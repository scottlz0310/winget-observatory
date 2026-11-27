import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runCollectReviewFeedback } from "../../src/cli/collect-review-feedback";
import { parseReviewFeedbackCorpus } from "../../src/domain/review-feedback";
import type { GitHubDetailedSearchResult } from "../../src/models/progress";

const VALID_OID = "74eefe96691ffdc4542ca541be5c25c1fce43e6a";

describe("collect-review-feedback parseArgs", () => {
  test("既定オプションと主要オプションを正しく解釈する", () => {
    const defaults = parseArgs([]);
    expect(defaults.repository).toBe("microsoft/winget-pkgs");
    expect(defaults.lookbackDays).toBe(90);
    expect(defaults.states).toEqual(["merged"]);
    expect(defaults.fetchBudget).toBe(200);
    expect(defaults.portableOnly).toBe(false);
    expect(defaults.privilegedOnly).toBe(false);

    const parsed = parseArgs([
      "--repo",
      "owner/repo",
      "--lookback-days",
      "30",
      "--states",
      "merged,open,closed",
      "--fetch-budget",
      "0",
      "--fetch-limit",
      "500",
      "--installer-type",
      "zip,portable",
      "--nested-installer-type",
      "portable",
      "--portable-only",
      "--privileged-only",
      "--first-timer-only",
      "--output-path",
      "out/corpus.jsonl",
      "--report-path",
      "out/report.md",
      "--no-report",
      "--no-write",
      "--as-json",
    ]);

    expect(parsed).toMatchObject({
      repository: "owner/repo",
      lookbackDays: 30,
      states: ["merged", "open", "closed"],
      fetchBudget: 0,
      fetchLimit: 500,
      installerTypes: ["zip", "portable"],
      nestedInstallerTypes: ["portable"],
      portableOnly: true,
      privilegedOnly: true,
      firstTimerOnly: true,
      outputPath: "out/corpus.jsonl",
      reportPath: "out/report.md",
      noReport: true,
      noWrite: true,
      asJson: true,
    });
  });

  test.each([
    [["--states", "invalid"], "--states に無効な値"],
    [["--lookback-days", "0"], "--lookback-days に無効な値"],
    [["--fetch-budget", "-1"], "--fetch-budget オプションには値が必要です"],
    [["--fetch-budget", "9999"], "--fetch-budget に無効な値"],
    [["--unknown-flag"], "未知のオプション"],
  ])("不正引数 %j を拒否する", (argv, expectedMsg) => {
    expect(() => parseArgs(argv)).toThrow(expectedMsg);
  });
});

