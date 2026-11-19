import { describe, expect, test } from "bun:test";
import { buildForecastBandSource, calculateForecastBand } from "../../src/domain/forecast-band";
import {
  findOutcome,
  hasForecastRecord,
  parseForecastHistory,
  scoreForecasts,
  toForecastRecord,
} from "../../src/domain/forecast-history";
import type { ForecastComparison } from "../../src/models/forecast-comparison";
import type {
  ForecastHistoryLine,
  ForecastOutcomeRecord,
  ForecastRecord,
} from "../../src/models/forecast-history";

const DAY = 24 * 60 * 60 * 1000;
const MERGED = Date.parse("2026-12-10T00:00:00Z");

const forecast = (
  timestamp: string,
  estimates: [
    key: string,
    hypothesis: ForecastRecord["Estimates"][number]["Hypothesis"],
    daysFromMerge: number,
  ][],
  targetPr = 1,
): ForecastRecord => ({
  Type: "forecast",
  Timestamp: timestamp,
  Repository: "o/r",
  TargetPr: targetPr,
  Estimates: estimates.map(([Key, Hypothesis, d]) => ({
    Key,
    Hypothesis,
    Date: new Date(MERGED + d * DAY).toISOString(),
    EtaDays: 0,
    Primary: true,
  })),
});

const outcome = (
  mergedAt = new Date(MERGED).toISOString(),
  targetPr = 1,
): ForecastOutcomeRecord => ({
  Type: "outcome",
  Timestamp: "2026-12-10T01:00:00Z",
  Repository: "o/r",
  TargetPr: targetPr,
  MergedAt: mergedAt,
});

describe("Domain: toForecastRecord", () => {
  const comparison = (estimateCounts: number[]): ForecastComparison => ({
    nowMs: 0,
    range: null,
    hypotheses: (["rank-velocity", "creation-order"] as const).map((id, i) => ({
      id,
      title: id,
      premise: "",
      progressText: "",
      progressRatio: null,
      note: null,
      estimates: Array.from({ length: estimateCounts[i] }, (_, n) => ({
        key: `${id}:${n}`,
        label: "",
        dateMs: Date.parse("2026-12-01T00:00:00Z") + n * DAY,
        etaDays: 5.5,
        primary: n === 0,
      })),
    })),
  });

  test("現行 2 仮説の予想を、ISO の日付つきで 1 件の記録にまとめる", () => {
    const record = toForecastRecord(comparison([1, 2]), {
      repository: "o/r",
      targetPr: 7,
      timestamp: "2026-11-08T00:00:00Z",
    });
    expect(record).toMatchObject({
      Type: "forecast",
      Timestamp: "2026-11-08T00:00:00Z",
      Repository: "o/r",
      TargetPr: 7,
    });
    expect(record?.Estimates).toHaveLength(3);
    expect(record?.Estimates[1]).toEqual({
      Key: "creation-order:0",
      Hypothesis: "creation-order",
      Date: "2026-12-01T00:00:00.000Z",
      EtaDays: 5.5,
      Primary: true,
    });
    // 補助の予想も、主かどうかの区別つきで残す
    expect(record?.Estimates[2].Primary).toBe(false);
  });

  test("予想日が 1 件も無い観測は記録しない", () => {
    expect(
      toForecastRecord(comparison([0, 0]), {
        repository: "o/r",
        targetPr: 7,
        timestamp: "2026-11-08T00:00:00Z",
      }),
    ).toBeNull();
  });
});

describe("Domain: parseForecastHistory", () => {
  test("BOM 付き・空行を含む JSONL を、予想と結果の両方でパースする", () => {
    const text = `﻿${JSON.stringify(forecast("2026-11-08T00:00:00Z", [["rank-velocity", "rank-velocity", 1]]))}\n\n${JSON.stringify(outcome())}\n`;
    const lines = parseForecastHistory(text);
    expect(lines.map((l) => l.Type)).toEqual(["forecast", "outcome"]);
  });

  test("空のテキストは空配列", () => {
    expect(parseForecastHistory("")).toEqual([]);
  });

  test.each([
    ["壊れた JSON", "{ broken\n", "予想履歴 1 行目のパースに失敗しました"],
    ["種別が無い", `${JSON.stringify({ TargetPr: 1 })}\n`, "予想履歴 1 行目の種別が不正です"],
    ["未知の種別", `${JSON.stringify({ Type: "other" })}\n`, "予想履歴 1 行目の種別が不正です"],
  ])("握りつぶさず行番号つきで例外にする: %s", (_name, text, message) => {
    expect(() => parseForecastHistory(text)).toThrow(message);
  });

  test("2 行目以降の不正も行番号を示す", () => {
    const text = `${JSON.stringify(outcome())}\n{ broken\n`;
    expect(() => parseForecastHistory(text)).toThrow("予想履歴 2 行目");
  });
});

