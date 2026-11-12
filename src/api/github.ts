import type { GitHubPrView, GitHubSearchItem } from "../models/depths";
import type { ProgressPrDetail, ProgressTimelineEvent } from "../models/progress";
import {
  adaptGraphQLRateLimitBucket,
  adaptGraphQLToPrDetail,
  adaptGraphQLToPrView,
} from "./graphql-adapters";
import type { GraphQLPullRequestNode, GraphQLRateLimitData } from "./graphql-types";

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
  graphql?: GraphQLRateLimitBucket;
  /** 後方互換のためのエイリアスまたはフォールバック */
  core: GraphQLRateLimitBucket;
  search: GraphQLRateLimitBucket;
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

/**
 * GitHub REST API と通信する純 TypeScript クライアント。
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
   * Search Issues / PRs API を呼び出す。
   */
  async searchIssues(
    query: string,
    sort = "created",
    order = "asc",
    perPage = 3,
  ): Promise<GitHubSearchItem[]> {
    const encoded = encodeURIComponent(query);
    const url = `${this.baseUrl}/search/issues?q=${encoded}&sort=${sort}&order=${order}&per_page=${perPage}`;

    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub Search API 呼び出しに失敗しました (${res.status}): ${errText}`,
        res.status,
      );
    }

    const data = (await res.json()) as { items?: unknown[] };
    if (!Array.isArray(data.items)) {
      return [];
    }

    return data.items.map((raw) => {
      const item = raw as Record<string, unknown>;
      const user = item.user as Record<string, unknown> | undefined;
      return {
        number: Number(item.number),
        title: String(item.title),
        html_url: String(item.html_url),
        created_at: String(item.created_at),
        updated_at: String(item.updated_at),
        author: user?.login ? String(user.login) : undefined,
        author_association: item.author_association ? String(item.author_association) : undefined,
      };
    });
  }

  /**
   * レート制限の残量を取得する。GraphQL の rateLimit クエリを使用する。
   * 既存コードとの後方互換性のため、core と search にも GraphQL の情報を設定して返す。
   */
  async getRateLimit(): Promise<GitHubRateLimit> {
    const data = await this.graphql<{ rateLimit?: GraphQLRateLimitData }>(GET_RATE_LIMIT_QUERY);
    if (
      !data?.rateLimit ||
      !Number.isFinite(data.rateLimit.limit) ||
      !Number.isFinite(data.rateLimit.remaining)
    ) {
      throw new GitHubApiError("GitHub レート制限の応答に rateLimit がありません", 500);
    }

    const bucket: GraphQLRateLimitBucket = {
      ...adaptGraphQLRateLimitBucket(data.rateLimit),
      cost: data.rateLimit.cost,
    };

    return {
      graphql: bucket,
      core: bucket,
      search: bucket,
    };
  }

  /**
   * Pull Request の基本情報を取得する（GraphQL repository.pullRequest 経由）。
   */
  async getPullRequest(repository: string, prNumber: number): Promise<GitHubPrView> {
    const { owner, name } = parseRepository(repository);
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
  }

  /**
   * Search Issues / PRs API を呼び出し、詳細情報と総件数を返す。
   */
  async searchIssuesDetailed(
    query: string,
    sort = "created",
    order = "asc",
    perPage = 30,
    page = 1,
  ): Promise<GitHubDetailedSearchResult> {
    const encoded = encodeURIComponent(query);
    const url = `${this.baseUrl}/search/issues?q=${encoded}&sort=${sort}&order=${order}&per_page=${perPage}&page=${page}`;

    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub Search API 呼び出しに失敗しました (${res.status}): ${errText}`,
        res.status,
      );
    }

    const data = (await res.json()) as {
      total_count?: number;
      items?: unknown[];
    };

    const totalCount = Number(data.total_count ?? 0);
    const items: GitHubDetailedSearchItem[] = Array.isArray(data.items)
      ? data.items.map((raw) => {
          const item = raw as Record<string, unknown>;
          return {
            number: Number(item.number),
            title: String(item.title),
            html_url: String(item.html_url),
            created_at: String(item.created_at),
            updated_at: String(item.updated_at),
            labels: Array.isArray(item.labels)
              ? item.labels.map((l) => ({ name: String((l as Record<string, unknown>).name) }))
              : [],
            is_draft: Boolean(item.draft),
            pull_request: item.pull_request
              ? {
                  merged_at: (item.pull_request as Record<string, unknown>).merged_at
                    ? String((item.pull_request as Record<string, unknown>).merged_at)
                    : null,
                }
              : undefined,
          };
        })
      : [];

    return { totalCount, items };
  }

  /**
   * Pull Request の詳細情報（状態、コミット一覧、ラベルなど）を取得する（GraphQL repository.pullRequest 経由）。
   * 1 リクエストで PR 基本情報・ラベル・コミット一覧（先頭 100 件）を一括取得する。
   */
  async getPullRequestDetails(repository: string, prNumber: number): Promise<ProgressPrDetail> {
    const { owner, name } = parseRepository(repository);
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
  }

  /**
   * Issue / PR のタイムラインイベント一覧をページネーションして取得する。
   */
  async getIssueTimeline(
    repository: string,
    issueNumber: number,
    maxPages = 10,
  ): Promise<ProgressTimelineEvent[]> {
    let nextUrl: string | null =
      `${this.baseUrl}/repos/${repository}/issues/${issueNumber}/timeline?per_page=100`;
    const allEvents: ProgressTimelineEvent[] = [];
    let pageCount = 0;

    while (nextUrl && pageCount < maxPages) {
      pageCount++;
      const res: Response = await this.fetchFn(nextUrl, {
        method: "GET",
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new GitHubApiError(
          `GitHub Timeline 取得に失敗しました (#${issueNumber}, status ${res.status}): ${errText}`,
          res.status,
        );
      }

      const items = (await res.json()) as unknown[];
      if (Array.isArray(items)) {
        for (const item of items) {
          const rec = item as Record<string, unknown>;
          const event = String(rec.event ?? "");
          const createdAt = String(rec.created_at ?? "");
          const labelObj = rec.label as Record<string, unknown> | undefined;

          if (event && createdAt) {
            allEvents.push({
              event,
              created_at: createdAt,
              label: labelObj ? { name: String(labelObj.name) } : undefined,
            });
          }
        }
      }

      // Link ヘッダーから次ページ URL を探索
      const linkHeader: string | null = res.headers.get("Link") ?? res.headers.get("link");
      nextUrl = null;
      if (linkHeader) {
        const match: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (match) {
          nextUrl = match[1];
        }
      }
    }

    return allEvents;
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
      errors?: Array<{ message?: string }>;
    };

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message ?? "Unknown error").join("; ");
      throw new GitHubApiError(
        `GitHub GraphQL API からエラーが返されました: ${messages}`,
        res.status,
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
