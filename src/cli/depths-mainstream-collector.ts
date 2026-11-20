import { existsSync, readFileSync } from "node:fs";
import {
  type GitHubApiClient,
  parseRepository,
  resolvePrInterventionWithPaging,
} from "../api/github";
import { SEARCH_INTERVENTION_LIGHT_CANDIDATES_QUERY } from "../api/graphql-queries";
import type { GraphQLPullRequestNode } from "../api/graphql-types";
import { isFirstTimerCandidate } from "../domain/depths";
import {
  DEFAULT_AUTHOR_MERGED_BATCH_SIZE,
  hasValidatedReadyVersion,
  isPrivilegedOrBotAuthor,
  resolveAuthorMergedCounts,
} from "../domain/first-timer";
import { DAY_MS } from "../domain/formatters";
import {
  calculateFirstReviewMainstreamFrontier,
  FIRST_REVIEW_COHORT_WINDOW_DAYS,
  type FirstReviewCohortCandidate,
} from "../domain/intervention";
import { indexSampleCache, parseSampleCache } from "../domain/sample-cache";
import type { FirstReviewFrontier, GraphQLPrNode, PrInterventionSummary } from "../models/depths";
import {
  fetchInterventionBatchNodes,
  INTERVENTION_BATCH_SIZE,
} from "./depths-intervention-collector";

/** 主戦場ライン探索における 1 ページあたりの検索取得件数（軽量メタデータ取得のため上限 100） */
export const MAINSTREAM_SEARCH_PAGE_SIZE = 100;

/** GitHub Search API の 1 窓あたり到達上限（超過時は動的二分走査を行う） */
const MAINSTREAM_SEARCH_WINDOW_CAPACITY = 1000;

/** 動的二分走査の最小時間幅（1 分） */
const MAINSTREAM_MIN_BISECT_SPAN_MS = 60_000;

/** 生涯マージ件数チェックの 1 バッチあたり最大作者数 */
const AUTHOR_MERGED_BATCH_SIZE = DEFAULT_AUTHOR_MERGED_BATCH_SIZE;

interface LightInterventionCandidateNode {
  number: number;
  author?: { login?: string | null } | null;
  authorAssociation?: string | null;
}

interface SearchInterventionLightNodesResponse {
  search?: {
    issueCount?: number;
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
    nodes?: Array<{
      number?: number | null;
      author?: { login?: string | null } | null;
      authorAssociation?: string | null;
    } | null>;
  };
}

/**
 * GitHub Search API の 1,000 件上限を回避しつつ、指定期間内の PR の軽量メタデータ（number, author, authorAssociation）を
 * 重複なく全量走査して取得する。コメント本文やレビューのネスト取得は後段の alias バッチに分離して Search 負荷を抑える。
 */
async function collectInterventionLightNodes(
  client: GitHubApiClient,
  baseFilterQuery: string,
  dateQualifier: "updated" | "merged",
  sinceDate: Date,
  untilDate: Date,
): Promise<LightInterventionCandidateNode[]> {
  if (sinceDate.getTime() >= untilDate.getTime()) {
    return [];
  }

  const results: LightInterventionCandidateNode[] = [];
  const seen = new Set<number>();
  const stack: Array<{ since: Date; until: Date }> = [{ since: sinceDate, until: untilDate }];

  while (stack.length > 0) {
    const slice = stack.pop();
    if (!slice || slice.since.getTime() >= slice.until.getTime()) continue;

    const query = `${baseFilterQuery} ${dateQualifier}:${slice.since.toISOString()}..${slice.until.toISOString()} sort:updated-desc`;
    const firstRes = await client.graphql<SearchInterventionLightNodesResponse>(
      SEARCH_INTERVENTION_LIGHT_CANDIDATES_QUERY,
      {
        query,
        first: MAINSTREAM_SEARCH_PAGE_SIZE,
      },
    );

    const conn = firstRes.search;
    const totalCount = conn?.issueCount;
    const spanMs = slice.until.getTime() - slice.since.getTime();
    if (
      typeof totalCount === "number" &&
      totalCount > MAINSTREAM_SEARCH_WINDOW_CAPACITY &&
      spanMs > MAINSTREAM_MIN_BISECT_SPAN_MS
    ) {
      const mid = new Date(Math.floor((slice.since.getTime() + slice.until.getTime()) / 2));
      stack.push({ since: slice.since, until: mid });
      stack.push({ since: mid, until: slice.until });
      continue;
    }

    const pushNodes = (
      nodes: NonNullable<SearchInterventionLightNodesResponse["search"]>["nodes"],
    ) => {
      for (const n of nodes ?? []) {
        if (typeof n?.number !== "number" || !Number.isInteger(n.number) || n.number <= 0) continue;
        if (seen.has(n.number)) continue;
        seen.add(n.number);
        results.push({
          number: n.number,
          author: n.author,
          authorAssociation: n.authorAssociation,
        });
      }
    };

    pushNodes(conn?.nodes);

    let hasNext = Boolean(conn?.pageInfo?.hasNextPage);
    let cursor = conn?.pageInfo?.endCursor ?? null;
    while (hasNext && cursor) {
      const nextRes = await client.graphql<SearchInterventionLightNodesResponse>(
        SEARCH_INTERVENTION_LIGHT_CANDIDATES_QUERY,
        {
          query,
          first: MAINSTREAM_SEARCH_PAGE_SIZE,
          after: cursor,
        },
      );
      const nextConn = nextRes.search;
      pushNodes(nextConn?.nodes);
      hasNext = Boolean(nextConn?.pageInfo?.hasNextPage);
      cursor = nextConn?.pageInfo?.endCursor ?? null;
      if (!nextConn?.nodes || nextConn.nodes.length === 0) break;
    }
  }

  return results;
}

