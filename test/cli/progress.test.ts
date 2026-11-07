import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../../scripts/build-pages";
import type { GitHubApiClient, GitHubDetailedSearchResult } from "../../src/api/github";
import { parseArgs, resolveDefaultDataDir, runProgressCli } from "../../src/cli/progress";

describe("CLI: progress parseArgs", () => {
  test("デフォルト値が正しく設定される", () => {
    const origEnv = { ...process.env };
    delete process.env.WINGET_TARGET_PR;
    delete process.env.WINGET_REPOSITORY;
    delete process.env.WINGET_LOG_PATH;
    delete process.env.WINGET_SNAPSHOT_PATH;

    try {
      const opts = parseArgs([]);
      expect(opts.targetPr).toBe(464302);
      expect(opts.repository).toBe("microsoft/winget-pkgs");
      expect(opts.lookbackDays).toBe(30);
      expect(opts.sampleSize).toBe(30);
      expect(opts.fetchLimit).toBe(1000);
      expect(opts.noLog).toBeFalse();
      expect(opts.asJson).toBeFalse();
    } finally {
      process.env = origEnv;
    }
  });

  test("コマンドライン引数を正しくパースする", () => {
    const opts = parseArgs([
      "--target-pr",
      "99999",
      "--repo",
      "custom/repo",
      "--lookback-days",
      "14",
      "--sample-size",
      "20",
      "--fetch-limit",
      "200",
      "--log-path",
      "custom.csv",
      "--snapshot-path",
      "custom.json",
      "--no-log",
      "--as-json",
    ]);

    expect(opts.targetPr).toBe(99999);
    expect(opts.repository).toBe("custom/repo");
    expect(opts.lookbackDays).toBe(14);
    expect(opts.sampleSize).toBe(20);
    expect(opts.fetchLimit).toBe(200);
    expect(opts.logPath).toBe("custom.csv");
    expect(opts.snapshotPath).toBe("custom.json");
    expect(opts.noLog).toBeTrue();
    expect(opts.asJson).toBeTrue();
  });

  test("不正な数値・範囲外の引数を拒否する", () => {
    expect(() => parseArgs(["--target-pr", "abc"])).toThrow("無効な値");
    expect(() => parseArgs(["--target-pr", "-5"])).toThrow();
    expect(() => parseArgs(["--lookback-days", "0"])).toThrow("無効な値");
    expect(() => parseArgs(["--lookback-days", "400"])).toThrow("無効な値");
    expect(() => parseArgs(["--sample-size", "150"])).toThrow("無効な値");
    expect(() => parseArgs(["--fetch-limit", "0"])).toThrow("無効な値");
  });

  test("引数値の欠落や後続フラグの誤消費を拒否する", () => {
    expect(() => parseArgs(["--target-pr"])).toThrow("必要です");
    expect(() => parseArgs(["--target-pr", "--no-log"])).toThrow("必要です");
    expect(() => parseArgs(["--log-path", "--no-log"])).toThrow("必要です");
  });

  test("未知の引数を拒否する", () => {
    expect(() => parseArgs(["--unknown-option"])).toThrow("未知のオプション");
  });
});

describe("CLI: resolveDefaultDataDir", () => {
  test("既定の保存先は実行時の cwd ではなくリポジトリルートの data/ を起点に解決する", () => {
    const tempWorkingDir = mkdtempSync(join(tmpdir(), "winget-progress-external-cwd-"));
    const originalCwd = process.cwd();
    const expectedRepoDataDir = join(__dirname, "../../data");

    try {
      const defaultDir1 = resolveDefaultDataDir();
      expect(defaultDir1).toBe(expectedRepoDataDir);

      process.chdir(tempWorkingDir);
      const defaultDir2 = resolveDefaultDataDir();
      expect(defaultDir2).toBe(expectedRepoDataDir);
      expect(defaultDir2).not.toBe(join(tempWorkingDir, "data"));
    } finally {
      process.chdir(originalCwd);
      rmSync(tempWorkingDir, { recursive: true, force: true });
    }
  });
});

