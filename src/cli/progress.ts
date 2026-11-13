import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient } from "../api/github";
import { buildExitCountQueries } from "../domain/exit-breakdown";
import {
  buildHealthyQueryParts,
  calculateProgressStats,
  createProgressSnapshot,
  formatDateTimeWithDay,
  formatDelta,
  formatHumanDays,
  isBlockedLabel,
  parseCsvRows,
  QUEUE_BASIS,
  REQUIRED_LABELS,
  serializeCsvRows,
  simulateReadySince,
} from "../domain/progress";
import {
  formatFrontDeltaText,
  logBenchmark,
  logRivals,
  reportSkippedObservation,
} from "../domain/progress-format";
import { parseSampleCache, serializeSampleCacheEntries } from "../domain/sample-cache";
import { orchestrateSampleCollection } from "../domain/sample-collector";
import { collectMergedCandidates } from "../domain/search-window";
import type {
  ProgressHistoryRow,
  ProgressQueueInfo,
  ProgressRivalPr,
  ProgressSnapshot,
} from "../models/progress";
import type { SampleCacheEntry } from "../models/sample-cache";
import {
  DEFAULT_REPOSITORY,
  parseBoundedInt,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultTargetPr,
} from "./args";

export { reportSkippedObservation };

export interface ProgressCliOptions {
  targetPr: number;
  repository: string;
  lookbackDays: number;
  /** 初回提出者コホートの集計窓（日。省略時は 90） */
  firstTimerLookbackDays?: number;
  /** 1 回の実行で新規に取得するマージ済み PR の上限（キャッシュ済みの分は数えない） */
  fetchBudget: number;
  fetchLimit: number;
  /** マージ済み PR のサンプルキャッシュ（JSONL）。省略時はキャッシュを使わない */
  cachePath?: string;
  logPath?: string;
  snapshotPath?: string;
  noLog: boolean;
  asJson: boolean;
  /** テスト用等で基準時刻を固定する場合に指定 */
  now?: Date;
}

export function parseArgs(argv: string[]): ProgressCliOptions {
  let targetPr = resolveDefaultTargetPr();
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let lookbackDays = 30;
  let firstTimerLookbackDays = 90;
  let fetchBudget = 300;
  let fetchLimit = 5000;
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
    logPath,
    snapshotPath,
    cachePath,
    noLog,
    asJson,
  };
}

function readSampleCache(path: string): SampleCacheEntry[] {
  if (!existsSync(path)) return [];
  try {
    return parseSampleCache(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`サンプルキャッシュの読み込みに失敗しました (${path}): ${msg}`, { cause: err });
  }
}

/** キャッシュファイル全体を保存する（更新・属性補完を永続化する） */
function saveSampleCache(path: string, entries: SampleCacheEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeSampleCacheEntries(entries), "utf-8");
}

export function resolveDefaultDataDir(baseDir: string = import.meta.dirname): string {
  return resolve(baseDir, "../../data");
}

