/**
 * 進捗メトリクス計測（progress）に関するデータモデル・型定義。
 * 外部依存を持たない純粋な TypeScript 型定義のみを提供する。
 */

export interface ProgressCommitSummary {
  oid?: string;
  messageHeadline?: string;
  committedDate: string;
}

export interface ProgressPrDetail {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  labels: string[];
  commits: ProgressCommitSummary[];
}

export interface ProgressTimelineEvent {
  event: string;
  created_at: string;
  label?: {
    name: string;
  };
}

export interface ProgressRivalPr {
  number: number;
  title: string;
  createdAt: string;
  url: string;
}

export interface ProgressQueueInfo {
  /** 前線: 条件を満たす未マージ PR のうち最も古いもの */
  front: { number: number; createdAt: string };
  /**
   * 実質待ち: 更新順で自 PR より前に並ぶ健康な PR の数。
   * 指摘なく健康になり順番を待つだけの PR の待ち順位で、更新があった PR は順位が後ろへ動く。
   */
  activeAheadCount: number;
  /** 作成順で自 PR より前の健康な PR の総数 */
  aheadCount: number;
  totalCount: number;
  behindCount: number;
  rivals: ProgressRivalPr[];
}

export interface MergedCandidateSample {
  number: number;
  title: string;
  createdAt: string;
  latestCommittedDate: string;
  commitCount: number;
  readyAt: string;
  mergedAt: string;
  totalDays: number;
  turnDays: number;
  days: number;
}

export interface ProgressPercentileMetrics {
  median: number;
  p75: number;
  max: number;
}

export interface ProgressStatsSummary {
  sampleCount: number;
  skippedCount: number;
  total: ProgressPercentileMetrics;
  turn: ProgressPercentileMetrics;
  ready: ProgressPercentileMetrics;
}

export interface ProgressHistoryRow {
  Timestamp: string;
  TargetPr: number | string;
  FrontNumber: number | string;
  FrontCreatedAt: string;
  ActiveAhead: number | string;
  TotalAhead: number | string;
  /** ActiveAhead の算出基準。"updated"（更新順）。旧スキーマの行では空文字 */
  QueueBasis: string;
  Behind: number | string;
  TotalLifetimeDays: number | string;
  TurnLatencyDays: number | string;
  WaitDays: number | string;
  CommitCount: number | string;
}

export interface ProgressSnapshot {
  Timestamp: string;
  TimestampJst: string;
  Repository: string;
  TargetPr: number;
  PrTitle: string;
  PrUrl: string;
  PrState: string;
  FrontNumber: number;
  FrontCreatedAt: string;
  ActiveAhead: number;
  TotalAhead: number;
  Behind: number;
  TotalLifetimeDays: number;
  TurnLatencyDays: number;
  WaitDays: number;
  CommitCount: number;
  TotalMedianDays: number | null;
  TotalP75Days: number | null;
  TurnMedianDays: number | null;
  TurnP75Days: number | null;
  ReadyMedianDays: number | null;
  ReadyP75Days: number | null;
}
