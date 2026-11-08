import { describe, expect, test } from "bun:test";
import {
  calculateForecastComparison,
  type ForecastComparisonSource,
} from "../../src/domain/forecast-comparison";
import type { HistoryRecord } from "../../src/models/dashboard";
import type { StaleFrontierSample } from "../../src/models/forecast";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-08T00:00:00Z");

const record = (hoursAgo: number, activeAhead: number): HistoryRecord => ({
  timestamp: "",
  timestampMs: NOW - hoursAgo * HOUR,
  targetPr: 1,
  frontNumber: 1,
  activeAhead,
  totalAhead: activeAhead,
  behind: 0,
  waitDays: 0,
});

/** 遭難の底の先頭。観測は hoursAgo 時間前、先頭の最終更新は現在の updatedDaysAgo 日前 */
const sample = (hoursAgo: number, updatedDaysAgo: number): StaleFrontierSample => ({
  timestampMs: NOW - hoursAgo * HOUR,
  pr: 10,
  updatedMs: NOW - updatedDaysAgo * DAY,
});

const baseSource = (
  overrides: Partial<ForecastComparisonSource> = {},
): ForecastComparisonSource => ({
  nowMs: NOW,
  targetCreatedMs: NOW - 10 * DAY,
  targetUpdatedMs: NOW - 3 * DAY,
  activeAhead: 2400,
  totalMedianDays: 44,
  totalP75Days: 45,
  // 24 時間で 100 件減（100 件/日）。残り 2400 件 → 24 日後
  history: [record(24, 2500), record(0, 2400)],
  // 先頭の更新は 30 日前のまま動かず（遅れ 30 日）、基準 PR との更新差は 27 日 → 定常モデルは 27 日後
  frontierSamples: [sample(24, 30), sample(0, 30)],
  ...overrides,
});

const estimateOf = (comparison: ReturnType<typeof calculateForecastComparison>, key: string) =>
  comparison.hypotheses.flatMap((h) => h.estimates).find((e) => e.key === key);