export async function runProgressCli(
  options: ProgressCliOptions,
  client: GitHubApiClient = new GitHubApiClient(),
  log: (msg: string) => void = console.log,
): Promise<{ snapshot: ProgressSnapshot | null }> {
  const now = options.now ?? new Date();
  log(`=== ${options.repository} PR #${options.targetPr} ===`);

  const pr = await client.getPullRequestDetails(options.repository, options.targetPr);
  const created = new Date(pr.createdAt);
  const commits = pr.commits;
  const commitCount = commits.length;
  const latestCommit = commitCount > 0 ? commits[commitCount - 1] : null;
  const latestCommittedDate = latestCommit ? new Date(latestCommit.committedDate) : created;

  const totalLifetimeDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  const turnLatencyDays = (now.getTime() - latestCommittedDate.getTime()) / (1000 * 60 * 60 * 24);

  log(pr.title);
  log(pr.url);
  log(`ステータス                 : ${pr.state}`);
  log(
    `通算待機日数 (Total)       : ${formatHumanDays(totalLifetimeDays)} (起票: ${formatDateTimeWithDay(created)})`,
  );

  if (commitCount <= 1) {
    const deltaCommitCreated =
      Math.abs(created.getTime() - latestCommittedDate.getTime()) / (1000 * 60);
    const diffText =
      deltaCommitCreated >= 1 ? ` (起票と約 ${Math.round(deltaCommitCreated)} 分差)` : "";
    log(
      `レビュー待ち時間 (Turn)    : ${formatHumanDays(turnLatencyDays)} [初手から手直しなし (1コミット)${diffText}]`,
    );
  } else {
    const commitMsg = latestCommit?.messageHeadline ? ` - ${latestCommit.messageHeadline}` : "";
    const shortOid = latestCommit?.oid ? latestCommit.oid.substring(0, 7) : "";
    log(
      `レビュー待ち時間 (Turn)    : ${formatHumanDays(turnLatencyDays)} [最新コミット: ${formatDateTimeWithDay(latestCommittedDate)} (${commitCount} コミット目: ${shortOid}${commitMsg})]`,
    );
  }

  if (pr.state !== "OPEN") {
    const endText = pr.state === "MERGED" ? pr.mergedAt : pr.closedAt;
    const endAt = endText ? new Date(endText) : now;
    const endTotalDays = (endAt.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
    const endTurnDays = (endAt.getTime() - latestCommittedDate.getTime()) / (1000 * 60 * 60 * 24);

    log(`通算所要日数 (作成〜終了)   : ${formatHumanDays(endTotalDays)}`);
    log(`最終ターン所要日数 (最新〜) : ${formatHumanDays(endTurnDays)}`);
    return { snapshot: null };
  }

  const missing = REQUIRED_LABELS.filter((l) => !pr.labels.includes(l));
  const blocking = pr.labels.filter((l) => isBlockedLabel(l));

  if (pr.isDraft || missing.length > 0 || blocking.length > 0) {
    log("");
    log("現在は今回の比較条件を満たしていません。");
    if (pr.isDraft) log("Draft            : はい");
    if (missing.length > 0) log(`不足ラベル       : ${missing.join(", ")}`);
    if (blocking.length > 0) log(`除外ラベル       : ${blocking.join(", ")}`);
    return { snapshot: null };
  }

  log("比較条件                   : 必須3ラベルあり・除外ラベルなし・Draftでない");

  // 対象 PR のタイムライン取得と成立日時特定
  const targetTimeline = await client.getIssueTimeline(options.repository, options.targetPr);
  const targetReady = simulateReadySince(targetTimeline, pr.isDraft, now);

  if (!targetReady) {
    throw new Error("対象PRの条件成立日時を履歴から特定できませんでした。");
  }

  const waitDays = (now.getTime() - targetReady.getTime()) / (1000 * 60 * 60 * 24);
  log(`条件が整った日時 (ReadyAt) : ${formatDateTimeWithDay(targetReady)}`);
  log(`整ってからの待機 (Ready)   : ${formatHumanDays(waitDays)}`);

  // 履歴 CSV の読み込み
  const defaultDataDir = resolveDefaultDataDir();
  const historyCsvPath = options.logPath
    ? resolve(process.cwd(), options.logPath)
    : resolve(defaultDataDir, "progress-history.csv");

  let prevRecord: ProgressHistoryRow | null = null;
  const pastHistory: ProgressHistoryRow[] = [];

  if (existsSync(historyCsvPath)) {
    try {
      const csvText = readFileSync(historyCsvPath, "utf-8");
      const rows = parseCsvRows(csvText);
      for (const rec of rows) {
        if (Number(rec.TargetPr) === options.targetPr) {
          pastHistory.push(rec);
        }
      }
      if (pastHistory.length > 0) {
        prevRecord = pastHistory[pastHistory.length - 1];
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`履歴ファイルの読み込みに失敗しました (${historyCsvPath}): ${msg}`, {
        cause: err,
      });
    }
  }

  // 過去マージ済み PR のサンプリング（全体用と初回提出者用で探索窓が異なるため、大きい方を基準に広めに取得する）
  const firstTimerLookbackDays = options.firstTimerLookbackDays ?? 90;
  const maxLookbackDays = Math.max(options.lookbackDays, firstTimerLookbackDays);
  const sinceDate = new Date(now.getTime() - maxLookbackDays * 24 * 60 * 60 * 1000);

  const baseParts = buildHealthyQueryParts(options.repository);

  // 1. 前線（健康な最古の未マージ PR）と、自 PR より前に並ぶ健康な PR 数
  const createdIso = created.toISOString();
  const eligibleQuery = baseParts.join(" ");

  const frontRes = await client.searchIssuesDetailed(eligibleQuery, "created", "asc", 1);
  const frontItem = frontRes.items[0];
  if (!frontItem) {
    throw new Error("前線（条件を満たす最古の未マージ PR）を検索結果から特定できませんでした。");
  }
  const allTotal = frontRes.totalCount;

  // 作成順での累積待ち
  const aheadQuery = `${eligibleQuery} created:<${createdIso}`;
  const aheadRes = await client.searchIssuesDetailed(aheadQuery, "created", "desc", 15);
  const aheadTotal = aheadRes.totalCount;

  // 実質待ち: 指摘なく順番待ちをしている PR は更新が止まっているため、更新順が実際の待ち順位になる
  const updatedAheadRes = await client.searchIssuesDetailed(
    `${eligibleQuery} updated:<${new Date(pr.updatedAt).toISOString()}`,
    "updated",
    "asc",
    1,
  );
  const activeAheadCount = updatedAheadRes.totalCount;

  // 2. 直前ライバル PR 抽出
  const rivals: ProgressRivalPr[] = [];
  for (const item of aheadRes.items) {
    if (item.number >= options.targetPr) continue;
    const hasBlocked = (item.labels ?? []).some((l) => isBlockedLabel(l.name));
    if (hasBlocked) continue;

    rivals.push({
      number: item.number,
      title: item.title,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      url: item.html_url,
    });
    if (rivals.length >= 5) break;
  }

  // 3. マージ済み候補のサンプリング
  // 全体用集計窓（30日）と初回提出者専用窓（90日）の境界を定義
  const overallSinceDate = new Date(now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000);
  // Search API の 1,000 件制限を回避するため、カーソルスライド方式（最古 merged_at による絶対数区切り）で全量走査
  const candidates = await collectMergedCandidates({
    client,
    repository: options.repository,
    since: sinceDate,
    until: now,
    targetPr: options.targetPr,
    requiredLabels: REQUIRED_LABELS,
    fetchLimit: options.fetchLimit,
  });

  const rawCache = options.cachePath ? readSampleCache(options.cachePath) : [];
  const {
    samples,
    skippedCandidates,
    skippedCount: skipped,
    fetchedCount: fetched,
    deferredCount: deferred,
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

  log(
    `サンプル         : 採用 ${samples.length} 件・除外 ${skipped} 件（キャッシュ ${samples.length + skipped - fetched} 件を再利用、今回の新規取得 ${fetched} 件／予算 ${options.fetchBudget} 件）`,
  );
  if (deferred > 0) {
    log(
      `  取得予算に達したため、未取得の候補 ${deferred} 件は次回以降に取得します（統計は取得済みの分で計算）`,
    );
  }

  const behindCount = Math.max(0, allTotal - aheadTotal - 1);

  const queueInfo: ProgressQueueInfo = {
    front: { number: frontItem.number, createdAt: frontItem.created_at },
    activeAheadCount,
    aheadCount: aheadTotal,
    totalCount: allTotal,
    behindCount,
    rivals,
  };

  log("");
  log("----------------------------------------");
  log("【現在のレビュー待ち行列（実質的な待ち人数）】");

  // 前回行が旧定義（QueueBasis 列なし）の場合、ActiveAhead の定義が異なるため前回比は出さない
  const prev = prevRecord && prevRecord.QueueBasis === QUEUE_BASIS ? prevRecord : null;
  const front = queueInfo.front;
  const prevFrontNum = prev && prev.FrontNumber !== "" ? Number(prev.FrontNumber) : undefined;
  const frontDeltaText = formatFrontDeltaText(front.number, prevFrontNum);
  const deltaOf = (current: number, previous: number | string | undefined): string =>
    prev && previous !== undefined && previous !== ""
      ? ` ${formatDelta(current, Number(previous))}`
      : "";

  log(
    `消化前線（最古の健康なPR）  : #${front.number} (作成: ${formatDateTimeWithDay(front.createdAt)})${frontDeltaText}`,
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

  // 待ち行列からの離脱（基準 PR の起票以降にマージ・クローズされた、起票が基準 PR より前の PR）の累積件数。
  // 実質待ちの減少の内訳（マージ・クローズ・その他）を、観測の間の差から求めるために履歴へ残す
  const exitQueries = buildExitCountQueries(
    options.repository,
    created.toISOString().replace(/\.\d{3}Z$/, "Z"),
    REQUIRED_LABELS,
  );
  const mergedOlder = (await client.searchIssuesDetailed(exitQueries.merged, "updated", "desc", 1))
    .totalCount;
  const closedOlder = (await client.searchIssuesDetailed(exitQueries.closed, "updated", "desc", 1))
    .totalCount;
  log(
    `離脱の累積         : 基準 PR の起票以降に、起票が前の PR がマージ ${mergedOlder} 件・未マージでクローズ ${closedOlder} 件`,
  );

  // 全体実績（既定 30 日窓）と初回提出者コホート（既定 90 日窓）でサンプルを分離して統計計算
  const overallSince = new Date(now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000);
  const overallSamples = samples.filter(
    (s) => new Date(s.mergedAt).getTime() >= overallSince.getTime(),
  );
  const overallSkipped = skippedCandidates.filter(
    (s) => s.mergedAt.getTime() >= overallSince.getTime(),
  ).length;

  const stats = calculateProgressStats(overallSamples, overallSkipped);

  const firstTimerSince = new Date(now.getTime() - firstTimerLookbackDays * 24 * 60 * 60 * 1000);
  const firstTimerCandidateSamples = samples.filter(
    (s) => new Date(s.mergedAt).getTime() >= firstTimerSince.getTime(),
  );
  const firstTimerSamples = firstTimerCandidateSamples.filter((s) => s.isFirstTimer === true);
  const firstTimerStats =
    firstTimerSamples.length > 0 ? calculateProgressStats(firstTimerSamples) : null;
  const firstTimerSampleCount = firstTimerSamples.length;

  const frontCreatedVal = formatDateTimeWithDay(front.createdAt);

  const snapshot = createProgressSnapshot({
    now,
    repository: options.repository,
    targetPr: options.targetPr,
    prTitle: pr.title,
    prUrl: pr.url,
    prState: pr.state,
    frontNumber: front.number,
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
    skippedCount: overallSkipped,
    rivals,
    samples: overallSamples,
    targetCreatedAt: created,
    targetReadyAt: targetReady,
    firstTimerStats,
    firstTimerSampleCount,
    firstTimerLookbackDays,
  });

  logRivals(queueInfo.rivals, log);
  logBenchmark(snapshot, options, { totalLifetimeDays, turnLatencyDays, waitDays }, log);

  if (options.asJson) {
    log(JSON.stringify(snapshot, null, 2));
  }

  // ログ保存
  if (!options.noLog) {
    const logRow: ProgressHistoryRow = {
      Timestamp: formatDateTimeWithDay(now),
      TargetPr: options.targetPr,
      FrontNumber: front.number,
      FrontCreatedAt: frontCreatedVal,
      ActiveAhead: queueInfo.activeAheadCount,
      TotalAhead: queueInfo.aheadCount,
      QueueBasis: QUEUE_BASIS,
      Behind: queueInfo.behindCount,
      TotalLifetimeDays: Number(totalLifetimeDays.toFixed(2)),
      TurnLatencyDays: Number(turnLatencyDays.toFixed(2)),
      WaitDays: Number(waitDays.toFixed(2)),
      CommitCount: commitCount,
      MergedOlder: mergedOlder,
      ClosedOlder: closedOlder,
    };

    const logDir = dirname(historyCsvPath);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    try {
      const existingRows = existsSync(historyCsvPath)
        ? parseCsvRows(readFileSync(historyCsvPath, "utf-8"))
        : [];
      existingRows.push(logRow);
      writeFileSync(historyCsvPath, serializeCsvRows(existingRows), "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`履歴ファイルへの保存に失敗しました (${historyCsvPath}): ${msg}`);
    }

    const resolvedSnapshotPath = options.snapshotPath
      ? resolve(process.cwd(), options.snapshotPath)
      : resolve(defaultDataDir, "latest-progress.json");

    const snapshotDir = dirname(resolvedSnapshotPath);
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }

    try {
      writeFileSync(resolvedSnapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `スナップショットファイルへの保存に失敗しました (${resolvedSnapshotPath}): ${msg}`,
      );
    }
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
