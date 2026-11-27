/**
 * 初回提出（New package:）PR の差し戻し指摘抽出・マニフェスト解析・
 * フィルタリング・オフライン再分類・JSONL シリアライズに関する純粋ドメインロジック。
 * 外部 I/O を行わず、src/models と同一ドメイン内モジュールのみに依存する。
 */

import type {
  FeedbackTriggerKind,
  InstallerManifestMetadata,
  ReviewFeedbackAuthorReply,
  ReviewFeedbackComment,
  ReviewFeedbackCorpusEntry,
  ReviewFeedbackFilterOptions,
  ReviewFeedbackPrState,
  ReviewFeedbackRecord,
  ReviewFeedbackStateFilter,
} from "../models/review-feedback";
import { isPrivilegedAuthorAssociation } from "./first-timer";
import {
  DELETED_ACTOR_LABEL,
  hasDeterministicAutomationManualEdit,
  isAutomationComment,
  isBotActor,
  isSameActorLogin,
} from "./intervention";
import {
  CATEGORY_LABELS,
  categorizeFeedback,
  classifyFeedbackCommentSeverity,
  FEEDBACK_CATEGORY_RULES,
  type FeedbackCategoryRule,
  hasEmbeddedImage,
  isAuthorNoiseComment,
  isAutomaticValidationNoiseComment,
  isFalsePositiveNoteOnlyComment,
  isFeedbackNoiseComment,
  isPolicyCommandOnlyComment,
  isStaleCloseCommandOnlyComment,
  isVerifyMemoOnlyComment,
  isWingetbotCommandOnlyComment,
} from "./review-feedback-rules";

export {
  CATEGORY_LABELS,
  categorizeFeedback,
  classifyFeedbackCommentSeverity,
  FEEDBACK_CATEGORY_RULES,
  type FeedbackCategoryRule,
  hasEmbeddedImage,
  isAuthorNoiseComment,
  isAutomaticValidationNoiseComment,
  isFalsePositiveNoteOnlyComment,
  isFeedbackNoiseComment,
  isPolicyCommandOnlyComment,
  isStaleCloseCommandOnlyComment,
  isVerifyMemoOnlyComment,
  isWingetbotCommandOnlyComment,
};

/** 現行のレビュー指摘コーパススキーマバージョン（v2: 定型ノイズ除外・深刻度・7 カテゴリ・CLOSED 却下トリガー） */
export const CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION = 2;

/** 差し戻し履歴として検知するラベル一覧 */
export const FEEDBACK_TRIGGER_LABELS: readonly string[] = [
  "Needs-Author-Feedback",
  "Changes-Requested",
] as const;

/** CLOSED（未マージ終了）PR で直接却下トリガーとして検知するラベル一覧 */
export const CLOSED_REJECTION_LABELS: ReadonlySet<string> = new Set([
  "Blocking-Issue",
  "Scripted-Application",
  "Interactive-Only-Installer",
  "DriverInstall",
]);

const NEEDS_AUTHOR_FEEDBACK_LABEL = "Needs-Author-Feedback";
const CHANGES_REQUESTED_LABEL = "Changes-Requested";

/**
 * PR タイトルが初回パッケージ提出（`New package:`）で始まるかを判定する（大小文字無視・前後空白許容）。
 */
export function isNewPackageTitle(title: string | null | undefined): boolean {
  if (typeof title !== "string") {
    return false;
  }
  return /^\s*new\s+package\s*:/i.test(title);
}

/**
 * 状態ごとの GitHub Search クエリ条件文字列を構築する。
 * - `merged`: 指定期間内にマージされた `New-Package` + タイトル `New package:` PR（ラベル履歴はバッチ詳細で判定）
 * - `open` / `closed`: 指定期間内に更新された `New-Package` + タイトル `New package:` PR
 */
