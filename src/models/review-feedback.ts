/**
 * 初回提出（New package:）PR のメンテナ差し戻し指摘収集・分類に関する型定義。
 * 他レイヤー（domain / api / cli）への依存を持たない純粋なモデル層。
 */

/** 収集対象の PR 状態 */
export type ReviewFeedbackPrState = "MERGED" | "OPEN" | "CLOSED";

/** 検索指定に用いる小文字 PR 状態 */
export type ReviewFeedbackStateFilter = "merged" | "open" | "closed";

/** 差し戻しトリガーの種別 */
export type FeedbackTriggerKind =
  | "needs-author-feedback-label"
  | "changes-requested-label"
  | "changes-requested-review"
  | "closed-rejection-label"
  | "closed-maintainer-feedback";

/** 抽出した指摘コメントのソース種別 */
export type FeedbackCommentSource = "review" | "review_comment" | "issue_comment";

/** 指摘コメントの深刻度（ブロッキング差し戻し vs 非ブロッキング助言） */
export type FeedbackCommentSeverity = "blocking" | "non-blocking";

/** 地雷カテゴリ ID（7 カテゴリ + 未分類） */
export type ReviewFeedbackCategoryId =
  | "privacy-policy"
  | "dll-runtime"
  | "launch-command"
  | "metadata-url"
  | "manifest-installer"
  | "locale-language"
  | "security-signing"
  | "uncategorized";

/** 差し戻し指摘の個別コメント */
export interface ReviewFeedbackComment {
  /** ソース種別（レビュー本文 / インラインレビューコメント / 通常 PR コメント） */
  source: FeedbackCommentSource;
  /** 投稿者ログイン名（削除済みアカウント時は deleted-user） */
  author: string;
  /** GraphQL authorAssociation（MEMBER / COLLABORATOR / CONTRIBUTOR / NONE 等） */
  authorAssociation: string;
  /** 投稿日時（ISO 8601） */
  createdAt: string;
  /** レビュー状態（source === "review" の場合のみ） */
  reviewState?: string;
  /** 対象ファイルパス（インラインレビューコメントの場合のみ） */
  path?: string;
  /** コメント本文（生テキスト） */
  body: string;
  /** スクリーンショット等の画像添付を含むか（HTML img / Markdown image 判定） */
  hasImage: boolean;
  /** ブロッキング差し戻しか非ブロッキング助言か（v2 以降で付与、v1 互換時は未設定） */
  severity?: FeedbackCommentSeverity;
}

/** PR 作成者による手動返信コメント（修正内容・原因説明の文脈保持用） */
export interface ReviewFeedbackAuthorReply {
  /** 投稿者ログイン名 */
  author: string;
  /** 投稿日時（ISO 8601） */
  createdAt: string;
  /** コメント本文（生テキスト） */
  body: string;
}

/** `.installer.yaml` 等から抽出したインストーラーメタデータ */
export interface InstallerManifestMetadata {
  /** 解析対象となったマニフェストファイルのパス一覧 */
  files: string[];
  /** InstallerType 一覧（小文字正規化・重複排除済み） */
  installerTypes: string[];
  /** NestedInstallerType 一覧（小文字正規化・重複排除済み） */
  nestedInstallerTypes: string[];
  /** Architecture 一覧（小文字正規化・重複排除済み） */
  architectures: string[];
  /** Scope 一覧（小文字正規化・重複排除済み） */
  scopes: string[];
  /** ManifestVersion（判明した場合） */
  manifestVersion?: string;
  /** ポータブル配布形式（InstallerType: portable または NestedInstallerType: portable）か */
  isPortable: boolean;
}

/** カテゴリ分類の詳細結果 */
export interface FeedbackCategoryMatch {
  /** カテゴリ ID */
  category: ReviewFeedbackCategoryId;
  /** ヒットしたキーワード一覧（uncategorized 時は空配列） */
  matchedKeywords: string[];
}

