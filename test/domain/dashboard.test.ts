import { describe, expect, test } from "bun:test";
import {
  calculateCalendarGap,
  calculateDashboardMetrics,
  calculateDeltaMetrics,
  calculateHistoryWithDeltas,
  calculateVelocityMetrics,
  formatDeltaBadge,
  formatJstDate,
  parseTimestampToMs,
} from "../../src/domain/dashboard";
import type { HistoryRecord } from "../../src/models/dashboard";

describe("Domain: dashboard calculations", () => {
  describe("parseTimestampToMs & formatJstDate", () => {
    test("JST 形式の文字列を環境非依存で正しく UTC ミリ秒にパースする", () => {
      const ms = parseTimestampToMs("2026-11-06 18:22:14");
      const expected = Date.parse("2026-11-06T18:22:14+09:00");
      expect(ms).toBe(expected);
    });

    test("ISO 形式の文字列を正しくパースする", () => {
      const ms = parseTimestampToMs("2026-11-06T09:22:14Z");
      expect(ms).toBe(Date.parse("2026-11-06T09:22:14Z"));
    });

    test("不正文字列や空文字列で NaN を返す", () => {
      expect(Number.isNaN(parseTimestampToMs(""))).toBeTrue();
      expect(Number.isNaN(parseTimestampToMs("invalid-date"))).toBeTrue();
    });

    test("formatJstDate は UTC ミリ秒を JST の YYYY-MM-DD に変換する", () => {
      const ms = Date.parse("2026-11-06T18:00:00Z"); // JST では 2026-11-07 03:00:00
      expect(formatJstDate(ms)).toBe("2026-11-07");
    });
  });

  describe("calculateDeltaMetrics", () => {
    test("レコードが 2 件未満の場合は全項目 null を返す", () => {
      expect(calculateDeltaMetrics([])).toEqual({
        activeAheadDelta: null,
        frontNumberDelta: null,
        behindDelta: null,
        waitDaysDelta: null,
      });

      const single: HistoryRecord = {
        timestamp: "2026-11-06 18:00:00",
        timestampMs: 1000,
        targetPr: 464302,
        frontNumber: 440000,
        activeAhead: 2000,
        totalAhead: 2100,
        behind: 800,
        waitDays: 9.0,
      };
      expect(calculateDeltaMetrics([single])).toEqual({
        activeAheadDelta: null,
        frontNumberDelta: null,
        behindDelta: null,
        waitDaysDelta: null,
      });
    });

    test("最新と直前のレコードから正確に差分（Δ）を算出する", () => {
      const records: HistoryRecord[] = [
        {
          timestamp: "2026-11-06 18:00:00",
          timestampMs: 1000,
          targetPr: 464302,
          frontNumber: 440000,
          activeAhead: 2000,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.0,
        },
        {
          timestamp: "2026-11-06 22:00:00",
          timestampMs: 2000,
          targetPr: 464302,
          frontNumber: 440020,
          activeAhead: 1992,
          totalAhead: 2095,
          behind: 805,
          waitDays: 9.17,
        },
      ];

      const delta = calculateDeltaMetrics(records);
      expect(delta.activeAheadDelta).toBe(-8); // 8件消化
      expect(delta.frontNumberDelta).toBe(20);
      expect(delta.behindDelta).toBe(5);
      expect(delta.waitDaysDelta).toBe(0.17);
    });
  });

  describe("calculateHistoryWithDeltas", () => {
    test("先頭行は delta null、以降は前行との activeAhead 差分が付与される", () => {
      const records: HistoryRecord[] = [
        {
          timestamp: "2026-11-06 18:00:00",
          timestampMs: 1000,
          targetPr: 464302,
          frontNumber: 440000,
          activeAhead: 2000,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.0,
        },
        {
          timestamp: "2026-11-06 22:00:00",
          timestampMs: 2000,
          targetPr: 464302,
          frontNumber: 440010,
          activeAhead: 1995,
          totalAhead: 2095,
          behind: 805,
          waitDays: 9.17,
        },
        {
          timestamp: "2026-11-07 02:00:00",
          timestampMs: 3000,
          targetPr: 464302,
          frontNumber: 440020,
          activeAhead: 1998, // 巻き戻り
          totalAhead: 2095,
          behind: 808,
          waitDays: 9.33,
        },
      ];

      const withDeltas = calculateHistoryWithDeltas(records);
      expect(withDeltas.length).toBe(3);
      expect(withDeltas[0].activeAheadDelta).toBeNull();
      expect(withDeltas[1].activeAheadDelta).toBe(-5);
      expect(withDeltas[2].activeAheadDelta).toBe(3);
    });
  });

  describe("calculateVelocityMetrics", () => {
    test("レコードが 2 件未満の場合は fallback を返す", () => {
      const res = calculateVelocityMetrics([], 2000);
      expect(res.velocityPerDay).toBeNull();
      expect(res.etaDays).toBeNull();
    });

    test("時間差が 30 分未満の場合は短すぎるため速度を算出しない", () => {
      const baseMs = Date.parse("2026-11-06T10:00:00+09:00");
      const records: HistoryRecord[] = [
        {
          timestamp: "2026-11-06 10:00:00",
          timestampMs: baseMs,
          targetPr: 464302,
          frontNumber: 440000,
          activeAhead: 2000,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.0,
        },
        {
          timestamp: "2026-11-06 10:20:00", // 20分後
          timestampMs: baseMs + 20 * 60 * 1000,
          targetPr: 464302,
          frontNumber: 440005,
          activeAhead: 1995,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.01,
        },
      ];

      const res = calculateVelocityMetrics(records, 1995);
      expect(res.velocityPerDay).toBeNull();
    });

    test("過去 24 時間のデータから正確に日速 (PRs/day) と ETA を算出する", () => {
      const baseMs = Date.parse("2026-11-06T12:00:00+09:00");
      // 24 時間で 100 件消化（base 2000 -> latest 1900）
      const records: HistoryRecord[] = [
        {
          timestamp: "2026-11-06 12:00:00",
          timestampMs: baseMs,
          targetPr: 464302,
          frontNumber: 440000,
          activeAhead: 2000,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.0,
        },
        {
          timestamp: "2026-11-06 18:00:00",
          timestampMs: baseMs + 6 * 3600 * 1000,
          targetPr: 464302,
          frontNumber: 440020,
          activeAhead: 1975,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.25,
        },
        {
          timestamp: "2026-11-07 12:00:00", // ちょうど 24 時間後
          timestampMs: baseMs + 24 * 3600 * 1000,
          targetPr: 464302,
          frontNumber: 440100,
          activeAhead: 1900,
          totalAhead: 2100,
          behind: 800,
          waitDays: 10.0,
        },
      ];

      const res = calculateVelocityMetrics(records, 1900, 24);
      expect(res.sampleHours).toBe(24);
      expect(res.consumedCount).toBe(100);
      expect(res.velocityPerHour).toBe(4.17); // 100 / 24 = 4.166...
      expect(res.velocityPerDay).toBe(100); // 100 件/日

      // 1900 件 / 100 件/日 = 19 日
      expect(res.etaDays).toBe(19);
      // latest 2026-11-07 + 19日 = 2026-11-26
      expect(res.etaDateJst).toBe("2026-11-26");
    });

    test("キューが後退・停滞（消化件数 <= 0）している場合は ETA を null にする", () => {
      const baseMs = Date.parse("2026-11-06T12:00:00+09:00");
      const records: HistoryRecord[] = [
        {
          timestamp: "2026-11-06 12:00:00",
          timestampMs: baseMs,
          targetPr: 464302,
          frontNumber: 440000,
          activeAhead: 1900,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.0,
        },
        {
          timestamp: "2026-11-07 12:00:00",
          timestampMs: baseMs + 24 * 3600 * 1000,
          targetPr: 464302,
          frontNumber: 440000,
          activeAhead: 1920, // 巻き戻って増加
          totalAhead: 2100,
          behind: 800,
          waitDays: 10.0,
        },
      ];

      const res = calculateVelocityMetrics(records, 1920, 24);
      expect(res.consumedCount).toBe(-20);
      expect(res.velocityPerDay).toBe(-20);
      expect(res.etaDays).toBeNull();
      expect(res.etaDateJst).toBeNull();
    });
  });

  describe("calculateCalendarGap", () => {
    test("欠落時は null を返す", () => {
      expect(calculateCalendarGap(null, null).gapDays).toBeNull();
      expect(calculateCalendarGap("2026-09-23 12:00", null).gapDays).toBeNull();
    });

    test("前線と自 PR の起票日時の日数差を正しく計算する", () => {
      // 2026-09-23 12:00 〜 2026-10-25 12:00 (32 日差)
      const res = calculateCalendarGap("2026-09-23 12:00", "2026-10-25 12:00");
      expect(res.gapDays).toBe(32);
    });
  });

  describe("formatDeltaBadge", () => {
    test("負数（前線進行）は delta-progress を返す", () => {
      const b = formatDeltaBadge(-8);
      expect(b.text).toBe("-8");
      expect(b.className).toBe("delta-progress");
      expect(b.label).toContain("8 件進行");
    });

    test("正数（後退・巻き戻り）は delta-rewind を返す", () => {
      const b = formatDeltaBadge(12);
      expect(b.text).toBe("+12");
      expect(b.className).toBe("delta-rewind");
    });

    test("ゼロは delta-neutral を返す", () => {
      const b = formatDeltaBadge(0);
      expect(b.text).toBe("±0");
      expect(b.className).toBe("delta-neutral");
    });

    test("null はハイフンを返す", () => {
      const b = formatDeltaBadge(null);
      expect(b.text).toBe("-");
    });
  });

  describe("calculateDashboardMetrics", () => {
    test("全指標を一括で整合性をもって算出する", () => {
      const baseMs = Date.parse("2026-11-06T12:00:00+09:00");
      const records: HistoryRecord[] = [
        {
          timestamp: "2026-11-06 12:00:00",
          timestampMs: baseMs,
          targetPr: 464302,
          frontNumber: 440000,
          frontCreatedAt: "2026-09-20 12:00",
          activeAhead: 2000,
          totalAhead: 2100,
          behind: 800,
          waitDays: 9.0,
        },
        {
          timestamp: "2026-11-07 12:00:00",
          timestampMs: baseMs + 24 * 3600 * 1000,
          targetPr: 464302,
          frontNumber: 440050,
          frontCreatedAt: "2026-09-23 12:00",
          activeAhead: 1950,
          totalAhead: 2100,
          behind: 805,
          waitDays: 10.0,
        },
      ];

      const res = calculateDashboardMetrics(records, 1950, "2026-09-23 12:00", "2026-10-25 12:00");

      expect(res.latestDelta.activeAheadDelta).toBe(-50);
      expect(res.velocity.velocityPerDay).toBe(50);
      expect(res.velocity.etaDays).toBe(39); // 1950 / 50 = 39 日
      expect(res.calendarGap.gapDays).toBe(32);
      expect(res.historyWithDeltas.length).toBe(2);
      expect(res.historyWithDeltas[1].activeAheadDelta).toBe(-50);
    });
  });
});
