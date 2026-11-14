import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  formatDaysStat,
  formatErrorDays,
  formatEtaDays,
  formatNumber,
  renderBadgeHtml,
} from "../../scripts/pages/formatters";
import { generateDashboardHtml } from "../../scripts/pages/template";

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
});
