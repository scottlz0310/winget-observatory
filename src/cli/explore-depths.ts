import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient, parseRepository, resolvePrInterventionWithPaging } from "../api/github";
import {
  buildPullRequestBatchInterventionQuery,
  FIRST_TIMER_GRAPHQL_QUERY,
  SEARCH_INTERVENTION_LIGHT_CANDIDATES_QUERY,
  SEARCH_PR_NUMBERS_QUERY,
} from "../api/graphql-queries";
import type { GraphQLPullRequestNode } from "../api/graphql-types";
import {
  buildAbsoluteBaseQuery,
  buildExpressQuery,
  buildHealthyBaseQuery,
  createDepthsSnapshot,
  formatDepthsRow,
  formatGraphQLDepthsRow,
  formatTargetPrInfo,
  isFirstTimerCandidate,
  isFirstTimerDepthsRow,
  isStaleCandidate,
} from "../domain/depths";
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
  summarizeInterventionFrontier,
} from "../domain/intervention";
import { indexSampleCache, parseSampleCache } from "../domain/sample-cache";
import type {
  DepthsRow,
  DepthsSnapshot,
  ExploreDepthsOptions,
  FirstReviewFrontier,
  GraphQLPrNode,
  PrInterventionSummary,
  TargetPrInfo,
} from "../models/depths";
import {
  DEFAULT_REPOSITORY,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultDataDir,
  resolveDefaultTargetPr,
} from "./args";

export { resolveDefaultDataDir };

/** 各待機ライン（健康的大底・1コミット完走組・初回提出者・未レビュー前線）の取得・表示件数 */
export const BOTTOM_LIST_LIMIT = 10;

/** 後方互換エイリアス（BOTTOM_LIST_LIMIT と同値） */
export const STALE_BOTTOM_LIMIT = BOTTOM_LIST_LIMIT;

/** 初回提出者の底を走査する際の 1 ページあたりの取得件数（GraphQL search の上限値） */
export const FIRST_TIMER_PAGE_SIZE = 100;

/** 初回提出者の底を走査する際の探索安全上限（終端に達する前の過剰走査を防止するガード） */
export const FIRST_TIMER_MAX_NODES = 1000;

export interface GraphQLSearchFirstTimerResponse {
  search?: {
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
    nodes?: GraphQLPrNode[];
  };
}

/** 生涯マージ件数チェックの 1 バッチあたり最大作者数 */
const AUTHOR_MERGED_BATCH_SIZE = DEFAULT_AUTHOR_MERGED_BATCH_SIZE;

interface CollectBottomOptions {
  client: GitHubApiClient;
  query: string;
  limit: number;
  maxTraverseNodes: number;
  label: string;
  filterNodes: (
    nodes: GraphQLPrNode[],
    needed: number,
  ) => Promise<GraphQLPrNode[]> | GraphQLPrNode[];
}

/**
 * GraphQL Search をページング走査して、条件に一致する底の候補を limit 件まで収集する共通ヘルパー。
 */