describe("runCollectReviewFeedback integration", () => {
  test("新規収集 → コーパス/レポート保存 → キャッシュ再利用 (--fetch-budget 0 含む) が一貫動作する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-feedback-cli-"));
    const outputPath = join(tmpDir, "review-feedback.jsonl");
    const reportPath = join(tmpDir, "review-feedback-report.md");

    let searchCalls = 0;
    let detailBatchCalls = 0;
    let blobBatchCalls = 0;

    const mockClient = {
      searchIssuesDetailed: async (): Promise<GitHubDetailedSearchResult> => {
        searchCalls++;
        return {
          totalCount: 2,
          items: [
            {
              number: 445661,
              title: "New package: okzea.WindowRescue version 0.1.3",
              html_url: "https://github.com/microsoft/winget-pkgs/pull/445661",
              created_at: "2026-10-02T12:31:18Z",
              updated_at: "2026-11-26T21:50:19Z",
              author: "okzea",
              pull_request: { merged_at: "2026-11-26T21:50:19Z" },
            },
            {
              number: 445660,
              title: "New package: Clean.App version 1.0.0",
              html_url: "https://github.com/microsoft/winget-pkgs/pull/445660",
              created_at: "2026-10-02T10:00:00Z",
              updated_at: "2026-11-20T00:00:00Z",
              author: "clean-user",
              pull_request: { merged_at: "2026-11-20T00:00:00Z" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
      graphql: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes("GetPullRequestFeedbackBatch")) {
          detailBatchCalls++;
          return {
            repository: {
              pr0: {
                number: 445661,
                title: "New package: okzea.WindowRescue version 0.1.3",
                url: "https://github.com/microsoft/winget-pkgs/pull/445661",
                state: "MERGED",
                createdAt: "2026-10-02T12:31:18Z",
                updatedAt: "2026-11-26T21:50:19Z",
                mergedAt: "2026-11-26T21:50:19Z",
                closedAt: "2026-11-26T21:50:19Z",
                mergeCommit: { oid: VALID_OID },
                author: { __typename: "User", login: "okzea" },
                authorAssociation: "CONTRIBUTOR",
                commits: { totalCount: 3 },
                labels: { nodes: [{ name: "New-Package" }] },
                files: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      path: "manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.installer.yaml",
                    },
                  ],
                },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      author: { __typename: "User", login: "taras-janea" },
                      authorAssociation: "NONE",
                      body: "Required: fails to start on clean Windows",
                      createdAt: "2026-11-24T23:09:25Z",
                    },
                    {
                      author: { __typename: "User", login: "okzea" },
                      authorAssociation: "CONTRIBUTOR",
                      body: "Fixed VCRUNTIME140.dll by static linking",
                      createdAt: "2026-11-25T01:58:59Z",
                    },
                  ],
                },
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: "LabeledEvent",
                      createdAt: "2026-11-24T23:09:58Z",
                      label: { name: "Needs-Author-Feedback" },
                    },
                  ],
                },
              },
              pr1: {
                number: 445660,
                title: "New package: Clean.App version 1.0.0",
                url: "https://github.com/microsoft/winget-pkgs/pull/445660",
                state: "MERGED",
                createdAt: "2026-10-02T10:00:00Z",
                updatedAt: "2026-11-20T00:00:00Z",
                mergedAt: "2026-11-20T00:00:00Z",
                closedAt: "2026-11-20T00:00:00Z",
                mergeCommit: { oid: VALID_OID },
                author: { __typename: "User", login: "clean-user" },
                authorAssociation: "CONTRIBUTOR",
                commits: { totalCount: 1 },
                labels: { nodes: [{ name: "New-Package" }] },
                files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          } as T;
        }
        if (query.includes("GetInstallerManifestBlobs")) {
          blobBatchCalls++;
          return {
            repository: {
              b0: { text: "InstallerType: portable\nManifestVersion: 1.28.0\n" },
            },
          } as T;
        }
        if (query.includes("u_0: search")) {
          return { u_0: { issueCount: 1 } } as T;
        }
        throw new Error(`Unexpected GraphQL query: ${query}`);
      },
      getRateLimit: async () => ({
        graphql: { limit: 5000, remaining: 4990, resetAt: "2026-11-27T07:00:00.000Z" },
      }),
    };

    try {
      const logs: string[] = [];
      const firstRun = await runCollectReviewFeedback(
        {
          ...parseArgs(["--output-path", outputPath, "--report-path", reportPath]),
          now: new Date("2026-11-27T06:00:00.000Z"),
        },
        mockClient,
        (msg) => logs.push(msg),
      );

      expect(firstRun.stats.newFeedbackCount).toBe(1);
      expect(firstRun.stats.newNoFeedbackCount).toBe(1);
      expect(firstRun.records).toHaveLength(1);
      expect(firstRun.records[0].categories).toEqual(["dll-runtime", "launch-command"]);
      expect(firstRun.records[0].installer.isPortable).toBe(true);
      expect(firstRun.records[0].isFirstTimeAuthor).toBe(true);
      expect(detailBatchCalls).toBe(1);
      expect(blobBatchCalls).toBe(1);
      expect(existsSync(outputPath)).toBe(true);
      expect(existsSync(reportPath)).toBe(true);
      expect(logs.some((l) => l.includes("[RateLimit]"))).toBe(true);

      const savedCorpus = parseReviewFeedbackCorpus(readFileSync(outputPath, "utf-8"));
      expect(savedCorpus).toHaveLength(2);

      // 2 回目の実行: 2 件とも確定済み MERGED キャッシュから再利用され、詳細バッチは呼ばれない
      const secondRun = await runCollectReviewFeedback(
        {
          ...parseArgs(["--output-path", outputPath, "--report-path", reportPath]),
          now: new Date("2026-11-27T06:05:00.000Z"),
        },
        mockClient,
        () => {},
      );
      expect(secondRun.stats.reusedFromCacheCount).toBe(2);
      expect(secondRun.stats.fetchedCount).toBe(0);
      expect(detailBatchCalls).toBe(1);

      // 3 回目の実行: --fetch-budget 0 で API 呼び出し 0 回・フィルタ再集計のみ
      const searchCallsBeforeOffline = searchCalls;
      const offlineRun = await runCollectReviewFeedback(
        {
          ...parseArgs([
            "--fetch-budget",
            "0",
            "--portable-only",
            "--output-path",
            outputPath,
            "--no-write",
            "--as-json",
          ]),
          now: new Date("2026-11-27T06:10:00.000Z"),
        },
        mockClient,
        () => {},
      );
      expect(searchCalls).toBe(searchCallsBeforeOffline);
      expect(offlineRun.records).toHaveLength(1);

      // 破損キャッシュがある場合はサイレント無視せずエラー伝播
      writeFileSync(outputPath, "{corrupted\n", "utf-8");
      await expect(
        runCollectReviewFeedback(
          {
            ...parseArgs(["--fetch-budget", "0", "--output-path", outputPath]),
            now: new Date("2026-11-27T06:15:00.000Z"),
          },
          mockClient,
          () => {},
        ),
      ).rejects.toThrow("フィードバックコーパスの読み込みに失敗");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("動的二分窓走査・ページネーション・open/closed 状態・特権作者・予算上限が正しく動作する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-feedback-bisect-"));
    const outputPath = join(tmpDir, "review-feedback.jsonl");
    const observedQueries: string[] = [];

    const mockClient = {
      searchIssuesDetailed: async (
        query: string,
        _sort?: string,
        _order?: string,
        _perPage?: number,
        page = 1,
        cursor?: string | null,
      ): Promise<GitHubDetailedSearchResult> => {
        observedQueries.push(`${query} [p=${page},c=${cursor ?? ""}]`);

        // 広い期間（30日）は 1,001 件を返して動的二分を誘発
        if (query.includes("is:open") && query.includes('label:"Needs-Author-Feedback"')) {
          const rangeMatch = /updated:(\S+)\.\.(\S+)/.exec(query);
          const spanMs = rangeMatch ? Date.parse(rangeMatch[2]) - Date.parse(rangeMatch[1]) : 0;
          if (spanMs > 20 * 24 * 60 * 60 * 1000) {
            return {
              totalCount: 1001,
              items: [],
              pageInfo: { hasNextPage: true, endCursor: "c0" },
            };
          }
          if (page === 1) {
            return {
              totalCount: 2,
              items: [
                {
                  number: 450002,
                  title: "New package: Open.Pkg version 1.0",
                  html_url: "https://github.com/microsoft/winget-pkgs/pull/450002",
                  created_at: "2026-11-01T00:00:00Z",
                  updated_at: "2026-11-26T00:00:00Z",
                  author: "priv-author",
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "open-p2" },
            };
          }
          return {
            totalCount: 2,
            items: [
              {
                number: 450001,
                title: "New version: Ignored.Version 2.0",
                html_url: "https://github.com/microsoft/winget-pkgs/pull/450001",
                created_at: "2026-11-01T00:00:00Z",
                updated_at: "2026-11-25T00:00:00Z",
                author: "other",
              },
              {
                number: 450000,
                title: "New package: OverBudget.Pkg version 1.0",
                html_url: "https://github.com/microsoft/winget-pkgs/pull/450000",
                created_at: "2026-11-01T00:00:00Z",
                updated_at: "2026-11-24T00:00:00Z",
                author: "other2",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        }

        return {
          totalCount: 0,
          items: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
      },
      graphql: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes("GetPullRequestFeedbackBatch")) {
          return {
            repository: {
              pr0: {
                number: 450002,
                title: "New package: Open.Pkg version 1.0",
                url: "https://github.com/microsoft/winget-pkgs/pull/450002",
                state: "OPEN",
                createdAt: "2026-11-01T00:00:00Z",
                updatedAt: "2026-11-26T00:00:00Z",
                mergedAt: null,
                closedAt: null,
                headRefOid: VALID_OID,
                author: { __typename: "User", login: "priv-author" },
                authorAssociation: "COLLABORATOR",
                commits: { totalCount: 1 },
                labels: { nodes: [{ name: "New-Package" }, { name: "Needs-Author-Feedback" }] },
                files: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ path: "manifests/o/Open/Pkg/1.0/Open.Pkg.installer.yaml" }],
                },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      author: { __typename: "User", login: "reviewer" },
                      authorAssociation: "MEMBER",
                      body: "PrivacyUrl returns 404",
                      createdAt: "2026-11-26T00:00:00Z",
                    },
                  ],
                },
                timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          } as T;
        }
        if (query.includes("GetInstallerManifestBlobs")) {
          return {
            repository: {
              b0: { text: "InstallerType: zip\nNestedInstallerType: portable\n" },
            },
          } as T;
        }
        throw new Error(`Unexpected query: ${query}`);
      },
      getRateLimit: async () => ({
        graphql: { limit: 5000, remaining: 4980, resetAt: null },
      }),
    };

    try {
      const result = await runCollectReviewFeedback(
        {
          ...parseArgs([
            "--states",
            "open,closed",
            "--lookback-days",
            "30",
            "--fetch-budget",
            "1",
            "--output-path",
            outputPath,
            "--no-report",
          ]),
          now: new Date("2026-11-27T06:00:00.000Z"),
        },
        mockClient,
        () => {},
      );

      // 動的二分が発生し、非 New package: は除外され、予算 1 件で 1 件取得・1 件超過スキップ
      expect(observedQueries.length).toBeGreaterThanOrEqual(4);
      expect(result.stats.fetchedCount).toBe(1);
      expect(result.stats.skippedByBudgetCount).toBe(1);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].number).toBe(450002);
      expect(result.records[0].isFirstTimeAuthor).toBe(false);
      expect(result.records[0].categories).toEqual(["metadata-url"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
