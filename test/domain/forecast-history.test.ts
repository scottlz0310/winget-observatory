import { describe, expect, test } from "bun:test";
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
    hypotheses: (["rank-velocity", "update-order", "creation-order"] as const).map((id, i) => ({
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

  test("すべての仮説・モデルの予想を、ISO の日付つきで 1 件の記録にまとめる", () => {
    const record = toForecastRecord(comparison([1, 2, 1]), {
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
    expect(record?.Estimates).toHaveLength(4);
    expect(record?.Estimates[1]).toEqual({
      Key: "update-order:0",
      Hypothesis: "update-order",
      Date: "2026-12-01T00:00:00.000Z",
      EtaDays: 5.5,
      Primary: true,
    });
    // 補助の予想も、主かどうかの区別つきで残す
    expect(record?.Estimates[2].Primary).toBe(false);
  });

  test("予想日が 1 件も無い観測は記録しない", () => {
    expect(
      toForecastRecord(comparison([0, 0, 0]), {
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

  test("仮説・モデルの表示順（順位消化 → 更新順 → 作成順）に並べ、基準 PR ごとに採点する", () => {
    const scores = scoreForecasts([
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
    ]);
    expect(scores.map((s) => s.targetPr)).toEqual([1, 2]);
    expect(scores[0].keys.map((k) => k.key)).toEqual([
      "rank-velocity",
      "update-order:steady",
      "update-order:observed",
      "creation-order:median",
      "creation-order:p75",
    ]);
    // PR 2 は 5 日後にマージ。予想はマージの 7 日後だったので誤差は +2
    expect(scores[1].keys[0].lastErrorDays).toBe(2);
  });

  test("結果の MergedAt を解釈できなければ握りつぶさず例外にする", () => {
    expect(() => scoreForecasts([outcome("not-a-date")])).toThrow("MergedAt を解釈できません");
  });
});