function isTimestampWithinWindow(
  iso: string | null | undefined,
  windowStartMs: number,
  nowMs: number,
): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= windowStartMs && ms <= nowMs;
}

function toFirstReviewCohortCandidate(
  node: GraphQLPullRequestNode & GraphQLPrNode,
  summary: PrInterventionSummary,
  state: "OPEN" | "MERGED",
  authorMergedCount?: number,
): FirstReviewCohortCandidate {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state,
    author: node.author?.login,
    ...(node.authorAssociation ? { authorAssociation: node.authorAssociation } : {}),
    ...(authorMergedCount !== undefined ? { authorMergedCount } : {}),
    commitCount: node.commits?.totalCount,
    createdAt: node.createdAt,
    ...(state === "MERGED" ? { mergedAt: node.mergedAt ?? null } : {}),
    intervention: summary,
  };
}

async function resolveMainstreamInterventionsByNumbers(params: {
  client: GitHubApiClient;
  owner: string;
  name: string;
  numbers: readonly number[];
  batchSize: number;
}): Promise<
  Array<{ node: GraphQLPullRequestNode & GraphQLPrNode; summary: PrInterventionSummary }>
> {
  const { client, owner, name, numbers, batchSize } = params;
  const graphqlInvoker = <T = unknown>(q: string, vars?: Record<string, unknown>) =>
    client.graphql<T>(q, vars);
  const resolved: Array<{
    node: GraphQLPullRequestNode & GraphQLPrNode;
    summary: PrInterventionSummary;
  }> = [];

  for (let i = 0; i < numbers.length; i += batchSize) {
    const chunk = numbers.slice(i, i + batchSize);
    const batchNodes = await fetchInterventionBatchNodes({ client, owner, name, chunk });
    for (const prNode of batchNodes) {
      resolved.push(await resolvePrInterventionWithPaging(graphqlInvoker, owner, name, prNode));
    }
  }

  return resolved;
}

export interface FirstReviewFrontiersResult {
  /** 初回提出者限定コホートの主戦場ライン集計（既存 FirstReviewFrontier 互換） */
  firstReviewFrontier: FirstReviewFrontier;
  /** 常連含む全体コホートの主戦場ライン集計（2×2 全体トグル用） */
  allAuthorsFirstReviewFrontier: FirstReviewFrontier;
}

/**
 * 直近 7 日間（[now - 7d, now]）に初めて人間介入が入った New-Package PR（オープン中 ＋ 直近マージ済み）を収集し、
 * 「初回提出者限定コホート」と「常連含む全体コホート」の主戦場ライン（起票日時の中央値）を同時算出する。
 */
