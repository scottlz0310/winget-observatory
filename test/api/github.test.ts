import { describe, expect, test } from "bun:test";
import {
  calculateBackoffDelay,
  GitHubApiClient,
  GitHubApiError,
  GitHubGraphQLError,
  isPrNotFoundGraphQLError,
  isRetryableStatusCode,
  parseRepository,
  parseRetryAfterMs,
} from "../../src/api/github";

describe("API: GitHubApiClient", () => {
  test("searchIssues は GraphQL 経由で検索を実行しアイテム一覧を返す", async () => {
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
            search: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 101,
                  title: "Test PR 101",
                  url: "https://github.com/test/repo/pull/101",
                  createdAt: "2026-11-01T00:00:00Z",
                  updatedAt: "2026-11-02T00:00:00Z",
                  author: { login: "tester" },
                  authorAssociation: "CONTRIBUTOR",
                },
              ],
            },
          },
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
    expect(items[0].html_url).toBe("https://github.com/test/repo/pull/101");
    expect(items[0].author).toBe("tester");
    expect(items[0].author_association).toBe("CONTRIBUTOR");
    expect(capturedUrl).toContain("/graphql");
    const parsedBody = JSON.parse(capturedBody) as {
      variables: { query: string; first: number };
    };
    expect(parsedBody.variables.query).toBe("repo:microsoft/winget-pkgs is:pr sort:created-asc");
    expect(parsedBody.variables.first).toBe(3);
    expect(capturedHeaders.Authorization).toBe("Bearer dummy-token-xyz");
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

  test("getPullRequest は PR が存在しない場合（実 API の NOT_FOUND errors 応答）404 GitHubApiError をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: null,
            },
          },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository", "pullRequest"],
              locations: [{ line: 1, column: 63 }],
              message: "Could not resolve to a PullRequest with the number of 9999999.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({
      token: "sample-token",
      fetch: mockFetch,
    });

    await expect(client.getPullRequest("microsoft/winget-pkgs", 9999999)).rejects.toThrow(
      GitHubApiError,
    );
    try {
      await client.getPullRequest("microsoft/winget-pkgs", 9999999);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
    }
  });

  test.each([
    [
      "FORBIDDEN",
      "Resource not accessible by integration",
      {
        type: "FORBIDDEN",
        path: ["repository", "pullRequest"],
        message: "Resource not accessible by integration",
      },
    ],
    [
      "INTERNAL",
      "An unexpected error occurred",
      {
        type: "INTERNAL",
        path: ["repository", "pullRequest"],
        message: "An unexpected error occurred",
      },
    ],
  ])(
    "getPullRequest は同じ path の %s エラーを 404 に誤変換せず元のエラーを保持する",
    async (_type, msg, errorObj) => {
      const mockFetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            errors: [errorObj],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new GitHubApiClient({
        token: "sample-token",
        fetch: mockFetch,
      });

      await expect(client.getPullRequest("microsoft/winget-pkgs", 100)).rejects.toThrow(
        GitHubApiError,
      );
      try {
        await client.getPullRequest("microsoft/winget-pkgs", 100);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).status).toBe(200);
        expect((err as GitHubApiError).message).toContain(msg);
      }
    },
  );

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

  test("searchIssuesDetailed は GraphQL 経由で totalCount と items を返す", async () => {
    let capturedBody = "";
    const mockFetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          data: {
            search: {
              issueCount: 42,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 200,
                  title: "Issue 200",
                  url: "https://github.com/test/repo/issues/200",
                  createdAt: "2026-11-01T00:00:00Z",
                  updatedAt: "2026-11-02T00:00:00Z",
                  isDraft: false,
                  labels: { nodes: [{ name: "New-Package" }] },
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    const res = await client.searchIssuesDetailed("repo:test/repo is:pr");

    expect(res.totalCount).toBe(42);
    expect(res.items.length).toBe(1);
    expect(res.items[0].number).toBe(200);
    expect(res.items[0].labels?.[0].name).toBe("New-Package");
    const parsedBody = JSON.parse(capturedBody) as { variables: { query: string } };
    expect(parsedBody.variables.query).toContain("sort:created-asc");
  });

  test("searchIssuesDetailed は cursor 引数を受け取って直接そのカーソルで検索する", async () => {
    let capturedBody = "";
    const mockFetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          data: {
            search: {
              issueCount: 100,
              pageInfo: { hasNextPage: true, endCursor: "next-cursor-123" },
              nodes: [
                {
                  number: 201,
                  title: "Issue 201",
                  url: "https://github.com/test/repo/issues/201",
                  createdAt: "2026-11-01T00:00:00Z",
                  updatedAt: "2026-11-02T00:00:00Z",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    const res = await client.searchIssuesDetailed(
      "repo:test/repo is:pr",
      "updated",
      "desc",
      30,
      1,
      "cursor-xyz",
    );

    const parsedBody = JSON.parse(capturedBody) as {
      variables: { query: string; first: number; after: string };
    };
    expect(parsedBody.variables.after).toBe("cursor-xyz");
    expect(parsedBody.variables.first).toBe(30);
    expect(res.pageInfo?.endCursor).toBe("next-cursor-123");
    expect(res.items[0].number).toBe(201);
  });

  test("searchIssuesDetailed は cursor 未指定で page > 1 の場合に前ページから走査して指定ページを返す", async () => {
    let callCount = 0;
    const requestedCursors: (string | null | undefined)[] = [];

    const mockFetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      callCount++;
      const body = JSON.parse(String(init?.body)) as {
        variables: { after?: string | null };
      };
      requestedCursors.push(body.variables.after);

      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            data: {
              search: {
                issueCount: 50,
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
                nodes: [
                  {
                    number: 101,
                    title: "PR 101",
                    url: "https://x/101",
                    createdAt: "2026-01-01",
                    updatedAt: "2026-01-01",
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          data: {
            search: {
              issueCount: 50,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 102,
                  title: "PR 102",
                  url: "https://x/102",
                  createdAt: "2026-01-02",
                  updatedAt: "2026-01-02",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    const res = await client.searchIssuesDetailed("repo:test/repo is:pr", "created", "asc", 10, 2);

    expect(callCount).toBe(2);
    expect(requestedCursors).toEqual([null, "cursor-1"]);
    expect(res.items.length).toBe(1);
    expect(res.items[0].number).toBe(102);
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

  test("getPullRequestDetails は PR が存在しない場合（実 API の NOT_FOUND errors 応答）404 GitHubApiError をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: null,
            },
          },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository", "pullRequest"],
              locations: [{ line: 1, column: 63 }],
              message: "Could not resolve to a PullRequest with the number of 9999999.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    await expect(client.getPullRequestDetails("test/repo", 9999999)).rejects.toThrow(
      GitHubApiError,
    );
    try {
      await client.getPullRequestDetails("test/repo", 9999999);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
    }
  });

  test.each([
    [
      "FORBIDDEN",
      "Resource not accessible by integration",
      {
        type: "FORBIDDEN",
        path: ["repository", "pullRequest"],
        message: "Resource not accessible by integration",
      },
    ],
    [
      "INTERNAL",
      "An unexpected error occurred",
      {
        type: "INTERNAL",
        path: ["repository", "pullRequest"],
        message: "An unexpected error occurred",
      },
    ],
  ])(
    "getPullRequestDetails は同じ path の %s エラーを 404 に誤変換せず元のエラーを保持する",
    async (_type, msg, errorObj) => {
      const mockFetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            errors: [errorObj],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
      await expect(client.getPullRequestDetails("test/repo", 100)).rejects.toThrow(GitHubApiError);
      try {
        await client.getPullRequestDetails("test/repo", 100);
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(GitHubApiError);
        expect((err as GitHubApiError).status).toBe(200);
        expect((err as GitHubApiError).message).toContain(msg);
      }
    },
  );

  test("getIssueTimeline は GraphQL 経由でページネーションして全イベントを取得する", async () => {
    let callCount = 0;
    const requestedCursors: (string | null | undefined)[] = [];

    const mockFetch = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      callCount++;
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { owner: string; name: string; number: number; after?: string | null };
      };
      requestedCursors.push(body.variables.after);

      if (callCount === 1) {
        expect(body.variables.owner).toBe("test");
        expect(body.variables.name).toBe("repo");
        expect(body.variables.number).toBe(300);
        expect(body.variables.after).toBeNull();
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  timelineItems: {
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "cursor-page-1",
                    },
                    nodes: [
                      {
                        __typename: "LabeledEvent",
                        createdAt: "2026-11-01T10:00:00Z",
                        label: { name: "New-Package" },
                      },
                      {
                        __typename: "ConvertToDraftEvent",
                        createdAt: "2026-11-01T10:30:00Z",
                      },
                    ],
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      expect(body.variables.after).toBe("cursor-page-1");
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                  nodes: [
                    {
                      __typename: "ReadyForReviewEvent",
                      createdAt: "2026-11-01T11:00:00Z",
                    },
                    {
                      __typename: "LabeledEvent",
                      createdAt: "2026-11-01T11:30:00Z",
                      label: { name: "Validation-Completed" },
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
    const events = await client.getIssueTimeline("test/repo", 300);

    expect(callCount).toBe(2);
    expect(requestedCursors).toEqual([null, "cursor-page-1"]);
    expect(events.length).toBe(4);
    expect(events[0]).toEqual({
      event: "labeled",
      created_at: "2026-11-01T10:00:00Z",
      label: { name: "New-Package" },
    });
    expect(events[1]).toEqual({
      event: "converted_to_draft",
      created_at: "2026-11-01T10:30:00Z",
    });
    expect(events[2]).toEqual({
      event: "ready_for_review",
      created_at: "2026-11-01T11:00:00Z",
    });
    expect(events[3]).toEqual({
      event: "labeled",
      created_at: "2026-11-01T11:30:00Z",
      label: { name: "Validation-Completed" },
    });
  });

  test("getIssueTimeline は maxPages に達したら走査を打ち切る", async () => {
    let callCount = 0;
    const mockFetch = async (): Promise<Response> => {
      callCount++;
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  pageInfo: {
                    hasNextPage: true,
                    endCursor: `cursor-${callCount}`,
                  },
                  nodes: [
                    {
                      __typename: "LabeledEvent",
                      createdAt: "2026-11-01T10:00:00Z",
                      label: { name: "Test" },
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
    const events = await client.getIssueTimeline("test/repo", 300, 1);

    expect(callCount).toBe(1);
    expect(events.length).toBe(1);
  });

  test("getIssueTimeline は NOT_FOUND GraphQL エラー発生時に 404 GitHubApiError をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: { repository: null },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository", "pullRequest"],
              message: "Could not resolve to a PullRequest with the number of 999.",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    try {
      await client.getIssueTimeline("test/repo", 999);
      expect().fail("例外が発生するべきです");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
      expect((err as GitHubApiError).message).toContain("#999, status 404");
    }
  });

  test("getIssueTimeline は pullRequest が null の場合に 404 GitHubApiError をスローする", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: { repository: { pullRequest: null } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    try {
      await client.getIssueTimeline("test/repo", 999);
      expect().fail("例外が発生するべきです");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(404);
    }
  });

  test("getIssueTimeline は FORBIDDEN / INTERNAL エラー時に 404 へ変換せず元のエラーを保持する", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          data: { repository: null },
          errors: [
            {
              type: "FORBIDDEN",
              path: ["repository", "pullRequest"],
              message: "Resource not accessible by integration",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    try {
      await client.getIssueTimeline("test/repo", 300);
      expect().fail("例外が発生するべきです");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(GitHubGraphQLError);
      expect((err as GitHubGraphQLError).status).toBe(200);
      expect((err as GitHubGraphQLError).message).toContain(
        "Resource not accessible by integration",
      );
    }
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

    test("200 応答だが JSON 構文エラーの場合はリトライせず即座にエラーをスローする", async () => {
      let attempts = 0;
      const sleepDelays: number[] = [];

      const mockFetch = async (): Promise<Response> => {
        attempts++;
        return new Response("<html><body>502 Bad Gateway Proxy Error</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
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

      await expect(client.graphql("query { test }")).rejects.toThrow(
        "応答 JSON パースに失敗しました",
      );
      expect(attempts).toBe(1);
      expect(sleepDelays.length).toBe(0);
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
  });
});
