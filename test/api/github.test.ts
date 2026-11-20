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
