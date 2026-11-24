import { describe, expect, test } from "bun:test";
import { CURRENT_DEPTHS_VERSION } from "../../src/domain/depths";
import {
  calculateFirstReviewForecast,
  calculateLifetimeForecast,
  extractFirstTimerFrontierSamples,
  extractHealthyFrontierSamples,
  extractMainstreamFrontierSamples,
  extractUnreviewedFrontierSamples,
  parseDepthsHistory,
} from "../../src/domain/forecast";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "../../src/domain/intervention";
import type { DepthsRow, DepthsSnapshot, FirstReviewFrontier } from "../../src/models/depths";
import type { MainstreamFrontierSample } from "../../src/models/forecast";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-01T00:00:00Z");

const row = (number: number, updatedAt: string, createdAt = updatedAt): DepthsRow => ({
  PR: `#${number}`,
  Number: number,
  作成日時: "",
  更新日時: "",
  CreatedAt: createdAt,
  UpdatedAt: updatedAt,
  タイトル: "",
  Title: "",
  Url: "",
});

const snapshot = (
  timestamp: string,
  stale: DepthsRow[],
  depthsVersion: number | null = CURRENT_DEPTHS_VERSION,
): DepthsSnapshot => ({
  ...(depthsVersion !== null ? { DepthsVersion: depthsVersion } : {}),
  Timestamp: timestamp,
  TimestampJst: "",
  Repository: "test/repo",
  TargetPr: null,
  HealthyBottom: [],
  AbsoluteBottom: [],
  StaleBottom: stale,
  ExpressLane: [],
});

describe("Domain: parseDepthsHistory", () => {
  test("BOM 付き・空行を含む JSONL をパースする", () => {
    const text = `﻿${JSON.stringify(snapshot("2026-11-01T00:00:00Z", []))}\n\n${JSON.stringify(snapshot("2026-11-01T04:00:00Z", []))}\n`;
    expect(parseDepthsHistory(text).map((s) => s.Timestamp)).toEqual([
      "2026-11-01T00:00:00Z",
      "2026-11-01T04:00:00Z",
    ]);
  });

  test("壊れた行は握りつぶさず行番号付きで例外にする", () => {
    const text = `${JSON.stringify(snapshot("2026-11-01T00:00:00Z", []))}\n{ broken\n`;
    expect(() => parseDepthsHistory(text)).toThrow("2 行目のパースに失敗しました");
  });
});

