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

export interface DualAxisSeries extends ChartSeries {
  /** 左Y軸（例: 件数）または右Y軸（例: 日数）の指定 */
  axis: "left" | "right";
  /** 線の太さ（省略時は 2） */
  strokeWidth?: number;
  /** 線の破線パターン（例: "4 2"） */
  strokeDasharray?: string;
}

export interface DualAxisLineChartOptions {
  /** 読み上げ用の説明（aria-label / title） */
  title: string;
  series: DualAxisSeries[];
  /** 左Y軸の見出し（例: "待ち件数"） */
  leftAxisLabel?: string;
  /** 右Y軸の見出し（例: "先頭の遅れ（日）"） */
  rightAxisLabel?: string;
  leftDecimals?: number;
  rightDecimals?: number;
}

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

const DUAL_WIDTH = 640;
const DUAL_HEIGHT = 280;
const DUAL_MARGIN = { left: 56, right: 56, top: 58, bottom: 34 };

function computeAxisBounds(points: ChartPoint[], requestedDecimals?: number) {
  if (points.length === 0) {
    return { yMin: 0, yMax: 10, step: 2.5, decimals: 0 };
  }
  const yDataMin = Math.min(...points.map((p) => p.y));
  const yDataMax = Math.max(...points.map((p) => p.y));
  const span = yDataMax - yDataMin;
  const pad = span === 0 ? Math.max(Math.abs(yDataMax) * 0.05, 1) : span * 0.1;
  const step = niceStep((span + pad * 2) / Y_TICKS);
  const yMin = Math.floor((yDataMin - pad) / step) * step;
  const yMax = Math.ceil((yDataMax + pad) / step) * step;
  const decimals = requestedDecimals ?? Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return { yMin, yMax, step, decimals };
}

/**
 * 2軸（左Y軸＝件数、右Y軸＝遅れ日数など）の時系列折れ線チャートを SVG 文字列にする。
 * 描画できるだけの点（2 点以上、かつ時刻が異なる）が無ければ null を返す。
 */
