import type {
  DepthsRow,
  InterventionKind,
  PrInterventionActor,
  PrInterventionBadge,
  PrInterventionCommentInput,
  PrInterventionInput,
  PrInterventionReviewInput,
  PrInterventionSummary,
} from "../models/depths";
import { DAY_MS, round1 } from "./formatters";

export type { FirstReviewCohortCandidate } from "./mainstream-cohort";
export {
  calculateFirstReviewMainstreamFrontier,
  FIRST_REVIEW_COHORT_ITEM_LIMIT,
  FIRST_REVIEW_COHORT_WINDOW_DAYS,
  FIRST_REVIEW_MAINSTREAM_MODE,
} from "./mainstream-cohort";

/**
 * `stephengillie` 等が個人アカウント経由で投稿する自動検証ログの識別マーカー。
 * アカウント全体ではなく該当本文のみを自動ログとして除外するために使用する。
 */
export const DETERMINISTIC_AUTOMATION_MARKER = "(Deterministic automation";

/**
 * 個人アカウント経由で投稿される自動メッセージ（URL ステータス確認等）の識別マーカー。
 */
export const AUTOMATED_MESSAGE_MARKER = "(Automated message";

/**
 * 未編集時に人間介入から除外する自動生成コメントの識別マーカー一覧（SSoT）。
 */
export const AUTOMATION_COMMENT_MARKERS: readonly string[] = [
  DETERMINISTIC_AUTOMATION_MARKER,
  AUTOMATED_MESSAGE_MARKER,
];

/**
 * GraphQL 上 `__typename === "User"` だが純粋ボットとして除外する既知アカウント群（小文字正規化済み）。
 */
export const PURE_BOT_LOGINS: ReadonlySet<string> = new Set(["wingetbot"]);

/**
 * アクター削除済み（`author === null`）時の表示用代替名。
 */
export const DELETED_ACTOR_LABEL = "deleted-user";

/**
 * 配列または `{ nodes }` 形式のコレクションから null/undefined を除いた要素列を抽出する。
 */
function unwrapNodes<T>(
  collection:
    | ReadonlyArray<T | null | undefined>
    | { nodes?: ReadonlyArray<T | null | undefined> | null }
    | null
    | undefined,
): T[] {
  const raw = Array.isArray(collection)
    ? collection
    : collection && typeof collection === "object" && "nodes" in collection
      ? collection.nodes
      : null;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is T => item !== null && item !== undefined);
}

/**
 * 指定ログイン名が PR 作成者本人と一致するか（大文字・小文字無視）を判定する。
 * `prAuthorLogin` が欠落している場合は本人判定不可のため false（第三者扱い）を返す。
 */
export function isSameActorLogin(
  actorLogin: string | null | undefined,
  prAuthorLogin: string | null | undefined,
): boolean {
  const normalizedAuthor = prAuthorLogin?.trim().toLowerCase();
  const normalizedActor = actorLogin?.trim().toLowerCase();
  if (!normalizedAuthor || !normalizedActor) {
    return false;
  }
  return normalizedActor === normalizedAuthor;
}

/**
 * GraphQL Actor が純粋ボットかどうかを判定する。
 * - `author === null`（削除済みアカウント）は人間の介入跡として扱うため false を返す。
 * - GraphQL の `Bot` 型は login に `[bot]` が付かないため `__typename === "Bot"` を最優先で確認する。
 */
export function isBotActor(actor: PrInterventionActor | null | undefined): boolean {
  if (!actor) {
    return false;
  }
  if (actor.__typename === "Bot") {
    return true;
  }
  const normalizedLogin = actor.login?.trim().toLowerCase() ?? "";
  if (!normalizedLogin) {
    return false;
  }
  return normalizedLogin.endsWith("[bot]") || PURE_BOT_LOGINS.has(normalizedLogin);
}

/**
 * Markdown の引用行（`>` で始まる行）を除いた非引用行に指定マーカーが含まれるかを判定する。
 * メンテナの手動コメントが自動生成ログを引用した場合に自動コメントとして誤除外しないために使用する。
 */
function hasUnquotedMarker(body: string | null | undefined, markers: readonly string[]): boolean {
  if (typeof body !== "string") {
    return false;
  }
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trimStart();
    if (trimmed.startsWith(">")) {
      continue;
    }
    if (markers.some((marker) => trimmed.includes(marker))) {
      return true;
    }
  }
  return false;
}

/**
 * 自動検証パイプライン由来の決定的ログコメントかどうかを判定する（Markdown 引用行を除く）。
 */
