import { describe, expect, test } from "bun:test";
import { GitHubApiClient, GitHubApiError } from "../../src/api/github";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("API: GitHubApiClient.getRateLimit", () => {
  test("GraphQL rateLimit の上限・残量・リセット時刻（ISO）を返し、/graphql を認証つき POST で呼ぶ", async () => {
    const requests: { url: string; auth: string | null; method?: string; body?: string }[] = [];
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          auth: new Headers(init?.headers).get("Authorization"),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return jsonResponse({
          data: {
            rateLimit: {
              limit: 5000,
              cost: 1,
              remaining: 4999,
              resetAt: "2026-11-12T06:00:00Z",
            },
          },
        });
      },
    });

    const result = await client.getRateLimit();

    expect(requests.length).toBe(1);
    expect(requests[0].url).toBe("https://api.github.com/graphql");
    expect(requests[0].auth).toBe("Bearer dummy-token");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].body).toContain("GetRateLimit");

    expect(result.graphql).toEqual({
      limit: 5000,
      remaining: 4999,
      resetAt: "2026-11-12T06:00:00.000Z",
      cost: 1,
    });
    expect(result.core).toEqual({
      limit: 5000,
      remaining: 4999,
      resetAt: "2026-11-12T06:00:00.000Z",
      cost: 1,
    });
    expect(result.search).toEqual({
      limit: 5000,
      remaining: 4999,
      resetAt: "2026-11-12T06:00:00.000Z",
      cost: 1,
    });
  });

  test("リセット時刻が無効な形式の場合は resetAt を null にする", async () => {
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async () =>
        jsonResponse({
          data: {
            rateLimit: {
              limit: 5000,
              cost: 1,
              remaining: 4999,
              resetAt: "",
            },
          },
        }),
    });
    const result = await client.getRateLimit();
    expect(result.graphql?.resetAt).toBeNull();
    expect(result.core.resetAt).toBeNull();
  });

  test.each([
    ["rateLimit が無い", { data: {} }],
    [
      "limit が数値でない",
      { data: { rateLimit: { limit: "x", remaining: 10, resetAt: "2026-11-12T06:00:00Z" } } },
    ],
    [
      "remaining が数値でない",
      { data: { rateLimit: { limit: 5000, remaining: null, resetAt: "2026-11-12T06:00:00Z" } } },
    ],
  ])("応答が想定外なら握りつぶさず例外にする: %s", async (_name, body) => {
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async () => jsonResponse(body),
    });
    await expect(client.getRateLimit()).rejects.toThrow("rateLimit がありません");
  });

  test("トークン未指定時は 401 GitHubApiError にする", async () => {
    const origGithubToken = process.env.GITHUB_TOKEN;
    const origGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    try {
      const client = new GitHubApiClient({
        token: undefined,
        fetch: async () => jsonResponse({ data: {} }),
      });
      await expect(client.getRateLimit()).rejects.toThrow(GitHubApiError);
      try {
        await client.getRateLimit();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).status).toBe(401);
      }
    } finally {
      if (origGithubToken !== undefined) {
        process.env.GITHUB_TOKEN = origGithubToken;
      }
      if (origGhToken !== undefined) {
        process.env.GH_TOKEN = origGhToken;
      }
    }
  });

  test("HTTP エラーはステータス付きの GitHubApiError にする", async () => {
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async () => new Response("rate limited", { status: 403 }),
    });
    const error = await client.getRateLimit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).message).toContain("403");
  });
});
