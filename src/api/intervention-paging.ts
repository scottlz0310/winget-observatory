import { classifyPrIntervention } from "../domain/intervention";
import type { PrInterventionInput, PrInterventionSummary } from "../models/depths";
import {
  GET_PULL_REQUEST_COMMENTS_PAGE_QUERY,
  GET_PULL_REQUEST_REVIEWS_PAGE_QUERY,
} from "./graphql-queries";
import type {
  GraphQLCommentConnection,
  GraphQLPullRequestNode,
  GraphQLReviewConnection,
} from "./graphql-types";

export type GraphQLInvoker = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

interface GraphQLReviewsPageResponse {
  repository?: {
    pullRequest?: {
      reviews?: GraphQLReviewConnection | null;
    } | null;
  } | null;
}

interface GraphQLCommentsPageResponse {
  repository?: {
    pullRequest?: {
      comments?: GraphQLCommentConnection | null;
    } | null;
  } | null;
}

/** 介入判定の追加ページングにおける 1 コネクションあたりのデフォルト安全上限（50件/page × 50 = 2,500件） */
export const DEFAULT_MAX_INTERVENTION_EXTRA_PAGES = 50;

interface ConnectionPageResult<TNode> {
  hasNextPage: boolean;
  endCursor: string | null;
  nodes: Array<TNode | null>;
}

async function fetchRemainingInterventionConnection<TNode>(params: {
  label: string;
  prNumber: number;
  maxExtraPages: number;
  initialHasNext: boolean;
  initialCursor: string | null;
  fetchPage: (cursor: string) => Promise<ConnectionPageResult<TNode>>;
  onPageNodes: (nodes: Array<TNode | null>) => boolean;
}): Promise<void> {
  let hasNext = params.initialHasNext;
  let cursor = params.initialCursor;
  let pages = 0;

  while (hasNext) {
    if (!cursor) {
      throw new Error(
        `PR #${params.prNumber} の ${params.label} ページングで hasNextPage=true ですが endCursor が欠落しているため、未介入と確定できません`,
      );
    }
    if (pages >= params.maxExtraPages) {
      throw new Error(
        `PR #${params.prNumber} の ${params.label} が追加ページング上限 (${params.maxExtraPages} ページ) に達したため、未介入と確定できません`,
      );
    }
    pages++;
    const prevCursor = cursor;
    const page = await params.fetchPage(cursor);
    if (params.onPageNodes(page.nodes)) {
      return;
    }
    hasNext = page.hasNextPage;
    cursor = page.endCursor;
    if (hasNext && cursor === prevCursor) {
      throw new Error(
        `PR #${params.prNumber} の ${params.label} ページングでカーソルが進まないため、未介入と確定できません`,
      );
    }
  }
}

/**
 * 1 回目の PR 取得ノード（reviews/comments 20件）で未介入、または
 * 既知の `FirstHumanInterventionAt` より早い介入が後続ページに残っている可能性がある場合は、
 * 追加ページを取得して介入有無と初回人間介入日時を確定させる。
 * 上限到達やカーソル欠落により走査を完了できない場合は「未介入」や欠落のまま誤確定せず例外をスローする。
 */
