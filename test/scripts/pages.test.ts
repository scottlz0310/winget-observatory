import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  formatDaysStat,
  formatErrorDays,
  formatEtaDays,
  formatNumber,
  renderBadgeHtml,
} from "../../scripts/pages/formatters";
import {
  buildBandTimelineMarkers,
  renderIntegratedForecastHero,
} from "../../scripts/pages/sections/hero-and-kpi";
import { generateDashboardHtml } from "../../scripts/pages/template";
import { buildForecastBandSource, calculateForecastBand } from "../../src/domain/forecast-band";
import { DAY_MS } from "../../src/domain/formatters";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "../../src/domain/intervention";

describe("scripts/pages/formatters", () => {
  test.each([
    { input: undefined, expected: "-" },
    { input: null, expected: "-" },
    { input: "", expected: "-" },
    { input: "<script>\"&'</script>", expected: "&lt;script&gt;&quot;&amp;&#039;&lt;/script&gt;" },
    { input: 42, expected: "42" },
  ])("escapeHtml($input) -> $expected", ({ input, expected }) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  test.each([
    { input: undefined, expected: "-" },
    { input: null, expected: "-" },
    { input: "", expected: "-" },
    { input: "not-a-number", expected: "-" },
    { input: 0, expected: "0" },
    { input: 1234, expected: (1234).toLocaleString() },
  ])("formatNumber($input) -> $expected", ({ input, expected }) => {
    expect(formatNumber(input)).toBe(expected);
  });

  test.each([
    { input: 0, expected: "到達済み" },
    { input: 3.5, expected: "約 3.5 日後" },
  ])("formatEtaDays($input) -> $expected", ({ input, expected }) => {
    expect(formatEtaDays(input)).toBe(expected);
  });

  test.each([
    { input: 0, expected: "±0 日" },
    { input: 2.5, expected: "+2.5 日" },
    { input: -1.5, expected: "-1.5 日" },
  ])("formatErrorDays($input) -> $expected", ({ input, expected }) => {
    expect(formatErrorDays(input)).toBe(expected);
  });

  test("formatDaysStat は欠損を '-' 表示、数値を太字で整形する", () => {
    expect(formatDaysStat(null)).toContain(">-<");
    expect(formatDaysStat(undefined)).toContain(">-<");
    expect(formatDaysStat(Number.NaN)).toContain(">-<");
    expect(formatDaysStat(4.2)).toContain("<strong>4.2</strong>");
  });

  test("renderBadgeHtml は属性値とテキストを HTML エスケープする", () => {
    const html = renderBadgeHtml({
      text: "<-2>",
      className: "delta-progress",
      label: '前回比 "改善"',
    });
    expect(html).toBe(
      '<span class="delta-badge delta-progress" title="前回比 &quot;改善&quot;">&lt;-2&gt;</span>',
    );
  });
});

describe("generateDashboardHtml", () => {
  test("I/O なしで空スナップショットから完全な HTML 文書を生成できる", () => {
    const html = generateDashboardHtml({
      progress: null,
      depths: null,
      csvRows: [],
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Winget Observatory Dashboard</title>");
    expect(html).toContain("未観測");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("renderIntegratedForecastHero & buildBandTimelineMarkers: 前線・本命・大底マーカーとスナップショットを描画する", () => {
    const t0 = Date.parse("2026-11-18T20:05:00Z");
    const created = "2026-10-28T21:47:38Z";
    const band = calculateForecastBand(
      buildForecastBandSource({
        progress: {
          Timestamp: new Date(t0).toISOString(),
          TargetPr: 464302,
          FrontNumber: 436234,
          FrontCreatedAt: "2026-09-17(木) 06:01",
          ActiveAhead: 1609,
          TotalMedianDays: 38.55,
          FirstTimerMedianDays: 31.14,
          FirstTimerP75Days: 39.19,
        },
        depths: {
          DepthsVersion: 4,
          Timestamp: new Date(t0).toISOString(),
          TargetPr: {
            Number: 464302,
            Title: "t",
            Url: "u",
            CreatedAt: created,
            CreatedAtJst: "2026-10-29 06:47",
            UpdatedAt: new Date(t0).toISOString(),
          },
          HealthyBottom: [
            {
              PR: "#436234",
              Number: 436234,
              作成日時: "2026-09-17 06:01",
              更新日時: "2026-11-16 22:32",
              CreatedAt: "2026-09-16T21:01:02Z",
              UpdatedAt: "2026-11-16T13:32:58Z",
              タイトル: "h",
              Title: "h",
              Url: "u1",
            },
          ],
          StaleBottom: [
            {
              PR: "#449390",
              Number: 449390,
              作成日時: "2026-10-09 16:57",
              更新日時: "2026-10-09 17:42",
              CreatedAt: "2026-10-09T07:57:34Z",
              UpdatedAt: "2026-10-09T08:42:30Z",
              タイトル: "s",
              Title: "s",
              Url: "u2",
            },
          ],
        },
        history: [],
        mainstreamFrontierSamples: [
          {
            timestampMs: t0,
            createdMs: t0 - 45.1 * DAY_MS,
            cohortCount: 80,
            openCount: 41,
            mergedCount: 39,
            mode: FIRST_REVIEW_MAINSTREAM_MODE,
          },
        ],
      }),
    );

    const markers = buildBandTimelineMarkers(band);
    expect(markers.map((m) => m.label.slice(0, 3))).toEqual(["▼前線", "★本命", "▼大底"]);

    const html = renderIntegratedForecastHero({
      targetPrNum: 464302,
      repo: "microsoft/winget-pkgs",
      progress: { ActiveAhead: 1609, FirstTimerMedianDays: 31.14, FirstTimerP75Days: 39.19 },
      band,
      timelineSvg: "<svg></svg>",
    });
    expect(html).toContain("🎯 基準 PR #464302 着地予測（統合処理バンド）");
    expect(html).toContain("代表中央値:");
    expect(html).toContain("#449390");
    expect(html).toContain("健康的大底（#436234）と差");
    expect(html).toContain("🔍 統合処理バンドの内訳と 2 仮説比較（検証用詳細）");
  });
});
