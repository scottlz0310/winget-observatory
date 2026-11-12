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

          if (query.includes("CompareRateLimit")) {
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
  });
});
