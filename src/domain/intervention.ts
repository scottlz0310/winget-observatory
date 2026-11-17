import type {
  DepthsRow,
  PrInterventionActor,
  PrInterventionBadge,
  PrInterventionCommentInput,
  PrInterventionInput,
  PrInterventionReviewInput,
  PrInterventionSummary,
} from "../models/depths";
import { DAY_MS, round1 } from "./formatters";

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
 * PR の reviews / comments / assignees を統合評価し、
 * 「未レビュー（完全未着手）」と「レビュー・介入済み」の判定結果および代表バッジを生成する。
 */
export function classifyPrIntervention(input: PrInterventionInput): PrInterventionSummary {
  const prAuthorLogin = input.author?.login ?? null;
  const thirdPartyAssignees = extractThirdPartyAssignees(input.assignees, prAuthorLogin);

  const reviews = unwrapNodes<PrInterventionReviewInput>(input.reviews);
  const humanReviews = reviews.filter(
    (r) => !isBotActor(r.author) && !isSameActorLogin(r.author?.login, prAuthorLogin),
  );

  const comments = unwrapNodes<PrInterventionCommentInput>(input.comments);
  const manualComments = comments.filter(
    (c) =>
      !isBotActor(c.author) &&
      !isSameActorLogin(c.author?.login, prAuthorLogin) &&
      !isDeterministicAutomationComment(c.body),
  );

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
    const actor = latestComment.author?.login?.trim() || DELETED_ACTOR_LABEL;
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
  }

  return {
    Intervened:
      humanReviews.length > 0 || manualComments.length > 0 || thirdPartyAssignees.length > 0,
    ThirdPartyAssignees: thirdPartyAssignees,
    HumanReviewCount: humanReviews.length,
    ManualCommentCount: manualComments.length,
    ...(primaryBadge ? { PrimaryBadge: primaryBadge } : {}),
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
