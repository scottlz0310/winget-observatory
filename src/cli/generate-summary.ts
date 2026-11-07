import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseCsvRows } from "../domain/progress";
import { generateSummaryMarkdown } from "../domain/summary";
import type { DepthsSnapshot } from "../models/depths";
import type { ProgressHistoryRow, ProgressSnapshot } from "../models/progress";
import type { GenerateSummaryOptions } from "../models/summary";

export function parseArgs(argv: string[]): GenerateSummaryOptions {
  let dataDir: string | undefined;
  let outputPath = "SUMMARY.md";
  let targetPr: number | undefined;
  let repository: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--data-dir オプションにはディレクトリパスが必要です");
      }
      dataDir = argv[++i];
    } else if (arg === "--output-path") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--output-path オプションにはファイルパスが必要です");
      }
      outputPath = argv[++i];
    } else if (arg === "--target-pr") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--target-pr オプションには正の整数の値が必要です");
      }
      const val = argv[++i];
      const parsed = Number.parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed <= 0 || !/^\d+$/.test(val)) {
        throw new Error(
          `--target-pr に無効な値が指定されました: ${val}（正の整数を指定してください）`,
        );
      }
      targetPr = parsed;
    } else if (arg === "--repository" || arg === "--repo") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error(`${arg} オプションにはリポジトリ名 (owner/repo) の値が必要です`);
      }
      repository = argv[++i];
    } else {
      throw new Error(`未知のオプションです: ${arg}`);
    }
  }

  return {
    dataDir,
    outputPath,
    targetPr,
    repository,
  };
}

export function resolveDefaultDataDir(baseDir: string = import.meta.dirname): string {
  return resolve(baseDir, "../../data");
}

export function runGenerateSummary(
  options: GenerateSummaryOptions = {},
  log: (msg: string) => void = console.log,
): { markdown: string; outputPath: string } | null {
  const defaultDataDir = resolveDefaultDataDir();
  const dataDir = options.dataDir ? resolve(process.cwd(), options.dataDir) : defaultDataDir;

  const progressJsonPath = resolve(dataDir, "latest-progress.json");
  const depthsJsonPath = resolve(dataDir, "latest-depths.json");
  const csvPath = resolve(dataDir, "progress-history.csv");

  if (!existsSync(progressJsonPath) && !existsSync(depthsJsonPath)) {
    log(`観測データが見つかりません (${dataDir})`);
    return null;
  }

  let progress: ProgressSnapshot | null = null;
  if (existsSync(progressJsonPath)) {
    try {
      progress = JSON.parse(readFileSync(progressJsonPath, "utf-8")) as ProgressSnapshot;
    } catch (e) {
      log(`progress JSON パース失敗: ${e}`);
    }
  }

  let depths: DepthsSnapshot | null = null;
  if (existsSync(depthsJsonPath)) {
    try {
      depths = JSON.parse(readFileSync(depthsJsonPath, "utf-8")) as DepthsSnapshot;
    } catch (e) {
      log(`depths JSON パース失敗: ${e}`);
    }
  }

  let historyRecords: ProgressHistoryRow[] = [];
  if (existsSync(csvPath)) {
    try {
      historyRecords = parseCsvRows(readFileSync(csvPath, "utf-8"));
    } catch (e) {
      log(`CSV パース失敗: ${e}`);
    }
  }

  const markdown = generateSummaryMarkdown({
    progress,
    depths,
    historyRecords,
  });

  const outputPath = options.outputPath
    ? resolve(process.cwd(), options.outputPath)
    : resolve(process.cwd(), "SUMMARY.md");

  const parentDir = dirname(outputPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  try {
    writeFileSync(outputPath, markdown, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`サマリードキュメントの保存に失敗しました (${outputPath}): ${msg}`);
  }

  log(`Summary generated successfully: ${outputPath}`);
  return { markdown, outputPath };
}

// 直接実行時のエントリポイント
if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    runGenerateSummary(options);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`エラー: ${message}`);
    process.exit(1);
  }
}
