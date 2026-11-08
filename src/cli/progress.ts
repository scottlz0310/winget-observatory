import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient, type GitHubDetailedSearchItem } from "../api/github";
import { describeGuidance, describeOvertake } from "../domain/benchmark";
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
  fromCachedSample,
  indexSampleCache,
  parseSampleCache,
  serializeSampleCacheEntries,
  toCachedSample,
} from "../domain/sample-cache";
import type {
  MergedCandidateSample,
  ProgressHistoryRow,
  ProgressQueueInfo,
  ProgressRivalPr,
  ProgressSnapshot,
  ReferenceGuidance,
} from "../models/progress";
import type { SampleCacheEntry } from "../models/sample-cache";
import {
  DEFAULT_REPOSITORY,
  parseBoundedInt,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultTargetPr,
} from "./args";

export interface ProgressCliOptions {
  targetPr: number;
  repository: string;
  lookbackDays: number;
  /** 1 回の実行で新規に取得するマージ済み PR の上限（キャッシュ済みの分は数えない） */
  fetchBudget: number;
  fetchLimit: number;
  /** マージ済み PR のサンプルキャッシュ（JSONL）。省略時はキャッシュを使わない */
  cachePath?: string;
  logPath?: string;
  snapshotPath?: string;
  noLog: boolean;
  asJson: boolean;
}

