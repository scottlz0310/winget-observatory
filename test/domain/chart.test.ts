import { describe, expect, test } from "bun:test";
import { renderDualAxisLineChartSvg, renderTimelineSvg } from "../../src/domain/chart";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-07T00:00:00Z");

const point = (hours: number, y: number) => ({ x: T0 + hours * HOUR, y });

describe("Domain: renderTimelineSvg", () => {
  const DAY = 24 * HOUR;
  const marker = (label: string, days: number) => ({
    label,
    dateMs: T0 + days * DAY,
    color: "var(--primary)",
  });
  /** 印（circle）の cx を左から右の順に取り出す */
  const circleXs = (svg: string): number[] =>
    [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));

  test.each([
    ["印が無い", { nowMs: T0, markers: [] }],
    ["起点の時刻が不正", { nowMs: Number.NaN, markers: [marker("a", 5)] }],
    ["印の時刻がすべて不正", { nowMs: T0, markers: [{ ...marker("a", 5), dateMs: Number.NaN }] }],
  ])("描画できないときは null を返す: %s", (_name, options) => {
    expect(renderTimelineSvg({ title: "t", ...options })).toBeNull();
  });

  test("予想日の順に左から右へ印を置き、今日と日付の目盛りを出す", () => {
    const svg = renderTimelineSvg({
      title: "予想日",
      nowMs: T0,
      // 渡す順は日付順でなくてもよい
      markers: [marker("③ 11/30", 30), marker("① 11/21", 21), marker("② 11/24", 24)],
    }) as string;
    const xs = circleXs(svg);
    expect(xs).toHaveLength(3);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(svg).toContain("今日");
    // 印のラベルは日付順に並ぶ
    expect(svg.indexOf("① 11/21")).toBeLessThan(svg.indexOf("② 11/24"));
    expect(svg.indexOf("② 11/24")).toBeLessThan(svg.indexOf("③ 11/30"));
  });

  test("近い日付の印はラベルの段をずらして重ならないようにする", () => {
    const svg = renderTimelineSvg({
      title: "t",
      nowMs: T0,
      markers: [marker("a", 20), marker("b", 22), marker("c", 24)],
    }) as string;
    const ys = [
      ...svg.matchAll(/<text x="[\d.]+" y="(\d+)" text-anchor="middle"[^>]*font-weight="600"/g),
    ].map((m) => m[1]);
    expect(ys).toHaveLength(3);
    expect(ys[0]).not.toBe(ys[1]);
    expect(ys[1]).not.toBe(ys[2]);
  });

  test("今日以前の印は今日の位置（軸の左端）に寄せ、範囲の帯を描ける", () => {
    const svg = renderTimelineSvg({
      title: "t",
      nowMs: T0,
      markers: [marker("超過", -3), marker("先", 10)],
      band: { startMs: T0 + 2 * DAY, endMs: T0 + 8 * DAY },
    }) as string;
    const xs = circleXs(svg);
    expect(xs[0]).toBe(28);
    expect(xs[1]).toBeGreaterThan(xs[0]);
    expect(svg).toContain("<rect");
  });

  test("ラベルは XML エスケープする", () => {
    const svg = renderTimelineSvg({
      title: "a<b",
      nowMs: T0,
      markers: [marker("<script>", 5)],
    }) as string;
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("a&lt;b");
  });
});

describe("Domain: renderDualAxisLineChartSvg", () => {
  test.each([
    ["系列が空", []],
    ["点が 1 つだけ", [{ label: "a", axis: "left" as const, color: "red", points: [point(0, 1)] }]],
    [
      "すべて同じ時刻",
      [
        {
          label: "a",
          axis: "left" as const,
          color: "red",
          points: [point(0, 1), point(0, 2)],
        },
      ],
    ],
  ])("描画できないときは null を返す: %s", (_name, series) => {
    expect(renderDualAxisLineChartSvg({ title: "t", series })).toBeNull();
  });

  test("左右 2 軸それぞれの系列と見出し・目盛り・凡例を正しく描く", () => {
    const svg = renderDualAxisLineChartSvg({
      title: "統合チャート",
      leftAxisLabel: "待ち件数",
      rightAxisLabel: "先頭の遅れ（日）",
      series: [
        {
          label: "実質待ち",
          axis: "left",
          color: "var(--primary)",
          strokeWidth: 2.5,
          points: [point(0, 100), point(1, 80), point(2, 50)],
        },
        {
          label: "累積待ち",
          axis: "left",
          color: "var(--text-muted)",
          strokeDasharray: "4 2",
          points: [point(0, 150), point(1, 130), point(2, 110)],
        },
        {
          label: "優等生の底 先頭の遅れ",
          axis: "right",
          color: "var(--warning)",
          points: [point(0, 30), point(1, 31), point(2, 32)],
        },
        {
          label: "🌱 初回提出者の底 先頭の遅れ",
          axis: "right",
          color: "var(--success)",
          strokeWidth: 3,
          points: [point(1, 35), point(2, 36)],
        },
      ],
    });

    expect(svg).not.toBeNull();
    const str = svg as string;
    expect(str).toContain('aria-label="統合チャート"');
    expect(str).toContain("待ち件数");
    expect(str).toContain("先頭の遅れ（日）");
    expect(str).toContain("実質待ち");
    expect(str).toContain("累積待ち");
    expect(str).toContain("優等生の底 先頭の遅れ");
    expect(str).toContain("🌱 初回提出者の底 先頭の遅れ");
    expect(str).toContain('stroke-dasharray="4 2"');
    expect(str).toContain('stroke-width="3"');
    expect(str.match(/<polyline /g)?.length).toBe(4);
  });

  test("タイトルやラベルを XML エスケープする", () => {
    const svg = renderDualAxisLineChartSvg({
      title: "Chart <1>",
      leftAxisLabel: "Left & Right",
      series: [
        {
          label: "A < B",
          axis: "left",
          color: "blue",
          points: [point(0, 1), point(1, 2)],
        },
      ],
    }) as string;
    expect(svg).toContain("Chart &lt;1&gt;");
    expect(svg).toContain("Left &amp; Right");
    expect(svg).toContain("A &lt; B");
  });
});
