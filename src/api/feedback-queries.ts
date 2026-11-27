/**
 * 初回提出 PR の差し戻し指摘収集に特化した GitHub GraphQL クエリ構築・
 * バッチ取得・追加ページング・マニフェスト Blob 取得モジュール。
 * 通信はすべて GraphQLInvoker（GitHubApiClient.graphql）経由で実行する。
 */

import type {
  RawPrActorInput,
  RawPrCommentInput,
  RawPrFeedbackInput,
  RawPrReviewCommentInput,
  RawPrReviewInput,
} from "../domain/review-feedback";
import type { ReviewFeedbackPrState } from "../models/review-feedback";
import type { GraphQLPageInfo } from "./graphql-types";
import type { GraphQLInvoker } from "./intervention-paging";

/** PR 詳細フィードバック取得の既定バッチサイズ（GraphQL 複雑度とセカンダリレート制限抑制のため 15） */
export const DEFAULT_FEEDBACK_BATCH_SIZE = 15;

/** マニフェスト Blob 取得の既定バッチサイズ */
export const DEFAULT_BLOB_BATCH_SIZE = 20;

/** 追加ページングの安全上限（1 コネクションあたり） */
export const DEFAULT_FEEDBACK_MAX_EXTRA_PAGES = 20;

const SHA_HEX_PATTERN = /^[0-9a-f]{40}$/i;

export interface GraphQLFeedbackReviewCommentNode {
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  path?: string | null;
  body?: string | null;
  createdAt?: string | null;
}

export interface GraphQLFeedbackReviewNode {
  id?: string | null;
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  state?: string | null;
  body?: string | null;
  submittedAt?: string | null;
  createdAt?: string | null;
  comments?: {
    pageInfo?: GraphQLPageInfo | null;
    nodes?: Array<GraphQLFeedbackReviewCommentNode | null> | null;
  } | null;
}

export interface GraphQLFeedbackCommentNode {
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  body?: string | null;
  createdAt?: string | null;
  lastEditedAt?: string | null;
  editor?: RawPrActorInput | null;
}

export interface GraphQLFeedbackLabeledEventNode {
  __typename?: string;
  createdAt?: string | null;
  label?: { name?: string | null } | null;
}

export interface GraphQLFeedbackFileNode {
  path?: string | null;
}

export interface GraphQLFeedbackPrNode {
  number?: number;
  title?: string | null;
  url?: string | null;
  state?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  mergeCommit?: { oid?: string | null } | null;
  headRefOid?: string | null;
  author?: RawPrActorInput | null;
  authorAssociation?: string | null;
  commits?: { totalCount?: number | null } | null;
  labels?: { nodes?: Array<{ name?: string | null } | null> | null } | null;
  files?: {
    pageInfo?: GraphQLPageInfo | null;
    nodes?: Array<GraphQLFeedbackFileNode | null> | null;
  } | null;
  reviews?: {
    pageInfo?: GraphQLPageInfo | null;
    nodes?: Array<GraphQLFeedbackReviewNode | null> | null;
  } | null;
  comments?: {
    pageInfo?: GraphQLPageInfo | null;
    nodes?: Array<GraphQLFeedbackCommentNode | null> | null;
  } | null;
  timelineItems?: {
    pageInfo?: GraphQLPageInfo | null;
    nodes?: Array<GraphQLFeedbackLabeledEventNode | null> | null;
  } | null;
}

export interface FetchedFeedbackPrDetail {
  input: RawPrFeedbackInput;
  /** マニフェスト Blob 参照に利用可能な commit OID（mergeCommit 優先、未マージ時は headRefOid） */
  manifestOid: string | null;
}

export const GET_FEEDBACK_REVIEWS_PAGE_QUERY = `
query GetFeedbackReviewsPage($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 50, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          author {
            __typename
            login
          }
          authorAssociation
          state
          body
          submittedAt
          createdAt
          comments(first: 20) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              author {
                __typename
                login
              }
              authorAssociation
              path
              body
              createdAt
            }
          }
        }
      }
    }
  }
}
`;

export const GET_FEEDBACK_REVIEW_COMMENTS_PAGE_QUERY = `
query GetFeedbackReviewCommentsPage($reviewId: ID!, $after: String) {
  node(id: $reviewId) {
    ... on PullRequestReview {
      comments(first: 50, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          authorAssociation
          path
          body
          createdAt
        }
      }
    }
  }
}
`;

export const GET_FEEDBACK_COMMENTS_PAGE_QUERY = `
query GetFeedbackCommentsPage($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 50, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          authorAssociation
          body
          createdAt
          lastEditedAt
          editor {
            __typename
            login
          }
        }
      }
    }
  }
}
`;

