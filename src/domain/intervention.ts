import type {
  DepthsRow,
  FirstReviewCohortItem,
  FirstReviewFrontier,
  InterventionKind,
  PrInterventionActor,
  PrInterventionAssignedEventInput,
  PrInterventionBadge,
  PrInterventionCommentInput,
  PrInterventionInput,
  PrInterventionReviewInput,
  PrInterventionSummary,
} from "../models/depths";
import { isPrivilegedAuthorAssociation } from "./first-timer";
import { calculateNumericMedian, DAY_MS, round1 } from "./formatters";

/** 主戦場ライン（初回介入コホート中央値）のモード識別子 */
export const FIRST_REVIEW_MAINSTREAM_MODE = "cohort-median-7d" as const;

/** 主戦場ラインのコホート集計窓（日） */
export const FIRST_REVIEW_COHORT_WINDOW_DAYS = 7;

/** スナップショットに保存するコホート内訳アイテムの最大件数 */
export const FIRST_REVIEW_COHORT_ITEM_LIMIT = 30;

/**
 * `stephengillie` 等が個人アカウント経由で投稿する自動検証ログの識別マーカー。
 * アカウント全体ではなく該当本文のみを自動ログとして除外するために使用する。
 */
export const DETERMINISTIC_AUTOMATION_MARKER = "(Deterministic automation";

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
 * 自動検証パイプライン由来の決定的ログコメントかどうかを判定する。
 */
export function isDeterministicAutomationComment(body: string | null | undefined): boolean {
  return typeof body === "string" && body.includes(DETERMINISTIC_AUTOMATION_MARKER);
}

const EXPLICIT_EDIT_LINE_PATTERN = /^(?:\*{1,2}|_{1,2})?edit\s*:/i;

