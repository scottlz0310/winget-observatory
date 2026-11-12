import type { GitHubPrView, GitHubSearchItem } from "../models/depths";
import type { ProgressPrDetail, ProgressTimelineEvent } from "../models/progress";
import {
  adaptGraphQLRateLimitBucket,
  adaptGraphQLTimelineItems,
  adaptGraphQLToDetailedSearchItem,
  adaptGraphQLToPrDetail,
  adaptGraphQLToPrView,
  adaptGraphQLToSearchItem,
  buildGraphQLSearchQuery,
} from "./graphql-adapters";
import type {
  GraphQLPageInfo,
  GraphQLPullRequestNode,
  GraphQLRateLimitData,
  GraphQLSearchConnection,
  GraphQLTimelineItemNode,
} from "./graphql-types";

export interface GitHubDetailedSearchItem {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels?: { name: string }[];
  is_draft?: boolean;
  pull_request?: {
    merged_at?: string | null;
  };
}

export interface GitHubDetailedSearchResult {
  totalCount: number;
  items: GitHubDetailedSearchItem[];
  pageInfo?: GraphQLPageInfo;
}

/** `typeof fetch` は preconnect 等の静的プロパティを含みモック注入を妨げるため、呼び出しシグネチャのみを要求する */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** レート制限の 1 枠（core / search / graphql）の残量 */
export interface GitHubRateLimitBucket {
  limit: number;
  remaining: number;
  /** 枠がリセットされる時刻（ISO 8601, UTC）。不明なら null */
  resetAt: string | null;
}

export interface GraphQLRateLimitBucket extends GitHubRateLimitBucket {
  cost?: number;
}

export interface GitHubRateLimit {
  /** GraphQL レート制限枠 */
  graphql: GraphQLRateLimitBucket;
  /** @deprecated GraphQL 一本化に伴い廃止。後方互換・旧テストモック用にオプショナルで維持 */
  core?: GitHubRateLimitBucket;
  /** @deprecated GraphQL 一本化に伴い廃止。後方互換・旧テストモック用にオプショナルで維持 */
  search?: GitHubRateLimitBucket;
}

/**
 * リポジトリ識別文字列（"owner/name"）をパースする。
 */
export function parseRepository(repository: string): { owner: string; name: string } {
  const parts = repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitHubApiError(
      `リポジトリ名の形式が不正です: "${repository}" (owner/repo 形式を指定してください)`,
      400,
    );
  }
  return { owner: parts[0], name: parts[1] };
}

export const SEARCH_ISSUES_QUERY = `
query SearchIssues($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        title
        url
        createdAt
        updatedAt
        isDraft
        mergedAt
        author {
          login
        }
        authorAssociation
        labels(first: 100) {
          nodes {
            name
          }
        }
      }
    }
  }
}
`;

export const GET_RATE_LIMIT_QUERY = `
query GetRateLimit {
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
}
`;

export const GET_PULL_REQUEST_VIEW_QUERY = `
query GetPullRequestView($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      createdAt
      updatedAt
    }
  }
}
`;

export const GET_PULL_REQUEST_DETAILS_QUERY = `
query GetPullRequestDetails($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      state
      isDraft
      createdAt
      updatedAt
      mergedAt
      closedAt
      author {
        login
      }
      authorAssociation
      labels(first: 100) {
        nodes {
          name
        }
      }
      commits(first: 100) {
        totalCount
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
          }
        }
      }
    }
  }
}
`;

export const GET_PULL_REQUEST_TIMELINE_QUERY = `
query GetPullRequestTimeline($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(
        first: 100
        after: $after
        itemTypes: [
          LABELED_EVENT
          UNLABELED_EVENT
          CONVERT_TO_DRAFT_EVENT
          READY_FOR_REVIEW_EVENT
        ]
      ) {
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
          ... on UnlabeledEvent {
            createdAt
            label {
              name
            }
          }
          ... on ConvertToDraftEvent {
            createdAt
          }
          ... on ReadyForReviewEvent {
            createdAt
          }
        }
      }
    }
  }
}
`;

