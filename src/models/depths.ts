/**
 * GitHub API の Search Issues / PRs アイテムの型定義
 */
export interface GitHubSearchItem {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  author?: string;
  author_association?: string;
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
    login: string;
  } | null;
  authorAssociation: string;
  commits: {
    totalCount: number;
  };
  labels?: {
    nodes?: Array<{
      name: string;
    }>;
  } | null;
}

/**
 * 各底（Healthy, Absolute, Stale, FirstTimer, Express）の 1 行データ
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
}

/**
 * キュー境界探索のスナップショット（JSON / JSONL 永続化用）
 */
export interface DepthsSnapshot {
  /** 観測定義バージョン（2: StaleBottom=1コミット限定 / FirstTimerBottom=起票順・生涯マージ0回。未設定・1は旧定義） */
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
