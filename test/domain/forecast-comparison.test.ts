import { describe, expect, test } from "bun:test";
import {
  buildForecastSource,
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

  test("作成順の進捗は、起票からの経過日数 / 中央値の割合で表し、全体30日実績であることを明記する", () => {
    const creation = calculateForecastComparison(baseSource()).hypotheses[2];
    expect(creation.progressRatio).toBeCloseTo(10 / 44, 6);
    expect(creation.progressText).toContain("起票から 10 日 / 通算所要日数の中央値 44 日（23%）");
    expect(creation.premise).toContain("直近（30日間）の全体マージ実績（常連・特急含む）");
    expect(creation.note).toContain("上部の初回提出者90日コホート統計とは母集団が異なります");
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

  test("順位消化は 168 時間窓を基準とし、日数と時間を併記した進捗テキストを返す", () => {
    const result = calculateForecastComparison(
      baseSource({
        activeAhead: 2100,
        history: [record(200, 2600), record(168, 2450), record(24, 2150), record(0, 2100)],
      }),
    );
    const rank = result.hypotheses[0];
    expect(rank.progressText).toBe(
      "実質待ち 2,100 件。直近 7.0 日（168.0 時間）で 350 件減（50 件/日）",
    );
    expect(estimateOf(result, "rank-velocity")?.etaDays).toBe(42);
  });

  test.each([
    ["観測が 1 件しかない", [record(0, 2400)], "速度を測る観測が足りません"],
    [
      "待ち件数が増えている（後退）",
      [record(168, 2300), record(0, 2400)],
      "直近 7.0 日（168.0 時間）は停滞または後退中",
    ],
    [
      "待ち件数が変わらない（停滞）",
      [record(24, 2400), record(0, 2400)],
      "直近 1.0 日（24.0 時間）は停滞または後退中",
    ],
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
    ["先頭の観測が無い", { frontierSamples: [] }, "優等生の底の観測がありません"],
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

  test.each([
    ["既定値（省略時は 30日 / 90日）", {}, "直近（30日間）", "初回提出者90日コホート統計"],
    [
      "非既定値（14日 / 60日）",
      { lookbackDays: 14, firstTimerLookbackDays: 60 },
      "直近（14日間）",
      "初回提出者60日コホート統計",
    ],
    [
      "初回期間のみ省略時は全体期間を継承（14日 / 14日）",
      { lookbackDays: 14 },
      "直近（14日間）",
      "初回提出者14日コホート統計",
    ],
    [
      "不正な非正値は既定値へフォールバック（0 / -5 -> 30日 / 90日）",
      { lookbackDays: 0, firstTimerLookbackDays: -5 },
      "直近（30日間）",
      "初回提出者90日コホート統計",
    ],
  ])(
    "作成順の説明文は指定された集計期間を反映する: %s",
    (_name, overrides, expectedPremise, expectedNote) => {
      const creation = calculateForecastComparison(baseSource(overrides)).hypotheses[2];
      expect(creation.premise).toContain(expectedPremise);
      expect(creation.note).toContain(expectedNote);
    },
  );
});

describe("Domain: buildForecastSource", () => {
  const history = [record(24, 2500), record(0, 2400)];
  const frontierSamples = [sample(24, 30), sample(0, 30)];
  const depths = {
    TargetPr: {
      Number: 1,
      Title: "t",
      Url: "u",
      CreatedAt: "2026-10-29T00:00:00Z",
      CreatedAtJst: "",
      UpdatedAt: "2026-11-05T00:00:00Z",
    },
  };

  test("スナップショットの値を、比較の入力へ写す", () => {
    const source = buildForecastSource({
      progress: {
        Timestamp: "2026-11-08T00:00:00Z",
        ActiveAhead: 2400,
        TotalMedianDays: 44,
        TotalP75Days: 45,
      },
      depths,
      history,
      frontierSamples,
    });
    expect(source).toMatchObject({
      nowMs: Date.parse("2026-11-08T00:00:00Z"),
      targetCreatedMs: Date.parse("2026-10-29T00:00:00Z"),
      targetUpdatedMs: Date.parse("2026-11-05T00:00:00Z"),
      activeAhead: 2400,
      totalMedianDays: 44,
      totalP75Days: 45,
    });
    expect(source.history).toBe(history);
    expect(source.frontierSamples).toBe(frontierSamples);
  });

  test.each([
    ["進捗スナップショットの観測時刻を優先する", { Timestamp: "2026-11-09T00:00:00Z" }, NOW + DAY],
    ["観測時刻が無ければ、履歴の最新観測を使う", {}, NOW],
  ])("観測時刻: %s", (_name, progress, expected) => {
    expect(buildForecastSource({ progress, depths, history, frontierSamples }).nowMs).toBe(
      expected,
    );
  });

  test("履歴も無ければ遭難の底の最新観測を使い、それも無ければ NaN", () => {
    expect(
      buildForecastSource({ progress: null, depths: null, history: [], frontierSamples }).nowMs,
    ).toBe(NOW);
    expect(
      buildForecastSource({ progress: null, depths: null, history: [], frontierSamples: [] }).nowMs,
    ).toBeNaN();
  });

  test("スナップショットが無い・値が欠けていれば、既定の値（待ち 0 件・更新時刻 null・起票時刻 NaN）にする", () => {
    const source = buildForecastSource({
      progress: null,
      depths: null,
      history: [],
      frontierSamples: [],
    });
    expect(source.activeAhead).toBe(0);
    expect(source.targetUpdatedMs).toBeNull();
    expect(source.targetCreatedMs).toBeNaN();
    expect(source.totalMedianDays).toBeUndefined();
    expect(source.lookbackDays).toBeUndefined();
    expect(source.firstTimerLookbackDays).toBeUndefined();
  });

  test("非既定の LookbackDays / FirstTimerLookbackDays を引き渡し、作成順仮説の説明文と整合する", () => {
    const source = buildForecastSource({
      progress: {
        Timestamp: "2026-11-08T00:00:00Z",
        ActiveAhead: 2400,
        TotalMedianDays: 44,
        TotalP75Days: 45,
        LookbackDays: 14,
        FirstTimerLookbackDays: 60,
      },
      depths,
      history,
      frontierSamples,
    });
    expect(source.lookbackDays).toBe(14);
    expect(source.firstTimerLookbackDays).toBe(60);

    const creation = calculateForecastComparison(source).hypotheses[2];
    expect(creation.premise).toContain("直近（14日間）の全体マージ実績");
    expect(creation.note).toContain("初回提出者60日コホート統計");
  });

  test("FirstTimerLookbackDays 省略時は LookbackDays を初回コホート期間として引き継ぐ", () => {
    const source = buildForecastSource({
      progress: {
        Timestamp: "2026-11-08T00:00:00Z",
        ActiveAhead: 2400,
        TotalMedianDays: 44,
        TotalP75Days: 45,
        LookbackDays: 21,
      },
      depths,
      history,
      frontierSamples,
    });
    expect(source.lookbackDays).toBe(21);
    expect(source.firstTimerLookbackDays).toBe(21);

    const creation = calculateForecastComparison(source).hypotheses[2];
    expect(creation.premise).toContain("直近（21日間）の全体マージ実績");
    expect(creation.note).toContain("初回提出者21日コホート統計");
  });
});