interface GraphQLSearchResponse {
  search?: GraphQLSearchConnection<GraphQLPullRequestNode> | null;
}

interface GraphQLTimelineItemsResponse {
  repository?: {
    pullRequest?: {
      timelineItems?: {
        pageInfo?: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes?: GraphQLTimelineItemNode[];
      };
    } | null;
  } | null;
}

export interface GitHubApiClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GraphQLErrorDetail {
  message?: string;
  type?: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
}

export class GitHubGraphQLError extends GitHubApiError {
  constructor(
    message: string,
    status: number,
    readonly errors: GraphQLErrorDetail[] = [],
  ) {
    super(message, status);
    this.name = "GitHubGraphQLError";
  }
}

/**
 * GraphQL の errors が PullRequest の不存在（NOT_FOUND）に起因するかを厳密に判定する。
 * path で対象が pullRequest であることを確認し、FORBIDDEN や INTERNAL などの
 * 認可・サーバー障害エラーを誤って 404 に変換しないよう不存在エラーのみに限定する。
 */
export function isPrNotFoundGraphQLError(err: unknown): boolean {
  if (err instanceof GitHubGraphQLError) {
    if (err.errors.length === 0) {
      return false;
    }
    return err.errors.every((e) => {
      const isNotFound =
        e.type === "NOT_FOUND" ||
        Boolean(e.message?.includes("Could not resolve to a PullRequest"));
      const isPrPath = e.path ? e.path.includes("pullRequest") : true;
      return isNotFound && isPrPath;
    });
  }
  return false;
}

/**
 * GitHub GraphQL API と通信する純 TypeScript クライアント。
 * 外部ライブラリ非依存（Bun 標準 fetch）で動作し、モック注入可能。
 */
export class GitHubApiClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(options: GitHubApiClientOptions = {}) {
    this.token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  get apiToken(): string | undefined {
    return this.token;
  }

  get apiBaseUrl(): string {
    return this.baseUrl;
  }