export function isDeterministicAutomationComment(body: string | null | undefined): boolean {
  return hasUnquotedMarker(body, [DETERMINISTIC_AUTOMATION_MARKER]);
}

/**
 * 個人アカウント権限で投稿される自動コメント（`(Deterministic automation` / `(Automated message` 等）かどうかを判定する。
 * Markdown の引用行（`>` 開始）内のみに出現するマーカーは自動生成フッターとはみなさない。
 */
export function isAutomationComment(body: string | null | undefined): boolean {
  return hasUnquotedMarker(body, AUTOMATION_COMMENT_MARKERS);
}

const CI_RERUN_COMMAND_PATTERN = /^@wingetbot\s+run$/i;

/**
 * CI の機械的な再実行のみを指示する単体コマンドコメント（`@wingetbot run`）かどうかを判定する。
 * 説明文が併記されている場合や `@wingetbot waivers ...` 等の人間判断コマンドは false を返す。
 */
export function isCiRerunCommandComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  return CI_RERUN_COMMAND_PATTERN.test(normalized);
}

const EXPLICIT_EDIT_LINE_PATTERN = /^(?:\*{1,2}|_{1,2})?edit\s*:/i;

function findLastUnquotedAutomationMarkerIndex(body: string): number {
  let latestIdx = -1;
  let offset = 0;
  for (const line of body.split(/\r?\n/)) {
    const lineEnd = body.indexOf("\n", offset);
    const nextOffset = lineEnd >= 0 ? lineEnd + 1 : body.length;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(">")) {
      for (const marker of AUTOMATION_COMMENT_MARKERS) {
        const localIdx = line.lastIndexOf(marker);
        if (localIdx >= 0) {
          const absIdx = offset + localIdx;
          if (absIdx > latestIdx) {
            latestIdx = absIdx;
          }
        }
      }
    }
    offset = nextOffset;
  }
  return latestIdx;
}

