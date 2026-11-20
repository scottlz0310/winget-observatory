import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient } from "../../src/api/github";
import {
  BOTTOM_LIST_LIMIT as DIRECT_BOTTOM_LIST_LIMIT,
  FIRST_TIMER_MAX_NODES as DIRECT_FIRST_TIMER_MAX_NODES,
  FIRST_TIMER_PAGE_SIZE as DIRECT_FIRST_TIMER_PAGE_SIZE,
  fetchFirstTimerBottom as directFetchFirstTimerBottom,
  fetchHealthyBottoms as directFetchHealthyBottoms,
} from "../../src/cli/depths-bottom-collector";
import {
  INTERVENTION_BATCH_SIZE as DIRECT_INTERVENTION_BATCH_SIZE,
  fetchInterventionFrontiers as directFetchInterventionFrontiers,
} from "../../src/cli/depths-intervention-collector";
import {
  MAINSTREAM_SEARCH_PAGE_SIZE as DIRECT_MAINSTREAM_SEARCH_PAGE_SIZE,
  fetchFirstReviewFrontiers as directFetchFirstReviewFrontiers,
  fetchFirstReviewMainstreamFrontier as directFetchFirstReviewMainstreamFrontier,
} from "../../src/cli/depths-mainstream-collector";
import {
  BOTTOM_LIST_LIMIT,
  FIRST_TIMER_MAX_NODES,
  FIRST_TIMER_PAGE_SIZE,
  fetchFirstReviewFrontiers,
  fetchFirstReviewMainstreamFrontier,
  fetchFirstTimerBottom,
  fetchHealthyBottoms,
  fetchInterventionFrontiers,
  INTERVENTION_BATCH_SIZE,
  MAINSTREAM_SEARCH_PAGE_SIZE,
  parseArgs,
  resolveDefaultDataDir,
  runExploreDepths,
} from "../../src/cli/explore-depths";
import { buildHealthyBaseQuery, CURRENT_DEPTHS_VERSION } from "../../src/domain/depths";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "../../src/domain/intervention";
import type { GitHubPrView, GitHubSearchItem, GraphQLPrNode } from "../../src/models/depths";

