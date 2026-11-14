/**
 * 進捗メトリクス計測（progress）の統計集計およびスナップショット構築ロジック。
 * 外部 I/O を行わない純粋関数群であり、src/models の型定義および同一ドメインモジュールに依存する。
 */

import type {
  MergedCandidateSample,
  ProgressPercentileMetrics,
  ProgressRivalPr,
  ProgressSnapshot,
  ProgressStatsSummary,
} from "../models/progress";
import { buildGuidance, compareWithSamples, toSnapshotSamples } from "./benchmark";
import { formatDateTimeWithDay } from "./formatters";

export { formatDateTimeWithDay, formatDelta, formatHumanDays } from "./formatters";
export {
  BLOCKED_LABELS,
  BLOCKED_PATTERNS,
  buildHealthyQueryParts,
  INVESTIGATION_LABELS,
  isBlockedLabel,
  isEligibleLabels,
  REQUIRED_LABELS,
} from "./labels";
export { parseCsvRows, QUEUE_BASIS, serializeCsvRows, toHistoryRow } from "./progress-csv";
export { simulateReadySince } from "./timeline";

/**
 * パーセンタイル値を線形補間（R-7 / Excel PERCENTILE.INC 相当）で算出する。
 */
export function getPercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    throw new Error("集計対象がありません。");
  }
  if (percentile < 0 || percentile > 1) {
    throw new RangeError("パーセンタイルは 0 以上 1 以下の数値を指定してください。");
  }

  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;

  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
}

/**
 * 収集したマージ済みサンプル群から統計値（中央値、P75、最大値）を計算する。
 */
export function calculateProgressStats(
  samples: MergedCandidateSample[],
  skippedCount = 0,
): ProgressStatsSummary | null {
  if (samples.length === 0) {
    return null;
  }

  const totalValues = samples.map((s) => s.totalDays);
  const turnValues = samples.map((s) => s.turnDays);
  const readyValues = samples.map((s) => s.days);

  const calcMetrics = (values: number[]): ProgressPercentileMetrics => {
    return {
      median: Number(getPercentile(values, 0.5).toFixed(2)),
      p75: Number(getPercentile(values, 0.75).toFixed(2)),
      max: Number(Math.max(...values).toFixed(2)),
    };
  };

  return {
    sampleCount: samples.length,
    skippedCount,
    total: calcMetrics(totalValues),
    turn: calcMetrics(turnValues),
    ready: calcMetrics(readyValues),
  };
}

export interface CreateProgressSnapshotParams {
  now: Date;
  repository: string;
  targetPr: number;
  prTitle: string;
  prUrl: string;
  prState: string;
  frontNumber: number;
  frontCreatedAt: string;
  activeAhead: number;
  totalAhead: number;
  behind: number;
  totalLifetimeDays: number;
  turnLatencyDays: number;
  waitDays: number;
  commitCount: number;
  stats: ProgressStatsSummary | null;
  lookbackDays: number;
  /** 条件不成立などで比較から除いた候補数（サンプルが 0 件でも記録する） */
  skippedCount: number;
  rivals: ProgressRivalPr[];
  /** 統計に採用したサンプル（stats が null のときは空） */
  samples: MergedCandidateSample[];
  targetCreatedAt: Date;
  /** 基準 PR の条件成立日時（ReadyAt） */
  targetReadyAt: Date;
  /** 初回提出者コホートの統計サマリ（任意） */
  firstTimerStats?: ProgressStatsSummary | null;
  /** 初回提出者コホートの採用サンプル件数（任意） */
  firstTimerSampleCount?: number;
  /** 初回提出者コホートの集計窓（日。任意） */
  firstTimerLookbackDays?: number;
}

/**
 * スナップショット JSON オブジェクトを構築する。
 */
export function createProgressSnapshot(params: CreateProgressSnapshotParams): ProgressSnapshot {
  const { stats, samples, targetPr, lookbackDays, firstTimerStats } = params;

  return {
    Timestamp: params.now.toISOString(),
    TimestampJst: formatDateTimeWithDay(params.now),
    Repository: params.repository,
    TargetPr: targetPr,
    PrTitle: params.prTitle,
    PrUrl: params.prUrl,
    PrState: params.prState,
    FrontNumber: params.frontNumber,
    FrontCreatedAt: params.frontCreatedAt,
    ActiveAhead: params.activeAhead,
    TotalAhead: params.totalAhead,
    Behind: params.behind,
    TotalLifetimeDays: Number(params.totalLifetimeDays.toFixed(2)),
    TurnLatencyDays: Number(params.turnLatencyDays.toFixed(2)),
    WaitDays: Number(params.waitDays.toFixed(2)),
    CommitCount: params.commitCount,
    TotalMedianDays: stats ? stats.total.median : null,
    TotalP75Days: stats ? stats.total.p75 : null,
    TurnMedianDays: stats ? stats.turn.median : null,
    TurnP75Days: stats ? stats.turn.p75 : null,
    ReadyMedianDays: stats ? stats.ready.median : null,
    ReadyP75Days: stats ? stats.ready.p75 : null,
    TotalMaxDays: stats ? stats.total.max : null,
    TurnMaxDays: stats ? stats.turn.max : null,
    ReadyMaxDays: stats ? stats.ready.max : null,
    LookbackDays: lookbackDays,
    FirstTimerLookbackDays: params.firstTimerLookbackDays ?? lookbackDays,
    SampleCount: stats ? stats.sampleCount : 0,
    SkippedCount: params.skippedCount,
    Rivals: params.rivals.map((r) => ({
      Number: r.number,
      Title: r.title,
      Url: r.url,
      CreatedAt: r.createdAt,
      UpdatedAt: r.updatedAt,
    })),
    Samples: stats ? toSnapshotSamples(samples, targetPr) : [],
    Comparison: stats
      ? compareWithSamples(samples, {
          number: targetPr,
          createdAt: params.targetCreatedAt,
          readyAt: params.targetReadyAt,
        })
      : null,
    Guidance: stats
      ? buildGuidance(stats, samples, {
          totalDays: params.totalLifetimeDays,
          turnDays: params.turnLatencyDays,
          readyDays: params.waitDays,
        })
      : null,
    FirstTimerMedianDays: firstTimerStats ? firstTimerStats.total.median : null,
    FirstTimerP75Days: firstTimerStats ? firstTimerStats.total.p75 : null,
    FirstTimerTurnMedianDays: firstTimerStats ? firstTimerStats.turn.median : null,
    FirstTimerTurnP75Days: firstTimerStats ? firstTimerStats.turn.p75 : null,
    FirstTimerSampleCount:
      params.firstTimerSampleCount ?? (firstTimerStats ? firstTimerStats.sampleCount : 0),
  };
}