describe("CLI: runProgressCli with mock client", () => {
  test("PR が CLOSED の場合はログ出力して snapshot: null を返す", async () => {
    const mockClient = {
      getPullRequestDetails: async () => ({
        number: 100,
        title: "Closed PR",
        url: "https://github.com/test/repo/pull/100",
        state: "CLOSED" as const,
        isDraft: false,
        createdAt: "2026-11-01T00:00:00Z",
        mergedAt: null,
        closedAt: "2026-11-02T00:00:00Z",
        labels: [],
        commits: [],
      }),
    } as unknown as GitHubApiClient;

    const logs: string[] = [];
    const res = await runProgressCli(
      {
        targetPr: 100,
        repository: "test/repo",
        lookbackDays: 30,
        sampleSize: 30,
        fetchLimit: 1000,
        noLog: true,
        asJson: false,
      },
      mockClient,
      (msg) => logs.push(msg),
    );

    expect(res.snapshot).toBeNull();
    expect(logs.some((l) => l.includes("ステータス                 : CLOSED"))).toBeTrue();
    expect(logs.some((l) => l.includes("通算所要日数"))).toBeTrue();
  });

  test("必須ラベルが不足している場合は snapshot: null を返す", async () => {
    const mockClient = {
      getPullRequestDetails: async () => ({
        number: 101,
        title: "Incomplete PR",
        url: "https://github.com/test/repo/pull/101",
        state: "OPEN" as const,
        isDraft: false,
        createdAt: "2026-11-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels: ["New-Package"], // 2つ不足
        commits: [],
      }),
    } as unknown as GitHubApiClient;

    const logs: string[] = [];
    const res = await runProgressCli(
      {
        targetPr: 101,
        repository: "test/repo",
        lookbackDays: 30,
        sampleSize: 30,
        fetchLimit: 1000,
        noLog: true,
        asJson: false,
      },
      mockClient,
      (msg) => logs.push(msg),
    );

    expect(res.snapshot).toBeNull();
    expect(logs.some((l) => l.includes("不足ラベル"))).toBeTrue();
  });

  test("正常系でスナップショット生成と CSV/JSON 出力が行われる", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-test-"));
    const logPath = join(tmpDir, "progress-history.csv");
    const snapshotPath = join(tmpDir, "latest-progress.json");

    try {
      const mockClient = {
        getPullRequestDetails: async () => ({
          number: 200,
          title: "Valid PR",
          url: "https://github.com/test/repo/pull/200",
          state: "OPEN" as const,
          isDraft: false,
          createdAt: "2026-11-01T00:00:00Z",
          mergedAt: null,
          closedAt: null,
          labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
          commits: [
            {
              oid: "1234567890",
              messageHeadline: "feat: add package",
              committedDate: "2026-11-01T00:00:00Z",
            },
          ],
        }),
        getIssueTimeline: async () => [
          {
            event: "labeled",
            created_at: "2026-11-01T01:00:00Z",
            label: { name: "New-Package" },
          },
          {
            event: "labeled",
            created_at: "2026-11-01T01:00:00Z",
            label: { name: "Azure-Pipeline-Passed" },
          },
          {
            event: "labeled",
            created_at: "2026-11-01T01:00:00Z",
            label: { name: "Validation-Completed" },
          },
        ],
        searchIssuesDetailed: async () => ({
          totalCount: 5,
          items: [],
        }),
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const res = await runProgressCli(
        {
          targetPr: 200,
          repository: "test/repo",
          lookbackDays: 30,
          sampleSize: 30,
          fetchLimit: 1000,
          logPath,
          snapshotPath,
          noLog: false,
          asJson: false,
        },
        mockClient,
        (msg) => logs.push(msg),
      );

      expect(res.snapshot).not.toBeNull();
      expect(res.snapshot?.TargetPr).toBe(200);
      expect(existsSync(logPath)).toBeTrue();
      expect(existsSync(snapshotPath)).toBeTrue();

      const csvContent = readFileSync(logPath, "utf-8");
      expect(csvContent).toContain('"200"');
      expect(csvContent).toContain('"TotalLifetimeDays"');

      const jsonContent = JSON.parse(readFileSync(snapshotPath, "utf-8"));
      expect(jsonContent.TargetPr).toBe(200);
      expect(jsonContent.PrTitle).toBe("Valid PR");

      // CLI 出力スナップショットを buildDashboard に渡して HTML 生成を検証
      const siteDir = join(tmpDir, "site");
      const { htmlPath } = buildDashboard({
        dataDir: tmpDir,
        outputDir: siteDir,
      });
      expect(existsSync(htmlPath)).toBeTrue();
      const htmlContent = readFileSync(htmlPath, "utf-8");
      expect(htmlContent).toContain("Valid PR");
      expect(htmlContent).toContain("200");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("マージ済み候補が複数ページ（101件以上）に渡る場合もページネーションして取得する", async () => {
    const searchPageCalls: number[] = [];
    const mockClient = {
      getPullRequestDetails: async (_repo: string, num: number) => ({
        number: num,
        title: `PR ${num}`,
        url: `https://github.com/test/repo/pull/${num}`,
        state: "OPEN" as const,
        isDraft: false,
        createdAt: "2026-11-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
        commits: [
          {
            oid: "abc",
            messageHeadline: "fix",
            committedDate: "2026-11-01T00:00:00Z",
          },
        ],
      }),
      getIssueTimeline: async () => [
        {
          event: "labeled",
          created_at: "2026-11-01T01:00:00Z",
          label: { name: "New-Package" },
        },
        {
          event: "labeled",
          created_at: "2026-11-01T01:00:00Z",
          label: { name: "Azure-Pipeline-Passed" },
        },
        {
          event: "labeled",
          created_at: "2026-11-01T01:00:00Z",
          label: { name: "Validation-Completed" },
        },
      ],
      searchIssuesDetailed: async (
        query: string,
        _sort?: string,
        _order?: string,
        _perPage?: number,
        page = 1,
      ): Promise<GitHubDetailedSearchResult> => {
        if (query.includes("is:merged")) {
          searchPageCalls.push(page);
          if (page === 1) {
            // 1ページ目: 100件の候補（すべて条件不成立の無効アイテム）
            const items = Array.from({ length: 100 }, (_, i) => ({
              number: 1000 + i,
              title: `Invalid Candidate ${i}`,
              html_url: `https://github.com/test/repo/pull/${1000 + i}`,
              created_at: "2026-11-01T00:00:00Z",
              updated_at: "2026-11-02T00:00:00Z",
              labels: [], // 必須ラベルなし
              is_draft: false,
              pull_request: { merged_at: "2026-11-02T10:00:00Z" },
            }));
            return { totalCount: 150, items };
          }
          if (page === 2) {
            // 2ページ目: 1件の有効な候補
            return {
              totalCount: 150,
              items: [
                {
                  number: 2000,
                  title: "Valid Merged Candidate",
                  html_url: "https://github.com/test/repo/pull/2000",
                  created_at: "2026-11-01T00:00:00Z",
                  updated_at: "2026-11-03T00:00:00Z",
                  labels: [
                    { name: "New-Package" },
                    { name: "Azure-Pipeline-Passed" },
                    { name: "Validation-Completed" },
                  ],
                  is_draft: false,
                  pull_request: { merged_at: "2026-11-03T12:00:00Z" },
                },
              ],
            };
          }
          return { totalCount: 150, items: [] };
        }
        return { totalCount: 0, items: [] };
      },
    } as unknown as GitHubApiClient;

    const res = await runProgressCli(
      {
        targetPr: 500,
        repository: "test/repo",
        lookbackDays: 30,
        sampleSize: 10,
        fetchLimit: 200,
        noLog: true,
        asJson: false,
      },
      mockClient,
      () => {},
    );

    // 2ページ目まで検索APIが呼ばれたこと
    expect(searchPageCalls).toContain(1);
    expect(searchPageCalls).toContain(2);
    // 2ページ目の有効候補が集計され、前線PRとして採用されたこと
    expect(res.snapshot).not.toBeNull();
    expect(res.snapshot?.FrontNumber).toBe(2000);
  });
});
