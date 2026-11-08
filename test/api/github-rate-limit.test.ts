import { describe, expect, test } from "bun:test";
import { GitHubApiClient, GitHubApiError } from "../../src/api/github";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("API: GitHubApiClient.getRateLimit", () => {
  test("core と search の上限・残量・リセット時刻（ISO）を返し、/rate_limit を認証つきで呼ぶ", async () => {
    const requests: { url: string; auth: string | null }[] = [];
    const client = new GitHubApiClient({
      token: "dummy-token",
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          auth: new Headers(init?.headers).get("Authorization"),
        });
        return jsonResponse({
          resources: {
            core: { limit: 1000, remaining: 640, reset: 1_794_000_000 },
            search: { limit: 30, remaining: 22, reset: 1_794_000_060 },
            graphql: { limit: 5000, remaining: 5000, reset: 1_794_003_600 },
          },
        });
      },
    });

    const result = await client.getRateLimit();

    expect(requests).toEqual([
      { url: "https://api.github.com/rate_limit", auth: "Bearer dummy-token" },
    ]);
    expect(result).toEqual({
      core: { limit: 1000, remaining: 640, resetAt: new Date(1_794_000_000_000).toISOString() },
      search: { limit: 30, remaining: 22, resetAt: new Date(1_794_000_060_000).toISOString() },
    });
  });

  test("リセット時刻が無い枠は resetAt を null にする", async () => {
    const client = new GitHubApiClient({
      fetch: async () =>
        jsonResponse({
          resources: {
            core: { limit: 60, remaining: 59 },
            search: { limit: 10, remaining: 10 },
          },
        }),
    });
    const result = await client.getRateLimit();
    expect(result.core.resetAt).toBeNull();
    expect(result.search.resetAt).toBeNull();
  });

  test.each([
    ["core が無い", { resources: { search: { limit: 30, remaining: 30, reset: 1 } } }, "core"],
    ["search が無い", { resources: { core: { limit: 60, remaining: 60, reset: 1 } } }, "search"],
    [
      "残量が数値でない",
      {
        resources: {
          core: { limit: 60, remaining: "x", reset: 1 },
          search: { limit: 30, remaining: 30, reset: 1 },
        },
      },
      "core",
    ],
    ["resources が無い", {}, "core"],
  ])("応答が想定外なら握りつぶさず例外にする: %s", async (_name, body, field) => {
    const client = new GitHubApiClient({ fetch: async () => jsonResponse(body) });
    await expect(client.getRateLimit()).rejects.toThrow(`応答に ${field} がありません`);
  });

  test("HTTP エラーはステータス付きの GitHubApiError にする", async () => {
    const client = new GitHubApiClient({
      fetch: async () => new Response("rate limited", { status: 403 }),
    });
    const error = await client.getRateLimit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).message).toContain("status 403");
    expect((error as GitHubApiError).message).toContain("rate limited");
  });
});
