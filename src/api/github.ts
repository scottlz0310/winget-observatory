import type { GitHubPrView, GitHubSearchItem } from "../models/depths";
import type {
  GitHubDetailedSearchItem,
  GitHubDetailedSearchResult,
  ProgressPrDetail,
  ProgressPrSampleData,
  ProgressPrState,
  ProgressTimelineEvent,
  SearchPageInfo,
} from "../models/progress";
import {
  adaptGraphQLRateLimitBucket,
  adaptGraphQLTimelineItems,
  adaptGraphQLToDetailedSearchResult,
  adaptGraphQLToPrDetail,
  adaptGraphQLToPrSampleData,
  adaptGraphQLToPrState,
  adaptGraphQLToPrView,
  adaptGraphQLToSearchItem,
  buildGraphQLSearchQuery,
} from "./graphql-adapters";
import {
  GET_PULL_REQUEST_DETAILS_QUERY,
  GET_PULL_REQUEST_SAMPLE_QUERY,
  GET_PULL_REQUEST_STATE_QUERY,
  GET_PULL_REQUEST_TIMELINE_QUERY,
  GET_PULL_REQUEST_VIEW_QUERY,
  GET_RATE_LIMIT_QUERY,
  SEARCH_COUNT_QUERY,
  SEARCH_ISSUES_DETAILED_QUERY,
  SEARCH_ISSUES_QUERY,
} from "./graphql-queries";
import type {
  GitHubRateLimit,
  GitHubRateLimitBucket,
  GraphQLPullRequestNode,
  GraphQLRateLimitBucket,
  GraphQLRateLimitData,
  GraphQLSearchConnection,
  GraphQLTimelineConnection,
} from "./graphql-types";
import {
  DEFAULT_MAX_INTERVENTION_EXTRA_PAGES,
  type GraphQLInvoker,
  resolvePrInterventionWithPaging,
} from "./intervention-paging";
import {
  calculateBackoffDelay,
  computeRetryMinDelayMs,
  DEFAULT_ADAPTIVE_COOLDOWN_MS,
  DEFAULT_ADAPTIVE_COOLDOWN_REQUESTS,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_SECONDARY_RATE_LIMIT_DELAY_MS,
  GitHubApiError,
  GitHubGraphQLError,
  type GraphQLErrorDetail,
  type GraphQLRetryOptions,
  isPrNotFoundGraphQLError,
  isRetryableHttpResponse,
  isRetryableStatusCode,
  isSecondaryRateLimitResponse,
  parseRetryAfterMs,
  RETRYABLE_STATUS_CODES,
} from "./retry";

export type {
  GitHubDetailedSearchItem,
  GitHubDetailedSearchResult,
  GitHubRateLimit,
  GitHubRateLimitBucket,
  GraphQLErrorDetail,
  GraphQLInvoker,
  GraphQLRateLimitBucket,
  GraphQLRetryOptions,
  ProgressPrSampleData,
  ProgressPrState,
  SearchPageInfo,
};
export {
  calculateBackoffDelay,
  computeRetryMinDelayMs,
  DEFAULT_ADAPTIVE_COOLDOWN_MS,
  DEFAULT_ADAPTIVE_COOLDOWN_REQUESTS,
  DEFAULT_MAX_INTERVENTION_EXTRA_PAGES,
  DEFAULT_MAX_RETRY_AFTER_MS,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_SECONDARY_RATE_LIMIT_DELAY_MS,
  GET_PULL_REQUEST_DETAILS_QUERY,
  GET_PULL_REQUEST_SAMPLE_QUERY,
  GET_PULL_REQUEST_STATE_QUERY,
  GET_PULL_REQUEST_TIMELINE_QUERY,
  GET_PULL_REQUEST_VIEW_QUERY,
  GET_RATE_LIMIT_QUERY,
  GitHubApiError,
  GitHubGraphQLError,
  isPrNotFoundGraphQLError,
  isRetryableHttpResponse,
  isRetryableStatusCode,
  isSecondaryRateLimitResponse,
  parseRetryAfterMs,
  RETRYABLE_STATUS_CODES,
  resolvePrInterventionWithPaging,
  SEARCH_COUNT_QUERY,
  SEARCH_ISSUES_DETAILED_QUERY,
  SEARCH_ISSUES_QUERY,
};

/** `typeof fetch` は preconnect 等の静的プロパティを含みモック注入を妨げるため、呼び出しシグネチャのみを要求する */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

interface GraphQLSearchResponse {
  search?: GraphQLSearchConnection<GraphQLPullRequestNode> | null;
}

interface GraphQLTimelineItemsResponse {
  repository?: {
    pullRequest?: {
      timelineItems?: GraphQLTimelineConnection | null;
    } | null;
  } | null;
}