/** 差し戻し指摘が抽出された PR レコード（JSONL 1 行） */
export interface ReviewFeedbackRecord {
  /** スキーマバージョン（再評価判定用） */
  schemaVersion: number;
  /** レコード種別（指摘あり） */
  entryType: "feedback";
  /** 対象リポジトリ（owner/repo） */
  repository: string;
  /** PR 番号 */
  number: number;
  /** PR タイトル */
  title: string;
  /** PR URL */
  url: string;
  /** PR 状態 */
  state: ReviewFeedbackPrState;
  /** 起票日時（ISO 8601） */
  createdAt: string;
  /** 更新日時（ISO 8601） */
  updatedAt: string;
  /** マージ日時（未マージ時は null） */
  mergedAt: string | null;
  /** クローズ日時（未クローズ時は null） */
  closedAt: string | null;
  /** PR 作成者ログイン名 */
  author: string;
  /** PR 作成者の GraphQL authorAssociation */
  authorAssociation: string;
  /** 初回提出者（非特権・非 Bot かつ生涯マージ数が 1 以下 / OPEN・CLOSED は 0）か。未判定時は undefined */
  isFirstTimeAuthor?: boolean;
  /** 作者の生涯マージ済み PR 数（照会済みの場合） */
  authorMergedCount?: number;
  /** コミット総数 */
  commitCount: number;
  /** 差し戻しトリガー一覧 */
  triggers: FeedbackTriggerKind[];
  /** 現在のラベル一覧 */
  currentLabels: string[];
  /** タイムライン上で付与履歴のあった差し戻し関連ラベル一覧 */
  historicalFeedbackLabels: string[];
  /** インストーラーメタデータ */
  installer: InstallerManifestMetadata;
  /** メンテナ・第三者レビュアーからの指摘コメント一覧 */
  feedbackItems: ReviewFeedbackComment[];
  /** PR 作成者の手動返信コメント一覧（CLA 同意等ノイズ除外済み） */
  authorReplies: ReviewFeedbackAuthorReply[];
  /** 自動分類カテゴリ一覧（マルチタグ） */
  categories: ReviewFeedbackCategoryId[];
  /** カテゴリ別のマッチキーワード詳細 */
  categoryMatches: FeedbackCategoryMatch[];
  /** ブロッキングな差し戻し指摘を 1 件以上含むか（false の場合は非ブロッキング助言のみ） */
  hasBlockingFeedback?: boolean;
  /** このレコードを収集した日時（ISO 8601） */
  collectedAt: string;
}

/** 差し戻し無し・人間指摘無しと確定した PR のキャッシュレコード（JSONL 1 行） */
export interface ReviewFeedbackSkippedRecord {
  /** スキーマバージョン */
  schemaVersion: number;
  /** レコード種別（指摘なしキャッシュ） */
  entryType: "no-feedback";
  /** 対象リポジトリ */
  repository: string;
  /** PR 番号 */
  number: number;
  /** PR タイトル */
  title: string;
  /** PR 状態 */
  state: ReviewFeedbackPrState;
  /** 起票日時（ISO 8601） */
  createdAt: string;
  /** 更新日時（ISO 8601） */
  updatedAt: string;
  /** マージ日時 */
  mergedAt: string | null;
  /** クローズ日時 */
  closedAt: string | null;
  /** スキップ理由 */
  skipReason:
    | "not-new-package-title"
    | "no-rejection-trigger"
    | "no-human-feedback"
    | "noise-only-feedback";
  /** 記録日時（ISO 8601） */
  collectedAt: string;
}

/** JSONL コーパスに格納される全レコードのユニオン型 */
export type ReviewFeedbackCorpusEntry = ReviewFeedbackRecord | ReviewFeedbackSkippedRecord;

/** カテゴリ別集計行 */
export interface CategorySummaryRow {
  category: ReviewFeedbackCategoryId;
  label: string;
  count: number;
  ratioPercent: number;
  topKeywords: Array<{ keyword: string; count: number }>;
  samplePrNumbers: number[];
}

/** インストーラー種別別集計行 */
export interface InstallerTypeSummaryRow {
  key: string;
  count: number;
  ratioPercent: number;
}

/** 収集結果の全体サマリー */
export interface ReviewFeedbackSummary {
  repository: string;
  generatedAt: string;
  totalFeedbackPrs: number;
  blockingPrCount: number;
  nonBlockingOnlyPrCount: number;
  totalFeedbackComments: number;
  totalAuthorReplies: number;
  portablePrCount: number;
  firstTimeAuthorPrCount: number;
  stateCounts: Record<ReviewFeedbackPrState, number>;
  triggerCounts: Record<FeedbackTriggerKind, number>;
  categoryRanking: CategorySummaryRow[];
  installerTypeBreakdown: InstallerTypeSummaryRow[];
  nestedInstallerTypeBreakdown: InstallerTypeSummaryRow[];
}

/** フィルタ条件 */
export interface ReviewFeedbackFilterOptions {
  /** 許可する InstallerType（小文字正規化済み）。空なら無制限 */
  installerTypes?: readonly string[];
  /** 許可する NestedInstallerType（小文字正規化済み）。空なら無制限 */
  nestedInstallerTypes?: readonly string[];
  /** ポータブル配布形式（portable / zip+portable）のみに限定するか */
  portableOnly?: boolean;
  /** 指摘コメントを MEMBER / COLLABORATOR / OWNER のみに限定するか */
  privilegedOnly?: boolean;
  /** 初回提出者（isFirstTimeAuthor === true）の PR のみに限定するか */
  firstTimerOnly?: boolean;
  /** ブロッキングな指摘コメントのみに限定するか（非ブロッキング助言のみの PR を除外） */
  blockingOnly?: boolean;
}

/** CLI 実行オプション */
export interface CollectReviewFeedbackOptions {
  repository: string;
  lookbackDays: number;
  states: ReviewFeedbackStateFilter[];
  fetchBudget: number;
  fetchLimit: number;
  outputPath?: string;
  reportPath?: string;
  noReport: boolean;
  noWrite: boolean;
  asJson: boolean;
  installerTypes: string[];
  nestedInstallerTypes: string[];
  portableOnly: boolean;
  privilegedOnly: boolean;
  firstTimerOnly: boolean;
  blockingOnly: boolean;
  reclassify: boolean;
  now?: Date;
}