export const GET_FEEDBACK_LABELED_EVENTS_PAGE_QUERY = `
query GetFeedbackLabeledEventsPage($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, after: $after, itemTypes: [LABELED_EVENT]) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on LabeledEvent {
            createdAt
            label {
              name
            }
          }
        }
      }
    }
  }
}
`;

export const GET_FEEDBACK_FILES_PAGE_QUERY = `
query GetFeedbackFilesPage($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          path
        }
      }
    }
  }
}
`;

/**
 * 複数 PR のフィードバック解析に必要な全フィールドを 1 リクエストで取得する GraphQL alias クエリを構築する。
 */
export function buildPullRequestFeedbackBatchQuery(numbers: readonly number[]): string {
  if (numbers.length === 0) {
    return "";
  }

  const fields = numbers
    .map((num, idx) => {
      if (!Number.isInteger(num) || num <= 0) {
        throw new Error(`PR 番号が不正です: ${num}`);
      }
      return `
    pr${idx}: pullRequest(number: ${num}) {
      number
      title
      url
      state
      createdAt
      updatedAt
      mergedAt
      closedAt
      mergeCommit {
        oid
      }
      headRefOid
      author {
        __typename
        login
      }
      authorAssociation
      commits {
        totalCount
      }
      labels(first: 50) {
        nodes {
          name
        }
      }
      files(first: 30) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          path
        }
      }
      reviews(first: 20) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          author {
            __typename
            login
          }
          authorAssociation
          state
          body
          submittedAt
          createdAt
          comments(first: 20) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              author {
                __typename
                login
              }
              authorAssociation
              path
              body
              createdAt
            }
          }
        }
      }
      comments(first: 30) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          authorAssociation
          body
          createdAt
          lastEditedAt
          editor {
            __typename
            login
          }
        }
      }
      timelineItems(first: 50, itemTypes: [LABELED_EVENT]) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on LabeledEvent {
            createdAt
            label {
              name
            }
          }
        }
      }
    }`;
    })
    .join("\n");

  return `query GetPullRequestFeedbackBatch($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {${fields}
  }
}`;
}

export interface BlobFetchTarget {
  /** 応答復元用の識別キー（例: `${prNumber}:${path}`） */
  key: string;
  /** 40 桁 SHA-1 コミット OID */
  oid: string;
  /** リポジトリ相対ファイルパス */
  path: string;
}

/**
 * 複数マニフェストファイルの Blob テキストを 1 リクエストで取得する GraphQL alias クエリを構築する。
 */
export function buildInstallerBlobBatchQuery(targets: readonly BlobFetchTarget[]): string {
  if (targets.length === 0) {
    return "";
  }

  const fields = targets
    .map((target, idx) => {
      if (!SHA_HEX_PATTERN.test(target.oid)) {
        throw new Error(`コミット OID の形式が不正です: ${target.oid}`);
      }
      if (!target.path || /[\r\n\0]/.test(target.path)) {
        throw new Error(`ファイルパスの形式が不正です: ${target.path}`);
      }
      const expressionLiteral = JSON.stringify(`${target.oid}:${target.path}`);
      return `    b${idx}: object(expression: ${expressionLiteral}) {\n      ... on Blob {\n        text\n      }\n    }`;
    })
    .join("\n");

  return `query GetInstallerManifestBlobs($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
${fields}
  }
}`;
}

interface PageResult<T> {
  hasNextPage: boolean;
  endCursor: string | null;
  nodes: Array<T | null>;
}

async function fetchRemainingPages<T>(params: {
  label: string;
  prNumber: number;
  maxExtraPages: number;
  initialHasNext: boolean;
  initialCursor: string | null;
  fetchPage: (after: string) => Promise<PageResult<T>>;
}): Promise<T[]> {
  const collected: T[] = [];
  let hasNext = params.initialHasNext;
  let cursor = params.initialCursor;
  let pages = 0;

  while (hasNext) {
    if (!cursor) {
      throw new Error(
        `PR #${params.prNumber} の ${params.label} ページングで hasNextPage=true ですが endCursor が欠落しています`,
      );
    }
    if (pages >= params.maxExtraPages) {
      break;
    }
    pages++;
    const prevCursor = cursor;
    const page = await params.fetchPage(cursor);
    for (const node of page.nodes) {
      if (node !== null && node !== undefined) {
        collected.push(node);
      }
    }
    hasNext = page.hasNextPage;
    cursor = page.endCursor;
    if (hasNext && cursor === prevCursor) {
      throw new Error(
        `PR #${params.prNumber} の ${params.label} ページングでカーソルが進行しませんでした`,
      );
    }
  }

  return collected;
}

