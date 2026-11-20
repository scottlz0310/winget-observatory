import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient } from "../../src/api/github";
import {
  fetchFirstReviewFrontiers,
  fetchFirstTimerBottom,
  fetchHealthyBottoms,
  fetchInterventionFrontiers,
  runExploreDepths,
} from "../../src/cli/explore-depths";
import { buildHealthyBaseQuery } from "../../src/domain/depths";
import type { GitHubPrView, GitHubSearchItem, GraphQLPrNode } from "../../src/models/depths";

describe("CLI: explore-depths の初回提出者の底（First-Timer Bottom）走査", () => {
  const createMockNode = (
    number: number,
    author: string,
    association: string,
    commits = 1,
  ): GraphQLPrNode => ({
    number,
    title: `PR ${number} by ${author}`,
    url: `https://github.com/microsoft/winget-pkgs/pull/${number}`,
    createdAt: "2026-10-09T01:00:00Z",
    updatedAt: "2026-10-09T02:00:00Z",
    author: { login: author },
    authorAssociation: association,
    commits: { totalCount: commits },
  });

  test("先頭50件が常連（CONTRIBUTOR）の場合に2ページ目を走査して候補を取得する", async () => {
    const page1Nodes: GraphQLPrNode[] = Array.from({ length: 50 }, (_, i) =>
      createMockNode(400000 + i, `contributor-${i}`, "CONTRIBUTOR"),
    );
    const page2Nodes: GraphQLPrNode[] = Array.from({ length: 10 }, (_, i) =>
      createMockNode(400100 + i, `first-timer-${i}`, "NONE"),
    );

    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const mockClient = {
      graphql: async <T>(_query: string, variables: Record<string, unknown>): Promise<T> => {
        calls.push({ query: _query, variables });
        if (!variables.after) {
          // 1ページ目
          return {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
              nodes: page1Nodes,
            },
          } as unknown as T;
        }
        // 2ページ目
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: "cursor-page-2" },
            nodes: page2Nodes,
          },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const results = await fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 10);

    const searchCalls = calls.filter((c) =>
      String(c.variables?.query ?? "").includes("sort:created-asc"),
    );
    expect(searchCalls.length).toBe(2);
    expect(searchCalls[0].variables.after).toBeUndefined();
    expect(searchCalls[1].variables.after).toBe("cursor-page-1");
    expect(results.length).toBe(10);
    expect(results[0].Number).toBe(400100);
    expect(results[0].Author).toBe("first-timer-0");
  });

  test("先頭200件が CONTRIBUTOR で201〜210件目に初回提出者がいる場合、200件境界を越えて走査して取得する", async () => {
    // 210件モック: 1〜100件目 CONTRIBUTOR, 101〜200件目 CONTRIBUTOR, 201〜210件目 NONE
    const page1Nodes: GraphQLPrNode[] = Array.from({ length: 100 }, (_, i) =>
      createMockNode(400000 + i, `contributor-p1-${i}`, "CONTRIBUTOR"),
    );
    const page2Nodes: GraphQLPrNode[] = Array.from({ length: 100 }, (_, i) =>
      createMockNode(400100 + i, `contributor-p2-${i}`, "CONTRIBUTOR"),
    );
    const page3Nodes: GraphQLPrNode[] = Array.from({ length: 10 }, (_, i) =>
      createMockNode(400200 + i, `first-timer-${i}`, "NONE"),
    );

    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const mockClient = {
      graphql: async <T>(_query: string, variables: Record<string, unknown>): Promise<T> => {
        calls.push({ query: _query, variables });
        if (!variables.after) {
          return {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              nodes: page1Nodes,
            },
          } as unknown as T;
        }
        if (variables.after === "cursor-1") {
          return {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
              nodes: page2Nodes,
            },
          } as unknown as T;
        }
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: "cursor-3" },
            nodes: page3Nodes,
          },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const results = await fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 10);

    // 200件境界を越えて3回目の検索リクエストが走り、10件取得できたこと
    const searchCalls = calls.filter((c) =>
      String(c.variables?.query ?? "").includes("sort:created-asc"),
    );
    expect(searchCalls.length).toBe(3);
    expect(results.length).toBe(10);
    expect(results[0].Number).toBe(400200);
    expect(results[0].Author).toBe("first-timer-0");
  });

  test("探索上限（maxTraverseNodes）に達したが未走査PRが残っている場合は候補なしと誤認させず例外で中断する", async () => {
    // 200件上限で全件 CONTRIBUTOR かつ hasNextPage: true の場合
    const page1Nodes: GraphQLPrNode[] = Array.from({ length: 100 }, (_, i) =>
      createMockNode(400000 + i, `contributor-p1-${i}`, "CONTRIBUTOR"),
    );
    const page2Nodes: GraphQLPrNode[] = Array.from({ length: 100 }, (_, i) =>
      createMockNode(400100 + i, `contributor-p2-${i}`, "CONTRIBUTOR"),
    );

    const mockClient = {
      graphql: async <T>(_query: string, variables: Record<string, unknown>): Promise<T> => {
        if (!variables.after) {
          return {
            search: {
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              nodes: page1Nodes,
            },
          } as unknown as T;
        }
        return {
          search: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
            nodes: page2Nodes,
          },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    await expect(
      fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 10, 200),
    ).rejects.toThrow(
      "初回提出者の底の探索上限 (200件) に達しましたが、未走査の PR が残っています",
    );
  });

  test("検索結果の終端（hasNextPage: false）まで走査し終えた場合は候補が0件でも正当な結果として返す", async () => {
    const pageNodes: GraphQLPrNode[] = Array.from({ length: 50 }, (_, i) =>
      createMockNode(400000 + i, `contributor-${i}`, "CONTRIBUTOR"),
    );

    const mockClient = {
      graphql: async <T>(): Promise<T> => {
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: "cursor-end" },
            nodes: pageNodes,
          },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const results = await fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 10);
    expect(results).toEqual([]);
  });

  test("採用件数が limit に達した時点で後続ページの走査を行わずに打ち切る", async () => {
    // 1ページ目にすでに10件以上の初回提出者がいる場合
    const page1Nodes: GraphQLPrNode[] = Array.from({ length: 50 }, (_, i) =>
      createMockNode(400000 + i, `first-timer-${i}`, "NONE"),
    );

    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const mockClient = {
      graphql: async <T>(_query: string, variables: Record<string, unknown>): Promise<T> => {
        calls.push({ query: _query, variables });
        return {
          search: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
            nodes: page1Nodes,
          },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const results = await fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 10);

    // 1ページ目で10件に達したため、2ページ目の検索は呼ばれない
    const searchCalls = calls.filter((c) =>
      String(c.variables?.query ?? "").includes("sort:created-asc"),
    );
    expect(searchCalls.length).toBe(1);
    expect(results.length).toBe(10);
  });

  test("複数コミット（commits > 1）の初回提出者（NONE）も除外されずに初回提出者の底として抽出される", async () => {
    // 3コミットの初回提出者PR
    const multiCommitNodes: GraphQLPrNode[] = [
      createMockNode(400501, "multi-commit-first-timer-1", "NONE", 3),
      createMockNode(400502, "multi-commit-first-timer-2", "NONE", 5),
    ];

    const mockClient = {
      graphql: async <T>(): Promise<T> =>
        ({
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: multiCommitNodes,
          },
        }) as unknown as T,
    } as unknown as GitHubApiClient;

    const results = await fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 10);
    expect(results.length).toBe(2);
    expect(results[0].Number).toBe(400501);
    expect(results[0].Author).toBe("multi-commit-first-timer-1");
    expect(results[0].CommitCount).toBe(3);
    expect(results[1].Number).toBe(400502);
    expect(results[1].Author).toBe("multi-commit-first-timer-2");
    expect(results[1].CommitCount).toBe(5);
  });

  test("authorAssociation が NONE でも生涯マージ歴 > 0 の作者を除外し、後続ページから補完して CreatedAt 昇順で返す", async () => {
    const page1Nodes: GraphQLPrNode[] = [
      {
        ...createMockNode(400601, "hidden-repeater", "NONE", 2),
        createdAt: "2026-10-01T00:00:00Z",
      },
      {
        ...createMockNode(400602, "true-first-timer-a", "NONE", 1),
        createdAt: "2026-10-02T00:00:00Z",
      },
    ];
    const page2Nodes: GraphQLPrNode[] = [
      {
        ...createMockNode(400603, "true-first-timer-b", "NONE", 4),
        createdAt: "2026-10-03T00:00:00Z",
      },
    ];

    const calls: string[] = [];
    const mockClient = {
      graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
        if (variables.query) {
          calls.push(String(variables.query));
          if (!variables.after) {
            return {
              search: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: page1Nodes },
            } as unknown as T;
          }
          return {
            search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: page2Nodes },
          } as unknown as T;
        }
        // 生涯マージ件数照会: hidden-repeater (u_0) だけ過去に 2 件マージ済み
        if (query.includes("author:hidden-repeater")) {
          return {
            u_0: { issueCount: 2 },
            u_1: { issueCount: 0 },
          } as unknown as T;
        }
        return {
          u_0: { issueCount: 0 },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const results = await fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 2);
    expect(calls[0]).toContain("sort:created-asc");
    expect(results.map((r) => r.Number)).toEqual([400602, 400603]);
    expect(results.map((r) => r.Author)).toEqual(["true-first-timer-a", "true-first-timer-b"]);
    expect(results.map((r) => r.CommitCount)).toEqual([1, 4]);
  });

  test("GraphQL API が 503 等で失敗した場合はコンテキスト付き例外をスローする", async () => {
    const mockClient = {
      graphql: async () => {
        throw new Error("GitHub GraphQL API error: HTTP 503 Service Unavailable");
      },
    } as unknown as GitHubApiClient;

    await expect(
      fetchFirstTimerBottom(mockClient, "repo:microsoft/winget-pkgs", 10),
    ).rejects.toThrow(
      "初回提出者の底の GraphQL 取得に失敗しました: GitHub GraphQL API error: HTTP 503 Service Unavailable",
    );
  });

  test("runExploreDepths は GraphQL 失敗時にスナップショットを保存せず例外を伝播する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-depths-gql-fail-"));
    const outputPath = join(tempDir, "latest-depths.json");
    const historyPath = join(tempDir, "depths-history.jsonl");

    const sampleItem: GitHubSearchItem = {
      number: 12345,
      title: "Sample item",
      html_url: "https://github.com/microsoft/winget-pkgs/pull/12345",
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-11-01T10:00:00Z",
    };

    const mockClient = {
      getPullRequest: async (_repo: string, prNumber: number): Promise<GitHubPrView> => ({
        number: prNumber,
        title: "Target PR title",
        url: `https://github.com/microsoft/winget-pkgs/pull/${prNumber}`,
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-16T00:00:00Z",
      }),
      searchIssues: async (): Promise<GitHubSearchItem[]> => [sampleItem],
      graphql: async () => {
        throw new Error("GraphQL network failure 503");
      },
    } as unknown as GitHubApiClient;

    try {
      await expect(
        runExploreDepths(
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
        ),
      ).rejects.toThrow("健康的大底・初回提出者の底の GraphQL 取得に失敗しました");

      // 失敗時はファイルへの書き込みが行われないこと
      expect(existsSync(outputPath)).toBeFalse();
      expect(existsSync(historyPath)).toBeFalse();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("CLI: explore-depths Phase 1（2×2 GraphQL 統一・作者メタデータ・キャッシュ共有）", () => {
  test("fetchHealthyBottoms は 1 回の GraphQL 走査で HealthyBottom（全体 TOP N）と FirstTimerBottom（初回 TOP N）を同時取得し作者メタデータを付与する", async () => {
    const nodes: GraphQLPrNode[] = [
      {
        number: 510001,
        title: "Contributor PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/510001",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-10T00:00:00Z",
        author: { login: "regular-dev" },
        authorAssociation: "CONTRIBUTOR",
        commits: { totalCount: 3 },
      },
      {
        number: 510002,
        title: "Hidden Repeater PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/510002",
        createdAt: "2026-10-02T00:00:00Z",
        updatedAt: "2026-10-11T00:00:00Z",
        author: { login: "hidden-rep" },
        authorAssociation: "NONE",
        commits: { totalCount: 2 },
      },
      {
        number: 510003,
        title: "True First Timer 1",
        url: "https://github.com/microsoft/winget-pkgs/pull/510003",
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-10-12T00:00:00Z",
        author: { login: "ft-alice" },
        authorAssociation: "NONE",
        commits: { totalCount: 4 },
      },
      {
        number: 510004,
        title: "True First Timer 2",
        url: "https://github.com/microsoft/winget-pkgs/pull/510004",
        createdAt: "2026-10-04T00:00:00Z",
        updatedAt: "2026-10-13T00:00:00Z",
        author: { login: "ft-bob" },
        authorAssociation: "NONE",
        commits: { totalCount: 1 },
      },
    ];

    const searchQueries: string[] = [];
    const mergedCountQueries: string[] = [];
    const mockClient = {
      graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
        if (variables.query) {
          searchQueries.push(String(variables.query));
          return {
            search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          } as unknown as T;
        }
        if (query.includes("u_0: search(")) {
          mergedCountQueries.push(query);
          const result: Record<string, { issueCount: number }> = {};
          const matches = [...query.matchAll(/u_(\d+): search\(query: "[^"]*author:([^\s"]+)/g)];
          for (const m of matches) {
            const idx = m[1];
            const author = m[2];
            result[`u_${idx}`] = { issueCount: author === "hidden-rep" ? 3 : 0 };
          }
          return result as unknown as T;
        }
        throw new Error(`想定外のクエリ: ${query}`);
      },
    } as unknown as GitHubApiClient;

    const cache = new Map<string, number>();
    const { healthyBottom, firstTimerBottom } = await fetchHealthyBottoms(
      mockClient,
      buildHealthyBaseQuery("microsoft/winget-pkgs"),
      2,
      100,
      cache,
    );

    expect(searchQueries.length).toBe(1);
    expect(searchQueries[0]).toContain("sort:created-asc");
    expect(healthyBottom.map((r) => r.Number)).toEqual([510001, 510002]);
    expect(healthyBottom[0].AuthorAssociation).toBe("CONTRIBUTOR");
    expect(healthyBottom[0].CommitCount).toBe(3);
    expect(healthyBottom[1].AuthorMergedCount).toBe(3);

    expect(firstTimerBottom.map((r) => r.Number)).toEqual([510003, 510004]);
    expect(firstTimerBottom[0].AuthorMergedCount).toBe(0);
    expect(firstTimerBottom[1].AuthorMergedCount).toBe(0);
    expect(cache.get("hidden-rep")).toBe(3);
    expect(cache.get("ft-alice")).toBe(0);
    expect(cache.get("ft-bob")).toBe(0);
    expect(mergedCountQueries.length).toBeGreaterThanOrEqual(1);
  });

  test("fetchInterventionFrontiers は未レビュー PR に AuthorMergedCount を付与し常連を除外した FirstTimerUnreviewedBottom を同時収集する", async () => {
    const mockNodes: Record<number, Record<string, unknown>> = {
      530001: {
        number: 530001,
        title: "Unreviewed hidden repeater",
        url: "https://github.com/microsoft/winget-pkgs/pull/530001",
        state: "OPEN",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        author: { __typename: "User", login: "hidden-rep" },
        authorAssociation: "NONE",
        commits: { totalCount: 3 },
        assignees: { nodes: [] },
        reviews: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
      530002: {
        number: 530002,
        title: "Unreviewed true first timer",
        url: "https://github.com/microsoft/winget-pkgs/pull/530002",
        state: "OPEN",
        createdAt: "2026-10-02T00:00:00Z",
        updatedAt: "2026-10-03T00:00:00Z",
        author: { __typename: "User", login: "ft-unrev" },
        authorAssociation: "NONE",
        commits: { totalCount: 2 },
        assignees: { nodes: [] },
        reviews: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    };

    const cache = new Map<string, number>([["hidden-rep", 2]]);
    let mergedQueryCount = 0;

    const mockClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ number: 530001 }, { number: 530002 }],
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          return {
            repository: {
              pr0: mockNodes[530001],
              pr1: mockNodes[530002],
            },
          } as unknown as T;
        }
        if (query.includes("u_0: search(")) {
          mergedQueryCount++;
          // hidden-rep はキャッシュ済みのため ft-unrev のみ照会されること
          expect(query).toContain("author:ft-unrev");
          expect(query).not.toContain("author:hidden-rep");
          return { u_0: { issueCount: 0 } } as unknown as T;
        }
        throw new Error(`想定外のクエリ: ${query}`);
      },
    } as unknown as GitHubApiClient;

    const result = await fetchInterventionFrontiers(
      mockClient,
      buildHealthyBaseQuery("microsoft/winget-pkgs"),
      2,
      100,
      15,
      cache,
    );

    expect(mergedQueryCount).toBe(1);
    expect(result.unreviewedBottom.map((r) => r.Number)).toEqual([530001, 530002]);
    expect(result.unreviewedBottom[0].AuthorMergedCount).toBe(2);
    expect(result.unreviewedBottom[1].AuthorMergedCount).toBe(0);
    expect(result.firstTimerUnreviewedBottom.map((r) => r.Number)).toEqual([530002]);
    expect(result.firstTimerUnreviewedTruncated).toBe(false);
  });

  test("fetchFirstReviewFrontiers は常連（CONTRIBUTOR・NONEマージ歴あり）と初回提出者が混在するケースで全体コホートと初回限定コホートを両方算出する", async () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const prDetails: Record<number, Record<string, unknown>> = {
      550001: {
        number: 550001,
        title: "Open Contributor PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/550001",
        state: "OPEN",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-11-18T00:00:00Z",
        author: { __typename: "User", login: "regular-contrib" },
        authorAssociation: "CONTRIBUTOR",
        commits: { totalCount: 1 },
        assignees: { nodes: [] },
        reviews: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { __typename: "User", login: "reviewer-a" },
              state: "COMMENTED",
              submittedAt: "2026-11-18T00:00:00Z",
            },
          ],
        },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
      550002: {
        number: 550002,
        title: "Open Hidden Repeater PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/550002",
        state: "OPEN",
        createdAt: "2026-10-05T00:00:00Z",
        updatedAt: "2026-11-18T01:00:00Z",
        author: { __typename: "User", login: "hidden-rep" },
        authorAssociation: "NONE",
        commits: { totalCount: 2 },
        assignees: { nodes: [] },
        reviews: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { __typename: "User", login: "reviewer-a" },
              state: "COMMENTED",
              submittedAt: "2026-11-18T01:00:00Z",
            },
          ],
        },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
      550003: {
        number: 550003,
        title: "Open True First Timer PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/550003",
        state: "OPEN",
        createdAt: "2026-10-10T00:00:00Z",
        updatedAt: "2026-11-18T02:00:00Z",
        author: { __typename: "User", login: "ft-open" },
        authorAssociation: "NONE",
        commits: { totalCount: 1 },
        assignees: { nodes: [] },
        reviews: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { __typename: "User", login: "reviewer-b" },
              state: "COMMENTED",
              submittedAt: "2026-11-18T02:00:00Z",
            },
          ],
        },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
      550004: {
        number: 550004,
        title: "Merged Regular PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/550004",
        state: "MERGED",
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-11-19T00:00:00Z",
        mergedAt: "2026-11-19T00:00:00Z",
        author: { __typename: "User", login: "regular-merged" },
        authorAssociation: "CONTRIBUTOR",
        commits: { totalCount: 1 },
        assignees: { nodes: [] },
        reviews: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { __typename: "User", login: "reviewer-b" },
              state: "APPROVED",
              submittedAt: "2026-11-19T00:00:00Z",
            },
          ],
        },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
      550005: {
        number: 550005,
        title: "Merged True First Timer PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/550005",
        state: "MERGED",
        createdAt: "2026-10-20T00:00:00Z",
        updatedAt: "2026-11-19T01:00:00Z",
        mergedAt: "2026-11-19T01:00:00Z",
        author: { __typename: "User", login: "ft-merged" },
        authorAssociation: "CONTRIBUTOR",
        commits: { totalCount: 1 },
        assignees: { nodes: [] },
        reviews: {
          totalCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              author: { __typename: "User", login: "reviewer-b" },
              state: "APPROVED",
              submittedAt: "2026-11-19T01:00:00Z",
            },
          ],
        },
        comments: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    };

    const mockClient = {
      graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (query.includes("SearchInterventionLightCandidates")) {
          const q = String(variables?.query ?? "");
          if (q.includes("is:open")) {
            return {
              search: {
                issueCount: 3,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 550001,
                    author: { login: "regular-contrib" },
                    authorAssociation: "CONTRIBUTOR",
                  },
                  { number: 550002, author: { login: "hidden-rep" }, authorAssociation: "NONE" },
                  { number: 550003, author: { login: "ft-open" }, authorAssociation: "NONE" },
                ],
              },
            } as unknown as T;
          }
          return {
            search: {
              issueCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 550004,
                  author: { login: "regular-merged" },
                  authorAssociation: "CONTRIBUTOR",
                },
                {
                  number: 550005,
                  author: { login: "ft-merged" },
                  authorAssociation: "CONTRIBUTOR",
                },
              ],
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          const repo: Record<string, unknown> = {};
          for (const m of query.matchAll(/pr(\d+): pullRequest\(number: (\d+)\)/g)) {
            repo[`pr${m[1]}`] = prDetails[Number(m[2])] ?? null;
          }
          return { repository: repo } as unknown as T;
        }
        if (query.includes("u_0: search(")) {
          const counts: Record<string, number> = {
            "hidden-rep": 4,
            "ft-open": 0,
            "regular-merged": 5,
            "ft-merged": 1,
          };
          const res: Record<string, { issueCount: number }> = {};
          for (const m of query.matchAll(/u_(\d+): search\(query: "[^"]*author:([^\s"]+)/g)) {
            res[`u_${m[1]}`] = { issueCount: counts[m[2]] ?? 0 };
          }
          return res as unknown as T;
        }
        throw new Error(`想定外のクエリ: ${query}`);
      },
    } as unknown as GitHubApiClient;

    const { firstReviewFrontier, allAuthorsFirstReviewFrontier } = await fetchFirstReviewFrontiers({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      now,
    });

    // 全体コホートには常連・初回の全 5 件（Open 3 / Merged 2）が含まれること
    expect(allAuthorsFirstReviewFrontier.CohortCount).toBe(5);
    expect(allAuthorsFirstReviewFrontier.OpenCount).toBe(3);
    expect(allAuthorsFirstReviewFrontier.MergedCount).toBe(2);
    expect(allAuthorsFirstReviewFrontier.MedianCreatedAt).toBe("2026-10-10T00:00:00.000Z");

    // 初回限定コホートには真の初回提出者 2 件（#550003, #550005）のみが含まれること
    expect(firstReviewFrontier.CohortCount).toBe(2);
    expect(firstReviewFrontier.OpenCount).toBe(1);
    expect(firstReviewFrontier.MergedCount).toBe(1);
    expect(firstReviewFrontier.Items?.map((i) => i.Number)).toEqual([550005, 550003]);
  });
});