interface GraphQLPullRequestSampleResponse {
  repository?: {
    pullRequest?: GraphQLPullRequestNode | null;
  } | null;
}

export interface GitHubApiClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  retry?: GraphQLRetryOptions;
}

/**
 * GitHub GraphQL API と通信する純 TypeScript クライアント。
 * 外部ライブラリ非依存（Bun 標準 fetch）で動作し、モック注入可能。
 */
export class GitHubApiClient {
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxJitterMs: number;
  private readonly secondaryRateLimitDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly adaptiveCooldownMs: number;
  private readonly adaptiveCooldownRequests: number;
  private cooldownRemainingRequests = 0;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly warnLogFn: (message: string) => void;

  constructor(options: GitHubApiClientOptions = {}) {
    this.token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? undefined;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.retry?.maxRetries ?? 3;
    this.baseDelayMs = options.retry?.baseDelayMs ?? 2000;
    this.maxJitterMs = options.retry?.maxJitterMs ?? 500;
    this.secondaryRateLimitDelayMs =
      options.retry?.secondaryRateLimitDelayMs ?? DEFAULT_SECONDARY_RATE_LIMIT_DELAY_MS;
    this.maxRetryDelayMs = options.retry?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.maxRetryAfterMs = options.retry?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.adaptiveCooldownMs = options.retry?.adaptiveCooldownMs ?? DEFAULT_ADAPTIVE_COOLDOWN_MS;
    this.adaptiveCooldownRequests =
      options.retry?.adaptiveCooldownRequests ?? DEFAULT_ADAPTIVE_COOLDOWN_REQUESTS;
    this.sleepFn =
      options.retry?.sleep ??
      ((ms: number) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.warnLogFn = options.retry?.warnLog ?? console.error;
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
   * GitHub GraphQL Search API を呼び出し、条件に一致する総件数（issueCount）のみを取得する。
   * nodes や pageInfo を一切取得しない最小クエリ。
   */
  async searchIssueCount(query: string): Promise<number> {
    const data = await this.graphql<{ search?: { issueCount?: number } | null }>(
      SEARCH_COUNT_QUERY,
      {
        query: query.trim(),
      },
    );
    return Number(data?.search?.issueCount ?? 0);
  }

  /**
   * GitHub GraphQL Search API を呼び出し、PR の軽量検索結果アイテム一覧を取得する。
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
      ...(gqlData.rateLimit.cost !== undefined ? { cost: gqlData.rateLimit.cost } : {}),
    };

    return {
      graphql: graphqlBucket,
    };
  }

  private createNotFoundError(resourceLabel: string, prNumber: number): GitHubApiError {
    return new GitHubApiError(
      `GitHub ${resourceLabel} 取得に失敗しました (#${prNumber}, status 404): Not Found`,
      404,
    );
  }

  private activateCooldown(): void {
    if (this.adaptiveCooldownMs > 0 && this.adaptiveCooldownRequests > 0) {
      this.cooldownRemainingRequests = this.adaptiveCooldownRequests;
    }
  }

  private async waitAdaptiveCooldown(): Promise<void> {
    if (this.cooldownRemainingRequests <= 0) {
      return;
    }
    this.cooldownRemainingRequests--;
    if (this.adaptiveCooldownMs > 0) {
      await this.sleepFn(this.adaptiveCooldownMs);
    }
  }

  private async waitBeforeRetry(
    attempt: number,
    reason: string,
    options?: { clientMinDelayMs?: number; retryAfterMs?: number },
  ): Promise<void> {
    this.activateCooldown();
    const exponentialDelay = calculateBackoffDelay(attempt, this.baseDelayMs, this.maxJitterMs);
    const clientMinDelay = options?.clientMinDelayMs ?? 0;
    const rawClientDelay =
      clientMinDelay > 0 ? Math.max(exponentialDelay, clientMinDelay) : exponentialDelay;
    const cappedClientDelay =
      this.maxRetryDelayMs > 0 ? Math.min(rawClientDelay, this.maxRetryDelayMs) : rawClientDelay;
    // サーバー明示指定の Retry-After は短縮しない（クライアント側バックオフ上限より優先する）
    const retryAfterMs = options?.retryAfterMs;
    const delay =
      retryAfterMs !== undefined ? Math.max(cappedClientDelay, retryAfterMs) : cappedClientDelay;
    this.warnLogFn(
      `[GitHub GraphQL] ${reason}。リトライ ${attempt}/${this.maxRetries} (待機時間: ${delay}ms)...`,
    );
    await this.sleepFn(delay);
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
        throw this.createNotFoundError("Pull Request", prNumber);
      }

      const { node: resolvedNode } = await resolvePrInterventionWithPaging(
        (query, variables) => this.graphql(query, variables),
        owner,
        name,
        prNode,
      );

      return adaptGraphQLToPrView(resolvedNode);
    } catch (err: unknown) {
      if (isPrNotFoundGraphQLError(err)) {
        throw this.createNotFoundError("Pull Request", prNumber);
      }
      throw err;
    }
  }

  /**
   * Pull Request の状態（OPEN / CLOSED / MERGED）と mergedAt のみを軽量に取得する。
   */
  async getPullRequestState(repository: string, prNumber: number): Promise<ProgressPrState> {
    const { owner, name } = parseRepository(repository);
    try {
      const data = await this.graphql<{
        repository?: {
          pullRequest?: GraphQLPullRequestNode | null;
        } | null;
      }>(GET_PULL_REQUEST_STATE_QUERY, { owner, name, number: prNumber });

      const prNode = data?.repository?.pullRequest;
      if (!prNode) {
        throw this.createNotFoundError("Pull Request", prNumber);
      }

      return adaptGraphQLToPrState(prNode);
    } catch (err: unknown) {
      if (isPrNotFoundGraphQLError(err)) {
        throw this.createNotFoundError("Pull Request", prNumber);
      }
      throw err;
    }
  }

  /**
   * Search Issues / PRs API を呼び出し、詳細情報と総件数を取得する（GraphQL search 経由）。
   * perPage <= 0 が指定された場合は件数専用クエリ（SEARCH_COUNT_QUERY）を使用して nodes を取得しない。
   *
   * @param query 検索クエリ文字列
   * @param sort ソート基準（例: "created", "updated"）
   * @param order ソート順（"asc" または "desc"）
   * @param perPage 1ページあたりの取得件数（0 の場合は件数のみ取得）
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
    if (perPage <= 0) {
      const totalCount = await this.searchIssueCount(query);
      return { totalCount, items: [] };
    }

    const fullQuery = buildGraphQLSearchQuery(query, sort, order);

    let after: string | null = cursor ?? null;

    // cursor が明示されておらず、page > 1 が指定された場合は、1ページ目から cursor をたどる
    if (!cursor && page > 1) {
      let currentPage = 1;
      while (currentPage < page) {
        const stepData: GraphQLSearchResponse = await this.graphql<GraphQLSearchResponse>(
          SEARCH_ISSUES_DETAILED_QUERY,
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
      SEARCH_ISSUES_DETAILED_QUERY,
      {
        query: fullQuery,
        first: perPage,
        after,
      },
    );

    const connection = data.search;
    return adaptGraphQLToDetailedSearchResult(connection ?? { issueCount: 0 });
  }

  /**
   * Pull Request の詳細情報（状態、最新コミット・総コミット数、ラベルなど）を取得する（GraphQL repository.pullRequest 経由）。
   * 1 リクエストで PR 基本情報・ラベル・最新コミット（commits(last: 1)）と総コミット数を一括取得する。
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
        throw this.createNotFoundError("Pull Request", prNumber);
      }

      return adaptGraphQLToPrDetail(prNode);
    } catch (err: unknown) {
      if (isPrNotFoundGraphQLError(err)) {
        throw this.createNotFoundError("Pull Request", prNumber);
      }
      throw err;
    }
  }

  /**
   * マージ済み候補サンプル計測に必要なメタデータ（createdAt, author, commitCount, latestCommittedDate）と
   * タイムラインイベント一覧を 1 クエリ（GET_PULL_REQUEST_SAMPLE_QUERY）で統合取得する。
   * タイムラインが 2 ページ以上にわたる場合のみ、2 ページ目以降を GET_PULL_REQUEST_TIMELINE_QUERY で追加走査する。
   */
  async getPullRequestSampleData(
    repository: string,
    prNumber: number,
    maxPages = 10,
  ): Promise<ProgressPrSampleData> {
    const { owner, name } = parseRepository(repository);

    try {
      const firstPageData = await this.graphql<GraphQLPullRequestSampleResponse>(
        GET_PULL_REQUEST_SAMPLE_QUERY,
        {
          owner,
          name,
          number: prNumber,
          after: null,
        },
      );

      const prNode = firstPageData.repository?.pullRequest;
      if (!prNode) {
        throw this.createNotFoundError("Sample", prNumber);
      }

      const allEvents: ProgressTimelineEvent[] = [];
      let connection = prNode.timelineItems;
      if (Array.isArray(connection?.nodes)) {
        allEvents.push(...adaptGraphQLTimelineItems(connection.nodes));
      }

      let pageCount = 1;
      let after = connection?.pageInfo?.endCursor ?? null;
      let hasNext = Boolean(connection?.pageInfo?.hasNextPage && after);

      while (hasNext && pageCount < maxPages) {
        pageCount++;
        const nextData = await this.graphql<GraphQLTimelineItemsResponse>(
          GET_PULL_REQUEST_TIMELINE_QUERY,
          {
            owner,
            name,
            number: prNumber,
            after,
          },
        );

        const nextPrNode = nextData.repository?.pullRequest;
        if (!nextPrNode) {
          throw this.createNotFoundError("Timeline", prNumber);
        }

        connection = nextPrNode.timelineItems;
        if (Array.isArray(connection?.nodes)) {
          allEvents.push(...adaptGraphQLTimelineItems(connection.nodes));
        }

        after = connection?.pageInfo?.endCursor ?? null;
        hasNext = Boolean(connection?.pageInfo?.hasNextPage && after);
      }

      return adaptGraphQLToPrSampleData(prNode, allEvents);
    } catch (err: unknown) {
      if (isPrNotFoundGraphQLError(err)) {
        throw this.createNotFoundError("Sample", prNumber);
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
          throw this.createNotFoundError("Timeline", issueNumber);
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
        throw this.createNotFoundError("Timeline", issueNumber);
      }
      throw err;
    }
  }

  /**
   * GitHub GraphQL API を呼び出し、data フィールドを返す。
   * 一時的なネットワークエラーや 502/503/504/429・403 セカンダリレート制限では指数バックオフ・Retry-After 付きで自動リトライする。
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

    await this.waitAdaptiveCooldown();

    const url = `${this.baseUrl}/graphql`;
    const headers = {
      ...this.getHeaders(),
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({ query, variables });

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      let res: Response;
      let rawText: string;

      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers,
          body,
        });

        // 成功レスポンスの場合、本文のストリーム受信までを通信処理として実行（本文受信中の切断もリトライ対象）
        if (res.ok) {
          rawText = await res.text();
        } else {
          rawText = await res.text().catch(() => "");
        }
      } catch (err: unknown) {
        const networkError = err instanceof Error ? err : new Error(String(err));
        lastError = networkError;

        if (attempt <= this.maxRetries) {
          await this.waitBeforeRetry(
            attempt,
            `一時的なネットワークエラーが発生しました (${networkError.message})`,
          );
          continue;
        }

        throw networkError;
      }

      if (!res.ok) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
        const withinRetryAfterBudget =
          retryAfterMs === undefined ||
          this.maxRetryAfterMs <= 0 ||
          retryAfterMs <= this.maxRetryAfterMs;

        if (!withinRetryAfterBudget) {
          throw new GitHubApiError(
            `GitHub GraphQL API 呼び出しに失敗しました (${res.status}): Retry-After (${retryAfterMs}ms) が許容待機上限 (${this.maxRetryAfterMs}ms) を超過しているため早期再送せず終了します: ${rawText}`,
            res.status,
          );
        }

        const apiError = new GitHubApiError(
          `GitHub GraphQL API 呼び出しに失敗しました (${res.status}): ${rawText}`,
          res.status,
        );

        if (
          isRetryableHttpResponse(res.status, rawText, retryAfterHeader) &&
          attempt <= this.maxRetries
        ) {
          lastError = apiError;
          const isSecondary = isSecondaryRateLimitResponse(res.status, rawText, retryAfterHeader);
          const clientMinDelayMs =
            retryAfterMs === undefined && isSecondary ? this.secondaryRateLimitDelayMs : 0;
          const reason = isSecondary
            ? `セカンダリレート制限に達しました (status: ${res.status})`
            : `一時エラーが発生しました (status: ${res.status})`;
          await this.waitBeforeRetry(attempt, reason, {
            clientMinDelayMs,
            retryAfterMs,
          });
          continue;
        }

        throw apiError;
      }

      let json: {
        data?: T;
        errors?: GraphQLErrorDetail[];
      };

      try {
        if (!rawText || rawText.trim() === "") {
          throw new SyntaxError("Unexpected end of JSON input (empty body)");
        }
        json = JSON.parse(rawText) as {
          data?: T;
          errors?: GraphQLErrorDetail[];
        };
      } catch (parseErr: unknown) {
        const parseError = new GitHubApiError(
          `GitHub GraphQL API の応答 JSON パースに失敗しました: ${rawText}`,
          res.status,
        );
        lastError = parseError;

        if (attempt <= this.maxRetries) {
          const errDetail = parseErr instanceof Error ? parseErr.message : String(parseErr);
          await this.waitBeforeRetry(attempt, `応答 JSON パースに失敗しました (${errDetail})`);
          continue;
        }

        throw parseError;
      }

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
          500,
        );
      }

      return json.data;
    }

    throw lastError ?? new GitHubApiError("GitHub GraphQL API 呼び出しに失敗しました", 500);
  }
}