function normalizePrState(
  rawState: string | null | undefined,
  mergedAt: string | null | undefined,
): ReviewFeedbackPrState {
  if (mergedAt) {
    return "MERGED";
  }
  const upper = String(rawState ?? "OPEN").toUpperCase();
  if (upper === "MERGED") return "MERGED";
  if (upper === "CLOSED") return "CLOSED";
  return "OPEN";
}

async function resolveCompleteReviewComments(
  graphqlFn: GraphQLInvoker,
  prNumber: number,
  reviewNode: GraphQLFeedbackReviewNode,
  maxExtraPages: number,
): Promise<RawPrReviewCommentInput[]> {
  const initialNodes = (reviewNode.comments?.nodes ?? []).filter(
    (n): n is GraphQLFeedbackReviewCommentNode => n !== null && n !== undefined,
  );

  let allNodes = [...initialNodes];
  if (reviewNode.id && reviewNode.comments?.pageInfo?.hasNextPage) {
    const extra = await fetchRemainingPages<GraphQLFeedbackReviewCommentNode>({
      label: `review(${reviewNode.id}).comments`,
      prNumber,
      maxExtraPages,
      initialHasNext: Boolean(reviewNode.comments.pageInfo.hasNextPage),
      initialCursor: reviewNode.comments.pageInfo.endCursor ?? null,
      fetchPage: async (after) => {
        const res = await graphqlFn<{
          node?: {
            comments?: {
              pageInfo?: GraphQLPageInfo | null;
              nodes?: Array<GraphQLFeedbackReviewCommentNode | null> | null;
            } | null;
          } | null;
        }>(GET_FEEDBACK_REVIEW_COMMENTS_PAGE_QUERY, {
          reviewId: reviewNode.id,
          after,
        });
        const conn = res?.node?.comments;
        return {
          hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
          endCursor: conn?.pageInfo?.endCursor ?? null,
          nodes: Array.isArray(conn?.nodes) ? conn.nodes : [],
        };
      },
    });
    allNodes = [...allNodes, ...extra];
  }

  return allNodes.map((c) => ({
    author: c.author,
    authorAssociation: c.authorAssociation,
    path: c.path,
    body: c.body,
    createdAt: c.createdAt,
  }));
}

/**
 * 1 件の GraphQLFeedbackPrNode について不足ページがあれば追加取得し、完全な RawPrFeedbackInput へ変換する。
 */