describe("Domain: calculateForecastComparison", () => {
  test("3 つの仮説それぞれの予想日と、主な予想日の範囲を返す", () => {
    const result = calculateForecastComparison(baseSource());

    expect(result.hypotheses.map((h) => h.id)).toEqual([
      "rank-velocity",
      "update-order",
      "creation-order",
    ]);
    expect(estimateOf(result, "rank-velocity")).toMatchObject({
      dateMs: NOW + 24 * DAY,
      etaDays: 24,
      primary: true,
    });
    expect(estimateOf(result, "update-order:steady")).toMatchObject({
      dateMs: NOW + 27 * DAY,
      etaDays: 27,
    });
    // 起票 10 日前 + 中央値 44 日 = 34 日後。75%点は補助
    expect(estimateOf(result, "creation-order:median")).toMatchObject({
      dateMs: NOW + 34 * DAY,
      etaDays: 34,
      primary: true,
    });
    expect(estimateOf(result, "creation-order:p75")).toMatchObject({
      dateMs: NOW + 35 * DAY,
      primary: false,
    });
    expect(result.range).toEqual({
      startMs: NOW + 24 * DAY,
      endMs: NOW + 34 * DAY,
      minDays: 24,
      maxDays: 34,
    });
  });

  test("範囲には主な予想だけを使い、補助の 75%点は含めない", () => {
    const result = calculateForecastComparison(baseSource({ totalP75Days: 100 }));
    expect(result.range?.maxDays).toBe(34);
  });

  test("作成順の進捗は、起票からの経過日数 / 中央値の割合で表す", () => {
    const creation = calculateForecastComparison(baseSource()).hypotheses[2];
    expect(creation.progressRatio).toBeCloseTo(10 / 44, 6);
    expect(creation.progressText).toContain("起票から 10 日 / 通算所要日数の中央値 44 日（23%）");
    // 割合が自然に定義できない仮説は持たない
    expect(calculateForecastComparison(baseSource()).hypotheses[0].progressRatio).toBeNull();
    expect(calculateForecastComparison(baseSource()).hypotheses[1].progressRatio).toBeNull();
  });

  test("中央値を超過していれば残り日数は 0、進捗は 100% で頭打ちにする", () => {
    const result = calculateForecastComparison(
      baseSource({ targetCreatedMs: NOW - 50 * DAY, totalMedianDays: 44, totalP75Days: 60 }),
    );
    const creation = result.hypotheses[2];
    expect(creation.progressRatio).toBe(1);
    expect(creation.progressText).toContain("中央値を超過");
    expect(estimateOf(result, "creation-order:median")?.etaDays).toBe(0);
  });

  test.each([
    ["観測が 1 件しかない", [record(0, 2400)], "速度を測る観測が足りません"],
    ["待ち件数が増えている（後退）", [record(24, 2300), record(0, 2400)], "停滞または後退中"],
    ["待ち件数が変わらない（停滞）", [record(24, 2400), record(0, 2400)], "停滞または後退中"],
  ])("順位消化は速度から予想できないとき予想日を出さず理由を示す: %s", (_name, history, text) => {
    const result = calculateForecastComparison(baseSource({ history }));
    expect(result.hypotheses[0].estimates).toEqual([]);
    expect(result.hypotheses[0].progressText).toContain(text);
    // 他の仮説は影響を受けない
    expect(estimateOf(result, "update-order:steady")).toBeDefined();
  });

  test("更新順は、先頭が進んでいれば実測の速度による予想も出す", () => {
    // 24 時間で先頭の更新が 30 日前 → 29 日前へ 1 日分進む。実測速度 1 日/日、遅れ 29 日、更新差 26 日
    const result = calculateForecastComparison(
      baseSource({ frontierSamples: [sample(24, 30), sample(0, 29)] }),
    );
    expect(estimateOf(result, "update-order:steady")?.etaDays).toBe(26);
    expect(estimateOf(result, "update-order:observed")).toBeDefined();
  });

  test("更新順は、先頭が進んでいなければ実測を出さず理由を示す", () => {
    const update = calculateForecastComparison(baseSource()).hypotheses[1];
    expect(update.estimates.map((e) => e.key)).toEqual(["update-order:steady"]);
    expect(update.progressText).toContain("先頭 #10 の遅れ 30 日 / 基準 PR との更新差 27 日");
    expect(update.progressText).toContain("観測期間内に先頭が進んでいないため算出できません");
  });

  test.each([
    ["先頭の観測が無い", { frontierSamples: [] }, "遭難の底の観測がありません"],
    ["基準 PR の更新時刻が不明", { targetUpdatedMs: null }, "基準 PR の更新時刻が未記録です"],
  ])("更新順は予想日を出せない理由を示す: %s", (_name, overrides, text) => {
    const update = calculateForecastComparison(baseSource(overrides)).hypotheses[1];
    expect(update.estimates).toEqual([]);
    expect(update.progressText).toContain(text);
  });

  test.each([
    ["統計が無い（旧スナップショット）", { totalMedianDays: null, totalP75Days: null }],
    ["起票時刻が不明", { targetCreatedMs: Number.NaN }],
  ])("作成順は算出できないとき予想日も進捗も持たない: %s", (_name, overrides) => {
    const creation = calculateForecastComparison(baseSource(overrides)).hypotheses[2];
    expect(creation.estimates).toEqual([]);
    expect(creation.progressRatio).toBeNull();
    expect(creation.progressText).toContain("未記録です");
  });

  test("観測時刻が不明なときは、どの仮説も予想日を出さず範囲も無い", () => {
    const result = calculateForecastComparison(baseSource({ nowMs: Number.NaN }));
    expect(result.range).toBeNull();
    for (const h of result.hypotheses) {
      expect(h.estimates).toEqual([]);
      expect(h.progressRatio).toBeNull();
    }
  });

  test("どの仮説も予想日を出せなければ範囲は null", () => {
    const result = calculateForecastComparison(
      baseSource({
        history: [],
        frontierSamples: [],
        totalMedianDays: null,
        totalP75Days: null,
      }),
    );
    expect(result.range).toBeNull();
    expect(result.hypotheses.every((h) => h.estimates.length === 0)).toBeTrue();
  });
});