describe("Domain: hasForecastRecord / findOutcome", () => {
  const history: ForecastHistoryLine[] = [
    forecast("2026-11-08T00:00:00Z", [["rank-velocity", "rank-velocity", 1]]),
    outcome(),
  ];

  test.each([
    ["同じ PR・同じ観測時刻", "o/r", 1, "2026-11-08T00:00:00Z", true],
    ["観測時刻が違う", "o/r", 1, "2026-11-08T04:00:00Z", false],
    ["PR が違う", "o/r", 2, "2026-11-08T00:00:00Z", false],
    ["リポジトリが違う", "x/y", 1, "2026-11-08T00:00:00Z", false],
  ])("予想の記録済み判定: %s", (_name, repo, pr, ts, expected) => {
    expect(hasForecastRecord(history, repo, pr, ts)).toBe(expected);
  });

  test("結果は基準 PR とリポジトリで探す", () => {
    expect(findOutcome(history, "o/r", 1)?.MergedAt).toBe(new Date(MERGED).toISOString());
    expect(findOutcome(history, "o/r", 2)).toBeUndefined();
    expect(findOutcome(history, "x/y", 1)).toBeUndefined();
  });
});

describe("Domain: scoreForecasts", () => {
  test("結果が無ければ採点しない", () => {
    expect(
      scoreForecasts([forecast("2026-11-08T00:00:00Z", [["rank-velocity", "rank-velocity", 1]])]),
    ).toEqual([]);
  });

  test("誤差は「予想日 − 実際のマージ日」で、平均・平均絶対・最後の予想の誤差を求める", () => {
    const scores = scoreForecasts([
      // 予想が 4 日遅い → +4、次は 2 日早い → -2
      forecast("2026-11-08T00:00:00Z", [["rank-velocity", "rank-velocity", 4]]),
      forecast("2026-11-20T00:00:00Z", [["rank-velocity", "rank-velocity", -2]]),
      outcome(),
    ]);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      repository: "o/r",
      targetPr: 1,
      mergedAtMs: MERGED,
      observationCount: 2,
    });
    expect(scores[0].keys).toEqual([
      {
        key: "rank-velocity",
        hypothesis: "rank-velocity",
        count: 2,
        meanErrorDays: 1,
        meanAbsErrorDays: 3,
        lastErrorDays: -2,
      },
    ]);
  });

  test("マージ後に記録された予想と、別の基準 PR の予想は採点に使わない", () => {
    const scores = scoreForecasts([
      forecast("2026-11-08T00:00:00Z", [["rank-velocity", "rank-velocity", 3]]),
      forecast("2026-12-11T00:00:00Z", [["rank-velocity", "rank-velocity", 99]]),
      forecast("2026-11-09T00:00:00Z", [["rank-velocity", "rank-velocity", 50]], 2),
      outcome(),
    ]);
    expect(scores[0].observationCount).toBe(1);
    expect(scores[0].keys[0].count).toBe(1);
    expect(scores[0].keys[0].lastErrorDays).toBe(3);
  });

  test("仮説・モデルの表示順（順位消化 → 作成順）に並べ、旧 update-order 履歴を後方互換で読み込みつつ採点対象からは除外する", () => {
    const rawJsonl = [
      forecast("2026-11-08T00:00:00Z", [
        ["creation-order:p75", "creation-order", 5],
        ["update-order:observed", "update-order", 1],
        ["creation-order:median", "creation-order", 0],
        ["rank-velocity", "rank-velocity", -1],
        ["update-order:steady", "update-order", 2],
      ]),
      forecast("2026-11-08T00:00:00Z", [["rank-velocity", "rank-velocity", 7]], 2),
      outcome(),
      outcome(new Date(MERGED + 5 * DAY).toISOString(), 2),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");

    const parsed = parseForecastHistory(rawJsonl);
    expect(parsed).toHaveLength(4);

    const scores = scoreForecasts(parsed);
    expect(scores.map((s) => s.targetPr)).toEqual([1, 2]);
    expect(scores[0].keys.map((k) => k.key)).toEqual([
      "rank-velocity",
      "creation-order:median",
      "creation-order:p75",
    ]);
    // PR 2 は 5 日後にマージ。予想はマージの 7 日後だったので誤差は +2
    expect(scores[1].keys[0].lastErrorDays).toBe(2);
  });

  test("結果の MergedAt を解釈できなければ握りつぶさず例外にする", () => {
    expect(() => scoreForecasts([outcome("not-a-date")])).toThrow("MergedAt を解釈できません");
  });

  test("処理バンド記録（Band）がある場合は JST 暦日基準で本命バンド的中率・全体包含率・中央値誤差を採点する", () => {
    // MERGED = 2026-12-10T00:00:00Z = JST 2026-12-10 09:00
    // 観測1: 本命バンド 12-06 ~ 12-10 (同日 JST 23:00 終わり)、中央値 12-08 (-2日) -> 本命的中 & 全体的中
    // 観測2: 本命バンド 12-11 ~ 12-14 (JST)、全体 12-05 ~ 12-20、中央値 12-12 (+2日) -> 本命外れ & 全体的中
    const rec1: ForecastRecord = {
      Type: "forecast",
      Timestamp: "2026-11-18T00:00:00Z",
      Repository: "o/r",
      TargetPr: 1,
      Estimates: [],
      Band: {
        FrontDate: "2026-12-02T00:00:00Z",
        MainstreamStartDate: "2026-12-06T00:00:00Z",
        // UTC 12-10T14:00Z = JST 12-10 23:00 (MERGED UTC 00:00Z = JST 09:00 と同 JST 暦日)
        // さらに UTC 12-10T00:00Z が下限の場合でも暦日同日扱いになることを検証
        MainstreamEndDate: "2026-12-10T14:00:00Z",
        MainstreamMedianDate: "2026-12-08T00:00:00Z",
        BottomDate: "2026-12-25T00:00:00Z",
        OverallStartDate: "2026-12-02T00:00:00Z",
        OverallEndDate: "2026-12-25T00:00:00Z",
      },
    };
    const rec2: ForecastRecord = {
      Type: "forecast",
      Timestamp: "2026-11-25T00:00:00Z",
      Repository: "o/r",
      TargetPr: 1,
      Estimates: [],
      Band: {
        FrontDate: "2026-12-05T00:00:00Z",
        MainstreamStartDate: "2026-12-11T00:00:00Z", // JST 12-11 09:00
        MainstreamEndDate: "2026-12-14T00:00:00Z",
        MainstreamMedianDate: "2026-12-12T00:00:00Z",
        BottomDate: "2026-12-20T00:00:00Z",
        OverallStartDate: "2026-12-05T00:00:00Z",
        OverallEndDate: "2026-12-20T00:00:00Z",
      },
    };

    const scores = scoreForecasts([rec1, rec2, outcome()]);
    expect(scores).toHaveLength(1);
    expect(scores[0].bandScore).toEqual({
      count: 2,
      mainstreamHitCount: 1,
      mainstreamHitRatePct: 50,
      lastInMainstreamBand: false,
      medianMeanErrorDays: 0,
      medianMeanAbsErrorDays: 2,
      medianLastErrorDays: 2,
      overallCount: 2,
      overallHitCount: 2,
      overallHitRatePct: 100,
    });
  });

  test("本命バンド上限と実マージが JST 同日だが時刻だけ遅い場合でも的中と判定する", () => {
    // 2026-12-10 18:00 JST (= 2026-12-10T09:00:00Z) にマージ
    const mergedLaterSameJstDay = outcome("2026-12-10T09:00:00Z");
    const rec: ForecastRecord = {
      Type: "forecast",
      Timestamp: "2026-11-18T00:00:00Z",
      Repository: "o/r",
      TargetPr: 1,
      Estimates: [],
      Band: {
        FrontDate: "2026-12-01T00:00:00Z",
        MainstreamStartDate: "2026-12-05T00:00:00Z", // JST 12-05
        MainstreamEndDate: "2026-12-10T01:00:00Z", // JST 12-10 10:00 (時刻は早いが暦日は同じ 12-10)
        MainstreamMedianDate: "2026-12-08T00:00:00Z",
        BottomDate: "2026-12-20T00:00:00Z",
      },
    };
    const scores = scoreForecasts([rec, mergedLaterSameJstDay]);
    expect(scores[0].bandScore?.mainstreamHitCount).toBe(1);
    expect(scores[0].bandScore?.lastInMainstreamBand).toBe(true);
    expect(scores[0].bandScore?.overallHitCount).toBe(1);
  });

  test("toForecastRecord は既存 Estimates が空でも Band が算出できていれば記録する", () => {
    const band = calculateForecastBand(
      buildForecastBandSource({
        progress: {
          Timestamp: "2026-11-18T20:00:00Z",
          TargetPr: 1,
          FirstTimerMedianDays: 30,
        },
        depths: {
          TargetPr: {
            Number: 1,
            Title: "t",
            Url: "u",
            CreatedAt: "2026-10-29T00:00:00Z",
            CreatedAtJst: "2026-10-29 09:00",
            UpdatedAt: "2026-11-01T00:00:00Z",
          },
        },
        history: [],
      }),
    );
    const rec = toForecastRecord(
      band.comparison,
      { repository: "o/r", targetPr: 1, timestamp: "2026-11-18T20:00:00Z" },
      band,
    );
    expect(rec).not.toBeNull();
    expect(rec?.Estimates).toEqual([]);
    expect(rec?.Band?.FrontDate).toBe("2026-11-28T00:00:00.000Z");
  });
});
