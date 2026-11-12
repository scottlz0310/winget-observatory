import { describe, expect, test } from "bun:test";
import { GitHubApiClient, GitHubApiError } from "../../src/api/github";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("API: GitHubApiClient.getRateLimit", () => {
  test("GraphQL rateLimit のみを取得して返し、REST エンドポイントを呼び出さない", async () => {
    const requests: { url: string; auth: string | null; method?: string }[] = [];
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async (input, init) => {
        const urlStr = String(input);
        requests.push({
          url: urlStr,
          auth: new Headers(init?.headers).get("Authorization"),
          method: init?.method,
        });

        if (urlStr.includes("/graphql")) {
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
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    const result = await client.getRateLimit();

    // GraphQL 呼び出し 1 件のみであること
    expect(requests.length).toBe(1);
    expect(requests[0].url).toBe("https://api.github.com/graphql");
    expect(requests[0].method).toBe("POST");
    expect(requests.some((r) => r.url.includes("/rate_limit"))).toBe(false);

    // GraphQL 枠の実値
    expect(result.graphql).toEqual({
      limit: 5000,
      remaining: 4999,
      resetAt: "2026-11-12T06:00:00.000Z",
      cost: 1,
    });
  });

  test("GraphQL のリセット時刻が無効な形式の場合は resetAt を null にする", async () => {
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async (input) => {
        const urlStr = String(input);
        if (urlStr.includes("/graphql")) {
          return jsonResponse({
            data: {
              rateLimit: {
                limit: 5000,
                cost: 1,
                remaining: 4999,
                resetAt: "",
              },
            },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
    const result = await client.getRateLimit();
    expect(result.graphql.resetAt).toBeNull();
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
  ])("GraphQL 応答が想定外なら握りつぶさず例外にする: %s", async (_name, body) => {
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async (input) => {
        const urlStr = String(input);
        if (urlStr.includes("/graphql")) {
          return jsonResponse(body);
        }
        return new Response("Not Found", { status: 404 });
      },
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