export function buildFeedbackSearchQueryParts(params: {
  repository: string;
  state: ReviewFeedbackStateFilter;
  sinceIso: string;
  untilIso: string;
  triggerQualifier?: "needs-author-feedback" | "changes-requested";
}): string[] {
  const parts = [
    `repo:${params.repository}`,
    "is:pr",
    'label:"New-Package"',
    '"New package:" in:title',
  ];

  if (params.state === "merged") {
    parts.push("is:merged", `merged:${params.sinceIso}..${params.untilIso}`);
  } else if (params.state === "open") {
    parts.push("is:open", `updated:${params.sinceIso}..${params.untilIso}`);
  } else {
    parts.push("is:closed", "is:unmerged", `updated:${params.sinceIso}..${params.untilIso}`);
  }

  if (params.triggerQualifier === "needs-author-feedback") {
    parts.push(`label:"${NEEDS_AUTHOR_FEEDBACK_LABEL}"`);
  } else if (params.triggerQualifier === "changes-requested") {
    parts.push("review:changes_requested");
  }

  return parts;
}

/** 詳細 PR 評価用の入力型 */
export interface RawPrActorInput {
  __typename?: string | null;
  login?: string | null;
}

export interface RawPrReviewCommentInput {
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  path?: string | null;
  body?: string | null;
  createdAt?: string | null;
}

export interface RawPrReviewInput {
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  state?: string | null;
  body?: string | null;
  submittedAt?: string | null;
  createdAt?: string | null;
  comments?: readonly RawPrReviewCommentInput[];
}

export interface RawPrCommentInput {
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  body?: string | null;
  createdAt?: string | null;
  lastEditedAt?: string | null;
  editor?: RawPrActorInput | null;
}

export interface RawPrFeedbackInput {
  repository: string;
  number: number;
  title: string;
  url: string;
  state: ReviewFeedbackPrState;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  commitCount: number;
  currentLabels: readonly string[];
  labeledEvents: ReadonlyArray<{ label: string; createdAt?: string }>;
  reviews: readonly RawPrReviewInput[];
  comments: readonly RawPrCommentInput[];
  filePaths: readonly string[];
}

function isClosedRejectionLabel(label: string): boolean {
  return CLOSED_REJECTION_LABELS.has(label) || /^Policy-Test-/i.test(label);
}

/**
 * 差し戻し・却下トリガーを判定する。
 * - 全状態共通: `Needs-Author-Feedback` / `Changes-Requested` ラベル履歴、人間 `CHANGES_REQUESTED` レビュー
 * - `CLOSED`（未マージ終了）のみ追加: 却下系ラベル（`Blocking-Issue` / `Scripted-Application` / `Interactive-Only-Installer` / `Policy-Test-*` 等）、
 *   または特権ロール（`MEMBER` / `COLLABORATOR` / `OWNER`）による実質的な人間指摘コメント
 */
export function detectFeedbackTriggers(params: {
  prAuthorLogin?: string | null;
  state?: ReviewFeedbackPrState;
  currentLabels: readonly string[];
  labeledEvents: ReadonlyArray<{ label: string }>;
  reviews: readonly RawPrReviewInput[];
  feedbackItems?: readonly ReviewFeedbackComment[];
}): {
  triggers: FeedbackTriggerKind[];
  historicalFeedbackLabels: string[];
} {
  const historicalSet = new Set<string>();
  const allLabels = new Set<string>([
    ...params.currentLabels,
    ...params.labeledEvents.map((e) => e.label),
  ]);

  const triggers: FeedbackTriggerKind[] = [];
  if (allLabels.has(NEEDS_AUTHOR_FEEDBACK_LABEL)) {
    triggers.push("needs-author-feedback-label");
    historicalSet.add(NEEDS_AUTHOR_FEEDBACK_LABEL);
  }
  if (allLabels.has(CHANGES_REQUESTED_LABEL)) {
    triggers.push("changes-requested-label");
    historicalSet.add(CHANGES_REQUESTED_LABEL);
  }

  const hasHumanChangesRequested = params.reviews.some(
    (review) =>
      String(review.state ?? "").toUpperCase() === "CHANGES_REQUESTED" &&
      !isBotActor(review.author) &&
      !isSameActorLogin(review.author?.login, params.prAuthorLogin),
  );
  if (hasHumanChangesRequested) {
    triggers.push("changes-requested-review");
  }

  if (params.state === "CLOSED") {
    const matchedClosedLabels = [...allLabels].filter(isClosedRejectionLabel);
    if (matchedClosedLabels.length > 0) {
      triggers.push("closed-rejection-label");
      for (const label of matchedClosedLabels) {
        historicalSet.add(label);
      }
    }

    const hasPrivilegedFeedback = (params.feedbackItems ?? []).some((item) =>
      isPrivilegedAuthorAssociation(item.authorAssociation),
    );
    if (hasPrivilegedFeedback) {
      triggers.push("closed-maintainer-feedback");
    }
  }

  return {
    triggers,
    historicalFeedbackLabels: [...historicalSet],
  };
}

