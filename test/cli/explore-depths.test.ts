import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient } from "../../src/api/github";
import {
  fetchFirstTimerBottom,
  fetchStaleBottom,
  parseArgs,
  resolveDefaultDataDir,
  runExploreDepths,
} from "../../src/cli/explore-depths";
import { buildHealthyBaseQuery } from "../../src/domain/depths";
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
      expect(snapshot.StaleBottom.length).toBe(1);
      expect(snapshot.StaleBottom[0].CommitCount).toBe(1);
      expect(snapshot.FirstTimerBottom?.length).toBe(1);
      expect(snapshot.FirstTimerBottom?.[0].Author).toBe("first-timer-user");
      expect(snapshot.FirstTimerBottom?.[0].CommitCount).toBe(1);
      expect(snapshot.ExpressLane.length).toBe(1);

      // Search API は Healthy, Absolute, Express の 3 クエリが発行されたこと（Stale / FirstTimer は GraphQL）
      expect(searchQueries.length).toBe(3);

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
      // Search API は Healthy, Absolute の 2 クエリのみ（Express は実行されず、Stale / FirstTimer は GraphQL）
      expect(searchQueries.length).toBe(2);
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

describe("CLI: explore-depths の優等生の底（Stale Bottom）", () => {
  test("優等生の底は sort:updated-asc ＋ progress と同じ健康条件で GraphQL 検索し、1コミット限定のみ上位 10 件取得する", async () => {
    const gqlCalls: { query: string; variables: Record<string, unknown> }[] = [];
    const mockClient = {
      searchIssues: async (): Promise<GitHubSearchItem[]> => [],
      graphql: async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
        gqlCalls.push({ query, variables });
        const searchQuery = String(variables.query ?? "");
        if (searchQuery.includes("sort:updated-asc")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 1001,
                  title: "Two-commit PR (excluded)",
                  url: "https://github.com/microsoft/winget-pkgs/pull/1001",
                  createdAt: "2026-10-01T00:00:00Z",
                  updatedAt: "2026-10-01T01:00:00Z",
                  author: { login: "user-a" },
                  authorAssociation: "NONE",
                  commits: { totalCount: 2 },
                  labels: { nodes: [{ name: "New-Package" }] },
                },
                {
                  number: 1002,
                  title: "One-commit Contributor PR (included)",
                  url: "https://github.com/microsoft/winget-pkgs/pull/1002",
                  createdAt: "2026-10-02T00:00:00Z",
                  updatedAt: "2026-10-02T01:00:00Z",
                  author: { login: "contributor-b" },
                  authorAssociation: "CONTRIBUTOR",
                  commits: { totalCount: 1 },
                  labels: { nodes: [{ name: "New-Package" }] },
                },
              ],
            },
          } as unknown as T;
        }
        return {
          search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const snapshot = await runExploreDepths(
      {
        targetPr: 1,
        repository: "microsoft/winget-pkgs",
        noTargetPr: true,
        noHistory: true,
        outputPath: join(tmpdir(), `winget-depths-stale-${Date.now()}.json`),
        asJson: true,
      },
      mockClient,
      () => {},
    );

    const staleCall = gqlCalls.find((c) =>
      String(c.variables.query ?? "").includes("sort:updated-asc"),
    );
    expect(staleCall).toBeDefined();
    expect(staleCall?.variables.query).toBe(
      `${buildHealthyBaseQuery("microsoft/winget-pkgs")} sort:updated-asc`,
    );
    // 健康条件は progress 側と同じ定義（阻害・調査中ラベルをすべて除外）を使う
    expect(staleCall?.variables.query).toContain('-label:"Validation-SmartScreen"');
    expect(staleCall?.variables.query).toContain('-label:"Testing"');
    expect(snapshot.StaleBottom.map((r) => r.Number)).toEqual([1002]);
    expect(snapshot.StaleBottom[0].CommitCount).toBe(1);
  });

  test("fetchStaleBottom は 2コミット以上が並ぶページをまたいで 1コミットPR を limit 件補完する", async () => {
    const page1Nodes: GraphQLPrNode[] = Array.from({ length: 10 }, (_, i) => ({
      number: 2000 + i,
      title: `Multi commit ${i}`,
      url: `https://github.com/microsoft/winget-pkgs/pull/${2000 + i}`,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: `2026-10-01T0${i}:00:00Z`,
      author: { login: `multi-${i}` },
      authorAssociation: "CONTRIBUTOR",
      commits: { totalCount: 3 },
      labels: { nodes: [{ name: "New-Package" }] },
    }));
    const page2Nodes: GraphQLPrNode[] = Array.from({ length: 3 }, (_, i) => ({
      number: 2100 + i,
      title: `Single commit ${i}`,
      url: `https://github.com/microsoft/winget-pkgs/pull/${2100 + i}`,
      createdAt: "2026-10-02T00:00:00Z",
      updatedAt: `2026-10-02T0${i}:00:00Z`,
      author: { login: `single-${i}` },
      authorAssociation: "NONE",
      commits: { totalCount: 1 },
      labels: { nodes: [{ name: "New-Package" }] },
    }));

    const mockClient = {
      graphql: async <T>(_query: string, variables: Record<string, unknown>): Promise<T> => {
        if (!variables.after) {
          return {
            search: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: page1Nodes },
          } as unknown as T;
        }
        return {
          search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: page2Nodes },
        } as unknown as T;
      },
    } as unknown as GitHubApiClient;

    const results = await fetchStaleBottom(mockClient, "repo:microsoft/winget-pkgs", 10);
    expect(results.map((r) => r.Number)).toEqual([2100, 2101, 2102]);
    expect(results.every((r) => r.CommitCount === 1)).toBe(true);
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
    labels: { nodes: [{ name: "New-Package" }] },
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
        ...createMockNode(400602, "true-first-timer-b", "NONE", 4),
        createdAt: "2026-10-03T00:00:00Z",
      },
    ];
    const page2Nodes: GraphQLPrNode[] = [
      {
        ...createMockNode(400603, "true-first-timer-a", "NONE", 1),
        createdAt: "2026-10-02T00:00:00Z",
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
    expect(results.map((r) => r.Number)).toEqual([400603, 400602]);
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
      ).rejects.toThrow("優等生の底の GraphQL 取得に失敗しました");

      // 失敗時はファイルへの書き込みが行われないこと
      expect(existsSync(outputPath)).toBeFalse();
      expect(existsSync(historyPath)).toBeFalse();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