describe("Domain: extractFirstTimerFrontierSamples", () => {
  test("初回提出者の底の先頭を時刻昇順で取り出し、UpdatedAt ではなく CreatedAt（起票時刻）を抽出する", () => {
    const s1 = snapshot("2026-11-01T08:00:00Z", []);
    s1.FirstTimerBottom = [row(200, "2026-10-20T00:00:00Z", "2026-10-10T00:00:00Z")];
    const s2 = snapshot("2026-11-01T00:00:00Z", []);
    s2.FirstTimerBottom = [row(100, "2026-10-19T00:00:00Z", "2026-10-09T00:00:00Z")];
    const s3 = snapshot("2026-11-01T04:00:00Z", []);
    s3.FirstTimerBottom = [];
    const s4 = snapshot("invalid", []);
    s4.FirstTimerBottom = [row(300, "2026-10-11T00:00:00Z", "2026-10-11T00:00:00Z")];
    const s5 = snapshot("2026-11-01T06:00:00Z", []);
    s5.FirstTimerBottom = [row(400, "2026-10-12T00:00:00Z", "not-a-date")];
    const s6 = snapshot("2026-11-01T07:00:00Z", []);
    // FirstTimerBottom 未定義

    const samples = extractFirstTimerFrontierSamples([s1, s2, s3, s4, s5, s6]);
    expect(samples.map((s) => s.pr)).toEqual([100, 200]);
    expect(samples[0].createdMs).toBe(Date.parse("2026-10-09T00:00:00Z"));
    expect(samples[1].createdMs).toBe(Date.parse("2026-10-10T00:00:00Z"));
  });

  test("更新順で記録された旧定義の FirstTimerBottom 履歴は除外し、新定義（起票順・生涯マージ0回）のみを抽出する", () => {
    const oldUpdatedOrder = snapshot("2026-11-13T00:00:00Z", [], null);
    oldUpdatedOrder.FirstTimerBottom = [
      row(3001, "2026-11-02T00:00:00Z", "2026-11-01T00:00:00Z"),
      row(3002, "2026-11-03T00:00:00Z", "2026-10-01T00:00:00Z"),
    ];
    const newCreatedOrder = snapshot("2026-11-14T00:00:00Z", []);
    newCreatedOrder.FirstTimerBottom = [row(3002, "2026-11-03T00:00:00Z", "2026-10-01T00:00:00Z")];

    const samples = extractFirstTimerFrontierSamples([oldUpdatedOrder, newCreatedOrder]);
    expect(samples.map((s) => s.pr)).toEqual([3002]);
    expect(samples[0].createdMs).toBe(Date.parse("2026-10-01T00:00:00Z"));
  });

  test("extractHealthyFrontierSamples は旧条件の履歴を除外する", () => {
    const legacy = snapshot("2026-11-01T00:00:00Z", [], null);
    legacy.HealthyBottom = [row(1001, "2026-10-20T00:00:00Z", "2026-09-15T00:00:00Z")];
    const v5 = snapshot("2026-11-02T00:00:00Z", [], 5);
    v5.HealthyBottom = [row(1002, "2026-10-25T00:00:00Z", "2026-09-20T00:00:00Z")];

    const current = snapshot("2026-11-03T00:00:00Z", []);
    current.HealthyBottom = [row(1003, "2026-10-26T00:00:00Z", "2026-09-21T00:00:00Z")];

    const samples = extractHealthyFrontierSamples([v5, current, legacy]);
    expect(samples.map((s) => s.pr)).toEqual([1003]);
    expect(samples[0].createdMs).toBe(Date.parse("2026-09-21T00:00:00Z"));
  });
});

describe("Domain: calculateLifetimeForecast", () => {
  const created = Date.parse("2026-10-29T00:00:00Z");
  const now = Date.parse("2026-11-08T00:00:00Z"); // 起票から 10 日後

  test("起票日に中央値・75%点を足した予想日と、現在からの残り日数を返す", () => {
    const result = calculateLifetimeForecast(created, 44.5, 45, now);
    expect(result).toEqual({
      medianDays: 44.5,
      medianDateMs: created + 44.5 * DAY,
      medianEtaDays: 34.5,
      exceededMedian: false,
      p75DateMs: created + 45 * DAY,
      p75EtaDays: 35,
    });
  });

  test.each([
    ["中央値を超過している", 8, 9, 0, 0, true],
    ["中央値は超過・75%点は未到達", 8, 12, 0, 2, true],
  ])("%s: 残り日数は 0 に丸める", (_name, median, p75, medianEta, p75Eta, exceeded) => {
    const result = calculateLifetimeForecast(created, median, p75, now);
    expect(result?.medianEtaDays).toBe(medianEta);
    expect(result?.p75EtaDays).toBe(p75Eta);
    expect(result?.exceededMedian).toBe(exceeded);
  });

  test("75%点が無ければ中央値だけで算出し、75%点は null", () => {
    const result = calculateLifetimeForecast(created, 44.5, null, now);
    expect(result?.medianEtaDays).toBe(34.5);
    expect(result?.p75DateMs).toBeNull();
    expect(result?.p75EtaDays).toBeNull();
  });

  test.each([
    ["中央値が無い", created, null, now],
    ["中央値が未定義", created, undefined, now],
    ["起票時刻が不正", Number.NaN, 44.5, now],
    ["観測時刻が不正", created, 44.5, Number.NaN],
  ])("算出できない入力は null を返す: %s", (_name, createdMs, median, nowMs) => {
    expect(calculateLifetimeForecast(createdMs, median, 45, nowMs)).toBeNull();
  });
});

