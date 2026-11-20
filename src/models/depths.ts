/**
 * GitHub API の Search Issues / PRs アイテムの型定義
 */
export interface GitHubSearchItem {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

/**
 * PR への人間・第三者による介入種別（強い順に review > comment > assignee）
 */
export type InterventionKind = "review" | "comment" | "assignee";

/**
 * PR への代表的な介入内容を示す表示用バッジ情報
 */
export interface PrInterventionBadge {
  Kind: InterventionKind;
  Actor: string;
  Label: string;
  ReviewState?: string;
}

/**
 * PR に対する人間レビュー・手動コメント・第三者 Assignees の統合判定結果
 */
export interface PrInterventionSummary {
  /** 人間レビュー・手動コメント・第三者 Assignees・特権ロールによる自動指摘のいずれかが存在すれば true */
  Intervened: boolean;
  /** PR 作成者を除いた第三者 Assignees */
  ThirdPartyAssignees: string[];
  /** ボット・作成者本人を除いた人間レビュー数 */
  HumanReviewCount: number;
  /** ボット・作成者本人・未編集自動検証ログを除いた手動コメント数 */
  ManualCommentCount: number;
  /** Deterministic automation を含むが発言者が COLLABORATOR / MEMBER / OWNER である自動指摘コメント数 */
  PrivilegedAutomationCommentCount?: number;
  /** 最も強い介入種別に基づく代表バッジ（未介入時は undefined） */
  PrimaryBadge?: PrInterventionBadge;
  /** 最初の人間介入日時（ISO 8601, UTC。タイムスタンプ付き介入が観測できた場合のみ） */
  FirstHumanInterventionAt?: string;
  /** 最初の人間介入種別 */
  FirstInterventionKind?: InterventionKind;
  /** 最初の人間介入アクター */
  FirstInterventionActor?: string;
}

/**
 * 介入判定のアクター表現（GraphQL Actor 互換）
 */
export interface PrInterventionActor {
  __typename?: string | null;
  login?: string | null;
}

/**
 * 介入判定の入力となるレビュー項目
 */
export interface PrInterventionReviewInput {
  author?: PrInterventionActor | null;
  state?: string | null;
  submittedAt?: string | null;
  createdAt?: string | null;
}

/**
 * 介入判定の入力となるコメント項目
 */
export interface PrInterventionCommentInput {
  author?: PrInterventionActor | null;
  authorAssociation?: string | null;
  body?: string | null;
  createdAt?: string | null;
  lastEditedAt?: string | null;
  editor?: PrInterventionActor | null;
}

/**
 * 介入判定の入力となる第三者アサインイベント項目（AssignedEvent）
 */
export interface PrInterventionAssignedEventInput {
  __typename?: string | null;
  createdAt?: string | null;
  actor?: PrInterventionActor | null;
  assignee?: PrInterventionActor | null;
}

/**
 * 介入判定関数への純粋入力オブジェクト
 */
export interface PrInterventionInput {
  author?: PrInterventionActor | null;
  assignees?:
    | ReadonlyArray<string | PrInterventionActor | null | undefined>
    | { nodes?: ReadonlyArray<PrInterventionActor | null> | null }
    | null;
  reviews?:
    | ReadonlyArray<PrInterventionReviewInput | null | undefined>
    | { nodes?: ReadonlyArray<PrInterventionReviewInput | null> | null }
    | null;
  comments?:
    | ReadonlyArray<PrInterventionCommentInput | null | undefined>
    | { nodes?: ReadonlyArray<PrInterventionCommentInput | null> | null }
    | null;
  timelineItems?:
    | ReadonlyArray<PrInterventionAssignedEventInput | null | undefined>
    | { nodes?: ReadonlyArray<PrInterventionAssignedEventInput | null> | null }
    | null;
}

/**
 * 基準 PR の取得結果
 */
export interface GitHubPrView {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author?: string;
  /** PR 作成者を除いた第三者 Assignees（GraphQL で assignees 取得時のみ設定） */
  thirdPartyAssignees?: string[];
  /** 人間レビュー・手動コメント・第三者アサインの介入判定結果 */
  intervention?: PrInterventionSummary;
}

/**
 * 基準 PR の観測メタデータ
 */
export interface TargetPrInfo {
  Number: number;
  Title: string;
  Url: string;
  CreatedAt: string;
  CreatedAtJst: string;
  /** 基準 PR の最終更新時刻（マージ時期の予想モデルが使う） */
  UpdatedAt: string;
  /** PR 作成者ログイン名（旧データ互換のためオプショナル） */
  Author?: string;
  /** PR 作成者を除いた第三者 Assignees（旧データ互換のためオプショナル） */
  ThirdPartyAssignees?: string[];
  /** 人間レビュー・手動コメント・第三者アサインの介入判定結果（v3 以降で保存） */
  Intervention?: PrInterventionSummary;
}

/**
 * GraphQL API の PullRequest 検索ノード
 */
export interface GraphQLPrNode {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  author?: {
    __typename?: string | null;
    login: string;
  } | null;
  authorAssociation: string;
  commits: {
    totalCount: number;
  };
  assignees?: {
    nodes?: Array<{
      __typename?: string | null;
      login?: string | null;
    } | null> | null;
  } | null;
  reviews?: {
    totalCount?: number;
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    } | null;
    nodes?: Array<{
      author?: PrInterventionActor | null;
      state?: string | null;
      submittedAt?: string | null;
      createdAt?: string | null;
    } | null> | null;
  } | null;
  comments?: {
    totalCount?: number;
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    } | null;
    nodes?: Array<{
      author?: PrInterventionActor | null;
      body?: string | null;
      createdAt?: string | null;
      lastEditedAt?: string | null;
      editor?: PrInterventionActor | null;
    } | null> | null;
  } | null;
  timelineItems?: {
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    } | null;
    nodes?: Array<PrInterventionAssignedEventInput | null> | null;
  } | null;
}

