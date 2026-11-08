import { describe, expect, test } from "bun:test";
import { renderLineChartSvg } from "../../src/domain/chart";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-07T00:00:00Z");

const point = (hours: number, y: number) => ({ x: T0 + hours * HOUR, y });

/** polyline の points 属性を [x, y] の配列に戻す */
function polylinePoints(svg: string, index = 0): [number, number][] {
  const matches = [...svg.matchAll(/<polyline points="([^"]+)"/g)];
  const raw = matches[index]?.[1];
  if (raw === undefined) throw new Error(`polyline #${index} がありません`);
  return raw.split(" ").map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return [x, y];
  });
}

describe("Domain: renderLineChartSvg", () => {
  test.each([
    ["系列が空", []],
    ["点が 1 つだけ", [{ label: "a", color: "red", points: [point(0, 1)] }]],
    ["すべて同じ時刻", [{ label: "a", color: "red", points: [point(0, 1), point(0, 2)] }]],
    [
      "有限でない値だけで 2 点に満たない",
      [{ label: "a", color: "red", points: [point(0, Number.NaN), point(1, 2)] }],
    ],
  ])("描画できないときは null を返す: %s", (_name, series) => {
    expect(renderLineChartSvg({ title: "t", series })).toBeNull();
  });

  test("点の数だけ座標を持つ polyline を、時刻順に左から右へ描く", () => {
    const svg = renderLineChartSvg({
      title: "待ち件数",
      // 時刻が前後して渡されても時刻順に並べ替える
      series: [
        {
          label: "実質待ち",
          color: "var(--primary)",
          points: [point(2, 30), point(0, 10), point(1, 20)],
        },
      ],
    });
    expect(svg).not.toBeNull();
    const coords = polylinePoints(svg as string);
    expect(coords).toHaveLength(3);
    const xs = coords.map(([x]) => x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  test("値が大きいほど SVG の y 座標は小さい（上に描く）", () => {
    const svg = renderLineChartSvg({
      title: "t",
      series: [{ label: "a", color: "red", points: [point(0, 10), point(1, 20), point(2, 30)] }],
    });
    const ys = polylinePoints(svg as string).map(([, y]) => y);
    expect(ys[0]).toBeGreaterThan(ys[1]);
    expect(ys[1]).toBeGreaterThan(ys[2]);
  });

  test("値がすべて同じでも縦軸に幅を持たせ、線を描ける", () => {
    const svg = renderLineChartSvg({
      title: "t",
      series: [{ label: "a", color: "red", points: [point(0, 5), point(1, 5)] }],
    });
    expect(svg).not.toBeNull();
    const ys = polylinePoints(svg as string).map(([, y]) => y);
    expect(ys.every((y) => Number.isFinite(y))).toBeTrue();
    expect(ys[0]).toBe(ys[1]);
  });

  test("複数系列は同じ縦軸・横軸で描き、凡例にラベルを出す", () => {
    const svg = renderLineChartSvg({
      title: "t",
      series: [
        { label: "実質待ち", color: "var(--primary)", points: [point(0, 2500), point(2, 2450)] },
        { label: "累積待ち", color: "var(--text-muted)", points: [point(0, 2100), point(2, 2090)] },
      ],
    });
    const html = svg as string;
    expect(html.match(/<polyline /g)).toHaveLength(2);
    expect(html).toContain("実質待ち");
    expect(html).toContain("累積待ち");
    // 実質待ちの方が値が大きいので、全点で累積待ちより上（y が小さい）
    const upper = polylinePoints(html, 0);
    const lower = polylinePoints(html, 1);
    for (const [i, [, y]] of upper.entries()) expect(y).toBeLessThan(lower[i][1]);
  });

  test("横軸は JST の月日時刻、縦軸は桁区切りで表示する", () => {
    const svg = renderLineChartSvg({
      title: "t",
      series: [{ label: "a", color: "red", points: [point(0, 2000), point(24, 3000)] }],
      decimals: 0,
    }) as string;
    // T0 = 2026-11-07T00:00Z = JST 09:00
    expect(svg).toContain("11-07 09:00");
    expect(svg).toContain("11-08 09:00");
    expect(svg).toMatch(/>[23],\d{3}</);
  });

  test.each([
    ["幅が 10 未満は小数 1 桁", [point(0, 1), point(1, 2)], undefined, /<text[^>]*>1\.5</],
    ["幅が 10 以上は整数", [point(0, 100), point(1, 200)], undefined, /<text[^>]*>150</],
    ["decimals の明示を優先", [point(0, 1), point(1, 2)], 0, /<text[^>]*>2</],
  ])("縦軸の小数桁数: %s", (_name, points, decimals, expected) => {
    const svg = renderLineChartSvg({
      title: "t",
      series: [{ label: "a", color: "red", points }],
      decimals,
    }) as string;
    expect(svg).toMatch(expected);
  });

  test.each([
    ["件数（幅が数十）", [point(0, 2450), point(1, 2507)]],
    ["日数（幅が 2 未満）", [point(0, 28.4), point(1, 29.9)]],
    ["桁の大きい件数", [point(0, 120_000), point(1, 480_000)]],
  ])("縦軸の目盛りは等間隔で、刻み幅が 1・2・5 × 10^n になる: %s", (_name, points) => {
    const svg = renderLineChartSvg({
      title: "t",
      series: [{ label: "a", color: "red", points }],
    }) as string;
    const ticks = [...svg.matchAll(/x="50" y="[^"]+" text-anchor="end"[^>]*>([^<]+)</g)].map((m) =>
      Number(m[1].replaceAll(",", "")),
    );
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    const step = ticks[1] - ticks[0];
    for (const [i, tick] of ticks.entries()) {
      expect(tick).toBeCloseTo(ticks[0] + step * i, 6);
    }
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    expect([1, 2, 5]).toContain(Math.round(mantissa * 1e6) / 1e6);
  });

  test("タイトルとラベルは XML エスケープする", () => {
    const svg = renderLineChartSvg({
      title: 'a<b>&"c',
      series: [{ label: "<script>", color: "red", points: [point(0, 1), point(1, 2)] }],
    }) as string;
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("a&lt;b&gt;&amp;&quot;c");
  });

  test("点が多い系列はマーカーを省略して線だけを描く", () => {
    const many = Array.from({ length: 100 }, (_, i) => point(i, i));
    const few = Array.from({ length: 5 }, (_, i) => point(i, i));
    const manySvg = renderLineChartSvg({
      title: "t",
      series: [{ label: "a", color: "red", points: many }],
    });
    const fewSvg = renderLineChartSvg({
      title: "t",
      series: [{ label: "a", color: "red", points: few }],
    });
    expect(manySvg).not.toContain("<circle");
    expect(fewSvg?.match(/<circle /g)).toHaveLength(5);
  });
});
