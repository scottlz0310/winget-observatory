import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

describe("downloadMetricsFiles", () => {
  test("/data/ から取得し、存在しないファイルはスキップする（旧パスは参照しない）", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-sync-test-"));
    const requestedPaths: string[] = [];

    const mockClient = {
      download: async (path: string): Promise<string | undefined> => {
        requestedPaths.push(path);
        // 新パス /data/ に存在するファイル
        if (path === "/data/progress-history.csv") {
          return "timestamp,pr\n2026-11-07,123\n";
        }
        // /data/ に存在しないファイル（旧パスに同名があっても取得しない）
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

      // /data/ に無いファイルはスキップし、ローカルにも作らない
      expect(summary.skipped).toEqual(["depths-history.jsonl", "latest-progress.json"]);
      expect(existsSync(join(tempDir, "depths-history.jsonl"))).toBe(false);

      // 要求するのは /data/ 配下のみ
      expect(requestedPaths).toEqual([
        "/data/progress-history.csv",
        "/data/depths-history.jsonl",
        "/data/latest-progress.json",
      ]);
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
