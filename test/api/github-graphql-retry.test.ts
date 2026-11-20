import { describe, expect, test } from "bun:test";
import {
  calculateBackoffDelay,
  computeRetryMinDelayMs,
  DEFAULT_MAX_INTERVENTION_EXTRA_PAGES,
  GET_PULL_REQUEST_DETAILS_QUERY,
  GET_PULL_REQUEST_TIMELINE_QUERY,
  GET_PULL_REQUEST_VIEW_QUERY,
  GET_RATE_LIMIT_QUERY,
  GitHubApiClient,
  GitHubApiError,
  GitHubGraphQLError,
  isPrNotFoundGraphQLError,
  isRetryableHttpResponse,
  isRetryableStatusCode,
  isSecondaryRateLimitResponse,
  parseRepository,
  parseRetryAfterMs,
  RETRYABLE_STATUS_CODES,
  resolvePrInterventionWithPaging,
  SEARCH_ISSUES_QUERY,
} from "../../src/api/github";
import {
  GET_PULL_REQUEST_DETAILS_QUERY as DIRECT_GET_PULL_REQUEST_DETAILS_QUERY,
  GET_PULL_REQUEST_TIMELINE_QUERY as DIRECT_GET_PULL_REQUEST_TIMELINE_QUERY,
  GET_PULL_REQUEST_VIEW_QUERY as DIRECT_GET_PULL_REQUEST_VIEW_QUERY,
  GET_RATE_LIMIT_QUERY as DIRECT_GET_RATE_LIMIT_QUERY,
  SEARCH_ISSUES_QUERY as DIRECT_SEARCH_ISSUES_QUERY,
  FIRST_TIMER_GRAPHQL_QUERY,
} from "../../src/api/graphql-queries";
import {
  DEFAULT_MAX_INTERVENTION_EXTRA_PAGES as DIRECT_DEFAULT_MAX_INTERVENTION_EXTRA_PAGES,
  resolvePrInterventionWithPaging as directResolvePrInterventionWithPaging,
} from "../../src/api/intervention-paging";
import {
  RETRYABLE_STATUS_CODES as DIRECT_RETRYABLE_STATUS_CODES,
  GitHubApiError as DirectGitHubApiError,
  GitHubGraphQLError as DirectGitHubGraphQLError,
  calculateBackoffDelay as directCalculateBackoffDelay,
  isPrNotFoundGraphQLError as directIsPrNotFoundGraphQLError,
  isRetryableStatusCode as directIsRetryableStatusCode,
  parseRetryAfterMs as directParseRetryAfterMs,
} from "../../src/api/retry";

