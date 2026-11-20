import { describe, expect, test } from "bun:test";
import {
  GitHubApiClient,
  GitHubApiError,
  GitHubGraphQLError,
  resolvePrInterventionWithPaging,
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

  test("getPullRequest は author と assignees から thirdPartyAssignees を返す", async () => {
    const mockFetch = async (): Promise<Response> => {
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
                author: { login: "scottlz0310" },
                assignees: { nodes: [{ login: "scottlz0310" }, { login: "stephengillie" }] },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "sample-token", fetch: mockFetch });
    const pr = await client.getPullRequest("microsoft/winget-pkgs", 464302);
    expect(pr.author).toBe("scottlz0310");
    expect(pr.thirdPartyAssignees).toEqual(["stephengillie"]);
  });

  test("getPullRequest は 1 ページ目で未介入かつ comments に次ページがある場合のみ追加ページングして介入を検出する", async () => {
    const calledOperations: string[] = [];
    const mockFetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
        variables?: Record<string, unknown>;
      };
      const q = parsed.query ?? "";
      if (q.includes("GetPullRequestView")) {
        calledOperations.push("view");
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
                  author: { __typename: "User", login: "scottlz0310" },
                  assignees: { nodes: [] },
                  reviews: {
                    totalCount: 0,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                  comments: {
                    totalCount: 22,
                    pageInfo: { hasNextPage: true, endCursor: "c-page1" },
                    nodes: [
                      {
                        author: { __typename: "Bot", login: "microsoft-github-policy-service" },
                        body: "CLA",
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
      if (q.includes("GetPullRequestCommentsPage")) {
        calledOperations.push("comments-page");
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    totalCount: 22,
                    pageInfo: { hasNextPage: true, endCursor: "c-page2" },
                    nodes: [
                      {
                        author: { __typename: "User", login: "stephengillie" },
                        body: "Need privacy policy",
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
      throw new Error(`想定外のクエリ呼び出し: ${q}`);
    };

    const client = new GitHubApiClient({ token: "sample-token", fetch: mockFetch });
    const pr = await client.getPullRequest("microsoft/winget-pkgs", 464302);
    expect(calledOperations).toEqual(["view", "comments-page"]);
    expect(pr.intervention?.Intervened).toBe(true);
    expect(pr.intervention?.PrimaryBadge?.Label).toBe("コメント済: stephengillie");
  });

  test("resolvePrInterventionWithPaging は reviews の追加ページングで人間レビューを検出したら即終了し、comments の追加ページングを呼ばない", async () => {
    const calledQueries: string[] = [];
    const initialNode = {
      number: 700,
      author: { __typename: "User", login: "submitter" },
      assignees: { nodes: [] },
      reviews: {
        totalCount: 22,
        pageInfo: { hasNextPage: true, endCursor: "r-page1" },
        nodes: [
          {
            author: { __typename: "Bot", login: "copilot-pull-request-reviewer" },
            state: "COMMENTED",
          },
        ],
      },
      comments: {
        totalCount: 25,
        pageInfo: { hasNextPage: true, endCursor: "c-page1" },
        nodes: [
          { author: { __typename: "Bot", login: "microsoft-github-policy-service" }, body: "CLA" },
        ],
      },
    };

    const { summary } = await resolvePrInterventionWithPaging(
      async <T>(query: string): Promise<T> => {
        calledQueries.push(query);
        if (query.includes("GetPullRequestReviewsPage")) {
          return {
            repository: {
              pullRequest: {
                reviews: {
                  totalCount: 22,
                  pageInfo: { hasNextPage: true, endCursor: "r-page2" },
                  nodes: [
                    { author: { __typename: "User", login: "matteozanettii" }, state: "APPROVED" },
                  ],
                },
              },
            },
          } as unknown as T;
        }
        throw new Error(`想定外の追加ページング: ${query}`);
      },
      "microsoft",
      "winget-pkgs",
      initialNode,
    );

    expect(calledQueries.length).toBe(1);
    expect(calledQueries[0]).toContain("GetPullRequestReviewsPage");
    expect(summary.Intervened).toBe(true);
    expect(summary.PrimaryBadge?.Label).toBe("レビュー済: matteozanettii (APPROVED)");
  });

  test.each<{
    name: string;
    connection: "reviews" | "comments";
    hasNextPage: boolean;
    endCursor: string | null;
    nextCursor?: string | null;
    expectedMessage: string;
  }>([
    {
      name: "reviews が追加ページング上限到達時に未介入として確定せずエラーにする",
      connection: "reviews",
      hasNextPage: true,
      endCursor: "r-cursor-1",
      nextCursor: "r-cursor-2",
      expectedMessage:
        "reviews が追加ページング上限 (1 ページ) に達したため、未介入と確定できません",
    },
    {
      name: "comments が追加ページング上限到達時に未介入として確定せずエラーにする",
      connection: "comments",
      hasNextPage: true,
      endCursor: "c-cursor-1",
      nextCursor: "c-cursor-2",
      expectedMessage:
        "comments が追加ページング上限 (1 ページ) に達したため、未介入と確定できません",
    },
    {
      name: "reviews で hasNextPage=true かつ endCursor 欠落時はエラーにする",
      connection: "reviews",
      hasNextPage: true,
      endCursor: null,
      expectedMessage: "reviews ページングで hasNextPage=true ですが endCursor が欠落しているため",
    },
    {
      name: "comments で同一カーソル連続返却時は無限ループを止めてエラーにする",
      connection: "comments",
      hasNextPage: true,
      endCursor: "c-same",
      nextCursor: "c-same",
      expectedMessage: "comments ページングでカーソルが進まないため",
    },
  ])(
    "resolvePrInterventionWithPaging fail-closed: $name",
    async ({ connection, hasNextPage, endCursor, nextCursor, expectedMessage }) => {
      const initialNode = {
        number: 701,
        author: { __typename: "User", login: "submitter" },
        assignees: { nodes: [] },
        reviews:
          connection === "reviews"
            ? {
                pageInfo: { hasNextPage, endCursor },
                nodes: [
                  {
                    author: { __typename: "Bot", login: "copilot-pull-request-reviewer" },
                    state: "COMMENTED",
                  },
                ],
              }
            : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        comments:
          connection === "comments"
            ? {
                pageInfo: { hasNextPage, endCursor },
                nodes: [
                  {
                    author: { __typename: "Bot", login: "microsoft-github-policy-service" },
                    body: "CLA",
                  },
                ],
              }
            : { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      };

      await expect(
        resolvePrInterventionWithPaging(
          async <T>(query: string): Promise<T> => {
            if (query.includes("GetPullRequestReviewsPage")) {
              return {
                repository: {
                  pullRequest: {
                    reviews: {
                      pageInfo: { hasNextPage: true, endCursor: nextCursor ?? null },
                      nodes: [
                        {
                          author: { __typename: "Bot", login: "copilot-pull-request-reviewer" },
                          state: "COMMENTED",
                        },
                      ],
                    },
                  },
                },
              } as unknown as T;
            }
            return {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: nextCursor ?? null },
                    nodes: [
                      {
                        author: { __typename: "Bot", login: "microsoft-github-policy-service" },
                        body: "CLA",
                      },
                    ],
                  },
                },
              },
            } as unknown as T;
          },
          "microsoft",
          "winget-pkgs",
          initialNode,
          1,
        ),
      ).rejects.toThrow(expectedMessage);
    },
  );

  test.each([
    {
      name: "comments 後続ページの手動コメントで FirstHumanInterventionAt を取得する",
      reviewsHasNext: false,
      commentsHasNext: true,
      extraReviewNodes: [],
      extraCommentNodes: [
        {
          author: { login: "reviewer-b" },
          authorAssociation: "MEMBER",
          body: "Looks good, please fix typo",
          createdAt: "2026-11-18T12:00:00Z",
          lastEditedAt: null,
        },
      ],
      expectedHumanReviews: 0,
      expectedManualComments: 1,
      expectedFirstHumanAt: "2026-11-18T12:00:00.000Z",
      expectedBadgeLabel: "コメント済: reviewer-b",
    },
    {
      name: "reviews 後続ページの人間レビューで FirstHumanInterventionAt を取得する",
      reviewsHasNext: true,
      commentsHasNext: false,
      extraReviewNodes: [
        {
          author: { login: "winget-maintainer" },
          state: "APPROVED",
          submittedAt: "2026-11-18T15:00:00Z",
        },
      ],
      extraCommentNodes: [],
      expectedHumanReviews: 1,
      expectedManualComments: 0,
      expectedFirstHumanAt: "2026-11-18T15:00:00.000Z",
      expectedBadgeLabel: "レビュー済: winget-maintainer (APPROVED)",
    },
  ])(
    "resolvePrInterventionWithPaging は特権ロールの自動指摘のみで Intervened=true になっても $name",
    async ({
      reviewsHasNext,
      commentsHasNext,
      extraReviewNodes,
      extraCommentNodes,
      expectedHumanReviews,
      expectedManualComments,
      expectedFirstHumanAt,
      expectedBadgeLabel,
    }) => {
      let pageCalls = 0;
      const initialNode: Parameters<typeof resolvePrInterventionWithPaging>[3] = {
        number: 439626,
        author: { login: "contributor-a" },
        assignees: { nodes: [] },
        reviews: {
          pageInfo: { hasNextPage: reviewsHasNext, endCursor: reviewsHasNext ? "r1" : null },
          nodes: [
            {
              author: { __typename: "Bot", login: "msftbot" },
              state: "COMMENTED",
              submittedAt: "2026-10-30T06:00:00Z",
            },
          ],
        },
        comments: {
          pageInfo: { hasNextPage: commentsHasNext, endCursor: commentsHasNext ? "c1" : null },
          nodes: [
            {
              author: { __typename: "User", login: "stephengillie" },
              authorAssociation: "COLLABORATOR",
              body: "This PR cannot be merged.\n\n(Deterministic automation)",
              createdAt: "2026-10-30T06:18:49Z",
              lastEditedAt: null,
            },
          ],
        },
        timelineItems: { nodes: [] },
      };

      const { summary } = await resolvePrInterventionWithPaging(
        async <T>(_query: string, variables?: Record<string, unknown>): Promise<T> => {
          pageCalls += 1;
          expect(variables).toMatchObject({
            owner: "microsoft",
            name: "winget-pkgs",
            number: 439626,
          });
          return {
            repository: {
              pullRequest: {
                reviews: reviewsHasNext
                  ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: extraReviewNodes }
                  : undefined,
                comments: commentsHasNext
                  ? { pageInfo: { hasNextPage: false, endCursor: null }, nodes: extraCommentNodes }
                  : undefined,
              },
            },
          } as T;
        },
        "microsoft",
        "winget-pkgs",
        initialNode,
      );

      expect(pageCalls).toBe(1);
      expect(summary.Intervened).toBe(true);
      expect(summary.PrivilegedAutomationCommentCount).toBe(1);
      expect(summary.HumanReviewCount).toBe(expectedHumanReviews);
      expect(summary.ManualCommentCount).toBe(expectedManualComments);
      expect(summary.FirstHumanInterventionAt).toBe(expectedFirstHumanAt);
      expect(summary.PrimaryBadge?.Label).toBe(expectedBadgeLabel);
    },
  );

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
    const parsedBody = JSON.parse(capturedBody) as { variables: { query: string } };
    expect(parsedBody.variables.query).toContain("sort:created-asc");
  });

  test("searchIssuesDetailed は perPage <= 0 のとき SEARCH_COUNT_QUERY を使い issueCount のみ取得する", async () => {
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
              issueCount: 123,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    const res = await client.searchIssuesDetailed("repo:test/repo is:pr", "updated", "asc", 0);

    expect(res.totalCount).toBe(123);
    expect(res.items).toEqual([]);
    expect(capturedBody).toContain("SearchIssueCount");
    expect(capturedBody).not.toContain("nodes");
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
    expect(pr.commitCount).toBe(1);
    expect(pr.labels).toEqual(["New-Package", "Validation-Completed"]);
    expect(pr.commits.length).toBe(1);
    expect(pr.commits[0].oid).toBe("abcdef123456");
    expect(pr.commits[0].messageHeadline).toBe("Initial commit");
    expect(pr.commits[0].committedDate).toBe("2026-11-01T12:00:00Z");
  });

  test("getPullRequestState は state と mergedAt のみを軽量に取得し、NOT_FOUND 時は 404 を返す", async () => {
    let capturedBody = "";
    const mockFetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      if (capturedBody.includes('"number":999')) {
        return new Response(
          JSON.stringify({
            data: { repository: { pullRequest: null } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                state: "CLOSED",
                mergedAt: "2026-11-10T00:00:00Z",
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const client = new GitHubApiClient({ token: "test-token", fetch: mockFetch });
    const state = await client.getPullRequestState("test/repo", 300);
    expect(capturedBody).toContain("GetPullRequestState");
    expect(state).toEqual({ state: "MERGED", mergedAt: "2026-11-10T00:00:00Z" });
    await expect(client.getPullRequestState("test/repo", 999)).rejects.toThrow(GitHubApiError);
  });

  test("getPullRequestSampleData は 1 リクエストでメタデータとタイムラインを統合取得し、次ページがあればページングする", async () => {
    const capturedBodies: string[] = [];
    const mockFetch = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const body = typeof init?.body === "string" ? init.body : "";
      capturedBodies.push(body);
      if (body.includes('"number":999')) {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: null } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (capturedBodies.length === 1) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  createdAt: "2026-11-01T00:00:00Z",
                  author: { __typename: "User", login: "sample-user" },
                  authorAssociation: "CONTRIBUTOR",
                  commits: {
                    totalCount: 3,
                    nodes: [{ commit: { committedDate: "2026-11-02T00:00:00Z" } }],
                  },
                  timelineItems: {
                    pageInfo: { hasNextPage: true, endCursor: "tl-c1" },
                    nodes: [
                      {
                        __typename: "LabeledEvent",
                        createdAt: "2026-11-01T01:00:00Z",
                        label: { name: "New-Package" },
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
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: "LabeledEvent",
                      createdAt: "2026-11-01T02:00:00Z",
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
    const sample = await client.getPullRequestSampleData("test/repo", 300);

    expect(capturedBodies.length).toBe(2);
    expect(capturedBodies[0]).toContain("GetPullRequestSample");
    expect(capturedBodies[1]).toContain("GetPullRequestTimeline");
    expect(sample.createdAt).toBe("2026-11-01T00:00:00Z");
    expect(sample.commitCount).toBe(3);
    expect(sample.latestCommittedDate).toBe("2026-11-02T00:00:00Z");
    expect(sample.author).toBe("sample-user");
    expect(sample.authorType).toBe("User");
    expect(sample.authorAssociation).toBe("CONTRIBUTOR");
    expect(sample.timeline.length).toBe(2);

    await expect(client.getPullRequestSampleData("test/repo", 999)).rejects.toThrow(GitHubApiError);
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
});
