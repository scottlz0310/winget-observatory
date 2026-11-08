import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { downloadMetricsFiles, parseArgs } from "../scripts/sync-dropbox";

describe("sync-dropbox CLI credentials validation", () => {
  const scriptPath = resolve(__dirname, "../scripts/sync-dropbox.ts");

  test.each([
    {
      name: "--allow-skip がない場合は非ゼロ終了 (exit 1) する",
      extraArgs: [] as string[],
      expectedExitCode: 1,
      stream: "stderr" as const,
      expectedMessage:
        "DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN の環境変数を設定してください",
    },
    {
      name: "--allow-skip が指定された場合は正常終了 (exit 0) する",
      extraArgs: ["--allow-skip"],
      expectedExitCode: 0,
      stream: "stdout" as const,
      expectedMessage: "同期をスキップします",
    },
  ])(
    "資格情報が未設定で $name",
    async ({ extraArgs, expectedExitCode, stream, expectedMessage }) => {
      const proc = Bun.spawn(["bun", "run", scriptPath, "--direction", "upload", ...extraArgs], {
        env: {
          ...process.env,
          DROPBOX_APP_KEY: "",
          DROPBOX_APP_SECRET: "",
          DROPBOX_REFRESH_TOKEN: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      const output = await new Response(proc[stream]).text();

      expect(exitCode).toBe(expectedExitCode);
      expect(output).toContain(expectedMessage);
    },
  );
});

describe("downloadMetricsFiles with legacy fallback", () => {
  test("新パス優先および旧パスへのフォールバック取得が正常に動作する", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-sync-test-"));
    const requestedPaths: string[] = [];

    const mockClient = {
      download: async (path: string): Promise<string | undefined> => {
        requestedPaths.push(path);
        // 新パス /data/ に存在するファイル
        if (path === "/data/progress-history.csv") {
          return "timestamp,pr\n2026-11-07,123\n";
        }
        // 新パスにはなく、旧パス /winget-observatory/ にのみ存在するファイル
        if (path === "/winget-observatory/depths-history.jsonl") {
          return '{"time":"2026-11-07","pr":456}\n';
        }
        // どちらにも存在しないファイル
        return undefined;
      },
    };

    try {
      const summary = await downloadMetricsFiles(
        mockClient,
        tempDir,
        ["progress-history.csv", "depths-history.jsonl", "latest-progress.json"],
        () => {},
      );

      // progress-history.csv は新パスから取得
      expect(summary.downloaded).toEqual(["progress-history.csv"]);
      expect(readFileSync(join(tempDir, "progress-history.csv"), "utf-8")).toBe(
        "timestamp,pr\n2026-11-07,123\n",
      );

      // depths-history.jsonl は新パスが undefined で旧パスからフォールバック取得
      expect(summary.fallback).toEqual(["depths-history.jsonl"]);
      expect(readFileSync(join(tempDir, "depths-history.jsonl"), "utf-8")).toBe(
        '{"time":"2026-11-07","pr":456}\n',
      );

      // latest-progress.json は両方存在せずスキップ
      expect(summary.skipped).toEqual(["latest-progress.json"]);

      // 要求されたパス順序の確認
      expect(requestedPaths).toContain("/data/progress-history.csv");
      expect(requestedPaths).toContain("/data/depths-history.jsonl");
      expect(requestedPaths).toContain("/winget-observatory/depths-history.jsonl");
      expect(requestedPaths).toContain("/data/latest-progress.json");
      expect(requestedPaths).toContain("/winget-observatory/latest-progress.json");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("sync-dropbox parseArgs", () => {
  test.each([
    [["--direction", "upload"], { direction: "upload", dryRun: false, allowSkip: false }],
    [
      ["--direction", "download", "--dry-run", "--allow-skip"],
      { direction: "download", dryRun: true, allowSkip: true },
    ],
  ])("正しい引数 %j を解釈する", (args, expected) => {
    expect(parseArgs(args, "/work")).toMatchObject(expected);
  });

  test("--data-dir は cwd 基準で解決する", () => {
    expect(parseArgs(["--direction", "upload", "--data-dir", "out"], "/work").dataDir).toBe(
      resolve("/work", "out"),
    );
  });

  test.each([
    [[], "--direction オプション"],
    [["--direction"], "--direction オプションには値が必要です"],
    [["--direction", "--dry-run"], "--direction オプションには値が必要です"],
    [["--direction", "sync"], "無効な direction: sync"],
    [["--direction", "upload", "--data-dir"], "--data-dir オプションには値が必要です"],
    [["--direction", "upload", "--unknown"], "未知のオプションです: --unknown"],
  ])("不正な引数 %j は暗黙の upload にせず拒否する", (args, message) => {
    expect(() => parseArgs(args, "/work")).toThrow(message);
  });
});
