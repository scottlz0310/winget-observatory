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
}

/**
 * キュー境界探索のスナップショット（JSON / JSONL 永続化用）
 */
export interface DepthsSnapshot {
  Timestamp: string;
  TimestampJst: string;
  Repository: string;
  TargetPr: TargetPrInfo | null;
  HealthyBottom: DepthsRow[];
  AbsoluteBottom: DepthsRow[];
  /** 優等生の底（旧称: 遭難の底。健康体の中で更新日時が最も古い PR） */
  StaleBottom: DepthsRow[];
  /** 初回提出者の底（優等生の底から常連を除外した初回提出者・1コミットの PR） */
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