/**
 * 初回レビュー到達予想の算出方式識別子（旧未着手底との分離・速度算出ガード用）
 */
export type FirstReviewFrontierMode = "cohort-median-7d";

/**
 * 主戦場ライン（7日間初回人間介入コホート）の内訳 1 行
 */
export interface FirstReviewCohortItem {
  Number: number;
  Title: string;
  Url: string;
  State: "OPEN" | "MERGED";
  Author?: string;
  /** PR 作成者のリポジトリ関連付け（NONE / CONTRIBUTOR 等） */
  AuthorAssociation?: string;
  /** 作者の生涯マージ済 PR 数（初回提出者判定メタデータ） */
  AuthorMergedCount?: number;
  CommitCount?: number;
  CreatedAt: string;
  FirstHumanInterventionAt: string;
  InterventionKind?: InterventionKind;
  InterventionActor?: string;
  MergedAt?: string | null;
}

/**
 * 直近 7 日間に初めて人間介入が入った初回提出 PR コホートの主戦場ライン集計（v4 以降）
 */
export interface FirstReviewFrontier {
  Mode: FirstReviewFrontierMode;
  WindowDays: number;
  CohortCount: number;
  OpenCount: number;
  MergedCount: number;
  MedianCreatedAt: string | null;
  LagDays: number | null;
  OldestCreatedAt?: string | null;
  NewestCreatedAt?: string | null;
  Items?: FirstReviewCohortItem[];
}

/**
 * 各底（Healthy, Absolute, Stale, FirstTimer, Express, Unreviewed, Intervened）の 1 行データ
 */
export interface DepthsRow {
  PR: string;
  Number: number;
  作成日時: string;
  更新日時: string;
  CreatedAt: string;
  UpdatedAt: string;
  タイトル: string;
  Title: string;
  Url: string;
  Author?: string;
  AuthorAssociation?: string;
  /** 作者の生涯マージ済 PR 数（常連除外判定用。旧データ互換のためオプショナル） */
  AuthorMergedCount?: number;
  /** コミット数（GraphQL 経由の底取得時に記録。旧データ互換のためオプショナル） */
  CommitCount?: number;
  /** PR 作成者を除いた第三者 Assignees 一覧（旧データ互換のためオプショナル） */
  ThirdPartyAssignees?: string[];
  /** 人間レビュー・手動コメント・第三者アサインの介入判定結果（v3 以降） */
  Intervention?: PrInterventionSummary;
}

