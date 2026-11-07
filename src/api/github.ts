import type { GitHubPrView, GitHubSearchItem } from "../models/depths";

export interface GitHubApiClientOptions {
  token?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
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
  private readonly fetchFn: typeof fetch;

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
}