export async function fetchFirstReviewFrontiers(params: {
  client: GitHubApiClient;
  repository: string;
  now: Date;
  mergedCountCache?: Map<string, number>;
  samplesPath?: string;
  windowDays?: number;
  batchSize?: number;
  includeAllAuthors?: boolean;
}): Promise<FirstReviewFrontiersResult> {
  const {
    client,
    repository,
    now,
    mergedCountCache = new Map<string, number>(),
    samplesPath,
    windowDays = FIRST_REVIEW_COHORT_WINDOW_DAYS,
    batchSize = INTERVENTION_BATCH_SIZE,
    includeAllAuthors = true,
  } = params;
  const { owner, name } = parseRepository(repository);
  const nowMs = now.getTime();
  const windowStartMs = nowMs - windowDays * DAY_MS;
  const windowStart = new Date(windowStartMs);

  const firstTimerCandidates: FirstReviewCohortCandidate[] = [];
  const allAuthorsCandidates: FirstReviewCohortCandidate[] = [];

  try {
    // 1. オープン中 PR: 軽量 Search で候補を抽出し、バッチで介入詳細を取得
    const openLightNodes = await collectInterventionLightNodes(
      client,
      `repo:${repository} is:pr is:open label:New-Package`,
      "updated",
      windowStart,
      now,
    );
    const openCandidateNumbers = openLightNodes
      .filter((node) => {
        if (!node.author?.login) return false;
        if (includeAllAuthors) {
          return !node.author.login.trim().toLowerCase().endsWith("[bot]");
        }
        return isFirstTimerCandidate(node as GraphQLPrNode);
      })
      .map((node) => node.number);

    const resolvedOpenNodes = await resolveMainstreamInterventionsByNumbers({
      client,
      owner,
      name,
      numbers: openCandidateNumbers,
      batchSize,
    });

    const openIntervenedCandidates = resolvedOpenNodes
      .filter(({ summary }) =>
        isTimestampWithinWindow(summary.FirstHumanInterventionAt, windowStartMs, nowMs),
      )
      .map(({ node, summary }) => toFirstReviewCohortCandidate(node, summary, "OPEN"));

    if (openIntervenedCandidates.length > 0) {
      const openNoneAuthors = openIntervenedCandidates
        .filter((c) => c.authorAssociation === "NONE" && Boolean(c.author))
        .map((c) => c.author as string);
      if (openNoneAuthors.length > 0) {
        await resolveAuthorMergedCounts(
          repository,
          openNoneAuthors,
          (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query, {}),
          { batchSize: AUTHOR_MERGED_BATCH_SIZE, cache: mergedCountCache },
        );
      }
      for (const candidate of openIntervenedCandidates) {
        if (!candidate.author) continue;
        const mergedCount =
          candidate.authorAssociation === "NONE" && mergedCountCache.has(candidate.author)
            ? mergedCountCache.get(candidate.author)
            : undefined;
        const isFt =
          !isPrivilegedOrBotAuthor({
            author: candidate.author,
            authorAssociation: candidate.authorAssociation,
          }) &&
          candidate.authorAssociation === "NONE" &&
          (mergedCount ?? 0) === 0;
        const enriched: FirstReviewCohortCandidate = {
          ...candidate,
          ...(mergedCount !== undefined ? { authorMergedCount: mergedCount } : {}),
          isFirstTimer: isFt,
        };
        allAuthorsCandidates.push(enriched);
        if (isFt) {
          firstTimerCandidates.push(enriched);
        }
      }
    }

    // 2. マージ済み PR: キャッシュ済み初回 PR ＋ 軽量 Search で発見した候補を統合バッチで取得
    const cachedFirstTimerNumbers: number[] = [];
    const cachedFirstTimerSet = new Set<number>();
    const knownNonFirstTimerNumbers = new Set<number>();

    if (samplesPath && existsSync(samplesPath)) {
      const rawCache = readFileSync(samplesPath, "utf-8");
      const indexed = indexSampleCache(parseSampleCache(rawCache));
      for (const entry of indexed.values()) {
        const mergedMs = Date.parse(entry.MergedAt);
        if (!Number.isFinite(mergedMs) || mergedMs < windowStartMs || mergedMs > nowMs) {
          continue;
        }
        if (entry.Type === "sample") {
          if (!hasValidatedReadyVersion(entry.FirstTimerVersion)) {
            continue;
          }
          const privilegedOrBot = isPrivilegedOrBotAuthor({
            author: entry.Author,
            authorType: entry.AuthorType,
            authorAssociation: entry.AuthorAssociation,
          });
          if (privilegedOrBot || entry.IsFirstTimer === false) {
            knownNonFirstTimerNumbers.add(entry.Number);
          } else if (entry.IsFirstTimer === true) {
            cachedFirstTimerNumbers.push(entry.Number);
            cachedFirstTimerSet.add(entry.Number);
          }
        } else if (entry.Reason === "not-first-timer-candidate") {
          knownNonFirstTimerNumbers.add(entry.Number);
        }
      }
    }

    const mergedLightNodes = await collectInterventionLightNodes(
      client,
      `repo:${repository} is:pr is:merged label:New-Package`,
      "merged",
      windowStart,
      now,
    );
    const uncachedMergedNumbers = mergedLightNodes
      .filter((node) => {
        if (!node.author?.login) return false;
        if (cachedFirstTimerSet.has(node.number)) return false;
        if (includeAllAuthors) {
          return !node.author.login.trim().toLowerCase().endsWith("[bot]");
        }
        return !knownNonFirstTimerNumbers.has(node.number);
      })
      .map((node) => node.number);

    const mergedFetchNumbers = [...cachedFirstTimerNumbers, ...uncachedMergedNumbers];
    const resolvedMergedNodes = await resolveMainstreamInterventionsByNumbers({
      client,
      owner,
      name,
      numbers: mergedFetchNumbers,
      batchSize,
    });

    const uncachedMergedForFirstTimer: FirstReviewCohortCandidate[] = [];
    for (const { node, summary } of resolvedMergedNodes) {
      if (!summary.FirstHumanInterventionAt) continue;
      if (cachedFirstTimerSet.has(node.number)) {
        const cachedCount = node.author?.login
          ? mergedCountCache.get(node.author.login)
          : undefined;
        const cand: FirstReviewCohortCandidate = {
          ...toFirstReviewCohortCandidate(node, summary, "MERGED", cachedCount),
          isFirstTimer: true,
        };
        firstTimerCandidates.push(cand);
        allAuthorsCandidates.push(cand);
        continue;
      }
      if (!isTimestampWithinWindow(summary.FirstHumanInterventionAt, windowStartMs, nowMs)) {
        continue;
      }
      const cand = toFirstReviewCohortCandidate(node, summary, "MERGED");
      if (knownNonFirstTimerNumbers.has(node.number)) {
        allAuthorsCandidates.push({ ...cand, isFirstTimer: false });
        continue;
      }
      uncachedMergedForFirstTimer.push(cand);
    }

    if (uncachedMergedForFirstTimer.length > 0) {
      const mergedAuthors = uncachedMergedForFirstTimer
        .map((c) => c.author)
        .filter((login): login is string => Boolean(login));
      await resolveAuthorMergedCounts(
        repository,
        mergedAuthors,
        (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query, {}),
        { batchSize: AUTHOR_MERGED_BATCH_SIZE, cache: mergedCountCache },
      );
      for (const candidate of uncachedMergedForFirstTimer) {
        if (!candidate.author) continue;
        const mergedCount = mergedCountCache.get(candidate.author) ?? 0;
        const privilegedOrBot = isPrivilegedOrBotAuthor({
          author: candidate.author,
          authorAssociation: candidate.authorAssociation,
        });
        // 既にマージ済みの初回 PR なので非特権・非 Bot かつ累計マージ数 1 件以下のみ初回提出者コホートへ算入
        const isFt = !privilegedOrBot && mergedCount <= 1;
        const enriched: FirstReviewCohortCandidate = {
          ...candidate,
          authorMergedCount: mergedCount,
          isFirstTimer: isFt,
        };
        allAuthorsCandidates.push(enriched);
        if (isFt) {
          firstTimerCandidates.push(enriched);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`主戦場ライン（初回介入コホート）の GraphQL 取得に失敗しました: ${msg}`, {
      cause: err,
    });
  }

  return {
    firstReviewFrontier: calculateFirstReviewMainstreamFrontier(firstTimerCandidates, now, {
      windowDays,
    }),
    allAuthorsFirstReviewFrontier: calculateFirstReviewMainstreamFrontier(
      allAuthorsCandidates,
      now,
      { windowDays },
    ),
  };
}

/**
 * 直近 7 日間（[now - 7d, now]）に初めて人間介入が入った初回提出者 PR（オープン中 ＋ 直近マージ済み）を収集し、
 * 主戦場ライン（起票日時の中央値）を算出する（既存互換ラッパー）。
 */
export async function fetchFirstReviewMainstreamFrontier(params: {
  client: GitHubApiClient;
  repository: string;
  now: Date;
  mergedCountCache?: Map<string, number>;
  samplesPath?: string;
  windowDays?: number;
  batchSize?: number;
}): Promise<FirstReviewFrontier> {
  const { firstReviewFrontier } = await fetchFirstReviewFrontiers({
    ...params,
    includeAllAuthors: false,
  });
  return firstReviewFrontier;
}
