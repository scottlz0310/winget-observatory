/**
 * 初回提出（New package:）PR の差し戻し指摘抽出・マニフェスト解析・カテゴリ自動分類・
 * フィルタリング・JSONL シリアライズに関する純粋ドメインロジック。
 * 外部 I/O を行わず、src/models と同一ドメイン内モジュールのみに依存する。
 */

import type {
  FeedbackCategoryMatch,
  FeedbackTriggerKind,
  InstallerManifestMetadata,
  ReviewFeedbackAuthorReply,
  ReviewFeedbackCategoryId,
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
  isCiRerunCommandComment,
  isSameActorLogin,
} from "./intervention";

/** 現行のレビュー指摘コーパススキーマバージョン */
export const CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION = 1;

/** 差し戻し履歴として検知するラベル一覧 */
export const FEEDBACK_TRIGGER_LABELS: readonly string[] = [
  "Needs-Author-Feedback",
  "Changes-Requested",
] as const;

const NEEDS_AUTHOR_FEEDBACK_LABEL = "Needs-Author-Feedback";
const CHANGES_REQUESTED_LABEL = "Changes-Requested";

/** カテゴリ定義（表示ラベルとキーワードルール） */
export interface FeedbackCategoryRule {
  id: Exclude<ReviewFeedbackCategoryId, "uncategorized">;
  label: string;
  patterns: ReadonlyArray<{ keyword: string; regex: RegExp }>;
}

export const FEEDBACK_CATEGORY_RULES: readonly FeedbackCategoryRule[] = [
  {
    id: "dll-runtime",
    label: "DLL / ランタイム欠損",
    patterns: [
      { keyword: "VCRUNTIME140", regex: /\bvcruntime\d*/i },
      { keyword: "MSVCP140", regex: /\bmsvcp\d*/i },
      { keyword: "ucrtbase", regex: /\bucrtbase\b/i },
      {
        keyword: "VCRedist",
        regex: /\b(?:vcredist|vc\+\+|visual\s+c\+\+|c\+\+\s+redistributable)\b/i,
      },
      { keyword: ".dll", regex: /(?:\.dll\b|\bdll\b)/i },
      { keyword: "missing", regex: /\bmissing\b/i },
      { keyword: "not found", regex: /\bnot\s+found\b/i },
      {
        keyword: "runtime",
        regex: /\b(?:c\s+runtime|runtime\s+(?:missing|required|dependency|dll))\b/i,
      },
    ],
  },
  {
    id: "launch-command",
    label: "起動・コマンド動作不良",
    patterns: [
      { keyword: "fails to start", regex: /\bfails?\s+to\s+(?:start|launch|run)\b/i },
      { keyword: "launch", regex: /\blaunch(?:es|ing|ed)?\b/i },
      { keyword: "exit code", regex: /\bexit\s+code\b/i },
      { keyword: "crash", regex: /\bcrash(?:es|ed|ing)?\b/i },
      { keyword: "PortableCommandAlias", regex: /\bPortableCommandAlias\b/i },
      { keyword: "Commands", regex: /\bCommands\b/ },
    ],
  },
  {
    id: "metadata-url",
    label: "メタデータ・URL 不備",
    patterns: [
      { keyword: "PrivacyUrl", regex: /\bPrivacyUrl\b/i },
      { keyword: "ReleaseNotesUrl", regex: /\bReleaseNotesUrl\b/i },
      { keyword: "PublisherSupportUrl", regex: /\bPublisherSupportUrl\b/i },
      { keyword: "PublisherUrl", regex: /\bPublisherUrl\b/i },
      { keyword: "LicenseUrl", regex: /\bLicenseUrl\b/i },
      { keyword: "PackageUrl", regex: /\bPackageUrl\b/i },
      { keyword: "404", regex: /\b404\b/ },
      { keyword: "redirect", regex: /\bredirect(?:s|ed|ing)?\b/i },
      { keyword: "broken link", regex: /\b(?:dead|broken)\s+(?:link|url)\b/i },
    ],
  },
  {
    id: "manifest-installer",
    label: "マニフェスト構造・インストーラー種別",
    patterns: [
      { keyword: "NestedInstallerType", regex: /\bNestedInstallerType\b/i },
      { keyword: "InstallerType", regex: /\bInstallerType\b/i },
      { keyword: "Architecture", regex: /\bArchitecture\b/i },
      { keyword: "UpgradeBehavior", regex: /\bUpgradeBehavior\b/i },
      { keyword: "Scope", regex: /\bScope\b/ },
      { keyword: "InstallerSwitches", regex: /\bInstallerSwitches\b/i },
      { keyword: "InstallerSha256", regex: /\bInstallerSha256\b/i },
      { keyword: "ManifestVersion", regex: /\bManifestVersion\b/i },
      { keyword: "AppsAndFeaturesEntries", regex: /\bAppsAndFeaturesEntries\b/i },
    ],
  },
  {
    id: "security-signing",
    label: "セキュリティ / 署名 / SmartScreen",
    patterns: [
      { keyword: "SmartScreen", regex: /\bsmartscreen\b/i },
      { keyword: "VirusTotal", regex: /\bvirustotal\b/i },
      { keyword: "defender", regex: /\bdefender\b/i },
      { keyword: "malware", regex: /\b(?:malware|trojan|virus)\b/i },
      { keyword: "signature", regex: /\b(?:signature|unsigned|code\s*sign(?:ing|ed)?)\b/i },
    ],
  },
] as const;