function hasManualAppendInDeterministicBody(body: string): boolean {
  const markerIdx = body.lastIndexOf(DETERMINISTIC_AUTOMATION_MARKER);
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
 * 自動検証ログ（`(Deterministic automation`）を含むコメントが、
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
 * 自動検証ログ（`(Deterministic automation`）を含むコメントに、
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
  if (!isDeterministicAutomationComment(comment.body)) {
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

function resolveCommentActor(comment: PrInterventionCommentInput): string {
  if (isDeterministicAutomationComment(comment.body)) {
    return comment.editor?.login?.trim() || comment.author?.login?.trim() || DELETED_ACTOR_LABEL;
  }
  return comment.author?.login?.trim() || DELETED_ACTOR_LABEL;
}

function resolveCommentInterventionAt(
  comment: PrInterventionCommentInput,
): string | null | undefined {
  if (isDeterministicAutomationComment(comment.body) && hasEditedTimestampAfterCreation(comment)) {
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

function isEligibleThirdPartyAssignedEvent(
  event: PrInterventionAssignedEventInput,
  prAuthorLogin: string | null,
): boolean {
  if (event.__typename && event.__typename !== "AssignedEvent") {
    return false;
  }
  if (!event.createdAt || !Number.isFinite(Date.parse(event.createdAt))) {
    return false;
  }
  if (isBotActor(event.actor) || isBotActor(event.assignee)) {
    return false;
  }
  if (!event.assignee?.login?.trim()) {
    return false;
  }
  return !isSameActorLogin(event.assignee.login, prAuthorLogin);
}

/**
 * PR の reviews / comments / assignees / timelineItems を統合評価し、
 * 「未レビュー（完全未着手）」と「レビュー・介入済み」の判定結果・代表バッジ・最初の人間介入日時を生成する。
 *
 * - `Deterministic automation` を含むコメントでも、発言者が特権ロール（COLLABORATOR / MEMBER / OWNER）
 *   かつ非ボット・非作成者である場合は「トリアージ反応あり（`PrivilegedAutomationCommentCount`）」として
 *   `Intervened = true`（未レビュー前線から除外）とする。
 * - 一方、`FirstHumanInterventionAt`（主戦場ライン用）には一斉バッチ（build 1830 等）や自動検証投稿による
 *   時刻逆戻りを防ぐため、人間の手動レビュー・手動コメント・第三者アサインのみを算入する。
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
  const privilegedAutomationComments: PrInterventionCommentInput[] = [];
  for (const c of comments) {
    if (isDeterministicAutomationComment(c.body)) {
      if (hasDeterministicAutomationManualEdit(c, prAuthorLogin)) {
        manualComments.push(c);
      } else if (
        !isBotActor(c.author) &&
        !isSameActorLogin(c.author?.login, prAuthorLogin) &&
        isPrivilegedAuthorAssociation(c.authorAssociation)
      ) {
        privilegedAutomationComments.push(c);
      }
      continue;
    }
    if (!isBotActor(c.author) && !isSameActorLogin(c.author?.login, prAuthorLogin)) {
      manualComments.push(c);
    }
  }

  const assignedEvents = unwrapNodes<PrInterventionAssignedEventInput>(input.timelineItems).filter(
    (e) => isEligibleThirdPartyAssignedEvent(e, prAuthorLogin),
  );

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
    considerInterventionTime(resolveCommentInterventionAt(c), "comment", resolveCommentActor(c));
  }
  for (const e of assignedEvents) {
    considerInterventionTime(
      e.createdAt,
      "assignee",
      e.assignee?.login?.trim() || e.actor?.login?.trim() || DELETED_ACTOR_LABEL,
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
    const actor = resolveCommentActor(latestComment);
    primaryBadge = {
      Kind: "comment",
      Actor: actor,
      Label: `コメント済: ${actor}`,
    };
  } else if (thirdPartyAssignees.length > 0) {
    primaryBadge = {
      Kind: "assignee",
      Actor: thirdPartyAssignees[0],
      Label: `アサイン済: ${thirdPartyAssignees.join(", ")}`,
    };
  } else if (privilegedAutomationComments.length > 0) {
    const latestPrivAuto = privilegedAutomationComments[privilegedAutomationComments.length - 1];
    const actor = resolveCommentActor(latestPrivAuto);
    primaryBadge = {
      Kind: "comment",
      Actor: actor,
      Label: `自動指摘済: ${actor}`,
    };
  }

  return {
    Intervened:
      humanReviews.length > 0 ||
      manualComments.length > 0 ||
      thirdPartyAssignees.length > 0 ||
      privilegedAutomationComments.length > 0,
    ThirdPartyAssignees: thirdPartyAssignees,
    HumanReviewCount: humanReviews.length,
    ManualCommentCount: manualComments.length,
    ...(privilegedAutomationComments.length > 0
      ? { PrivilegedAutomationCommentCount: privilegedAutomationComments.length }
      : {}),
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
      continue;
    }

    // PrimaryBadge 未付与の行へのフォールバック（ThirdPartyAssignees のみ記録時）
    const assignees = row.ThirdPartyAssignees ?? [];
    if (assignees.length > 0) {
      kindCounts.assignee++;
      for (const login of assignees) {
        actorMap.set(login, (actorMap.get(login) ?? 0) + 1);
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

export interface FirstReviewCohortCandidate {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED";
  author?: string;
  authorAssociation?: string;
  authorMergedCount?: number;
  commitCount?: number;
  createdAt: string;
  mergedAt?: string | null;
  intervention: PrInterventionSummary;
}

/**
 * オープン中・直近マージ済みの初回提出者 PR 候補群から、
 * 最初の人間介入日時（FirstHumanInterventionAt）が [now - windowDays, now] に入る PR を抽出し、
 * 起票日時（CreatedAt）の中央値に基づく「主戦場ライン」を集計する。
 */
export function calculateFirstReviewMainstreamFrontier(
  candidates: readonly FirstReviewCohortCandidate[],
  observedAt: Date | string | number,
  options: { windowDays?: number; itemLimit?: number } = {},
): FirstReviewFrontier {
  const windowDays = options.windowDays ?? FIRST_REVIEW_COHORT_WINDOW_DAYS;
  const itemLimit = options.itemLimit ?? FIRST_REVIEW_COHORT_ITEM_LIMIT;
  const observedMs =
    observedAt instanceof Date
      ? observedAt.getTime()
      : typeof observedAt === "number"
        ? observedAt
        : Date.parse(observedAt);

  if (!Number.isFinite(observedMs)) {
    return {
      Mode: FIRST_REVIEW_MAINSTREAM_MODE,
      WindowDays: windowDays,
      CohortCount: 0,
      OpenCount: 0,
      MergedCount: 0,
      MedianCreatedAt: null,
      LagDays: null,
      OldestCreatedAt: null,
      NewestCreatedAt: null,
      Items: [],
    };
  }

  const windowStartMs = observedMs - windowDays * DAY_MS;
  // 同一 PR がオープン探索・マージキャッシュの両方に現れた場合は後続または MERGED 状態を優先して重複排除
  const deduped = new Map<
    number,
    {
      candidate: FirstReviewCohortCandidate;
      createdMs: number;
      interventionMs: number;
    }
  >();

  for (const candidate of candidates) {
    if (!candidate.intervention.FirstHumanInterventionAt) {
      continue;
    }
    const createdMs = Date.parse(candidate.createdAt);
    const interventionMs = Date.parse(candidate.intervention.FirstHumanInterventionAt);
    if (!Number.isFinite(createdMs) || !Number.isFinite(interventionMs)) {
      continue;
    }
    if (interventionMs < windowStartMs || interventionMs > observedMs) {
      continue;
    }
    const existing = deduped.get(candidate.number);
    if (!existing || (existing.candidate.state === "OPEN" && candidate.state === "MERGED")) {
      deduped.set(candidate.number, { candidate, createdMs, interventionMs });
    }
  }

  const entries = [...deduped.values()];
  if (entries.length === 0) {
    return {
      Mode: FIRST_REVIEW_MAINSTREAM_MODE,
      WindowDays: windowDays,
      CohortCount: 0,
      OpenCount: 0,
      MergedCount: 0,
      MedianCreatedAt: null,
      LagDays: null,
      OldestCreatedAt: null,
      NewestCreatedAt: null,
      Items: [],
    };
  }

  const sortedCreatedMs = entries.map((e) => e.createdMs).sort((a, b) => a - b);
  const medianCreatedMs = calculateNumericMedian(sortedCreatedMs);
  const openCount = entries.filter((e) => e.candidate.state === "OPEN").length;
  const mergedCount = entries.filter((e) => e.candidate.state === "MERGED").length;

  const items: FirstReviewCohortItem[] = entries
    .sort((a, b) => b.interventionMs - a.interventionMs || b.candidate.number - a.candidate.number)
    .slice(0, itemLimit)
    .map(({ candidate }) => ({
      Number: candidate.number,
      Title: candidate.title,
      Url: candidate.url,
      State: candidate.state,
      ...(candidate.author !== undefined ? { Author: candidate.author } : {}),
      ...(candidate.authorAssociation !== undefined
        ? { AuthorAssociation: candidate.authorAssociation }
        : {}),
      ...(candidate.authorMergedCount !== undefined
        ? { AuthorMergedCount: candidate.authorMergedCount }
        : {}),
      ...(candidate.commitCount !== undefined ? { CommitCount: candidate.commitCount } : {}),
      CreatedAt: candidate.createdAt,
      FirstHumanInterventionAt: candidate.intervention.FirstHumanInterventionAt as string,
      ...(candidate.intervention.FirstInterventionKind
        ? { InterventionKind: candidate.intervention.FirstInterventionKind }
        : {}),
      ...(candidate.intervention.FirstInterventionActor
        ? { InterventionActor: candidate.intervention.FirstInterventionActor }
        : {}),
      ...(candidate.mergedAt !== undefined ? { MergedAt: candidate.mergedAt } : {}),
    }));

  return {
    Mode: FIRST_REVIEW_MAINSTREAM_MODE,
    WindowDays: windowDays,
    CohortCount: entries.length,
    OpenCount: openCount,
    MergedCount: mergedCount,
    MedianCreatedAt: medianCreatedMs !== null ? new Date(medianCreatedMs).toISOString() : null,
    LagDays: medianCreatedMs !== null ? round1((observedMs - medianCreatedMs) / DAY_MS) : null,
    OldestCreatedAt: new Date(sortedCreatedMs[0]).toISOString(),
    NewestCreatedAt: new Date(sortedCreatedMs[sortedCreatedMs.length - 1]).toISOString(),
    Items: items,
  };
}
