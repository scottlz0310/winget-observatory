/**
 * 折れ線チャート（インライン SVG）を生成する純粋関数。外部 I/O を行わない。
 * 色は CSS 変数で渡し、ライト/ダークの切り替えは呼び出し側のスタイルに委ねる。
 */

export interface ChartPoint {
  /** 時刻（UTC ミリ秒） */
  x: number;
  y: number;
}

export interface ChartSeries {
  label: string;
  /** 線の色（例: "var(--primary)"） */
  color: string;
  points: ChartPoint[];
}

export interface LineChartOptions {
  /** 読み上げ用の説明（aria-label / title） */
  title: string;
  series: ChartSeries[];
  /** 縦軸ラベルの小数桁数。省略時は値の幅から決める */
  decimals?: number;
}

const WIDTH = 640;
const HEIGHT = 240;
const MARGIN = { left: 56, right: 16, top: 30, bottom: 34 };
const Y_TICKS = 4;
const X_TICKS = 3;
/** 点（マーカー）を描くのは、系列の点数がこれ以下のときだけ（多いと線が潰れる） */
const MAX_MARKED_POINTS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 1・2・5 × 10^n のうち、目標の刻み幅以上で最小のもの */
function niceStep(rawStep: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

const xmlEscape = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const withThousands = (text: string): string => text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function formatYTick(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [integer, fraction] = fixed.split(".");
  const body =
    fraction === undefined ? withThousands(integer) : `${withThousands(integer)}.${fraction}`;
  return value < 0 && Number(fixed) !== 0 ? `-${body}` : body;
}

/** JST の "MM-DD HH:mm" */
function formatXTick(timeMs: number): string {
  const iso = new Date(timeMs + 9 * 60 * 60 * 1000).toISOString();
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/**
 * 時系列の折れ線チャートを SVG 文字列にする。
 * 描画できるだけの点（2 点以上、かつ時刻が異なる）が無ければ null を返す。
 */
export function renderLineChartSvg(options: LineChartOptions): string | null {
  const series = options.series
    .map((s) => ({
      ...s,
      points: s.points
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.x - b.x),
    }))
    .filter((s) => s.points.length > 0);
  const all = series.flatMap((s) => s.points);
  if (series.every((s) => s.points.length < 2) || all.length < 2) return null;

  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  if (xMin === xMax) return null;

  const yDataMin = Math.min(...all.map((p) => p.y));
  const yDataMax = Math.max(...all.map((p) => p.y));
  const span = yDataMax - yDataMin;
  const pad = span === 0 ? Math.max(Math.abs(yDataMax) * 0.05, 1) : span * 0.1;
  const step = niceStep((span + pad * 2) / Y_TICKS);
  // 目盛りをきりの良い値にするため、縦軸の範囲は刻み幅の倍数に広げる
  const yMin = Math.floor((yDataMin - pad) / step) * step;
  const yMax = Math.ceil((yDataMax + pad) / step) * step;
  const decimals = options.decimals ?? Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const tickCount = Math.round((yMax - yMin) / step);

  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const px = (x: number): number => MARGIN.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const py = (y: number): number => MARGIN.top + (1 - (y - yMin) / (yMax - yMin)) * plotH;
  const num = (value: number): string => String(Math.round(value * 10) / 10);

  const yGrid = Array.from({ length: tickCount + 1 }, (_, i) => {
    const value = yMin + step * i;
    const y = py(value);
    return (
      `<line x1="${MARGIN.left}" y1="${num(y)}" x2="${WIDTH - MARGIN.right}" y2="${num(y)}" style="stroke: var(--border-color)" />` +
      `<text x="${MARGIN.left - 6}" y="${num(y + 4)}" text-anchor="end" style="fill: var(--text-muted)" font-size="11">${xmlEscape(formatYTick(value, decimals))}</text>`
    );
  }).join("");

  const xLabels = Array.from({ length: X_TICKS }, (_, i) => {
    const ratio = i / (X_TICKS - 1);
    const anchor = i === 0 ? "start" : i === X_TICKS - 1 ? "end" : "middle";
    return `<text x="${num(MARGIN.left + ratio * plotW)}" y="${HEIGHT - 10}" text-anchor="${anchor}" style="fill: var(--text-muted)" font-size="11">${xmlEscape(formatXTick(xMin + (xMax - xMin) * ratio))}</text>`;
  }).join("");

  const lines = series
    .map((s) => {
      const coords = s.points.map((p) => `${num(px(p.x))},${num(py(p.y))}`).join(" ");
      const markers =
        s.points.length <= MAX_MARKED_POINTS
          ? s.points
              .map(
                (p) =>
                  `<circle cx="${num(px(p.x))}" cy="${num(py(p.y))}" r="2.5" style="fill: ${xmlEscape(s.color)}" />`,
              )
              .join("")
          : "";
      return `<polyline points="${coords}" fill="none" stroke-width="2" stroke-linejoin="round" style="stroke: ${xmlEscape(s.color)}" />${markers}`;
    })
    .join("");

  const legend = series
    .map((s, i) => {
      const x = MARGIN.left + i * 170;
      return (
        `<line x1="${x}" y1="14" x2="${x + 16}" y2="14" stroke-width="2" style="stroke: ${xmlEscape(s.color)}" />` +
        `<text x="${x + 22}" y="18" style="fill: var(--text-color)" font-size="12">${xmlEscape(s.label)}</text>`
      );
    })
    .join("");

  const title = xmlEscape(options.title);
  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${title}" style="width: 100%; height: auto; display: block;"><title>${title}</title>${yGrid}${xLabels}${lines}${legend}</svg>`;
}

export interface TimelineMarker {
  /** 印の上に出す文字（例: "① 12/03"） */
  label: string;
  /** 時刻（UTC ミリ秒） */
  dateMs: number;
  color: string;
}

export interface TimelineOptions {
  title: string;
  /** 起点（今日）の時刻（UTC ミリ秒） */
  nowMs: number;
  markers: TimelineMarker[];
  /** 範囲として帯で示す期間（UTC ミリ秒） */
  band?: { startMs: number; endMs: number };
}

const TL_WIDTH = 640;
const TL_HEIGHT = 120;
const TL_MARGIN = { left: 28, right: 28 };
const TL_AXIS_Y = 68;
/** 隣り合う印のラベルが重ならないよう、段をずらして並べる */
const TL_LABEL_ROWS = [50, 30];

/** JST の "MM/DD" */
function formatMonthDay(timeMs: number): string {
  const iso = new Date(timeMs + 9 * 60 * 60 * 1000).toISOString();
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

/**
 * 今日から予想日までの時間軸に、印と範囲の帯を描く SVG を返す。
 * 描ける印が無い、または時刻が有限でないときは null。今日以前の印は今日の位置に寄せる。
 */
export function renderTimelineSvg(options: TimelineOptions): string | null {
  const markers = options.markers
    .filter((m) => Number.isFinite(m.dateMs))
    .sort((a, b) => a.dateMs - b.dateMs);
  if (!Number.isFinite(options.nowMs) || markers.length === 0) return null;

  const endMs = Math.max(...markers.map((m) => m.dateMs), options.nowMs + DAY_MS);
  const span = endMs - options.nowMs;
  const domainEnd = endMs + span * 0.05;
  const plotW = TL_WIDTH - TL_MARGIN.left - TL_MARGIN.right;
  const px = (ms: number): number =>
    TL_MARGIN.left +
    ((Math.min(Math.max(ms, options.nowMs), domainEnd) - options.nowMs) /
      (domainEnd - options.nowMs)) *
      plotW;
  const num = (value: number): string => String(Math.round(value * 10) / 10);

  const band = options.band
    ? `<rect x="${num(px(options.band.startMs))}" y="${TL_AXIS_Y - 7}" width="${num(Math.max(px(options.band.endMs) - px(options.band.startMs), 2))}" height="14" rx="3" style="fill: var(--primary); opacity: 0.18" />`
    : "";

  const ticks = Array.from({ length: 4 }, (_, i) => {
    const ms = options.nowMs + (domainEnd - options.nowMs) * (i / 3);
    const x = px(ms);
    const anchor = i === 0 ? "start" : i === 3 ? "end" : "middle";
    const text = i === 0 ? "今日" : formatMonthDay(ms);
    return (
      `<line x1="${num(x)}" y1="${TL_AXIS_Y - 4}" x2="${num(x)}" y2="${TL_AXIS_Y + 4}" style="stroke: var(--text-muted)" />` +
      `<text x="${num(x)}" y="${TL_AXIS_Y + 22}" text-anchor="${anchor}" style="fill: var(--text-muted)" font-size="11">${xmlEscape(text)}</text>`
    );
  }).join("");

  const marks = markers
    .map((m, i) => {
      const x = num(px(m.dateMs));
      const labelY = TL_LABEL_ROWS[i % TL_LABEL_ROWS.length];
      return (
        `<line x1="${x}" y1="${labelY + 4}" x2="${x}" y2="${TL_AXIS_Y}" style="stroke: ${xmlEscape(m.color)}" stroke-width="1" />` +
        `<circle cx="${x}" cy="${TL_AXIS_Y}" r="6" style="fill: ${xmlEscape(m.color)}" />` +
        `<text x="${x}" y="${labelY}" text-anchor="middle" style="fill: var(--text-color)" font-size="12" font-weight="600">${xmlEscape(m.label)}</text>`
      );
    })
    .join("");

  const title = xmlEscape(options.title);
  return `<svg viewBox="0 0 ${TL_WIDTH} ${TL_HEIGHT}" role="img" aria-label="${title}" style="width: 100%; height: auto; display: block;"><title>${title}</title><line x1="${TL_MARGIN.left}" y1="${TL_AXIS_Y}" x2="${TL_WIDTH - TL_MARGIN.right}" y2="${TL_AXIS_Y}" stroke-width="2" style="stroke: var(--border-color)" />${band}${ticks}${marks}</svg>`;
}
