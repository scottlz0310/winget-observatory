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