export function parseArgs(argv: string[]): ProgressCliOptions {
  let targetPr = resolveDefaultTargetPr();
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let lookbackDays = 30;
  let fetchBudget = 100;
  let fetchLimit = 1000;
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
    } else if (arg === "--fetch-budget") {
      fetchBudget = parseBoundedInt(readOptionValue(argv, i++), "fetch-budget", 1, 100);
    } else if (arg === "--fetch-limit") {
      fetchLimit = parseBoundedInt(readOptionValue(argv, i++), "fetch-limit", 1, 1000);
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

/** 末尾が改行で終わっていないファイルにも、行が連結しないよう追記する */
function appendSampleCache(path: string, entries: SampleCacheEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const needsBreak = existing.length > 0 && !existing.endsWith("\n");
  appendFileSync(path, `${needsBreak ? "\n" : ""}${serializeSampleCacheEntries(entries)}`, "utf-8");
}

export function resolveDefaultDataDir(baseDir: string = import.meta.dirname): string {
  return resolve(baseDir, "../../data");
}

export async function runProgressCli(
  options: ProgressCliOptions,
  client: GitHubApiClient = new GitHubApiClient(),
  log: (msg: string) => void = console.log,
): Promise<{ snapshot: ProgressSnapshot | null }> {
  const now = new Date();
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

  // 過去マージ済み PR のサンプリング
  const sinceDate = new Date(now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();

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
  const mergedQuery = [
    `repo:${options.repository}`,
    "is:pr",
    "is:merged",
    `merged:>=${sinceIso}`,
    ...REQUIRED_LABELS.map((l) => `label:"${l}"`),
  ].join(" ");

  const candidates: GitHubDetailedSearchItem[] = [];
  const perPage = 100;
  let page = 1;
  const maxPages = Math.ceil(options.fetchLimit / perPage);

  while (candidates.length < options.fetchLimit && page <= maxPages) {
    const mergedRes = await client.searchIssuesDetailed(
      mergedQuery,
      "updated",
      "desc",
      perPage,
      page,
    );
    if (!mergedRes.items || mergedRes.items.length === 0) {
      break;
    }
    for (const item of mergedRes.items) {
      if (item.number !== options.targetPr && item.pull_request?.merged_at) {
        candidates.push(item);
        if (candidates.length >= options.fetchLimit) {
          break;
        }
      }
    }
    if (mergedRes.items.length < perPage) {
      break;
    }
    page++;
  }

  candidates.sort(
    (a, b) =>
      new Date(b.pull_request?.merged_at ?? b.updated_at).getTime() -
      new Date(a.pull_request?.merged_at ?? a.updated_at).getTime(),
  );

  const samples: MergedCandidateSample[] = [];
  let skipped = 0;

  const cacheIndex = options.cachePath
    ? indexSampleCache(readSampleCache(options.cachePath))
    : new Map<number, SampleCacheEntry>();
  const newEntries: SampleCacheEntry[] = [];
  let fetched = 0;
  let deferred = 0;

  try {
    // 新しくマージされた順。キャッシュ済みは API を使わずに採用し、未取得の候補は予算の範囲で取得する
    for (const cand of candidates) {
      const cached = cacheIndex.get(cand.number);
      if (cached) {
        if (cached.Type === "sample") {
          samples.push(fromCachedSample(cached));
        } else {
          skipped++;
        }
        continue;
      }
      if (fetched >= options.fetchBudget) {
        deferred++;
        continue;
      }
      fetched++;

      try {
        const mergedAtStr = cand.pull_request?.merged_at ?? cand.updated_at;
        const mergedAt = new Date(mergedAtStr);
        const candTimeline = await client.getIssueTimeline(options.repository, cand.number);

        const readyAt = simulateReadySince(candTimeline, Boolean(cand.is_draft), mergedAt);
        if (!readyAt) {
          skipped++;
          newEntries.push({
            Type: "skipped",
            Number: cand.number,
            MergedAt: mergedAt.toISOString(),
            Reason: "no-ready",
          });
          continue;
        }

        const readyDays = (mergedAt.getTime() - readyAt.getTime()) / (1000 * 60 * 60 * 24);
        if (readyDays < 0) {
          skipped++;
          newEntries.push({
            Type: "skipped",
            Number: cand.number,
            MergedAt: mergedAt.toISOString(),
            Reason: "negative-ready",
          });
          continue;
        }

        const candDetail = await client.getPullRequestDetails(options.repository, cand.number);
        const candCreatedAt = new Date(candDetail.createdAt);
        const candCommits = candDetail.commits;
        const candLatestCommit =
          candCommits.length > 0 ? candCommits[candCommits.length - 1] : null;
        const candLatestCommittedDate = candLatestCommit
          ? new Date(candLatestCommit.committedDate)
          : candCreatedAt;

        const totalDays = (mergedAt.getTime() - candCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
        const turnDays =
          (mergedAt.getTime() - candLatestCommittedDate.getTime()) / (1000 * 60 * 60 * 24);

        const sample: MergedCandidateSample = {
          number: cand.number,
          title: cand.title,
          createdAt: candDetail.createdAt,
          latestCommittedDate: candLatestCommittedDate.toISOString(),
          commitCount: candCommits.length,
          readyAt: readyAt.toISOString(),
          mergedAt: mergedAt.toISOString(),
          totalDays: Number(totalDays.toFixed(2)),
          turnDays: Number(turnDays.toFixed(2)),
          days: Number(readyDays.toFixed(2)),
        };
        samples.push(sample);
        newEntries.push(toCachedSample(sample));
      } catch (err: unknown) {
        // 一部だけ欠けた統計は誤った比較値になるため、握りつぶさず中断する
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`マージ済み PR #${cand.number} のサンプル計測に失敗しました: ${msg}`, {
          cause: err,
        });
      }
    }
  } finally {
    // マージ済み PR の履歴は後から変わらないので、途中で失敗しても取得済みの分は保存し、次回の再取得を避ける
    if (options.cachePath && newEntries.length > 0) {
      appendSampleCache(options.cachePath, newEntries);
    }
  }

  log(
    `サンプル         : 採用 ${samples.length} 件・除外 ${skipped} 件（キャッシュ ${samples.length + skipped - newEntries.length} 件を再利用、今回の新規取得 ${fetched} 件／予算 ${options.fetchBudget} 件）`,
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
  let frontDeltaText = "";
  if (prev && prev.FrontNumber !== "") {
    const prevFrontNum = Number(prev.FrontNumber);
    const frontDiff = front.number - prevFrontNum;
    if (frontDiff > 0) {
      frontDeltaText = ` [前回 #${prevFrontNum} から +${frontDiff} 件前進]`;
    } else if (frontDiff === 0) {
      frontDeltaText = " [前回から変動なし]";
    } else {
      frontDeltaText = ` [前回 #${prevFrontNum}]`;
    }
  }
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

  const stats = calculateProgressStats(samples, skipped);

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
    skippedCount: skipped,
    rivals,
    samples,
    targetCreatedAt: created,
    targetReadyAt: targetReady,
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

function logRivals(rivals: ProgressRivalPr[], log: (msg: string) => void): void {
  if (rivals.length === 0) return;
  log("");
  log(`直前のライバルPR（あなたの直前に並んでいるPR TOP ${rivals.length}）:`);
  for (const r of rivals) {
    log(
      `  #${r.number}  起票: ${formatDateTimeWithDay(r.createdAt)} / 更新: ${formatDateTimeWithDay(r.updatedAt)}  ${r.title}`,
    );
  }
}

/** 過去のマージ実績との比較（統計・位置づけ・追い越し・サンプル一覧）を出力する */
function logBenchmark(
  snapshot: ProgressSnapshot,
  options: ProgressCliOptions,
  current: { totalLifetimeDays: number; turnLatencyDays: number; waitDays: number },
  log: (msg: string) => void,
): void {
  log("----------------------------------------");
  log(`比較対象         : 過去 ${options.lookbackDays} 日間のマージ済みPR`);
  log(`採用サンプル     : ${snapshot.SampleCount} 件`);
  log(`条件不成立で除外 : ${snapshot.SkippedCount} 件`);

  const { Guidance: guidance, Comparison: comparison } = snapshot;
  if (snapshot.SampleCount === 0 || !guidance || !comparison) {
    log("比較可能なサンプルがありませんでした。");
    return;
  }

  const block = (
    title: string,
    median: number | null,
    p75: number | null,
    max: number | null,
    currentDays: number,
    note = "",
  ): void => {
    log(title);
    log(
      `   中央値: ${formatHumanDays(median ?? 0)} | 75%点: ${formatHumanDays(p75 ?? 0)} | 最大: ${formatHumanDays(max ?? 0)}`,
    );
    log(`   あなたの待機 : ${formatHumanDays(currentDays)}${note}`);
  };

  log("");
  log("【過去実績との統計比較】");
  block(
    "1. 通算日数 (Total Lifetime: 作成→マージ)",
    snapshot.TotalMedianDays,
    snapshot.TotalP75Days,
    snapshot.TotalMaxDays,
    current.totalLifetimeDays,
  );
  log("");
  block(
    "2. レビュー待ち (Turn Latency: 最新コミット→マージ)",
    snapshot.TurnMedianDays,
    snapshot.TurnP75Days,
    snapshot.TurnMaxDays,
    current.turnLatencyDays,
    snapshot.CommitCount <= 1 ? " [初手から手直しなし]" : "",
  );
  log("");
  block(
    "3. （参考）条件成立後 (ReadyAt→マージ)",
    snapshot.ReadyMedianDays,
    snapshot.ReadyP75Days,
    snapshot.ReadyMaxDays,
    current.waitDays,
  );

  if (snapshot.SampleCount < 10) {
    log("※ サンプルが少ないため、数値は変動しやすくなっています。");
  }

  log("----------------------------------------");
  log("参考目安:");
  const guide = (label: string, g: ReferenceGuidance): void =>
    log(
      `  [${label}] ${describeGuidance(g, formatHumanDays)} （サンプルの ${g.ShorterSharePct}% はこれより短い期間でマージ済み）`,
    );
  guide("レビュー待ち", guidance.Turn);
  guide("通算日数    ", guidance.Total);
  guide("条件成立後  ", guidance.Ready);

  log("");
  log("【条件成立日時の比較（ReadyAt）】");
  log(`  採用サンプル内で、自分より後に条件が整いマージ済み : ${comparison.LaterReady} 件`);
  log("");
  log("【作成日・PR番号の比較（CreatedAt / PR番号）】");
  log(`  自分より後に作成されマージ済み   : ${comparison.LaterCreated} 件`);
  log(`  自分より前に作成されマージ済み   : ${comparison.EarlierCreated} 件`);
  log(`  自分より新しいPR番号 (>${options.targetPr}) : ${comparison.NewerNumber} 件`);
  log(`  自分より古いPR番号   (<${options.targetPr}) : ${comparison.OlderNumber} 件`);
  log(`  ※ ${describeOvertake(comparison)}`);

  log("");
  log("参考サンプル（マージ日時順）:");
  for (const s of snapshot.Samples) {
    const relation = s.Relation === "older" ? "古い  " : "新しい";
    log(
      `  #${s.Number} ${relation} ${s.CommitCount}コミット  レビュー待ち ${s.TurnDays.toFixed(1)}日 / 通算 ${s.TotalDays.toFixed(1)}日 / 成立後 ${s.ReadyDays.toFixed(1)}日  最新コミット ${formatDateTimeWithDay(s.LatestCommittedDate)}  マージ ${formatDateTimeWithDay(s.MergedAt)}`,
    );
  }
  log("※ 待機はラベルとDraftの履歴に基づきます。レビュー本文・チェック履歴は解析しません。");
  log("※ 候補検索は現在の必須ラベルを使うため、マージ後にそれらが外れたPRは含まれません。");
  log("※ 日数差は実績との比較であり、残り待ち時間の予測ではありません。");
}

/**
 * 基準 PR が観測対象外で記録をスキップしたことを、Actions 上で見落とさないよう warning として出力する。
 */
export function reportSkippedObservation(
  snapshot: ProgressSnapshot | null,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = console.log,
): void {
  if (snapshot === null && env.GITHUB_ACTIONS) {
    log(
      "::warning::基準 PR が観測対象外（クローズ済み・Draft・比較条件未達）のため、今回は履歴とスナップショットを記録していません",
    );
  }
}

/**
 * レート制限の残量を診断ログとして出す。呼び出し自体は制限を消費しない。
 * 診断のための補助なので、取得に失敗しても計測の成否には影響させず、警告として見える形で残す。
 */
export async function logRateLimit(
  client: Pick<GitHubApiClient, "getRateLimit">,
  log: (msg: string) => void = console.log,
): Promise<void> {
  try {
    const { core, search } = await client.getRateLimit();
    const fmt = (name: string, b: { limit: number; remaining: number; resetAt: string | null }) =>
      `${name}: 残り ${b.remaining} / ${b.limit}（使用 ${b.limit - b.remaining}）${b.resetAt ? ` リセット ${b.resetAt}` : ""}`;
    log(`[RateLimit] ${fmt("core", core)} / ${fmt("search", search)}`);
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
