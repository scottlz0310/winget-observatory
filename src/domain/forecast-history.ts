/**
 * 予想日の履歴の組み立て・パース・採点を行う純粋関数群。
 * 外部 I/O を行わず、src/models の型定義と同一ドメイン内のモジュールだけに依存する。
 */

import type { ForecastComparison } from "../models/forecast-comparison";
import type {
  ForecastHistoryLine,
  ForecastKeyScore,
  ForecastOutcomeRecord,
  ForecastRecord,
  ForecastScore,
} from "../models/forecast-history";
import { DAY_MS, round1 } from "./formatters";

/** 仮説・モデルの表示順（採点表の並び） */
const KEY_ORDER = [
  "rank-velocity",
  "update-order:steady",
  "update-order:observed",
  "creation-order:median",
  "creation-order:p75",
];

/**
 * 比較結果を、履歴に追記する 1 件の記録にする。
 * 予想日が 1 件も無い観測は記録する意味が無いため null を返す。
 */
export function toForecastRecord(
  comparison: ForecastComparison,
  meta: { repository: string; targetPr: number; timestamp: string },
): ForecastRecord | null {
  const estimates = comparison.hypotheses.flatMap((h) =>
    h.estimates.map((e) => ({
      Key: e.key,
      Hypothesis: h.id,
      Date: new Date(e.dateMs).toISOString(),
      EtaDays: e.etaDays,
      Primary: e.primary,
    })),
  );
  if (estimates.length === 0) return null;
  return {
    Type: "forecast",
    Timestamp: meta.timestamp,
    Repository: meta.repository,
    TargetPr: meta.targetPr,
    Estimates: estimates,
  };
}

/**
 * forecast-history.jsonl（1 行 1 JSON、先頭に BOM があり得る）をパースする。
 * 壊れた行や不明な種別は握りつぶさず、行番号付きで例外にする。
 */
export function parseForecastHistory(text: string): ForecastHistoryLine[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const result: ForecastHistoryLine[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`予想履歴 ${index + 1} 行目のパースに失敗しました: ${msg}`, { cause: err });
    }
    const type = (parsed as { Type?: unknown } | null)?.Type;
    if (type !== "forecast" && type !== "outcome") {
      throw new Error(`予想履歴 ${index + 1} 行目の種別が不正です: ${String(type)}`);
    }
    result.push(parsed as ForecastHistoryLine);
  }
  return result;
}

/** 同じ基準 PR の同じ観測時刻の予想が、すでに記録されているか */
export function hasForecastRecord(
  history: ForecastHistoryLine[],
  repository: string,
  targetPr: number,
  timestamp: string,
): boolean {
  return history.some(
    (line) =>
      line.Type === "forecast" &&
      line.Repository === repository &&
      line.TargetPr === targetPr &&
      line.Timestamp === timestamp,
  );
}

/** 基準 PR のマージ結果が、すでに記録されているか */
export function findOutcome(
  history: ForecastHistoryLine[],
  repository: string,
  targetPr: number,
): ForecastOutcomeRecord | undefined {
  return history.find(
    (line): line is ForecastOutcomeRecord =>
      line.Type === "outcome" && line.Repository === repository && line.TargetPr === targetPr,
  );
}

/**
 * マージ結果が記録された基準 PR ごとに、各仮説・モデルの予想の当たり具合を採点する。
 * 誤差は「予想日 − 実際のマージ日」（日）。マージ後に記録された予想は採点しない。
 */
export function scoreForecasts(history: ForecastHistoryLine[]): ForecastScore[] {
  const outcomes = history.filter((l): l is ForecastOutcomeRecord => l.Type === "outcome");
  const scores: ForecastScore[] = [];

  for (const outcome of outcomes) {
    const mergedAtMs = Date.parse(outcome.MergedAt);
    if (!Number.isFinite(mergedAtMs)) {
      throw new Error(
        `予想履歴の結果が不正です (#${outcome.TargetPr}): MergedAt を解釈できません: ${outcome.MergedAt}`,
      );
    }
    const forecasts = history
      .filter(
        (l): l is ForecastRecord =>
          l.Type === "forecast" &&
          l.Repository === outcome.Repository &&
          l.TargetPr === outcome.TargetPr &&
          Date.parse(l.Timestamp) <= mergedAtMs,
      )
      .sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp));

    const byKey = new Map<
      string,
      { hypothesis: ForecastKeyScore["hypothesis"]; errors: number[] }
    >();
    for (const forecast of forecasts) {
      for (const e of forecast.Estimates) {
        const entry = byKey.get(e.Key) ?? { hypothesis: e.Hypothesis, errors: [] };
        entry.errors.push((Date.parse(e.Date) - mergedAtMs) / DAY_MS);
        byKey.set(e.Key, entry);
      }
    }

    const keys: ForecastKeyScore[] = [...byKey.entries()]
      .map(([key, { hypothesis, errors }]) => ({
        key,
        hypothesis,
        count: errors.length,
        meanErrorDays: round1(errors.reduce((sum, v) => sum + v, 0) / errors.length),
        meanAbsErrorDays: round1(errors.reduce((sum, v) => sum + Math.abs(v), 0) / errors.length),
        lastErrorDays: round1(errors[errors.length - 1]),
      }))
      .sort((a, b) => orderOf(a.key) - orderOf(b.key));

    scores.push({
      repository: outcome.Repository,
      targetPr: outcome.TargetPr,
      mergedAtMs,
      observationCount: forecasts.length,
      keys,
    });
  }

  return scores;
}

function orderOf(key: string): number {
  const index = KEY_ORDER.indexOf(key);
  return index === -1 ? KEY_ORDER.length : index;
}