describe("Domain: extractUnreviewedFrontierSamples", () => {
  test("現行 DepthsVersion かつ UnreviewedBottom を持つスナップショットのみから CreatedAt 基準の観測列を時刻昇順で抽出し、旧バージョン（v7 以前）を混ぜない", () => {
    const legacyWithoutUnreviewed = snapshot("2026-11-01T00:00:00Z", []);
    const oldV7WithUnreviewed = snapshot("2026-11-01T02:00:00Z", [], CURRENT_DEPTHS_VERSION - 1);
    oldV7WithUnreviewed.UnreviewedBottom = [
      row(100, "2026-10-15T00:00:00Z", "2026-10-07T00:00:00Z"),
    ];

    const s2 = snapshot("2026-11-02T08:00:00Z", []);
    s2.UnreviewedBottom = [row(200, "2026-10-25T00:00:00Z", "2026-10-10T00:00:00Z")];
    const s1 = snapshot("2026-11-01T08:00:00Z", []);
    s1.UnreviewedBottom = [row(150, "2026-10-20T00:00:00Z", "2026-10-09T00:00:00Z")];

    const samples = extractUnreviewedFrontierSamples([
      legacyWithoutUnreviewed,
      oldV7WithUnreviewed,
      s2,
      s1,
    ]);
    expect(samples.map((s) => s.pr)).toEqual([150, 200]);
    expect(samples[0].createdMs).toBe(Date.parse("2026-10-09T00:00:00Z"));
    expect(samples[1].createdMs).toBe(Date.parse("2026-10-10T00:00:00Z"));
  });
});

