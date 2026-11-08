import { describe, expect, test } from "bun:test";
import {
  buildExitCountQueries,
  calculateExitBreakdown,
  MIN_EXIT_WINDOW_HOURS,
} from "../../src/domain/exit-breakdown";
import type { HistoryRecord } from "../../src/models/dashboard";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-08T00:00:00Z");

const record = (
  hoursAgo: number,
  v: {
    activeAhead: number;
    totalAhead: number;
    mergedOlder?: number | null;
    closedOlder?: number | null;
  },
): HistoryRecord => ({
  timestamp: "",
  timestampMs: NOW - hoursAgo * HOUR,
  targetPr: 1,
  frontNumber: 1,
  activeAhead: v.activeAhead,
  totalAhead: v.totalAhead,
  behind: 0,
  waitDays: 0,
  mergedOlder: v.mergedOlder === undefined ? 0 : v.mergedOlder,
  closedOlder: v.closedOlder === undefined ? 0 : v.closedOlder,
});

describe("Domain: buildExitCountQueries", () => {
  const queries = buildExitCountQueries("o/r", "2026-10-29T06:47:00Z", ["A-1", "B-2"]);

  test("マージ: 起票が基準 PR より前で、基準 PR の起票以降にマージされた、必須ラベル付きの PR", () => {
    expect(queries.merged).toBe(
      'repo:o/r is:pr created:<2026-10-29T06:47:00Z label:"A-1" label:"B-2" is:merged merged:>=2026-10-29T06:47:00Z',
    );
  });

  test("クローズ: 同じ条件で、未マージのままクローズされた PR", () => {
    expect(queries.closed).toBe(
      'repo:o/r is:pr created:<2026-10-29T06:47:00Z label:"A-1" label:"B-2" is:closed is:unmerged closed:>=2026-10-29T06:47:00Z',
    );
  });
});

