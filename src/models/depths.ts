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
 * 各底（Healthy, Absolute, Stale, Express）の 1 行データ
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
  StaleBottom: DepthsRow[];
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
