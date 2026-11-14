#!/usr/bin/env bun
// data/ 配下のメトリクスから GitHub Pages 向けの静的ダッシュボード HTML をビルドする薄い CLI エントリポイント

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  extractFirstTimerFrontierSamples,
  extractStaleFrontierSamples,
  parseDepthsHistory,
} from "../src/domain/forecast";
import { parseForecastHistory } from "../src/domain/forecast-history";
import { parseCsvRows } from "../src/domain/progress-csv";
import type { FirstTimerFrontierSample, StaleFrontierSample } from "../src/models/forecast";
import type { ForecastHistoryLine } from "../src/models/forecast-history";
import type { ProgressHistoryRow } from "../src/models/progress";
import { generateDashboardHtml } from "./pages/template";
import type { BuildOptions, LatestDepths, LatestProgress } from "./pages/types";

export type { BuildOptions };

function buildError(label: string, path: string, cause: unknown): Error {
  // 破損データのまま空のダッシュボードを公開しないよう、読み込み失敗は中断する
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${label} (${path}) の読み込み・パースに失敗しました: ${msg}`, { cause });
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(2);
  let dataDir = resolve(process.cwd(), "data");
  let outputDir = resolve(process.cwd(), "site");

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--data-dir" && i + 1 < args.length) {
      dataDir = resolve(process.cwd(), args[++i]);
    } else if (arg === "--output-dir" && i + 1 < args.length) {
      outputDir = resolve(process.cwd(), args[++i]);
    }
  }

  return { dataDir, outputDir };
}

function readOptionalParsed<T>(
  filePath: string,
  label: string,
  parser: (raw: string) => T,
  defaultValue: T,
): T {
  if (!existsSync(filePath)) {
    return defaultValue;
  }
  try {
    return parser(readFileSync(filePath, "utf-8"));
  } catch (e) {
    throw buildError(label, filePath, e);
  }
}

/** 観測データ一式を読み込み、静的 HTML ダッシュボードと RAW データを出力先ディレクトリへ書き出す */
export function buildDashboard(options: BuildOptions): { htmlPath: string } {
  const { dataDir, outputDir } = options;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const progress = readOptionalParsed<LatestProgress | null>(
    join(dataDir, "latest-progress.json"),
    "進捗スナップショット",
    (raw) => JSON.parse(raw) as LatestProgress,
    null,
  );

  const depths = readOptionalParsed<LatestDepths | null>(
    join(dataDir, "latest-depths.json"),
    "キュー境界スナップショット",
    (raw) => JSON.parse(raw) as LatestDepths,
    null,
  );

  const csvRows = readOptionalParsed<ProgressHistoryRow[]>(
    join(dataDir, "progress-history.csv"),
    "履歴 CSV",
    parseCsvRows,
    [],
  );

  const { frontierSamples, firstTimerFrontierSamples } = readOptionalParsed<{
    frontierSamples: StaleFrontierSample[];
    firstTimerFrontierSamples: FirstTimerFrontierSample[];
  }>(
    join(dataDir, "depths-history.jsonl"),
    "キュー境界履歴",
    (raw) => {
      const depthsHistory = parseDepthsHistory(raw);
      return {
        frontierSamples: extractStaleFrontierSamples(depthsHistory),
        firstTimerFrontierSamples: extractFirstTimerFrontierSamples(depthsHistory),
      };
    },
    { frontierSamples: [], firstTimerFrontierSamples: [] },
  );

  const forecastHistory = readOptionalParsed<ForecastHistoryLine[]>(
    join(dataDir, "forecast-history.jsonl"),
    "予想履歴",
    parseForecastHistory,
    [],
  );

  const html = generateDashboardHtml({
    progress,
    depths,
    csvRows,
    frontierSamples,
    forecastHistory,
    firstTimerFrontierSamples,
  });
  const htmlPath = join(outputDir, "index.html");
  writeFileSync(htmlPath, html, "utf-8");
  console.log(`[Build Pages] HTML 生成完了: ${htmlPath}`);

  // RAW データファイルを site/data にコピー
  const siteDataDir = join(outputDir, "data");
  if (!existsSync(siteDataDir)) {
    mkdirSync(siteDataDir, { recursive: true });
  }

  const copyTargets = [
    "progress-history.csv",
    "latest-progress.json",
    "latest-depths.json",
    "depths-history.jsonl",
    "forecast-history.jsonl",
  ];

  for (const file of copyTargets) {
    const src = join(dataDir, file);
    const dest = join(siteDataDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  console.log(`[Build Pages] データファイルを ${siteDataDir} へコピー完了`);

  return { htmlPath };
}

if (import.meta.main) {
  try {
    buildDashboard(parseArgs());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Build Pages] エラー: ${message}`);
    process.exit(1);
  }
}
