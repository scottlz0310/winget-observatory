import { describe, expect, test } from "bun:test";
import { buildForecastBandSource, calculateForecastBand } from "../../src/domain/forecast-band";
import { DAY_MS } from "../../src/domain/formatters";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "../../src/domain/intervention";
import type { HistoryRecord } from "../../src/models/dashboard";
import type { DepthsSnapshot } from "../../src/models/depths";
import type { MainstreamFrontierSample } from "../../src/models/forecast";
import type { ProgressSnapshot } from "../../src/models/progress";

const T0 = Date.parse("2026-11-18T20:05:00Z"); // 2026-11-19 05:05 JST
const TARGET_CREATED = Date.parse("2026-10-28T21:47:38Z"); // 2026-10-29 06:47 JST

function makeHistory(activeAheadStart: number, activeAheadEnd: number): HistoryRecord[] {
  return [
    {
      timestamp: "2026-11-12 05:00:00",
      timestampMs: T0 - 7 * DAY_MS,
      targetPr: 464302,
      frontNumber: 436000,
      activeAhead: activeAheadStart,
      totalAhead: activeAheadStart,
      behind: 1000,
      waitDays: 14,
    },
    {
      timestamp: "2026-11-19 05:01:00",
      timestampMs: T0 - 4 * 60 * 1000,
      targetPr: 464302,
      frontNumber: 436234,
      activeAhead: activeAheadEnd,
      totalAhead: 1472,
      behind: 1775,
      waitDays: 20.9,
    },
  ];
}

function makeMainstreamSamples(medianDaysAgo: number): MainstreamFrontierSample[] {
  return [
    {
      timestampMs: T0 - 36 * 3_600_000,
      createdMs: T0 - (medianDaysAgo + 0.9) * DAY_MS,
      cohortCount: 77,
      openCount: 40,
      mergedCount: 37,
      mode: FIRST_REVIEW_MAINSTREAM_MODE,
    },
    {
      timestampMs: T0,
      createdMs: T0 - medianDaysAgo * DAY_MS,
      cohortCount: 80,
      openCount: 41,
      mergedCount: 39,
      mode: FIRST_REVIEW_MAINSTREAM_MODE,
    },
  ];
}