export function renderDualAxisLineChartSvg(options: DualAxisLineChartOptions): string | null {
  const series = options.series
    .map((s) => ({
      ...s,
      points: s.points
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
        .sort((a, b) => a.x - b.x),
    }))
    .filter((s) => s.points.length > 0);

  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return null;

  const xMin = Math.min(...all.map((p) => p.x));
  const xMax = Math.max(...all.map((p) => p.x));
  if (xMin === xMax) return null;

  const leftPoints = series.filter((s) => s.axis === "left").flatMap((s) => s.points);
  const rightPoints = series.filter((s) => s.axis === "right").flatMap((s) => s.points);

  const leftBounds = computeAxisBounds(leftPoints, options.leftDecimals);
  const rightBounds = computeAxisBounds(rightPoints, options.rightDecimals);

  const plotW = DUAL_WIDTH - DUAL_MARGIN.left - DUAL_MARGIN.right;
  const plotH = DUAL_HEIGHT - DUAL_MARGIN.top - DUAL_MARGIN.bottom;
  const px = (x: number): number => DUAL_MARGIN.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const pyLeft = (y: number): number =>
    DUAL_MARGIN.top +
    (1 - (y - leftBounds.yMin) / (leftBounds.yMax - leftBounds.yMin || 1)) * plotH;
  const pyRight = (y: number): number =>
    DUAL_MARGIN.top +
    (1 - (y - rightBounds.yMin) / (rightBounds.yMax - rightBounds.yMin || 1)) * plotH;
  const num = (value: number): string => String(Math.round(value * 10) / 10);

  // Y 軸グリッド線および目盛り（左・右）
  const yGrid = Array.from({ length: Y_TICKS + 1 }, (_, i) => {
    const ratio = i / Y_TICKS;
    const yLeftVal = leftBounds.yMin + ratio * (leftBounds.yMax - leftBounds.yMin);
    const yRightVal = rightBounds.yMin + ratio * (rightBounds.yMax - rightBounds.yMin);
    const y = DUAL_MARGIN.top + (1 - ratio) * plotH;

    const leftText =
      leftPoints.length > 0
        ? `<text x="${DUAL_MARGIN.left - 6}" y="${num(y + 4)}" text-anchor="end" style="fill: var(--text-muted)" font-size="11">${xmlEscape(formatYTick(yLeftVal, leftBounds.decimals))}</text>`
        : "";
    const rightText =
      rightPoints.length > 0
        ? `<text x="${num(DUAL_WIDTH - DUAL_MARGIN.right + 6)}" y="${num(y + 4)}" text-anchor="start" style="fill: var(--text-muted)" font-size="11">${xmlEscape(formatYTick(yRightVal, rightBounds.decimals))}</text>`
        : "";

    return (
      `<line x1="${DUAL_MARGIN.left}" y1="${num(y)}" x2="${num(DUAL_WIDTH - DUAL_MARGIN.right)}" y2="${num(y)}" style="stroke: var(--border-color)" />` +
      leftText +
      rightText
    );
  }).join("");

  // 軸見出しラベル
  const axisHeaders =
    (options.leftAxisLabel
      ? `<text x="${DUAL_MARGIN.left}" y="${DUAL_MARGIN.top - 8}" text-anchor="start" font-size="11" font-weight="600" style="fill: var(--text-muted)">${xmlEscape(options.leftAxisLabel)}</text>`
      : "") +
    (options.rightAxisLabel
      ? `<text x="${num(DUAL_WIDTH - DUAL_MARGIN.right)}" y="${DUAL_MARGIN.top - 8}" text-anchor="end" font-size="11" font-weight="600" style="fill: var(--text-muted)">${xmlEscape(options.rightAxisLabel)}</text>`
      : "");

  const xLabels = Array.from({ length: X_TICKS }, (_, i) => {
    const ratio = i / (X_TICKS - 1);
    const anchor = i === 0 ? "start" : i === X_TICKS - 1 ? "end" : "middle";
    return `<text x="${num(DUAL_MARGIN.left + ratio * plotW)}" y="${DUAL_HEIGHT - 10}" text-anchor="${anchor}" style="fill: var(--text-muted)" font-size="11">${xmlEscape(formatXTick(xMin + (xMax - xMin) * ratio))}</text>`;
  }).join("");

  const lines = series
    .map((s) => {
      const py = s.axis === "left" ? pyLeft : pyRight;
      const coords = s.points.map((p) => `${num(px(p.x))},${num(py(p.y))}`).join(" ");
      const strokeW = s.strokeWidth ?? 2;
      const dash = s.strokeDasharray ? ` stroke-dasharray="${xmlEscape(s.strokeDasharray)}"` : "";
      const markers =
        s.points.length <= MAX_MARKED_POINTS
          ? s.points
              .map(
                (p) =>
                  `<circle cx="${num(px(p.x))}" cy="${num(py(p.y))}" r="${num(strokeW + 0.5)}" style="fill: ${xmlEscape(s.color)}" />`,
              )
              .join("")
          : "";
      return `<polyline points="${coords}" fill="none" stroke-width="${strokeW}"${dash} stroke-linejoin="round" style="stroke: ${xmlEscape(s.color)}" />${markers}`;
    })
    .join("");

  // 凡例（上部に2段構成で配置して重複を避ける）
  const leftS = series.filter((s) => s.axis === "left");
  const rightS = series.filter((s) => s.axis === "right");

  const renderLegendRow = (items: typeof series, rowY: number, startX: number) =>
    items
      .map((s, i) => {
        const x = startX + i * 180;
        const strokeW = s.strokeWidth ?? 2;
        const dash = s.strokeDasharray ? ` stroke-dasharray="${xmlEscape(s.strokeDasharray)}"` : "";
        return (
          `<line x1="${x}" y1="${rowY}" x2="${x + 16}" y2="${rowY}" stroke-width="${strokeW}"${dash} style="stroke: ${xmlEscape(s.color)}" />` +
          `<text x="${x + 22}" y="${rowY + 4}" style="fill: var(--text-color)" font-size="11">${xmlEscape(s.label)}</text>`
        );
      })
      .join("");

  const legend =
    renderLegendRow(leftS, 14, DUAL_MARGIN.left) + renderLegendRow(rightS, 32, DUAL_MARGIN.left);

  const title = xmlEscape(options.title);
  return `<svg viewBox="0 0 ${DUAL_WIDTH} ${DUAL_HEIGHT}" role="img" aria-label="${title}" style="width: 100%; height: auto; display: block;"><title>${title}</title>${yGrid}${axisHeaders}${xLabels}${lines}${legend}</svg>`;
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