export async function resolvePrInterventionWithPaging<TNode extends GraphQLPullRequestNode>(
  graphqlFn: GraphQLInvoker,
  owner: string,
  name: string,
  prNode: TNode,
  maxExtraPages = DEFAULT_MAX_INTERVENTION_EXTRA_PAGES,
): Promise<{ node: TNode; summary: PrInterventionSummary }> {
  let currentSummary = classifyPrIntervention(prNode as PrInterventionInput);
  let reviewNodes = [...(prNode.reviews?.nodes ?? [])];
  let commentNodes = [...(prNode.comments?.nodes ?? [])];

  const recomputeSummary = (): PrInterventionSummary => {
    currentSummary = classifyPrIntervention({
      author: prNode.author,
      assignees: prNode.assignees,
      reviews: reviewNodes,
      comments: commentNodes,
    });
    return currentSummary;
  };

  const canStopPagingAtLastNode = (lastTs: string | null | undefined): boolean => {
    if (!currentSummary.Intervened) return false;
    const firstMs = currentSummary.FirstHumanInterventionAt
      ? Date.parse(currentSummary.FirstHumanInterventionAt)
      : Number.NaN;
    if (!Number.isFinite(firstMs)) {
      // 日時省略モック等で HumanReviewCount > 0 || ManualCommentCount > 0 が判明済みの場合のみ打ち切る
      return currentSummary.HumanReviewCount > 0 || currentSummary.ManualCommentCount > 0;
    }
    const lastMs = lastTs ? Date.parse(lastTs) : Number.NaN;
    // 時系列昇順の末尾ノードがすでに既知の初回介入日時以降であれば、後続ページにより早い介入は存在しない
    return Number.isFinite(lastMs) && lastMs >= firstMs;
  };

  if (
    prNode.number &&
    (!currentSummary.Intervened ||
      !canStopPagingAtLastNode(
        reviewNodes[reviewNodes.length - 1]?.submittedAt ??
          reviewNodes[reviewNodes.length - 1]?.createdAt,
      ))
  ) {
    await fetchRemainingInterventionConnection({
      label: "reviews",
      prNumber: prNode.number,
      maxExtraPages,
      initialHasNext: Boolean(prNode.reviews?.pageInfo?.hasNextPage),
      initialCursor: prNode.reviews?.pageInfo?.endCursor ?? null,
      fetchPage: async (after) => {
        const pageData = await graphqlFn<GraphQLReviewsPageResponse>(
          GET_PULL_REQUEST_REVIEWS_PAGE_QUERY,
          { owner, name, number: prNode.number, after },
        );
        const conn = pageData?.repository?.pullRequest?.reviews;
        return {
          hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
          endCursor: conn?.pageInfo?.endCursor ?? null,
          nodes: Array.isArray(conn?.nodes) ? conn.nodes : [],
        };
      },
      onPageNodes: (nodes) => {
        reviewNodes = [...reviewNodes, ...nodes];
        recomputeSummary();
        const last = nodes[nodes.length - 1];
        return canStopPagingAtLastNode(last?.submittedAt ?? last?.createdAt);
      },
    });
  }

  if (
    prNode.number &&
    (!currentSummary.Intervened ||
      !canStopPagingAtLastNode(commentNodes[commentNodes.length - 1]?.createdAt))
  ) {
    await fetchRemainingInterventionConnection({
      label: "comments",
      prNumber: prNode.number,
      maxExtraPages,
      initialHasNext: Boolean(prNode.comments?.pageInfo?.hasNextPage),
      initialCursor: prNode.comments?.pageInfo?.endCursor ?? null,
      fetchPage: async (after) => {
        const pageData = await graphqlFn<GraphQLCommentsPageResponse>(
          GET_PULL_REQUEST_COMMENTS_PAGE_QUERY,
          { owner, name, number: prNode.number, after },
        );
        const conn = pageData?.repository?.pullRequest?.comments;
        return {
          hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
          endCursor: conn?.pageInfo?.endCursor ?? null,
          nodes: Array.isArray(conn?.nodes) ? conn.nodes : [],
        };
      },
      onPageNodes: (nodes) => {
        commentNodes = [...commentNodes, ...nodes];
        recomputeSummary();
        const last = nodes[nodes.length - 1];
        return canStopPagingAtLastNode(last?.createdAt);
      },
    });
  }

  const mergedNode: TNode = {
    ...prNode,
    ...(prNode.reviews !== undefined ? { reviews: { ...prNode.reviews, nodes: reviewNodes } } : {}),
    ...(prNode.comments !== undefined
      ? { comments: { ...prNode.comments, nodes: commentNodes } }
      : {}),
  };

  return { node: mergedNode, summary: currentSummary };
}
