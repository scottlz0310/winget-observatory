import {
  type GitHubApiClient,
  parseRepository,
  resolvePrInterventionWithPaging,
} from "../api/github";
import {
  buildPullRequestBatchInterventionQuery,
  SEARCH_PR_NUMBERS_QUERY,
} from "../api/graphql-queries";
import type { GraphQLPullRequestNode } from "../api/graphql-types";
import { formatGraphQLDepthsRow, isFirstTimerDepthsRow } from "../domain/depths";
import type { DepthsRow, GraphQLPrNode } from "../models/depths";
import { DEFAULT_REPOSITORY } from "./args";
import {
  attachAuthorMergedCounts,
  BOTTOM_LIST_LIMIT,
  extractRepositoryFromQuery,
  FIRST_TIMER_MAX_NODES,
  FIRST_TIMER_PAGE_SIZE,
} from "./depths-bottom-collector";

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
export async function fetchInterventionBatchNodes(params: {
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
  limit = BOTTOM_LIST_LIMIT,
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