describe("CLI: explore-depths", () => {
  test("parseArgs はコマンドライン引数と環境変数を正確に解釈する", () => {
    const opts = parseArgs([
      "--target-pr",
      "999999",
      "--repository",
      "test/repo",
      "--output-path",
      "out.json",
      "--history-path",
      "hist.jsonl",
      "--no-target-pr",
      "--no-history",
      "--as-json",
    ]);

    expect(opts.targetPr).toBe(999999);
    expect(opts.repository).toBe("test/repo");
    expect(opts.outputPath).toBe("out.json");
    expect(opts.historyPath).toBe("hist.jsonl");
    expect(opts.noTargetPr).toBe(true);
    expect(opts.noHistory).toBe(true);
    expect(opts.asJson).toBe(true);
  });

  test("runExploreDepths はモック API クライアントを用いて各底を探索しスナップショットを保存する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-depths-test-"));
    const outputPath = join(tempDir, "latest-depths.json");
    const historyPath = join(tempDir, "depths-history.jsonl");

    const sampleItem: GitHubSearchItem = {
      number: 12345,
      title: "New package: sample version 1.0",
      html_url: "https://github.com/microsoft/winget-pkgs/pull/12345",
      created_at: "2026-10-01T10:00:00Z",
      updated_at: "2026-11-01T10:00:00Z",
    };

    const searchQueries: string[] = [];
    const mockClient = {
      getPullRequest: async (_repo: string, prNumber: number): Promise<GitHubPrView> => ({
        number: prNumber,
        title: "Target PR title",
        url: `https://github.com/microsoft/winget-pkgs/pull/${prNumber}`,
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-16T00:00:00Z",
      }),
      searchIssues: async (query: string): Promise<GitHubSearchItem[]> => {
        searchQueries.push(query);
        return [sampleItem];
      },
      graphql: async (): Promise<{ search: { nodes: unknown[] } }> => ({
        search: {
          nodes: [
            {
              number: 450001,
              title: "First Timer Sample",
              url: "https://github.com/microsoft/winget-pkgs/pull/450001",
              createdAt: "2026-10-09T01:00:00Z",
              updatedAt: "2026-10-09T02:00:00Z",
              author: { login: "first-timer-user" },
              authorAssociation: "NONE",
              commits: { totalCount: 1 },
              labels: { nodes: [{ name: "New-Package" }] },
            },
          ],
        },
      }),
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

      // スナップショットの検証
      expect(snapshot.Repository).toBe("microsoft/winget-pkgs");
      expect(snapshot.TargetPr?.Number).toBe(464302);
      expect(snapshot.HealthyBottom.length).toBe(1);
      expect(snapshot.AbsoluteBottom.length).toBe(1);
      expect(snapshot.SingleCommitBottom).toBeUndefined();
      expect(snapshot.StaleBottom).toBeUndefined();
      expect(snapshot.FirstTimerBottom?.length).toBe(1);
      expect(snapshot.FirstTimerBottom?.[0].Author).toBe("first-timer-user");
      expect(snapshot.FirstTimerBottom?.[0].CommitCount).toBe(1);
      expect(snapshot.ExpressLane.length).toBe(1);

      // Search API は Absolute, Express の 2 クエリのみ（Healthy / FirstTimer は GraphQL）
      expect(searchQueries.length).toBe(2);

      // 出力ファイルの検証
      expect(existsSync(outputPath)).toBe(true);
      const savedJson = JSON.parse(readFileSync(outputPath, "utf-8"));
      expect(savedJson.TargetPr.Number).toBe(464302);
      expect(savedJson.FirstTimerBottom[0].CommitCount).toBe(1);

      expect(existsSync(historyPath)).toBe(true);
      const lines = readFileSync(historyPath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(1);
      const savedLine = JSON.parse(lines[0]);
      expect(savedLine.Repository).toBe("microsoft/winget-pkgs");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "--target-pr に数値以外",
      ["--target-pr", "abc"],
      "--target-pr に無効な値が指定されました: abc",
    ],
    ["--target-pr に負数", ["--target-pr", "-1"], undefined],
    ["--target-pr の値が欠落", ["--target-pr"], "--target-pr オプションには正の整数の値が必要です"],
    [
      "--repository の値が欠落",
      ["--repository"],
      "--repository オプションにはリポジトリ名 (owner/repo) の値が必要です",
    ],
    [
      "--output-path の値が欠落",
      ["--output-path"],
      "--output-path オプションにはファイルパスが必要です",
    ],
    [
      "値を取るフラグの直後に別のフラグ (--output-path)",
      ["--output-path", "--no-history"],
      "--output-path オプションにはファイルパスが必要です",
    ],
    [
      "値を取るフラグの直後に別のフラグ (--target-pr)",
      ["--target-pr", "--no-target-pr"],
      "--target-pr オプションには正の整数の値が必要です",
    ],
    ["未知のオプション", ["--unknown-flag"], "未知の引数が指定されました: --unknown-flag"],
  ])("parseArgs は不正な引数を拒否する: %s", (_name, args, message) => {
    expect(() => parseArgs(args)).toThrow(message);
  });

  test("既定の保存先は実行時の cwd ではなくリポジトリルートの data/ を起点に解決する", () => {
    const tempWorkingDir = mkdtempSync(join(tmpdir(), "winget-depths-external-cwd-"));
    const originalCwd = process.cwd();

    const expectedRepoDataDir = join(__dirname, "../../data");

    try {
      // 1. 通常の cwd で解決されるパスの確認
      const defaultDir1 = resolveDefaultDataDir();
      expect(defaultDir1).toBe(expectedRepoDataDir);

      // 2. repo 外の外部ディレクトリを cwd に変更した場合でも、常にリポジトリルートの data/ を指すこと
      process.chdir(tempWorkingDir);
      const defaultDir2 = resolveDefaultDataDir();
      expect(defaultDir2).toBe(expectedRepoDataDir);
      expect(defaultDir2).not.toBe(join(tempWorkingDir, "data"));
    } finally {
      process.chdir(originalCwd);
      rmSync(tempWorkingDir, { recursive: true, force: true });
    }
  });

  test("noTargetPr 指定時は全体観測モードとして動作し特急レーン探索を行わない", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-depths-no-target-"));
    const outputPath = join(tempDir, "latest-depths.json");

    const searchQueries: string[] = [];
    const mockClient = {
      getPullRequest: async () => {
        throw new Error("Should not be called");
      },
      searchIssues: async (query: string): Promise<GitHubSearchItem[]> => {
        searchQueries.push(query);
        return [];
      },
      graphql: async () => ({ search: { nodes: [] } }),
    } as unknown as GitHubApiClient;

    try {
      const snapshot = await runExploreDepths(
        {
          targetPr: 464302,
          repository: "microsoft/winget-pkgs",
          outputPath,
          noTargetPr: true,
          noHistory: true,
          asJson: true,
        },
        mockClient,
        () => {},
      );

      expect(snapshot.TargetPr).toBeNull();
      // Search API は Absolute の 1 クエリのみ（Express は実行されず、Healthy / SingleCommit / Stale / FirstTimer は GraphQL）
      expect(searchQueries.length).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("基準 PR の取得に失敗した場合は履歴を汚さず中断する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-depths-target-fail-"));
    const historyPath = join(tempDir, "depths-history.jsonl");
    const outputPath = join(tempDir, "latest-depths.json");

    const mockClient = {
      getPullRequest: async () => {
        throw new Error("GitHub Pull Request 取得に失敗しました (status 502)");
      },
      searchIssues: async (): Promise<GitHubSearchItem[]> => [],
    } as unknown as GitHubApiClient;

    try {
      await expect(
        runExploreDepths(
          {
            targetPr: 464302,
            repository: "microsoft/winget-pkgs",
            historyPath,
            outputPath,
            noTargetPr: false,
            noHistory: false,
            asJson: true,
          },
          mockClient,
          () => {},
        ),
      ).rejects.toThrow("status 502");
      expect(existsSync(historyPath)).toBeFalse();
      expect(existsSync(outputPath)).toBeFalse();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

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
        assignees: [{ login: "u2" }],
      },
      {
        number: 613,
        createdAt: "2026-10-03T00:00:00Z",
        author: null,
        assignees: [{ login: "stephengillie" }],
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
        assignees: [{ login: "stephengillie" }],
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
        assignees: [{ login: "trenly" }],
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
      assignees: [{ login: "stephengillie" }],
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

  test("COLLABORATOR の Deterministic automation コメント付き PR (#439626 相当) は未レビュー前線から除外され介入済み側へ分類される（Issue #121）", async () => {
    const privAutoPr = createInterventionNode({
      number: 439626,
      createdAt: "2026-09-23T08:52:58Z",
      author: "rakleed",
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            createdAt: "2026-10-30T06:18:49Z",
            body: "This manifest version has been depreciated. Please use version `1.28.0`. (Deterministic automation - build 1830.)",
          },
        ],
      },
    });
    const trueUnreviewedPr = createInterventionNode({
      number: 448260,
      createdAt: "2026-10-07T15:34:01Z",
      author: "Aureliolo",
      comments: {
        nodes: [
          {
            author: { __typename: "Bot", login: "microsoft-github-policy-service" },
            authorAssociation: "CONTRIBUTOR",
            createdAt: "2026-10-07T15:35:00Z",
            body: "CLA check",
          },
          {
            author: { __typename: "User", login: "Aureliolo" },
            authorAssociation: "CONTRIBUTOR",
            createdAt: "2026-10-07T15:36:00Z",
            body: "@microsoft-github-policy-service agree",
          },
        ],
      },
    });

    const nodeMap = new Map([
      [439626, privAutoPr],
      [448260, trueUnreviewedPr],
    ]);
    const mockClient = {
      graphql: async <T>(query: string): Promise<T> => {
        if (query.includes("SearchPrNumbers")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ number: 439626 }, { number: 448260 }],
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
    expect(result.unreviewedBottom.map((r) => r.Number)).toEqual([448260]);
    expect(result.intervenedBottom.map((r) => r.Number)).toEqual([439626]);
    expect(result.intervenedBottom[0]?.Intervention?.PrimaryBadge?.Label).toBe(
      "自動指摘済: stephengillie",
    );
    expect(result.intervenedBottom[0]?.Intervention?.FirstHumanInterventionAt).toBeUndefined();
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

  test("fetchFirstReviewMainstreamFrontier は軽量2段階SearchでオープンPRと merged-samples.jsonl キャッシュ・増分マージPRを合算し、ボット/常連をバッチ取得前に除外して中央値を算出する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-mainstream-test-"));
    const samplesPath = join(tempDir, "merged-samples.jsonl");
    const now = new Date("2026-11-17T00:00:00Z");

    // キャッシュ済みマージ済み PR #901（初回提出者・3日前にマージ）
    writeFileSync(
      samplesPath,
      `${JSON.stringify({
        Type: "sample",
        Number: 901,
        Title: "Merged First Timer 901",
        CreatedAt: "2026-10-01T00:00:00Z",
        LatestCommittedDate: "2026-10-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-10-01T01:00:00Z",
        MergedAt: "2026-11-14T00:00:00Z",
        TotalDays: 44,
        TurnDays: 44,
        ReadyDays: 44,
        Author: "cached-ft",
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      })}\n`,
      "utf-8",
    );

    const batchedQueries: string[] = [];
    const mockClient = {
      graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (query.includes("SearchInterventionLightCandidates")) {
          const searchQ = String(variables?.query ?? "");
          if (searchQ.includes("is:open")) {
            return {
              search: {
                issueCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 902,
                    author: { login: "open-ft" },
                    authorAssociation: "NONE",
                  },
                  // 常連 CONTRIBUTOR #903 → 軽量段階で除外され詳細バッチに入らない
                  {
                    number: 903,
                    author: { login: "repeater-open" },
                    authorAssociation: "CONTRIBUTOR",
                  },
                ],
              },
            } as unknown as T;
          }
          // キャッシュ以降の増分マージ PR #904（#901 はキャッシュ済み初回なので Search 結果に出なくてもバッチに含まれる）
          return {
            search: {
              issueCount: 1,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 904,
                  author: { login: "inc-ft" },
                  authorAssociation: "CONTRIBUTOR",
                },
              ],
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          batchedQueries.push(query);
          if (query.includes("number: 902")) {
            return {
              repository: {
                pr0: {
                  number: 902,
                  title: "Open First Timer 902",
                  url: "https://github.com/microsoft/winget-pkgs/pull/902",
                  state: "OPEN",
                  createdAt: "2026-10-11T00:00:00Z",
                  updatedAt: "2026-11-12T00:00:00Z",
                  author: { __typename: "User", login: "open-ft" },
                  authorAssociation: "NONE",
                  commits: { totalCount: 1 },
                  comments: {
                    nodes: [
                      {
                        author: { __typename: "Bot", login: "microsoft-github-policy-service" },
                        body: "bot",
                        createdAt: "2026-10-11T01:00:00Z",
                      },
                      {
                        author: { __typename: "User", login: "stephengillie" },
                        body: "Please check checksum",
                        createdAt: "2026-11-12T00:00:00Z",
                      },
                    ],
                  },
                },
              },
            } as unknown as T;
          }
          return {
            repository: {
              pr0: {
                number: 901,
                title: "Merged First Timer 901",
                url: "https://github.com/microsoft/winget-pkgs/pull/901",
                state: "MERGED",
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-11-14T00:00:00Z",
                mergedAt: "2026-11-14T00:00:00Z",
                author: { __typename: "User", login: "cached-ft" },
                authorAssociation: "CONTRIBUTOR",
                commits: { totalCount: 1 },
                reviews: {
                  nodes: [
                    {
                      author: { __typename: "User", login: "stephengillie" },
                      state: "APPROVED",
                      submittedAt: "2026-11-14T00:00:00Z",
                    },
                  ],
                },
              },
              pr1: {
                number: 904,
                title: "Incremental Merged FT 904",
                url: "https://github.com/microsoft/winget-pkgs/pull/904",
                state: "MERGED",
                createdAt: "2026-10-21T00:00:00Z",
                updatedAt: "2026-11-16T12:00:00Z",
                mergedAt: "2026-11-16T12:00:00Z",
                author: { __typename: "User", login: "inc-ft" },
                authorAssociation: "CONTRIBUTOR",
                commits: { totalCount: 2 },
                reviews: {
                  nodes: [
                    {
                      author: { __typename: "User", login: "trenly" },
                      state: "APPROVED",
                      submittedAt: "2026-11-16T12:00:00Z",
                    },
                  ],
                },
              },
            },
          } as unknown as T;
        }
        // resolveAuthorMergedCounts: open-ft=0, inc-ft=1
        if (query.includes("author:open-ft")) {
          return { u_0: { issueCount: 0 } } as unknown as T;
        }
        if (query.includes("author:inc-ft")) {
          return { u_0: { issueCount: 1 } } as unknown as T;
        }
        return {} as T;
      },
    } as unknown as GitHubApiClient;

    try {
      const frontier = await fetchFirstReviewMainstreamFrontier({
        client: mockClient,
        repository: "microsoft/winget-pkgs",
        now,
        samplesPath,
      });

      // 3 件: #901 (10/01 MERGED), #902 (10/11 OPEN), #904 (10/21 MERGED) → 中央値は 10/11
      expect(frontier.Mode).toBe(FIRST_REVIEW_MAINSTREAM_MODE);
      expect(frontier.CohortCount).toBe(3);
      expect(frontier.OpenCount).toBe(1);
      expect(frontier.MergedCount).toBe(2);
      expect(frontier.MedianCreatedAt).toBe("2026-10-11T00:00:00.000Z");
      expect(frontier.LagDays).toBe(37);
      expect(frontier.Items?.map((i) => i.Number)).toEqual([904, 901, 902]);
      // 常連 CONTRIBUTOR #903 は軽量段階で除外され詳細バッチに含まれないこと
      expect(batchedQueries.some((q) => q.includes("number: 903"))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("部分キャッシュ（新しい日時の skipped レコードのみ）があっても過去の未キャッシュ初回マージPRを取りこぼさず、アサイン解除済みオープンPRも含める", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-mainstream-partial-cache-"));
    const samplesPath = join(tempDir, "merged-samples.jsonl");
    const now = new Date("2026-11-17T00:00:00Z");

    // 11/16 の skipped レコード 1 件（および IsFirstTimer=false 1 件）だけがキャッシュに存在
    writeFileSync(
      samplesPath,
      [
        JSON.stringify({
          Type: "skipped",
          Number: 951,
          Reason: "no-ready",
          MergedAt: "2026-11-16T00:00:00Z",
        }),
        JSON.stringify({
          Type: "sample",
          Number: 952,
          Title: "Known Repeater",
          CreatedAt: "2026-11-10T00:00:00Z",
          LatestCommittedDate: "2026-11-10T00:00:00Z",
          CommitCount: 1,
          ReadyAt: "2026-11-10T01:00:00Z",
          MergedAt: "2026-11-15T00:00:00Z",
          TotalDays: 5,
          TurnDays: 5,
          ReadyDays: 5,
          Author: "known-repeater",
          IsFirstTimer: false,
          FirstTimerReason: "lifetime-merged",
          FirstTimerVersion: 7,
        }),
      ].join("\n"),
      "utf-8",
    );

    const queriedAuthors: string[] = [];
    const batchedQueries: string[] = [];
    const mockClient = {
      graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (query.includes("SearchInterventionLightCandidates")) {
          const searchQ = String(variables?.query ?? "");
          if (searchQ.includes("is:open")) {
            return {
              search: {
                issueCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 960,
                    author: { login: "unassigned-open-ft" },
                    authorAssociation: "NONE",
                  },
                ],
              },
            } as unknown as T;
          }
          // merged 検索は 7 日窓全体を返し、11/14 マージの未キャッシュ PR #950 と既知常連 #952 を含む
          expect(searchQ).toContain("merged:2026-11-10T00:00:00.000Z..2026-11-17T00:00:00.000Z");
          return {
            search: {
              issueCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 950,
                  author: { login: "uncached-merged-ft" },
                  authorAssociation: "CONTRIBUTOR",
                },
                {
                  number: 952,
                  author: { login: "known-repeater" },
                  authorAssociation: "CONTRIBUTOR",
                },
              ],
            },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          batchedQueries.push(query);
          if (query.includes("number: 960")) {
            // 11/15 に人間 AssignedEvent があるが現在は assignees: [] に解除されているオープン PR
            return {
              repository: {
                pr0: {
                  number: 960,
                  title: "Unassigned After Event 960",
                  url: "https://github.com/microsoft/winget-pkgs/pull/960",
                  state: "OPEN",
                  createdAt: "2026-10-08T00:00:00Z",
                  updatedAt: "2026-11-16T00:00:00Z",
                  author: { __typename: "User", login: "unassigned-open-ft" },
                  authorAssociation: "NONE",
                  commits: { totalCount: 1 },
                  assignees: { nodes: [] },
                  reviews: { nodes: [] },
                  comments: { nodes: [] },
                  timelineItems: {
                    nodes: [
                      {
                        __typename: "AssignedEvent",
                        createdAt: "2026-11-15T00:00:00Z",
                        actor: { __typename: "User", login: "stephengillie" },
                        assignee: { __typename: "User", login: "stephengillie" },
                      },
                    ],
                  },
                },
              },
            } as unknown as T;
          }
          return {
            repository: {
              pr0: {
                number: 950,
                title: "Uncached Earlier Merged FT 950",
                url: "https://github.com/microsoft/winget-pkgs/pull/950",
                state: "MERGED",
                createdAt: "2026-10-04T00:00:00Z",
                updatedAt: "2026-11-14T00:00:00Z",
                mergedAt: "2026-11-14T00:00:00Z",
                author: { __typename: "User", login: "uncached-merged-ft" },
                authorAssociation: "CONTRIBUTOR",
                commits: { totalCount: 1 },
                reviews: {
                  nodes: [
                    {
                      author: { __typename: "User", login: "trenly" },
                      state: "APPROVED",
                      submittedAt: "2026-11-14T00:00:00Z",
                    },
                  ],
                },
              },
            },
          } as unknown as T;
        }
        if (query.includes("author:")) {
          queriedAuthors.push(query);
          if (query.includes("unassigned-open-ft"))
            return { u_0: { issueCount: 0 } } as unknown as T;
          if (query.includes("uncached-merged-ft"))
            return { u_0: { issueCount: 1 } } as unknown as T;
        }
        return {} as T;
      },
    } as unknown as GitHubApiClient;

    try {
      const frontier = await fetchFirstReviewMainstreamFrontier({
        client: mockClient,
        repository: "microsoft/winget-pkgs",
        now,
        samplesPath,
      });

      // #950 (10/04 MERGED) と #960 (10/08 OPEN) の 2 件が拾われ、#952 (known-repeater) は詳細バッチ・著者照会ともにスキップ
      expect(frontier.CohortCount).toBe(2);
      expect(frontier.OpenCount).toBe(1);
      expect(frontier.MergedCount).toBe(1);
      expect(frontier.MedianCreatedAt).toBe("2026-10-06T00:00:00.000Z");
      expect(queriedAuthors.some((q) => q.includes("known-repeater"))).toBe(false);
      expect(batchedQueries.some((q) => q.includes("number: 952"))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("主戦場ラインは1000件超検索の動的二分分割とbatchSize分割を経ても重複なく全候補を集計する", async () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const midIso = "2026-11-13T12:00:00.000Z";
    const batchSizesSeen: number[] = [];

    const mockClient = {
      graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        if (query.includes("SearchInterventionLightCandidates")) {
          const searchQ = String(variables?.query ?? "");
          if (searchQ.includes("is:open")) {
            if (searchQ.includes("2026-11-10T00:00:00.000Z..2026-11-17T00:00:00.000Z")) {
              return {
                search: {
                  issueCount: 1200,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [],
                },
              } as unknown as T;
            }
            if (searchQ.includes(`..${midIso}`)) {
              return {
                search: {
                  issueCount: 2,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { number: 971, author: { login: "ft-971" }, authorAssociation: "NONE" },
                    { number: 972, author: { login: "ft-972" }, authorAssociation: "NONE" },
                  ],
                },
              } as unknown as T;
            }
            // 後半スライスに重複 PR #972 と新規 PR #973
            return {
              search: {
                issueCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { number: 972, author: { login: "ft-972" }, authorAssociation: "NONE" },
                  { number: 973, author: { login: "ft-973" }, authorAssociation: "NONE" },
                ],
              },
            } as unknown as T;
          }
          return {
            search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          } as unknown as T;
        }
        if (query.includes("GetPullRequestInterventionBatch")) {
          const nums = [...query.matchAll(/pullRequest\(number:\s*(\d+)\)/g)].map((m) =>
            Number(m[1]),
          );
          batchSizesSeen.push(nums.length);
          const repo: Record<string, unknown> = {};
          nums.forEach((num, idx) => {
            repo[`pr${idx}`] = {
              number: num,
              title: `Open ${num}`,
              url: `https://github.com/microsoft/winget-pkgs/pull/${num}`,
              state: "OPEN",
              createdAt:
                num === 971
                  ? "2026-10-01T00:00:00Z"
                  : num === 972
                    ? "2026-10-05T00:00:00Z"
                    : "2026-10-09T00:00:00Z",
              updatedAt: "2026-11-14T00:00:00Z",
              author: { __typename: "User", login: `ft-${num}` },
              authorAssociation: "NONE",
              commits: { totalCount: 1 },
              reviews: {
                nodes: [
                  {
                    author: { __typename: "User", login: "stephengillie" },
                    state: "COMMENTED",
                    submittedAt: "2026-11-14T00:00:00Z",
                  },
                ],
              },
            };
          });
          return { repository: repo } as unknown as T;
        }
        if (query.includes("author:")) {
          return { u_0: { issueCount: 0 }, u_1: { issueCount: 0 }, u_2: { issueCount: 0 } } as T;
        }
        return {} as T;
      },
    } as unknown as GitHubApiClient;

    const frontier = await fetchFirstReviewMainstreamFrontier({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      now,
      batchSize: 2,
    });

    // 重複排除されて 3 件 (#971, #972, #973) が batchSize=2 (2件 + 1件) で取得される
    expect(batchSizesSeen).toEqual([2, 1]);
    expect(frontier.CohortCount).toBe(3);
    expect(frontier.MedianCreatedAt).toBe("2026-10-05T00:00:00.000Z");
  });

  test("fetchFirstReviewMainstreamFrontier は merged-samples.jsonl の v4 以下を無視し、MEMBER/Bot キャッシュを除外して処理する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-mainstream-cache-guard-"));
    const samplesPath = join(tempDir, "merged-samples.jsonl");
    const now = new Date("2026-11-17T00:00:00Z");

    writeFileSync(
      samplesPath,
      [
        // #981: v4 ゾンビ (IsFirstTimer: true) -> バージョン不足でキャッシュショートカットから無視される
        JSON.stringify({
          Type: "sample",
          Number: 981,
          Title: "v4 Zombie 981",
          CreatedAt: "2026-10-01T00:00:00Z",
          LatestCommittedDate: "2026-10-01T00:00:00Z",
          CommitCount: 1,
          ReadyAt: "2026-10-01T01:00:00Z",
          MergedAt: "2026-11-14T00:00:00Z",
          TotalDays: 44,
          TurnDays: 44,
          ReadyDays: 44,
          Author: "zombie-user",
          IsFirstTimer: true,
          FirstTimerVersion: 4,
        }),
        // #982: v7 MEMBER (IsFirstTimer: true) -> 特権ロールのため除外（knownNonFirstTimer 扱い）
        JSON.stringify({
          Type: "sample",
          Number: 982,
          Title: "Member 982",
          CreatedAt: "2026-11-10T00:00:00Z",
          LatestCommittedDate: "2026-11-10T00:00:00Z",
          CommitCount: 1,
          ReadyAt: "2026-11-10T01:00:00Z",
          MergedAt: "2026-11-15T00:00:00Z",
          TotalDays: 5,
          TurnDays: 5,
          ReadyDays: 5,
          Author: "asklar",
          AuthorAssociation: "MEMBER",
          IsFirstTimer: true,
          FirstTimerVersion: 7,
        }),
        // #983: v7 有効な初回提出者 -> 採用
        JSON.stringify({
          Type: "sample",
          Number: 983,
          Title: "Valid 983",
          CreatedAt: "2026-10-10T00:00:00Z",
          LatestCommittedDate: "2026-10-10T00:00:00Z",
          CommitCount: 1,
          ReadyAt: "2026-10-10T01:00:00Z",
          MergedAt: "2026-11-15T00:00:00Z",
          TotalDays: 36,
          TurnDays: 36,
          ReadyDays: 36,
          Author: "valid-ft",
          AuthorType: "User",
          AuthorAssociation: "CONTRIBUTOR",
          IsFirstTimer: true,
          FirstTimerVersion: 7,
        }),
      ].join("\n"),
      "utf-8",
    );

    try {
      const requestedBatches: number[][] = [];
      const mockClient = {
        graphql: async <T>(query: string): Promise<T> => {
          if (query.includes("SearchInterventionLightCandidates")) {
            return {
              search: {
                issueCount: 0,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            } as unknown as T;
          }
          if (query.includes("GetPullRequestInterventionBatch")) {
            const nums = [...query.matchAll(/pullRequest\(number:\s*(\d+)\)/g)].map((m) =>
              Number(m[1]),
            );
            requestedBatches.push(nums);
            return {
              repository: {
                pr0: {
                  number: 983,
                  title: "Valid 983",
                  url: "https://github.com/microsoft/winget-pkgs/pull/983",
                  state: "MERGED",
                  createdAt: "2026-10-10T00:00:00Z",
                  updatedAt: "2026-11-15T00:00:00Z",
                  author: { __typename: "User", login: "valid-ft" },
                  authorAssociation: "CONTRIBUTOR",
                  commits: { totalCount: 1 },
                  reviews: {
                    nodes: [
                      {
                        author: { __typename: "User", login: "stephengillie" },
                        state: "APPROVED",
                        submittedAt: "2026-11-15T00:00:00Z",
                      },
                    ],
                  },
                },
              },
            } as unknown as T;
          }
          return {} as T;
        },
      } as unknown as GitHubApiClient;

      const frontier = await fetchFirstReviewMainstreamFrontier({
        client: mockClient,
        repository: "microsoft/winget-pkgs",
        now,
        samplesPath,
      });

      expect(requestedBatches).toEqual([[983]]);
      expect(frontier.CohortCount).toBe(1);
      expect(frontier.MedianCreatedAt).toBe("2026-10-10T00:00:00.000Z");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("fetchFirstReviewMainstreamFrontier は 1 ページ目が特権ロールの自動指摘のみでも後続ページから初回人間介入日時を補完してコホートに含める", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-mainstream-paging-"));
    const samplesPath = join(tempDir, "merged-samples.jsonl");
    const now = new Date("2026-11-17T00:00:00Z");
    writeFileSync(samplesPath, "", "utf-8");

    try {
      let extraPageFetchCount = 0;
      const mockClient = {
        graphql: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
          if (query.includes("SearchInterventionLightCandidates")) {
            const searchQ = String(variables?.query ?? "");
            if (searchQ.includes("is:open")) {
              return {
                search: {
                  issueCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      number: 990,
                      author: { login: "open-first-timer-990" },
                      authorAssociation: "NONE",
                    },
                  ],
                },
              } as unknown as T;
            }
            return {
              search: {
                issueCount: 0,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            } as unknown as T;
          }
          if (query.includes("GetPullRequestInterventionBatch")) {
            return {
              repository: {
                pr0: {
                  number: 990,
                  title: "Open First Timer 990",
                  url: "https://github.com/microsoft/winget-pkgs/pull/990",
                  state: "OPEN",
                  createdAt: "2026-10-12T00:00:00Z",
                  updatedAt: "2026-11-16T12:00:00Z",
                  author: { __typename: "User", login: "open-first-timer-990" },
                  authorAssociation: "NONE",
                  commits: { totalCount: 1 },
                  reviews: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [],
                  },
                  comments: {
                    pageInfo: { hasNextPage: true, endCursor: "c1" },
                    nodes: [
                      {
                        author: { __typename: "User", login: "stephengillie" },
                        authorAssociation: "COLLABORATOR",
                        body: "This PR cannot be merged.\n\n(Deterministic automation)",
                        createdAt: "2026-10-12T01:00:00Z",
                        lastEditedAt: null,
                      },
                    ],
                  },
                },
              },
            } as unknown as T;
          }
          if (variables?.after === "c1") {
            extraPageFetchCount += 1;
            return {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        author: { __typename: "User", login: "winget-reviewer" },
                        authorAssociation: "MEMBER",
                        body: "Thanks, reviewing package manifest now.",
                        createdAt: "2026-11-16T12:00:00Z",
                        lastEditedAt: null,
                      },
                    ],
                  },
                },
              },
            } as unknown as T;
          }
          return {} as T;
        },
      } as unknown as GitHubApiClient;

      const frontier = await fetchFirstReviewMainstreamFrontier({
        client: mockClient,
        repository: "microsoft/winget-pkgs",
        now,
        samplesPath,
      });

      expect(extraPageFetchCount).toBe(1);
      expect(frontier.CohortCount).toBe(1);
      expect(frontier.OpenCount).toBe(1);
      expect(frontier.MedianCreatedAt).toBe("2026-10-12T00:00:00.000Z");
      expect(frontier.Items?.[0]?.FirstHumanInterventionAt).toBe("2026-11-16T12:00:00.000Z");
      expect(frontier.Items?.[0]?.InterventionActor).toBe("winget-reviewer");
      expect(frontier.Items?.[0]?.AuthorAssociation).toBe("NONE");
      expect(frontier.Items?.[0]?.AuthorMergedCount).toBe(0);
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

  test("分離された各コレクタモジュールのエクスポートと explore-depths.ts の互換 re-export が完全一致する", () => {
    expect(BOTTOM_LIST_LIMIT).toBe(DIRECT_BOTTOM_LIST_LIMIT);
    expect(FIRST_TIMER_PAGE_SIZE).toBe(DIRECT_FIRST_TIMER_PAGE_SIZE);
    expect(FIRST_TIMER_MAX_NODES).toBe(DIRECT_FIRST_TIMER_MAX_NODES);
    expect(fetchHealthyBottoms).toBe(directFetchHealthyBottoms);
    expect(fetchFirstTimerBottom).toBe(directFetchFirstTimerBottom);

    expect(INTERVENTION_BATCH_SIZE).toBe(DIRECT_INTERVENTION_BATCH_SIZE);
    expect(fetchInterventionFrontiers).toBe(directFetchInterventionFrontiers);

    expect(MAINSTREAM_SEARCH_PAGE_SIZE).toBe(DIRECT_MAINSTREAM_SEARCH_PAGE_SIZE);
    expect(fetchFirstReviewFrontiers).toBe(directFetchFirstReviewFrontiers);
    expect(fetchFirstReviewMainstreamFrontier).toBe(directFetchFirstReviewMainstreamFrontier);
  });
});
