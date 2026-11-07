import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient } from "../../src/api/github";
import { parseArgs, resolveDefaultDataDir, runExploreDepths } from "../../src/cli/explore-depths";
import { buildHealthyBaseQuery } from "../../src/domain/depths";
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
      expect(snapshot.ExpressLane.length).toBe(1);

      // 4 つのクエリが発行されたこと（Healthy, Absolute, Stale, Express）
      expect(searchQueries.length).toBe(4);

      // 出力ファイルの検証
      expect(existsSync(outputPath)).toBe(true);
      const savedJson = JSON.parse(readFileSync(outputPath, "utf-8"));
      expect(savedJson.TargetPr.Number).toBe(464302);

      expect(existsSync(historyPath)).toBe(true);
      const lines = readFileSync(historyPath, "utf-8").trim().split("\n");
      expect(lines.length).toBe(1);
      const savedLine = JSON.parse(lines[0]);
      expect(savedLine.Repository).toBe("microsoft/winget-pkgs");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("parseArgs は不正な引数や欠落、フラグの誤消費を厳格に拒否する", () => {
    // 1. --target-pr に数値以外を指定した場合
    expect(() => parseArgs(["--target-pr", "abc"])).toThrow(
      "--target-pr に無効な値が指定されました: abc",
    );
    expect(() => parseArgs(["--target-pr", "-1"])).toThrow();

    // 2. 引数の値が欠落している場合
    expect(() => parseArgs(["--target-pr"])).toThrow(
      "--target-pr オプションには正の整数の値が必要です",
    );
    expect(() => parseArgs(["--repository"])).toThrow(
      "--repository オプションにはリポジトリ名 (owner/repo) の値が必要です",
    );
    expect(() => parseArgs(["--output-path"])).toThrow(
      "--output-path オプションにはファイルパスが必要です",
    );

    // 3. 値を取るフラグの直後に別のフラグが来て誤消費されるケース
    expect(() => parseArgs(["--output-path", "--no-history"])).toThrow(
      "--output-path オプションにはファイルパスが必要です",
    );
    expect(() => parseArgs(["--target-pr", "--no-target-pr"])).toThrow(
      "--target-pr オプションには正の整数の値が必要です",
    );

    // 4. 未知のオプション
    expect(() => parseArgs(["--unknown-flag"])).toThrow(
      "未知の引数が指定されました: --unknown-flag",
    );
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
      // Healthy, Absolute, Stale の 3 クエリのみ（Express は実行されない）
      expect(searchQueries.length).toBe(3);
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

describe("CLI: explore-depths の放置の底", () => {
  test("放置の底は更新が最も古い健康な PR を上位 10 件取得し、progress と同じ健康条件で検索する", async () => {
    const calls: { query: string; sort: string; order: string; perPage: number }[] = [];
    const mockClient = {
      searchIssues: async (
        query: string,
        sort: string,
        order: string,
        perPage: number,
      ): Promise<GitHubSearchItem[]> => {
        calls.push({ query, sort, order, perPage });
        return [];
      },
    } as unknown as GitHubApiClient;

    await runExploreDepths(
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

    const stale = calls.find((c) => c.sort === "updated" && c.order === "asc");
    expect(stale?.perPage).toBe(10);
    expect(stale?.query).toBe(buildHealthyBaseQuery("microsoft/winget-pkgs"));
    // 健康条件は progress 側と同じ定義（阻害・調査中ラベルをすべて除外）を使う
    expect(stale?.query).toContain('-label:"Validation-SmartScreen"');
    expect(stale?.query).toContain('-label:"Testing"');
  });
});
