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
  author?: string;
  authorAssociation?: string;
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
  /** 更新が止まっているほど順番待ちに徹している PR と読める */
  updatedAt: string;
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
  author?: string;
  isFirstTimer?: boolean;
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
  /**
   * 基準 PR の起票以降にマージされた、起票が基準 PR より前の PR（必須ラベル付き）の累積件数。
   * 待ち行列からの離脱の内訳に使う。旧スキーマの行では空文字（省略可）
   */
  MergedOlder?: number | string;
  /** 同じ条件で、未マージのままクローズされた PR の累積件数。旧スキーマの行では空文字（省略可） */
  ClosedOlder?: number | string;
}

/** 基準 PR との作成順の関係（番号は作成順に単調増加する） */
export type SampleRelation = "older" | "newer";

/** スナップショットに保存するマージ済み比較サンプル 1 件 */
export interface ProgressSnapshotSample {
  Number: number;
  Title: string;
  Relation: SampleRelation;
  CommitCount: number;
  CreatedAt: string;
  LatestCommittedDate: string;
  ReadyAt: string;
  MergedAt: string;
  TotalDays: number;
  TurnDays: number;
  ReadyDays: number;
  Author?: string;
  IsFirstTimer?: boolean;
}

/** スナップショットに保存する直前ライバル PR 1 件 */
export interface ProgressSnapshotRival {
  Number: number;
  Title: string;
  Url: string;
  CreatedAt: string;
  UpdatedAt: string;
}

/**
 * 追い越しの判定。
 * - all-older: マージ済みサンプルがすべて基準 PR より前に作成された（バックログの順次消化）
 * - mostly-older: 基準 PR より後に作成されたマージ済みサンプルが 2 件以下
 * - overtaken: それ以外（後から作成された PR が複数マージ済み）
 */
export type OvertakeVerdict = "all-older" | "mostly-older" | "overtaken";

/** 採用サンプル内で、基準 PR と比べたマージ済み PR の件数 */
export interface SampleComparison {
  /** 基準 PR より後に条件が整い、マージ済み */
  LaterReady: number;
  /** 基準 PR より後に作成され、マージ済み（追い越し） */
  LaterCreated: number;
  /** 基準 PR 以前に作成され、マージ済み */
  EarlierCreated: number;
  /** 基準 PR より新しい PR 番号でマージ済み */
  NewerNumber: number;
  /** 基準 PR より古い PR 番号でマージ済み */
  OlderNumber: number;
  Verdict: OvertakeVerdict;
  /** 初回提出者による追い越し（基準 PR より後に作成された初回提出者マージ） */
  FirstTimerLaterCreated?: number;
  /** 常連・特急レーンによる追い越し（基準 PR より後に作成された常連・手戻りマージ） */
  RepeatOrExpressLaterCreated?: number;
  /** 未判定（旧キャッシュ等で判定情報がない追い越し） */
  UnknownLaterCreated?: number;
}

/**
 * 基準 PR の現在値の位置づけ。
 * - within-median: 中央値以内
 * - within-p75: 中央値超〜75%点以内
 * - over-p75: 75%点超
 */
export type GuidanceLevel = "within-median" | "within-p75" | "over-p75";

export interface ReferenceGuidance {
  Level: GuidanceLevel;
  /** 中央値到達までの残り日数。すでに超えていれば null */
  ToMedianDays: number | null;
  /** 75%点到達までの残り日数。すでに超えていれば null */
  ToP75Days: number | null;
  /** サンプルのうち、基準 PR の現在値より短い期間でマージされた割合（%） */
  ShorterSharePct: number;
}

export interface ProgressGuidance {
  Total: ReferenceGuidance;
  Turn: ReferenceGuidance;
  Ready: ReferenceGuidance;
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
  TotalMaxDays: number | null;
  TurnMaxDays: number | null;
  ReadyMaxDays: number | null;
  /** 比較に使った期間（日） */
  LookbackDays: number;
  /** 初回提出者コホートの集計に使った期間（日）。省略時は LookbackDays または 30 */
  FirstTimerLookbackDays?: number;
  /** 統計に採用したサンプル数 */
  SampleCount: number;
  /** 条件不成立などで除外した候補数 */
  SkippedCount: number;
  /** 直前に並ぶ健康な PR（作成順で基準 PR の直前、最大 5 件） */
  Rivals: ProgressSnapshotRival[];
  /** 採用サンプル（マージ日時の新しい順）。空なら比較できていない */
  Samples: ProgressSnapshotSample[];
  /** サンプルがないときは null */
  Comparison: SampleComparison | null;
  /** サンプルがないときは null */
  Guidance: ProgressGuidance | null;
  /** 初回提出者コホートの通算所要日数中央値（サンプル不足時は null） */
  FirstTimerMedianDays?: number | null;
  /** 初回提出者コホートの通算所要日数75%点（サンプル不足時は null） */
  FirstTimerP75Days?: number | null;
  /** 初回提出者コホートの最終コミット後所要日数（Turn Latency）中央値（サンプル不足時は null） */
  FirstTimerTurnMedianDays?: number | null;
  /** 初回提出者コホートの最終コミット後所要日数（Turn Latency）75%点（サンプル不足時は null） */
  FirstTimerTurnP75Days?: number | null;
  /** 初回提出者サンプルの採用件数 */
  FirstTimerSampleCount?: number;
}