describe("Domain: calculateExitBreakdown", () => {
  test("実質待ちの減少を、マージ・クローズ・健康条件の変化・更新による入れ替わりに分解する", () => {
    // 24 時間で、実質待ち 100 件減、累積待ち 30 件減、マージ 24 件、クローズ 4 件
    const result = calculateExitBreakdown([
      record(24, { activeAhead: 2500, totalAhead: 2100, mergedOlder: 100, closedOlder: 10 }),
      record(0, { activeAhead: 2400, totalAhead: 2070, mergedOlder: 124, closedOlder: 14 }),
    ]);

    expect(result).toEqual({
      available: true,
      hours: 24,
      baseMs: NOW - 24 * HOUR,
      latestMs: NOW,
      counts: { rank: 100, created: 30, merged: 24, closed: 4, healthChange: 2, reshuffle: 70 },
      perDay: { rank: 100, created: 30, merged: 24, closed: 4, healthChange: 2, reshuffle: 70 },
      mergeShare: 0.24,
    });
  });

  test("内訳は足し合わせると、実質待ちの減少に一致する", () => {
    const result = calculateExitBreakdown([
      record(30, { activeAhead: 2507, totalAhead: 2107, mergedOlder: 50, closedOlder: 7 }),
      record(0, { activeAhead: 2448, totalAhead: 2090, mergedOlder: 71, closedOlder: 9 }),
    ]);
    if (!result.available) throw new Error("算出できるはず");
    const { counts } = result;
    expect(counts.merged + counts.closed + counts.healthChange + counts.reshuffle).toBe(
      counts.rank,
    );
  });

  test("1 日あたりに換算する（間隔が 24 時間でなければ按分し、小数 1 桁に丸める）", () => {
    // 12 時間で実質待ち 50 件減、マージ 11 件 → 1 日あたり 100 件、22 件
    const result = calculateExitBreakdown([
      record(12, { activeAhead: 2500, totalAhead: 2100, mergedOlder: 0, closedOlder: 0 }),
      record(0, { activeAhead: 2450, totalAhead: 2080, mergedOlder: 11, closedOlder: 3 }),
    ]);
    if (!result.available) throw new Error("算出できるはず");
    expect(result.hours).toBe(12);
    expect(result.perDay.rank).toBe(100);
    expect(result.perDay.merged).toBe(22);
    expect(result.perDay.closed).toBe(6);
  });

  test("比較の起点は、24 時間以上前の観測のうち最も新しいもの（無ければ最古のもの）", () => {
    const records = [
      record(60, { activeAhead: 3000, totalAhead: 2500, mergedOlder: 0, closedOlder: 0 }),
      record(30, { activeAhead: 2600, totalAhead: 2200, mergedOlder: 10, closedOlder: 1 }),
      record(10, { activeAhead: 2550, totalAhead: 2180, mergedOlder: 14, closedOlder: 2 }),
      record(0, { activeAhead: 2500, totalAhead: 2160, mergedOlder: 18, closedOlder: 3 }),
    ];
    const result = calculateExitBreakdown(records);
    if (!result.available) throw new Error("算出できるはず");
    expect(result.hours).toBe(30);
    expect(result.counts.rank).toBe(100);

    // 24 時間に満たなければ、最古の観測を起点にする
    const recent = calculateExitBreakdown(records.slice(2));
    if (!recent.available) throw new Error("算出できるはず");
    expect(recent.hours).toBe(10);
  });

  test("実質待ちが減っていなければ、マージの割合は null（0 割りを避ける）", () => {
    const result = calculateExitBreakdown([
      record(24, { activeAhead: 2400, totalAhead: 2000, mergedOlder: 0, closedOlder: 0 }),
      record(0, { activeAhead: 2450, totalAhead: 2010, mergedOlder: 20, closedOlder: 0 }),
    ]);
    if (!result.available) throw new Error("算出できるはず");
    expect(result.counts.rank).toBe(-50);
    expect(result.mergeShare).toBeNull();
  });

  test.each([
    ["観測が無い", []],
    ["観測が 1 回だけ", [record(0, { activeAhead: 1, totalAhead: 1 })]],
    [
      "内訳の記録が無い観測（旧い行）だけ",
      [
        record(24, { activeAhead: 1, totalAhead: 1, mergedOlder: null, closedOlder: null }),
        record(0, { activeAhead: 1, totalAhead: 1, mergedOlder: null, closedOlder: null }),
      ],
    ],
    [
      "記録のある観測が 1 回だけ（旧い行と混在）",
      [
        record(24, { activeAhead: 1, totalAhead: 1, mergedOlder: null, closedOlder: null }),
        record(0, { activeAhead: 1, totalAhead: 1 }),
      ],
    ],
  ])("内訳の記録のある観測が 2 回に満たなければ算出しない: %s", (_name, records) => {
    expect(calculateExitBreakdown(records)).toEqual({ available: false, reason: "no-records" });
  });

  test(`観測の間隔が ${MIN_EXIT_WINDOW_HOURS} 時間に満たなければ算出しない`, () => {
    const result = calculateExitBreakdown([
      record(MIN_EXIT_WINDOW_HOURS - 1, { activeAhead: 2500, totalAhead: 2100 }),
      record(0, { activeAhead: 2490, totalAhead: 2095 }),
    ]);
    expect(result).toEqual({ available: false, reason: "short-window" });
  });

  test("ちょうど最小間隔なら算出する", () => {
    const result = calculateExitBreakdown([
      record(MIN_EXIT_WINDOW_HOURS, { activeAhead: 2500, totalAhead: 2100 }),
      record(0, { activeAhead: 2490, totalAhead: 2095 }),
    ]);
    expect(result.available).toBe(true);
  });

  test.each([
    ["マージの累積件数が減っている", { mergedOlder: 5, closedOlder: 14 }],
    ["クローズの累積件数が減っている", { mergedOlder: 124, closedOlder: 3 }],
  ])("累積件数が減っていれば、矛盾した記録として算出しない: %s", (_name, latest) => {
    const result = calculateExitBreakdown([
      record(24, { activeAhead: 2500, totalAhead: 2100, mergedOlder: 100, closedOlder: 10 }),
      record(0, { activeAhead: 2400, totalAhead: 2070, ...latest }),
    ]);
    expect(result).toEqual({ available: false, reason: "inconsistent" });
  });

  test("時刻が不正な観測は無視する", () => {
    const bad = { ...record(12, { activeAhead: 0, totalAhead: 0 }), timestampMs: Number.NaN };
    const result = calculateExitBreakdown([
      record(24, { activeAhead: 2500, totalAhead: 2100, mergedOlder: 100, closedOlder: 10 }),
      bad,
      record(0, { activeAhead: 2400, totalAhead: 2070, mergedOlder: 124, closedOlder: 14 }),
    ]);
    if (!result.available) throw new Error("算出できるはず");
    expect(result.hours).toBe(24);
  });
});
