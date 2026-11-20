import { resolve } from "node:path";
import { GitHubApiClient } from "../api/github";
import { DAY_MS, formatDateTimeWithDay, formatDelta, round2 } from "../domain/formatters";
import { REQUIRED_LABELS } from "../domain/labels";
import {
  calculateProgressStats,
  createProgressSnapshot,
  partitionSamplesByWindow,
} from "../domain/progress";
import { QUEUE_BASIS } from "../domain/progress-csv";
import {
  formatFrontDeltaText,
  logBenchmark,
  logRivals,
  reportSkippedObservation,
} from "../domain/progress-format";
import {
  DEFAULT_METADATA_REFRESH_BUDGET,
  DEFAULT_SAMPLE_CACHE_RETENTION_DAYS,
  indexSampleCache,
  pruneSampleCache,
  summarizeSampleCacheVersions,
} from "../domain/sample-cache";
import {
  orchestrateSampleCollection,
  refreshLegacyAuthorMetadata,
} from "../domain/sample-collector";
import { collectMergedCandidatesWithStatus } from "../domain/search-window";
import type { ProgressHistoryRow, ProgressQueueInfo, ProgressSnapshot } from "../models/progress";
import {
  DEFAULT_REPOSITORY,
  parseBoundedInt,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultDataDir,
  resolveDefaultTargetPr,
} from "./args";
import {
  collectOpenQueueInfo,
  fetchAndValidateTargetPr,
  fetchExitCounts,
  loadTargetHistory,
  type ProgressCliOptions,
  readSampleCache,
  saveProgressOutputs,
  saveSampleCache,
} from "./progress-io";

export type { ProgressCliOptions };
export { resolveDefaultDataDir };

export function parseArgs(argv: string[]): ProgressCliOptions {
  let targetPr = resolveDefaultTargetPr();
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let lookbackDays = 30;
  let firstTimerLookbackDays = 90;
  let fetchBudget = 300;
  let fetchLimit = 5000;
  let metadataRefreshBudget = DEFAULT_METADATA_REFRESH_BUDGET;
  let cacheRetentionDays = DEFAULT_SAMPLE_CACHE_RETENTION_DAYS;
  let logPath: string | undefined = process.env.WINGET_LOG_PATH;
  let snapshotPath: string | undefined = process.env.WINGET_SNAPSHOT_PATH;
  let cachePath: string | undefined = process.env.WINGET_CACHE_PATH;
  let noLog = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target-pr") {
      targetPr = parseTargetPrArg(readOptionValue(argv, i++, "正の整数の値"));
    } else if (arg === "--repository" || arg === "--repo") {
      repository = readOptionValue(argv, i++, "リポジトリ名 (owner/repo) の値");
    } else if (arg === "--lookback-days") {
      lookbackDays = parseBoundedInt(readOptionValue(argv, i++), "lookback-days", 1, 365);
    } else if (arg === "--first-timer-lookback-days") {
      firstTimerLookbackDays = parseBoundedInt(
        readOptionValue(argv, i++),
        "first-timer-lookback-days",
        1,
        365,
      );
    } else if (arg === "--fetch-budget") {
      fetchBudget = parseBoundedInt(readOptionValue(argv, i++), "fetch-budget", 1, 1000);
    } else if (arg === "--fetch-limit") {
      fetchLimit = parseBoundedInt(readOptionValue(argv, i++), "fetch-limit", 1, 10000);
    } else if (arg === "--metadata-refresh-budget") {
      metadataRefreshBudget = parseBoundedInt(
        readOptionValue(argv, i++),
        "metadata-refresh-budget",
        0,
        1000,
      );
    } else if (arg === "--cache-retention-days") {
      cacheRetentionDays = parseBoundedInt(
        readOptionValue(argv, i++),
        "cache-retention-days",
        0,
        3650,
      );
    } else if (arg === "--log-path") {
      logPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--snapshot-path") {
      snapshotPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--cache-path") {
      cachePath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--no-log") {
      noLog = true;
    } else if (arg === "--as-json") {
      asJson = true;
    } else {
      throw new Error(`未知のオプションです: ${arg}`);
    }
  }

  return {
    targetPr,
    repository,
    lookbackDays,
    firstTimerLookbackDays,
    fetchBudget,
    fetchLimit,
    metadataRefreshBudget,
    cacheRetentionDays,
    logPath,
    snapshotPath,
    cachePath,
    noLog,
    asJson,
  };
}

