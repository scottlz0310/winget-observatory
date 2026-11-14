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
  selectComparableHistory,
} from "../../src/domain/dashboard";
import type { HistoryRecord } from "../../src/models/dashboard";
import type { ProgressHistoryRow } from "../../src/models/progress";

describe("Domain: dashboard calculations", () => {
  describe("parseTimestampToMs & formatJstDate", () => {
    test("JST 形式の文字列を環境非依存で正しく UTC ミリ秒にパースする", () => {
      const ms = parseTimestampToMs("2026-11-06 18:22:14");
      const expected = Date.parse("2026-11-06T18:22:14+09:00");
      expect(ms).toBe(expected);
    });

    test("曜日付き JST 形式 (現行 progress CLI 出力) を環境非依存で正しくパースする", () => {
      const ms = parseTimestampToMs("2026-11-07(土) 23:00");
      const expected = Date.parse("2026-11-07T23:00:00+09:00");
      expect(ms).toBe(expected);

      const msWithSec = parseTimestampToMs("2026-11-07(土) 23:00:45");
      const expectedWithSec = Date.parse("2026-11-07T23:00:45+09:00");
      expect(msWithSec).toBe(expectedWithSec);
    });

    test("旧形式と曜日付き新形式の混在時も正確に 24 時間間隔を認識して速度・ETA を算出する", () => {
      const t1 = parseTimestampToMs("2026-11-06 23:00:00");
      const t2 = parseTimestampToMs("2026-11-07(土) 23:00");
      expect(t2 - t1).toBe(24 * 3600 * 1000);

      const records: HistoryRecord[] = [
        {
          timestamp: "2026-11-06 23:00:00",
          timestampMs: t1,
          targetPr: 1000,
          frontNumber: 900,
          activeAhead: 150,
          totalAhead: 200,
          behind: 50,
          waitDays: 5,
        },
        {
          timestamp: "2026-11-07(土) 23:00",
          timestampMs: t2,
          targetPr: 1000,
          frontNumber: 950,
          activeAhead: 100,
          totalAhead: 150,
          behind: 60,
          waitDays: 6,
        },
      ];

      const velocity = calculateVelocityMetrics(records, 100);
      expect(velocity.velocityPerDay).toBe(50);
      expect(velocity.etaDays).toBe(2);
      expect(velocity.etaDateJst).toBe("2026-11-09");
    });

    test("ISO 形式の文字列を正しくパースする", () => {
      const ms = parseTimestampToMs("2026-11-06T09:22:14Z");
      expect(ms).toBe(Date.parse("2026-11-06T09:22:14Z"));
    });

    test.each(["", "invalid-date"])("不正文字列 %j で NaN を返す", (input) => {
      expect(Number.isNaN(parseTimestampToMs(input))).toBeTrue();
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

    test("既定では 168 時間（1 週間）以上前で最も新しいレコードを基準とし、168 時間未満なら最古を採用する", () => {
      const baseMs = Date.parse("2026-11-01T00:00:00+09:00");
      const mkRow = (hoursAfterBase: number, activeAhead: number): HistoryRecord => ({
        timestamp: "",
        timestampMs: baseMs + hoursAfterBase * 3600 * 1000,
        targetPr: 464302,
        frontNumber: 440000,
        activeAhead,
        totalAhead: activeAhead,
        behind: 0,
        waitDays: 10,
      });

      const records = [
        mkRow(0, 3000), // latest から 200h 前
        mkRow(28, 2700), // latest から 172h 前（168h 以上前で最新）
        mkRow(176, 2100), // latest から 24h 前
        mkRow(200, 1840), // latest: 172h で 860 件減 = 120 件/日
      ];

      const res = calculateVelocityMetrics(records, 1840);
      expect(res.sampleHours).toBe(172);
      expect(res.consumedCount).toBe(860);
      expect(res.velocityPerDay).toBe(120);

      // 履歴が 168h 未満（24h のみ）なら最古レコードにフォールバック
      const shortRes = calculateVelocityMetrics(records.slice(2), 1840);
      expect(shortRes.sampleHours).toBe(24);
      expect(shortRes.consumedCount).toBe(260);
    });
  });

  describe("calculateCalendarGap", () => {
    test.each([
      [null, null],
      ["2026-09-23 12:00", null],
    ])("欠落時 (%p, %p) は null を返す", (front, target) => {
      expect(calculateCalendarGap(front, target).gapDays).toBeNull();
    });

    test("前線と自 PR の起票日時の日数差を正しく計算する", () => {
      // 2026-09-23 12:00 〜 2026-10-25 12:00 (32 日差)
      const res = calculateCalendarGap("2026-09-23 12:00", "2026-10-25 12:00");
      expect(res.gapDays).toBe(32);
    });
  });

  describe("formatDeltaBadge", () => {
    const countOptions = undefined; // 待ち件数用 (higherIsBetter = false: 減少が改善)
    const prNumberOptions = { higherIsBetter: true, unit: "" }; // PR番号用 (増加が進行、減少が後退)

    test.each([
      ["待ち件数: 負数（前線進行）", -8, countOptions, "-8", "delta-progress", "8 件進行"],
      ["待ち件数: 正数（後退・巻き戻り）", 12, countOptions, "+12", "delta-rewind", "+12 件増加"],
      ["待ち件数: ゼロ", 0, countOptions, "±0", "delta-neutral", undefined],
      ["待ち件数: null", null, countOptions, "-", "delta-neutral", undefined],
      ["PR番号: 正数（前線番号の増加）", 50, prNumberOptions, "+50", "delta-progress", "+50進行"],
      [
        "PR番号: 負数（前線番号の巻き戻り）",
        -8546,
        prNumberOptions,
        "-8546",
        "delta-rewind",
        "-8546後退",
      ],
    ])("%s", (_name, value, options, text, className, labelPart) => {
      const b = formatDeltaBadge(value, options);
      expect(b.text).toBe(text);
      expect(b.className).toBe(className);
      if (labelPart !== undefined) expect(b.label).toContain(labelPart);
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

describe("selectComparableHistory", () => {
  const baseRow: ProgressHistoryRow = {
    Timestamp: "2026-11-07(土) 12:00",
    TargetPr: "100",
    FrontNumber: "50",
    FrontCreatedAt: "2026-10-01 10:00",
    ActiveAhead: "120",
    TotalAhead: "150",
    QueueBasis: "updated",
    Behind: "30",
    TotalLifetimeDays: "5",
    TurnLatencyDays: "5",
    WaitDays: "4.5",
    CommitCount: "1",
  };

  test.each([
    ["離脱の累積件数がある行は数値にする", { MergedOlder: "192", ClosedOlder: "27" }, 192, 27],
    ["空欄の旧い行は null（0 件と誤認させない）", { MergedOlder: "", ClosedOlder: "" }, null, null],
    ["列が省略された行は null", {}, null, null],
    ["数値でない値は null", { MergedOlder: "abc", ClosedOlder: "x" }, null, null],
    ["0 件は 0 のまま", { MergedOlder: "0", ClosedOlder: "0" }, 0, 0],
  ])("履歴レコードの離脱の累積件数: %s", (_name, extra, merged, closed) => {
    const [record] = selectComparableHistory([{ ...baseRow, ...extra }], 100);
    expect(record.mergedOlder).toBe(merged);
    expect(record.closedOlder).toBe(closed);
  });

  test("新定義の行を数値に変換する", () => {
    const [record] = selectComparableHistory([baseRow], 100);
    expect(record).toMatchObject({
      targetPr: 100,
      frontNumber: 50,
      activeAhead: 120,
      totalAhead: 150,
      behind: 30,
      waitDays: 4.5,
      frontCreatedAt: "2026-10-01 10:00",
    });
    expect(Number.isNaN(record.timestampMs)).toBeFalse();
  });

  test.each([
    ["別の基準 PR の行", { TargetPr: "999" }],
    ["QueueBasis が空欄の旧定義の行", { QueueBasis: "" }],
    ["QueueBasis が現行と異なる行", { QueueBasis: "created" }],
    ["ActiveAhead が空欄の行（0 件として扱わない）", { ActiveAhead: "" }],
    ["FrontNumber が空欄の行", { FrontNumber: "" }],
    ["時刻が不正な行", { Timestamp: "invalid" }],
  ])("%s は履歴から除く", (_name, override) => {
    expect(selectComparableHistory([{ ...baseRow, ...override }], 100)).toEqual([]);
  });

  test("速度・前回比の計算には新定義の行だけが渡る", () => {
    const rows: ProgressHistoryRow[] = [
      { ...baseRow, Timestamp: "2026-11-06(金) 12:00", ActiveAhead: "2000", QueueBasis: "" },
      { ...baseRow, Timestamp: "2026-11-07(土) 00:00", ActiveAhead: "120" },
      { ...baseRow, Timestamp: "2026-11-07(土) 12:00", ActiveAhead: "108" },
    ];
    const records = selectComparableHistory(rows, 100);
    expect(records.map((r) => r.activeAhead)).toEqual([120, 108]);
    // 旧定義の 2000 件が混ざらないので、12 時間で 12 件消化 = 24 件/日
    const velocity = calculateVelocityMetrics(records, 108);
    expect(velocity.velocityPerDay).toBe(24);
  });
});
