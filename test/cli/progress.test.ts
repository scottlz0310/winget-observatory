import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../../scripts/build-pages";
import type { GitHubApiClient, GitHubDetailedSearchResult } from "../../src/api/github";
import {
  parseArgs,
  reportSkippedObservation,
  resolveDefaultDataDir,
  runProgressCli,
} from "../../src/cli/progress";
import { REQUIRED_LABELS } from "../../src/domain/progress";
import { parseSampleCache, serializeSampleCacheEntries } from "../../src/domain/sample-cache";
import type { SampleCacheEntry } from "../../src/models/sample-cache";

describe("CLI: progress parseArgs", () => {
  test("デフォルト値が正しく設定される", () => {
    const envKeys = [
      "WINGET_TARGET_PR",
      "WINGET_REPOSITORY",
      "WINGET_LOG_PATH",
      "WINGET_SNAPSHOT_PATH",
    ];
    const saved = envKeys.map((key) => [key, process.env[key]] as const);
    delete process.env.WINGET_TARGET_PR;
    delete process.env.WINGET_REPOSITORY;
    delete process.env.WINGET_LOG_PATH;
    delete process.env.WINGET_SNAPSHOT_PATH;

    try {
      const opts = parseArgs([]);
      expect(opts.targetPr).toBe(464302);
      expect(opts.repository).toBe("microsoft/winget-pkgs");
      expect(opts.lookbackDays).toBe(30);
      expect(opts.firstTimerLookbackDays).toBe(90);
      expect(opts.fetchBudget).toBe(100);
      expect(opts.fetchLimit).toBe(5000);
      expect(opts.noLog).toBeFalse();
      expect(opts.asJson).toBeFalse();
    } finally {
      // process.env オブジェクト自体は置換せず、変更したキーだけを復元する
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
      "--first-timer-lookback-days",
      "60",
      "--fetch-budget",
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
    expect(opts.firstTimerLookbackDays).toBe(60);
    expect(opts.fetchBudget).toBe(20);
    expect(opts.fetchLimit).toBe(200);
    expect(opts.logPath).toBe("custom.csv");
    expect(opts.snapshotPath).toBe("custom.json");
    expect(opts.noLog).toBeTrue();
    expect(opts.asJson).toBeTrue();
  });

  test.each([
    [["--target-pr", "abc"], "無効な値"],
    [["--target-pr", "-5"], undefined],
    [["--lookback-days", "0"], "無効な値"],
    [["--lookback-days", "400"], "無効な値"],
    [["--first-timer-lookback-days", "0"], "無効な値"],
    [["--first-timer-lookback-days", "400"], "無効な値"],
    [["--first-timer-lookback-days"], "必要です"],
    [["--fetch-budget", "1001"], "無効な値"],
    [["--fetch-budget", "0"], "無効な値"],
    [["--sample-size", "30"], "未知のオプション"],
    [["--cache-path"], "必要です"],
    [["--fetch-limit", "0"], "無効な値"],
    [["--fetch-limit", "10001"], "無効な値"],
    [["--target-pr"], "必要です"],
    [["--target-pr", "--no-log"], "必要です"],
    [["--log-path", "--no-log"], "必要です"],
    [["--unknown-option"], "未知のオプション"],
  ])("不正な引数 %j を拒否する", (args, message) => {
    expect(() => parseArgs(args)).toThrow(message);
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
        updatedAt: "2026-11-01T00:00:00Z",
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
        fetchBudget: 30,
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
        updatedAt: "2026-11-01T00:00:00Z",
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
        fetchBudget: 30,
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
          updatedAt: "2026-11-01T00:00:00Z",
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
          items: [
            {
              number: 100,
              title: "Oldest healthy PR",
              html_url: "https://github.com/test/repo/pull/100",
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
              labels: [],
            },
          ],
        }),
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const res = await runProgressCli(
        {
          targetPr: 200,
          repository: "test/repo",
          lookbackDays: 30,
          fetchBudget: 30,
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
        updatedAt: "2026-11-01T00:00:00Z",
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
        return {
          totalCount: 3,
          items: [
            {
              number: 100,
              title: "Oldest healthy PR",
              html_url: "https://github.com/test/repo/pull/100",
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-02T00:00:00Z",
              labels: [],
            },
          ],
        };
      },
    } as unknown as GitHubApiClient;

    const res = await runProgressCli(
      {
        targetPr: 500,
        repository: "test/repo",
        lookbackDays: 30,
        fetchBudget: 10,
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
    // 2ページ目の有効候補が統計サンプルとして集計されたこと（前線はマージ実績ではなく最古の健康な未マージ PR）
    expect(res.snapshot).not.toBeNull();
    expect(res.snapshot?.FrontNumber).toBe(100);
    expect(res.snapshot?.TotalMedianDays).not.toBeNull();
  });
});

describe("CLI: 前線・実質待ち（更新順）の算出", () => {
  const labels = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"];
  const frontItem = {
    number: 100,
    title: "Oldest healthy PR",
    html_url: "https://github.com/test/repo/pull/100",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    labels: [],
  };

  const createMockClient = (queries: string[]) =>
    ({
      getPullRequestDetails: async () => ({
        number: 200,
        title: "Valid PR",
        url: "https://github.com/test/repo/pull/200",
        state: "OPEN" as const,
        isDraft: false,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels,
        commits: [{ oid: "abc", messageHeadline: "fix", committedDate: "2026-11-01T00:00:00Z" }],
      }),
      getIssueTimeline: async () =>
        labels.map((name) => ({
          event: "labeled",
          created_at: "2026-11-01T01:00:00Z",
          label: { name },
        })),
      searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
        queries.push(query);
        if (query.includes("is:merged")) return { totalCount: 0, items: [] };
        if (query.includes("updated:<")) return { totalCount: 60, items: [] };
        if (query.includes("created:<")) return { totalCount: 100, items: [] };
        return { totalCount: 150, items: [frontItem] };
      },
    }) as unknown as GitHubApiClient;

  const baseOptions = {
    targetPr: 200,
    repository: "test/repo",
    lookbackDays: 30,
    fetchBudget: 30,
    fetchLimit: 1000,
    asJson: false,
  };

  test("前線は最古の健康な未マージ PR、実質待ちは更新順で自 PR より前の健康な PR 数とする", async () => {
    const queries: string[] = [];
    const res = await runProgressCli(
      { ...baseOptions, noLog: true },
      createMockClient(queries),
      () => {},
    );

    expect(res.snapshot).toMatchObject({
      FrontNumber: 100,
      TotalAhead: 100,
      ActiveAhead: 60,
      Behind: 49,
    });
    // 指摘なく順番待ちしている PR は更新が止まっているため、基準 PR の更新時刻より前に更新された健康な PR を数える
    const updatedQuery = queries.find((q) => q.includes("updated:<")) ?? "";
    expect(updatedQuery).toContain("updated:<2026-11-01T00:00:00.000Z");
    expect(updatedQuery).not.toContain("created:<");
  });

  test("前回行が旧定義（QueueBasis 列なし）の場合は定義が異なるため前回比を出さない", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-legacy-"));
    try {
      const logPath = join(tmpDir, "progress-history.csv");
      writeFileSync(
        logPath,
        [
          '"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount"',
          '"2026-11-06 23:22:44","200","447466","2026-10-06 10:13","1618","2133","756","9.07","9.07","9","1"',
          "",
        ].join("\n"),
        "utf-8",
      );

      const logs: string[] = [];
      await runProgressCli(
        { ...baseOptions, logPath, snapshotPath: join(tmpDir, "latest.json"), noLog: false },
        createMockClient([]),
        (msg) => logs.push(msg),
      );

      expect(logs.some((l) => l.includes("前回比"))).toBeFalse();
      // 新しい行は QueueBasis 列を含み、旧行は空欄のまま温存される
      const csv = readFileSync(logPath, "utf-8");
      expect(csv.split("\n")[0]).toContain('"QueueBasis"');
      expect(csv).toContain('"447466"');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("前回行が新定義なら前回比を出す", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-newdef-"));
    try {
      const logPath = join(tmpDir, "progress-history.csv");
      writeFileSync(
        logPath,
        [
          '"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis"',
          '"2026-11-06 23:22:44","200","90","2026-08-01 10:00","70","115","50","9","9","9","1","updated"',
          "",
        ].join("\n"),
        "utf-8",
      );

      const logs: string[] = [];
      await runProgressCli(
        { ...baseOptions, logPath, snapshotPath: join(tmpDir, "latest.json"), noLog: false },
        createMockClient([]),
        (msg) => logs.push(msg),
      );

      expect(logs.find((l) => l.startsWith("実質待ちPR"))).toContain("[前回比 -10 件]");
      expect(logs.find((l) => l.startsWith("消化前線"))).toContain("[前回 #90 から +10 件前進]");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("検索結果に前線が存在しない場合は黙って続行せず中断する", async () => {
    const mockClient = {
      ...createMockClient([]),
      searchIssuesDetailed: async () => ({ totalCount: 0, items: [] }),
    } as unknown as GitHubApiClient;

    await expect(
      runProgressCli({ ...baseOptions, noLog: true }, mockClient, () => {}),
    ).rejects.toThrow("前線");
  });
});

describe("CLI: progress のコミット表示", () => {
  test("複数コミットの最新コミット表示は区切り文字を重複させない", async () => {
    const labels = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"];
    const mockClient = {
      getPullRequestDetails: async () => ({
        number: 200,
        title: "Valid PR",
        url: "https://github.com/test/repo/pull/200",
        state: "OPEN" as const,
        isDraft: false,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels,
        commits: [
          {
            oid: "1111111aaaa",
            messageHeadline: "feat: add",
            committedDate: "2026-11-01T00:00:00Z",
          },
          {
            oid: "abcdef1234",
            messageHeadline: "fix: typo",
            committedDate: "2026-11-02T00:00:00Z",
          },
        ],
      }),
      getIssueTimeline: async () =>
        labels.map((name) => ({
          event: "labeled",
          created_at: "2026-11-01T01:00:00Z",
          label: { name },
        })),
      searchIssuesDetailed: async () => ({
        totalCount: 1,
        items: [
          {
            number: 100,
            title: "Oldest healthy PR",
            html_url: "https://github.com/test/repo/pull/100",
            created_at: "2026-09-01T00:00:00Z",
            updated_at: "2026-09-02T00:00:00Z",
            labels: [],
          },
        ],
      }),
    } as unknown as GitHubApiClient;

    const logs: string[] = [];
    await runProgressCli(
      {
        targetPr: 200,
        repository: "test/repo",
        lookbackDays: 30,
        fetchBudget: 30,
        fetchLimit: 1000,
        noLog: true,
        asJson: false,
      },
      mockClient,
      (msg) => logs.push(msg),
    );

    const turnLine = logs.find((l) => l.includes("2 コミット目")) ?? "";
    expect(turnLine).toContain("2 コミット目: abcdef1 - fix: typo)");
    expect(turnLine).not.toContain(" -  - ");
  });
});

describe("CLI: runProgressCli のエラー伝播", () => {
  test("マージ済みサンプルの計測に失敗した場合は握りつぶさず PR 番号付きで中断する", async () => {
    const readyLabels = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"];
    let timelineCalls = 0;
    const mockClient = {
      getPullRequestDetails: async () => ({
        number: 200,
        title: "Valid PR",
        url: "https://github.com/test/repo/pull/200",
        state: "OPEN" as const,
        isDraft: false,
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels: readyLabels,
        commits: [{ oid: "abc", messageHeadline: "fix", committedDate: "2026-11-01T00:00:00Z" }],
      }),
      getIssueTimeline: async () => {
        timelineCalls++;
        if (timelineCalls > 1) {
          throw new Error("rate limited");
        }
        return readyLabels.map((name) => ({
          event: "labeled",
          created_at: "2026-11-01T01:00:00Z",
          label: { name },
        }));
      },
      searchIssuesDetailed: async () => ({
        totalCount: 1,
        items: [
          {
            number: 100,
            title: "Merged PR",
            html_url: "https://github.com/test/repo/pull/100",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-11-02T00:00:00Z",
            labels: readyLabels.map((name) => ({ name })),
            pull_request: { merged_at: "2026-11-02T00:00:00Z" },
          },
        ],
      }),
    } as unknown as GitHubApiClient;

    await expect(
      runProgressCli(
        {
          targetPr: 200,
          repository: "test/repo",
          lookbackDays: 30,
          fetchBudget: 30,
          fetchLimit: 1000,
          noLog: true,
          asJson: false,
        },
        mockClient,
        () => {},
      ),
    ).rejects.toThrow(/#100 のサンプル計測に失敗しました: rate limited/);
  });
});

describe("CLI: progress の保全とスキップ通知", () => {
  test("履歴 CSV を読めない場合は検索へ進まず、パス付きで中断する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-badlog-"));
    try {
      // ディレクトリを履歴パスに置き、存在するが読めない状態を作る
      const logPath = join(tmpDir, "progress-history.csv");
      mkdirSync(logPath);
      const labels = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"];
      let searched = false;
      const mockClient = {
        getPullRequestDetails: async () => ({
          number: 200,
          title: "Valid PR",
          url: "https://github.com/test/repo/pull/200",
          state: "OPEN" as const,
          isDraft: false,
          createdAt: "2026-11-01T00:00:00Z",
          updatedAt: "2026-11-01T00:00:00Z",
          mergedAt: null,
          closedAt: null,
          labels,
          commits: [],
        }),
        getIssueTimeline: async () =>
          labels.map((name) => ({
            event: "labeled",
            created_at: "2026-11-01T01:00:00Z",
            label: { name },
          })),
        searchIssuesDetailed: async () => {
          searched = true;
          return { totalCount: 0, items: [] };
        },
      } as unknown as GitHubApiClient;

      await expect(
        runProgressCli(
          {
            targetPr: 200,
            repository: "test/repo",
            lookbackDays: 30,
            fetchBudget: 30,
            fetchLimit: 1000,
            logPath,
            noLog: false,
            asJson: false,
          },
          mockClient,
          () => {},
        ),
      ).rejects.toThrow(/履歴ファイルの読み込みに失敗しました/);
      expect(searched).toBeFalse();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    [null, { GITHUB_ACTIONS: "true" }, true],
    [null, {}, false],
    [{ TargetPr: 1 } as never, { GITHUB_ACTIONS: "true" }, false],
  ])(
    "reportSkippedObservation(snapshot=%j, env=%j) の warning 出力は %p",
    (snapshot, env, warned) => {
      const logs: string[] = [];
      reportSkippedObservation(snapshot, env, (m) => logs.push(m));
      expect(logs.length > 0).toBe(warned);
      if (warned) expect(logs[0]).toStartWith("::warning::");
    },
  );
});

describe("CLI: 過去実績との比較・ライバル PR", () => {
  const labels = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"].map((name) => ({
    name,
  }));
  const created: Record<number, string> = {
    500: "2026-11-01T00:00:00Z",
    400: "2026-10-20T00:00:00Z",
    450: "2026-10-25T00:00:00Z",
    600: "2026-11-02T00:00:00Z",
  };
  const merged: Record<number, string> = {
    400: "2026-11-04T00:00:00Z",
    450: "2026-11-03T00:00:00Z",
    600: "2026-11-02T12:00:00Z",
  };

  const buildClient = (): GitHubApiClient =>
    ({
      getPullRequestDetails: async (_repo: string, num: number) => ({
        number: num,
        title: `PR ${num}`,
        url: `https://github.com/test/repo/pull/${num}`,
        state: "OPEN" as const,
        isDraft: false,
        createdAt: created[num],
        updatedAt: created[num],
        mergedAt: null,
        closedAt: null,
        labels: labels.map((l) => l.name),
        commits: [{ oid: "abcdef0123", messageHeadline: "fix", committedDate: created[num] }],
      }),
      getIssueTimeline: async (_repo: string, num: number) =>
        labels.map((l) => ({
          event: "labeled",
          created_at: new Date(Date.parse(created[num]) + 3_600_000).toISOString(),
          label: { name: l.name },
        })),
      searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
        if (query.includes("is:merged")) {
          return {
            totalCount: 3,
            items: [400, 450, 600].map((n) => ({
              number: n,
              title: `Merged ${n}`,
              html_url: `https://github.com/test/repo/pull/${n}`,
              created_at: created[n],
              updated_at: merged[n],
              labels,
              is_draft: false,
              pull_request: { merged_at: merged[n] },
            })),
          };
        }
        return {
          totalCount: 4,
          items: [
            // 基準 PR より新しい番号・阻害ラベル付きはライバルから除く
            {
              number: 700,
              title: "Newer",
              html_url: "u",
              created_at: "2026-11-03T00:00:00Z",
              updated_at: "2026-11-03T00:00:00Z",
              labels: [],
            },
            {
              number: 480,
              title: "Blocked rival",
              html_url: "u",
              created_at: "2026-10-30T00:00:00Z",
              updated_at: "2026-10-30T00:00:00Z",
              labels: [{ name: "Needs-Author-Feedback" }],
            },
            {
              number: 470,
              title: "Healthy rival",
              html_url: "https://github.com/test/repo/pull/470",
              created_at: "2026-10-28T00:00:00Z",
              updated_at: "2026-10-29T00:00:00Z",
              labels: [],
            },
          ],
        };
      },
    }) as unknown as GitHubApiClient;

  const options = {
    targetPr: 500,
    repository: "test/repo",
    lookbackDays: 30,
    fetchBudget: 10,
    fetchLimit: 100,
    noLog: true,
    asJson: false,
  };

  test("ライバル PR・統計・追い越し・サンプル一覧をスナップショットとログに出す", async () => {
    const logs: string[] = [];
    const { snapshot } = await runProgressCli(options, buildClient(), (m) => logs.push(m));
    const text = logs.join("\n");

    expect(snapshot?.Rivals.map((r) => r.Number)).toEqual([470]);
    expect(snapshot?.Rivals[0].UpdatedAt).toBe("2026-10-29T00:00:00Z");
    expect(snapshot?.SampleCount).toBe(3);
    expect(snapshot?.SkippedCount).toBe(0);
    expect(snapshot?.LookbackDays).toBe(30);
    expect(snapshot?.Samples.map((s) => `${s.Number}:${s.Relation}`)).toEqual([
      "400:older",
      "450:older",
      "600:newer",
    ]);
    expect(snapshot?.Comparison).toMatchObject({ LaterCreated: 1, NewerNumber: 1 });
    expect(snapshot?.Comparison?.Verdict).toBe("mostly-older");
    expect(snapshot?.TotalMaxDays).not.toBeNull();
    expect(snapshot?.Guidance?.Ready.ShorterSharePct).toBeGreaterThanOrEqual(0);

    expect(text).toContain("直前のライバルPR");
    expect(text).toContain("#470");
    expect(text).not.toContain("Blocked rival");
    expect(text).toContain("3. （参考）条件成立後");
    expect(text).toContain("参考目安:");
    expect(text).toContain("【条件成立日時の比較（ReadyAt）】");
    expect(text).toContain("自分より後に作成されマージ済み   : 1 件");
    expect(text).toContain("参考サンプル（マージ日時順）:");
    expect(text).toContain("採用サンプル     : 3 件");
    expect(text).toContain("サンプルが少ないため");
  });

  test("マージ済みサンプルの初回提出者を常連から分離し、GraphQL で累計マージ数を照会してキャッシュ・スナップショットに記録する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-first-timer-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");
    const snapshotPath = join(tmpDir, "latest-progress.json");

    try {
      let graphqlCalled = false;
      let graphqlQuery = "";

      const client = {
        ...buildClient(),
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          if (num === 400) {
            return {
              number: 400,
              title: "Merged PR 400",
              url: "https://github.com/test/repo/pull/400",
              state: "MERGED" as const,
              isDraft: false,
              createdAt: "2026-10-20T00:00:00Z",
              updatedAt: "2026-10-24T00:00:00Z",
              mergedAt: "2026-10-24T00:00:00Z",
              closedAt: null,
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
              commits: [
                {
                  oid: "oid400",
                  messageHeadline: "feat",
                  committedDate: "2026-10-20T00:00:00Z",
                },
              ],
              author: "repeatUser",
            };
          }
          if (num === 450) {
            return {
              number: 450,
              title: "Merged PR 450",
              url: "https://github.com/test/repo/pull/450",
              state: "MERGED" as const,
              isDraft: false,
              createdAt: "2026-10-25T00:00:00Z",
              updatedAt: "2026-10-26T00:00:00Z",
              mergedAt: "2026-10-26T00:00:00Z",
              closedAt: null,
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
              commits: [
                {
                  oid: "oid450",
                  messageHeadline: "feat",
                  committedDate: "2026-10-25T00:00:00Z",
                },
              ],
              author: "repeatUser", // 同一バッチ内で2回登場
            };
          }
          if (num === 600) {
            return {
              number: 600,
              title: "Merged PR 600",
              url: "https://github.com/test/repo/pull/600",
              state: "MERGED" as const,
              isDraft: false,
              createdAt: "2026-11-02T00:00:00Z",
              updatedAt: "2026-11-03T00:00:00Z",
              mergedAt: "2026-11-03T00:00:00Z",
              closedAt: null,
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
              commits: [
                {
                  oid: "oid600",
                  messageHeadline: "feat",
                  committedDate: "2026-11-02T00:00:00Z",
                },
              ],
              author: "firstTimerUser", // 単発
            };
          }
          throw new Error(`Unexpected PR #${num}`);
        },
        graphql: async (query: string) => {
          graphqlCalled = true;
          graphqlQuery = query;
          return {
            u_0: { issueCount: 1 },
          };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          snapshotPath,
        },
        client,
        (m) => logs.push(m),
      );

      expect(graphqlCalled).toBeTrue();
      expect(graphqlQuery).toContain("firstTimerUser");
      expect(graphqlQuery).not.toContain("repeatUser");

      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      expect(snapshot?.FirstTimerMedianDays).not.toBeNull();

      const samples = snapshot?.Samples ?? [];
      const ftSample = samples.find((s) => s.Number === 600);
      const repeatSample = samples.find((s) => s.Number === 400);

      expect(ftSample?.IsFirstTimer).toBeTrue();
      expect(repeatSample?.IsFirstTimer).toBeFalse();

      // キャッシュファイルへの保存検証
      expect(existsSync(cachePath)).toBeTrue();
      const cacheEntries = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached600 = cacheEntries.find((e) => e.Number === 600);
      expect(cached600?.Type).toBe("sample");
      if (cached600?.Type === "sample") {
        expect(cached600.Author).toBe("firstTimerUser");
        expect(cached600.IsFirstTimer).toBeTrue();
      }

      const text = logs.join("\n");
      expect(text).toContain("初回提出者コホート実績");
      expect(text).toContain("うち初回提出者による追い越し   : 1 件");
      expect(text).toContain("うち常連・特急レーンによる追い越し: 0 件");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("1コミット・累計マージ1件でも途中で阻害ラベル履歴があるPRは初期健康体から除外され isFirstTimer: false となる", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-blocked-history-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      let graphqlCalled = false;
      const client = {
        ...buildClient(),
        getIssueTimeline: async (_repo: string, num: number) => {
          if (num === 500) {
            return [
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
            ];
          }
          // PR 600: 途中で Error-TestFailure が付与され、その後解除された
          return [
            {
              event: "labeled",
              created_at: "2026-10-01T01:00:00Z",
              label: { name: "New-Package" },
            },
            {
              event: "labeled",
              created_at: "2026-10-01T01:00:00Z",
              label: { name: "Azure-Pipeline-Passed" },
            },
            {
              event: "labeled",
              created_at: "2026-10-01T01:00:00Z",
              label: { name: "Validation-Completed" },
            },
            {
              event: "labeled",
              created_at: "2026-10-02T01:00:00Z",
              label: { name: "Error-TestFailure" },
            },
            {
              event: "unlabeled",
              created_at: "2026-10-30T01:00:00Z",
              label: { name: "Error-TestFailure" },
            },
          ];
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          return {
            number: num,
            title: `Merged PR ${num}`,
            url: `https://github.com/test/repo/pull/${num}`,
            state: "MERGED" as const,
            isDraft: false,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-11-01T00:00:00Z",
            mergedAt: "2026-11-01T00:00:00Z",
            closedAt: null,
            labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
            commits: [
              { oid: `oid${num}`, messageHeadline: "feat", committedDate: "2026-10-01T00:00:00Z" },
            ],
            author: "userWithBlockedHistory",
          };
        },
        graphql: async () => {
          graphqlCalled = true;
          return { u_0: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli({ ...options, cachePath }, client, (m) =>
        logs.push(m),
      );

      // 阻害履歴があるため候補から除外され、GraphQL 一括照会も行われない
      expect(graphqlCalled).toBeFalse();
      expect(snapshot?.FirstTimerSampleCount).toBe(0);
      const s600 = snapshot?.Samples.find((s) => s.Number === 600);
      expect(s600?.IsFirstTimer).toBeFalse();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("1コミット・累計マージ1件でもDraft履歴（converted_to_draft や ready_for_review）があるPRは初期健康体から除外される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-draft-history-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      let graphqlCalled = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 2,
              items: [600, 601].map((n) => ({
                number: n,
                title: `Merged ${n}`,
                html_url: `https://github.com/test/repo/pull/${n}`,
                created_at: "2026-10-01T00:00:00Z",
                updated_at: "2026-11-01T00:00:00Z",
                labels,
                is_draft: false,
                pull_request: { merged_at: "2026-11-01T00:00:00Z" },
              })),
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getIssueTimeline: async (_repo: string, num: number) => {
          if (num === 500) {
            return [
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
            ];
          }
          if (num === 600) {
            // 途中で converted_to_draft → ready_for_review
            return [
              {
                event: "labeled",
                created_at: "2026-10-01T01:00:00Z",
                label: { name: "New-Package" },
              },
              {
                event: "labeled",
                created_at: "2026-10-01T01:00:00Z",
                label: { name: "Azure-Pipeline-Passed" },
              },
              {
                event: "labeled",
                created_at: "2026-10-01T01:00:00Z",
                label: { name: "Validation-Completed" },
              },
              {
                event: "converted_to_draft",
                created_at: "2026-10-02T01:00:00Z",
              },
              {
                event: "ready_for_review",
                created_at: "2026-10-15T01:00:00Z",
              },
            ];
          }
          // PR 601: 最初から Draft で起票され、後に ready_for_review のみ発生
          return [
            {
              event: "labeled",
              created_at: "2026-10-01T01:00:00Z",
              label: { name: "New-Package" },
            },
            {
              event: "labeled",
              created_at: "2026-10-01T01:00:00Z",
              label: { name: "Azure-Pipeline-Passed" },
            },
            {
              event: "labeled",
              created_at: "2026-10-01T01:00:00Z",
              label: { name: "Validation-Completed" },
            },
            {
              event: "ready_for_review",
              created_at: "2026-10-10T01:00:00Z",
            },
          ];
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          return {
            number: num,
            title: `Merged PR ${num}`,
            url: `https://github.com/test/repo/pull/${num}`,
            state: "MERGED" as const,
            isDraft: false,
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-11-01T00:00:00Z",
            mergedAt: "2026-11-01T00:00:00Z",
            closedAt: null,
            labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
            commits: [
              { oid: `oid${num}`, messageHeadline: "feat", committedDate: "2026-10-01T00:00:00Z" },
            ],
            author: `draftUser${num}`,
          };
        },
        graphql: async () => {
          graphqlCalled = true;
          return { u_0: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli({ ...options, cachePath }, client, (m) =>
        logs.push(m),
      );

      // Draft 履歴があるため候補から除外され、GraphQL 一括照会も行われない
      expect(graphqlCalled).toBeFalse();
      expect(snapshot?.FirstTimerSampleCount).toBe(0);
      const s600 = snapshot?.Samples.find((s) => s.Number === 600);
      expect(s600?.IsFirstTimer).toBeFalse();
      const s601 = snapshot?.Samples.find((s) => s.Number === 601);
      expect(s601?.IsFirstTimer).toBeFalse();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("旧形式キャッシュ（Author/IsFirstTimer欠落）が存在する場合に未判定として正しく分離され常連に誤合算されない", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-legacy-cache-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const legacyEntry1 = {
        Type: "sample",
        Number: 600,
        Title: "Legacy PR 600",
        CreatedAt: "2026-11-02T00:00:00.000Z",
        LatestCommittedDate: "2026-11-02T00:00:00.000Z",
        CommitCount: 1,
        ReadyAt: "2026-11-02T01:00:00.000Z",
        MergedAt: "2026-11-03T00:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      const legacyEntry2 = {
        Type: "sample",
        Number: 601,
        Title: "Legacy PR 601",
        CreatedAt: "2026-11-02T00:00:00.000Z",
        LatestCommittedDate: "2026-11-02T00:00:00.000Z",
        CommitCount: 1,
        ReadyAt: "2026-11-02T01:00:00.000Z",
        MergedAt: "2026-11-03T01:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      const legacyEntry3 = {
        Type: "sample",
        Number: 602,
        Title: "Legacy PR 602",
        CreatedAt: "2026-11-02T00:00:00.000Z",
        LatestCommittedDate: "2026-11-02T00:00:00.000Z",
        CommitCount: 1,
        ReadyAt: "2026-11-02T01:00:00.000Z",
        MergedAt: "2026-11-03T02:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      const legacyMultiCommit = {
        Type: "sample",
        Number: 450,
        Title: "Legacy PR 450",
        CreatedAt: "2026-10-25T00:00:00.000Z",
        LatestCommittedDate: "2026-10-25T00:00:00.000Z",
        CommitCount: 2,
        ReadyAt: "2026-10-25T01:00:00.000Z",
        MergedAt: "2026-10-26T00:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      writeFileSync(
        cachePath,
        `${JSON.stringify(legacyEntry1)}\n${JSON.stringify(legacyEntry2)}\n${JSON.stringify(legacyEntry3)}\n${JSON.stringify(legacyMultiCommit)}\n`,
        "utf-8",
      );

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 4,
              items: [450, 600, 601, 602].map((n) => ({
                number: n,
                title: `Merged ${n}`,
                html_url: `https://github.com/test/repo/pull/${n}`,
                created_at: n === 450 ? "2026-10-25T00:00:00Z" : "2026-11-02T00:00:00Z",
                updated_at: "2026-11-03T00:00:00Z",
                labels: [
                  { name: "New-Package" },
                  { name: "Azure-Pipeline-Passed" },
                  { name: "Validation-Completed" },
                ],
                is_draft: false,
                pull_request: { merged_at: "2026-11-03T00:00:00Z" },
              })),
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          throw new Error(`Unexpected PR #${num}`);
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        { ...options, cachePath, fetchBudget: 0 },
        client,
        (m) => logs.push(m),
      );

      // PR 600, 601, 602 は自分より後に作成された未判定サンプル
      expect(snapshot?.Comparison?.LaterCreated).toBe(3);
      expect(snapshot?.Comparison?.FirstTimerLaterCreated).toBe(0);
      expect(snapshot?.Comparison?.RepeatOrExpressLaterCreated).toBe(0); // 常連に誤合算されない！
      expect(snapshot?.Comparison?.UnknownLaterCreated).toBe(3); // 未判定に計上される！

      // PR 450 は commitCount > 1 のため IsFirstTimer: false に自動確定される
      const s450 = snapshot?.Samples.find((s) => s.Number === 450);
      expect(s450?.IsFirstTimer).toBeFalse();

      const text = logs.join("\n");
      expect(text).toContain("うち未判定による追い越し       : 3 件");
      expect(text).not.toContain("すべて常連・特急レーンによるもので"); // 誤って常連のみと断定しない！
      expect(text).toContain("確定した初回提出者による追い越しはありません）。");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("サンプルが 1 件もないときは比較不能と明示し、比較系は空にする", async () => {
    const client = buildClient();
    const original = client.searchIssuesDetailed.bind(client);
    client.searchIssuesDetailed = (async (query: string, ...rest: unknown[]) => {
      if (query.includes("is:merged")) return { totalCount: 0, items: [] };
      return (original as (q: string, ...r: unknown[]) => Promise<GitHubDetailedSearchResult>)(
        query,
        ...rest,
      );
    }) as typeof client.searchIssuesDetailed;

    const logs: string[] = [];
    const { snapshot } = await runProgressCli(options, client, (m) => logs.push(m));

    expect(logs.join("\n")).toContain("比較可能なサンプルがありませんでした。");
    expect(snapshot?.SampleCount).toBe(0);
    expect(snapshot?.Samples).toEqual([]);
    expect(snapshot?.Comparison).toBeNull();
    expect(snapshot?.Guidance).toBeNull();
  });

  test("全体実績（30日窓）と初回提出者コホート（90日窓）がハイブリッド集計される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-obs-hybrid-lookback-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    // 15日前（30日窓内、初回）
    const merged15d = new Date(now.getTime() - 15 * dayMs).toISOString();
    // 50日前（30日窓外・90日窓内、初回）
    const merged50d = new Date(now.getTime() - 50 * dayMs).toISOString();
    // 5日前（30日窓内、常連）
    const merged5d = new Date(now.getTime() - 5 * dayMs).toISOString();

    const cacheEntries: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 101,
        MergedAt: merged15d,
        CreatedAt: new Date(now.getTime() - 17 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 17 * dayMs).toISOString(),
        CommitCount: 1,
        ReadyAt: new Date(now.getTime() - 16 * dayMs).toISOString(),
        TotalDays: 2.0,
        TurnDays: 2.0,
        ReadyDays: 1.0,
        Title: "Sample 101 (FirstTimer 15d)",
        Author: "author-first1",
        IsFirstTimer: true,
      },
      {
        Type: "sample",
        Number: 102,
        MergedAt: merged50d,
        CreatedAt: new Date(now.getTime() - 55 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 55 * dayMs).toISOString(),
        CommitCount: 1,
        ReadyAt: new Date(now.getTime() - 52 * dayMs).toISOString(),
        TotalDays: 5.0,
        TurnDays: 5.0,
        ReadyDays: 2.0,
        Title: "Sample 102 (FirstTimer 50d)",
        Author: "author-first2",
        IsFirstTimer: true,
      },
      {
        Type: "sample",
        Number: 103,
        MergedAt: merged5d,
        CreatedAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 6 * dayMs).toISOString(),
        CommitCount: 2,
        ReadyAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
        TotalDays: 1.0,
        TurnDays: 1.0,
        ReadyDays: 1.0,
        Title: "Sample 103 (Repeat 5d)",
        Author: "author-repeat",
        IsFirstTimer: false,
      },
    ];
    writeFileSync(cachePath, serializeSampleCacheEntries(cacheEntries), "utf-8");

    try {
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 3,
              items: [
                {
                  number: 103,
                  title: "Sample 103",
                  html_url: "u103",
                  created_at: new Date(now.getTime() - 6 * dayMs).toISOString(),
                  updated_at: merged5d,
                  labels,
                  is_draft: false,
                  pull_request: { merged_at: merged5d },
                },
                {
                  number: 101,
                  title: "Sample 101",
                  html_url: "u101",
                  created_at: new Date(now.getTime() - 17 * dayMs).toISOString(),
                  updated_at: merged15d,
                  labels,
                  is_draft: false,
                  pull_request: { merged_at: merged15d },
                },
                {
                  number: 102,
                  title: "Sample 102",
                  html_url: "u102",
                  created_at: new Date(now.getTime() - 55 * dayMs).toISOString(),
                  updated_at: merged50d,
                  labels,
                  is_draft: false,
                  pull_request: { merged_at: merged50d },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
          fetchBudget: 0,
        },
        client,
        (m) => logs.push(m),
      );

      // 全体サンプルの検証（30日窓）: 101 と 103 のみ採用（2件）
      expect(snapshot?.LookbackDays).toBe(30);
      expect(snapshot?.SampleCount).toBe(2);
      expect(snapshot?.Samples.map((s) => s.Number).sort()).toEqual([101, 103]);

      // 初回提出者コホートの検証（90日窓）: 101 と 102 の両方が採用（2件）
      expect(snapshot?.FirstTimerLookbackDays).toBe(90);
      expect(snapshot?.FirstTimerSampleCount).toBe(2);
      expect(snapshot?.FirstTimerMedianDays).toBe(3.5); // (2.0 + 5.0) / 2 = 3.5

      // ログに「過去 90 日間」が明記されていること
      const logText = logs.join("\n");
      expect(logText).toContain(
        "[初回提出者コホート実績 (過去 90 日間・1コミット・単発・累計マージ1件: 2件)]",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("キャッシュなしで取得予算を超えて保留（deferred）された候補は SkippedCount に誤混入しない", async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const merged5d = new Date(now.getTime() - 5 * dayMs).toISOString();
    const merged10d = new Date(now.getTime() - 10 * dayMs).toISOString();

    // 候補 PR が 2 件（#201, #202）存在
    const client = {
      ...buildClient(),
      graphql: async () => ({}),
      searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
        if (query.includes("is:merged")) {
          return {
            totalCount: 2,
            items: [
              {
                number: 201,
                title: "PR 201",
                html_url: "u201",
                created_at: new Date(now.getTime() - 7 * dayMs).toISOString(),
                updated_at: merged5d,
                labels,
                is_draft: false,
                pull_request: { merged_at: merged5d },
              },
              {
                number: 202,
                title: "PR 202",
                html_url: "u202",
                created_at: new Date(now.getTime() - 12 * dayMs).toISOString(),
                updated_at: merged10d,
                labels,
                is_draft: false,
                pull_request: { merged_at: merged10d },
              },
            ],
          };
        }
        return (
          buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
        )(query);
      },
      getPullRequestDetails: async (_repo: string, num: number) => ({
        number: num,
        title: `PR ${num}`,
        url: `https://github.com/test/repo/pull/${num}`,
        state: "OPEN" as const,
        isDraft: false,
        createdAt: new Date(now.getTime() - 7 * dayMs).toISOString(),
        updatedAt: merged5d,
        mergedAt: null,
        closedAt: null,
        labels: labels.map((l) => l.name),
        commits: [{ oid: "abc", messageHeadline: "fix", committedDate: merged5d }],
        author: "author-test",
      }),
      getIssueTimeline: async () =>
        labels.map((l) => ({
          event: "labeled",
          created_at: new Date(now.getTime() - 6 * dayMs).toISOString(),
          label: { name: l.name },
        })),
    } as unknown as GitHubApiClient;

    const logs: string[] = [];
    // fetchBudget: 1 のため、#201 を取得した時点で予算上限となり #202 は保留（deferred）される
    const { snapshot } = await runProgressCli(
      {
        ...options,
        fetchBudget: 1,
        lookbackDays: 30,
        firstTimerLookbackDays: 90,
      },
      client,
      (m) => logs.push(m),
    );

    // 採用 1 件、保留 1 件、除外は 0 件であること（保留分が SkippedCount に誤算入されない）
    expect(snapshot?.SampleCount).toBe(1);
    expect(snapshot?.SkippedCount).toBe(0);
    const logText = logs.join("\n");
    expect(logText).toContain("採用 1 件・除外 0 件");
    expect(logText).toContain("未取得の候補 1 件は次回以降に取得します");
  });

  test("一部キャッシュ済みで取得予算を超えて保留された場合も、実際の除外判定のみが SkippedCount に計上される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-obs-deferred-skipped-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const merged3d = new Date(now.getTime() - 3 * dayMs).toISOString();
    const merged6d = new Date(now.getTime() - 6 * dayMs).toISOString();
    const merged10d = new Date(now.getTime() - 10 * dayMs).toISOString();

    // キャッシュには #301（採用サンプル）と #302（除外サンプル: no-ready）がある
    const cacheEntries: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 301,
        MergedAt: merged3d,
        CreatedAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 5 * dayMs).toISOString(),
        CommitCount: 1,
        ReadyAt: new Date(now.getTime() - 4 * dayMs).toISOString(),
        TotalDays: 2.0,
        TurnDays: 2.0,
        ReadyDays: 1.0,
        Title: "Sample 301",
        Author: "author-301",
        IsFirstTimer: true,
      },
      {
        Type: "skipped",
        Number: 302,
        MergedAt: merged6d,
        Reason: "no-ready",
      },
    ];
    writeFileSync(cachePath, serializeSampleCacheEntries(cacheEntries), "utf-8");

    try {
      // 候補には #301, #302 に加え、未キャッシュの #303 が存在する
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 3,
              items: [
                {
                  number: 301,
                  title: "PR 301",
                  html_url: "u301",
                  created_at: new Date(now.getTime() - 5 * dayMs).toISOString(),
                  updated_at: merged3d,
                  labels,
                  is_draft: false,
                  pull_request: { merged_at: merged3d },
                },
                {
                  number: 302,
                  title: "PR 302",
                  html_url: "u302",
                  created_at: new Date(now.getTime() - 8 * dayMs).toISOString(),
                  updated_at: merged6d,
                  labels,
                  is_draft: false,
                  pull_request: { merged_at: merged6d },
                },
                {
                  number: 303,
                  title: "PR 303",
                  html_url: "u303",
                  created_at: new Date(now.getTime() - 12 * dayMs).toISOString(),
                  updated_at: merged10d,
                  labels,
                  is_draft: false,
                  pull_request: { merged_at: merged10d },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      // fetchBudget: 0 のため、未キャッシュの #303 は保留（deferred）される
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 0,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        (m) => logs.push(m),
      );

      // 採用 1 件（#301）、除外 1 件（#302 のみ）、保留 1 件（#303）
      expect(snapshot?.SampleCount).toBe(1);
      expect(snapshot?.SkippedCount).toBe(1); // #303 は保留なので SkippedCount は 2 にならず 1 のまま！
      const logText = logs.join("\n");
      expect(logText).toContain("採用 1 件・除外 1 件");
      expect(logText).toContain("未取得の候補 1 件は次回以降に取得します");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("マージ済み候補の走査で日付窓スライス分割クエリが発行され、30日超の非初回候補は詳細取得をスキップして除外記録される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-slice-filter-test-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;
      const labels = REQUIRED_LABELS.map((name) => ({ name }));

      const searchQueries: string[] = [];
      const detailFetchedPrs: number[] = [];
      const timelineFetchedPrs: number[] = [];

      // 45日前（30日超）の PR:
      // #501: 2コミット（非初回候補 -> スキップされるべき）
      // #502: 1コミット・クリーン（初回候補 -> 詳細取得されるべき）
      // #503: 1コミット・常連author（author: frequent, 同一期間に2件 -> スキップされるべき）
      // #504: 1コミット・常連author（author: frequent, 同一期間に2件 -> スキップされるべき）
      const merged45d = new Date(now.getTime() - 45 * dayMs).toISOString();

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          searchQueries.push(query);
          if (query.includes("is:merged") && !query.includes("created:<")) {
            // スライス分割クエリ（merged:ISO..ISO）が使われていること
            expect(query).toMatch(/merged:\d{4}-\d{2}-\d{2}T.*..\d{4}-\d{2}-\d{2}T/);

            return {
              totalCount: 4,
              items: [
                {
                  number: 501,
                  title: "PR 501 (2 commits)",
                  html_url: "u501",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  labels,
                  is_draft: false,
                  author: "user-501",
                  commitCount: 2, // 2コミット -> 非初回
                  pull_request: { merged_at: merged45d },
                },
                {
                  number: 502,
                  title: "PR 502 (1 commit, first timer)",
                  html_url: "u502",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  labels,
                  is_draft: false,
                  author: "first-timer-user",
                  commitCount: 1, // 1コミット -> 初回候補！
                  pull_request: { merged_at: merged45d },
                },
                {
                  number: 503,
                  title: "PR 503 (frequent author)",
                  html_url: "u503",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  labels,
                  is_draft: false,
                  author: "frequent-user",
                  commitCount: 1,
                  pull_request: { merged_at: merged45d },
                },
                {
                  number: 504,
                  title: "PR 504 (frequent author)",
                  html_url: "u504",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  labels,
                  is_draft: false,
                  author: "frequent-user",
                  commitCount: 1,
                  pull_request: { merged_at: merged45d },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, prNumber: number) => {
          detailFetchedPrs.push(prNumber);
          const isTarget = prNumber === options.targetPr;
          return {
            number: prNumber,
            title: `PR ${prNumber}`,
            url: `https://github.com/microsoft/winget-pkgs/pull/${prNumber}`,
            state: (isTarget ? "OPEN" : "MERGED") as "OPEN" | "MERGED",
            isDraft: false,
            createdAt: new Date(now.getTime() - 50 * dayMs).toISOString(),
            updatedAt: merged45d,
            mergedAt: isTarget ? null : merged45d,
            closedAt: null,
            author: "first-timer-user",
            commits: [
              {
                committedDate: new Date(now.getTime() - 50 * dayMs).toISOString(),
                oid: "abc1234",
              },
            ],
            labels: REQUIRED_LABELS,
          };
        },
        getIssueTimeline: async (_repo: string, prNumber: number) => {
          timelineFetchedPrs.push(prNumber);
          return REQUIRED_LABELS.map((name) => ({
            event: "labeled",
            created_at: new Date(now.getTime() - 48 * dayMs).toISOString(),
            label: { name },
          }));
        },
        graphql: async <T>() => {
          return {
            u_0: { issueCount: 1 },
          } as unknown as T;
        },
      } as unknown as GitHubApiClient;

      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 100,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        () => {},
      );

      // 詳細・タイムライン API が呼ばれたのは 自PR(#500) と候補中では #502 のみであること！
      // #501（2コミット）と #503, #504（常連author）は詳細フェッチをスキップ！
      expect(detailFetchedPrs).toEqual([500, 502]);
      expect(timelineFetchedPrs).toEqual([500, 502]);

      // スナップショットの確認:
      // #502 は45日前（30日超）のため全体窓 SampleCount には入らず、初回コホート FirstTimerSampleCount に採用されること
      expect(snapshot?.SampleCount).toBe(0);
      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      // 30日以内の除外ではないため全体 SkippedCount は 0
      expect(snapshot?.SkippedCount).toBe(0);

      // キャッシュファイルの内容を確認: スキップされた PR が not-first-timer-candidate として記録されていること
      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const skippedEntries = savedCache.filter((e) => e.Type === "skipped");
      expect(skippedEntries).toHaveLength(3);
      for (const entry of skippedEntries) {
        expect(entry.Reason).toBe("not-first-timer-candidate");
      }
      expect(skippedEntries.map((e) => e.Number).sort()).toEqual([501, 503, 504]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