export async function resolveFeedbackPrNodeWithPaging(params: {
  graphqlFn: GraphQLInvoker;
  owner: string;
  name: string;
  repository: string;
  node: GraphQLFeedbackPrNode;
  maxExtraPages?: number;
}): Promise<FetchedFeedbackPrDetail> {
  const {
    graphqlFn,
    owner,
    name,
    repository,
    node,
    maxExtraPages = DEFAULT_FEEDBACK_MAX_EXTRA_PAGES,
  } = params;
  const prNumber = Number(node.number ?? 0);

  // 1. Reviews + 各 Review のインラインコメント
  const initialReviewNodes = (node.reviews?.nodes ?? []).filter(
    (r): r is GraphQLFeedbackReviewNode => r !== null && r !== undefined,
  );
  const extraReviewNodes = node.reviews?.pageInfo?.hasNextPage
    ? await fetchRemainingPages<GraphQLFeedbackReviewNode>({
        label: "reviews",
        prNumber,
        maxExtraPages,
        initialHasNext: true,
        initialCursor: node.reviews.pageInfo.endCursor ?? null,
        fetchPage: async (after) => {
          const res = await graphqlFn<{
            repository?: {
              pullRequest?: {
                reviews?: {
                  pageInfo?: GraphQLPageInfo | null;
                  nodes?: Array<GraphQLFeedbackReviewNode | null> | null;
                } | null;
              } | null;
            } | null;
          }>(GET_FEEDBACK_REVIEWS_PAGE_QUERY, { owner, name, number: prNumber, after });
          const conn = res?.repository?.pullRequest?.reviews;
          return {
            hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
            endCursor: conn?.pageInfo?.endCursor ?? null,
            nodes: Array.isArray(conn?.nodes) ? conn.nodes : [],
          };
        },
      })
    : [];

  const allReviewNodes = [...initialReviewNodes, ...extraReviewNodes];
  const reviews: RawPrReviewInput[] = [];
  for (const r of allReviewNodes) {
    const inlineComments = await resolveCompleteReviewComments(
      graphqlFn,
      prNumber,
      r,
      maxExtraPages,
    );
    reviews.push({
      author: r.author,
      authorAssociation: r.authorAssociation,
      state: r.state,
      body: r.body,
      submittedAt: r.submittedAt,
      createdAt: r.createdAt,
      comments: inlineComments,
    });
  }

  // 2. Comments
  const initialCommentNodes = (node.comments?.nodes ?? []).filter(
    (c): c is GraphQLFeedbackCommentNode => c !== null && c !== undefined,
  );
  const extraCommentNodes = node.comments?.pageInfo?.hasNextPage
    ? await fetchRemainingPages<GraphQLFeedbackCommentNode>({
        label: "comments",
        prNumber,
        maxExtraPages,
        initialHasNext: true,
        initialCursor: node.comments.pageInfo.endCursor ?? null,
        fetchPage: async (after) => {
          const res = await graphqlFn<{
            repository?: {
              pullRequest?: {
                comments?: {
                  pageInfo?: GraphQLPageInfo | null;
                  nodes?: Array<GraphQLFeedbackCommentNode | null> | null;
                } | null;
              } | null;
            } | null;
          }>(GET_FEEDBACK_COMMENTS_PAGE_QUERY, { owner, name, number: prNumber, after });
          const conn = res?.repository?.pullRequest?.comments;
          return {
            hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
            endCursor: conn?.pageInfo?.endCursor ?? null,
            nodes: Array.isArray(conn?.nodes) ? conn.nodes : [],
          };
        },
      })
    : [];

  const comments: RawPrCommentInput[] = [...initialCommentNodes, ...extraCommentNodes].map((c) => ({
    author: c.author,
    authorAssociation: c.authorAssociation,
    body: c.body,
    createdAt: c.createdAt,
    lastEditedAt: c.lastEditedAt,
    editor: c.editor,
  }));

  // 3. Timeline LabeledEvents
  const initialTimelineNodes = (node.timelineItems?.nodes ?? []).filter(
    (t): t is GraphQLFeedbackLabeledEventNode => t !== null && t !== undefined,
  );
  const extraTimelineNodes = node.timelineItems?.pageInfo?.hasNextPage
    ? await fetchRemainingPages<GraphQLFeedbackLabeledEventNode>({
        label: "timelineItems",
        prNumber,
        maxExtraPages,
        initialHasNext: true,
        initialCursor: node.timelineItems.pageInfo.endCursor ?? null,
        fetchPage: async (after) => {
          const res = await graphqlFn<{
            repository?: {
              pullRequest?: {
                timelineItems?: {
                  pageInfo?: GraphQLPageInfo | null;
                  nodes?: Array<GraphQLFeedbackLabeledEventNode | null> | null;
                } | null;
              } | null;
            } | null;
          }>(GET_FEEDBACK_LABELED_EVENTS_PAGE_QUERY, { owner, name, number: prNumber, after });
          const conn = res?.repository?.pullRequest?.timelineItems;
          return {
            hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
            endCursor: conn?.pageInfo?.endCursor ?? null,
            nodes: Array.isArray(conn?.nodes) ? conn.nodes : [],
          };
        },
      })
    : [];

  const labeledEvents = [...initialTimelineNodes, ...extraTimelineNodes]
    .filter((t) => Boolean(t.label?.name))
    .map((t) => ({
      label: String(t.label?.name),
      ...(t.createdAt ? { createdAt: String(t.createdAt) } : {}),
    }));

  // 4. Files
  const initialFileNodes = (node.files?.nodes ?? []).filter(
    (f): f is GraphQLFeedbackFileNode => f !== null && f !== undefined,
  );
  const extraFileNodes = node.files?.pageInfo?.hasNextPage
    ? await fetchRemainingPages<GraphQLFeedbackFileNode>({
        label: "files",
        prNumber,
        maxExtraPages,
        initialHasNext: true,
        initialCursor: node.files.pageInfo.endCursor ?? null,
        fetchPage: async (after) => {
          const res = await graphqlFn<{
            repository?: {
              pullRequest?: {
                files?: {
                  pageInfo?: GraphQLPageInfo | null;
                  nodes?: Array<GraphQLFeedbackFileNode | null> | null;
                } | null;
              } | null;
            } | null;
          }>(GET_FEEDBACK_FILES_PAGE_QUERY, { owner, name, number: prNumber, after });
          const conn = res?.repository?.pullRequest?.files;
          return {
            hasNextPage: Boolean(conn?.pageInfo?.hasNextPage),
            endCursor: conn?.pageInfo?.endCursor ?? null,
            nodes: Array.isArray(conn?.nodes) ? conn.nodes : [],
          };
        },
      })
    : [];

  const filePaths = [...initialFileNodes, ...extraFileNodes]
    .map((f) => f.path?.trim())
    .filter((p): p is string => Boolean(p));

  const currentLabels = (node.labels?.nodes ?? [])
    .map((l) => l?.name?.trim())
    .filter((n): n is string => Boolean(n));

  const mergedAt = node.mergedAt ? String(node.mergedAt) : null;
  const closedAt = node.closedAt ? String(node.closedAt) : null;
  const state = normalizePrState(node.state, mergedAt);

  const rawOid = node.mergeCommit?.oid ?? node.headRefOid ?? null;
  const manifestOid = rawOid && SHA_HEX_PATTERN.test(rawOid) ? rawOid : null;

  return {
    input: {
      repository,
      number: prNumber,
      title: String(node.title ?? ""),
      url: String(node.url ?? ""),
      state,
      createdAt: String(node.createdAt ?? ""),
      updatedAt: String(node.updatedAt ?? ""),
      mergedAt,
      closedAt,
      author: node.author,
      authorAssociation: node.authorAssociation,
      commitCount: Number(node.commits?.totalCount ?? 0),
      currentLabels,
      labeledEvents,
      reviews,
      comments,
      filePaths,
    },
    manifestOid,
  };
}

