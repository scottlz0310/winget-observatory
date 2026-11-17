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
  /** 人間レビュー・手動コメント・第三者 Assignees のいずれかが存在すれば true */
  Intervened: boolean;
  /** PR 作成者を除いた第三者 Assignees */
  ThirdPartyAssignees: string[];
  /** ボット・作成者本人を除いた人間レビュー数 */
  HumanReviewCount: number;
  /** ボット・作成者本人・自動検証ログを除いた手動コメント数 */
  ManualCommentCount: number;
  /** 最も強い介入種別に基づく代表バッジ（未介入時は undefined） */
  PrimaryBadge?: PrInterventionBadge;
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
}

/**
 * 介入判定の入力となるコメント項目
 */
export interface PrInterventionCommentInput {
  author?: PrInterventionActor | null;
  body?: string | null;
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
    } | null> | null;
  } | null;
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
   */
  DepthsVersion?: number;
  Timestamp: string;
  TimestampJst: string;
  Repository: string;
  TargetPr: TargetPrInfo | null;
  HealthyBottom: DepthsRow[];
  AbsoluteBottom: DepthsRow[];
  /** 優等生の底（1コミット限定の健康体の中で更新日時が最も古い PR） */
  StaleBottom: DepthsRow[];
  /** 初回提出者の底（手直しコミット込み・生涯マージ 0 回の初回提出者の中で起票日時が最も古い健康な PR） */
  FirstTimerBottom?: DepthsRow[];
  /** 未レビュー（完全未着手）前線（健康な待機 PR のうち人間レビュー・手動コメント・第三者アサインすべて無し・起票日時順） */
  UnreviewedBottom?: DepthsRow[];
  /** レビュー・介入済み前線（健康な待機 PR のうち人間レビュー・手動コメント・第三者アサインのいずれかあり・起票日時順） */
  IntervenedBottom?: DepthsRow[];
  /** 未レビュー前線の探索が走査上限到達により途中で打ち切られた場合 true */
  UnreviewedTruncated?: boolean;
  /** レビュー・介入済み前線の探索が走査上限到達により途中で打ち切られた場合 true */
  IntervenedTruncated?: boolean;
  /** @deprecated v2 互換用（v3 以降は UnreviewedBottom を使用） */
  UnassignedBottom?: DepthsRow[];
  /** @deprecated v2 互換用（v3 以降は IntervenedBottom を使用） */
  AssignedBottom?: DepthsRow[];
  /** @deprecated v2 互換用（v3 以降は UnreviewedTruncated を使用） */
  UnassignedTruncated?: boolean;
  /** @deprecated v2 互換用（v3 以降は IntervenedTruncated を使用） */
  AssignedTruncated?: boolean;
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
  noTargetPr: boolean;
  noHistory: boolean;
  asJson: boolean;
}
