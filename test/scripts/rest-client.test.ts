import { describe, expect, test } from "bun:test";
import { GitHubRestApiClient } from "../../scripts/rest-client";
import { GitHubApiError } from "../../src/api/github";

describe("Scripts: GitHubRestApiClient", () => {
  test("searchIssues は正しくエンコードされた URL とヘッダーでリクエストを行う", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};

      return new Response(
        JSON.stringify({
          items: [
            {
              number: 101,
              title: "Test PR 101",
              html_url: "https://github.com/test/repo/pull/101",
              created_at: "2026-11-01T00:00:00Z",
              updated_at: "2026-11-02T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubRestApiClient({
      token: "dummy-token-xyz",
      fetch: mockFetch,
    });

    const items = await client.searchIssues(
      "repo:microsoft/winget-pkgs is:pr",
      "created",
      "asc",
      3,
    );

    expect(items.length).toBe(1);
    expect(items[0].number).toBe(101);
    expect(capturedUrl).toContain(
      "/search/issues?q=repo%3Amicrosoft%2Fwinget-pkgs%20is%3Apr&sort=created&order=asc&per_page=3",
    );
    expect(capturedHeaders.Authorization).toBe("Bearer dummy-token-xyz");
  });

  test("トークン未指定時は Authorization ヘッダーを付与しない", async () => {
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };

    const origGithubToken = process.env.GITHUB_TOKEN;
    const origGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    try {
      const client = new GitHubRestApiClient({
        token: undefined,
        fetch: mockFetch,
      });

      await client.searchIssues("test");
      expect(capturedHeaders.Authorization).toBeUndefined();
    } finally {
      if (origGithubToken !== undefined) {
        process.env.GITHUB_TOKEN = origGithubToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
      if (origGhToken !== undefined) {
        process.env.GH_TOKEN = origGhToken;
      } else {
        delete process.env.GH_TOKEN;
      }
    }
  });

  test("searchIssuesDetailed は totalCount と items を返し、page 引数を URL に付与する", async () => {
    let capturedUrl = "";
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          total_count: 42,
          items: [
            {
              number: 200,
              title: "Issue 200",
              html_url: "https://github.com/test/repo/issues/200",
              created_at: "2026-11-01T00:00:00Z",
              updated_at: "2026-11-02T00:00:00Z",
              labels: [{ name: "New-Package" }],
              draft: false,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubRestApiClient({ fetch: mockFetch });
    const res = await client.searchIssuesDetailed("repo:test/repo is:pr", "created", "asc", 30, 3);

    expect(capturedUrl).toContain("page=3");
    expect(res.totalCount).toBe(42);
    expect(res.items.length).toBe(1);
    expect(res.items[0].number).toBe(200);
    expect(res.items[0].labels?.[0].name).toBe("New-Package");
  });

  test("getPullRequestDetails は REST API から PR 情報とコミット一覧を取得して統合する", async () => {
    let pullsCalled = false;
    let commitsCalled = false;

    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/commits")) {
        commitsCalled = true;
        return new Response(
          JSON.stringify([
            {
              sha: "restcommit123",
              commit: {
                message: "feat: rest commit headline",
                committer: { date: "2026-11-01T12:00:00Z" },
              },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      pullsCalled = true;
      return new Response(
        JSON.stringify({
          number: 500,
          title: "REST PR 500",
          html_url: "https://github.com/test/repo/pull/500",
          state: "open",
          draft: false,
          created_at: "2026-11-01T10:00:00Z",
          merged_at: null,
          closed_at: null,
          labels: [{ name: "New-Package" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubRestApiClient({ fetch: mockFetch });
    const pr = await client.getPullRequestDetails("test/repo", 500);

    expect(pullsCalled).toBe(true);
    expect(commitsCalled).toBe(true);
    expect(pr.number).toBe(500);
    expect(pr.state).toBe("OPEN");
    expect(pr.commits.length).toBe(1);
    expect(pr.commits[0].oid).toBe("restcommit123");
  });

  test("getIssueTimeline は REST API を呼び出してページネーションして全イベントを取得する", async () => {
    let callCount = 0;
    const mockFetch = async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify([
            {
              event: "labeled",
              created_at: "2026-11-01T10:00:00Z",
              label: { name: "New-Package" },
            },
          ]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://api.github.com/repos/test/repo/issues/300/timeline?page=2>; rel="next"',
            },
          },
        );
      }
      return new Response(
        JSON.stringify([
          {
            event: "labeled",
            created_at: "2026-11-01T11:00:00Z",
            label: { name: "Validation-Completed" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubRestApiClient({ fetch: mockFetch });
    const events = await client.getIssueTimeline("test/repo", 300);

    expect(callCount).toBe(2);
    expect(events.length).toBe(2);
    expect(events[0].label?.name).toBe("New-Package");
    expect(events[1].label?.name).toBe("Validation-Completed");
  });

  test("getIssueTimeline は HTTP エラー時に例外をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    };

    const client = new GitHubRestApiClient({ fetch: mockFetch });
    try {
      await client.getIssueTimeline("test/repo", 999);
      expect().fail("例外が発生するべきです");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
      expect((err as GitHubApiError).message).toContain(
        "GitHub Timeline (REST) 取得に失敗しました",
      );
    }
  });

  test("getRateLimit は REST /rate_limit から core と search を取得する", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          resources: {
            core: { limit: 1000, remaining: 640, reset: 1_794_000_000 },
            search: { limit: 30, remaining: 22, reset: 1_794_000_060 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubRestApiClient({ fetch: mockFetch });
    const rate = await client.getRateLimit();

    expect(rate.core.limit).toBe(1000);
    expect(rate.core.remaining).toBe(640);
    expect(rate.search.limit).toBe(30);
    expect(rate.search.remaining).toBe(22);
  });
});
