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
    expect(defaults.blockingOnly).toBe(false);
    expect(defaults.reclassify).toBe(false);

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
      "--blocking-only",
      "--reclassify",
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
      blockingOnly: true,
      reclassify: true,
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

        // 広い期間（30日）は 1,001 件を返して動的二分を誘発（トリガー修飾子なしの状態・期間検索を検証）
        if (query.includes("is:open")) {
          expect(query).not.toContain('label:"Needs-Author-Feedback"');
          expect(query).not.toContain("review:changes_requested");
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
      expect(result.records[0].categories).toEqual(["privacy-policy", "metadata-url"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("ラベル解除済み CLOSED PR の拾い上げ・CLOSED→OPEN 再オープン時のキャッシュ再取得・他リポジトリ保全・未完了ページング非保存を検証する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-feedback-regression-"));
    const outputPath = join(tmpDir, "review-feedback.jsonl");

    // 事前キャッシュ:
    // 1) 別リポジトリ (other/repo) の同番号 PR #436234（上書きされてはならない）
    // 2) microsoft/winget-pkgs の #450010 が CLOSED としてキャッシュ済み（今回 OPEN へ再オープン）
    writeFileSync(
      outputPath,
      `${[
        JSON.stringify({
          schemaVersion: 1,
          entryType: "no-feedback",
          repository: "other/repo",
          number: 436234,
          title: "New package: Other.Pkg 1.0",
          state: "CLOSED",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-10T00:00:00Z",
          mergedAt: null,
          closedAt: "2026-10-10T00:00:00Z",
          skipReason: "no-rejection-trigger",
          collectedAt: "2026-11-20T00:00:00.000Z",
        }),
        JSON.stringify({
          schemaVersion: 1,
          entryType: "no-feedback",
          repository: "microsoft/winget-pkgs",
          number: 450010,
          title: "New package: Reopened.Pkg 1.0",
          state: "CLOSED",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-11-10T00:00:00Z",
          mergedAt: null,
          closedAt: "2026-11-10T00:00:00Z",
          skipReason: "no-rejection-trigger",
          collectedAt: "2026-11-15T00:00:00.000Z",
        }),
      ].join("\n")}\n`,
      "utf-8",
    );

    const mockClient = {
      searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
        if (query.includes("is:open")) {
          return {
            totalCount: 2,
            items: [
              {
                number: 450010,
                title: "New package: Reopened.Pkg 1.0",
                html_url: "https://github.com/microsoft/winget-pkgs/pull/450010",
                created_at: "2026-10-01T00:00:00Z",
                updated_at: "2026-11-26T00:00:00Z",
                author: "reopen-user",
              },
              {
                number: 450011,
                title: "New package: Truncated.Pkg 1.0",
                html_url: "https://github.com/microsoft/winget-pkgs/pull/450011",
                created_at: "2026-10-01T00:00:00Z",
                updated_at: "2026-11-26T00:00:00Z",
                author: "trunc-user",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        }
        if (query.includes("is:closed")) {
          return {
            totalCount: 1,
            items: [
              {
                number: 436234,
                title: "New package: RemovedLabel.Pkg 1.0",
                html_url: "https://github.com/microsoft/winget-pkgs/pull/436234",
                created_at: "2026-09-20T00:00:00Z",
                updated_at: "2026-11-25T00:00:00Z",
                author: "removed-label-user",
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        }
        return { totalCount: 0, items: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      graphql: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes("GetPullRequestFeedbackBatch")) {
          return {
            repository: {
              pr0: {
                number: 450011,
                title: "New package: Truncated.Pkg 1.0",
                url: "https://github.com/microsoft/winget-pkgs/pull/450011",
                state: "OPEN",
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-11-26T00:00:00Z",
                mergedAt: null,
                closedAt: null,
                headRefOid: VALID_OID,
                author: { __typename: "User", login: "trunc-user" },
                authorAssociation: "NONE",
                commits: { totalCount: 1 },
                labels: { nodes: [{ name: "New-Package" }] },
                files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                comments: {
                  // 20 ページ超過を再現するため常に次のカーソルを返す
                  pageInfo: { hasNextPage: true, endCursor: "page-0" },
                  nodes: [],
                },
                timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
              pr1: {
                number: 450010,
                title: "New package: Reopened.Pkg 1.0",
                url: "https://github.com/microsoft/winget-pkgs/pull/450010",
                state: "OPEN",
                createdAt: "2026-10-01T00:00:00Z",
                updatedAt: "2026-11-26T00:00:00Z",
                mergedAt: null,
                closedAt: null,
                headRefOid: VALID_OID,
                author: { __typename: "User", login: "reopen-user" },
                authorAssociation: "NONE",
                commits: { totalCount: 2 },
                labels: { nodes: [{ name: "New-Package" }, { name: "Needs-Author-Feedback" }] },
                files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      author: { __typename: "User", login: "mod" },
                      authorAssociation: "COLLABORATOR",
                      body: "VCRUNTIME140.dll missing",
                      createdAt: "2026-11-26T00:00:00Z",
                    },
                  ],
                },
                timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
              pr2: {
                number: 436234,
                title: "New package: RemovedLabel.Pkg 1.0",
                url: "https://github.com/microsoft/winget-pkgs/pull/436234",
                state: "CLOSED",
                createdAt: "2026-09-20T00:00:00Z",
                updatedAt: "2026-11-25T00:00:00Z",
                mergedAt: null,
                closedAt: "2026-11-25T00:00:00Z",
                headRefOid: VALID_OID,
                author: { __typename: "User", login: "removed-label-user" },
                authorAssociation: "NONE",
                commits: { totalCount: 1 },
                // 現在ラベルからは外れているが、timelineItems に Needs-Author-Feedback 履歴あり
                labels: { nodes: [{ name: "New-Package" }] },
                files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      author: { __typename: "User", login: "reviewer" },
                      authorAssociation: "NONE",
                      body: "SmartScreen flagged installer",
                      createdAt: "2026-11-24T00:00:00Z",
                    },
                  ],
                },
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: "LabeledEvent",
                      createdAt: "2026-11-24T00:01:00Z",
                      label: { name: "Needs-Author-Feedback" },
                    },
                  ],
                },
              },
            },
          } as T;
        }
        if (query.includes("GetFeedbackCommentsPage")) {
          const nextNum = Math.random().toString(36).slice(2);
          return {
            repository: {
              pullRequest: {
                comments: {
                  pageInfo: { hasNextPage: true, endCursor: `page-${nextNum}` },
                  nodes: [],
                },
              },
            },
          } as T;
        }
        if (query.includes("u_0: search")) {
          return { u_0: { issueCount: 0 }, u_1: { issueCount: 0 } } as T;
        }
        throw new Error(`Unexpected query: ${query}`);
      },
      getRateLimit: async () => ({
        graphql: { limit: 5000, remaining: 4950, resetAt: null },
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
            "--output-path",
            outputPath,
            "--no-report",
          ]),
          now: new Date("2026-11-27T06:00:00.000Z"),
        },
        mockClient,
        () => {},
      );

      // 1) 再オープンされた #450010 とラベル解除済み履歴の #436234 が両方抽出される
      expect(result.records.map((r) => r.number)).toEqual([450010, 436234]);
      expect(result.records[0].state).toBe("OPEN");
      expect(result.records[1].state).toBe("CLOSED");

      // 2) ページング上限到達の #450011 は incompleteCount=1 で確定キャッシュに入らない
      expect(result.stats.incompleteCount).toBe(1);
      const saved = parseReviewFeedbackCorpus(readFileSync(outputPath, "utf-8"));
      expect(saved.some((e) => e.number === 450011)).toBe(false);

      // 3) 他リポジトリ (other/repo) の同番号 #436234 が上書きされず保全されている
      expect(saved.filter((e) => e.number === 436234).map((e) => e.repository)).toEqual([
        "microsoft/winget-pkgs",
        "other/repo",
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("複数状態指定時に先行状態が fetchLimit / fetchBudget を占有せず全状態へ配分され、再実行で未処理の古い OPEN と後続 CLOSED へ前進する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-feedback-fairness-"));
    const outputPath = join(tmpDir, "review-feedback.jsonl");

    const searchedStates: string[] = [];
    const fetchedPrBatches: number[][] = [];

    const openItems = [
      {
        number: 500103,
        title: "New package: Open.Latest 1.0",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/500103",
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-26T00:00:00Z",
        author: "u1",
      },
      {
        number: 500102,
        title: "New package: Open.Older 1.0",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/500102",
        created_at: "2026-10-20T00:00:00Z",
        updated_at: "2026-11-20T00:00:00Z",
        author: "u2",
      },
      {
        number: 500101,
        title: "New package: Open.Third 1.0",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/500101",
        created_at: "2026-10-10T00:00:00Z",
        updated_at: "2026-11-10T00:00:00Z",
        author: "u3",
      },
    ];
    const closedItems = [
      {
        number: 500003,
        title: "New package: Closed.Latest 1.0",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/500003",
        created_at: "2026-10-15T00:00:00Z",
        updated_at: "2026-11-25T00:00:00Z",
        author: "u4",
      },
      {
        number: 500002,
        title: "New package: Closed.Second 1.0",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/500002",
        created_at: "2026-10-10T00:00:00Z",
        updated_at: "2026-11-18T00:00:00Z",
        author: "u5",
      },
      {
        number: 500001,
        title: "New package: Closed.Third 1.0",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/500001",
        created_at: "2026-10-05T00:00:00Z",
        updated_at: "2026-11-15T00:00:00Z",
        author: "u6",
      },
    ];

    const makeMockPr = (
      num: number,
      title: string,
      state: "OPEN" | "CLOSED",
      updatedAt: string,
      author: string,
      body: string,
    ): Record<string, unknown> => ({
      number: num,
      title,
      url: `https://github.com/microsoft/winget-pkgs/pull/${num}`,
      state,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt,
      mergedAt: null,
      closedAt: state === "CLOSED" ? updatedAt : null,
      author: { __typename: "User", login: author },
      authorAssociation: "NONE",
      commits: { totalCount: 1 },
      labels: {
        nodes:
          state === "OPEN"
            ? [{ name: "New-Package" }, { name: "Needs-Author-Feedback" }]
            : [{ name: "New-Package" }],
      },
      files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      comments: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            author: { __typename: "User", login: "mod" },
            authorAssociation: "COLLABORATOR",
            body,
            createdAt: updatedAt,
          },
        ],
      },
      timelineItems: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes:
          state === "CLOSED"
            ? [
                {
                  __typename: "LabeledEvent",
                  createdAt: updatedAt,
                  label: { name: "Needs-Author-Feedback" },
                },
              ]
            : [],
      },
    });

    const prDetailsByNumber = new Map<number, Record<string, unknown>>([
      [
        500103,
        makeMockPr(
          500103,
          "New package: Open.Latest 1.0",
          "OPEN",
          "2026-11-26T00:00:00Z",
          "u1",
          "PrivacyUrl 404",
        ),
      ],
      [
        500102,
        makeMockPr(
          500102,
          "New package: Open.Older 1.0",
          "OPEN",
          "2026-11-20T00:00:00Z",
          "u2",
          "VCRUNTIME140.dll missing",
        ),
      ],
      [
        500101,
        makeMockPr(
          500101,
          "New package: Open.Third 1.0",
          "OPEN",
          "2026-11-10T00:00:00Z",
          "u3",
          "SmartScreen warning",
        ),
      ],
      [
        500003,
        makeMockPr(
          500003,
          "New package: Closed.Latest 1.0",
          "CLOSED",
          "2026-11-25T00:00:00Z",
          "u4",
          "SmartScreen warning",
        ),
      ],
      [
        500002,
        makeMockPr(
          500002,
          "New package: Closed.Second 1.0",
          "CLOSED",
          "2026-11-18T00:00:00Z",
          "u5",
          "InstallerType mismatch",
        ),
      ],
      [
        500001,
        makeMockPr(
          500001,
          "New package: Closed.Third 1.0",
          "CLOSED",
          "2026-11-15T00:00:00Z",
          "u6",
          "ReleaseNotesUrl 404",
        ),
      ],
    ]);

    const mockClient = {
      searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
        if (query.includes("is:open")) {
          searchedStates.push("open");
          return {
            totalCount: openItems.length,
            items: openItems,
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        }
        if (query.includes("is:closed")) {
          searchedStates.push("closed");
          return {
            totalCount: closedItems.length,
            items: closedItems,
            pageInfo: { hasNextPage: false, endCursor: null },
          };
        }
        return { totalCount: 0, items: [], pageInfo: { hasNextPage: false, endCursor: null } };
      },
      graphql: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes("GetPullRequestFeedbackBatch")) {
          const matchedNums = [...query.matchAll(/pullRequest\(number:\s*(\d+)\)/g)].map((m) =>
            Number(m[1]),
          );
          fetchedPrBatches.push(matchedNums);
          const repo: Record<string, unknown> = {};
          matchedNums.forEach((num, idx) => {
            repo[`pr${idx}`] = prDetailsByNumber.get(num) ?? null;
          });
          return { repository: repo } as T;
        }
        if (query.includes("u_0: search")) {
          return { u_0: { issueCount: 0 }, u_1: { issueCount: 0 } } as T;
        }
        throw new Error(`Unexpected query: ${query}`);
      },
      getRateLimit: async () => ({
        graphql: { limit: 5000, remaining: 4940, resetAt: null },
      }),
    };

    try {
      const cliArgs = [
        "--states",
        "open,closed",
        "--lookback-days",
        "90",
        "--fetch-limit",
        "4",
        "--fetch-budget",
        "2",
        "--output-path",
        outputPath,
        "--no-report",
      ];

      // 1 回目: fetchLimit=4 が open:2 / closed:2 に均等配分され、fetchBudget=2 が open:1 / closed:1 に配分される
      const run1 = await runCollectReviewFeedback(
        { ...parseArgs(cliArgs), now: new Date("2026-11-27T06:00:00.000Z") },
        mockClient,
        () => {},
      );
      expect(searchedStates).toEqual(["open", "closed"]);
      expect(fetchedPrBatches[0]).toEqual([500103, 500003]);
      expect(run1.records.map((r) => r.number)).toEqual([500103, 500003]);

      // 2 回目: 1 回目で取得した未更新 OPEN (#500103) と CLOSED (#500003) が枠を消費せず再利用され、
      //        2 件目 (#500102, #500002) へ前進する
      const run2 = await runCollectReviewFeedback(
        { ...parseArgs(cliArgs), now: new Date("2026-11-27T06:05:00.000Z") },
        mockClient,
        () => {},
      );
      expect(run2.stats.reusedFromCacheCount).toBe(2);
      expect(fetchedPrBatches[1]).toEqual([500102, 500002]);
      expect(run2.records.map((r) => r.number)).toEqual([500103, 500102, 500003, 500002]);

      // 3 回目: 先頭 2 件ずつ（旧 stateLimit=2 の内側）がすべてキャッシュ済みでも枠を消費せず読み飛ばし、
      //        上限外だった 3 件目 (#500101, #500001) へ確実に到達・取得できる
      const run3 = await runCollectReviewFeedback(
        { ...parseArgs(cliArgs), now: new Date("2026-11-27T06:10:00.000Z") },
        mockClient,
        () => {},
      );
      expect(run3.stats.reusedFromCacheCount).toBe(4);
      expect(fetchedPrBatches[2]).toEqual([500101, 500001]);
      expect(run3.records.map((r) => r.number)).toEqual([
        500103, 500102, 500101, 500003, 500002, 500001,
      ]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("--reclassify --fetch-budget 0 は既存 v1 コーパスを API ゼロで v2 へ再分類・永続化し --blocking-only で絞り込める", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-feedback-reclassify-"));
    const outputPath = join(tmpDir, "review-feedback.jsonl");
    const reportPath = join(tmpDir, "review-feedback-report.md");

    const v1Entries = [
      {
        schemaVersion: 1,
        entryType: "feedback",
        repository: "microsoft/winget-pkgs",
        number: 448826,
        title: "New package: Noise.Only version 1.0.0",
        url: "https://github.com/microsoft/winget-pkgs/pull/448826",
        state: "MERGED",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-11-24T00:00:00Z",
        mergedAt: "2026-11-24T00:00:00Z",
        closedAt: "2026-11-24T00:00:00Z",
        author: "u1",
        authorAssociation: "NONE",
        commitCount: 1,
        triggers: ["needs-author-feedback-label"],
        currentLabels: ["New-Package"],
        historicalFeedbackLabels: ["Needs-Author-Feedback"],
        installer: {
          files: ["manifests/n/Noise/Only/1.0.0/Noise.Only.installer.yaml"],
          installerTypes: ["inno"],
          nestedInstallerTypes: [],
          architectures: ["x64"],
          scopes: [],
          isPortable: false,
        },
        feedbackItems: [
          {
            source: "issue_comment",
            author: "stephengillie",
            authorAssociation: "COLLABORATOR",
            createdAt: "2026-11-23T00:00:00Z",
            body: 'Verify: <img src="https://example.com/a.png" /> Privacy Policy: https://example.com/privacy',
            hasImage: true,
          },
        ],
        authorReplies: [],
        categories: ["uncategorized"],
        categoryMatches: [{ category: "uncategorized", matchedKeywords: [] }],
        collectedAt: "2026-11-27T00:00:00Z",
      },
      {
        schemaVersion: 1,
        entryType: "feedback",
        repository: "microsoft/winget-pkgs",
        number: 446301,
        title: "New package: Advice.Only version 1.0.0",
        url: "https://github.com/microsoft/winget-pkgs/pull/446301",
        state: "MERGED",
        createdAt: "2026-10-02T00:00:00Z",
        updatedAt: "2026-11-25T00:00:00Z",
        mergedAt: "2026-11-25T00:00:00Z",
        closedAt: "2026-11-25T00:00:00Z",
        author: "u2",
        authorAssociation: "NONE",
        commitCount: 1,
        triggers: ["needs-author-feedback-label"],
        currentLabels: ["New-Package"],
        historicalFeedbackLabels: ["Needs-Author-Feedback"],
        installer: {
          files: [],
          installerTypes: ["inno"],
          nestedInstallerTypes: [],
          architectures: ["x64"],
          scopes: [],
          isPortable: false,
        },
        feedbackItems: [
          {
            source: "issue_comment",
            author: "taras-janea",
            authorAssociation: "NONE",
            createdAt: "2026-11-24T00:00:00Z",
            body: "No blockers have been found for this PR. Optional note: adding PrivacyUrl helps.",
            hasImage: false,
          },
        ],
        authorReplies: [],
        categories: ["metadata-url"],
        categoryMatches: [{ category: "metadata-url", matchedKeywords: ["PrivacyUrl"] }],
        collectedAt: "2026-11-27T00:00:00Z",
      },
      {
        schemaVersion: 1,
        entryType: "feedback",
        repository: "microsoft/winget-pkgs",
        number: 446778,
        title: "New package: Real.Blocker version 1.0.0",
        url: "https://github.com/microsoft/winget-pkgs/pull/446778",
        state: "MERGED",
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-11-25T00:00:00Z",
        mergedAt: "2026-11-25T00:00:00Z",
        closedAt: "2026-11-25T00:00:00Z",
        author: "u3",
        authorAssociation: "NONE",
        commitCount: 2,
        triggers: ["needs-author-feedback-label"],
        currentLabels: ["New-Package"],
        historicalFeedbackLabels: ["Needs-Author-Feedback"],
        installer: {
          files: [],
          installerTypes: ["inno"],
          nestedInstallerTypes: [],
          architectures: ["x64"],
          scopes: [],
          isPortable: false,
        },
        feedbackItems: [
          {
            source: "issue_comment",
            author: "stephengillie",
            authorAssociation: "COLLABORATOR",
            createdAt: "2026-11-24T00:00:00Z",
            body: 'Verify: <img src="https://example.com/a.png" /> Hi @u3, This package sends data off device. Does it have a privacy policy?',
            hasImage: true,
          },
        ],
        authorReplies: [],
        categories: ["uncategorized"],
        categoryMatches: [{ category: "uncategorized", matchedKeywords: [] }],
        collectedAt: "2026-11-27T00:00:00Z",
      },
    ];
    writeFileSync(outputPath, `${v1Entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");

    const unusedClient = {
      searchIssuesDetailed: async () => {
        throw new Error("API must not be called when fetchBudget === 0");
      },
      graphql: async () => {
        throw new Error("GraphQL must not be called when fetchBudget === 0");
      },
      getRateLimit: async () => {
        throw new Error("RateLimit must not be called when fetchBudget === 0");
      },
    };

    try {
      const res = await runCollectReviewFeedback(
        {
          ...parseArgs([
            "--reclassify",
            "--fetch-budget",
            "0",
            "--output-path",
            outputPath,
            "--report-path",
            reportPath,
          ]),
          now: new Date("2026-11-27T06:00:00.000Z"),
        },
        unusedClient,
        () => {},
      );

      expect(res.records.map((r) => r.number)).toEqual([446778, 446301]);
      expect(res.summary.blockingPrCount).toBe(1);
      expect(res.summary.nonBlockingOnlyPrCount).toBe(1);
      expect(res.records[0].categories).toEqual(["privacy-policy"]);

      const saved = parseReviewFeedbackCorpus(readFileSync(outputPath, "utf-8"));
      const demoted = saved.find((e) => e.number === 448826);
      expect(demoted?.entryType).toBe("no-feedback");
      if (demoted?.entryType === "no-feedback") {
        expect(demoted.skipReason).toBe("noise-only-feedback");
        expect(demoted.schemaVersion).toBe(2);
      }

      // --blocking-only で非ブロッキング助言のみの #446301 が除外される
      const blockingOnlyRes = await runCollectReviewFeedback(
        {
          ...parseArgs([
            "--fetch-budget",
            "0",
            "--blocking-only",
            "--no-write",
            "--output-path",
            outputPath,
          ]),
          now: new Date("2026-11-27T06:05:00.000Z"),
        },
        unusedClient,
        () => {},
      );
      expect(blockingOnlyRes.records.map((r) => r.number)).toEqual([446778]);
      expect(blockingOnlyRes.summary.blockingPrCount).toBe(1);
      expect(blockingOnlyRes.summary.nonBlockingOnlyPrCount).toBe(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLOSED PR で Needs-Author-Feedback なしでも却下ラベル・メンテナコメントがあれば Blob と作者情報込みで収集される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-feedback-closed-direct-"));
    const outputPath = join(tmpDir, "review-feedback.jsonl");
    let blobCalls = 0;

    const mockClient = {
      searchIssuesDetailed: async (): Promise<GitHubDetailedSearchResult> => ({
        totalCount: 1,
        items: [
          {
            number: 436234,
            title: "New package: DiamTek.JVM version 1.1.1",
            html_url: "https://github.com/microsoft/winget-pkgs/pull/436234",
            created_at: "2026-10-10T00:00:00Z",
            updated_at: "2026-11-10T00:00:00Z",
            author: "TheHawk09",
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      }),
      graphql: async <T = unknown>(query: string): Promise<T> => {
        if (query.includes("GetPullRequestFeedbackBatch")) {
          return {
            repository: {
              pr0: {
                number: 436234,
                title: "New package: DiamTek.JVM version 1.1.1",
                url: "https://github.com/microsoft/winget-pkgs/pull/436234",
                state: "CLOSED",
                createdAt: "2026-10-10T00:00:00Z",
                updatedAt: "2026-11-10T00:00:00Z",
                mergedAt: null,
                closedAt: "2026-11-10T00:00:00Z",
                headRefOid: VALID_OID,
                author: { __typename: "User", login: "TheHawk09" },
                authorAssociation: "NONE",
                commits: { totalCount: 1 },
                labels: { nodes: [{ name: "New-Package" }, { name: "Scripted-Application" }] },
                files: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ path: "manifests/d/DiamTek/JVM/1.1.1/DiamTek.JVM.installer.yaml" }],
                },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                comments: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      author: { __typename: "User", login: "stephengillie" },
                      authorAssociation: "COLLABORATOR",
                      body: "Unfortunately, we're not currently accepting scripted applications.",
                      createdAt: "2026-11-09T00:00:00Z",
                    },
                  ],
                },
                timelineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      __typename: "LabeledEvent",
                      createdAt: "2026-11-09T00:00:00Z",
                      label: { name: "Scripted-Application" },
                    },
                  ],
                },
              },
            },
          } as T;
        }
        if (query.includes("GetInstallerManifestBlobs")) {
          blobCalls++;
          return {
            repository: {
              b0: { text: "InstallerType: portable\nManifestVersion: 1.28.0\n" },
            },
          } as T;
        }
        if (query.includes("u_0: search")) {
          return { u_0: { issueCount: 0 } } as T;
        }
        throw new Error(`Unexpected query: ${query}`);
      },
      getRateLimit: async () => ({
        graphql: { limit: 5000, remaining: 4990, resetAt: null },
      }),
    };

    try {
      const res = await runCollectReviewFeedback(
        {
          ...parseArgs(["--states", "closed", "--output-path", outputPath, "--no-report"]),
          now: new Date("2026-11-27T06:00:00.000Z"),
        },
        mockClient,
        () => {},
      );
      expect(blobCalls).toBe(1);
      expect(res.records).toHaveLength(1);
      expect(res.records[0].triggers).toEqual([
        "closed-rejection-label",
        "closed-maintainer-feedback",
      ]);
      expect(res.records[0].installer.isPortable).toBe(true);
      expect(res.records[0].isFirstTimeAuthor).toBe(true);
      expect(res.records[0].categories).toEqual(["security-signing"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
