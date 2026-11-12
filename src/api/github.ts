import type { GitHubPrView, GitHubSearchItem } from "../models/depths";
import type {
  ProgressCommitSummary,
  ProgressPrDetail,
  ProgressTimelineEvent,
} from "../models/progress";
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
  /** REST core 枠の実値 */
  core: GitHubRateLimitBucket;
  /** REST search 枠の実値 */
  search: GitHubRateLimitBucket;
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
   * レート制限の残量を取得する。
   * GraphQL の rateLimit クエリ（1pt消費）と REST /rate_limit（0pt消費）を並行取得し、
   * GraphQL 枠および REST core / search 枠の真の残量を返す。
   */
  async getRateLimit(): Promise<GitHubRateLimit> {
    const [gqlData, restRes] = await Promise.all([
      this.graphql<{ rateLimit?: GraphQLRateLimitData }>(GET_RATE_LIMIT_QUERY),
      this.fetchFn(`${this.baseUrl}/rate_limit`, {
        method: "GET",
        headers: this.getHeaders(),
      }),
    ]);

    if (
      !gqlData?.rateLimit ||
      !Number.isFinite(gqlData.rateLimit.limit) ||
      !Number.isFinite(gqlData.rateLimit.remaining)
    ) {
      throw new GitHubApiError("GitHub レート制限の応答に rateLimit がありません", 500);
    }

    if (!restRes.ok) {
      const errText = await restRes.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub REST レート制限の取得に失敗しました (status ${restRes.status}): ${errText}`,
        restRes.status,
      );
    }

    const restData = (await restRes.json()) as { resources?: Record<string, unknown> };
    const pickRest = (name: string): GitHubRateLimitBucket => {
      const bucket = restData.resources?.[name] as Record<string, unknown> | undefined;
      const limit = Number(bucket?.limit);
      const remaining = Number(bucket?.remaining);
      const reset = Number(bucket?.reset);
      if (!bucket || !Number.isFinite(limit) || !Number.isFinite(remaining)) {
        throw new GitHubApiError(`GitHub レート制限の応答に ${name} がありません`, restRes.status);
      }
      return {
        limit,
        remaining,
        resetAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null,
      };
    };

    const graphqlBucket: GraphQLRateLimitBucket = {
      ...adaptGraphQLRateLimitBucket(gqlData.rateLimit),
      cost: gqlData.rateLimit.cost,
    };

    return {
      graphql: graphqlBucket,
      core: pickRest("core"),
      search: pickRest("search"),
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
   * REST API を直接呼び出して PR 詳細・コミット一覧を取得する（比較検証・移行診断専用）。
   */
  async getPullRequestDetailsRest(repository: string, prNumber: number): Promise<ProgressPrDetail> {
    const prUrl = `${this.baseUrl}/repos/${repository}/pulls/${prNumber}`;
    const commitsUrl = `${this.baseUrl}/repos/${repository}/pulls/${prNumber}/commits?per_page=100`;

    const [prRes, commitsRes] = await Promise.all([
      this.fetchFn(prUrl, { method: "GET", headers: this.getHeaders() }),
      this.fetchFn(commitsUrl, { method: "GET", headers: this.getHeaders() }),
    ]);

    if (!prRes.ok) {
      const errText = await prRes.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub Pull Request (REST) 取得に失敗しました (#${prNumber}, status ${prRes.status}): ${errText}`,
        prRes.status,
      );
    }

    if (!commitsRes.ok) {
      const errText = await commitsRes.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub PR コミット一覧 (REST) 取得に失敗しました (#${prNumber}, status ${commitsRes.status}): ${errText}`,
        commitsRes.status,
      );
    }

    const prData = (await prRes.json()) as Record<string, unknown>;

    const rawCommits = (await commitsRes.json()) as unknown[];
    const commits: ProgressCommitSummary[] = Array.isArray(rawCommits)
      ? rawCommits.map((c) => {
          const commitObj = c as Record<string, unknown>;
          const commitDetails = commitObj.commit as Record<string, unknown> | undefined;
          const committer = commitDetails?.committer as Record<string, unknown> | undefined;
          const author = commitDetails?.author as Record<string, unknown> | undefined;
          const message = String(commitDetails?.message ?? "");
          const committedDate = String(committer?.date ?? author?.date ?? prData.created_at);

          return {
            oid: commitObj.sha ? String(commitObj.sha) : undefined,
            messageHeadline: message.split("\n")[0],
            committedDate,
          };
        })
      : [];

    const stateRaw = String(prData.state ?? "open").toUpperCase();
    const isMerged = Boolean(prData.merged_at);
    const state: "OPEN" | "CLOSED" | "MERGED" = isMerged
      ? "MERGED"
      : stateRaw === "OPEN"
        ? "OPEN"
        : "CLOSED";

    const labels = Array.isArray(prData.labels)
      ? prData.labels.map((l) => String((l as Record<string, unknown>).name))
      : [];

    const userObj = prData.user as Record<string, unknown> | undefined;
    const author = userObj?.login ? String(userObj.login) : undefined;
    const authorAssociation = prData.author_association
      ? String(prData.author_association)
      : undefined;

    return {
      number: Number(prData.number),
      title: String(prData.title),
      url: String(prData.html_url),
      state,
      isDraft: Boolean(prData.draft),
      createdAt: String(prData.created_at),
      updatedAt: String(prData.updated_at),
      mergedAt: prData.merged_at ? String(prData.merged_at) : null,
      closedAt: prData.closed_at ? String(prData.closed_at) : null,
      labels,
      commits,
      author,
      authorAssociation,
    };
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
