import { describe, expect, test } from "bun:test";
import { parseCliArgs, runCompare } from "../../scripts/compare-rest-graphql";
import { GitHubApiClient } from "../../src/api/github";

describe("Scripts: compare-rest-graphql", () => {
  describe("parseCliArgs", () => {
    test("既定のオプションを正しく解析する", () => {
      const options = parseCliArgs([]);
      expect(options.repository).toBe("microsoft/winget-pkgs");
      expect(options.sort).toBe("created");
      expect(options.order).toBe("asc");
      expect(options.perPage).toBe(10);
      expect(options.asJson).toBeFalse();
    });

    test("CLI フラグで指定された引数を上書きできる", () => {
      const options = parseCliArgs([
        "--repository",
        "owner/my-repo",
        "--target-pr",
        "42",
        "--query",
        "is:pr is:open",
        "--sort",
        "updated",
        "--order",
        "desc",
        "--per-page",
        "25",
        "--json",
      ]);

      expect(options.repository).toBe("owner/my-repo");
      expect(options.targetPr).toBe(42);
      expect(options.query).toBe("is:pr is:open");
      expect(options.sort).toBe("updated");
      expect(options.order).toBe("desc");
      expect(options.perPage).toBe(25);
      expect(options.asJson).toBeTrue();
    });
  });

  describe("runCompare", () => {
    test("モッククライアントを使用して正常に比較レポートを生成できる", async () => {
      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = String(input);

        // rate_limit
        if (urlStr.includes("/rate_limit")) {
          return new Response(
            JSON.stringify({
              resources: {
                core: { limit: 5000, remaining: 4999, reset: 1700000000 },
                search: { limit: 30, remaining: 29, reset: 1700000000 },
              },
            }),
            { status: 200 },
          );
        }

        // search issues
        if (urlStr.includes("/search/issues")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              items: [
                {
                  number: 100,
                  title: "Test PR",
                  html_url: "https://github.com/owner/repo/pull/100",
                  created_at: "2026-10-01T00:00:00Z",
                  updated_at: "2026-10-02T00:00:00Z",
                  labels: [{ name: "New-Package" }],
                  draft: false,
                },
              ],
            }),
            { status: 200 },
          );
        }

        // get pull request details
        if (urlStr.includes("/repos/owner/repo/pulls/100/commits")) {
          return new Response(
            JSON.stringify([
              {
                sha: "aaa111",
                commit: {
                  message: "feat: add pkg",
                  committer: { date: "2026-10-01T00:00:00Z" },
                },
              },
            ]),
            { status: 200 },
          );
        }

        if (urlStr.includes("/repos/owner/repo/pulls/100")) {
          return new Response(
            JSON.stringify({
              number: 100,
              title: "Test PR",
              html_url: "https://github.com/owner/repo/pull/100",
              state: "open",
              draft: false,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
              labels: [{ name: "New-Package" }],
              user: { login: "tester" },
              author_association: "NONE",
            }),
            { status: 200 },
          );
        }

        // get timeline
        if (urlStr.includes("/repos/owner/repo/issues/100/timeline")) {
          return new Response(
            JSON.stringify([
              {
                event: "labeled",
                created_at: "2026-10-01T00:00:00Z",
                label: { name: "New-Package" },
              },
            ]),
            { status: 200 },
          );
        }

        // graphql
        if (urlStr.includes("/graphql")) {
          const body = JSON.parse(String(init?.body));
          const query = String(body.query);

          if (query.includes("CompareRateLimit") || query.includes("GetRateLimit")) {
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    limit: 5000,
                    cost: 1,
                    remaining: 4995,
                    resetAt: "2026-10-01T00:00:00Z",
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareSearch")) {
            return new Response(
              JSON.stringify({
                data: {
                  search: {
                    issueCount: 1,
                    nodes: [
                      {
                        number: 100,
                        title: "Test PR",
                        url: "https://github.com/owner/repo/pull/100",
                        createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: "2026-10-02T00:00:00Z",
                        isDraft: false,
                        mergedAt: null,
                        author: { login: "tester" },
                        authorAssociation: "NONE",
                        labels: { nodes: [{ name: "New-Package" }] },
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("ComparePullRequest") || query.includes("GetPullRequestDetails")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      number: 100,
                      title: "Test PR",
                      url: "https://github.com/owner/repo/pull/100",
                      state: "OPEN",
                      isDraft: false,
                      createdAt: "2026-10-01T00:00:00Z",
                      updatedAt: "2026-10-02T00:00:00Z",
                      mergedAt: null,
                      closedAt: null,
                      author: { login: "tester" },
                      authorAssociation: "NONE",
                      labels: { nodes: [{ name: "New-Package" }] },
                      commits: {
                        nodes: [
                          {
                            commit: {
                              oid: "aaa111",
                              messageHeadline: "feat: add pkg",
                              committedDate: "2026-10-01T00:00:00Z",
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareTimeline")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      timelineItems: {
                        nodes: [
                          {
                            __typename: "LabeledEvent",
                            createdAt: "2026-10-01T00:00:00Z",
                            label: { name: "New-Package" },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: fakeFetch,
      });

      const report = await runCompare(
        {
          repository: "owner/repo",
          targetPr: 100,
        },
        client,
      );

      expect(report.repository).toBe("owner/repo");
      expect(report.rateLimit.rest.core.limit).toBe(5000);
      expect(report.rateLimit.graphql.cost).toBe(1);
      expect(report.search.totalCountMatch).toBeTrue();
      expect(report.search.itemCountMatch).toBeTrue();
      expect(report.search.orderMatch).toBeTrue();
      expect(report.prDetail).toBeDefined();
      expect(report.prDetail?.diff.match).toBeTrue();
      expect(report.timeline).toBeDefined();
      expect(report.timeline?.diff.countMatch).toBeTrue();
    });

    test("タイムラインが101件以上ある場合、GraphQLもページネーションして全イベントが判定に反映される", async () => {
      // 101件のイベントを作成: 1〜100件目は通常ラベル、101件目は ConvertToDraftEvent
      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = String(input);

        if (urlStr.includes("/rate_limit")) {
          return new Response(
            JSON.stringify({
              resources: {
                core: { limit: 5000, remaining: 5000, reset: 1700000000 },
                search: { limit: 30, remaining: 30, reset: 1700000000 },
              },
            }),
            { status: 200 },
          );
        }

        if (urlStr.includes("/search/issues")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              items: [
                {
                  number: 200,
                  title: "101 Events PR",
                  html_url: "https://github.com/owner/repo/pull/200",
                  created_at: "2026-10-01T00:00:00Z",
                  updated_at: "2026-10-02T00:00:00Z",
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (urlStr.includes("/repos/owner/repo/pulls/200/commits")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (urlStr.includes("/repos/owner/repo/pulls/200")) {
          return new Response(
            JSON.stringify({
              number: 200,
              title: "101 Events PR",
              html_url: "https://github.com/owner/repo/pull/200",
              state: "open",
              draft: false,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
            }),
            { status: 200 },
          );
        }

        // REST timeline: 1ページ目 (100件) + 2ページ目 (1件: converted_to_draft)
        if (urlStr.includes("/repos/owner/repo/issues/200/timeline")) {
          if (!urlStr.includes("page=2")) {
            const items = Array.from({ length: 100 }, (_, i) => ({
              event: "labeled",
              created_at: `2026-10-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
              label: { name: "New-Package" },
            }));
            return new Response(JSON.stringify(items), {
              status: 200,
              headers: {
                Link: '<https://api.github.com/repos/owner/repo/issues/200/timeline?per_page=100&page=2>; rel="next"',
              },
            });
          }
          // 2ページ目: 101件目
          return new Response(
            JSON.stringify([
              {
                event: "converted_to_draft",
                created_at: "2026-10-02T00:00:00Z",
              },
            ]),
            { status: 200 },
          );
        }

        if (urlStr.includes("/graphql")) {
          const body = JSON.parse(String(init?.body));
          const query = String(body.query);

          if (query.includes("CompareRateLimit") || query.includes("GetRateLimit")) {
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    limit: 5000,
                    cost: 1,
                    remaining: 5000,
                    resetAt: "2026-10-01T00:00:00Z",
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareSearch")) {
            return new Response(
              JSON.stringify({
                data: {
                  search: {
                    issueCount: 1,
                    nodes: [
                      {
                        number: 200,
                        title: "101 Events PR",
                        url: "https://github.com/owner/repo/pull/200",
                        createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: "2026-10-02T00:00:00Z",
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("ComparePullRequest") || query.includes("GetPullRequestDetails")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      number: 200,
                      title: "101 Events PR",
                      url: "https://github.com/owner/repo/pull/200",
                      state: "OPEN",
                      isDraft: false,
                      createdAt: "2026-10-01T00:00:00Z",
                      updatedAt: "2026-10-02T00:00:00Z",
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareTimeline")) {
            const vars = body.variables as { after?: string | null };
            if (!vars?.after) {
              // 1ページ目 (100件)
              const nodes = Array.from({ length: 100 }, (_, i) => ({
                __typename: "LabeledEvent",
                createdAt: `2026-10-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
                label: { name: "New-Package" },
              }));
              return new Response(
                JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        timelineItems: {
                          pageInfo: { hasNextPage: true, endCursor: "cursor_100" },
                          nodes,
                        },
                      },
                    },
                  },
                }),
                { status: 200 },
              );
            }
            // 2ページ目 (101件目: ConvertToDraftEvent)
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      timelineItems: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [
                          {
                            __typename: "ConvertToDraftEvent",
                            createdAt: "2026-10-02T00:00:00Z",
                          },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: fakeFetch,
      });

      const report = await runCompare(
        {
          repository: "owner/repo",
          targetPr: 200,
        },
        client,
      );

      // 101件目の Draft イベントが両方で読み取られ、hasBlockingOrDraftHistory が true で一致すること
      expect(report.timeline?.diff.countMatch).toBeTrue();
      expect(report.timeline?.diff.restEventCount).toBe(101);
      expect(report.timeline?.diff.graphqlEventCount).toBe(101);
      expect(report.timeline?.diff.blockingHistoryMatch).toBeTrue();
      expect(report.timeline?.diff.restHasBlocking).toBeTrue();
      expect(report.timeline?.diff.graphqlHasBlocking).toBeTrue();
    });

    test("101件のコミットがあるPRでも、RESTの先頭100件とGraphQLのcommits(first: 100)が一致する", async () => {
      // 101個のコミットデータ
      const allCommits = Array.from({ length: 101 }, (_, i) => ({
        sha: `sha_${i}`,
        message: `commit ${i}`,
        date: `2026-10-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
      }));

      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = String(input);

        if (urlStr.includes("/rate_limit")) {
          return new Response(
            JSON.stringify({
              resources: {
                core: { limit: 5000, remaining: 5000, reset: 1700000000 },
                search: { limit: 30, remaining: 30, reset: 1700000000 },
              },
            }),
            { status: 200 },
          );
        }

        if (urlStr.includes("/search/issues")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              items: [
                {
                  number: 300,
                  title: "101 Commits PR",
                  html_url: "https://github.com/owner/repo/pull/300",
                  created_at: "2026-10-01T00:00:00Z",
                  updated_at: "2026-10-02T00:00:00Z",
                },
              ],
            }),
            { status: 200 },
          );
        }

        // REST /pulls/300/commits?per_page=100 は先頭100件を返す
        if (urlStr.includes("/repos/owner/repo/pulls/300/commits")) {
          const restCommits = allCommits.slice(0, 100).map((c) => ({
            sha: c.sha,
            commit: {
              message: c.message,
              committer: { date: c.date },
            },
          }));
          return new Response(JSON.stringify(restCommits), { status: 200 });
        }

        if (urlStr.includes("/repos/owner/repo/pulls/300")) {
          return new Response(
            JSON.stringify({
              number: 300,
              title: "101 Commits PR",
              html_url: "https://github.com/owner/repo/pull/300",
              state: "open",
              draft: false,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
            }),
            { status: 200 },
          );
        }

        if (urlStr.includes("/repos/owner/repo/issues/300/timeline")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (urlStr.includes("/graphql")) {
          const body = JSON.parse(String(init?.body));
          const query = String(body.query);

          if (query.includes("CompareRateLimit") || query.includes("GetRateLimit")) {
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    limit: 5000,
                    cost: 1,
                    remaining: 5000,
                    resetAt: "2026-10-01T00:00:00Z",
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareSearch")) {
            return new Response(
              JSON.stringify({
                data: {
                  search: {
                    issueCount: 1,
                    nodes: [
                      {
                        number: 300,
                        title: "101 Commits PR",
                        url: "https://github.com/owner/repo/pull/300",
                        createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: "2026-10-02T00:00:00Z",
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("ComparePullRequest") || query.includes("GetPullRequestDetails")) {
            // commits(first: 100) で先頭100件が返る
            const gqlCommits = allCommits.slice(0, 100).map((c) => ({
              commit: {
                oid: c.sha,
                messageHeadline: c.message,
                committedDate: c.date,
              },
            }));
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      number: 300,
                      title: "101 Commits PR",
                      url: "https://github.com/owner/repo/pull/300",
                      state: "OPEN",
                      isDraft: false,
                      createdAt: "2026-10-01T00:00:00Z",
                      updatedAt: "2026-10-02T00:00:00Z",
                      commits: {
                        nodes: gqlCommits,
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareTimeline")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      timelineItems: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: fakeFetch,
      });

      const report = await runCompare(
        {
          repository: "owner/repo",
          targetPr: 300,
        },
        client,
      );

      // 先頭100件同士で比較され、commits[0] の不一致が発生せず完全一致すること
      expect(report.prDetail?.diff.match).toBeTrue();
      expect(report.prDetail?.diff.diffs).toEqual([]);
    });

    test("REST と GraphQL で意図的に異なる PR 詳細を返した場合に差分（match: false）を検出できる", async () => {
      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = String(input);

        // rate_limit (REST)
        if (urlStr.includes("/rate_limit")) {
          return new Response(
            JSON.stringify({
              resources: {
                core: { limit: 5000, remaining: 4999, reset: 1_700_000_000 },
                search: { limit: 30, remaining: 29, reset: 1_700_000_000 },
              },
            }),
            { status: 200 },
          );
        }

        // search issues (REST)
        if (urlStr.includes("/search/issues")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              items: [
                {
                  number: 100,
                  title: "Test PR",
                  html_url: "https://github.com/owner/repo/pull/100",
                  created_at: "2026-10-01T00:00:00Z",
                  updated_at: "2026-10-02T00:00:00Z",
                  labels: [{ name: "New-Package" }],
                  draft: false,
                },
              ],
            }),
            { status: 200 },
          );
        }

        // REST get PR details: REST 側はタイトル "REST Title", ラベル "REST-Label"
        if (urlStr.includes("/repos/owner/repo/pulls/100/commits")) {
          return new Response(
            JSON.stringify([
              {
                sha: "restcommit1",
                commit: {
                  message: "commit 1",
                  committer: { date: "2026-10-01T00:00:00Z" },
                },
              },
            ]),
            { status: 200 },
          );
        }

        if (urlStr.includes("/repos/owner/repo/pulls/100")) {
          return new Response(
            JSON.stringify({
              number: 100,
              title: "REST Title",
              html_url: "https://github.com/owner/repo/pull/100",
              state: "open",
              draft: false,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
              labels: [{ name: "REST-Label" }],
              user: { login: "tester" },
              author_association: "NONE",
            }),
            { status: 200 },
          );
        }

        // REST timeline
        if (urlStr.includes("/repos/owner/repo/issues/100/timeline")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        // GraphQL
        if (urlStr.includes("/graphql")) {
          const body = JSON.parse(String(init?.body));
          const query = String(body.query);

          if (query.includes("CompareRateLimit") || query.includes("GetRateLimit")) {
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    limit: 5000,
                    cost: 1,
                    remaining: 4995,
                    resetAt: "2026-10-01T00:00:00Z",
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareSearch")) {
            return new Response(
              JSON.stringify({
                data: {
                  search: {
                    issueCount: 1,
                    nodes: [
                      {
                        number: 100,
                        title: "Test PR",
                        url: "https://github.com/owner/repo/pull/100",
                        createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: "2026-10-02T00:00:00Z",
                        isDraft: false,
                        mergedAt: null,
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            );
          }

          // GraphQL 側はタイトル "GraphQL Title", ラベル "GraphQL-Label"
          if (query.includes("ComparePullRequest")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      number: 100,
                      title: "GraphQL Title",
                      url: "https://github.com/owner/repo/pull/100",
                      state: "OPEN",
                      isDraft: false,
                      createdAt: "2026-10-01T00:00:00Z",
                      updatedAt: "2026-10-02T00:00:00Z",
                      mergedAt: null,
                      closedAt: null,
                      author: { login: "tester" },
                      authorAssociation: "NONE",
                      labels: { nodes: [{ name: "GraphQL-Label" }] },
                      commits: {
                        nodes: [
                          {
                            commit: {
                              oid: "gqlcommit1",
                              messageHeadline: "commit 1",
                              committedDate: "2026-10-01T00:00:00Z",
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareTimeline")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      timelineItems: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: fakeFetch,
      });

      const report = await runCompare(
        {
          repository: "owner/repo",
          targetPr: 100,
        },
        client,
      );

      // REST と GraphQL で異なる値が返ったため、差分が検出されること
      expect(report.prDetail?.diff.match).toBeFalse();
      expect(report.prDetail?.diff.diffs.some((d) => d.field === "title")).toBeTrue();
      expect(report.prDetail?.diff.diffs.some((d) => d.field === "labels")).toBeTrue();
    });

    test("REST と GraphQL で意図的に異なるタイムラインを返した場合に差分（timelineMatch: false）を検出できる", async () => {
      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = String(input);

        if (urlStr.includes("/rate_limit")) {
          return new Response(
            JSON.stringify({
              resources: {
                core: { limit: 5000, remaining: 4999, reset: 1700000000 },
                search: { limit: 30, remaining: 29, reset: 1700000000 },
              },
            }),
            { status: 200 },
          );
        }

        if (urlStr.includes("/search/issues")) {
          return new Response(
            JSON.stringify({
              total_count: 1,
              items: [
                {
                  number: 100,
                  title: "Test PR",
                  html_url: "https://github.com/owner/repo/pull/100",
                  created_at: "2026-10-01T00:00:00Z",
                  updated_at: "2026-10-02T00:00:00Z",
                  labels: [{ name: "New-Package" }],
                  draft: false,
                },
              ],
            }),
            { status: 200 },
          );
        }

        // REST 側 PR 詳細
        if (urlStr.includes("/repos/owner/repo/pulls/100/commits")) {
          return new Response(
            JSON.stringify([
              {
                sha: "commit1",
                commit: {
                  message: "commit 1",
                  committer: { date: "2026-10-01T00:00:00Z" },
                },
              },
            ]),
            { status: 200 },
          );
        }
        if (urlStr.includes("/repos/owner/repo/pulls/100")) {
          return new Response(
            JSON.stringify({
              number: 100,
              title: "Test PR",
              html_url: "https://github.com/owner/repo/pull/100",
              state: "open",
              draft: false,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
              merged_at: null,
              closed_at: null,
              labels: [{ name: "New-Package" }],
              user: { login: "tester" },
              author_association: "NONE",
            }),
            { status: 200 },
          );
        }

        // REST 側タイムライン: 阻害ラベル "Needs-Author-Feedback" が付与されている
        if (urlStr.includes("/repos/owner/repo/issues/100/timeline")) {
          return new Response(
            JSON.stringify([
              {
                event: "labeled",
                created_at: "2026-10-01T01:00:00Z",
                label: { name: "Needs-Author-Feedback" },
              },
            ]),
            { status: 200 },
          );
        }

        // GraphQL POST
        if (urlStr.includes("/graphql")) {
          const body = JSON.parse(String(init?.body)) as { query: string };
          const query = body.query;

          if (query.includes("CompareRateLimit") || query.includes("GetRateLimit")) {
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    limit: 5000,
                    cost: 1,
                    remaining: 4999,
                    resetAt: "2026-10-01T00:00:00Z",
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareSearch")) {
            return new Response(
              JSON.stringify({
                data: {
                  search: {
                    issueCount: 1,
                    nodes: [
                      {
                        number: 100,
                        title: "Test PR",
                        url: "https://github.com/owner/repo/pull/100",
                        createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: "2026-10-02T00:00:00Z",
                        isDraft: false,
                        mergedAt: null,
                        author: { login: "tester" },
                        authorAssociation: "NONE",
                        labels: { nodes: [{ name: "New-Package" }] },
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("ComparePullRequest")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      number: 100,
                      title: "Test PR",
                      url: "https://github.com/owner/repo/pull/100",
                      state: "OPEN",
                      isDraft: false,
                      createdAt: "2026-10-01T00:00:00Z",
                      updatedAt: "2026-10-02T00:00:00Z",
                      mergedAt: null,
                      closedAt: null,
                      author: { login: "tester" },
                      authorAssociation: "NONE",
                      labels: { nodes: [{ name: "New-Package" }] },
                      commits: {
                        nodes: [
                          {
                            commit: {
                              oid: "commit1",
                              messageHeadline: "commit 1",
                              committedDate: "2026-10-01T00:00:00Z",
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }

          // GraphQL 側タイムライン: 阻害ラベルなし（"New-Package" のみ）
          if (query.includes("CompareTimeline")) {
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
                            createdAt: "2026-10-01T01:00:00Z",
                            label: { name: "New-Package" },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: fakeFetch,
      });

      const report = await runCompare(
        {
          repository: "owner/repo",
          targetPr: 100,
        },
        client,
      );

      // REST (Needs-Author-Feedback) と GraphQL (New-Package) で異なるイベントが返ったため、差分が検出されること
      expect(report.timeline?.diff.eventSequenceMatch).toBeFalse();
      expect(report.timeline?.diff.restHasBlocking).toBeTrue();
      expect(report.timeline?.diff.graphqlHasBlocking).toBeFalse();
      expect(report.timeline?.diff.blockingHistoryMatch).toBeFalse();
    });

    test("REST と GraphQL で意図的に異なる検索結果を返した場合に差分（totalCountMatch: false）を検出できる", async () => {
      const fakeFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = String(input);

        if (urlStr.includes("/rate_limit")) {
          return new Response(
            JSON.stringify({
              resources: {
                core: { limit: 5000, remaining: 4999, reset: 1700000000 },
                search: { limit: 30, remaining: 29, reset: 1700000000 },
              },
            }),
            { status: 200 },
          );
        }

        // REST 側検索結果: total_count = 5
        if (urlStr.includes("/search/issues")) {
          return new Response(
            JSON.stringify({
              total_count: 5,
              items: [
                {
                  number: 100,
                  title: "REST PR 100",
                  html_url: "https://github.com/owner/repo/pull/100",
                  created_at: "2026-10-01T00:00:00Z",
                  updated_at: "2026-10-02T00:00:00Z",
                  labels: [{ name: "New-Package" }],
                  draft: false,
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (urlStr.includes("/repos/owner/repo/pulls/100/commits")) {
          return new Response(
            JSON.stringify([
              {
                sha: "commit1",
                commit: {
                  message: "commit 1",
                  committer: { date: "2026-10-01T00:00:00Z" },
                },
              },
            ]),
            { status: 200 },
          );
        }
        if (urlStr.includes("/repos/owner/repo/pulls/100")) {
          return new Response(
            JSON.stringify({
              number: 100,
              title: "REST PR 100",
              html_url: "https://github.com/owner/repo/pull/100",
              state: "open",
              draft: false,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
              merged_at: null,
              closed_at: null,
              labels: [{ name: "New-Package" }],
              user: { login: "tester" },
              author_association: "NONE",
            }),
            { status: 200 },
          );
        }

        if (urlStr.includes("/repos/owner/repo/issues/100/timeline")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (urlStr.includes("/graphql")) {
          const body = JSON.parse(String(init?.body)) as { query: string };
          const query = body.query;

          if (query.includes("CompareRateLimit") || query.includes("GetRateLimit")) {
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    limit: 5000,
                    cost: 1,
                    remaining: 4999,
                    resetAt: "2026-10-01T00:00:00Z",
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("ComparePullRequest")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      number: 100,
                      title: "REST PR 100",
                      url: "https://github.com/owner/repo/pull/100",
                      state: "OPEN",
                      isDraft: false,
                      createdAt: "2026-10-01T00:00:00Z",
                      updatedAt: "2026-10-02T00:00:00Z",
                      mergedAt: null,
                      closedAt: null,
                      author: { login: "tester" },
                      authorAssociation: "NONE",
                      labels: { nodes: [{ name: "New-Package" }] },
                      commits: {
                        nodes: [
                          {
                            commit: {
                              oid: "commit1",
                              messageHeadline: "commit 1",
                              committedDate: "2026-10-01T00:00:00Z",
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }

          if (query.includes("CompareTimeline")) {
            return new Response(
              JSON.stringify({
                data: {
                  repository: {
                    pullRequest: {
                      timelineItems: {
                        pageInfo: { hasNextPage: false, endCursor: null },
                        nodes: [],
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            );
          }

          // GraphQL 側検索結果: issueCount = 10 (REST と不一致)
          if (query.includes("CompareSearch")) {
            return new Response(
              JSON.stringify({
                data: {
                  search: {
                    issueCount: 10,
                    nodes: [
                      {
                        number: 100,
                        title: "GraphQL PR 100",
                        url: "https://github.com/owner/repo/pull/100",
                        createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: "2026-10-02T00:00:00Z",
                        isDraft: false,
                        mergedAt: null,
                        author: { login: "tester" },
                        authorAssociation: "NONE",
                        labels: { nodes: [{ name: "New-Package" }] },
                      },
                    ],
                  },
                },
              }),
              { status: 200 },
            );
          }
        }

        return new Response("Not Found", { status: 404 });
      };

      const client = new GitHubApiClient({
        token: "dummy-token",
        fetch: fakeFetch,
      });

      const report = await runCompare(
        {
          repository: "owner/repo",
        },
        client,
      );

      // REST (totalCount=5) と GraphQL (issueCount=10) で異なる件数が返ったため、差分が検出されること
      expect(report.search.totalCountMatch).toBeFalse();
      expect(report.search.restTotalCount).toBe(5);
      expect(report.search.graphqlTotalCount).toBe(10);
      expect(report.search.countDiff).toBe(5);
    });
  });
});