function hasManualAppendInDeterministicBody(body: string): boolean {
  const markerIdx = findLastUnquotedAutomationMarkerIndex(body);
  if (markerIdx >= 0) {
    const closeIdx = body.indexOf(")", markerIdx);
    if (closeIdx >= 0) {
      const trailing = body
        .slice(closeIdx + 1)
        .replace(/<!--[\s\S]*?-->/g, "")
        .trim();
      if (trailing.length > 0) {
        return true;
      }
    }
  }

  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(">")) {
      continue;
    }
    if (EXPLICIT_EDIT_LINE_PATTERN.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function hasEditedTimestampAfterCreation(comment: PrInterventionCommentInput): boolean {
  if (!comment.lastEditedAt) {
    return false;
  }
  const editedMs = Date.parse(comment.lastEditedAt);
  if (!Number.isFinite(editedMs)) {
    return false;
  }
  if (!comment.createdAt) {
    return true;
  }
  const createdMs = Date.parse(comment.createdAt);
  return !Number.isFinite(createdMs) || editedMs > createdMs;
}

/**
 * 自動コメント（`(Deterministic automation` / `(Automated message`）が、
 * 投稿後に第三者の人間によって編集された（`lastEditedAt` かつ `editor` がボット・作成者本人でない）かを判定する。
 */
function isThirdPartyHumanEditedComment(
  comment: PrInterventionCommentInput,
  prAuthorLogin?: string | null,
): boolean {
  if (!hasEditedTimestampAfterCreation(comment)) {
    return false;
  }
  if (comment.editor) {
    return !isBotActor(comment.editor) && !isSameActorLogin(comment.editor.login, prAuthorLogin);
  }
  return !isBotActor(comment.author) && !isSameActorLogin(comment.author?.login, prAuthorLogin);
}

/**
 * 自動コメント（`(Deterministic automation` / `(Automated message`）に、
 * ボット・作成者本人以外の人間による手動追記または編集形跡が含まれるかを判定する。
 * - `editor` がボットまたは作成者本人の場合は自動編集／本人編集として除外（false）する。
 * - 元投稿者（`author`）がボットまたは作成者本人の場合は、第三者の人間 `editor` による投稿後の編集のみを検知し、
 *   未編集のボット追記や作成者本人による自動ログ引用を誤検知しない。
 * - 元投稿者が第三者人間の場合は、マーカー末尾以降の追記・非引用行の `Edit:` / `*Edit:` 記載、
 *   または投稿後の `lastEditedAt` 存在を検知する。
 */
export function hasDeterministicAutomationManualEdit(
  comment: PrInterventionCommentInput,
  prAuthorLogin?: string | null,
): boolean {
  if (!isAutomationComment(comment.body)) {
    return false;
  }
  if (isBotActor(comment.editor) || isSameActorLogin(comment.editor?.login, prAuthorLogin)) {
    return false;
  }
  if (isBotActor(comment.author) || isSameActorLogin(comment.author?.login, prAuthorLogin)) {
    return isThirdPartyHumanEditedComment(comment, prAuthorLogin);
  }
  if (hasManualAppendInDeterministicBody(comment.body as string)) {
    return true;
  }
  return hasEditedTimestampAfterCreation(comment);
}

function resolveCommentActor(
  comment: PrInterventionCommentInput,
  prAuthorLogin?: string | null,
): string {
  if (
    isAutomationComment(comment.body) ||
    isBotActor(comment.author) ||
    isSameActorLogin(comment.author?.login, prAuthorLogin)
  ) {
    return comment.editor?.login?.trim() || comment.author?.login?.trim() || DELETED_ACTOR_LABEL;
  }
  return comment.author?.login?.trim() || DELETED_ACTOR_LABEL;
}

function resolveCommentInterventionAt(
  comment: PrInterventionCommentInput,
  prAuthorLogin?: string | null,
): string | null | undefined {
  if (
    (isAutomationComment(comment.body) ||
      isBotActor(comment.author) ||
      isSameActorLogin(comment.author?.login, prAuthorLogin)) &&
    hasEditedTimestampAfterCreation(comment)
  ) {
    return comment.lastEditedAt;
  }
  return comment.createdAt;
}

/**
 * PR 作成者（authorLogin）を除外した第三者 Assignees のログイン名一覧を抽出する。
 * - 大文字・小文字を区別せずに作成者本人を除外する（セルフアサインを第三者扱いしない）
 * - authorLogin が null / undefined / 空文字の場合は、有効な全 assignees を第三者として扱う
 * - 重複（大小文字違い含む）を排除して出現順を保つ
 */
export function extractThirdPartyAssignees(
  assignees:
    | ReadonlyArray<string | PrInterventionActor | null | undefined>
    | { nodes?: ReadonlyArray<PrInterventionActor | null> | null }
    | null
    | undefined,
  authorLogin?: string | null,
): string[] {
  const entries = unwrapNodes<string | PrInterventionActor>(assignees);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of entries) {
    const rawLogin = typeof entry === "string" ? entry : entry.login;
    const login = rawLogin?.trim();
    if (!login) continue;

    if (isSameActorLogin(login, authorLogin)) {
      continue;
    }

    const normalized = login.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(login);
  }

  return result;
}

/**
 * PR の reviews / comments を統合評価し、
 * 「未レビュー（完全未着手）」と「レビュー・介入済み」の判定結果・代表バッジ・最初の人間介入日時を生成する。
 *
 * - 実質的な人間アクション（ボット・作成者本人を除いた人間レビュー、または手動コメント）のみを介入とみなす。
 * - `(Deterministic automation` / `(Automated message` を含む未編集コメント、CI 再実行コマンド単体（`@wingetbot run`）、
 *   および第三者 Assignees の付与単体はいずれも介入判定・`FirstHumanInterventionAt` から除外する。
 * - 自動コメントでも、第三者の人間による手動追記（`Edit:` 等）または投稿後編集がある場合は人間コメントとして検知する。
 */