export const CATEGORY_LABELS: Record<ReviewFeedbackCategoryId, string> = {
  "dll-runtime": "DLL / ランタイム欠損",
  "launch-command": "起動・コマンド動作不良",
  "metadata-url": "メタデータ・URL 不備",
  "manifest-installer": "マニフェスト構造・インストーラー種別",
  "security-signing": "セキュリティ / 署名 / SmartScreen",
  uncategorized: "未分類（その他・新種候補）",
};

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
 * - `open` / `closed`: 指定期間内に更新された `New-Package` + タイトル `New package:` + `Needs-Author-Feedback` ラベル PR
 *   （`changesRequestedOnly` 指定時は `review:changes_requested` 用の補助クエリも構築可能）
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

/**
 * `[Policy] Needs-Author-Feedback` 等の Policy Bot 向け単体コマンドコメントか判定する。
 * 説明文が併記されている場合は false を返す。
 */
export function isPolicyCommandOnlyComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!normalized) {
    return true;
  }
  return /^\[Policy\]\s+[^\r\n]+$/i.test(normalized);
}

/**
 * PR 作成者の定型コマンドコメント（CLA 同意・CI 再実行コマンド単体等）か判定する。
 */
export function isAuthorNoiseComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return true;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!normalized) {
    return true;
  }
  if (isCiRerunCommandComment(normalized) || isPolicyCommandOnlyComment(normalized)) {
    return true;
  }
  // Microsoft CLA 同意コマンド（例: `@microsoft-github-policy-service agree ...` または単独の `agree`）
  if (/^@microsoft-github-policy-service\s+agree\b/i.test(normalized)) {
    return true;
  }
  if (/^agree$/i.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * コメント本文に画像添付（HTML `<img>` または Markdown `![]()`）が含まれるかを判定する。
 */
export function hasEmbeddedImage(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  return /<img\b[^>]*\bsrc=/i.test(body) || /!\[[^\]]*\]\([^)]+\)/.test(body);
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

/**
 * 差し戻しトリガー（`Needs-Author-Feedback` / `Changes-Requested` ラベル履歴、人間 `CHANGES_REQUESTED` レビュー）を判定する。
 */