  get fetchFunction(): FetchLike {
    return this.fetchFn;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "winget-observatory",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  /**
   * GitHub GraphQL Search API を呼び出し、PR の検索結果アイテム一覧を取得する。
   *
   * @param query 検索クエリ文字列
   * @param sort ソート基準（例: "created", "updated"）
   * @param order ソート順（"asc" または "desc"）
   * @param perPage 取得件数（最大100）
   * @returns 検索結果アイテム一覧（GitHubSearchItem[]）
   */
  async searchIssues(
    query: string,
    sort = "created",
    order = "asc",
    perPage = 3,
  ): Promise<GitHubSearchItem[]> {
    const fullQuery = buildGraphQLSearchQuery(query, sort, order);
    const data = await this.graphql<GraphQLSearchResponse>(SEARCH_ISSUES_QUERY, {
      query: fullQuery,
      first: perPage,
    });

    const nodes = data?.search?.nodes;
    if (!Array.isArray(nodes)) {
      return [];
    }

    const items: GitHubSearchItem[] = [];
    for (const raw of nodes) {
      if (raw && typeof raw === "object" && "number" in raw && "title" in raw) {
        items.push(adaptGraphQLToSearchItem(raw as GraphQLPullRequestNode));
      }
    }
    return items;
  }

  /**
   * レート制限の残量を取得する（GraphQL rateLimit クエリ経由）。
   */
  async getRateLimit(): Promise<GitHubRateLimit> {
    const gqlData = await this.graphql<{ rateLimit?: GraphQLRateLimitData }>(GET_RATE_LIMIT_QUERY);

    if (
      !gqlData?.rateLimit ||
      !Number.isFinite(gqlData.rateLimit.limit) ||
      !Number.isFinite(gqlData.rateLimit.remaining)
    ) {
      throw new GitHubApiError("GitHub レート制限の応答に rateLimit がありません", 500);
    }

    const graphqlBucket: GraphQLRateLimitBucket = {
      ...adaptGraphQLRateLimitBucket(gqlData.rateLimit),
      cost: gqlData.rateLimit.cost,
    };

    return {
      graphql: graphqlBucket,
    };
  }

  /**
   * Pull Request の基本情報を取得する（GraphQL repository.pullRequest 経由）。
   */
  async getPullRequest(repository: string, prNumber: number): Promise<GitHubPrView> {
    const { owner, name } = parseRepository(repository);
    try {
      const data = await this.graphql<{
        repository?: {
          pullRequest?: GraphQLPullRequestNode | null;
        } | null;
      }>(GET_PULL_REQUEST_VIEW_QUERY, { owner, name, number: prNumber });

      const prNode = data?.repository?.pullRequest;
      if (!prNode) {
        throw new GitHubApiError(
          `GitHub Pull Request 取得に失敗しました (#${prNumber}, status 404): Not Found`,
          404,
        );
      }

      return adaptGraphQLToPrView(prNode);
    } catch (err: unknown) {
      if (isPrNotFoundGraphQLError(err)) {
        throw new GitHubApiError(
          `GitHub Pull Request 取得に失敗しました (#${prNumber}, status 404): Not Found`,
          404,
        );
      }
      throw err;
    }
  }

  /**
   * Search Issues / PRs API を呼び出し、詳細情報と総件数を取得する（GraphQL search 経由）。
   *
   * @param query 検索クエリ文字列
   * @param sort ソート基準（例: "created", "updated"）
   * @param order ソート順（"asc" または "desc"）
   * @param perPage 1ページあたりの取得件数（最大100）
   * @param page 取得ページ番号（1始まり。cursor 未指定で page > 1 の場合は内部で cursor を走査）
   * @param cursor GraphQL ページネーションカーソル（省略可）
   * @returns 検索結果オブジェクト（totalCount と items を含む。pageInfo も付与）
   */
  async searchIssuesDetailed(
    query: string,
    sort = "created",
    order = "asc",
    perPage = 30,
    page = 1,
    cursor?: string | null,
  ): Promise<GitHubDetailedSearchResult> {
    const fullQuery = buildGraphQLSearchQuery(query, sort, order);

    let after: string | null = cursor ?? null;

    // cursor が明示されておらず、page > 1 が指定された場合は、1ページ目から cursor をたどる
    if (!cursor && page > 1) {
      let currentPage = 1;
      while (currentPage < page) {
        const stepData: GraphQLSearchResponse = await this.graphql<GraphQLSearchResponse>(
          SEARCH_ISSUES_QUERY,
          {
            query: fullQuery,
            first: perPage,
            after,
          },
        );
        const conn = stepData.search;
        if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) {
          return {
            totalCount: Number(conn?.issueCount ?? 0),
            items: [],
            pageInfo: conn?.pageInfo,
          };
        }
        after = conn.pageInfo.endCursor;
        currentPage++;
      }
    }

    const data: GraphQLSearchResponse = await this.graphql<GraphQLSearchResponse>(
      SEARCH_ISSUES_QUERY,
      {
        query: fullQuery,
        first: perPage,
        after,
      },
    );

    const connection = data.search;
    const totalCount = Number(connection?.issueCount ?? 0);
    const items: GitHubDetailedSearchItem[] = [];

    if (Array.isArray(connection?.nodes)) {
      for (const raw of connection.nodes) {
        if (raw && typeof raw === "object" && "number" in raw && "title" in raw) {
          items.push(adaptGraphQLToDetailedSearchItem(raw as GraphQLPullRequestNode));
        }
      }
    }

    return { totalCount, items, pageInfo: connection?.pageInfo };
  }