function normalizeAssociation(raw: string | null | undefined): string {
  const trimmed = raw?.trim().toUpperCase();
  return trimmed && trimmed.length > 0 ? trimmed : "NONE";
}

function normalizeBody(body: string | null | undefined): string {
  return (body ?? "").replace(/\r\n/g, "\n").trim();
}

function extractRawThirdPartyHumanItems(params: {
  prAuthorLogin?: string | null;
  reviews: readonly RawPrReviewInput[];
  comments: readonly RawPrCommentInput[];
}): ReviewFeedbackComment[] {
  const items: ReviewFeedbackComment[] = [];

  for (const review of params.reviews) {
    const isHumanThirdPartyReview =
      !isBotActor(review.author) && !isSameActorLogin(review.author?.login, params.prAuthorLogin);

    const reviewBody = normalizeBody(review.body);
    if (isHumanThirdPartyReview && reviewBody.length > 0 && !isAutomationComment(reviewBody)) {
      items.push({
        source: "review",
        author: review.author?.login?.trim() || DELETED_ACTOR_LABEL,
        authorAssociation: normalizeAssociation(review.authorAssociation),
        createdAt: review.submittedAt ?? review.createdAt ?? "",
        ...(review.state ? { reviewState: review.state } : {}),
        body: reviewBody,
        hasImage: hasEmbeddedImage(reviewBody),
        severity: classifyFeedbackCommentSeverity(reviewBody),
      });
    }

    for (const inlineComment of review.comments ?? []) {
      if (
        isBotActor(inlineComment.author) ||
        isSameActorLogin(inlineComment.author?.login, params.prAuthorLogin)
      ) {
        continue;
      }
      const inlineBody = normalizeBody(inlineComment.body);
      if (!inlineBody || isAutomationComment(inlineBody)) {
        continue;
      }
      items.push({
        source: "review_comment",
        author: inlineComment.author?.login?.trim() || DELETED_ACTOR_LABEL,
        authorAssociation: normalizeAssociation(
          inlineComment.authorAssociation ?? review.authorAssociation,
        ),
        createdAt: inlineComment.createdAt ?? review.submittedAt ?? review.createdAt ?? "",
        ...(inlineComment.path ? { path: inlineComment.path } : {}),
        body: inlineBody,
        hasImage: hasEmbeddedImage(inlineBody),
        severity: classifyFeedbackCommentSeverity(inlineBody),
      });
    }
  }

  for (const comment of params.comments) {
    const body = normalizeBody(comment.body);
    if (!body) {
      continue;
    }

    if (isAutomationComment(body)) {
      if (!hasDeterministicAutomationManualEdit(comment, params.prAuthorLogin)) {
        continue;
      }
      const actor =
        comment.editor?.login?.trim() || comment.author?.login?.trim() || DELETED_ACTOR_LABEL;
      items.push({
        source: "issue_comment",
        author: actor,
        authorAssociation: normalizeAssociation(comment.authorAssociation),
        createdAt: comment.lastEditedAt ?? comment.createdAt ?? "",
        body,
        hasImage: hasEmbeddedImage(body),
        severity: classifyFeedbackCommentSeverity(body),
      });
      continue;
    }

    if (
      isBotActor(comment.author) ||
      isSameActorLogin(comment.author?.login, params.prAuthorLogin)
    ) {
      continue;
    }

    items.push({
      source: "issue_comment",
      author: comment.author?.login?.trim() || DELETED_ACTOR_LABEL,
      authorAssociation: normalizeAssociation(comment.authorAssociation),
      createdAt: comment.createdAt ?? "",
      body,
      hasImage: hasEmbeddedImage(body),
      severity: classifyFeedbackCommentSeverity(body),
    });
  }

  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return items;
}