export function detectFeedbackTriggers(params: {
  prAuthorLogin?: string | null;
  currentLabels: readonly string[];
  labeledEvents: ReadonlyArray<{ label: string }>;
  reviews: readonly RawPrReviewInput[];
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

/**
 * PR の reviews・インラインレビューコメント・通常コメントから、第三者人間による指摘コメントを抽出する。
 * Bot・PR 作成者本人・未編集自動検証ログ・CI 再実行コマンド単体・`[Policy]` 単体コマンドは除外する。
 */
export function extractReviewFeedbackItems(params: {
  prAuthorLogin?: string | null;
  reviews: readonly RawPrReviewInput[];
  comments: readonly RawPrCommentInput[];
}): ReviewFeedbackComment[] {
  const items: ReviewFeedbackComment[] = [];

  for (const review of params.reviews) {
    const isHumanThirdPartyReview =
      !isBotActor(review.author) && !isSameActorLogin(review.author?.login, params.prAuthorLogin);

    const reviewBody = normalizeBody(review.body);
    if (
      isHumanThirdPartyReview &&
      reviewBody.length > 0 &&
      !isPolicyCommandOnlyComment(reviewBody) &&
      !isCiRerunCommandComment(reviewBody) &&
      !isAutomationComment(reviewBody)
    ) {
      items.push({
        source: "review",
        author: review.author?.login?.trim() || DELETED_ACTOR_LABEL,
        authorAssociation: normalizeAssociation(review.authorAssociation),
        createdAt: review.submittedAt ?? review.createdAt ?? "",
        ...(review.state ? { reviewState: review.state } : {}),
        body: reviewBody,
        hasImage: hasEmbeddedImage(reviewBody),
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
      if (
        !inlineBody ||
        isPolicyCommandOnlyComment(inlineBody) ||
        isCiRerunCommandComment(inlineBody) ||
        isAutomationComment(inlineBody)
      ) {
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
      });
    }
  }

  for (const comment of params.comments) {
    const body = normalizeBody(comment.body);
    if (!body || isPolicyCommandOnlyComment(body) || isCiRerunCommandComment(body)) {
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
    });
  }

  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return items;
}

/**
 * PR 作成者本人による手動返信コメントを抽出する（CLA 同意・CI 再実行コマンド等は除外）。
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
 * 指摘コメント群（および任意で作成者返信群）をルールベースでカテゴリ分類する（マルチタグ対応）。
 * どのルールにも該当しない場合は `uncategorized` を付与する。
 */
export function categorizeFeedback(params: {
  feedbackItems: readonly ReviewFeedbackComment[];
  authorReplies?: readonly ReviewFeedbackAuthorReply[];
}): {
  categories: ReviewFeedbackCategoryId[];
  categoryMatches: FeedbackCategoryMatch[];
} {
  const combinedTexts = [
    ...params.feedbackItems.map((item) => item.body),
    ...(params.authorReplies ?? []).map((reply) => reply.body),
  ];
  const corpus = combinedTexts.join("\n\n");

  const categoryMatches: FeedbackCategoryMatch[] = [];
  for (const rule of FEEDBACK_CATEGORY_RULES) {
    const matchedKeywords: string[] = [];
    for (const pattern of rule.patterns) {
      if (pattern.regex.test(corpus)) {
        matchedKeywords.push(pattern.keyword);
      }
    }
    if (matchedKeywords.length > 0) {
      categoryMatches.push({
        category: rule.id,
        matchedKeywords,
      });
    }
  }

  if (categoryMatches.length === 0) {
    return {
      categories: ["uncategorized"],
      categoryMatches: [{ category: "uncategorized", matchedKeywords: [] }],
    };
  }

  return {
    categories: categoryMatches.map((m) => m.category),
    categoryMatches,
  };
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
  const { triggers, historicalFeedbackLabels } = detectFeedbackTriggers({
    prAuthorLogin,
    currentLabels: pr.currentLabels,
    labeledEvents: pr.labeledEvents,
    reviews: pr.reviews,
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

  const feedbackItems = extractReviewFeedbackItems({
    prAuthorLogin,
    reviews: pr.reviews,
    comments: pr.comments,
  });

  if (feedbackItems.length === 0) {
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
      skipReason: "no-human-feedback",
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
    collectedAt,
  };
}

/**
 * フィルタ条件（ポータブル形式・インストーラー種別・特権ロール限定・初回作者限定）をレコード群へ適用する。
 * `privilegedOnly` が有効な場合は、特権ロール（MEMBER / COLLABORATOR / OWNER）の指摘コメントのみに絞り込み、
 * 残存コメント 0 件の PR を除外してカテゴリを再計算する。
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

    if (options.privilegedOnly) {
      const privilegedItems = record.feedbackItems.filter((item) =>
        isPrivilegedAuthorAssociation(item.authorAssociation),
      );
      if (privilegedItems.length === 0) {
        continue;
      }
      const { categories, categoryMatches } = categorizeFeedback({
        feedbackItems: privilegedItems,
        authorReplies: record.authorReplies,
      });
      filtered.push({
        ...record,
        feedbackItems: privilegedItems,
        categories,
        categoryMatches,
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