/**
 * 指定された PR 番号群について、GraphQL alias バッチクエリで詳細を取得し、
 * 必要に応じてページング補完した FetchedFeedbackPrDetail 配列を返す。
 */
export async function fetchPullRequestFeedbackDetails(params: {
  graphqlFn: GraphQLInvoker;
  owner: string;
  name: string;
  repository: string;
  prNumbers: readonly number[];
  batchSize?: number;
  maxExtraPages?: number;
}): Promise<FetchedFeedbackPrDetail[]> {
  const {
    graphqlFn,
    owner,
    name,
    repository,
    prNumbers,
    batchSize = DEFAULT_FEEDBACK_BATCH_SIZE,
    maxExtraPages = DEFAULT_FEEDBACK_MAX_EXTRA_PAGES,
  } = params;

  const uniqueNumbers = Array.from(new Set(prNumbers.filter((n) => Number.isInteger(n) && n > 0)));
  const results: FetchedFeedbackPrDetail[] = [];

  for (let i = 0; i < uniqueNumbers.length; i += batchSize) {
    const batch = uniqueNumbers.slice(i, i + batchSize);
    const query = buildPullRequestFeedbackBatchQuery(batch);
    if (!query) continue;

    const data = await graphqlFn<{
      repository?: Record<string, GraphQLFeedbackPrNode | null | undefined> | null;
    }>(query, { owner, name });

    const repoNode = data?.repository;
    if (!repoNode) continue;

    for (let j = 0; j < batch.length; j++) {
      const prNode = repoNode[`pr${j}`];
      if (!prNode?.number) continue;
      const detail = await resolveFeedbackPrNodeWithPaging({
        graphqlFn,
        owner,
        name,
        repository,
        node: prNode,
        maxExtraPages,
      });
      results.push(detail);
    }
  }

  return results;
}

/**
 * 複数のマニフェスト Blob を GraphQL alias バッチで取得し、`target.key -> text` のマップを返す。
 * 削除済みフォーク等で object が null の場合はマップに含めない（エラーにしない）。
 */
export async function fetchInstallerManifestBlobs(params: {
  graphqlFn: GraphQLInvoker;
  owner: string;
  name: string;
  targets: readonly BlobFetchTarget[];
  batchSize?: number;
}): Promise<Map<string, string>> {
  const { graphqlFn, owner, name, targets, batchSize = DEFAULT_BLOB_BATCH_SIZE } = params;
  const validTargets = targets.filter(
    (t) => SHA_HEX_PATTERN.test(t.oid) && t.path.length > 0 && !/[\r\n\0]/.test(t.path),
  );
  const blobMap = new Map<string, string>();

  for (let i = 0; i < validTargets.length; i += batchSize) {
    const batch = validTargets.slice(i, i + batchSize);
    const query = buildInstallerBlobBatchQuery(batch);
    if (!query) continue;

    const data = await graphqlFn<{
      repository?: Record<string, { text?: string | null } | null | undefined> | null;
    }>(query, { owner, name });

    const repoNode = data?.repository;
    if (!repoNode) continue;

    for (let j = 0; j < batch.length; j++) {
      const blob = repoNode[`b${j}`];
      if (typeof blob?.text === "string") {
        blobMap.set(batch[j].key, blob.text);
      }
    }
  }

  return blobMap;
}
