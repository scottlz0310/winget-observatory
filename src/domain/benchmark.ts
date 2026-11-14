/**
 * 基準 PR を、過去にマージされた PR（比較サンプル）と見比べるための純粋関数群。
 * 外部 I/O を行わず、src/models の型定義のみに依存する。
 */

import type {
  GuidanceLevel,
  MergedCandidateSample,
  OvertakeVerdict,
  ProgressGuidance,
  ProgressSnapshotSample,
  ProgressStatsSummary,
  ReferenceGuidance,
  SampleComparison,
} from "../models/progress";
import { round2 } from "./formatters";

/** スナップショットに載せるサンプル一覧の最大件数（表示用。統計・比較は全件で計算する） */
export const SNAPSHOT_SAMPLE_LIMIT = 30;

/**
 * 採用サンプルを、スナップショットに保存する形へ変換する（基準 PR との作成順の関係を付与）。
 * キャッシュにより採用件数が数百件になるため、一覧にはマージが新しい順に limit 件だけ載せる。
 */
export function toSnapshotSamples(
  samples: MergedCandidateSample[],
  targetPr: number,
  limit: number = SNAPSHOT_SAMPLE_LIMIT,
): ProgressSnapshotSample[] {
  const newestFirst = [...samples].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  return newestFirst.slice(0, limit).map((s) => ({
    Number: s.number,
    Title: s.title,
    Relation: s.number < targetPr ? "older" : "newer",
    CommitCount: s.commitCount,
    CreatedAt: s.createdAt,
    LatestCommittedDate: s.latestCommittedDate,
    ReadyAt: s.readyAt,
    MergedAt: s.mergedAt,
    TotalDays: s.totalDays,
    TurnDays: s.turnDays,
    ReadyDays: s.days,
    ...(s.author !== undefined ? { Author: s.author } : {}),
    ...(s.isFirstTimer !== undefined ? { IsFirstTimer: s.isFirstTimer } : {}),
  }));
}

/**
 * 採用サンプル内で、基準 PR より後に作成・成立してマージ済みの件数を数える（追い越しの判定）。
 * サンプルは「直近にマージされた PR」なので、全期間の件数ではない。
 */
export function compareWithSamples(
  samples: MergedCandidateSample[],
  target: { number: number; createdAt: Date; readyAt: Date },
): SampleComparison {
  const createdMs = target.createdAt.getTime();
  const readyMs = target.readyAt.getTime();

  const laterReady = samples.filter((s) => Date.parse(s.readyAt) > readyMs).length;
  const laterCreatedSamples = samples.filter((s) => Date.parse(s.createdAt) > createdMs);
  const laterCreated = laterCreatedSamples.length;
  const firstTimerLaterCreated = laterCreatedSamples.filter((s) => s.isFirstTimer === true).length;
  const repeatOrExpressLaterCreated = laterCreatedSamples.filter(
    (s) => s.isFirstTimer === false,
  ).length;
  const unknownLaterCreated = laterCreatedSamples.filter(
    (s) => s.isFirstTimer === undefined,
  ).length;
  const newerNumber = samples.filter((s) => s.number > target.number).length;
  const olderNumber = samples.filter((s) => s.number < target.number).length;

  let verdict: OvertakeVerdict = "overtaken";
  if (laterCreated === 0 && newerNumber === 0) {
    verdict = "all-older";
  } else if (laterCreated <= 2) {
    verdict = "mostly-older";
  }

  return {
    LaterReady: laterReady,
    LaterCreated: laterCreated,
    EarlierCreated: samples.length - laterCreated,
    NewerNumber: newerNumber,
    OlderNumber: olderNumber,
    Verdict: verdict,
    FirstTimerLaterCreated: firstTimerLaterCreated,
    RepeatOrExpressLaterCreated: repeatOrExpressLaterCreated,
    UnknownLaterCreated: unknownLaterCreated,
  };
}

/**
 * 基準 PR の現在の待機日数を、サンプルの中央値・75%点・分布と見比べる。
 * 残り日数は「このまま待てば中央値（75%点）に届くまで」の目安であり、マージ時期の予測ではない。
 */