  /**
   * Pull Request の詳細情報（状態、コミット一覧、ラベルなど）を取得する（GraphQL repository.pullRequest 経由）。
   * 1 リクエストで PR 基本情報・ラベル・コミット一覧（先頭 100 件）を一括取得する。
   */
  async getPullRequestDetails(repository: string, prNumber: number): Promise<ProgressPrDetail> {
    const { owner, name } = parseRepository(repository);
    try {
      const data = await this.graphql<{
        repository?: {
          pullRequest?: GraphQLPullRequestNode | null;
        } | null;
      }>(GET_PULL_REQUEST_DETAILS_QUERY, { owner, name, number: prNumber });

      const prNode = data?.repository?.pullRequest;
      if (!prNode) {
        throw new GitHubApiError(
          `GitHub Pull Request 取得に失敗しました (#${prNumber}, status 404): Not Found`,
          404,
        );
      }

      return adaptGraphQLToPrDetail(prNode);
    } catch (err: unknown) {
      if (isPrNotFoundGraphQLError(err)) {
        throw new GitHubApiError(
          `GitHub Pull Request 取得に失敗しました (#${prNumber}, status 404): Not Found`,
          404,
        );
      }
      throw err;
    }
  }

  /**
   * Issue / PR のタイムラインイベント一覧をページネーションして取得する（GraphQL repository.pullRequest.timelineItems 経由）。
   * 最大 maxPages（既定 10 ページ = 最大 1,000 件）まで自動走査し、
   * LabeledEvent, UnlabeledEvent, ConvertToDraftEvent, ReadyForReviewEvent を取得して ProgressTimelineEvent[] に変換する。
   */
  async getIssueTimeline(
    repository: string,
    issueNumber: number,
    maxPages = 10,
  ): Promise<ProgressTimelineEvent[]> {
    const { owner, name } = parseRepository(repository);
    const allEvents: ProgressTimelineEvent[] = [];
    let after: string | null = null;
    let pageCount = 0;

    try {
      while (pageCount < maxPages) {
        pageCount++;
        const resData: GraphQLTimelineItemsResponse =
          await this.graphql<GraphQLTimelineItemsResponse>(GET_PULL_REQUEST_TIMELINE_QUERY, {
            owner,
            name,
            number: issueNumber,
            after,
          });

        const prNode = resData.repository?.pullRequest;
        if (!prNode) {
          throw new GitHubApiError(
            `GitHub Timeline 取得に失敗しました (#${issueNumber}, status 404): Not Found`,
            404,
          );
        }

        const connection = prNode.timelineItems;
        if (Array.isArray(connection?.nodes)) {
          const adapted = adaptGraphQLTimelineItems(connection.nodes);
          allEvents.push(...adapted);
        }

        if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
          break;
        }
        after = connection.pageInfo.endCursor;
      }

      return allEvents;
    } catch (err: unknown) {
      if (isPrNotFoundGraphQLError(err)) {
        throw new GitHubApiError(
          `GitHub Timeline 取得に失敗しました (#${issueNumber}, status 404): Not Found`,
          404,
        );
      }
      throw err;
    }
  }

  /**
   * GitHub GraphQL API を呼び出し、data フィールドを返す。
   *
   * @param query GraphQL クエリ文字列
   * @param variables クエリ変数（省略可）
   * @returns レスポンスの data フィールド
   * @throws {GitHubApiError} トークン未設定、HTTPエラー、GraphQL errors、または data 欠落の場合
   */
  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    if (!this.token) {
      throw new GitHubApiError(
        "GitHub GraphQL API の呼び出しにはトークン (GITHUB_TOKEN または GH_TOKEN) が必要です",
        401,
      );
    }

    const url = `${this.baseUrl}/graphql`;
    const headers = {
      ...this.getHeaders(),
      "Content-Type": "application/json",
    };

    const res = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub GraphQL API 呼び出しに失敗しました (${res.status}): ${errText}`,
        res.status,
      );
    }

    const json = (await res.json()) as {
      data?: T;
      errors?: GraphQLErrorDetail[];
    };

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message ?? "Unknown error").join("; ");
      throw new GitHubGraphQLError(
        `GitHub GraphQL API からエラーが返されました: ${messages}`,
        res.status,
        json.errors,
      );
    }

    if (json.data === undefined) {
      throw new GitHubApiError(
        "GitHub GraphQL API の応答に data フィールドが含まれていません",
        res.status,
      );
    }

    return json.data;
  }
}