describe("API: GitHubApiClient (graphql & retry)", () => {
  describe("graphql", () => {
    test("正しい URL, POST メソッド, JSON ボディ, ヘッダーで呼び出し data を返す", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = "";

      const mockFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? "";
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        capturedBody = String(init?.body ?? "");

        return new Response(
          JSON.stringify({
            data: {
              search: {
                issueCount: 42,
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new GitHubApiClient({
        token: "gql-test-token",
        fetch: mockFetch,
      });

      const query = "query($q: String!) { search(query: $q) { issueCount } }";
      const variables = { q: "repo:microsoft/winget-pkgs is:pr" };

      interface SearchData {
        search: { issueCount: number };
      }

      const data = await client.graphql<SearchData>(query, variables);

      expect(capturedUrl).toBe("https://api.github.com/graphql");
      expect(capturedMethod).toBe("POST");
      expect(capturedHeaders.Authorization).toBe("Bearer gql-test-token");
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
      expect(capturedHeaders.Accept).toBe("application/vnd.github+json");
      expect(JSON.parse(capturedBody)).toEqual({ query, variables });
      expect(data.search.issueCount).toBe(42);
    });

    test("トークンが未設定の場合は 401 の GitHubApiError をスローする", async () => {
      const origGithubToken = process.env.GITHUB_TOKEN;
      const origGhToken = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;

      try {
        const clientUndefinedToken = new GitHubApiClient({
          token: undefined,
          fetch: async () => new Response("{}", { status: 200 }),
        });

        const clientEmptyToken = new GitHubApiClient({
          token: "",
          fetch: async () => new Response("{}", { status: 200 }),
        });

        for (const client of [clientUndefinedToken, clientEmptyToken]) {
          await expect(client.graphql("query { viewer { login } }")).rejects.toThrow(
            GitHubApiError,
          );

          try {
            await client.graphql("query { viewer { login } }");
          } catch (err: unknown) {
            expect(err).toBeInstanceOf(GitHubApiError);
            expect((err as GitHubApiError).status).toBe(401);
            expect((err as GitHubApiError).message).toContain("トークン");
          }
        }
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

    test("502 連続後にリトライして成功し警告ログを出力する", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        if (attempts < 3) {
          return new Response("Bad Gateway", { status: 502 });
        }
        return new Response(JSON.stringify({ data: { test: "success" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 10,
          maxJitterMs: 5,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      const result = await client.graphql<{ test: string }>("query { test }");
      expect(result).toEqual({ test: "success" });
      expect(attempts).toBe(3);
      expect(sleepDelays.length).toBe(2);
      expect(warnLogs.length).toBe(2);
      expect(warnLogs[0]).toContain("status: 502");
      expect(warnLogs[0]).toContain("リトライ 1/3");
      expect(warnLogs[1]).toContain("status: 502");
      expect(warnLogs[1]).toContain("リトライ 2/3");
    });

    test("502 が連続してリトライ上限（最大3回、計4回試行）を超過した場合はエラーをスローする", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        return new Response("Bad Gateway", { status: 502 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          maxRetries: 3,
          baseDelayMs: 10,
          maxJitterMs: 0,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      try {
        await client.graphql("query { test }");
        expect().fail("例外がスローされるべき");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).status).toBe(502);
        expect((err as GitHubApiError).message).toContain("502");
        expect((err as GitHubApiError).message).toContain("Bad Gateway");
      }

      expect(attempts).toBe(4);
      expect(sleepDelays).toEqual([10, 20, 40]);
      expect(warnLogs.length).toBe(3);
      expect(warnLogs[0]).toContain("リトライ 1/3");
      expect(warnLogs[1]).toContain("リトライ 2/3");
      expect(warnLogs[2]).toContain("リトライ 3/3");
    });

    test.each([
      [400, "Bad Request"],
      [401, "Unauthorized"],
      [403, "Forbidden"],
      [404, "Not Found"],
      [500, "Internal Server Error"],
    ])(
      "非リトライ対象ステータス (%i) はリトライせず即座にエラーをスローする",
      async (status, statusText) => {
        let attempts = 0;
        const sleepDelays: number[] = [];
        const warnLogs: string[] = [];

        const mockFetch = async (): Promise<Response> => {
          attempts++;
          return new Response(statusText, { status });
        };

        const client = new GitHubApiClient({
          token: "dummy-token",
          fetch: mockFetch,
          retry: {
            baseDelayMs: 10,
            sleep: async (ms) => {
              sleepDelays.push(ms);
            },
            warnLog: (msg) => {
              warnLogs.push(msg);
            },
          },
        });

        try {
          await client.graphql("query { test }");
          expect().fail("例外がスローされるべき");
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(GitHubApiError);
          expect((err as GitHubApiError).status).toBe(status);
          expect((err as GitHubApiError).message).toContain(String(status));
        }

        expect(attempts).toBe(1);
        expect(sleepDelays.length).toBe(0);
        expect(warnLogs.length).toBe(0);
      },
    );

    test("429 応答の Retry-After を待機時間の下限として扱い指定秒数前に再送しない", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        if (attempts === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "60" },
          });
        }
        return new Response(JSON.stringify({ data: { test: "recovered" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 2000,
          maxJitterMs: 0,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      const result = await client.graphql<{ test: string }>("query { test }");
      expect(result).toEqual({ test: "recovered" });
      expect(attempts).toBe(2);
      // 指数バックオフ（2000ms）より Retry-After（60000ms）が長いため 60000ms が下限として使用される
      expect(sleepDelays).toEqual([60000]);
      expect(warnLogs[0]).toContain("status: 429");
      expect(warnLogs[0]).toContain("待機時間: 60000ms");
    });

    test("429 応答の Retry-After が指数バックオフより短い場合は指数バックオフが維持される", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        if (attempts === 1) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "Retry-After": "1" }, // 1 秒 = 1000ms
          });
        }
        return new Response(JSON.stringify({ data: { test: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 2000,
          maxJitterMs: 0,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
        },
      });

      await client.graphql("query { test }");
      expect(attempts).toBe(2);
      // Retry-After 1000ms < 指数バックオフ 2000ms なので 2000ms が使用される
      expect(sleepDelays).toEqual([2000]);
    });

    test("403 セカンダリレート制限（Retry-After なし）をリトライ対象として 60 秒以上待機し回復する", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        if (attempts === 1) {
          return new Response(
            JSON.stringify({
              documentation_url:
                "https://docs.github.com/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api#secondary-rate-limits",
              message:
                "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
            }),
            { status: 403 },
          );
        }
        return new Response(JSON.stringify({ data: { test: "recovered-403" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 2000,
          maxJitterMs: 0,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      const result = await client.graphql<{ test: string }>("query { test }");
      expect(result).toEqual({ test: "recovered-403" });
      expect(attempts).toBe(2);
      expect(sleepDelays).toEqual([60000]);
      expect(warnLogs[0]).toContain("セカンダリレート制限");
      expect(warnLogs[0]).toContain("status: 403");
    });

    test.each([403, 429, 503])(
      "status %i の Retry-After はクライアント側 maxRetryDelayMs 上限で短縮されず、仮想時計上で解除時刻まで正確に待機して成功する",
      async (status) => {
        let nowSec = 0;
        const releaseAtSec = 600;
        const sendTimesSec: number[] = [];
        const sleepDelays: number[] = [];

        const mockFetch = async (): Promise<Response> => {
          sendTimesSec.push(nowSec);
          if (nowSec < releaseAtSec) {
            const remainingSec = releaseAtSec - nowSec;
            return new Response("You have exceeded a secondary rate limit.", {
              status,
              headers: { "Retry-After": String(remainingSec) },
            });
          }
          return new Response(JSON.stringify({ data: { test: `ok-${status}` } }), {
            status: 200,
          });
        };

        const client = new GitHubApiClient({
          token: "dummy-token",
          fetch: mockFetch,
          retry: {
            baseDelayMs: 2000,
            maxJitterMs: 0,
            // 既定の maxRetryDelayMs (180000ms) より長い Retry-After: 600s を検証
            sleep: async (ms) => {
              sleepDelays.push(ms);
              nowSec += Math.ceil(ms / 1000);
            },
            warnLog: () => {},
          },
        });

        const result = await client.graphql<{ test: string }>("query { test }");
        expect(result).toEqual({ test: `ok-${status}` });
        expect(sendTimesSec).toEqual([0, 600]);
        expect(sleepDelays).toEqual([600000]);
      },
    );

    test("Retry-After が許容待機上限 (maxRetryAfterMs) を超える場合は短縮して早期再送せずエラーで終了する", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        return new Response("You have exceeded a secondary rate limit.", {
          status: 403,
          headers: { "Retry-After": "600" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          maxRetryAfterMs: 300000,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: () => {},
        },
      });

      await expect(client.graphql("query { test }")).rejects.toThrow(
        "Retry-After (600000ms) が許容待機上限 (300000ms) を超過",
      );
      expect(attempts).toBe(1);
      expect(sleepDelays).toEqual([]);
    });

    test("Retry-After 未指定のクライアント側待機時間（secondaryRateLimitDelayMs / 指数バックオフ）には maxRetryDelayMs 上限が適用される", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        if (attempts <= 2) {
          return new Response("You have exceeded a secondary rate limit.", {
            status: 403,
          });
        }
        return new Response(JSON.stringify({ data: { test: "ok" } }), { status: 200 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 1000,
          maxJitterMs: 0,
          secondaryRateLimitDelayMs: 150000,
          maxRetryDelayMs: 120000,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: () => {},
        },
      });

      const result = await client.graphql<{ test: string }>("query { test }");
      expect(result).toEqual({ test: "ok" });
      expect(attempts).toBe(3);
      expect(sleepDelays).toEqual([120000, 120000]);
    });

    test("適応的クールダウン: 正常時は 0ms で通過し、一時エラー発生後のみ指定回数だけ後続リクエストを冷却する", async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockFetch = async (): Promise<Response> => {
        callCount++;
        // 2 回目（リトライ対象 502）だけ失敗し、3 回目（リトライ）以降は成功
        if (callCount === 2) {
          return new Response("Bad Gateway", { status: 502 });
        }
        return new Response(JSON.stringify({ data: { ok: callCount } }), { status: 200 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 10,
          maxJitterMs: 0,
          adaptiveCooldownMs: 250,
          adaptiveCooldownRequests: 2,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: () => {},
        },
      });

      // 1 度目: エラーなし → sleep 0 回
      await client.graphql("query { r1 }");
      expect(sleepDelays).toEqual([]);

      // 2 度目: 502 で 1 回リトライ（10ms）し、クールダウン発動
      await client.graphql("query { r2 }");
      expect(sleepDelays).toEqual([10]);

      // 3・4 度目: クールダウン残り 2 回が消費される（各 250ms）
      await client.graphql("query { r3 }");
      await client.graphql("query { r4 }");
      // 5 度目: クールダウン終了し 0ms へ戻る
      await client.graphql("query { r5 }");
      expect(sleepDelays).toEqual([10, 250, 250]);
    });

    test("200 応答の本文受信中（ReadableStream）に接続切断が発生した場合にリトライして成功する", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        if (attempts === 1) {
          // ヘッダーは 200 OK だが本文読み込みで ECONNRESET
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "Content-Type": "application/json" }),
            text: async () => {
              throw new Error("connect ECONNRESET in body stream");
            },
          } as unknown as Response;
        }
        return new Response(JSON.stringify({ data: { streamResult: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 5,
          maxJitterMs: 0,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      const res = await client.graphql<{ streamResult: string }>("query { streamResult }");
      expect(res).toEqual({ streamResult: "ok" });
      expect(attempts).toBe(2);
      expect(sleepDelays).toEqual([5]);
      expect(warnLogs[0]).toContain("ECONNRESET in body stream");
      expect(warnLogs[0]).toContain("リトライ 1/3");
    });

    test("200 応答の本文受信中の接続切断が上限超過した場合はエラーをスローする", async () => {
      let attempts = 0;
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
          text: async () => {
            throw new Error("socket hang up during body read");
          },
        } as unknown as Response;
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 5,
          maxJitterMs: 0,
          sleep: async () => {},
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      await expect(client.graphql("query { test }")).rejects.toThrow("socket hang up");
      expect(attempts).toBe(4);
      expect(warnLogs.length).toBe(3);
    });

    test.each([
      ["空文字", ""],
      ["空白のみ", "   \n\t  "],
      ["HTMLエラー画面", "<html><body>502 Bad Gateway Proxy Error</body></html>"],
      ["不完全なJSON構文", '{"data": { "result": '],
    ])(
      "200 応答だが %s の場合は一時エラーとしてリトライして成功する",
      async (_label, invalidBody) => {
        let attempts = 0;
        const sleepDelays: number[] = [];
        const warnLogs: string[] = [];

        const mockFetch = async (): Promise<Response> => {
          attempts++;
          if (attempts === 1) {
            return new Response(invalidBody, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ data: { result: "ok" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        };

        const client = new GitHubApiClient({
          token: "dummy-token",
          fetch: mockFetch,
          retry: {
            baseDelayMs: 10,
            maxJitterMs: 0,
            sleep: async (ms) => {
              sleepDelays.push(ms);
            },
            warnLog: (msg) => {
              warnLogs.push(msg);
            },
          },
        });

        const res = await client.graphql<{ result: string }>("query { test }");
        expect(res).toEqual({ result: "ok" });
        expect(attempts).toBe(2);
        expect(sleepDelays).toEqual([10]);
        expect(warnLogs.length).toBe(1);
        expect(warnLogs[0]).toContain("JSON パースに失敗しました");
        expect(warnLogs[0]).toContain("リトライ 1/3");
      },
    );

    test("200 応答だが JSON パース失敗が継続して上限超過した場合は最後のエラーをスローする", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        return new Response("", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 5,
          maxJitterMs: 0,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      await expect(client.graphql("query { test }")).rejects.toThrow(
        "応答 JSON パースに失敗しました",
      );
      expect(attempts).toBe(4);
      expect(sleepDelays.length).toBe(3);
      expect(warnLogs.length).toBe(3);
    });

    test("ネットワークエラー発生時にリトライして成功する", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        if (attempts === 1) {
          throw new Error("connect ECONNRESET");
        }
        return new Response(JSON.stringify({ data: { result: "ok" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 5,
          maxJitterMs: 0,
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      const res = await client.graphql<{ result: string }>("query { result }");
      expect(res).toEqual({ result: "ok" });
      expect(attempts).toBe(2);
      expect(sleepDelays).toEqual([5]);
      expect(warnLogs.length).toBe(1);
      expect(warnLogs[0]).toContain("connect ECONNRESET");
      expect(warnLogs[0]).toContain("リトライ 1/3");
    });

    test("ネットワークエラーが継続して上限超過した場合は最後のエラーをスローする", async () => {
      let attempts = 0;
      const warnLogs: string[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        throw new Error("connect ETIMEDOUT");
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          baseDelayMs: 5,
          maxJitterMs: 0,
          sleep: async () => {},
          warnLog: (msg) => {
            warnLogs.push(msg);
          },
        },
      });

      await expect(client.graphql("query { test }")).rejects.toThrow("connect ETIMEDOUT");
      expect(attempts).toBe(4);
      expect(warnLogs.length).toBe(3);
    });

    test("GraphQL errors はリトライせず即座にエラーとする", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        return new Response(
          JSON.stringify({
            errors: [{ message: "Field 'invalid' doesn't exist on type 'Query'" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
        retry: {
          sleep: async (ms) => {
            sleepDelays.push(ms);
          },
        },
      });

      await expect(client.graphql("query { invalid }")).rejects.toThrow(GitHubGraphQLError);
      expect(attempts).toBe(1);
      expect(sleepDelays.length).toBe(0);
    });

    test("GraphQL errors が返された場合にメッセージ付き GitHubApiError をスローする", async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            errors: [
              { message: "Field 'invalid' doesn't exist on type 'Query'" },
              { message: "Syntax error" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
      });

      try {
        await client.graphql("query { invalid }");
        expect().fail("例外がスローされるべき");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).message).toContain(
          "Field 'invalid' doesn't exist on type 'Query'; Syntax error",
        );
      }
    });

    test.each([200, 202])(
      "data フィールドが含まれていない場合に実際の HTTP ステータス (%i) を保持した GitHubApiError をスローする",
      async (status) => {
        const mockFetch = async (): Promise<Response> => {
          return new Response(JSON.stringify({}), {
            status,
            headers: { "Content-Type": "application/json" },
          });
        };

        const client = new GitHubApiClient({
          token: "dummy-token",
          fetch: mockFetch,
        });

        try {
          await client.graphql("query { test }");
          expect().fail("例外がスローされるべき");
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(GitHubApiError);
          expect((err as GitHubApiError).message).toContain("data フィールドが含まれていません");
          expect((err as GitHubApiError).status).toBe(status);
        }
      },
    );
  });

  describe("parseRepository", () => {
    test("owner/name 形式の文字列を正しくパースする", () => {
      expect(parseRepository("microsoft/winget-pkgs")).toEqual({
        owner: "microsoft",
        name: "winget-pkgs",
      });
      expect(parseRepository("scottlz0310/winget-observatory")).toEqual({
        owner: "scottlz0310",
        name: "winget-observatory",
      });
    });

    test.each(["", "repo", "owner/repo/extra", "/repo", "owner/"])(
      "不正な形式の場合は 400 GitHubApiError をスローする: %s",
      (invalidRepo) => {
        expect(() => parseRepository(invalidRepo)).toThrow(GitHubApiError);
        try {
          parseRepository(invalidRepo);
        } catch (err: unknown) {
          expect((err as GitHubApiError).status).toBe(400);
        }
      },
    );
  });

  describe("isPrNotFoundGraphQLError", () => {
    test("NOT_FOUND かつ path に pullRequest を含む場合は true を返す", () => {
      const err = new GitHubGraphQLError("not found", 200, [
        {
          type: "NOT_FOUND",
          path: ["repository", "pullRequest"],
          message: "Could not resolve to a PullRequest with the number of 9999999.",
        },
      ]);
      expect(isPrNotFoundGraphQLError(err)).toBe(true);
    });

    test("Could not resolve to a PullRequest メッセージを含む場合は type 未指定でも true を返す", () => {
      const err = new GitHubGraphQLError("not found", 200, [
        {
          path: ["repository", "pullRequest"],
          message: "Could not resolve to a PullRequest with the number of 9999999.",
        },
      ]);
      expect(isPrNotFoundGraphQLError(err)).toBe(true);
    });

    test("FORBIDDEN や INTERNAL など認可・障害エラーが含まれる場合は false を返す", () => {
      const forbiddenErr = new GitHubGraphQLError("forbidden", 200, [
        {
          type: "FORBIDDEN",
          path: ["repository", "pullRequest"],
          message: "Resource not accessible by integration",
        },
      ]);
      expect(isPrNotFoundGraphQLError(forbiddenErr)).toBe(false);

      const internalErr = new GitHubGraphQLError("internal", 200, [
        {
          type: "INTERNAL",
          path: ["repository", "pullRequest"],
          message: "Something went wrong",
        },
      ]);
      expect(isPrNotFoundGraphQLError(internalErr)).toBe(false);
    });

    test("エラー配列が空または一般エラーの場合は false を返す", () => {
      expect(isPrNotFoundGraphQLError(new GitHubGraphQLError("empty", 200, []))).toBe(false);
      expect(isPrNotFoundGraphQLError(new Error("regular error"))).toBe(false);
    });
  });

  describe("isRetryableStatusCode", () => {
    test.each([429, 502, 503, 504])("リトライ対象ステータス %i は true を返す", (status) => {
      expect(isRetryableStatusCode(status)).toBe(true);
    });

    test.each([200, 201, 400, 401, 403, 404, 422, 500])(
      "非リトライ対象ステータス %i は false を返す",
      (status) => {
        expect(isRetryableStatusCode(status)).toBe(false);
      },
    );
  });

  describe("isSecondaryRateLimitResponse / isRetryableHttpResponse / computeRetryMinDelayMs", () => {
    test.each([
      { status: 429, body: "", retryAfter: null, expected: true },
      {
        status: 403,
        body: '{"message":"You have exceeded a secondary rate limit. Please wait."}',
        retryAfter: null,
        expected: true,
      },
      { status: 403, body: "Forbidden", retryAfter: "60", expected: true },
      {
        status: 403,
        body: "Resource not accessible by integration",
        retryAfter: null,
        expected: false,
      },
      { status: 403, body: "API rate limit exceeded", retryAfter: null, expected: false },
      { status: 404, body: "Not Found", retryAfter: "60", expected: false },
    ])(
      "セカンダリレート制限判定 (status=$status, retryAfter=$retryAfter) -> $expected",
      ({ status, body, retryAfter, expected }) => {
        expect(isSecondaryRateLimitResponse(status, body, retryAfter)).toBe(expected);
        expect(isRetryableHttpResponse(status, body, retryAfter)).toBe(expected);
      },
    );

    test("computeRetryMinDelayMs は Retry-After を優先し、未指定のセカンダリレート制限には secondaryRateLimitDelayMs を返す", () => {
      expect(
        computeRetryMinDelayMs({
          status: 403,
          bodyText: "You have exceeded a secondary rate limit.",
          retryAfterHeader: "30",
          secondaryRateLimitDelayMs: 60000,
        }),
      ).toBe(30000);
      expect(
        computeRetryMinDelayMs({
          status: 403,
          bodyText: "You have exceeded a secondary rate limit.",
          retryAfterHeader: null,
          secondaryRateLimitDelayMs: 45000,
        }),
      ).toBe(45000);
      expect(
        computeRetryMinDelayMs({
          status: 502,
          bodyText: "Bad Gateway",
          retryAfterHeader: null,
          secondaryRateLimitDelayMs: 60000,
        }),
      ).toBe(0);
    });
  });

  describe("calculateBackoffDelay", () => {
    test("ジッター 0 の場合、指数バックオフで 2000, 4000, 8000ms を返す", () => {
      expect(calculateBackoffDelay(1, 2000, 0)).toBe(2000);
      expect(calculateBackoffDelay(2, 2000, 0)).toBe(4000);
      expect(calculateBackoffDelay(3, 2000, 0)).toBe(8000);
    });

    test("ジッターがある場合、ベース待機時間以上かつベース待機時間 + maxJitterMs 未満の値を返す", () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const base = 2000 * 2 ** (attempt - 1);
        const delay = calculateBackoffDelay(attempt, 2000, 500);
        expect(delay).toBeGreaterThanOrEqual(base);
        expect(delay).toBeLessThan(base + 500);
      }
    });
  });

  describe("parseRetryAfterMs", () => {
    test("秒数文字列をミリ秒に変換する", () => {
      expect(parseRetryAfterMs("60")).toBe(60000);
      expect(parseRetryAfterMs("0")).toBe(0);
      expect(parseRetryAfterMs(" 120 ")).toBe(120000);
    });

    test("null, undefined, 不正文字列の場合は undefined を返す", () => {
      expect(parseRetryAfterMs(null)).toBeUndefined();
      expect(parseRetryAfterMs(undefined)).toBeUndefined();
      expect(parseRetryAfterMs("")).toBeUndefined();
      expect(parseRetryAfterMs("invalid")).toBeUndefined();
      expect(parseRetryAfterMs("-10")).toBeUndefined();
    });

    test("未来の HTTP-date 文字列を現在時刻からの差分ミリ秒に変換する", () => {
      const futureDate = new Date(Date.now() + 30000).toUTCString();
      const ms = parseRetryAfterMs(futureDate);
      expect(ms).toBeDefined();
      expect(ms).toBeGreaterThan(25000);
      expect(ms).toBeLessThanOrEqual(30000);
    });

    test("過去の HTTP-date 文字列は 0 にクランプする", () => {
      const pastDate = new Date(Date.now() - 30000).toUTCString();
      expect(parseRetryAfterMs(pastDate)).toBe(0);
    });
  });

  describe("分離モジュール (graphql-queries / retry) と互換 re-export の整合", () => {
    test("graphql-queries.ts と retry.ts のシンボルが github.ts からの re-export と一致する", () => {
      expect(SEARCH_ISSUES_QUERY).toBe(DIRECT_SEARCH_ISSUES_QUERY);
      expect(GET_RATE_LIMIT_QUERY).toBe(DIRECT_GET_RATE_LIMIT_QUERY);
      expect(GET_PULL_REQUEST_VIEW_QUERY).toBe(DIRECT_GET_PULL_REQUEST_VIEW_QUERY);
      expect(GET_PULL_REQUEST_DETAILS_QUERY).toBe(DIRECT_GET_PULL_REQUEST_DETAILS_QUERY);
      expect(GET_PULL_REQUEST_TIMELINE_QUERY).toBe(DIRECT_GET_PULL_REQUEST_TIMELINE_QUERY);
      expect(FIRST_TIMER_GRAPHQL_QUERY).toContain("authorAssociation");

      expect(RETRYABLE_STATUS_CODES).toBe(DIRECT_RETRYABLE_STATUS_CODES);
      expect(isRetryableStatusCode).toBe(directIsRetryableStatusCode);
      expect(calculateBackoffDelay).toBe(directCalculateBackoffDelay);
      expect(parseRetryAfterMs).toBe(directParseRetryAfterMs);
      expect(GitHubApiError).toBe(DirectGitHubApiError);
      expect(GitHubGraphQLError).toBe(DirectGitHubGraphQLError);
      expect(isPrNotFoundGraphQLError).toBe(directIsPrNotFoundGraphQLError);
      expect(DEFAULT_MAX_INTERVENTION_EXTRA_PAGES).toBe(
        DIRECT_DEFAULT_MAX_INTERVENTION_EXTRA_PAGES,
      );
      expect(resolvePrInterventionWithPaging).toBe(directResolvePrInterventionWithPaging);
    });
  });
});