export function classifyPrIntervention(input: PrInterventionInput): PrInterventionSummary {
  const prAuthorLogin = input.author?.login ?? null;
  const thirdPartyAssignees = extractThirdPartyAssignees(input.assignees, prAuthorLogin);

  const reviews = unwrapNodes<PrInterventionReviewInput>(input.reviews);
  const humanReviews = reviews.filter(
    (r) => !isBotActor(r.author) && !isSameActorLogin(r.author?.login, prAuthorLogin),
  );

  const comments = unwrapNodes<PrInterventionCommentInput>(input.comments);
  const manualComments: PrInterventionCommentInput[] = [];
  for (const c of comments) {
    if (isAutomationComment(c.body)) {
      if (hasDeterministicAutomationManualEdit(c, prAuthorLogin)) {
        manualComments.push(c);
      }
      continue;
    }
    if (isCiRerunCommandComment(c.body)) {
      continue;
    }
    if (!isBotActor(c.author) && !isSameActorLogin(c.author?.login, prAuthorLogin)) {
      manualComments.push(c);
    } else if (isThirdPartyHumanEditedComment(c, prAuthorLogin)) {
      manualComments.push(c);
    }
  }

  let earliestIntervention: {
    ms: number;
    kind: InterventionKind;
    actor: string;
  } | null = null;
  const considerInterventionTime = (
    rawTs: string | null | undefined,
    kind: InterventionKind,
    actor: string,
  ): void => {
    if (!rawTs) return;
    const ms = Date.parse(rawTs);
    if (!Number.isFinite(ms)) return;
    if (!earliestIntervention || ms < earliestIntervention.ms) {
      earliestIntervention = { ms, kind, actor };
    }
  };

  for (const r of humanReviews) {
    considerInterventionTime(
      r.submittedAt ?? r.createdAt,
      "review",
      r.author?.login?.trim() || DELETED_ACTOR_LABEL,
    );
  }
  for (const c of manualComments) {
    considerInterventionTime(
      resolveCommentInterventionAt(c, prAuthorLogin),
      "comment",
      resolveCommentActor(c, prAuthorLogin),
    );
  }

  let primaryBadge: PrInterventionBadge | undefined;
  if (humanReviews.length > 0) {
    const latestReview = humanReviews[humanReviews.length - 1];
    const actor = latestReview.author?.login?.trim() || DELETED_ACTOR_LABEL;
    const state = latestReview.state?.trim() || undefined;
    primaryBadge = {
      Kind: "review",
      Actor: actor,
      Label: state ? `レビュー済: ${actor} (${state})` : `レビュー済: ${actor}`,
      ...(state ? { ReviewState: state } : {}),
    };
  } else if (manualComments.length > 0) {
    const latestComment = manualComments[manualComments.length - 1];
    const actor = resolveCommentActor(latestComment, prAuthorLogin);
    primaryBadge = {
      Kind: "comment",
      Actor: actor,
      Label: `コメント済: ${actor}`,
    };
  }

  return {
    Intervened: humanReviews.length > 0 || manualComments.length > 0,
    ThirdPartyAssignees: thirdPartyAssignees,
    HumanReviewCount: humanReviews.length,
    ManualCommentCount: manualComments.length,
    ...(primaryBadge ? { PrimaryBadge: primaryBadge } : {}),
    ...(earliestIntervention
      ? {
          FirstHumanInterventionAt: new Date(
            (earliestIntervention as { ms: number }).ms,
          ).toISOString(),
          FirstInterventionKind: (earliestIntervention as { kind: InterventionKind }).kind,
          FirstInterventionActor: (earliestIntervention as { actor: string }).actor,
        }
      : {}),
  };
}

export interface InterventionFrontierSummary {
  /** 抽出された上位件数 */
  count: number;
  /** 先頭 PR（起票日時が最古の行）。該当なしなら null */
  head: DepthsRow | null;
  /** 先頭 PR の起票日時からの経過日数（日）。算出不能なら null */
  headElapsedDays: number | null;
  /** 介入種別ごとの件数内訳（代表バッジ基準） */
  kindCounts: {
    review: number;
    comment: number;
    assignee: number;
  };
  /** 代表介入アクター別の件数内訳（件数降順） */
  actorCounts: Array<{ login: string; count: number }>;
}

/**
 * 未レビュー前線／レビュー・介入済み前線の行リストから、先頭位置・経過日数・介入内訳を算出する。
 */
export function summarizeInterventionFrontier(
  rows: DepthsRow[],
  observedAt: Date | string | number,
): InterventionFrontierSummary {
  const head = rows[0] ?? null;
  const observedMs =
    observedAt instanceof Date
      ? observedAt.getTime()
      : typeof observedAt === "number"
        ? observedAt
        : Date.parse(observedAt);
  const headCreatedMs = head ? Date.parse(head.CreatedAt) : Number.NaN;
  const headElapsedDays =
    Number.isFinite(observedMs) && Number.isFinite(headCreatedMs)
      ? round1((observedMs - headCreatedMs) / DAY_MS)
      : null;

  const kindCounts = { review: 0, comment: 0, assignee: 0 };
  const actorMap = new Map<string, number>();

  for (const row of rows) {
    const badge = row.Intervention?.PrimaryBadge;
    if (badge) {
      kindCounts[badge.Kind]++;
      if (badge.Actor) {
        actorMap.set(badge.Actor, (actorMap.get(badge.Actor) ?? 0) + 1);
      }
    }
  }

  const actorCounts = [...actorMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([login, count]) => ({ login, count }));

  return {
    count: rows.length,
    head,
    headElapsedDays,
    kindCounts,
    actorCounts,
  };
}
