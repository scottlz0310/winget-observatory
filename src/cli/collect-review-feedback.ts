#!/usr/bin/env bun
/**
 * 初回提出（New package:）PR のメンテナ差し戻し指摘を GraphQL で収集・分類し、
 * LLM 読込・ナレッジ化向けの JSONL コーパスと Markdown レポートを生成する CLI エントリポイント。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient } from "../api/github";
import { formatJstDateTime } from "../domain/formatters";
import {
  filterReviewFeedbackRecords,
  parseReviewFeedbackCorpus,
  reclassifyReviewFeedbackCorpus,
  serializeReviewFeedbackCorpus,
} from "../domain/review-feedback";
import {
  formatReviewFeedbackMarkdown,
  summarizeReviewFeedback,
} from "../domain/review-feedback-report";
import type {
  CollectReviewFeedbackOptions,
  ReviewFeedbackCorpusEntry,
  ReviewFeedbackPrState,
  ReviewFeedbackRecord,
  ReviewFeedbackStateFilter,
  ReviewFeedbackSummary,
} from "../models/review-feedback";
import {
  DEFAULT_REPOSITORY,
  parseBoundedInt,
  readOptionValue,
  resolveDefaultDataDir,
} from "./args";
import { type FeedbackCollectionStats, orchestrateFeedbackCollection } from "./feedback-collector";

export { resolveDefaultDataDir };

const VALID_STATE_FILTERS: ReadonlySet<string> = new Set(["merged", "open", "closed"]);

function parseCsvList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parseStatesArg(raw: string): ReviewFeedbackStateFilter[] {
  const parts = parseCsvList(raw);
  if (parts.length === 0) {
    throw new Error("--states には merged / open / closed のいずれかを指定してください");
  }
  const unique: ReviewFeedbackStateFilter[] = [];
  for (const part of parts) {
    if (!VALID_STATE_FILTERS.has(part)) {
      throw new Error(
        `--states に無効な値が指定されました: ${part}（merged, open, closed のカンマ区切りで指定してください）`,
      );
    }
    const typed = part as ReviewFeedbackStateFilter;
    if (!unique.includes(typed)) {
      unique.push(typed);
    }
  }
  return unique;
}

export function parseArgs(argv: string[]): CollectReviewFeedbackOptions {
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let lookbackDays = 90;
  let states: ReviewFeedbackStateFilter[] = ["merged"];
  let fetchBudget = 200;
  let fetchLimit = 2000;
  let outputPath: string | undefined = process.env.WINGET_FEEDBACK_OUTPUT_PATH;
  let reportPath: string | undefined = process.env.WINGET_FEEDBACK_REPORT_PATH;
  let noReport = false;
  let noWrite = false;
  let asJson = false;
  let installerTypes: string[] = [];
  let nestedInstallerTypes: string[] = [];
  let portableOnly = false;
  let privilegedOnly = false;
  let firstTimerOnly = false;
  let blockingOnly = false;
  let reclassify = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repository" || arg === "--repo") {
      repository = readOptionValue(argv, i++, "リポジトリ名 (owner/repo) の値");
    } else if (arg === "--lookback-days") {
      lookbackDays = parseBoundedInt(readOptionValue(argv, i++), "lookback-days", 1, 365);
    } else if (arg === "--states") {
      states = parseStatesArg(readOptionValue(argv, i++, "merged/open/closed のカンマ区切り"));
    } else if (arg === "--fetch-budget") {
      fetchBudget = parseBoundedInt(readOptionValue(argv, i++), "fetch-budget", 0, 2000);
    } else if (arg === "--fetch-limit") {
      fetchLimit = parseBoundedInt(readOptionValue(argv, i++), "fetch-limit", 1, 10000);
    } else if (arg === "--output-path") {
      outputPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--report-path") {
      reportPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--installer-type") {
      installerTypes = parseCsvList(readOptionValue(argv, i++, "InstallerType のカンマ区切り"));
    } else if (arg === "--nested-installer-type") {
      nestedInstallerTypes = parseCsvList(
        readOptionValue(argv, i++, "NestedInstallerType のカンマ区切り"),
      );
    } else if (arg === "--portable-only") {
      portableOnly = true;
    } else if (arg === "--privileged-only") {
      privilegedOnly = true;
    } else if (arg === "--first-timer-only") {
      firstTimerOnly = true;
    } else if (arg === "--blocking-only") {
      blockingOnly = true;
    } else if (arg === "--reclassify") {
      reclassify = true;
    } else if (arg === "--no-report") {
      noReport = true;
    } else if (arg === "--no-write") {
      noWrite = true;
    } else if (arg === "--as-json") {
      asJson = true;
    } else {
      throw new Error(`未知のオプションです: ${arg}`);
    }
  }

  return {
    repository,
    lookbackDays,
    states,
    fetchBudget,
    fetchLimit,
    outputPath,
    reportPath,
    noReport,
    noWrite,
    asJson,
    installerTypes,
    nestedInstallerTypes,
    portableOnly,
    privilegedOnly,
    firstTimerOnly,
    blockingOnly,
    reclassify,
  };
}

export function readFeedbackCorpus(path: string): ReviewFeedbackCorpusEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    return parseReviewFeedbackCorpus(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`フィードバックコーパスの読み込みに失敗しました (${path}): ${msg}`, {
      cause: err,
    });
  }
}

export interface RunCollectReviewFeedbackResult {
  summary: ReviewFeedbackSummary;
  records: ReviewFeedbackRecord[];
  allEntries: ReviewFeedbackCorpusEntry[];
  stats: FeedbackCollectionStats;
  markdownReport: string;
}

export async function runCollectReviewFeedback(
  options: CollectReviewFeedbackOptions,
  client: Pick<
    GitHubApiClient,
    "searchIssuesDetailed" | "graphql" | "getRateLimit"
  > = new GitHubApiClient(),
  log: (msg: string) => void = console.log,
): Promise<RunCollectReviewFeedbackResult> {
  const now = options.now ?? new Date();
  const defaultDataDir = resolveDefaultDataDir();
  const resolvedOutputPath = options.outputPath
    ? resolve(process.cwd(), options.outputPath)
    : resolve(defaultDataDir, "review-feedback.jsonl");
  const resolvedReportPath = options.reportPath
    ? resolve(process.cwd(), options.reportPath)
    : resolve(dirname(resolvedOutputPath), "review-feedback-report.md");

  const rawExistingEntries = readFeedbackCorpus(resolvedOutputPath);
  const progressLog = options.asJson ? () => {} : log;

  progressLog(`=== ${options.repository} 初回提出 PR 差し戻し指摘収集 ===`);
  progressLog(
    `対象状態: ${options.states.join(", ")} / 遡及期間: 過去 ${options.lookbackDays} 日 / 取得予算: ${options.fetchBudget} 件`,
  );

  let existingEntries = rawExistingEntries;
  if (options.reclassify && rawExistingEntries.length > 0) {
    const reclassified = reclassifyReviewFeedbackCorpus(rawExistingEntries);
    existingEntries = reclassified.entries;
    progressLog(
      `[Feedback Crawler] オフライン再分類完了: 対象 ${reclassified.stats.totalProcessed} 件 / feedback 維持 ${reclassified.stats.reclassifiedFeedbackCount} 件 / ノイズ降格 ${reclassified.stats.demotedToNoiseOnlyCount} 件 / MERGED 既存スキップ昇格 ${reclassified.stats.upgradedMergedSkippedCount} 件 / 除外コメント ${reclassified.stats.removedFeedbackCommentsCount} 件`,
    );
  }

  const { entries: allEntries, stats } = await orchestrateFeedbackCollection({
    client,
    repository: options.repository,
    states: options.states,
    lookbackDays: options.lookbackDays,
    fetchBudget: options.fetchBudget,
    fetchLimit: options.fetchLimit,
    existingEntries,
    now,
    log: progressLog,
  });

  // コーパス保存（無フィルタの全蓄積エントリを保存し、後から任意の条件で再抽出できるようにする）
  if (!options.noWrite) {
    mkdirSync(dirname(resolvedOutputPath), { recursive: true });
    writeFileSync(resolvedOutputPath, serializeReviewFeedbackCorpus(allEntries), "utf-8");
    progressLog(
      `[Feedback Crawler] コーパス保存完了: ${resolvedOutputPath} (${allEntries.length} 件)`,
    );
  }

  // レポート・集計対象はリポジトリ一致・指定状態一致の feedback レコードにフィルタを適用
  const allowedStates = new Set<ReviewFeedbackPrState>(
    options.states.map((s) => s.toUpperCase() as ReviewFeedbackPrState),
  );
  const normalizedRepo = options.repository.trim().toLowerCase();
  const candidateFeedbackRecords = allEntries.filter(
    (entry): entry is ReviewFeedbackRecord =>
      entry.entryType === "feedback" &&
      entry.repository.trim().toLowerCase() === normalizedRepo &&
      allowedStates.has(entry.state),
  );

  const records = filterReviewFeedbackRecords(candidateFeedbackRecords, {
    installerTypes: options.installerTypes,
    nestedInstallerTypes: options.nestedInstallerTypes,
    portableOnly: options.portableOnly,
    privilegedOnly: options.privilegedOnly,
    firstTimerOnly: options.firstTimerOnly,
    blockingOnly: options.blockingOnly,
  });

  const summary = summarizeReviewFeedback({
    repository: options.repository,
    records,
    generatedAt: now.toISOString(),
  });

  const markdownReport = formatReviewFeedbackMarkdown({
    summary,
    records,
  });

  if (!options.noWrite && !options.noReport) {
    mkdirSync(dirname(resolvedReportPath), { recursive: true });
    writeFileSync(resolvedReportPath, markdownReport, "utf-8");
    progressLog(`[Feedback Crawler] レポート保存完了: ${resolvedReportPath}`);
  }

  if (options.asJson) {
    log(JSON.stringify({ summary, stats, records }, null, 2));
  } else {
    log("");
    log(
      `【集計結果】対象 PR: ${summary.totalFeedbackPrs} 件（ブロッキング: ${summary.blockingPrCount} 件 / 非ブロッキング助言のみ: ${summary.nonBlockingOnlyPrCount} 件 / 指摘 ${summary.totalFeedbackComments} 件 / 作成者返信 ${summary.totalAuthorReplies} 件）`,
    );
    for (const row of summary.categoryRanking) {
      log(`  - ${row.label} (${row.category}): ${row.count} 件 (${row.ratioPercent.toFixed(1)}%)`);
    }
  }

  if (options.fetchBudget > 0 && !options.asJson) {
    try {
      const rateLimit = await client.getRateLimit();
      const resetText = rateLimit.graphql.resetAt
        ? formatJstDateTime(rateLimit.graphql.resetAt)
        : "不明";
      log(
        `[RateLimit] GraphQL 残り ${rateLimit.graphql.remaining}/${rateLimit.graphql.limit} (リセット: ${resetText})`,
      );
    } catch {
      // レート制限照会の失敗は収集結果の成功を妨げない
    }
  }

  return {
    summary,
    records,
    allEntries,
    stats,
    markdownReport,
  };
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runCollectReviewFeedback(options);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`エラー: ${message}`);
    process.exit(1);
  }
}