/**
 * キュー境界探索のスナップショット（JSON / JSONL 永続化用）
 */
export interface DepthsSnapshot {
  /**
   * 観測定義バージョン:
   * - 未設定 / 1: 旧定義（StaleBottom=全コミット、FirstTimerBottom=updatedAt順・生涯マージ未検証）
   * - 2: 役割分離版（StaleBottom=1コミット限定、FirstTimerBottom=createdAt順・生涯マージ0回検証済み、Unassigned/Assigned）
   * - 3: 介入判定分離版（UnreviewedBottom / IntervenedBottom: 人間レビュー・手動コメント・第三者アサイン OR 分離）
   * - 4: 主戦場ライン版（FirstReviewFrontier: 直近7日間初回人間介入コホートの createdAt 中央値・オープン＋マージ済み）
   * - 5: 2×2 待機ライン統一版（HealthyBottom GraphQL TOP 10、SingleCommitBottom / FirstTimerSingleCommitBottom / FirstTimerUnreviewedBottom、全象限作者メタデータ統一）
   */
  DepthsVersion?: number;
  Timestamp: string;
  TimestampJst: string;
  Repository: string;
  TargetPr: TargetPrInfo | null;
  HealthyBottom: DepthsRow[];
  AbsoluteBottom: DepthsRow[];
  /** マージ前線・全体（1コミット健康体 PR の起票日時古い順 TOP 10、v5 以降） */
  SingleCommitBottom?: DepthsRow[];
  /** マージ前線・初回提出者のみ（1コミット健康体・生涯マージ 0 回の起票日時古い順 TOP 10、v5 以降） */
  FirstTimerSingleCommitBottom?: DepthsRow[];
  /** 更新停止最古（1コミット限定の健康体の中で更新日時が最も古い PR。後方互換・補助参照用） */
  StaleBottom: DepthsRow[];
  /** 初回提出者の底（手直しコミット込み・生涯マージ 0 回の初回提出者の中で起票日時が最も古い健康な PR） */
  FirstTimerBottom?: DepthsRow[];
  /** 未レビュー（完全未着手）前線・全体（健康な待機 PR のうち人間レビュー・手動コメント・第三者アサイン・特権自動指摘すべて無し・起票日時順） */
  UnreviewedBottom?: DepthsRow[];
  /** 未レビュー（完全未着手）前線・初回提出者のみ（起票日時順 TOP 10、v5 以降） */
  FirstTimerUnreviewedBottom?: DepthsRow[];
  /** @deprecated UI 未表示（v4 以降は FirstReviewFrontier を使用。旧履歴互換用） */
  IntervenedBottom?: DepthsRow[];
  /** 未レビュー前線（全体）の探索が走査上限到達により途中で打ち切られた場合 true */
  UnreviewedTruncated?: boolean;
  /** 未レビュー前線（初回提出者のみ）の探索が走査上限到達により途中で打ち切られた場合 true */
  FirstTimerUnreviewedTruncated?: boolean;
  /** @deprecated 旧履歴互換用 */
  IntervenedTruncated?: boolean;
  /** @deprecated v2 互換用（v3 以降は UnreviewedBottom を使用） */
  UnassignedBottom?: DepthsRow[];
  /** @deprecated v2 互換用（v3 以降は IntervenedBottom を使用） */
  AssignedBottom?: DepthsRow[];
  /** @deprecated v2 互換用（v3 以降は UnreviewedTruncated を使用） */
  UnassignedTruncated?: boolean;
  /** @deprecated v2 互換用（v3 以降は IntervenedTruncated を使用） */
  AssignedTruncated?: boolean;
  /** 直近 7 日間の初回人間介入コホートによる主戦場ライン集計（v4 以降） */
  FirstReviewFrontier?: FirstReviewFrontier;
  ExpressLane: DepthsRow[];
}

/**
 * CLI 実行オプション
 */
export interface ExploreDepthsOptions {
  targetPr: number;
  repository: string;
  outputPath?: string;
  historyPath?: string;
  samplesPath?: string;
  noTargetPr: boolean;
  noHistory: boolean;
  asJson: boolean;
}
