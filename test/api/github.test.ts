import { describe, expect, test } from "bun:test";
import { GitHubApiClient, GitHubApiError, parseRepository } from "../../src/api/github";

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

  test("getPullRequest は PR 基本情報を GraphQL で取得する", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(input);
      capturedBody = typeof init?.body === "string" ? init.body : "";
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 464302,
                title: "New package: sample",
                url: "https://github.com/microsoft/winget-pkgs/pull/464302",
                createdAt: "2026-10-28T21:47:38Z",
                updatedAt: "2026-11-02T03:00:00Z",
              },
            },
          },
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
    expect(pr.updatedAt).toBe("2026-11-02T03:00:00Z");
    expect(capturedUrl).toBe("https://api.github.com/graphql");
    expect(capturedHeaders.Authorization).toBe("Bearer sample-token");
    expect(capturedBody).toContain("GetPullRequestView");
    expect(capturedBody).toContain('"owner":"microsoft"');
    expect(capturedBody).toContain('"name":"winget-pkgs"');
    expect(capturedBody).toContain('"number":464302');
  });

  test("getPullRequest は PR が存在しない場合 404 GitHubApiError をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({
      token: "sample-token",
      fetch: mockFetch,
    });

    await expect(client.getPullRequest("microsoft/winget-pkgs", 999999)).rejects.toThrow(
      GitHubApiError,
    );
    try {
      await client.getPullRequest("microsoft/winget-pkgs", 999999);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
    }
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

    const origGithubToken = process.env.GITHUB_TOKEN;
    const origGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    try {
      const client = new GitHubApiClient({
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

  test("searchIssuesDetailed は totalCount と items を返す", async () => {
    const mockFetch = async (): Promise<Response> => {
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

    const client = new GitHubApiClient({ fetch: mockFetch });
    const res = await client.searchIssuesDetailed("repo:test/repo is:pr");

    expect(res.totalCount).toBe(42);
    expect(res.items.length).toBe(1);
    expect(res.items[0].number).toBe(200);
    expect(res.items[0].labels?.[0].name).toBe("New-Package");
  });

  test("getPullRequestDetails は PR 情報とコミット一覧を GraphQL 1 リクエストで統合して返す", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = String(input);
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 300,
                title: "PR 300",
                url: "https://github.com/test/repo/pull/300",
                state: "OPEN",
                isDraft: false,
                createdAt: "2026-11-01T10:00:00Z",
                updatedAt: "2026-11-02T10:00:00Z",
                mergedAt: null,
                closedAt: null,
                author: { login: "test-author" },
                authorAssociation: "CONTRIBUTOR",
                labels: {
                  nodes: [{ name: "New-Package" }, { name: "Validation-Completed" }],
                },
                commits: {
                  totalCount: 1,
                  nodes: [
                    {
                      commit: {
                        oid: "abcdef123456",
                        messageHeadline: "Initial commit",
                        committedDate: "2026-11-01T12:00:00Z",
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    const pr = await client.getPullRequestDetails("test/repo", 300);

    expect(capturedUrl).toBe("https://api.github.com/graphql");
    expect(capturedBody).toContain("GetPullRequestDetails");
    expect(capturedBody).toContain('"owner":"test"');
    expect(capturedBody).toContain('"name":"repo"');
    expect(capturedBody).toContain('"number":300');

    expect(pr.number).toBe(300);
    expect(pr.state).toBe("OPEN");
    expect(pr.author).toBe("test-author");
    expect(pr.authorAssociation).toBe("CONTRIBUTOR");
    expect(pr.labels).toEqual(["New-Package", "Validation-Completed"]);
    expect(pr.commits.length).toBe(1);
    expect(pr.commits[0].oid).toBe("abcdef123456");
    expect(pr.commits[0].messageHeadline).toBe("Initial commit");
    expect(pr.commits[0].committedDate).toBe("2026-11-01T12:00:00Z");
  });

  test("getPullRequestDetails は PR が存在しない場合 404 GitHubApiError をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: null,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    await expect(client.getPullRequestDetails("test/repo", 999)).rejects.toThrow(GitHubApiError);
    try {
      await client.getPullRequestDetails("test/repo", 999);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
    }
  });

  test("getIssueTimeline はページネーションして全イベントを取得する", async () => {
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

    const client = new GitHubApiClient({ fetch: mockFetch });
    const events = await client.getIssueTimeline("test/repo", 300);

    expect(callCount).toBe(2);
    expect(events.length).toBe(2);
    expect(events[0].label?.name).toBe("New-Package");
    expect(events[1].label?.name).toBe("Validation-Completed");
  });

  test("getPullRequestDetails は GraphQL エラー発生時に例外をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          errors: [{ message: "Repository not found" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    await expect(client.getPullRequestDetails("test/repo", 301)).rejects.toThrow(GitHubApiError);
  });

  test("searchIssuesDetailed は page 引数を URL に付与する", async () => {
    let capturedUrl = "";
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
    };

    const client = new GitHubApiClient({ fetch: mockFetch });
    await client.searchIssuesDetailed("test", "created", "asc", 30, 3);
    expect(capturedUrl).toContain("page=3");
  });

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

    test("HTTP エラー発生時にステータス付き GitHubApiError をスローする", async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response("Bad Gateway", { status: 502 });
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
        expect((err as GitHubApiError).status).toBe(502);
        expect((err as GitHubApiError).message).toContain("502");
        expect((err as GitHubApiError).message).toContain("Bad Gateway");
      }
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

    test("data フィールドが含まれていない場合に例外をスローする", async () => {
      const mockFetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: mockFetch,
      });

      await expect(client.graphql("query { test }")).rejects.toThrow(
        "data フィールドが含まれていません",
      );
    });
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
});
