import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient } from "../../src/api/github";
import { parseArgs, runExploreDepths } from "../../src/cli/explore-depths";
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
});