/**
 * PR の reviews・インラインレビューコメント・通常コメントから、第三者人間による実質的な指摘コメントを抽出する。
 * Bot・PR 作成者本人・未編集自動検証ログ・定型ボットコマンド（`@wingetbot waivers` / `[Policy]` 等）・
 * `Verify:` スクショ/メモ単体・`Close with reason: Stale;` 単体・Policy-Test 誤検知転載は除外する。
 */
export function extractReviewFeedbackItems(params: {
  prAuthorLogin?: string | null;
  reviews: readonly RawPrReviewInput[];
  comments: readonly RawPrCommentInput[];
}): ReviewFeedbackComment[] {
  return extractRawThirdPartyHumanItems(params).filter(
    (item) => !isFeedbackNoiseComment(item.body),
  );
}

/**
 * PR 作成者本人による手動返信コメントを抽出する（CLA 同意・引用付き CLA・`bump` 単体・CI 再実行コマンド等は除外）。
 */
export function extractAuthorReplies(params: {
  prAuthorLogin?: string | null;
  comments: readonly RawPrCommentInput[];
}): ReviewFeedbackAuthorReply[] {
  if (!params.prAuthorLogin) {
    return [];
  }

  const replies: ReviewFeedbackAuthorReply[] = [];
  for (const comment of params.comments) {
    if (
      isBotActor(comment.author) ||
      !isSameActorLogin(comment.author?.login, params.prAuthorLogin)
    ) {
      continue;
    }
    const body = normalizeBody(comment.body);
    if (isAuthorNoiseComment(body)) {
      continue;
    }
    replies.push({
      author: comment.author?.login?.trim() || params.prAuthorLogin,
      createdAt: comment.createdAt ?? "",
      body,
    });
  }

  replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return replies;
}

/**
 * 変更ファイル一覧から、インストーラーメタデータ解析対象の `.installer.yaml` パス群を特定する。
 * `.installer.yaml` が見つからない場合は、単一マニフェスト（`manifests/` 配下の非 `.locale.` YAML）を候補にする。
 */
export function selectInstallerManifestPaths(filePaths: readonly string[]): string[] {
  const installerFiles = filePaths.filter((p) => /\.installer\.ya?ml$/i.test(p));
  if (installerFiles.length > 0) {
    return [...new Set(installerFiles)];
  }
  const singletonCandidates = filePaths.filter(
    (p) => /^manifests\//i.test(p) && /\.ya?ml$/i.test(p) && !/\.locale\.[^/]+\.ya?ml$/i.test(p),
  );
  return [...new Set(singletonCandidates)];
}