describe("Domain: extractMainstreamFrontierSamples", () => {
  const mainstreamSnap = (
    timestamp: string,
    medianCreatedAt: string | null,
    cohortCount: number,
    depthsVersion = CURRENT_DEPTHS_VERSION,
    mode: FirstReviewFrontier["Mode"] = FIRST_REVIEW_MAINSTREAM_MODE,
  ): DepthsSnapshot => ({
    ...snapshot(timestamp, [], depthsVersion),
    UnreviewedBottom: [row(999, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z")],
    FirstReviewFrontier: {
      Mode: mode,
      WindowDays: 7,
      CohortCount: cohortCount,
      OpenCount: Math.ceil(cohortCount / 2),
      MergedCount: Math.floor(cohortCount / 2),
      MedianCreatedAt: medianCreatedAt,
      LagDays: medianCreatedAt ? 30 : null,
    },
  });

  test("DepthsVersion >= 4・Mode=cohort-median-7d・CohortCount > 0 の行だけを時刻昇順で抽出し、旧 v3 未着手底履歴を混ぜない", () => {
    const oldV3Unreviewed = snapshot("2026-11-12T00:00:00Z", [], 3);
    oldV3Unreviewed.UnreviewedBottom = [row(100, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z")];

    const emptyCohortV4 = mainstreamSnap("2026-11-13T00:00:00Z", null, 0);
    const s2 = mainstreamSnap("2026-11-15T00:00:00Z", "2026-10-12T00:00:00Z", 50);
    const s1 = mainstreamSnap("2026-11-14T00:00:00Z", "2026-10-11T00:00:00Z", 48);

    const samples = extractMainstreamFrontierSamples([oldV3Unreviewed, emptyCohortV4, s2, s1]);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.cohortCount)).toEqual([48, 50]);
    expect(samples[0].createdMs).toBe(Date.parse("2026-10-11T00:00:00Z"));
    expect(samples[1].createdMs).toBe(Date.parse("2026-10-12T00:00:00Z"));

    // 旧 v3 履歴と混在しても旧値 (09-01) は使われず、v4 主戦場ライン位置の定常換算が返ること
    const forecast = calculateFirstReviewForecast(
      samples.slice(0, 1),
      Date.parse("2026-10-20T00:00:00Z"),
    );
    expect(forecast.status).toBe("steady");
    expect(forecast.gapDays).toBe(9);
    expect(forecast.steadyEtaDays).toBe(9);
  });
});

describe("Domain: calculateFirstReviewForecast", () => {
  const mainstreamSample = (
    hoursFromT0: number,
    frontierDaysBeforeT0: number,
    cohortCount = 40,
  ): MainstreamFrontierSample => ({
    timestampMs: T0 + hoursFromT0 * HOUR,
    createdMs: T0 - frontierDaysBeforeT0 * DAY,
    cohortCount,
    openCount: Math.ceil(cohortCount / 2),
    mergedCount: Math.floor(cohortCount / 2),
    mode: FIRST_REVIEW_MAINSTREAM_MODE,
  });
  const targetCreated = T0 - 10 * DAY;

  test("観測が無い場合は no-samples を返す", () => {
    const result = calculateFirstReviewForecast([], targetCreated);
    expect(result.status).toBe("no-samples");
    expect(result.frontier).toBeNull();
    expect(result.steadyEtaDays).toBeNull();
    expect(result.steadyDateMs).toBeNull();
  });

  test("基準 PR の起票時刻が不明なら no-target と現在位置を返す", () => {
    const result = calculateFirstReviewForecast([mainstreamSample(0, 20, 42)], null);
    expect(result.status).toBe("no-target");
    expect(result.lagDays).toBe(20);
    expect(result.frontier?.cohortCount).toBe(42);
    expect(result.steadyEtaDays).toBeNull();
    expect(result.steadyDateMs).toBeNull();
  });

  test.each([
    ["観測 1 点のみ", [mainstreamSample(0, 20)], 10],
    [
      "進行速度が 0.5 日/日のように遅い場合も短期外挿せず定常 1.0 日/日換算",
      [mainstreamSample(0, 20.5), mainstreamSample(24, 20)],
      10,
    ],
    [
      "進行が停滞・後退していても割り算外挿せずスナップショット＋定常換算",
      [mainstreamSample(0, 20), mainstreamSample(24, 21)],
      11,
    ],
  ])(
    "主戦場ラインは短期速度外挿を廃止しスナップショット＋定常換算を返す: %s",
    (_name, samples, expectedGapDays) => {
      const result = calculateFirstReviewForecast(samples, targetCreated);
      expect(result.status).toBe("steady");
      expect(result.gapDays).toBe(expectedGapDays);
      expect(result.steadyEtaDays).toBe(expectedGapDays);
      expect(result.steadyDateMs).toBe(
        samples[samples.length - 1].timestampMs + expectedGapDays * DAY,
      );
    },
  );

  test("主戦場ラインが基準 PR の起票日時に到達済み（gap <= 0）なら reached（残り 0 日）を返す", () => {
    const result = calculateFirstReviewForecast(
      [mainstreamSample(0, 11), mainstreamSample(24, 9)],
      targetCreated,
    );
    expect(result.status).toBe("reached");
    expect(result.gapDays).toBe(-1);
    expect(result.steadyEtaDays).toBe(0);
    expect(result.steadyDateMs).toBe(T0 + 24 * HOUR);
  });

  test("基準 PR 自身が介入済み（レビュー/手動コメント）の場合は target-intervened を返し、アサインのみ未介入は steady のまま扱う", () => {
    const resultByComment = calculateFirstReviewForecast(
      [mainstreamSample(0, 21), mainstreamSample(24, 20)],
      targetCreated,
      {
        targetIntervention: {
          Intervened: true,
          ThirdPartyAssignees: [],
          HumanReviewCount: 0,
          ManualCommentCount: 1,
          PrimaryBadge: {
            Kind: "comment",
            Actor: "stephengillie",
            Label: "コメント済: stephengillie",
          },
        },
      },
    );
    expect(resultByComment.status).toBe("target-intervened");
    expect(resultByComment.targetIntervention?.PrimaryBadge?.Label).toBe(
      "コメント済: stephengillie",
    );
    expect(resultByComment.steadyEtaDays).toBe(0);
    expect(resultByComment.steadyDateMs).toBe(T0 + 24 * HOUR);

    const assigneeOnlyUnintervened = calculateFirstReviewForecast(
      [mainstreamSample(0, 21), mainstreamSample(24, 20)],
      targetCreated,
      {
        targetIntervention: {
          Intervened: false,
          ThirdPartyAssignees: ["stephengillie"],
          HumanReviewCount: 0,
          ManualCommentCount: 0,
        },
      },
    );
    expect(assigneeOnlyUnintervened.status).toBe("steady");
    expect(assigneeOnlyUnintervened.targetAssignees).toEqual(["stephengillie"]);
    expect(assigneeOnlyUnintervened.steadyEtaDays).toBe(10);
  });
});
