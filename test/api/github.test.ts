import { describe, expect, test } from "bun:test";
import { GitHubApiClient, GitHubApiError } from "../../src/api/github";

describe("API: GitHubApiClient", () => {
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

    const client = new GitHubApiClient({
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
    expect(items[0].title).toBe("Test PR 101");
    expect(capturedUrl).toContain("search/issues?q=repo%3Amicrosoft%2Fwinget-pkgs%20is%3Apr");
    expect(capturedUrl).toContain("sort=created&order=asc&per_page=3");
    expect(capturedHeaders.Authorization).toBe("Bearer dummy-token-xyz");
    expect(capturedHeaders.Accept).toBe("application/vnd.github+json");
  });

  test("getPullRequest は PR 基本情報を取得する", async () => {
    let capturedUrl = "";

    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          number: 464302,
          title: "New package: sample",
          html_url: "https://github.com/microsoft/winget-pkgs/pull/464302",
          created_at: "2026-10-28T21:47:38Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({
      token: "sample-token",
      fetch: mockFetch,
    });

    const pr = await client.getPullRequest("microsoft/winget-pkgs", 464302);
    expect(pr.number).toBe(464302);
    expect(pr.title).toBe("New package: sample");
    expect(pr.url).toBe("https://github.com/microsoft/winget-pkgs/pull/464302");
    expect(capturedUrl).toBe("https://api.github.com/repos/microsoft/winget-pkgs/pulls/464302");
  });

  test("API エラー発生時に GitHubApiError をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response("API rate limit exceeded", { status: 403 });
    };

    const client = new GitHubApiClient({
      token: "dummy",
      fetch: mockFetch,
    });

    expect(client.searchIssues("test")).rejects.toThrow(GitHubApiError);
    try {
      await client.searchIssues("test");
    } catch (err: unknown) {
      if (err instanceof GitHubApiError) {
        expect(err.status).toBe(403);
        expect(err.message).toContain("403");
      } else {
        throw err;
      }
    }
  });

  test("トークン未指定時は Authorization ヘッダーを付与しない", async () => {
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (_: unknown, init?: RequestInit): Promise<Response> => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    };

    const client = new GitHubApiClient({
      token: undefined,
      fetch: mockFetch,
    });

    await client.searchIssues("test");
    expect(capturedHeaders.Authorization).toBeUndefined();
  });
});