/**
 * 現在のレビュー待ち行列のサマリーを前回比デルタ付きでログ出力する。
 */
function logQueueSummary(
  queueInfo: ProgressQueueInfo,
  prevRecord: ProgressHistoryRow | null,
  log: (msg: string) => void,
): void {
  log("");
  log("----------------------------------------");
  log("【現在のレビュー待ち行列（実質的な待ち人数）】");

  // 算出基準が異なる履歴との前回比は出さない。
  const prev = prevRecord && prevRecord.QueueBasis === QUEUE_BASIS ? prevRecord : null;
  const front = queueInfo.front;
  const prevFrontNum = prev && prev.FrontNumber !== "" ? Number(prev.FrontNumber) : undefined;
  const frontDeltaText = formatFrontDeltaText(front.number, prevFrontNum);
  const deltaOf = (current: number, previous: number | string | undefined): string =>
    prev && previous !== undefined && previous !== ""
      ? ` ${formatDelta(current, Number(previous))}`
      : "";

  log(
    `健康的大底（最古の健康なPR）: #${front.number} (作成: ${formatDateTimeWithDay(front.createdAt)})${frontDeltaText}`,
  );
  log(
    `実質待ちPR（更新順の順位）  : 約 ${queueInfo.activeAheadCount} 件${deltaOf(queueInfo.activeAheadCount, prev?.ActiveAhead)} （あなたのPRより更新が古い健康なPR。指摘なく順番待ちしているPR）`,
  );
  log(
    `全期間の累積待ちPR (参考) : 約 ${queueInfo.aheadCount} 件${deltaOf(queueInfo.aheadCount, prev?.TotalAhead)} （作成順であなたより前の健康なPR）`,
  );
  log(
    `あなたの後ろに並ぶ準備完了PR: 約 ${queueInfo.behindCount} 件${deltaOf(queueInfo.behindCount, prev?.Behind)}`,
  );
  log("----------------------------------------");
}

