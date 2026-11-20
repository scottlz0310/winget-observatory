import type { GitHubApiClient } from "../api/github";
import { FIRST_TIMER_GRAPHQL_QUERY } from "../api/graphql-queries";
import {
  formatGraphQLDepthsRow,
  isFirstTimerCandidate,
  isFirstTimerDepthsRow,
} from "../domain/depths";
import { DEFAULT_AUTHOR_MERGED_BATCH_SIZE, resolveAuthorMergedCounts } from "../domain/first-timer";
import type { DepthsRow, GraphQLPrNode } from "../models/depths";

/** 各待機ライン（健康的大底・初回提出者・未レビュー正常底）の取得・表示件数 */
export const BOTTOM_LIST_LIMIT = 10;

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
export function extractRepositoryFromQuery(baseQuery: string): string | undefined {
  return baseQuery.match(/\brepo:([^\s]+)/)?.[1];
}

/**
 * `AuthorAssociation === "NONE"` の行について生涯マージ数を照会（キャッシュ共有）し、`AuthorMergedCount` を付与する。
 */
export async function attachAuthorMergedCounts(params: {
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
 * GraphQL API を用いて初回提出者の底（First-Timer Bottom: 起票日時古い順・手直し込み・生涯マージ0回）を取得する。
 * 採用件数（limit）に達するか走査終了（hasNextPage=false）まで最大 maxTraverseNodes 件までページング走査する。
 * 通信障害や認証エラー時は例外を握りつぶさずコンテキスト付き例外として伝播させる。
 */
export async function fetchFirstTimerBottom(
  client: GitHubApiClient,
  baseQuery: string,
  limit = BOTTOM_LIST_LIMIT,
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
