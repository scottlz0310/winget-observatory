import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  resolveDefaultDataDir,
  runGenerateSummary,
} from "../../src/cli/generate-summary";

describe("CLI: generate-summary parseArgs", () => {
  test("デフォルト値が正しく設定される", () => {
    const opts = parseArgs([]);
    expect(opts.outputPath).toBe("SUMMARY.md");
    expect(opts.dataDir).toBeUndefined();
  });

  test("オプション引数を正しくパースする", () => {
    const opts = parseArgs([
      "--data-dir",
      "custom/data",
      "--output-path",
      "out/SUMMARY.md",
      "--target-pr",
      "12345",
      "--repo",
      "custom/repo",
    ]);

    expect(opts.dataDir).toBe("custom/data");
    expect(opts.outputPath).toBe("out/SUMMARY.md");
    expect(opts.targetPr).toBe(12345);
    expect(opts.repository).toBe("custom/repo");
  });

  test("不正引数や欠落を拒否する", () => {
    expect(() => parseArgs(["--data-dir"])).toThrow("必要です");
    expect(() => parseArgs(["--output-path"])).toThrow("必要です");
    expect(() => parseArgs(["--target-pr", "abc"])).toThrow("無効な値");
    expect(() => parseArgs(["--unknown"])).toThrow("未知のオプション");
  });
});

describe("CLI: resolveDefaultDataDir for summary", () => {
  test("既定の保存先は実行時の cwd ではなくリポジトリルートの data/ を起点に解決する", () => {
    const tempWorkingDir = mkdtempSync(join(tmpdir(), "winget-summary-external-cwd-"));
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

describe("CLI: runGenerateSummary", () => {
  test("データが存在しない場合は null を返し警告を表示する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-summary-empty-"));
    try {
      const logs: string[] = [];
      const res = runGenerateSummary({ dataDir: tmpDir }, (msg) => logs.push(msg));
      expect(res).toBeNull();
      expect(logs.some((l) => l.includes("観測データが見つかりません"))).toBeTrue();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("正常にデータファイルを読み込んで SUMMARY.md を生成する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-summary-valid-"));
    const outputPath = join(tmpDir, "SUMMARY.md");

    try {
      // 模擬データの書き込み
      writeFileSync(
        join(tmpDir, "latest-progress.json"),
        JSON.stringify({
          TargetPr: 464302,
          PrTitle: "Test Summary PR",
          PrUrl: "https://github.com/microsoft/winget-pkgs/pull/464302",
          FrontNumber: 464000,
        }),
        "utf-8",
      );

      const logs: string[] = [];
      const res = runGenerateSummary(
        {
          dataDir: tmpDir,
          outputPath,
        },
        (msg) => logs.push(msg),
      );

      expect(res).not.toBeNull();
      expect(existsSync(outputPath)).toBeTrue();
      const content = readFileSync(outputPath, "utf-8");
      expect(content).toContain("Test Summary PR");
      expect(content).toContain("#464000");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("latest-progress.json の破損時に例外をスローして非ゼロ終了する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-summary-corrupted-progress-"));
    try {
      writeFileSync(join(tmpDir, "latest-progress.json"), "{ invalid json", "utf-8");
      expect(() => runGenerateSummary({ dataDir: tmpDir })).toThrow(
        "読み込み・パースに失敗しました",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("latest-depths.json の破損時に例外をスローして非ゼロ終了する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-summary-corrupted-depths-"));
    try {
      writeFileSync(join(tmpDir, "latest-depths.json"), "{ invalid json", "utf-8");
      expect(() => runGenerateSummary({ dataDir: tmpDir })).toThrow(
        "読み込み・パースに失敗しました",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