export async function runProgressCli(
  options: ProgressCliOptions,
  client: GitHubApiClient = new GitHubApiClient(),
  log: (msg: string) => void = console.log,
): Promise<{ snapshot: ProgressSnapshot | null }> {
  const now = options.now ?? new Date();
  log(`=== ${options.repository} PR #${options.targetPr} ===`);

  const targetContext = await fetchAndValidateTargetPr(options, client, now, log);
  if (!targetContext) {
    return { snapshot: null };
  }

  const { pr, created, commitCount, totalLifetimeDays, turnLatencyDays, targetReady, waitDays } =
    targetContext;

  const defaultDataDir = resolveDefaultDataDir();
  const historyCsvPath = options.logPath
    ? resolve(process.cwd(), options.logPath)
    : resolve(defaultDataDir, "progress-history.csv");
  const prevRecord = loadTargetHistory(historyCsvPath, options.targetPr);

  const queueInfo = await collectOpenQueueInfo(
    client,
    options.repository,
    options.targetPr,
    created,
    pr.updatedAt,
  );

  // 過去マージ済み PR のサンプリング（全体用と初回提出者用で探索窓が異なるため、大きい方を基準に広めに取得する）
  const firstTimerLookbackDays = options.firstTimerLookbackDays ?? 90;
  const maxLookbackDays = Math.max(options.lookbackDays, firstTimerLookbackDays);
  const sinceDate = new Date(now.getTime() - maxLookbackDays * DAY_MS);
  const overallSinceDate = new Date(now.getTime() - options.lookbackDays * DAY_MS);

  const candidateScan = await collectMergedCandidatesWithStatus({
    client,
    repository: options.repository,
    since: sinceDate,
    until: now,
    targetPr: options.targetPr,
    requiredLabels: REQUIRED_LABELS,
    fetchLimit: options.fetchLimit,
  });
  const candidates = candidateScan.items;

  const rawCache = options.cachePath ? readSampleCache(options.cachePath) : [];
  const {
    samples,
    skippedCandidates,
    skippedCount: skipped,
    fetchedCount: fetched,
    deferredCount: deferred,
    finalCache,
  } = await orchestrateSampleCollection({
    client,
    repository: options.repository,
    candidates,
    overallSinceDate,
    fetchBudget: options.fetchBudget,
    initialCache: rawCache,
    onCacheUpdated: (entries) => {
      if (options.cachePath) {
        saveSampleCache(options.cachePath, entries);
      }
    },
  });

  if (options.cachePath) {
    const scannedCandidateNumbers = new Set(candidates.map((c) => c.number));
    const scanComplete = candidateScan.complete && candidates.length > 0;
    const retentionDays = options.cacheRetentionDays ?? DEFAULT_SAMPLE_CACHE_RETENTION_DAYS;
    const pruned = pruneSampleCache(finalCache, {
      now,
      retentionDays,
      scannedCandidateNumbers,
      scanComplete,
      scanSinceDate: sinceDate,
    });
    const cacheIndex = indexSampleCache(pruned.entries);
    const refreshBudget = options.metadataRefreshBudget ?? DEFAULT_METADATA_REFRESH_BUDGET;
    const refreshResult = await refreshLegacyAuthorMetadata({
      cacheIndex,
      samples,
      client,
      repository: options.repository,
      now,
      windowDays: maxLookbackDays,
      budget: refreshBudget,
    });

    const latestEntries = Array.from(cacheIndex.values());
    if (pruned.ttlRemovedCount > 0 || pruned.staleRemovedCount > 0 || refreshResult.cacheModified) {
      saveSampleCache(options.cachePath, latestEntries);
    }
    const cacheSummary = summarizeSampleCacheVersions(latestEntries, {
      now,
      windowDays: maxLookbackDays,
    });
    if (
      pruned.ttlRemovedCount > 0 ||
      pruned.staleRemovedCount > 0 ||
      refreshResult.updatedCount > 0
    ) {
      log(
        `キャッシュ自己修復 : TTL削除 ${pruned.ttlRemovedCount} 件・検索外旧版削除 ${pruned.staleRemovedCount} 件・軽量メタデータ補完 ${refreshResult.updatedCount} 件（うち特権/Bot降格 ${refreshResult.privilegedDemotedCount} 件）`,
      );
    }
    log(
      `キャッシュ世代     : 全 ${cacheSummary.totalUnique} 件（最新: ${cacheSummary.currentCount} / 中間版: ${cacheSummary.intermediateCount} / 要再計測旧版: ${cacheSummary.legacyBeforeReadyCount} / skipped: ${cacheSummary.skippedCount} / 直近${maxLookbackDays}日 補完待ち: ${cacheSummary.windowRefreshRemainingCount} 件）`,
    );
  }

  log(
    `サンプル         : 採用 ${samples.length} 件・除外 ${skipped} 件（キャッシュ ${samples.length + skipped - fetched} 件を再利用、今回の新規取得 ${fetched} 件／予算 ${options.fetchBudget} 件）`,
  );
  if (deferred > 0) {
    log(
      `  取得予算に達したため、未取得の候補 ${deferred} 件は次回以降に取得します（統計は取得済みの分で計算）`,
    );
  }

  logQueueSummary(queueInfo, prevRecord, log);

  const { mergedOlder, closedOlder } = await fetchExitCounts(
    client,
    options.repository,
    created,
    log,
  );

  // 全体実績（既定 30 日窓）と初回提出者コホート（既定 90 日窓）でサンプルを分離して統計計算
  const { overallSamples, overallSkippedCount, firstTimerSamples } = partitionSamplesByWindow({
    samples,
    skippedCandidates,
    now,
    lookbackDays: options.lookbackDays,
    firstTimerLookbackDays,
  });

  const stats = calculateProgressStats(overallSamples, overallSkippedCount);
  const firstTimerStats =
    firstTimerSamples.length > 0 ? calculateProgressStats(firstTimerSamples) : null;
  const frontCreatedVal = formatDateTimeWithDay(queueInfo.front.createdAt);

  const snapshot = createProgressSnapshot({
    now,
    repository: options.repository,
    targetPr: options.targetPr,
    prTitle: pr.title,
    prUrl: pr.url,
    prState: pr.state,
    frontNumber: queueInfo.front.number,
    frontCreatedAt: frontCreatedVal,
    activeAhead: queueInfo.activeAheadCount,
    totalAhead: queueInfo.aheadCount,
    behind: queueInfo.behindCount,
    totalLifetimeDays,
    turnLatencyDays,
    waitDays,
    commitCount,
    stats,
    lookbackDays: options.lookbackDays,
    skippedCount: overallSkippedCount,
    rivals: queueInfo.rivals,
    samples: overallSamples,
    targetCreatedAt: created,
    targetReadyAt: targetReady,
    firstTimerStats,
    firstTimerSampleCount: firstTimerSamples.length,
    firstTimerSamples,
    firstTimerLookbackDays,
  });

  logRivals(queueInfo.rivals, log);
  logBenchmark(snapshot, options, { totalLifetimeDays, turnLatencyDays, waitDays }, log);

  if (options.asJson) {
    log(JSON.stringify(snapshot, null, 2));
  }

  if (!options.noLog) {
    saveProgressOutputs({
      historyCsvPath,
      defaultDataDir,
      snapshotPath: options.snapshotPath,
      logRow: {
        Timestamp: formatDateTimeWithDay(now),
        TargetPr: options.targetPr,
        FrontNumber: queueInfo.front.number,
        FrontCreatedAt: frontCreatedVal,
        ActiveAhead: queueInfo.activeAheadCount,
        TotalAhead: queueInfo.aheadCount,
        QueueBasis: QUEUE_BASIS,
        Behind: queueInfo.behindCount,
        TotalLifetimeDays: round2(totalLifetimeDays),
        TurnLatencyDays: round2(turnLatencyDays),
        WaitDays: round2(waitDays),
        CommitCount: commitCount,
        MergedOlder: mergedOlder,
        ClosedOlder: closedOlder,
      },
      snapshot,
    });
  }

  return { snapshot };
}