function unquoteYamlScalar(raw: string): string {
  const withoutInlineComment = raw.replace(/\s+#.*$/, "").trim();
  if (
    (withoutInlineComment.startsWith('"') && withoutInlineComment.endsWith('"')) ||
    (withoutInlineComment.startsWith("'") && withoutInlineComment.endsWith("'"))
  ) {
    return withoutInlineComment.slice(1, -1).trim();
  }
  return withoutInlineComment;
}

/**
 * 複数の `.installer.yaml` 本文テキストからインストーラー種別・アーキテクチャ・スコープ等のメタデータを抽出する。
 */
export function parseInstallerManifestMetadata(
  files: ReadonlyArray<{ path: string; text: string | null | undefined }>,
): InstallerManifestMetadata {
  const filePaths: string[] = [];
  const installerTypes = new Set<string>();
  const nestedInstallerTypes = new Set<string>();
  const architectures = new Set<string>();
  const scopes = new Set<string>();
  let manifestVersion: string | undefined;

  for (const file of files) {
    filePaths.push(file.path);
    if (!file.text) {
      continue;
    }

    for (const rawLine of file.text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const match = /^(?:-\s*)?([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+)$/.exec(trimmed);
      if (!match) {
        continue;
      }
      const key = match[1];
      const value = unquoteYamlScalar(match[2]);
      if (!value) {
        continue;
      }

      if (key === "InstallerType") {
        installerTypes.add(value.toLowerCase());
      } else if (key === "NestedInstallerType") {
        nestedInstallerTypes.add(value.toLowerCase());
      } else if (key === "Architecture") {
        architectures.add(value.toLowerCase());
      } else if (key === "Scope") {
        scopes.add(value.toLowerCase());
      } else if (key === "ManifestVersion" && !manifestVersion) {
        manifestVersion = value;
      }
    }
  }

  const installerTypeList = [...installerTypes].sort();
  const nestedTypeList = [...nestedInstallerTypes].sort();
  const isPortable = installerTypes.has("portable") || nestedInstallerTypes.has("portable");

  return {
    files: filePaths,
    installerTypes: installerTypeList,
    nestedInstallerTypes: nestedTypeList,
    architectures: [...architectures].sort(),
    scopes: [...scopes].sort(),
    ...(manifestVersion ? { manifestVersion } : {}),
    isPortable,
  };
}

/**
 * 指摘コメント配列からブロッキング差し戻し指摘を 1 件以上含むかを判定する。
 */
export function hasBlockingFeedbackItems(feedbackItems: readonly ReviewFeedbackComment[]): boolean {
  return feedbackItems.some(
    (item) => (item.severity ?? classifyFeedbackCommentSeverity(item.body)) === "blocking",
  );
}

/**
 * 生の PR 詳細入力とインストーラーメタデータから、最終的なコーパスエントリ（`feedback` または `no-feedback`）を生成する。
 */
export function buildReviewFeedbackEntry(params: {
  pr: RawPrFeedbackInput;
  installer: InstallerManifestMetadata;
  isFirstTimeAuthor?: boolean;
  authorMergedCount?: number;
  collectedAt: string;
}): ReviewFeedbackCorpusEntry {
  const { pr, installer, collectedAt } = params;

  if (!isNewPackageTitle(pr.title)) {
    return {
      schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
      entryType: "no-feedback",
      repository: pr.repository,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      skipReason: "not-new-package-title",
      collectedAt,
    };
  }

  const prAuthorLogin = pr.author?.login ?? null;
  const rawHumanItems = extractRawThirdPartyHumanItems({
    prAuthorLogin,
    reviews: pr.reviews,
    comments: pr.comments,
  });
  const feedbackItems = rawHumanItems.filter((item) => !isFeedbackNoiseComment(item.body));

  const { triggers, historicalFeedbackLabels } = detectFeedbackTriggers({
    prAuthorLogin,
    state: pr.state,
    currentLabels: pr.currentLabels,
    labeledEvents: pr.labeledEvents,
    reviews: pr.reviews,
    feedbackItems,
  });

  if (triggers.length === 0) {
    return {
      schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
      entryType: "no-feedback",
      repository: pr.repository,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      skipReason: "no-rejection-trigger",
      collectedAt,
    };
  }

  if (feedbackItems.length === 0) {
    const hasOnlyNonCommandNoise = rawHumanItems.some(
      (item) => !isPolicyCommandOnlyComment(item.body) && isFeedbackNoiseComment(item.body),
    );
    return {
      schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
      entryType: "no-feedback",
      repository: pr.repository,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      skipReason: hasOnlyNonCommandNoise ? "noise-only-feedback" : "no-human-feedback",
      collectedAt,
    };
  }

  const authorReplies = extractAuthorReplies({
    prAuthorLogin,
    comments: pr.comments,
  });

  const { categories, categoryMatches } = categorizeFeedback({
    feedbackItems,
    authorReplies,
  });

  return {
    schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
    entryType: "feedback",
    repository: pr.repository,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    closedAt: pr.closedAt,
    author: prAuthorLogin ?? DELETED_ACTOR_LABEL,
    authorAssociation: normalizeAssociation(pr.authorAssociation),
    ...(params.isFirstTimeAuthor !== undefined
      ? { isFirstTimeAuthor: params.isFirstTimeAuthor }
      : {}),
    ...(params.authorMergedCount !== undefined
      ? { authorMergedCount: params.authorMergedCount }
      : {}),
    commitCount: pr.commitCount,
    triggers,
    currentLabels: [...pr.currentLabels],
    historicalFeedbackLabels,
    installer,
    feedbackItems,
    authorReplies,
    categories,
    categoryMatches,
    hasBlockingFeedback: hasBlockingFeedbackItems(feedbackItems),
    collectedAt,
  };
}

export interface ReclassifyCorpusResult {
  entries: ReviewFeedbackCorpusEntry[];
  stats: {
    totalProcessed: number;
    reclassifiedFeedbackCount: number;
    demotedToNoiseOnlyCount: number;
    upgradedMergedSkippedCount: number;
    keptLegacySkippedCount: number;
    removedFeedbackCommentsCount: number;
    removedAuthorRepliesCount: number;
  };
}

/**
 * 既存コーパスエントリを GitHub API 再取得なしで現行ルール（v2）へオフライン再評価する。
 * - `feedback` レコードは保持済みの `feedbackItems` / `authorReplies` を現行ノイズ除外・深刻度・カテゴリで再評価し、
 *   残存指摘が 0 件になれば `no-feedback`（`skipReason: "noise-only-feedback"`）へ降格する。
 * - `MERGED` の `no-feedback` は v2 でトリガーが拡大していないため `CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION` へ安全に昇格する。
 * - `CLOSED` / `OPEN` の旧版 `no-feedback` は v2 の新トリガー判定に API 詳細が必要なため旧 `schemaVersion` を維持し、次回取得対象に残す。
 */
export function reclassifyReviewFeedbackCorpus(
  entries: readonly ReviewFeedbackCorpusEntry[],
): ReclassifyCorpusResult {
  const result: ReviewFeedbackCorpusEntry[] = [];
  let reclassifiedFeedbackCount = 0;
  let demotedToNoiseOnlyCount = 0;
  let upgradedMergedSkippedCount = 0;
  let keptLegacySkippedCount = 0;
  let removedFeedbackCommentsCount = 0;
  let removedAuthorRepliesCount = 0;

  for (const entry of entries) {
    if (entry.entryType === "no-feedback") {
      if (
        entry.state === "MERGED" &&
        entry.schemaVersion < CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION
      ) {
        upgradedMergedSkippedCount++;
        result.push({
          ...entry,
          schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
        });
      } else {
        if (entry.schemaVersion < CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION) {
          keptLegacySkippedCount++;
        }
        result.push(entry);
      }
      continue;
    }

    const cleanedFeedbackItems: ReviewFeedbackComment[] = [];
    for (const item of entry.feedbackItems) {
      if (isFeedbackNoiseComment(item.body)) {
        removedFeedbackCommentsCount++;
        continue;
      }
      cleanedFeedbackItems.push({
        ...item,
        severity: classifyFeedbackCommentSeverity(item.body),
      });
    }

    const cleanedAuthorReplies: ReviewFeedbackAuthorReply[] = [];
    for (const reply of entry.authorReplies) {
      if (isAuthorNoiseComment(reply.body)) {
        removedAuthorRepliesCount++;
        continue;
      }
      cleanedAuthorReplies.push(reply);
    }

    if (cleanedFeedbackItems.length === 0) {
      demotedToNoiseOnlyCount++;
      result.push({
        schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
        entryType: "no-feedback",
        repository: entry.repository,
        number: entry.number,
        title: entry.title,
        state: entry.state,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        mergedAt: entry.mergedAt,
        closedAt: entry.closedAt,
        skipReason: "noise-only-feedback",
        collectedAt: entry.collectedAt,
      });
      continue;
    }

    const { categories, categoryMatches } = categorizeFeedback({
      feedbackItems: cleanedFeedbackItems,
      authorReplies: cleanedAuthorReplies,
    });
    reclassifiedFeedbackCount++;
    result.push({
      ...entry,
      schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
      feedbackItems: cleanedFeedbackItems,
      authorReplies: cleanedAuthorReplies,
      categories,
      categoryMatches,
      hasBlockingFeedback: hasBlockingFeedbackItems(cleanedFeedbackItems),
    });
  }

  return {
    entries: result,
    stats: {
      totalProcessed: entries.length,
      reclassifiedFeedbackCount,
      demotedToNoiseOnlyCount,
      upgradedMergedSkippedCount,
      keptLegacySkippedCount,
      removedFeedbackCommentsCount,
      removedAuthorRepliesCount,
    },
  };
}

/**
 * フィルタ条件（ポータブル形式・インストーラー種別・特権ロール限定・初回作者限定・ブロッキング限定）をレコード群へ適用する。
 * `privilegedOnly` または `blockingOnly` が有効な場合は、条件を満たす指摘コメントのみに絞り込み、
 * 残存コメント 0 件の PR を除外してカテゴリと `hasBlockingFeedback` を再計算する。
 */
export function filterReviewFeedbackRecords(
  records: readonly ReviewFeedbackRecord[],
  options: ReviewFeedbackFilterOptions,
): ReviewFeedbackRecord[] {
  const installerTypeSet =
    options.installerTypes && options.installerTypes.length > 0
      ? new Set(options.installerTypes.map((t) => t.trim().toLowerCase()).filter(Boolean))
      : null;
  const nestedTypeSet =
    options.nestedInstallerTypes && options.nestedInstallerTypes.length > 0
      ? new Set(options.nestedInstallerTypes.map((t) => t.trim().toLowerCase()).filter(Boolean))
      : null;

  const filtered: ReviewFeedbackRecord[] = [];
  for (const record of records) {
    if (options.portableOnly && !record.installer.isPortable) {
      continue;
    }
    if (
      installerTypeSet &&
      !record.installer.installerTypes.some((t) => installerTypeSet.has(t.toLowerCase()))
    ) {
      continue;
    }
    if (
      nestedTypeSet &&
      !record.installer.nestedInstallerTypes.some((t) => nestedTypeSet.has(t.toLowerCase()))
    ) {
      continue;
    }
    if (options.firstTimerOnly && record.isFirstTimeAuthor !== true) {
      continue;
    }

    if (options.privilegedOnly || options.blockingOnly) {
      const scopedItems = record.feedbackItems.filter((item) => {
        if (options.privilegedOnly && !isPrivilegedAuthorAssociation(item.authorAssociation)) {
          return false;
        }
        if (options.blockingOnly) {
          const sev = item.severity ?? classifyFeedbackCommentSeverity(item.body);
          if (sev !== "blocking") {
            return false;
          }
        }
        return true;
      });
      if (scopedItems.length === 0) {
        continue;
      }
      const { categories, categoryMatches } = categorizeFeedback({
        feedbackItems: scopedItems,
        authorReplies: record.authorReplies,
      });
      filtered.push({
        ...record,
        feedbackItems: scopedItems,
        categories,
        categoryMatches,
        hasBlockingFeedback: hasBlockingFeedbackItems(scopedItems),
      });
      continue;
    }

    filtered.push(record);
  }

  return filtered;
}

export interface CachedFeedbackReuseCheckOptions {
  currentSchemaVersion?: number;
  /** 検索結果から判明した最新の PR 状態（キャッシュと不一致なら再取得） */
  currentState?: ReviewFeedbackPrState;
  /** 検索結果から判明した最新の更新日時 ISO 8601（キャッシュより新しければ再取得） */
  currentUpdatedAt?: string;
}

/**
 * コーパス内の重複排除・索引に用いる一意キー（`owner/repo#number`、リポジトリ名は小文字正規化）を生成する。
 */
export function getReviewFeedbackCorpusKey(repository: string, prNumber: number): string {
  return `${repository.trim().toLowerCase()}#${prNumber}`;
}

/**
 * キャッシュ済みエントリを再利用して詳細再取得をスキップできるか判定する。
 * - スキーマ版が古い場合は常に再取得（false）。
 * - `MERGED` / `CLOSED` は状態一致かつ `currentUpdatedAt` がキャッシュより進んでいなければ再利用可。
 * - `OPEN` は `currentState` と `currentUpdatedAt` が両方渡され、状態一致かつ未更新
 *   （`currentUpdatedAt <= entry.updatedAt`）が確認できた場合のみ再利用可（再実行時に未処理候補へ前進するため）。
 */
export function canReuseCachedFeedbackEntry(
  entry: ReviewFeedbackCorpusEntry | undefined,
  optionsOrVersion:
    | number
    | CachedFeedbackReuseCheckOptions = CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
): boolean {
  if (!entry) {
    return false;
  }
  const opts: CachedFeedbackReuseCheckOptions =
    typeof optionsOrVersion === "number"
      ? { currentSchemaVersion: optionsOrVersion }
      : optionsOrVersion;
  const currentSchemaVersion = opts.currentSchemaVersion ?? CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION;

  if (entry.schemaVersion < currentSchemaVersion) {
    return false;
  }
  if (opts.currentState !== undefined && opts.currentState !== entry.state) {
    return false;
  }

  const hasCurrentUpdatedAt = opts.currentUpdatedAt !== undefined;
  const cachedMs = Date.parse(entry.updatedAt);
  const currentMs = hasCurrentUpdatedAt ? Date.parse(opts.currentUpdatedAt as string) : Number.NaN;

  if (entry.state === "OPEN") {
    if (opts.currentState !== "OPEN" || !hasCurrentUpdatedAt) {
      return false;
    }
    return Number.isFinite(cachedMs) && Number.isFinite(currentMs) && currentMs <= cachedMs;
  }

  if (entry.state !== "MERGED" && entry.state !== "CLOSED") {
    return false;
  }
  if (hasCurrentUpdatedAt) {
    if (!Number.isFinite(cachedMs) || (Number.isFinite(currentMs) && currentMs > cachedMs)) {
      return false;
    }
  }
  return true;
}

/**
 * JSONL コーパス文字列をパースしてエントリ配列を返す。
 * 不正な JSON 行やスキーマ欠損行がある場合は例外をスローする。
 */
export function parseReviewFeedbackCorpus(raw: string): ReviewFeedbackCorpusEntry[] {
  const entries: ReviewFeedbackCorpusEntry[] = [];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`JSONL の ${i + 1} 行目が不正な JSON です: ${msg}`, { cause: err });
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(`JSONL の ${i + 1} 行目がオブジェクトではありません`);
    }

    const obj = parsed as Record<string, unknown>;
    if (
      (obj.entryType !== "feedback" && obj.entryType !== "no-feedback") ||
      typeof obj.number !== "number" ||
      !Number.isInteger(obj.number) ||
      typeof obj.schemaVersion !== "number" ||
      typeof obj.repository !== "string" ||
      obj.repository.trim().length === 0
    ) {
      throw new Error(
        `JSONL の ${i + 1} 行目に必須フィールド (entryType / repository / number / schemaVersion) が不足しています`,
      );
    }

    if (
      obj.entryType === "feedback" &&
      (!Array.isArray(obj.feedbackItems) || !obj.installer || typeof obj.installer !== "object")
    ) {
      throw new Error(
        `JSONL の ${i + 1} 行目の feedback レコードに必須フィールド (feedbackItems / installer) が不足しています`,
      );
    }

    entries.push(parsed as ReviewFeedbackCorpusEntry);
  }

  return entries;
}

/**
 * コーパスエントリを `(repository, number)` 複合キーで重複排除（後勝ち）し、
 * PR 番号降順・リポジトリ昇順でソートして JSONL 文字列へ直列化する。
 */
export function serializeReviewFeedbackCorpus(
  entries: readonly ReviewFeedbackCorpusEntry[],
): string {
  const byKey = new Map<string, ReviewFeedbackCorpusEntry>();
  for (const entry of entries) {
    byKey.set(getReviewFeedbackCorpusKey(entry.repository, entry.number), entry);
  }
  const sorted = [...byKey.values()].sort(
    (a, b) => b.number - a.number || a.repository.localeCompare(b.repository),
  );
  if (sorted.length === 0) {
    return "";
  }
  return `${sorted.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * コーパスエントリ一覧から `(repository, number)` 複合キーのマップを構築する（後勝ち）。
 */
export function indexReviewFeedbackCorpus(
  entries: readonly ReviewFeedbackCorpusEntry[],
): Map<string, ReviewFeedbackCorpusEntry> {
  const map = new Map<string, ReviewFeedbackCorpusEntry>();
  for (const entry of entries) {
    map.set(getReviewFeedbackCorpusKey(entry.repository, entry.number), entry);
  }
  return map;
}
