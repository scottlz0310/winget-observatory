/**
 * 待ち行列からの離脱の内訳を求める純粋関数。外部 I/O を行わず、src/models の型定義だけに依存する。
 */

import type { HistoryRecord } from "../models/dashboard";
import type { ExitBreakdownResult, ExitCounts } from "../models/exit-breakdown";

const HOUR_MS = 60 * 60 * 1000;

/** 内訳を出すために必要な、観測の最小間隔（これ未満は件数が少なく、1 日あたりの換算が不安定） */
export const MIN_EXIT_WINDOW_HOURS = 6;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** 検索クエリ用の条件（基準 PR の起票以降の離脱を数える） */
export function buildExitCountQueries(
  repository: string,
  targetCreatedIso: string,
  requiredLabels: readonly string[],
): { merged: string; closed: string } {
  const labels = requiredLabels.map((l) => `label:"${l}"`);
  const common = [`repo:${repository}`, "is:pr", `created:<${targetCreatedIso}`, ...labels];
  return {
    merged: [...common, "is:merged", `merged:>=${targetCreatedIso}`].join(" "),
    closed: [...common, "is:closed", "is:unmerged", `closed:>=${targetCreatedIso}`].join(" "),
  };
}

/**
 * 実質待ち（更新順の順位）の減少を、マージ・クローズ・その他に分解する。
 *
 * 比較する 2 回の観測は、最新の観測と、その targetHours 時間以上前の観測のうち最も新しいもの
 * （無ければ最古のもの）。どちらも内訳の記録（マージ・クローズの累積件数）がある観測に限る。
 *
 * - merged / closed: 累積件数の差（起票が基準 PR より前で、必須ラベルが付いた PR）
 * - healthChange: 累積待ち（作成順）の減少 − merged − closed（推定。阻害ラベルの付与など）
 * - reshuffle: 実質待ち（更新順）の減少 − 累積待ち（作成順）の減少（推定。更新による順位の入れ替わり）
 */
export function calculateExitBreakdown(
  records: HistoryRecord[],
  targetHours = 24,
): ExitBreakdownResult {
  const withCounts = records.filter(
    (r) => Number.isFinite(r.timestampMs) && r.mergedOlder != null && r.closedOlder != null,
  );
  if (withCounts.length < 2) return { available: false, reason: "no-records" };

  const latest = withCounts[withCounts.length - 1];
  let base = withCounts[0];
  for (let i = withCounts.length - 2; i >= 0; i--) {
    base = withCounts[i];
    if (latest.timestampMs - base.timestampMs >= targetHours * HOUR_MS) break;
  }

  const hours = (latest.timestampMs - base.timestampMs) / HOUR_MS;
  if (hours < MIN_EXIT_WINDOW_HOURS) return { available: false, reason: "short-window" };

  const merged = (latest.mergedOlder as number) - (base.mergedOlder as number);
  const closed = (latest.closedOlder as number) - (base.closedOlder as number);
  if (merged < 0 || closed < 0) return { available: false, reason: "inconsistent" };

  const rank = base.activeAhead - latest.activeAhead;
  const created = base.totalAhead - latest.totalAhead;
  const counts: ExitCounts = {
    rank,
    created,
    merged,
    closed,
    healthChange: created - merged - closed,
    reshuffle: rank - created,
  };
  const perDay = Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [key, round1((value / hours) * 24)]),
  ) as unknown as ExitCounts;

  return {
    available: true,
    hours: round1(hours),
    baseMs: base.timestampMs,
    latestMs: latest.timestampMs,
    counts,
    perDay,
    mergeShare: rank > 0 ? merged / rank : null,
  };
}