async function collectBottomCandidates({
  client,
  query,
  limit,
  maxTraverseNodes,
  label,
  filterNodes,
}: CollectBottomOptions): Promise<DepthsRow[]> {
  let cursor: string | null = null;
  let hasNext = true;
  let traversedCount = 0;
  const collectedRows: DepthsRow[] = [];

  while (hasNext && collectedRows.length < limit) {
    if (traversedCount >= maxTraverseNodes) {
      throw new Error(
        `${label}の探索上限 (${maxTraverseNodes}件) に達しましたが、未走査の PR が残っています (採用件数: ${collectedRows.length}/${limit}件)。不完全な結果を避けるため中断します。`,
      );
    }

    const fetchCount = Math.min(FIRST_TIMER_PAGE_SIZE, maxTraverseNodes - traversedCount);
    try {
      const gqlRes: GraphQLSearchFirstTimerResponse =
        await client.graphql<GraphQLSearchFirstTimerResponse>(FIRST_TIMER_GRAPHQL_QUERY, {
          query,
          first: fetchCount,
          ...(cursor ? { after: cursor } : {}),
        });

      const nodes = gqlRes.search?.nodes ?? [];
      traversedCount += nodes.length;

      const needed = limit - collectedRows.length;
      const matched = await filterNodes(nodes, needed);
      for (const node of matched) {
        if (collectedRows.length >= limit) break;
        collectedRows.push(formatGraphQLDepthsRow(node));
      }

      hasNext = Boolean(gqlRes.search?.pageInfo?.hasNextPage);
      cursor = gqlRes.search?.pageInfo?.endCursor ?? null;

      if (!cursor || nodes.length === 0) {
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}の GraphQL 取得に失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }

  return collectedRows.slice(0, limit);
}

/** baseQuery から `repo:owner/name` 部分を抽出する */
function extractRepositoryFromQuery(baseQuery: string): string | undefined {
  return baseQuery.match(/\brepo:([^\s]+)/)?.[1];
}

/**
 * `AuthorAssociation === "NONE"` の行について生涯マージ数を照会（キャッシュ共有）し、`AuthorMergedCount` を付与する。
 */
async function attachAuthorMergedCounts(params: {
  client: GitHubApiClient;
  repository: string | undefined;
  rows: DepthsRow[];
  mergedCountCache: Map<string, number>;
  label: string;
}): Promise<DepthsRow[]> {
  const { client, repository, rows, mergedCountCache, label } = params;
  const noneAuthors = rows
    .filter((row) => row.AuthorAssociation === "NONE" && Boolean(row.Author))
    .map((row) => row.Author as string);

  if (noneAuthors.length > 0 && repository) {
    try {
      await resolveAuthorMergedCounts(
        repository,
        noneAuthors,
        (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query, {}),
        { batchSize: AUTHOR_MERGED_BATCH_SIZE, cache: mergedCountCache },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}の GraphQL 取得に失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }

  return rows.map((row) => {
    if (row.AuthorAssociation === "NONE" && row.Author && mergedCountCache.has(row.Author)) {
      return { ...row, AuthorMergedCount: mergedCountCache.get(row.Author) };
    }
    return row;
  });
}

export interface BottomPairResult {
  all: DepthsRow[];
  firstTimer: DepthsRow[];
  allTruncated: boolean;
  firstTimerTruncated: boolean;
}

/**
 * 1 回の GraphQL Search ページング走査で、条件に一致する「全体 TOP limit 件」と
 * 「初回提出者（NONE・生涯マージ 0 回）TOP limit 件」を同時収集し、両方に AuthorMergedCount を付与する。
 * 走査上限（maxTraverseNodes）到達時は観測全体を中断せず、確定済みの行と打ち切りフラグを返す。
 */
async function collectBottomPairCandidates(params: {
  client: GitHubApiClient;
  query: string;
  repository: string | undefined;
  limit: number;
  maxTraverseNodes: number;
  label: string;
  mergedCountCache: Map<string, number>;
  filterNode?: (node: GraphQLPrNode) => boolean;
}): Promise<BottomPairResult> {
  const {
    client,
    query,
    repository,
    limit,
    maxTraverseNodes,
    label,
    mergedCountCache,
    filterNode,
  } = params;
  let cursor: string | null = null;
  let hasNext = true;
  let traversedCount = 0;
  let reachedNaturalEnd = false;
  const allRows: DepthsRow[] = [];
  const firstTimerRows: DepthsRow[] = [];

  while (
    hasNext &&
    traversedCount < maxTraverseNodes &&
    (allRows.length < limit || firstTimerRows.length < limit)
  ) {
    const fetchCount = Math.min(FIRST_TIMER_PAGE_SIZE, maxTraverseNodes - traversedCount);
    try {
      const gqlRes: GraphQLSearchFirstTimerResponse =
        await client.graphql<GraphQLSearchFirstTimerResponse>(FIRST_TIMER_GRAPHQL_QUERY, {
          query,
          first: fetchCount,
          ...(cursor ? { after: cursor } : {}),
        });

      const rawNodes = gqlRes.search?.nodes ?? [];
      traversedCount += rawNodes.length;
      const matchedNodes = filterNode ? rawNodes.filter(filterNode) : rawNodes;

      // 全体枠に入る行と、初回提出者枠の候補行をまとめて AuthorMergedCount 解決する
      const needAll = Math.max(0, limit - allRows.length);
      const allSliceNodes = matchedNodes.slice(0, needAll);
      const allSliceRows = await attachAuthorMergedCounts({
        client,
        repository,
        rows: allSliceNodes.map((n) => formatGraphQLDepthsRow(n)),
        mergedCountCache,
        label,
      });

      const resolvedByNumber = new Map<number, DepthsRow>();
      for (const row of allSliceRows) {
        resolvedByNumber.set(row.Number, row);
        if (allRows.length < limit) {
          allRows.push(row);
        }
        if (firstTimerRows.length < limit && isFirstTimerDepthsRow(row)) {
          firstTimerRows.push(row);
        }
      }

      if (firstTimerRows.length < limit) {
        const remainingFirstTimerCandidates = matchedNodes
          .slice(allSliceNodes.length)
          .filter(isFirstTimerCandidate);

        for (
          let i = 0;
          i < remainingFirstTimerCandidates.length && firstTimerRows.length < limit;
          i += AUTHOR_MERGED_BATCH_SIZE
        ) {
          const slice = remainingFirstTimerCandidates.slice(i, i + AUTHOR_MERGED_BATCH_SIZE);
          const enrichedSlice = await attachAuthorMergedCounts({
            client,
            repository,
            rows: slice.map((n) => formatGraphQLDepthsRow(n)),
            mergedCountCache,
            label,
          });
          for (const row of enrichedSlice) {
            if (resolvedByNumber.has(row.Number)) continue;
            if (isFirstTimerDepthsRow(row)) {
              firstTimerRows.push(row);
              if (firstTimerRows.length >= limit) break;
            }
          }
        }
      }

      hasNext = Boolean(gqlRes.search?.pageInfo?.hasNextPage);
      cursor = gqlRes.search?.pageInfo?.endCursor ?? null;

      if (!hasNext || !cursor || rawNodes.length === 0) {
        reachedNaturalEnd = true;
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith(`${label}の GraphQL 取得に失敗しました:`)) {
        throw err;
      }
      throw new Error(`${label}の GraphQL 取得に失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }

  return {
    all: allRows.slice(0, limit),
    firstTimer: firstTimerRows.slice(0, limit),
    allTruncated: !reachedNaturalEnd && allRows.length < limit,
    firstTimerTruncated: !reachedNaturalEnd && firstTimerRows.length < limit,
  };
}

/**
 * GraphQL API を用いてマージ正常底（健康的大底: 起票日時古い順 TOP 10）と
 * 初回提出者の底（手直し込み・生涯マージ 0 回 TOP 10）を 1 回の走査で同時取得する。
 */
export async function fetchHealthyBottoms(
  client: GitHubApiClient,
  baseQuery: string,
  limit = BOTTOM_LIST_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  mergedCountCache = new Map<string, number>(),
): Promise<{
  healthyBottom: DepthsRow[];
  firstTimerBottom: DepthsRow[];
  firstTimerBottomTruncated: boolean;
}> {
  const repository = extractRepositoryFromQuery(baseQuery);
  const { all, firstTimer, firstTimerTruncated } = await collectBottomPairCandidates({
    client,
    query: `${baseQuery} sort:created-asc`,
    repository,
    limit,
    maxTraverseNodes,
    label: "健康的大底・初回提出者の底",
    mergedCountCache,
  });
  return {
    healthyBottom: all,
    firstTimerBottom: firstTimer,
    firstTimerBottomTruncated: firstTimerTruncated,
  };
}

/**
 * GraphQL API を用いてマージ前線（1コミット完走組: 起票日時古い順 TOP 10）の
 * 全体および初回提出者限定リストを 1 回の走査で同時取得する。
 */
export async function fetchSingleCommitBottoms(
  client: GitHubApiClient,
  baseQuery: string,
  limit = BOTTOM_LIST_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  mergedCountCache = new Map<string, number>(),
): Promise<{
  singleCommitBottom: DepthsRow[];
  firstTimerSingleCommitBottom: DepthsRow[];
  singleCommitTruncated: boolean;
  firstTimerSingleCommitTruncated: boolean;
}> {
  const repository = extractRepositoryFromQuery(baseQuery);
  const { all, firstTimer, allTruncated, firstTimerTruncated } = await collectBottomPairCandidates({
    client,
    query: `${baseQuery} sort:created-asc`,
    repository,
    limit,
    maxTraverseNodes,
    label: "マージ前線（1コミット完走組）",
    mergedCountCache,
    filterNode: isStaleCandidate,
  });
  return {
    singleCommitBottom: all,
    firstTimerSingleCommitBottom: firstTimer,
    singleCommitTruncated: allTruncated,
    firstTimerSingleCommitTruncated: firstTimerTruncated,
  };
}

/**
 * GraphQL API を用いて更新停止最古（Stale Bottom: 1コミット限定・更新日時古い順）を取得する。
 * `authorAssociation === "NONE"` の行については生涯マージ数を照会し、`AuthorMergedCount` に記録する。
 */
export async function fetchStaleBottom(
  client: GitHubApiClient,
  baseQuery: string,
  limit = STALE_BOTTOM_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  mergedCountCache = new Map<string, number>(),
): Promise<DepthsRow[]> {
  const repository = extractRepositoryFromQuery(baseQuery);
  const rows = await collectBottomCandidates({
    client,
    query: `${baseQuery} sort:updated-asc`,
    limit,
    maxTraverseNodes,
    label: "優等生の底",
    filterNodes: (nodes) => nodes.filter(isStaleCandidate),
  });
  return attachAuthorMergedCounts({
    client,
    repository,
    rows: rows.slice(0, limit),
    mergedCountCache,
    label: "優等生の底",
  });
}

/**
 * GraphQL API を用いて初回提出者の底（First-Timer Bottom: 起票日時古い順・手直し込み・生涯マージ0回）を取得する。
 * 採用件数（limit）に達するか走査終了（hasNextPage=false）まで最大 maxTraverseNodes 件までページング走査する。
 * 通信障害や認証エラー時は例外を握りつぶさずコンテキスト付き例外として伝播させる。
 */
export async function fetchFirstTimerBottom(
  client: GitHubApiClient,
  baseQuery: string,
  limit = STALE_BOTTOM_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  mergedCountCache = new Map<string, number>(),
): Promise<DepthsRow[]> {
  const repository = extractRepositoryFromQuery(baseQuery);

  const rows = await collectBottomCandidates({
    client,
    query: `${baseQuery} sort:created-asc`,
    limit,
    maxTraverseNodes,
    label: "初回提出者の底",
    filterNodes: async (nodes, needed) => {
      const candidates = nodes.filter(isFirstTimerCandidate);
      const zeroMergedNodes: GraphQLPrNode[] = [];

      for (
        let i = 0;
        i < candidates.length && zeroMergedNodes.length < needed;
        i += AUTHOR_MERGED_BATCH_SIZE
      ) {
        const slice = candidates.slice(i, i + AUTHOR_MERGED_BATCH_SIZE);
        const authors = slice
          .map((n) => n.author?.login)
          .filter((login): login is string => Boolean(login));

        await resolveAuthorMergedCounts(
          repository ?? "",
          authors,
          (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query, {}),
          { batchSize: AUTHOR_MERGED_BATCH_SIZE, cache: mergedCountCache },
        );

        for (const node of slice) {
          const login = node.author?.login;
          if (!login) continue;
          if ((mergedCountCache.get(login) ?? 0) === 0) {
            zeroMergedNodes.push(node);
            if (zeroMergedNodes.length >= needed) break;
          }
        }
      }

      return zeroMergedNodes;
    },
  });

  return rows.slice(0, limit);
}

/** 介入判定バッチ 1 リクエストあたりの PR 取得件数 */
export const INTERVENTION_BATCH_SIZE = 15;

export interface InterventionFrontiersResult {
  unreviewedBottom: DepthsRow[];
  firstTimerUnreviewedBottom: DepthsRow[];
  intervenedBottom: DepthsRow[];
  unreviewedTruncated: boolean;
  firstTimerUnreviewedTruncated: boolean;
  intervenedTruncated: boolean;
}

interface GraphQLSearchNumbersResponse {
  search?: {
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
    nodes?: Array<{ number?: number | null } | null>;
  };
}

/**
 * PR 番号チャンクに対して GraphQL alias バッチを実行し、取得できた PR ノード一覧をチャンク順で返す。
 */
async function fetchInterventionBatchNodes(params: {
  client: GitHubApiClient;
  owner: string;
  name: string;
  chunk: readonly number[];
}): Promise<Array<GraphQLPullRequestNode & GraphQLPrNode>> {
  const { client, owner, name, chunk } = params;
  if (chunk.length === 0) return [];
  const batchQuery = buildPullRequestBatchInterventionQuery(chunk);
  const batchRes = await client.graphql<{
    repository?: Record<string, (GraphQLPullRequestNode & GraphQLPrNode) | null> | null;
  }>(batchQuery, { owner, name });
  const repoNodes = batchRes.repository ?? {};
  const nodes: Array<GraphQLPullRequestNode & GraphQLPrNode> = [];
  for (let idx = 0; idx < chunk.length; idx++) {
    const prNode = repoNodes[`pr${idx}`];
    if (prNode?.number) {
      nodes.push(prNode);
    }
  }
  return nodes;
}

/**
 * 2 段階パイプライン（第1段階: 軽量 Search で PR 番号収集 → 第2段階: GraphQL alias バッチで詳細エッジ判定）により、
 * 健康な待機 PR（sort:created-asc）を「未レビュー（完全未着手）前線」と「レビュー・介入済み前線」に分離して各上位 limit 件を抽出する。
 * 両区分が limit 件に到達した時点で後続バッチ・後続 Search ページの取得を即打ち切る。
 * 走査上限到達により未走査 PR を残したまま打ち切られた区分は *Truncated=true として記録する。
 */
export async function fetchInterventionFrontiers(
  client: GitHubApiClient,
  baseQuery: string,
  limit = STALE_BOTTOM_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  batchSize = INTERVENTION_BATCH_SIZE,
  mergedCountCache = new Map<string, number>(),
): Promise<InterventionFrontiersResult> {
  const repository = extractRepositoryFromQuery(baseQuery) ?? DEFAULT_REPOSITORY;
  const { owner, name } = parseRepository(repository);
  let cursor: string | null = null;
  let hasNext = true;
  let traversedCount = 0;
  let reachedNaturalEnd = false;
  const unreviewedBottom: DepthsRow[] = [];
  const firstTimerUnreviewedBottom: DepthsRow[] = [];
  const intervenedBottom: DepthsRow[] = [];
  const query = `${baseQuery} sort:created-asc`;
  const graphqlInvoker = <T = unknown>(q: string, vars?: Record<string, unknown>) =>
    client.graphql<T>(q, vars);

  const isDone = (): boolean =>
    unreviewedBottom.length >= limit &&
    firstTimerUnreviewedBottom.length >= limit &&
    intervenedBottom.length >= limit;

  while (hasNext && traversedCount < maxTraverseNodes && !isDone()) {
    const fetchCount = Math.min(FIRST_TIMER_PAGE_SIZE, maxTraverseNodes - traversedCount);
    try {
      const searchRes: GraphQLSearchNumbersResponse =
        await client.graphql<GraphQLSearchNumbersResponse>(SEARCH_PR_NUMBERS_QUERY, {
          query,
          first: fetchCount,
          ...(cursor ? { after: cursor } : {}),
        });

      const rawNodes = searchRes.search?.nodes ?? [];
      traversedCount += rawNodes.length;
      const numbers = rawNodes
        .map((n) => n?.number)
        .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);

      for (let i = 0; i < numbers.length; i += batchSize) {
        if (isDone()) {
          break;
        }
        const chunk = numbers.slice(i, i + batchSize);
        const batchNodes = await fetchInterventionBatchNodes({ client, owner, name, chunk });
        const batchUnreviewed: DepthsRow[] = [];
        for (const prNode of batchNodes) {
          const { node: resolvedNode, summary } = await resolvePrInterventionWithPaging(
            graphqlInvoker,
            owner,
            name,
            prNode,
          );
          const row = formatGraphQLDepthsRow(resolvedNode, summary);

          if (!summary.Intervened) {
            batchUnreviewed.push(row);
          } else if (intervenedBottom.length < limit) {
            intervenedBottom.push(row);
          }
        }

        if (batchUnreviewed.length > 0) {
          const enrichedUnreviewed = await attachAuthorMergedCounts({
            client,
            repository,
            rows: batchUnreviewed,
            mergedCountCache,
            label: "未レビュー前線・介入済み前線",
          });
          for (const row of enrichedUnreviewed) {
            if (unreviewedBottom.length < limit) {
              unreviewedBottom.push(row);
            }
            if (firstTimerUnreviewedBottom.length < limit && isFirstTimerDepthsRow(row)) {
              firstTimerUnreviewedBottom.push(row);
            }
          }
        }

        if (isDone()) {
          break;
        }
      }

      hasNext = Boolean(searchRes.search?.pageInfo?.hasNextPage);
      cursor = searchRes.search?.pageInfo?.endCursor ?? null;

      if (!hasNext || !cursor || rawNodes.length === 0) {
        reachedNaturalEnd = true;
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("未レビュー前線・介入済み前線の GraphQL 取得に失敗しました:")) {
        throw err;
      }
      throw new Error(`未レビュー前線・介入済み前線の GraphQL 取得に失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }

  return {
    unreviewedBottom: unreviewedBottom.slice(0, limit),
    firstTimerUnreviewedBottom: firstTimerUnreviewedBottom.slice(0, limit),
    intervenedBottom: intervenedBottom.slice(0, limit),
    unreviewedTruncated: !reachedNaturalEnd && unreviewedBottom.length < limit,
    firstTimerUnreviewedTruncated: !reachedNaturalEnd && firstTimerUnreviewedBottom.length < limit,
    intervenedTruncated: !reachedNaturalEnd && intervenedBottom.length < limit,
  };
}

/** 主戦場ライン探索における 1 ページあたりの検索取得件数（軽量メタデータ取得のため上限 100） */
export const MAINSTREAM_SEARCH_PAGE_SIZE = 100;

/** GitHub Search API の 1 窓あたり到達上限（超過時は動的二分走査を行う） */
const MAINSTREAM_SEARCH_WINDOW_CAPACITY = 1000;

/** 動的二分走査の最小時間幅（1 分） */
const MAINSTREAM_MIN_BISECT_SPAN_MS = 60_000;

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

export function parseArgs(argv: string[]): ExploreDepthsOptions {
  let targetPr = resolveDefaultTargetPr();
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let outputPath: string | undefined = process.env.WINGET_DEPTHS_OUTPUT_PATH;
  let historyPath: string | undefined = process.env.WINGET_DEPTHS_HISTORY_PATH;
  let samplesPath: string | undefined = process.env.WINGET_SAMPLES_PATH;
  let noTargetPr = false;
  let noHistory = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target-pr") {
      targetPr = parseTargetPrArg(readOptionValue(argv, i++, "正の整数の値"));
    } else if (arg === "--repository") {
      repository = readOptionValue(argv, i++, "リポジトリ名 (owner/repo) の値");
    } else if (arg === "--output-path") {
      outputPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--history-path") {
      historyPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--samples-path") {
      samplesPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--no-target-pr") {
      noTargetPr = true;
    } else if (arg === "--no-history") {
      noHistory = true;
    } else if (arg === "--as-json") {
      asJson = true;
    } else {
      throw new Error(`未知の引数が指定されました: ${arg}`);
    }
  }

  return {
    targetPr,
    repository,
    outputPath,
    historyPath,
    samplesPath,
    noTargetPr,
    noHistory,
    asJson,
  };
}

function printRowTable(
  rows: DepthsRow[],
  log = console.log,
  options:
    | { showCommitCount?: boolean; showThirdPartyAssignees?: boolean; showIntervention?: boolean }
    | boolean = false,
): void {
  const showCommitCount =
    typeof options === "boolean" ? options : (options.showCommitCount ?? false);
  const showThirdPartyAssignees =
    typeof options === "boolean" ? false : (options.showThirdPartyAssignees ?? false);
  const showIntervention =
    typeof options === "boolean" ? false : (options.showIntervention ?? false);
  if (rows.length === 0) {
    log("  （該当なし）");
    return;
  }
  for (const row of rows) {
    const commitCol = showCommitCount ? ` | ${String(row.CommitCount ?? "-").padStart(2)}c` : "";
    const badgeLabel = showIntervention ? row.Intervention?.PrimaryBadge?.Label : undefined;
    const assigneeCol = badgeLabel
      ? ` | [${badgeLabel}]`
      : (showThirdPartyAssignees || showIntervention) &&
          row.ThirdPartyAssignees &&
          row.ThirdPartyAssignees.length > 0
        ? ` | [${row.ThirdPartyAssignees.join(", ")}]`
        : "";
    log(
      `  ${row.PR.padEnd(8)}${commitCol} | ${row.作成日時} | ${row.更新日時}${assigneeCol} | ${row.タイトル}`,
    );
  }
}

/**
 * キュー境界探索の実行コア関数
 */
export async function runExploreDepths(
  options: ExploreDepthsOptions,
  client = new GitHubApiClient(),
  log = console.log,
): Promise<DepthsSnapshot> {
  const hasTarget = options.targetPr > 0 && !options.noTargetPr;
  let targetInfo: TargetPrInfo | null = null;
  let targetCreatedAtIso: string | null = null;

  if (hasTarget) {
    // 基準 PR 無しのスナップショットを履歴へ追記すると時系列が汚れるため、取得失敗は中断する
    // （基準 PR 無しで実行したい場合は --no-target-pr を明示する）
    const prView = await client.getPullRequest(options.repository, options.targetPr);
    targetInfo = formatTargetPrInfo(prView);
    targetCreatedAtIso = prView.createdAt;

    if (!options.asJson) {
      log("=== winget-pkgs キュー境界探索 ===");
      log(`基準PR : #${targetInfo.Number} (${targetInfo.Title})`);
      log(`作成日 : ${targetInfo.CreatedAtJst}`);
      log("");
    }
  } else if (!options.asJson) {
    log("=== winget-pkgs キュー境界探索 (全体観測モード) ===");
    log(`対象リポジトリ: ${options.repository}`);
    log("");
  }

  const healthyBase = buildHealthyBaseQuery(options.repository);
  const mergedCountCache = new Map<string, number>();

  // 1. マージ正常底（健康的大底 TOP 10）＋ 初回提出者の底（TOP 10）を GraphQL で同時取得
  const { healthyBottom, firstTimerBottom, firstTimerBottomTruncated } = await fetchHealthyBottoms(
    client,
    healthyBase,
    BOTTOM_LIST_LIMIT,
    FIRST_TIMER_MAX_NODES,
    mergedCountCache,
  );

  // 2. 真の大底（Absolute Bottom）
  const absoluteBase = buildAbsoluteBaseQuery(options.repository);
  const absoluteItems = await client.searchIssues(absoluteBase, "created", "asc", 3);
  const absoluteBottom = absoluteItems.map(formatDepthsRow);

  // 3A. マージ前線（1コミット完走組・起票日時古い順 TOP 10: 全体 ＋ 初回提出者のみ）
  const {
    singleCommitBottom,
    firstTimerSingleCommitBottom,
    singleCommitTruncated,
    firstTimerSingleCommitTruncated,
  } = await fetchSingleCommitBottoms(
    client,
    healthyBase,
    BOTTOM_LIST_LIMIT,
    FIRST_TIMER_MAX_NODES,
    mergedCountCache,
  );

  // 3B. 更新停止最古（Stale Bottom: 1コミット限定・更新日時古い順、後方互換・補助参照用）
  const staleBottom = await fetchStaleBottom(
    client,
    healthyBase,
    STALE_BOTTOM_LIMIT,
    FIRST_TIMER_MAX_NODES,
    mergedCountCache,
  );

  // 5. 未レビュー（完全未着手）前線（全体 ＋ 初回提出者のみ）／介入済み前線（起票日時順）
  const {
    unreviewedBottom,
    firstTimerUnreviewedBottom,
    intervenedBottom,
    unreviewedTruncated,
    firstTimerUnreviewedTruncated,
    intervenedTruncated,
  } = await fetchInterventionFrontiers(
    client,
    healthyBase,
    STALE_BOTTOM_LIMIT,
    FIRST_TIMER_MAX_NODES,
    INTERVENTION_BATCH_SIZE,
    mergedCountCache,
  );

  // 6. 特急レーン（Express Lane）
  let expressBottom: DepthsRow[] = [];
  if (hasTarget && targetCreatedAtIso) {
    const expressQuery = buildExpressQuery(options.repository, targetCreatedAtIso);
    const expressItems = await client.searchIssues(expressQuery, "updated", "desc", 5);
    expressBottom = expressItems.map(formatDepthsRow);
  }

  const now = new Date();
  const defaultDataDir = resolveDefaultDataDir();
  const resolvedSamplesPath = options.samplesPath
    ? resolve(process.cwd(), options.samplesPath)
    : options.outputPath
      ? resolve(dirname(resolve(process.cwd(), options.outputPath)), "merged-samples.jsonl")
      : options.historyPath
        ? resolve(dirname(resolve(process.cwd(), options.historyPath)), "merged-samples.jsonl")
        : resolve(defaultDataDir, "merged-samples.jsonl");

  // 5B. 主戦場ライン（直近 7 日間に初めて人間介入が入ったコホート: 初回提出者限定 ＋ 常連含む全体）
  const { firstReviewFrontier, allAuthorsFirstReviewFrontier } = await fetchFirstReviewFrontiers({
    client,
    repository: options.repository,
    now,
    mergedCountCache,
    samplesPath: resolvedSamplesPath,
  });

  const unreviewedSummary = summarizeInterventionFrontier(unreviewedBottom, now);
  const intervenedSummary = summarizeInterventionFrontier(intervenedBottom, now);

  if (!options.asJson) {
    log("【1. 健康的な大底 (Healthy Bottom)】");
    log("説明: CI通過・エラーなしの健康体で、現在最も古いオープンPR (FIFOの正当な先頭)");
    printRowTable(healthyBottom, log);
    log("");

    log("【2. 真の大底 (Absolute Bottom)】");
    log("説明: 状態やエラーを問わず、未クローズの New-Package で最も古いPR");
    printRowTable(absoluteBottom, log);
    log("");

    log("【3. 優等生の底 (Stale Bottom / Healthy Oldest)】");
    log(
      "説明: 指摘なく健康な1コミット限定PR（常連含む）の中で、更新日時(updated)が最も古い放置前線",
    );
    printRowTable(staleBottom, log, { showThirdPartyAssignees: true });
    log("");

    log("【4. 初回提出者の底 (First-Timer Bottom)】");
    log(
      "説明: 初回提出者（authorAssociation = NONE・生涯マージ 0 回）の健康なPR全体（手直し込み）の、起票日時(created)が最も古い先頭",
    );
    printRowTable(firstTimerBottom, log, { showCommitCount: true, showThirdPartyAssignees: true });
    log("");

    log("【5A. 未レビュー（完全未着手）前線 (Unreviewed Frontier)】");
    const unreviewedTruncatedNote = unreviewedTruncated ? " [※走査上限到達のため一部未完了]" : "";
    log(
      `説明: 人間レビュー・手動コメント・第三者 Assignees・Collaborator 以上の自動指摘がいずれも無い健康なPR（作成者本人・一般ボット除く）の起票順先頭 (上位 ${unreviewedSummary.count} 件 / 先頭: ${unreviewedSummary.head ? `${unreviewedSummary.head.PR} 起票 ${unreviewedSummary.head.作成日時}・経過 ${unreviewedSummary.headElapsedDays ?? "-"} 日` : unreviewedTruncated ? "走査上限到達・未確定" : "該当なし"})${unreviewedTruncatedNote}`,
    );
    if (unreviewedBottom.length === 0 && unreviewedTruncated) {
      log("  走査上限に到達し、未走査の PR が残っているため有無は未確定です");
    } else {
      printRowTable(unreviewedBottom, log, { showCommitCount: true });
    }
    log("");

    log("【5B. レビュー・介入済み前線 (Intervened Frontier)】");
    const intervenedTruncatedNote = intervenedTruncated ? " [※走査上限到達のため一部未完了]" : "";
    const kindParts: string[] = [];
    if (intervenedSummary.kindCounts.review > 0) {
      kindParts.push(`レビュー(${intervenedSummary.kindCounts.review})`);
    }
    if (intervenedSummary.kindCounts.comment > 0) {
      kindParts.push(`コメント(${intervenedSummary.kindCounts.comment})`);
    }
    if (intervenedSummary.kindCounts.assignee > 0) {
      kindParts.push(`アサイン(${intervenedSummary.kindCounts.assignee})`);
    }
    const intervenedBreakdown = kindParts.length > 0 ? ` / 内訳: ${kindParts.join(", ")}` : "";
    log(
      `説明: 人間レビュー・手動コメント・第三者 Assignees のいずれかが付いている健康なPRの起票順先頭 (上位 ${intervenedSummary.count} 件 / 先頭: ${intervenedSummary.head ? `${intervenedSummary.head.PR} 起票 ${intervenedSummary.head.作成日時}・経過 ${intervenedSummary.headElapsedDays ?? "-"} 日` : intervenedTruncated ? "走査上限到達・未確定" : "該当なし"}${intervenedBreakdown})${intervenedTruncatedNote}`,
    );
    if (intervenedBottom.length === 0 && intervenedTruncated) {
      log("  走査上限に到達し、未走査の PR が残っているため有無は未確定です");
    } else {
      printRowTable(intervenedBottom, log, { showCommitCount: true, showIntervention: true });
    }
    log("");

    if (hasTarget && targetInfo) {
      log("【6. 特急レーン・追い越し (Express Lane)】");
      log(`説明: あなたのPR作成日(${targetInfo.CreatedAtJst})以降に作成され、すでにマージされたPR`);
      if (expressBottom.length > 0) {
        printRowTable(expressBottom, log);
      } else {
        log("  該当なし（追い越しマージはありません）");
      }
      log("");
    }
    log(`【7. 主戦場ライン（直近 ${firstReviewFrontier.WindowDays} 日初回人間介入コホート）】`);
    log(
      `  対象件数: ${firstReviewFrontier.CohortCount} 件 (Open ${firstReviewFrontier.OpenCount} / Merged ${firstReviewFrontier.MergedCount}) | 起票中央値: ${firstReviewFrontier.MedianCreatedAt ?? "データ不足"} (経過 ${firstReviewFrontier.LagDays ?? "-"} 日)`,
    );
    log("");
  }

  const snapshot = createDepthsSnapshot({
    now,
    repository: options.repository,
    targetPr: targetInfo,
    healthyBottom,
    absoluteBottom,
    singleCommitBottom,
    firstTimerSingleCommitBottom,
    singleCommitTruncated,
    firstTimerSingleCommitTruncated,
    staleBottom,
    firstTimerBottom,
    firstTimerBottomTruncated,
    unreviewedBottom,
    firstTimerUnreviewedBottom,
    intervenedBottom,
    unreviewedTruncated,
    firstTimerUnreviewedTruncated,
    intervenedTruncated,
    firstReviewFrontier,
    allAuthorsFirstReviewFrontier,
    expressLane: expressBottom,
  });

  if (options.asJson) {
    log(JSON.stringify(snapshot, null, 2));
  }

  // 1. JSONL 履歴ファイルへの追記（蓄積）
  if (!options.noHistory) {
    const historyPath = options.historyPath
      ? resolve(process.cwd(), options.historyPath)
      : resolve(defaultDataDir, "depths-history.jsonl");

    const historyDir = dirname(historyPath);
    if (!existsSync(historyDir)) {
      mkdirSync(historyDir, { recursive: true });
    }

    try {
      const line = `${JSON.stringify(snapshot)}\n`;
      appendFileSync(historyPath, line, "utf-8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`キュー境界履歴 (JSONL) の保存に失敗しました (${historyPath}): ${message}`);
    }
  }

  // 2. 最新スナップショット JSON の上書き保存
  const outputPath = options.outputPath
    ? resolve(process.cwd(), options.outputPath)
    : resolve(defaultDataDir, "latest-depths.json");

  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  try {
    writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`最新スナップショット (JSON) の保存に失敗しました (${outputPath}): ${message}`);
  }

  return snapshot;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runExploreDepths(options);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`エラー: ${message}`);
    process.exit(1);
  }
}