describe("Domain: buildForecastBandSource & calculateForecastBand", () => {
  test("全指標が揃っているとき前線・本命中央値・大底・全体レンジを統合算出する", () => {
    const progress: Partial<ProgressSnapshot> = {
      Timestamp: new Date(T0).toISOString(),
      TargetPr: 464302,
      FrontNumber: 436234,
      FrontCreatedAt: "2026-09-17(木) 06:01",
      ActiveAhead: 1609,
      TotalMedianDays: 38.55,
      TotalP75Days: 45.31,
      FirstTimerMedianDays: 31.14,
      FirstTimerP75Days: 39.19,
      LookbackDays: 30,
      FirstTimerLookbackDays: 90,
    };
    const depths: Partial<DepthsSnapshot> = {
      DepthsVersion: 4,
      Timestamp: new Date(T0).toISOString(),
      TargetPr: {
        Number: 464302,
        Title: "test",
        Url: "https://example.com/464302",
        CreatedAt: new Date(TARGET_CREATED).toISOString(),
        CreatedAtJst: "2026-10-29 06:47",
        UpdatedAt: "2026-11-05T04:45:16Z",
      },
      HealthyBottom: [
        {
          PR: "#436234",
          Number: 436234,
          作成日時: "2026-09-17 06:01",
          更新日時: "2026-11-16 22:32",
          CreatedAt: "2026-09-16T21:01:02Z",
          UpdatedAt: "2026-11-16T13:32:58Z",
          タイトル: "Healthy",
          Title: "Healthy",
          Url: "https://example.com/436234",
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
          タイトル: "Stale",
          Title: "Stale",
          Url: "https://example.com/449390",
        },
      ],
    };

    // activeAhead: 2145 -> 1609 (7日あたり 536件減 = 76.6件/日 -> 1609 / 76.6 = 21.0日)
    const history = makeHistory(2145, 1609);
    // T0 から 45.1日前（= 2026-10-04T17:41Z 頃）が主戦場ライン中央値 -> gap 約 24.2日
    const mainstreamSamples = makeMainstreamSamples(45.1);

    const source = buildForecastBandSource({
      progress,
      depths,
      history,
      mainstreamFrontierSamples: mainstreamSamples,
    });
    const band = calculateForecastBand(source);

    // 前線: 初回 P50 (残り約10.2日) 〜 優等生の底 (残り約19.6日)
    expect(band.front).not.toBeNull();
    expect(band.front?.estimates.map((e) => e.key)).toEqual([
      "first-timer:p50",
      "stale-bottom:steady",
    ]);
    expect(band.front?.etaDays).toBeCloseTo(10.2, 1);
    expect(band.front?.range.maxDays).toBeCloseTo(19.6, 1);

    // 本命中央値: creation-order:median (~17.6d), first-timer:p75 (~18.3d), rank-velocity (~21.0d), mainstream-steady (~24.2d)
    expect(band.mainstream).not.toBeNull();
    expect(band.mainstream?.estimates.map((e) => e.key)).toEqual([
      "creation-order:median",
      "first-timer:p75",
      "rank-velocity",
      "mainstream-steady",
    ]);
    expect(band.mainstream?.range.minDays).toBeCloseTo(17.6, 1);
    expect(band.mainstream?.range.maxDays).toBeCloseTo(24.2, 1);
    // 中央 2 点 (first-timer:p75 と rank-velocity) の平均 ≈ 19.6〜19.7日
    expect(band.mainstream?.medianEtaDays).toBeGreaterThanOrEqual(19);
    expect(band.mainstream?.medianEtaDays).toBeLessThanOrEqual(20.5);

    // 大底: 健康的大底 (#436234, gap 42.0日)
    expect(band.bottom).not.toBeNull();
    expect(band.bottom?.etaDays).toBeCloseTo(42.0, 1);
    expect(band.snapshot.healthyBottomPr).toBe(436234);
    expect(band.snapshot.healthyBottomGapDays).toBeCloseTo(42.0, 1);
    expect(band.snapshot.staleBottomPr).toBe(449390);
    expect(band.snapshot.staleBottomGapDays).toBeCloseTo(19.6, 1);

    // 全体レンジ: 前線 (~10.2d) 〜 大底 (~42.0d)
    expect(band.overallRange?.minDays).toBeCloseTo(10.2, 1);
    expect(band.overallRange?.maxDays).toBeCloseTo(42.0, 1);
  });

  test("基準 PR が介入済み・到達済みの場合は mainstream-steady をマージ本命バンドに混入させない", () => {
    const progress: Partial<ProgressSnapshot> = {
      Timestamp: new Date(T0).toISOString(),
      TargetPr: 464302,
      ActiveAhead: 1000,
      TotalMedianDays: 38,
      FirstTimerP75Days: 40,
    };
    const depths: Partial<DepthsSnapshot> = {
      DepthsVersion: 4,
      Timestamp: new Date(T0).toISOString(),
      TargetPr: {
        Number: 464302,
        Title: "test",
        Url: "https://example.com/464302",
        CreatedAt: new Date(TARGET_CREATED).toISOString(),
        CreatedAtJst: "2026-10-29 06:47",
        UpdatedAt: new Date(T0).toISOString(),
        Intervention: {
          Intervened: true,
          ThirdPartyAssignees: ["maintainer"],
          HumanReviewCount: 1,
          ManualCommentCount: 0,
        },
      },
      FirstReviewFrontier: {
        Mode: FIRST_REVIEW_MAINSTREAM_MODE,
        WindowDays: 7,
        CohortCount: 30,
        OpenCount: 15,
        MergedCount: 15,
        MedianCreatedAt: new Date(T0 - 45 * DAY_MS).toISOString(),
        LagDays: 45,
      },
    };

    const band = calculateForecastBand(buildForecastBandSource({ progress, depths, history: [] }));
    expect(band.snapshot.firstReview.status).toBe("target-intervened");
    expect(band.mainstream?.estimates.map((e) => e.key)).toEqual([
      "creation-order:median",
      "first-timer:p75",
    ]);
    expect(band.mainstream?.range.minDays).toBeGreaterThan(15);
  });

  test.each([
    ["主戦場サンプル未指定時は depths.FirstReviewFrontier にフォールバックする", true],
    ["StaleBottom 欠損時は FirstTimerMedianDays のみで前線を算出する", false],
  ])("フォールバックと部分欠損処理: %s", (_name, includeFrontier) => {
    const progress: Partial<ProgressSnapshot> = {
      Timestamp: new Date(T0).toISOString(),
      TargetPr: 464302,
      FrontNumber: 436234,
      FrontCreatedAt: "2026-09-17(木) 06:01",
      FirstTimerMedianDays: 30,
    };
    const depths: Partial<DepthsSnapshot> = {
      DepthsVersion: 4,
      Timestamp: new Date(T0).toISOString(),
      TargetPr: {
        Number: 464302,
        Title: "test",
        Url: "https://example.com/464302",
        CreatedAt: new Date(TARGET_CREATED).toISOString(),
        CreatedAtJst: "2026-10-29 06:47",
        UpdatedAt: new Date(T0).toISOString(),
      },
      ...(includeFrontier
        ? {
            FirstReviewFrontier: {
              Mode: FIRST_REVIEW_MAINSTREAM_MODE,
              WindowDays: 7,
              CohortCount: 25,
              OpenCount: 10,
              MergedCount: 15,
              MedianCreatedAt: new Date(T0 - 45 * DAY_MS).toISOString(),
              LagDays: 45,
            },
          }
        : {}),
    };

    const band = calculateForecastBand(buildForecastBandSource({ progress, depths, history: [] }));
    expect(band.front?.estimates.map((e) => e.key)).toEqual(["first-timer:p50"]);
    expect(band.bottom?.etaDays).toBeCloseTo(42.0, 1);
    if (includeFrontier) {
      expect(band.mainstream?.estimates.map((e) => e.key)).toEqual(["mainstream-steady"]);
    } else {
      expect(band.mainstream).toBeNull();
    }
  });

  test("すでに超過・到達済みの指標は nowMs（残り 0 日）へクランプされる", () => {
    const progress: Partial<ProgressSnapshot> = {
      Timestamp: new Date(T0).toISOString(),
      TargetPr: 464302,
      FirstTimerMedianDays: 10, // すでに 20.9日経過しているため超過
      TotalMedianDays: 15, // 超過
    };
    const depths: Partial<DepthsSnapshot> = {
      DepthsVersion: 4,
      Timestamp: new Date(T0).toISOString(),
      TargetPr: {
        Number: 464302,
        Title: "test",
        Url: "https://example.com/464302",
        CreatedAt: new Date(TARGET_CREATED).toISOString(),
        CreatedAtJst: "2026-10-29 06:47",
        UpdatedAt: new Date(T0).toISOString(),
      },
      HealthyBottom: [
        {
          PR: "#470000",
          Number: 470000,
          作成日時: "2026-11-01 00:00",
          更新日時: "2026-11-01 00:00",
          CreatedAt: "2026-11-01T00:00:00Z", // 基準 PR より後なので到達済み
          UpdatedAt: "2026-11-01T00:00:00Z",
          タイトル: "Newer",
          Title: "Newer",
          Url: "https://example.com/470000",
        },
      ],
    };

    const band = calculateForecastBand(buildForecastBandSource({ progress, depths, history: [] }));
    expect(band.front?.dateMs).toBe(T0);
    expect(band.front?.etaDays).toBe(0);
    expect(band.mainstream?.medianDateMs).toBe(T0);
    expect(band.mainstream?.medianEtaDays).toBe(0);
    expect(band.bottom?.dateMs).toBe(T0);
    expect(band.bottom?.etaDays).toBe(0);
  });

  test("観測時刻が不明な場合は全バンドを null として安全に返す", () => {
    const band = calculateForecastBand(
      buildForecastBandSource({ progress: null, depths: null, history: [] }),
    );
    expect(Number.isNaN(band.nowMs)).toBe(true);
    expect(band.front).toBeNull();
    expect(band.mainstream).toBeNull();
    expect(band.bottom).toBeNull();
    expect(band.overallRange).toBeNull();
  });
});
