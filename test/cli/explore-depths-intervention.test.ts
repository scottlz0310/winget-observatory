import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient } from "../../src/api/github";
import { fetchInterventionFrontiers, runExploreDepths } from "../../src/cli/explore-depths";
import { buildHealthyBaseQuery, CURRENT_DEPTHS_VERSION } from "../../src/domain/depths";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "../../src/domain/intervention";
import type { GitHubPrView, GitHubSearchItem } from "../../src/models/depths";

describe("CLI: explore-depths の未レビュー前線・介入済み前線（fetchInterventionFrontiers）", () => {
  interface MockPrSpec {
    number: number;
    createdAt: string;
    author: string | null;
    commits?: number;
    authorAssociation?: string;
    assignees?: Array<{ __typename?: string; login: string }>;
    reviews?: {
      totalCount?: number;
      hasNextPage?: boolean;
      endCursor?: string | null;
      nodes: Array<{ author: { __typename?: string; login: string } | null; state: string }>;
    };
    comments?: {
      totalCount?: number;
      hasNextPage?: boolean;
      endCursor?: string | null;
      nodes: Array<{
        author: { __typename?: string; login: string } | null;
        authorAssociation?: string | null;
        body: string;
        createdAt?: string | null;
        lastEditedAt?: string | null;
        editor?: { __typename?: string; login: string } | null;
      }>;
    };
  }

  const createInterventionNode = (spec: MockPrSpec) => ({
    number: spec.number,
    title: `PR #${spec.number}`,
    url: `https://github.com/microsoft/winget-pkgs/pull/${spec.number}`,
    createdAt: spec.createdAt,
    updatedAt: spec.createdAt,
    author: spec.author ? { __typename: "User", login: spec.author } : null,
    authorAssociation: spec.authorAssociation ?? "NONE",
    commits: { totalCount: spec.commits ?? 1 },
    assignees: {
      nodes: (spec.assignees ?? []).map((a) => ({
        __typename: a.__typename ?? "User",
        login: a.login,
      })),
    },
    reviews: {
      totalCount: spec.reviews?.totalCount ?? spec.reviews?.nodes.length ?? 0,
      pageInfo: {
        hasNextPage: spec.reviews?.hasNextPage ?? false,
        endCursor: spec.reviews?.endCursor ?? null,
      },
      nodes: spec.reviews?.nodes ?? [],
    },
    comments: {
      totalCount: spec.comments?.totalCount ?? spec.comments?.nodes.length ?? 0,
      pageInfo: {
        hasNextPage: spec.comments?.hasNextPage ?? false,
        endCursor: spec.comments?.endCursor ?? null,
      },
      nodes: spec.comments?.nodes ?? [],
    },
  });

  const buildBatchRepoFromSpecs = (
    query: string,
    nodeMap: Map<number, ReturnType<typeof createInterventionNode>>,
  ): Record<string, ReturnType<typeof createInterventionNode> | null> => {
    const repo: Record<string, ReturnType<typeof createInterventionNode> | null> = {};
    for (const match of query.matchAll(/(pr\d+):\s*pullRequest\(number:\s*(\d+)\)/g)) {
      const alias = match[1];
      const num = Number(match[2]);
      repo[alias] = nodeMap.get(num) ?? null;
    }
    return repo;
  };

  test("2 段階パイプラインで未レビュー（完全未着手）と介入済みを分離し、両側が上限に達したら後続バッチ・検索を即打ち切る", async () => {
    const specs: MockPrSpec[] = [
      {
        number: 501,
        createdAt: "2026-10-01T00:00:00Z",
        author: "alice",
        assignees: [{ login: "alice" }], // セルフアサインのみ
        reviews: {
          nodes: [
            {
              author: { __typename: "Bot", login: "copilot-pull-request-reviewer" },
              state: "COMMENTED",
            },
          ],
        },
        comments: {
          nodes: [
            {
              author: { __typename: "Bot", login: "microsoft-github-policy-service" },
              body: "CLA",
            },
            {
              author: { __typename: "User", login: "alice" },
              body: "@microsoft-github-policy-service agree",
            },
            {
              author: { __typename: "User", login: "stephengillie" },
              body: "This manifest version has been depreciated. (Deterministic automation - build 1830.)",
            },
          ],
        },
      },
      {
        number: 502,
        createdAt: "2026-10-02T00:00:00Z",
        author: "bob",
        comments: {
          nodes: [{ author: { __typename: "User", login: "wingetbot" }, body: "@wingetbot run" }],
        },
      },
      {
        number: 503,
        createdAt: "2026-10-03T00:00:00Z",
        author: "carol",
        comments: {
          nodes: [
            {
              author: { __typename: "User", login: "stephengillie" },
              body: "Does this have a privacy policy?",
            },
          ],
        },
      },
      {
        number: 504,
        createdAt: "2026-10-04T00:00:00Z",
        author: "dave",
      },
      {
        number: 505,
        createdAt: "2026-10-05T00:00:00Z",
        author: "eve",
        reviews: {
          nodes: [{ author: { __typename: "User", login: "stephengillie" }, state: "DISMISSED" }],
        },
      },
      {
        number: 506,
        createdAt: "2026-10-06T00:00:00Z",
        author: "frank",
        assignees: [{ login: "trenly" }],
      },
    ];
    const nodeMap = new Map(specs.map((s) => [s.number, createInterventionNode(s)]));

    let searchCalls = 0;
    let batchCalls = 0;
    const mockClient = {
      graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          searchCalls++;
          expect(variables.query).toContain("sort:created-asc");
          if (!variables.after) {
            return {
              search: {
                pageInfo: { hasNextPage: true, endCursor: "c1" },
                nodes: [{ number: 501 }, { number: 502 }, { number: 503 }, { number: 504 }],
              },
            } as unknown as T;
          }
          if (variables.after === "c1") {
            return {
              search: {
                pageInfo: { hasNextPage: true, endCursor: "c2" },
                nodes: [{ number: 505 }, { number: 506 }],
              },
            } as unknown as T;
          }
          throw new Error("3ページ目は呼び出されないはず");
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          batchCalls++;
          expect(variables).toEqual({ owner: "microsoft", name: "winget-pkgs" });
          return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
        }
        if (query.includes("u_0: search(")) {
          return {} as unknown as T;
        }
        throw new Error(`想定外のクエリ: ${query}`);
      },
    } as unknown as GitHubApiClient;

    // batchSize=2 で 501,502 -> 503,504 -> 505,506 の 3 バッチ（505処理時点で limit=2 到達）
    const { unreviewedBottom, intervenedBottom, unreviewedTruncated, intervenedTruncated } =
      await fetchInterventionFrontiers(mockClient, "repo:microsoft/winget-pkgs", 2, 1000, 2);

    expect(searchCalls).toBe(2);
    expect(batchCalls).toBe(3);
    expect(unreviewedTruncated).toBe(false);
    expect(intervenedTruncated).toBe(false);
    expect(unreviewedBottom.map((r) => r.Number)).toEqual([501, 502]);
    expect(unreviewedBottom[0].Intervention?.Intervened).toBe(false);
    expect(intervenedBottom.map((r) => r.Number)).toEqual([503, 505]);
    expect(intervenedBottom[0].Intervention?.PrimaryBadge?.Label).toBe("コメント済: stephengillie");
    expect(intervenedBottom[1].Intervention?.PrimaryBadge?.Label).toBe(
      "レビュー済: stephengillie (DISMISSED)",
    );
  });

  test("最初の 20 件で介入済みが確定した場合は追加ページングせず、全件ボットで hasNextPage=true の PR のみ追加ページングして検出即停止する", async () => {
    const specs: MockPrSpec[] = [
      {
        // 先頭で既にコメント介入済み -> hasNextPage=true でも追加ページングしない
        number: 601,
        createdAt: "2026-10-01T00:00:00Z",
        author: "u1",
        comments: {
          totalCount: 30,
          hasNextPage: true,
          endCursor: "c601",
          nodes: [{ author: { __typename: "User", login: "stephengillie" }, body: "Waived" }],
        },
      },
      {
        // 1 ページ目はボットのみ + hasNextPage=true -> 追加ページングで 2 ページ目の人間コメントを検出
        number: 602,
        createdAt: "2026-10-02T00:00:00Z",
        author: "u2",
        comments: {
          totalCount: 25,
          hasNextPage: true,
          endCursor: "c602-p1",
          nodes: [
            {
              author: { __typename: "Bot", login: "microsoft-github-policy-service" },
              body: "CLA",
            },
          ],
        },
      },
      {
        // 1 ページ目はボットのみ + hasNextPage=true -> 追加ページング後もボットのみ -> 未レビュー確定
        number: 603,
        createdAt: "2026-10-03T00:00:00Z",
        author: "u3",
        comments: {
          totalCount: 22,
          hasNextPage: true,
          endCursor: "c603-p1",
          nodes: [
            {
              author: { __typename: "Bot", login: "microsoft-github-policy-service" },
              body: "CLA",
            },
          ],
        },
      },
    ];
    const nodeMap = new Map(specs.map((s) => [s.number, createInterventionNode(s)]));
    const pagedCalls: Array<{ number: number; after: string }> = [];

    const mockClient = {
      graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ number: 601 }, { number: 602 }, { number: 603 }],
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
        }
        if (query.includes("GetPullRequestCommentsPage")) {
          const num = Number(variables.number);
          const after = String(variables.after);
          pagedCalls.push({ number: num, after });
          if (num === 602 && after === "c602-p1") {
            return {
              repository: {
                pullRequest: {
                  comments: {
                    totalCount: 25,
                    pageInfo: { hasNextPage: true, endCursor: "c602-p2" },
                    nodes: [
                      {
                        author: { __typename: "User", login: "trenly" },
                        body: "Please update URL",
                      },
                    ],
                  },
                },
              },
            } as unknown as T;
          }
          if (num === 603 && after === "c603-p1") {
            return {
              repository: {
                pullRequest: {
                  comments: {
                    totalCount: 22,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      { author: { __typename: "Bot", login: "wingetvalidator-prod" }, body: "OK" },
                    ],
                  },
                },
              },
            } as unknown as T;
          }
          throw new Error(`不要な追加ページング: #${num} after=${after}`);
        }
        if (query.includes("u_0: search(")) {
          return {} as unknown as T;
        }
        throw new Error(`想定外のクエリ: ${query}`);
      },
    } as unknown as GitHubApiClient;

    const result = await fetchInterventionFrontiers(
      mockClient,
      "repo:microsoft/winget-pkgs",
      10,
      1000,
    );
    expect(pagedCalls).toEqual([
      { number: 602, after: "c602-p1" },
      { number: 603, after: "c603-p1" },
    ]);
    expect(result.intervenedBottom.map((r) => r.Number)).toEqual([601, 602]);
    expect(result.intervenedBottom[1].Intervention?.PrimaryBadge?.Label).toBe("コメント済: trenly");
    expect(result.unreviewedBottom.map((r) => r.Number)).toEqual([603]);
  });

  test("追加ページング上限に達して介入有無を確定できない PR は未レビューとして採用せず例外を送出する", async () => {
    const botOverflowSpec = createInterventionNode({
      number: 604,
      createdAt: "2026-10-04T00:00:00Z",
      author: "u4",
      comments: {
        totalCount: 3000,
        hasNextPage: true,
        endCursor: "c-0",
        nodes: [
          { author: { __typename: "Bot", login: "microsoft-github-policy-service" }, body: "CLA" },
        ],
      },
    });

    let pageCounter = 0;
    const mockClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ number: 604 }],
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          return { repository: { pr0: botOverflowSpec } } as unknown as T;
        }
        if (query.includes("GetPullRequestCommentsPage")) {
          pageCounter++;
          return {
            repository: {
              pullRequest: {
                comments: {
                  totalCount: 3000,
                  pageInfo: { hasNextPage: true, endCursor: `c-${pageCounter}` },
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
        }
        throw new Error(`想定外のクエリ: ${query}`);
      },
    } as unknown as GitHubApiClient;

    await expect(
      fetchInterventionFrontiers(mockClient, "repo:microsoft/winget-pkgs", 10, 1000),
    ).rejects.toThrow("追加ページング上限 (50 ページ) に達したため、未介入と確定できません");
  });

  test("fetchInterventionFrontiers は GraphQL 失敗時にコンテキスト付き例外をスローする", async () => {
    const mockClient = {
      graphql: async () => {
        throw new Error("HTTP 502 Bad Gateway");
      },
    } as unknown as GitHubApiClient;

    await expect(
      fetchInterventionFrontiers(mockClient, "repo:microsoft/winget-pkgs", 10, 1000),
    ).rejects.toThrow(
      "未レビュー前線・介入済み前線の GraphQL 取得に失敗しました: HTTP 502 Bad Gateway",
    );
  });

  test("片側（介入済み PR）が上限件数未満で走査終端（hasNextPage=false）に達しても異常終了せず収集分を返す", async () => {
    const specs: MockPrSpec[] = [
      { number: 611, createdAt: "2026-10-01T00:00:00Z", author: "u1" },
      {
        number: 612,
        createdAt: "2026-10-02T00:00:00Z",
        author: "u2",
        assignees: [{ login: "stephengillie" }],
      },
      {
        number: 613,
        createdAt: "2026-10-03T00:00:00Z",
        author: null,
        assignees: [{ login: "stephengillie" }],
        comments: {
          nodes: [
            {
              author: { __typename: "User", login: "stephengillie" },
              body: "Please check installer URL.",
            },
          ],
        },
      },
      { number: 614, createdAt: "2026-10-04T00:00:00Z", author: "u4" },
    ];
    const nodeMap = new Map(specs.map((s) => [s.number, createInterventionNode(s)]));

    const mockClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: specs.map((s) => ({ number: s.number })),
            },
          } as unknown as T;
        }
        return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const { unreviewedBottom, intervenedBottom, unreviewedTruncated, intervenedTruncated } =
      await fetchInterventionFrontiers(mockClient, "repo:microsoft/winget-pkgs", 10, 1000);

    expect(unreviewedBottom.map((r) => r.Number)).toEqual([611, 612, 614]);
    expect(intervenedBottom.map((r) => r.Number)).toEqual([613]);
    expect(intervenedBottom[0].ThirdPartyAssignees).toEqual(["stephengillie"]);
    expect(unreviewedTruncated).toBe(false);
    expect(intervenedTruncated).toBe(false);
  });

  test("片側が上限件数未満のまま maxTraverseNodes 上限に達した場合、収集済み結果を返しつつ未完了フラグを立てる", async () => {
    const specs: MockPrSpec[] = [
      { number: 701, createdAt: "2026-10-01T00:00:00Z", author: "u1" },
      { number: 702, createdAt: "2026-10-02T00:00:00Z", author: "u2" },
      {
        number: 703,
        createdAt: "2026-10-03T00:00:00Z",
        author: "u3",
        reviews: {
          nodes: [{ author: { __typename: "User", login: "stephengillie" }, state: "COMMENTED" }],
        },
      },
    ];
    const nodeMap = new Map(specs.map((s) => [s.number, createInterventionNode(s)]));

    const mockClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "c-next" },
              nodes: specs.map((s) => ({ number: s.number })),
            },
          } as unknown as T;
        }
        return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const { unreviewedBottom, intervenedBottom, unreviewedTruncated, intervenedTruncated } =
      await fetchInterventionFrontiers(mockClient, "repo:microsoft/winget-pkgs", 10, 3);

    expect(unreviewedBottom.map((r) => r.Number)).toEqual([701, 702]);
    expect(intervenedBottom.map((r) => r.Number)).toEqual([703]);
    expect(unreviewedTruncated).toBe(true);
    expect(intervenedTruncated).toBe(true);
  });

  test("複数コミット・常連著者は除外せず、健全クエリ（buildHealthyBaseQuery）でパターン阻害ラベルが除外されている", async () => {
    const specs: MockPrSpec[] = [
      {
        number: 754,
        createdAt: "2026-10-04T00:00:00Z",
        author: "regular",
        commits: 4,
        authorAssociation: "MEMBER",
      },
      {
        number: 755,
        createdAt: "2026-10-05T00:00:00Z",
        author: "u5",
        commits: 3,
        authorAssociation: "CONTRIBUTOR",
        comments: {
          nodes: [{ author: { __typename: "User", login: "trenly" }, body: "Please check hash." }],
        },
      },
    ];
    const nodeMap = new Map(specs.map((s) => [s.number, createInterventionNode(s)]));

    let capturedQuery = "";
    const mockClient = {
      graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          capturedQuery = String(variables.query ?? "");
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: specs.map((s) => ({ number: s.number })),
            },
          } as unknown as T;
        }
        return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const healthyBase = buildHealthyBaseQuery("microsoft/winget-pkgs");
    const result = await fetchInterventionFrontiers(mockClient, healthyBase, 10, 100);
    expect(capturedQuery).toContain('-label:"Policy-Test-1.5"');
    expect(capturedQuery).toContain('-label:"Validation-Error"');
    expect(capturedQuery).toContain('-label:"Validation-Guide"');
    expect(capturedQuery).not.toContain('-label:"Waived-Validation-Defender-Error"');
    expect(result.unreviewedBottom.map((r) => r.Number)).toEqual([754]);
    expect(result.intervenedBottom.map((r) => r.Number)).toEqual([755]);
    expect(result.unreviewedTruncated).toBe(false);
    expect(result.intervenedTruncated).toBe(false);
  });

  test("自動検証ログにメンテナの手動追記がある PR は介入済みに分類し、ボット自動編集の PR は未レビューのまま維持する", async () => {
    const specs: MockPrSpec[] = [
      {
        number: 758,
        createdAt: "2026-10-01T00:00:00Z",
        author: "submitter1",
        comments: {
          nodes: [
            {
              author: { __typename: "User", login: "stephengillie" },
              createdAt: "2026-10-30T20:23:43Z",
              lastEditedAt: "2026-10-30T20:23:59Z",
              editor: { __typename: "User", login: "stephengillie" },
              body: "Manual Validation ended with:\n(Deterministic automation - build 1831.)\n\nEdit: My approval VMs have been having difficulty connecting to this host recently.",
            },
          ],
        },
      },
      {
        number: 759,
        createdAt: "2026-10-02T00:00:00Z",
        author: "submitter2",
        comments: {
          nodes: [
            {
              author: { __typename: "User", login: "stephengillie" },
              createdAt: "2026-10-30T20:23:43Z",
              lastEditedAt: "2026-10-30T20:24:00Z",
              editor: { __typename: "Bot", login: "github-actions[bot]" },
              body: "Manual Validation ended with:\n(Deterministic automation - build 1831.)\nEdit: Automated sync",
            },
          ],
        },
      },
    ];
    const nodeMap = new Map(specs.map((s) => [s.number, createInterventionNode(s)]));

    const mockClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: specs.map((s) => ({ number: s.number })),
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          expect(query).toContain("lastEditedAt");
          expect(query).toContain("editor");
          return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
        }
        if (query.includes("u_0: search(")) {
          return {} as unknown as T;
        }
        throw new Error(`想定外のクエリ: ${query}`);
      },
    } as unknown as GitHubApiClient;

    const result = await fetchInterventionFrontiers(
      mockClient,
      buildHealthyBaseQuery("microsoft/winget-pkgs"),
      10,
      100,
    );
    expect(result.intervenedBottom.map((r) => r.Number)).toEqual([758]);
    expect(result.intervenedBottom[0].Intervention?.FirstHumanInterventionAt).toBe(
      "2026-10-30T20:23:59.000Z",
    );
    expect(result.unreviewedBottom.map((r) => r.Number)).toEqual([759]);
  });

  test("maxTraverseNodes 上限で未レビューが 0 件のまま打ち切られた場合は unreviewedTruncated=true（逆区分も同様）", async () => {
    const intervenedOnlySpec = createInterventionNode({
      number: 761,
      createdAt: "2026-10-01T00:00:00Z",
      author: "u1",
      comments: {
        nodes: [
          { author: { __typename: "User", login: "stephengillie" }, body: "Please clarify." },
        ],
      },
    });
    const intervenedOnlyClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [{ number: 761 }],
            },
          } as unknown as T;
        }
        return { repository: { pr0: intervenedOnlySpec } } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const r1 = await fetchInterventionFrontiers(
      intervenedOnlyClient,
      "repo:microsoft/winget-pkgs",
      1,
      1,
    );
    expect(r1.unreviewedBottom).toEqual([]);
    expect(r1.intervenedBottom.map((r) => r.Number)).toEqual([761]);
    expect(r1.unreviewedTruncated).toBe(true);
    expect(r1.intervenedTruncated).toBe(false);

    const unreviewedOnlySpec = createInterventionNode({
      number: 762,
      createdAt: "2026-10-01T00:00:00Z",
      author: "u2",
    });
    const unreviewedOnlyClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [{ number: 762 }],
            },
          } as unknown as T;
        }
        return { repository: { pr0: unreviewedOnlySpec } } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const r2 = await fetchInterventionFrontiers(
      unreviewedOnlyClient,
      "repo:microsoft/winget-pkgs",
      1,
      1,
    );
    expect(r2.unreviewedBottom.map((r) => r.Number)).toEqual([762]);
    expect(r2.intervenedBottom).toEqual([]);
    expect(r2.unreviewedTruncated).toBe(false);
    expect(r2.intervenedTruncated).toBe(true);
  });

  test("未編集の自動コメント（Deterministic automation / Automated message）・@wingetbot run・第三者アサインのみの PR は未レビュー前線として扱う（Issue #147）", async () => {
    const autoRecoveryPr = createInterventionNode({
      number: 464302,
      createdAt: "2026-10-06T08:52:58Z",
      author: "rakleed",
      assignees: [{ login: "stephengillie" }],
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            createdAt: "2026-10-30T06:18:49Z",
            body: "Automatic Validation ended with:\n> Defender race condition detected.\n\n(Deterministic automation - build 1838.)",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            createdAt: "2026-11-23T14:17:10Z",
            body: "URL: https://example.com/app.zip\nStatus Code: 200\n\n(Automated message - build 1838)",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            createdAt: "2026-11-23T17:20:36Z",
            body: "@wingetbot run",
          },
        ],
      },
    });
    const manualReviewedPr = createInterventionNode({
      number: 448260,
      createdAt: "2026-10-07T15:34:01Z",
      author: "Aureliolo",
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "taras-janea" },
            createdAt: "2026-11-19T13:01:49Z",
            body: "Thank you for the contribution.",
          },
        ],
      },
    });

    const nodeMap = new Map([
      [464302, autoRecoveryPr],
      [448260, manualReviewedPr],
    ]);
    const mockClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ number: 464302 }, { number: 448260 }],
            },
          } as unknown as T;
        }
        return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const result = await fetchInterventionFrontiers(
      mockClient,
      "repo:microsoft/winget-pkgs",
      10,
      100,
    );
    expect(result.unreviewedBottom.map((r) => r.Number)).toEqual([464302]);
    expect(result.unreviewedBottom[0]?.Intervention?.Intervened).toBe(false);
    expect(result.unreviewedBottom[0]?.Intervention?.PrimaryBadge).toBeUndefined();
    expect(result.unreviewedBottom[0]?.Intervention?.FirstHumanInterventionAt).toBeUndefined();
    expect(result.intervenedBottom.map((r) => r.Number)).toEqual([448260]);
    expect(result.intervenedBottom[0]?.Intervention?.PrimaryBadge?.Label).toBe(
      "コメント済: taras-janea",
    );
  });

  test("runExploreDepths は DepthsVersion=4 で FirstReviewFrontier / UnreviewedBottom / IntervenedBottom / TargetPr.Intervention を保存する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-depths-intervention-"));
    const outputPath = join(tempDir, "latest-depths.json");
    const historyPath = join(tempDir, "depths-history.jsonl");

    const sampleItem: GitHubSearchItem = {
      number: 12345,
      title: "Sample item",
      html_url: "https://github.com/microsoft/winget-pkgs/pull/12345",
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-11-01T10:00:00Z",
    };

    const specs: MockPrSpec[] = [
      {
        number: 801,
        createdAt: "2026-10-05T00:00:00Z",
        author: "first-timer",
        assignees: [{ login: "first-timer" }],
      },
      {
        number: 802,
        createdAt: "2026-10-06T00:00:00Z",
        author: "stuck-user",
        comments: {
          nodes: [
            { author: { __typename: "User", login: "stephengillie" }, body: "Need privacy policy" },
          ],
        },
      },
    ];
    const nodeMap = new Map(specs.map((s) => [s.number, createInterventionNode(s)]));

    const mockClient = {
      getPullRequest: async (_repo: string, prNumber: number): Promise<GitHubPrView> => ({
        number: prNumber,
        title: "Target PR title",
        url: `https://github.com/microsoft/winget-pkgs/pull/${prNumber}`,
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-16T00:00:00Z",
        author: "target-author",
        thirdPartyAssignees: [],
        intervention: {
          Intervened: true,
          ThirdPartyAssignees: [],
          HumanReviewCount: 0,
          ManualCommentCount: 1,
          PrimaryBadge: {
            Kind: "comment",
            Actor: "stephengillie",
            Label: "コメント済: stephengillie",
          },
        },
      }),
      searchIssues: async (): Promise<GitHubSearchItem[]> => [sampleItem],
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ number: 801 }, { number: 802 }],
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          return { repository: buildBatchRepoFromSpecs(query, nodeMap) } as unknown as T;
        }
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 801,
                title: "PR #801",
                url: "https://github.com/microsoft/winget-pkgs/pull/801",
                createdAt: "2026-10-05T00:00:00Z",
                updatedAt: "2026-10-05T00:00:00Z",
                author: { login: "first-timer" },
                authorAssociation: "NONE",
                commits: { totalCount: 1 },
                assignees: { nodes: [{ login: "first-timer" }] },
              },
              {
                number: 802,
                title: "PR #802",
                url: "https://github.com/microsoft/winget-pkgs/pull/802",
                createdAt: "2026-10-06T00:00:00Z",
                updatedAt: "2026-10-06T00:00:00Z",
                author: { login: "stuck-user" },
                authorAssociation: "NONE",
                commits: { totalCount: 1 },
                assignees: { nodes: [{ login: "stephengillie" }] },
              },
            ],
          },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    try {
      const snapshot = await runExploreDepths(
        {
          targetPr: 464302,
          repository: "microsoft/winget-pkgs",
          outputPath,
          historyPath,
          noTargetPr: false,
          noHistory: false,
          asJson: false,
        },
        mockClient,
        () => {},
      );

      expect(snapshot.DepthsVersion).toBe(CURRENT_DEPTHS_VERSION);
      expect(snapshot.FirstReviewFrontier?.Mode).toBe(FIRST_REVIEW_MAINSTREAM_MODE);
      expect(snapshot.TargetPr?.Intervention?.PrimaryBadge?.Label).toBe(
        "コメント済: stephengillie",
      );
      expect(snapshot.UnreviewedBottom?.map((r) => r.Number)).toEqual([801]);
      expect(snapshot.IntervenedBottom?.map((r) => r.Number)).toEqual([802]);
      expect(snapshot.IntervenedBottom?.[0].Intervention?.PrimaryBadge?.Label).toBe(
        "コメント済: stephengillie",
      );
      expect(snapshot.HealthyBottom[0].ThirdPartyAssignees).toEqual([]);
      expect(snapshot.HealthyBottom[1].ThirdPartyAssignees).toEqual(["stephengillie"]);

      const saved = JSON.parse(readFileSync(outputPath, "utf-8"));
      expect(saved.DepthsVersion).toBe(CURRENT_DEPTHS_VERSION);
      expect(saved.FirstReviewFrontier.Mode).toBe(FIRST_REVIEW_MAINSTREAM_MODE);
      expect(saved.UnreviewedBottom[0].Number).toBe(801);
      expect(saved.IntervenedBottom[0].Intervention.PrimaryBadge.Label).toBe(
        "コメント済: stephengillie",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
