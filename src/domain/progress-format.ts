/**
 * 進捗計測 CLI のコンソール表示およびログ整形の純粋ドメイン関数群。
 * 副作用を持たず、渡されたフォーマッタ・ロガー関数を介して文字列を出力する。
 */

import type { ProgressRivalPr, ProgressSnapshot, ReferenceGuidance } from "../models/progress";
import { describeGuidance, describeOvertake } from "./benchmark";
import { formatDateTimeWithDay, formatHumanDays } from "./formatters";

export interface BenchmarkLogOptions {
  lookbackDays: number;
  firstTimerLookbackDays?: number;
  targetPr: number;
}

export interface CurrentDaysMetrics {
  totalLifetimeDays: number;
  turnLatencyDays: number;
  waitDays: number;
}

/** 前回の消化前線番号との差分テキストを生成する */
export function formatFrontDeltaText(
  currentFrontNumber: number,
  prevFrontNumber: number | undefined,
): string {
  if (prevFrontNumber === undefined) return "";
  const diff = currentFrontNumber - prevFrontNumber;
  if (diff > 0) {
    return ` [前回 #${prevFrontNumber} から +${diff} 件前進]`;
  }
  if (diff === 0) {
    return " [前回から変動なし]";
  }
  return ` [前回 #${prevFrontNumber}]`;
}

/** 直前のライバル PR 一覧を出力する */
export function logRivals(rivals: ProgressRivalPr[], log: (msg: string) => void): void {
  if (rivals.length === 0) return;
  log("");
  log(`直前のライバルPR（あなたの直前に並んでいるPR TOP ${rivals.length}）:`);
  for (const r of rivals) {
    log(
      `  #${r.number}  起票: ${formatDateTimeWithDay(r.createdAt)} / 更新: ${formatDateTimeWithDay(r.updatedAt)}  ${r.title}`,
    );
  }
}

