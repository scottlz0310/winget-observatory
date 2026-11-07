import type { GitHubPrView, GitHubSearchItem } from "../models/depths";
import type {
  ProgressCommitSummary,
  ProgressPrDetail,
  ProgressTimelineEvent,
} from "../models/progress";

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
      return {
        number: Number(item.number),
        title: String(item.title),
        html_url: String(item.html_url),
        created_at: String(item.created_at),
        updated_at: String(item.updated_at),
      };
    });
  }

  /**
   * Pull Request の基本情報を取得する。
   */
  async getPullRequest(repository: string, prNumber: number): Promise<GitHubPrView> {
    const url = `${this.baseUrl}/repos/${repository}/pulls/${prNumber}`;

    const res = await this.fetchFn(url, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub Pull Request 取得に失敗しました (#${prNumber}, status ${res.status}): ${errText}`,
        res.status,
      );
    }

    const item = (await res.json()) as Record<string, unknown>;
    return {
      number: Number(item.number),
      title: String(item.title),
      url: String(item.html_url),
      createdAt: String(item.created_at),
    };
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
   * Pull Request の詳細情報（状態、コミット一覧、ラベルなど）を取得する。
   */
  async getPullRequestDetails(repository: string, prNumber: number): Promise<ProgressPrDetail> {
    const prUrl = `${this.baseUrl}/repos/${repository}/pulls/${prNumber}`;
    const commitsUrl = `${this.baseUrl}/repos/${repository}/pulls/${prNumber}/commits?per_page=100`;

    const [prRes, commitsRes] = await Promise.all([
      this.fetchFn(prUrl, { method: "GET", headers: this.getHeaders() }),
      this.fetchFn(commitsUrl, { method: "GET", headers: this.getHeaders() }),
    ]);

    if (!prRes.ok) {
      const errText = await prRes.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub Pull Request 取得に失敗しました (#${prNumber}, status ${prRes.status}): ${errText}`,
        prRes.status,
      );
    }

    if (!commitsRes.ok) {
      const errText = await commitsRes.text().catch(() => "");
      throw new GitHubApiError(
        `GitHub PR コミット一覧取得に失敗しました (#${prNumber}, status ${commitsRes.status}): ${errText}`,
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
}