export function buildReferenceGuidance(
  currentDays: number,
  metrics: { median: number; p75: number },
  sampleValues: number[],
): ReferenceGuidance {
  let level: GuidanceLevel = "over-p75";
  if (currentDays < metrics.median) {
    level = "within-median";
  } else if (currentDays < metrics.p75) {
    level = "within-p75";
  }

  const shorter = sampleValues.filter((v) => v < currentDays).length;

  return {
    Level: level,
    ToMedianDays: currentDays < metrics.median ? round2(metrics.median - currentDays) : null,
    ToP75Days: currentDays < metrics.p75 ? round2(metrics.p75 - currentDays) : null,
    ShorterSharePct:
      sampleValues.length === 0 ? 0 : Math.round((shorter / sampleValues.length) * 100),
  };
}

/** 通算・レビュー待ち・条件成立後の 3 指標について、基準 PR の位置づけを求める */
export function buildGuidance(
  stats: ProgressStatsSummary,
  samples: MergedCandidateSample[],
  current: { totalDays: number; turnDays: number; readyDays: number },
): ProgressGuidance {
  return {
    Total: buildReferenceGuidance(
      current.totalDays,
      stats.total,
      samples.map((s) => s.totalDays),
    ),
    Turn: buildReferenceGuidance(
      current.turnDays,
      stats.turn,
      samples.map((s) => s.turnDays),
    ),
    Ready: buildReferenceGuidance(
      current.readyDays,
      stats.ready,
      samples.map((s) => s.days),
    ),
  };
}

/**
 * 位置づけの説明文。日数の表記は呼び出し側の整形関数に任せる（表示先で書式が異なるため）。
 */
export function describeGuidance(
  guidance: ReferenceGuidance,
  formatDays: (days: number) => string,
): string {
  switch (guidance.Level) {
    case "within-median":
      return `中央値以内です（中央値まであと約 ${formatDays(guidance.ToMedianDays ?? 0)}）。`;
    case "within-p75":
      return `中央値を超えています（75%点まであと約 ${formatDays(guidance.ToP75Days ?? 0)}）。`;
    case "over-p75":
      return "75%点を超えており、長めの滞留となっています。";
  }
}

/** 追い越し判定の説明文 */
export function describeOvertake(comparison: SampleComparison): string {
  switch (comparison.Verdict) {
    case "all-older":
      return "マージされたPRはすべて自分より前に作成された（古いPR番号の）ものです。古いPRのバックログを順次消化している状況で、追い越されてはいません。";
    case "mostly-older":
      return "マージされたPRのほぼ全てが自分より前に作成されたものです。大きく追い越されているわけではありません。";
    case "overtaken": {
      const ftCount = comparison.FirstTimerLaterCreated ?? 0;
      const repeatCount = comparison.RepeatOrExpressLaterCreated ?? 0;
      const unknownCount = comparison.UnknownLaterCreated ?? 0;
      if (ftCount === 0 && unknownCount === 0) {
        return `自分より後に作成されたPRが ${comparison.LaterCreated} 件マージ済みです（すべて常連・特急レーンによるもので、初回提出者による追い越しはありません）。`;
      }
      if (ftCount === 0 && unknownCount > 0) {
        return `自分より後に作成されたPRが ${comparison.LaterCreated} 件マージ済みです（うち常連・特急レーン ${repeatCount} 件、未判定 ${unknownCount} 件。確定した初回提出者による追い越しはありません）。`;
      }
      const parts: string[] = [];
      if (ftCount > 0) parts.push(`初回提出者 ${ftCount} 件`);
      if (repeatCount > 0) parts.push(`常連・特急レーン ${repeatCount} 件`);
      if (unknownCount > 0) parts.push(`未判定 ${unknownCount} 件`);
      return `自分より後に作成されたPRが ${comparison.LaterCreated} 件マージ済みです（うち${parts.join("、")}）。`;
    }
  }
}
