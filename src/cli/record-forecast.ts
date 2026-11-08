// 観測のたびに、3 つの仮説の予想日を forecast-history.jsonl へ追記する CLI。
// 基準 PR がマージされていれば、予想ではなくマージ結果を 1 回だけ記録する（答え合わせの材料）。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GitHubApiClient } from "../api/github";
import { selectComparableHistory } from "../domain/dashboard";
import { extractStaleFrontierSamples, parseDepthsHistory } from "../domain/forecast";
import { buildForecastSource, calculateForecastComparison } from "../domain/forecast-comparison";
import {
  findOutcome,
  hasForecastRecord,
  parseForecastHistory,
  toForecastRecord,
} from "../domain/forecast-history";
import { parseCsvRows } from "../domain/progress";
import type { DepthsSnapshot } from "../models/depths";
import type {
  ForecastHistoryLine,
  ForecastOutcomeRecord,
  ForecastRecord,
} from "../models/forecast-history";
import type { ProgressSnapshot } from "../models/progress";
import {
  DEFAULT_REPOSITORY,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultTargetPr,
} from "./args";

export interface RecordForecastOptions {
  targetPr: number;
  repository: string;
  /** メトリクスファイル（latest-*.json、履歴 CSV / JSONL、予想履歴）の置き場 */
  dataDir: string;
}

export type RecordForecastResult =
  | { action: "recorded"; record: ForecastRecord }
  | { action: "outcome"; outcome: ForecastOutcomeRecord }
  | { action: "skipped"; reason: string };

export function resolveDefaultDataDir(baseDir: string = import.meta.dirname): string {
  return resolve(baseDir, "../../data");
}

export function parseArgs(argv: string[]): RecordForecastOptions {
  let targetPr = resolveDefaultTargetPr();
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let dataDir = resolveDefaultDataDir();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target-pr") {
      targetPr = parseTargetPrArg(readOptionValue(argv, i++, "正の整数の値"));
    } else if (arg === "--repository" || arg === "--repo") {
      repository = readOptionValue(argv, i++, "リポジトリ名 (owner/repo) の値");
    } else if (arg === "--data-dir") {
      dataDir = resolve(process.cwd(), readOptionValue(argv, i++, "ディレクトリパス"));
    } else {
      throw new Error(`未知のオプションです: ${arg}`);
    }
  }
  return { targetPr, repository, dataDir };
}

function readJson<T>(label: string, path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}の読み込みに失敗しました (${path}): ${msg}`, { cause: err });
  }
}

function readText<T>(label: string, path: string, parse: (text: string) => T, empty: T): T {
  if (!existsSync(path)) return empty;
  try {
    return parse(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label}の読み込みに失敗しました (${path}): ${msg}`, { cause: err });
  }
}

/** 末尾が改行で終わっていないファイルにも、行が連結しないよう追記する */
function appendJsonLine(path: string, value: ForecastHistoryLine): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const needsBreak = existing.length > 0 && !existing.endsWith("\n");
  appendFileSync(path, `${needsBreak ? "\n" : ""}${JSON.stringify(value)}\n`, "utf-8");
}

export async function runRecordForecast(
  options: RecordForecastOptions,
  client: Pick<GitHubApiClient, "getPullRequestDetails"> = new GitHubApiClient(),
  log: (msg: string) => void = console.log,
): Promise<RecordForecastResult> {
  const { targetPr, repository, dataDir } = options;
  const historyPath = join(dataDir, "forecast-history.jsonl");
  const history = readText("予想履歴", historyPath, parseForecastHistory, []);

  if (findOutcome(history, repository, targetPr)) {
    const reason = `#${targetPr} のマージ結果は記録済みのため、予想を記録しません`;
    log(`[Forecast] ${reason}`);
    return { action: "skipped", reason };
  }

  const pr = await client.getPullRequestDetails(repository, targetPr);

  if (pr.state === "MERGED" && pr.mergedAt) {
    const outcome: ForecastOutcomeRecord = {
      Type: "outcome",
      Timestamp: new Date().toISOString(),
      Repository: repository,
      TargetPr: targetPr,
      MergedAt: new Date(pr.mergedAt).toISOString(),
    };
    appendJsonLine(historyPath, outcome);
    log(`[Forecast] #${targetPr} のマージ結果を記録しました (MergedAt: ${outcome.MergedAt})`);
    return { action: "outcome", outcome };
  }

  if (pr.state !== "OPEN") {
    const reason = `#${targetPr} は未マージのままクローズされているため、予想を記録しません`;
    log(`[Forecast] ${reason}`);
    return { action: "skipped", reason };
  }

  const progressPath = join(dataDir, "latest-progress.json");
  const progress = readJson<Partial<ProgressSnapshot>>("進捗スナップショット", progressPath);
  if (!progress || typeof progress.Timestamp !== "string") {
    throw new Error(
      `進捗スナップショットが見つからないか、観測時刻がありません (${progressPath})。進捗の計測を先に実行してください`,
    );
  }
  if (progress.TargetPr !== targetPr) {
    throw new Error(
      `進捗スナップショットの基準 PR (#${progress.TargetPr}) が対象 (#${targetPr}) と一致しません。古いスナップショットの可能性があります (${progressPath})`,
    );
  }

  if (hasForecastRecord(history, repository, targetPr, progress.Timestamp)) {
    const reason = `観測時刻 ${progress.Timestamp} の予想は記録済みです`;
    log(`[Forecast] ${reason}`);
    return { action: "skipped", reason };
  }

  const depths = readJson<Partial<DepthsSnapshot>>(
    "キュー境界スナップショット",
    join(dataDir, "latest-depths.json"),
  );
  const csvRows = readText("履歴 CSV", join(dataDir, "progress-history.csv"), parseCsvRows, []);
  const frontierSamples = readText(
    "キュー境界履歴",
    join(dataDir, "depths-history.jsonl"),
    (text) => extractStaleFrontierSamples(parseDepthsHistory(text)),
    [],
  );

  const comparison = calculateForecastComparison(
    buildForecastSource({
      progress,
      depths,
      history: selectComparableHistory(csvRows, targetPr),
      frontierSamples,
    }),
  );
  const record = toForecastRecord(comparison, {
    repository,
    targetPr,
    timestamp: progress.Timestamp,
  });
  if (!record) {
    const reason = "予想日を出せる仮説がないため、記録しません";
    log(`[Forecast] ${reason}`);
    return { action: "skipped", reason };
  }

  appendJsonLine(historyPath, record);
  log(
    `[Forecast] 予想日を ${record.Estimates.length} 件記録しました (${record.Estimates.map((e) => `${e.Key}=${e.Date.slice(0, 10)}`).join(", ")})`,
  );
  return { action: "recorded", record };
}

// 直接実行時のエントリポイント
if (import.meta.main) {
  try {
    await runRecordForecast(parseArgs(process.argv.slice(2)));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`エラー: ${message}`);
    process.exit(1);
  }
}