/**
 * レート制限の残量を診断ログとして出す。
 * 診断のための補助なので、取得に失敗しても計測の成否には影響させず、警告として見える形で残す。
 */
export async function logRateLimit(
  client: Pick<GitHubApiClient, "getRateLimit">,
  log: (msg: string) => void = console.log,
): Promise<void> {
  try {
    const rate = await client.getRateLimit();
    const fmt = (name: string, b: { limit: number; remaining: number; resetAt: string | null }) =>
      `${name}: 残り ${b.remaining} / ${b.limit}（使用 ${b.limit - b.remaining}）${b.resetAt ? ` リセット ${b.resetAt}` : ""}`;
    log(`[RateLimit] ${fmt("GraphQL", rate.graphql)}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`::warning::レート制限の残量を取得できませんでした: ${message}`);
  }
}

// 直接実行時のエントリポイント
if (import.meta.main) {
  const client = new GitHubApiClient();
  try {
    const options = parseArgs(process.argv.slice(2));
    const { snapshot } = await runProgressCli(options, client);
    reportSkippedObservation(snapshot, process.env);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`エラー: ${message}`);
    process.exitCode = 1;
  } finally {
    // 失敗（レート制限超過を含む）したときこそ残量が診断に役立つため、成否にかかわらず出す
    await logRateLimit(client);
  }
  if (process.exitCode) process.exit(process.exitCode);
}
