import { describe, expect, test } from "bun:test";
import {
  DAY_MS,
  formatDateTimeWithDay,
  formatDelta,
  formatHumanDays,
  formatJstDate,
  formatJstDateTime,
  formatMonthDay,
  HOUR_MS,
  JST_OFFSET_MS,
  round1,
  round2,
} from "../../src/domain/formatters";

describe("Domain: formatters constants & rounding", () => {
  test("時間定数が期待値と一致する", () => {
    expect(HOUR_MS).toBe(3_600_000);
    expect(DAY_MS).toBe(86_400_000);
    expect(JST_OFFSET_MS).toBe(9 * 3_600_000);
  });

  test.each([
    [0, 0],
    [1.24, 1.2],
    [1.25, 1.3],
    [3.99, 4],
    [-1.24, -1.2],
  ])("round1(%p) は %p を返す", (input, expected) => {
    expect(round1(input)).toBe(expected);
  });

  test.each([
    [0, 0],
    [1.234, 1.23],
    [1.235, 1.24],
    [3.999, 4],
    [-1.234, -1.23],
  ])("round2(%p) は %p を返す", (input, expected) => {
    expect(round2(input)).toBe(expected);
  });
});

describe("Domain: JST date & datetime formatters", () => {
  test.each([
    [Date.parse("2026-11-06T14:59:59Z"), "2026-11-06"],
    [Date.parse("2026-11-06T15:00:00Z"), "2026-11-07"],
    [Date.parse("2026-12-31T15:00:00Z"), "2027-01-01"],
    [Number.NaN, "-"],
    [Number.POSITIVE_INFINITY, "-"],
  ])("formatJstDate(%p) は %s を返す", (timeMs, expected) => {
    expect(formatJstDate(timeMs)).toBe(expected);
  });

  test.each([
    ["2026-11-07T05:54:31.000Z", false, "2026-11-07 14:54"],
    ["2026-11-07T05:54:31.000Z", true, "2026-11-07 14:54:31"],
    ["2026-10-28T21:47:38Z", false, "2026-10-29 06:47"],
    [new Date("2026-11-07T05:54:31.000Z"), true, "2026-11-07 14:54:31"],
    [Date.parse("2026-11-07T05:54:31.000Z"), false, "2026-11-07 14:54"],
    [Number.NaN, false, "-"],
    ["invalid-iso", false, "-"],
  ])("formatJstDateTime(%p, %p) は %s を返す", (input, includeSeconds, expected) => {
    expect(formatJstDateTime(input, includeSeconds)).toBe(expected);
  });

  test.each([
    ["2026-11-07T11:30:00Z", "2026-11-07(土) 20:30"],
    ["2026-12-31T15:00:00Z", "2027-01-01(金) 00:00"],
    [new Date("2026-03-08T14:59:00Z"), "2026-03-08(日) 23:59"],
  ])("formatDateTimeWithDay(%p) は %s を返す", (input, expected) => {
    expect(formatDateTimeWithDay(input)).toBe(expected);
  });

  test("formatDateTimeWithDay / formatJstDateTime は実行環境のタイムゾーンに依存しない", () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatDateTimeWithDay("2026-03-08T07:30:00Z")).toBe("2026-03-08(日) 16:30");
      expect(formatJstDateTime("2026-03-08T07:30:00Z")).toBe("2026-03-08 16:30");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  test.each([
    [Date.parse("2026-11-06T14:59:59Z"), "11/06"],
    [Date.parse("2026-11-06T15:00:00Z"), "11/07"],
    [Date.parse("2026-12-03T00:00:00Z"), "12/03"],
    [Number.NaN, "-"],
  ])("formatMonthDay(%p) は %s を返す", (timeMs, expected) => {
    expect(formatMonthDay(timeMs)).toBe(expected);
  });
});

describe("Domain: human days & delta formatters", () => {
  test.each([
    [1.5, "1.5日 (1日 12時間)"],
    [0.5, "0.5日 (12時間)"],
    [3.0, "3.0日 (3日 0時間)"],
  ])("formatHumanDays(%p) は %s を返す", (days, expected) => {
    expect(formatHumanDays(days)).toBe(expected);
  });

  test.each([
    [10, 8, undefined, "[前回比 +2 件]"],
    [5, 7, undefined, "[前回比 -2 件]"],
    [5, 5, undefined, "[前回比 ±0 件]"],
    [5, 3, "日", "[前回比 +2 日]"],
  ])("formatDelta(%p, %p, %p) は %s を返す", (current, previous, unit, expected) => {
    expect(formatDelta(current, previous, unit)).toBe(expected);
  });
});
