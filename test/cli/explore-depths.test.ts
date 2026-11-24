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
import { CURRENT_FIRST_TIMER_VERSION } from "../../src/domain/first-timer";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "../../src/domain/intervention";
import type { GitHubPrView, GitHubSearchItem } from "../../src/models/depths";

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

describe("CLI: explore-depths の主戦場ライン（fetchFirstReviewMainstreamFrontier）", () => {
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

  const _buildBatchRepoFromSpecs = (
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
        FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
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
          FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
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
            // 11/15 にメンテナによる手動コメントがあるオープン PR（自動コメント・@wingetbot run は無視される）
            return {
              repository: {
                pr0: {
                  number: 960,
                  title: "Manually Commented Open FT 960",
                  url: "https://github.com/microsoft/winget-pkgs/pull/960",
                  state: "OPEN",
                  createdAt: "2026-10-08T00:00:00Z",
                  updatedAt: "2026-11-16T00:00:00Z",
                  author: { __typename: "User", login: "unassigned-open-ft" },
                  authorAssociation: "NONE",
                  commits: { totalCount: 1 },
                  assignees: { nodes: [] },
                  reviews: { nodes: [] },
                  comments: {
                    nodes: [
                      {
                        author: { __typename: "User", login: "stephengillie" },
                        body: "URL: https://example.com/app.zip\nStatus Code: 200\n\n(Automated message - build 1838)",
                        createdAt: "2026-11-01T00:00:00Z",
                      },
                      {
                        author: { __typename: "User", login: "stephengillie" },
                        body: "@wingetbot run",
                        createdAt: "2026-11-05T00:00:00Z",
                      },
                      {
                        author: { __typename: "User", login: "stephengillie" },
                        body: "Please verify the installer license.",
                        createdAt: "2026-11-15T00:00:00Z",
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
          FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
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
          FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
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

describe("CLI: explore-depths コレクタ分割互換 re-export", () => {
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