/** 過去のマージ実績との比較（統計・位置づけ・追い越し・サンプル一覧）を出力する */
export function logBenchmark(
  snapshot: ProgressSnapshot,
  options: BenchmarkLogOptions,
  current: CurrentDaysMetrics,
  log: (msg: string) => void,
): void {
  log("----------------------------------------");
  log(`比較対象         : 過去 ${options.lookbackDays} 日間のマージ済みPR`);
  log(`採用サンプル     : ${snapshot.SampleCount} 件`);
  log(`条件不成立で除外 : ${snapshot.SkippedCount} 件`);

  const { Guidance: guidance, Comparison: comparison } = snapshot;
  if (snapshot.SampleCount === 0 || !guidance || !comparison) {
    log("比較可能なサンプルがありませんでした。");
    return;
  }

  const block = (
    title: string,
    median: number | null,
    p75: number | null,
    max: number | null,
    currentDays: number,
    note = "",
  ): void => {
    log(title);
    log(
      `   中央値: ${formatHumanDays(median ?? 0)} | 75%点: ${formatHumanDays(p75 ?? 0)} | 最大: ${formatHumanDays(max ?? 0)}`,
    );
    log(`   あなたの待機 : ${formatHumanDays(currentDays)}${note}`);
  };

  log("");
  log("【過去実績との統計比較】");
  block(
    "1. 通算日数 (Total Lifetime: 作成→マージ)",
    snapshot.TotalMedianDays,
    snapshot.TotalP75Days,
    snapshot.TotalMaxDays,
    current.totalLifetimeDays,
  );
  if (snapshot.FirstTimerMedianDays !== null && snapshot.FirstTimerMedianDays !== undefined) {
    const ftDays = snapshot.FirstTimerLookbackDays ?? options.firstTimerLookbackDays;
    log(
      `   [初回提出者コホート実績 (過去 ${ftDays} 日間・単発・累計マージ1件: ${snapshot.FirstTimerSampleCount}件)]`,
    );
    log(
      `     通算所要日数   : 中央値: ${formatHumanDays(snapshot.FirstTimerMedianDays)} | 75%点: ${formatHumanDays(snapshot.FirstTimerP75Days ?? snapshot.FirstTimerMedianDays)}`,
    );
    if (
      snapshot.FirstTimerTurnMedianDays !== null &&
      snapshot.FirstTimerTurnMedianDays !== undefined
    ) {
      log(
        `     最終コミット後 : 中央値: ${formatHumanDays(snapshot.FirstTimerTurnMedianDays)} | 75%点: ${formatHumanDays(snapshot.FirstTimerTurnP75Days ?? snapshot.FirstTimerTurnMedianDays)}`,
      );
    }
  }
  log("");
  block(
    "2. レビュー待ち (Turn Latency: 最新コミット→マージ)",
    snapshot.TurnMedianDays,
    snapshot.TurnP75Days,
    snapshot.TurnMaxDays,
    current.turnLatencyDays,
    snapshot.CommitCount <= 1 ? " [初手から手直しなし]" : "",
  );
  log("");
  block(
    "3. （参考）条件成立後 (ReadyAt→マージ)",
    snapshot.ReadyMedianDays,
    snapshot.ReadyP75Days,
    snapshot.ReadyMaxDays,
    current.waitDays,
  );

  if (snapshot.SampleCount < 10) {
    log("※ サンプルが少ないため、数値は変動しやすくなっています。");
  }

  log("----------------------------------------");
  log("参考目安:");
  const guide = (label: string, g: ReferenceGuidance): void =>
    log(
      `  [${label}] ${describeGuidance(g, formatHumanDays)} （サンプルの ${g.ShorterSharePct}% はこれより短い期間でマージ済み）`,
    );
  guide("レビュー待ち", guidance.Turn);
  guide("通算日数    ", guidance.Total);
  guide("条件成立後  ", guidance.Ready);

  log("");
  log("【条件成立日時の比較（ReadyAt）】");
  log(`  採用サンプル内で、自分より後に条件が整いマージ済み : ${comparison.LaterReady} 件`);
  log("");
  log("【作成日・PR番号の比較（CreatedAt / PR番号）】");
  log(`  自分より後に作成されマージ済み   : ${comparison.LaterCreated} 件`);
  if (
    comparison.FirstTimerLaterCreated !== undefined &&
    comparison.RepeatOrExpressLaterCreated !== undefined
  ) {
    log(`    うち初回提出者による追い越し   : ${comparison.FirstTimerLaterCreated} 件`);
    log(`    うち常連・特急レーンによる追い越し: ${comparison.RepeatOrExpressLaterCreated} 件`);
    if (comparison.UnknownLaterCreated !== undefined && comparison.UnknownLaterCreated > 0) {
      log(`    うち未判定による追い越し       : ${comparison.UnknownLaterCreated} 件`);
    }
  }
  log(`  自分より前に作成されマージ済み   : ${comparison.EarlierCreated} 件`);
  log(`  自分より新しいPR番号 (>${options.targetPr}) : ${comparison.NewerNumber} 件`);
  log(`  自分より古いPR番号   (<${options.targetPr}) : ${comparison.OlderNumber} 件`);
  log(`  ※ ${describeOvertake(comparison)}`);

  log("");
  log("参考サンプル（マージ日時順）:");
  for (const s of snapshot.Samples) {
    const relation = s.Relation === "older" ? "古い  " : "新しい";
    const cohort = s.IsFirstTimer === true ? "初回" : s.IsFirstTimer === false ? "常連" : "    ";
    log(
      `  #${s.Number} ${relation} [${cohort}] ${s.CommitCount}コミット  レビュー待ち ${s.TurnDays.toFixed(1)}日 / 通算 ${s.TotalDays.toFixed(1)}日 / 成立後 ${s.ReadyDays.toFixed(1)}日  最新コミット ${formatDateTimeWithDay(s.LatestCommittedDate)}  マージ ${formatDateTimeWithDay(s.MergedAt)}`,
    );
  }
  log("※ 待機はラベルとDraftの履歴に基づきます。レビュー本文・チェック履歴は解析しません。");
  log("※ 候補検索は現在の必須ラベルを使うため、マージ後にそれらが外れたPRは含まれません。");
  log("※ 日数差は実績との比較であり、残り待ち時間の予測ではありません。");
}

/**
 * 基準 PR が観測対象外で記録をスキップしたことを、Actions 上で見落とさないよう warning として出力する。
 */
export function reportSkippedObservation(
  snapshot: ProgressSnapshot | null,
  env: Record<string, string | undefined>,
  log: (msg: string) => void = console.log,
): void {
  if (snapshot === null && env.GITHUB_ACTIONS) {
    log(
      "::warning::基準 PR が観測対象外（クローズ済み・Draft・比較条件未達）のため、今回は履歴とスナップショットを記録していません",
    );
  }
}
