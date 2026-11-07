import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient, type GitHubDetailedSearchItem } from "../api/github";
import {
  buildHealthyQueryParts,
  calculateProgressStats,
  createProgressSnapshot,
  formatDateTimeWithDay,
  formatDelta,
  formatHumanDays,
  isBlockedLabel,
  parseCsvRows,
  REQUIRED_LABELS,
  serializeCsvRows,
  simulateReadySince,
} from "../domain/progress";
import type {
  MergedCandidateSample,
  ProgressHistoryRow,
  ProgressQueueInfo,
  ProgressRivalPr,
  ProgressSnapshot,
} from "../models/progress";

export interface ProgressCliOptions {
  targetPr: number;
  repository: string;
  lookbackDays: number;
  sampleSize: number;
  fetchLimit: number;
  staleDays: number;
  queueLimit: number;
  logPath?: string;
  snapshotPath?: string;
  noLog: boolean;
  asJson: boolean;
}

export function parseArgs(argv: string[]): ProgressCliOptions {
  let targetPr = 464302;
  if (process.env.WINGET_TARGET_PR) {
    const envVal = process.env.WINGET_TARGET_PR;
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isNaN(parsed) || parsed <= 0 || !/^\d+$/.test(envVal)) {
      throw new Error(
        `無効な環境変数 WINGET_TARGET_PR です: ${envVal}（正の整数を指定してください）`,
      );
    }
    targetPr = parsed;
  }

  let repository = process.env.WINGET_REPOSITORY ?? "microsoft/winget-pkgs";
  let lookbackDays = 30;
  let sampleSize = 30;
  let fetchLimit = 1000;
  let staleDays = 14;
  let queueLimit = 500;
  let logPath: string | undefined = process.env.WINGET_LOG_PATH;
  let snapshotPath: string | undefined = process.env.WINGET_SNAPSHOT_PATH;
  let noLog = false;
  let asJson = false;

  const parseBoundedInt = (val: string, name: string, min: number, max: number): number => {
    const parsed = Number.parseInt(val, 10);
    if (Number.isNaN(parsed) || !/^\d+$/.test(val) || parsed < min || parsed > max) {
      throw new Error(
        `--${name} に無効な値が指定されました: ${val}（${min} 以上 ${max} 以下の整数を指定してください）`,
      );
    }
    return parsed;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target-pr") {
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
    } else if (arg === "--lookback-days") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--lookback-days オプションには値が必要です");
      }
      lookbackDays = parseBoundedInt(argv[++i], "lookback-days", 1, 365);
    } else if (arg === "--sample-size") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--sample-size オプションには値が必要です");
      }
      sampleSize = parseBoundedInt(argv[++i], "sample-size", 1, 100);
    } else if (arg === "--fetch-limit") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--fetch-limit オプションには値が必要です");
      }
      fetchLimit = parseBoundedInt(argv[++i], "fetch-limit", 1, 1000);
    } else if (arg === "--stale-days") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--stale-days オプションには値が必要です");
      }
      staleDays = parseBoundedInt(argv[++i], "stale-days", 1, 365);
    } else if (arg === "--queue-limit") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--queue-limit オプションには値が必要です");
      }
      queueLimit = parseBoundedInt(argv[++i], "queue-limit", 50, 1000);
    } else if (arg === "--log-path") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--log-path オプションにはファイルパスが必要です");
      }
      logPath = argv[++i];
    } else if (arg === "--snapshot-path") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--snapshot-path オプションにはファイルパスが必要です");
      }
      snapshotPath = argv[++i];
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
    sampleSize,
    fetchLimit,
    staleDays,
    queueLimit,
    logPath,
    snapshotPath,
    noLog,
    asJson,
  };
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
      `レビュー待ち時間 (Turn)    : ${formatHumanDays(turnLatencyDays)} [最新コミット: ${formatDateTimeWithDay(latestCommittedDate)} (${commitCount} コミット目: ${shortOid}${commitDetail(commitMsg)})]`,
    );
  }

  function commitDetail(msg: string): string {
    return msg ? ` - ${msg}` : "";
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
  const targetReady = simulateReadySince(
    targetTimeline,
    pr.labels,
    pr.isDraft,
    now,
    false, // 実環境の外部イベント揺れを許容
  );

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
    } catch {
      // 読み込み失敗時は新規作成として継続
    }
  }

  // 過去マージ済み PR のサンプリング
  const sinceDate = new Date(now.getTime() - options.lookbackDays * 24 * 60 * 60 * 1000);
  const sinceIso = sinceDate.toISOString();

  const baseParts = buildHealthyQueryParts(options.repository);

  // 1. 前線（健康な最古の未マージ PR）と、自 PR より前に並ぶ健康な PR の内訳（実質待ち / 放置）
  const createdIso = created.toISOString();
  const staleCutoffIso = new Date(
    now.getTime() - options.staleDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const eligibleQuery = baseParts.join(" ");

  const frontRes = await client.searchIssuesDetailed(eligibleQuery, "created", "asc", 1);
  const frontItem = frontRes.items[0];
  if (!frontItem) {
    throw new Error("前線（条件を満たす最古の未マージ PR）を検索結果から特定できませんでした。");
  }
  const allTotal = frontRes.totalCount;

  const aheadQuery = `${eligibleQuery} created:<${createdIso}`;
  const aheadRes = await client.searchIssuesDetailed(aheadQuery, "created", "desc", 15);
  const aheadTotal = aheadRes.totalCount;

  const staleRes = await client.searchIssuesDetailed(
    `${aheadQuery} updated:<${staleCutoffIso}`,
    "updated",
    "asc",
    1,
  );
  const staleAheadCount = staleRes.totalCount;
  const activeAheadCount = Math.max(0, aheadTotal - staleAheadCount);

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
  let failed = 0;

  for (const cand of candidates) {
    if (samples.length >= options.sampleSize) break;
    try {
      const mergedAtStr = cand.pull_request?.merged_at ?? cand.updated_at;
      const mergedAt = new Date(mergedAtStr);
      const candTimeline = await client.getIssueTimeline(options.repository, cand.number);
      const candLabels = (cand.labels ?? []).map((l) => l.name);

      const readyAt = simulateReadySince(
        candTimeline,
        candLabels,
        Boolean(cand.is_draft),
        mergedAt,
      );
      if (!readyAt) {
        skipped++;
        continue;
      }

      const readyDays = (mergedAt.getTime() - readyAt.getTime()) / (1000 * 60 * 60 * 24);
      if (readyDays < 0) {
        skipped++;
        continue;
      }

      const candDetail = await client.getPullRequestDetails(options.repository, cand.number);
      const candCreatedAt = new Date(candDetail.createdAt);
      const candCommits = candDetail.commits;
      const candLatestCommit = candCommits.length > 0 ? candCommits[candCommits.length - 1] : null;
      const candLatestCommittedDate = candLatestCommit
        ? new Date(candLatestCommit.committedDate)
        : candCreatedAt;

      const totalDays = (mergedAt.getTime() - candCreatedAt.getTime()) / (1000 * 60 * 60 * 24);
      const turnDays =
        (mergedAt.getTime() - candLatestCommittedDate.getTime()) / (1000 * 60 * 60 * 24);

      samples.push({
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
      });
    } catch {
      failed++;
    }
  }

  const behindCount = Math.max(0, allTotal - aheadTotal - 1);

  const queueInfo: ProgressQueueInfo = {
    front: { number: frontItem.number, createdAt: frontItem.created_at },
    activeAheadCount,
    staleAheadCount,
    aheadCount: aheadTotal,
    totalCount: allTotal,
    behindCount,
    rivals,
  };

  log("");
  log("----------------------------------------");
  log("【現在のレビュー待ち行列（実質的な待ち人数）】");

  // 前回行が旧定義（StaleAhead 列なし）の場合、定義が異なるため前回比は出さない
  const prev = prevRecord && prevRecord.StaleAhead !== "" ? prevRecord : null;
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
    `実質待ちPR（放置を除く）   : 約 ${queueInfo.activeAheadCount} 件${deltaOf(queueInfo.activeAheadCount, prev?.ActiveAhead)} （あなたのPRより前で、直近 ${options.staleDays} 日以内に更新あり）`,
  );
  log(
    `放置滞留PR（遭難）         : 約 ${queueInfo.staleAheadCount} 件${deltaOf(queueInfo.staleAheadCount, prev?.StaleAhead)} （あなたのPRより前で、${options.staleDays} 日以上更新なし）`,
  );
  log(
    `全期間の累積待ちPR (参考) : 約 ${queueInfo.aheadCount} 件${deltaOf(queueInfo.aheadCount, prev?.TotalAhead)} （実質待ち + 放置滞留）`,
  );

  log(
    `あなたの後ろに並ぶ準備完了PR: 約 ${queueInfo.behindCount} 件${deltaOf(queueInfo.behindCount, prev?.Behind)}`,
  );
  log("----------------------------------------");

  const stats = calculateProgressStats(samples, skipped, failed);

  if (stats) {
    log("");
    log("【過去実績との統計比較】");
    log("1. 通算日数 (Total Lifetime: 作成→マージ)");
    log(
      `   中央値: ${formatHumanDays(stats.total.median)} | 75%点: ${formatHumanDays(stats.total.p75)} | 最大: ${formatHumanDays(stats.total.max)}`,
    );
    log(`   あなたの待機 : ${formatHumanDays(totalLifetimeDays)}`);
    log("");
    log("2. レビュー待ち (Turn Latency: 最新コミット→マージ)");
    log(
      `   中央値: ${formatHumanDays(stats.turn.median)} | 75%点: ${formatHumanDays(stats.turn.p75)} | 最大: ${formatHumanDays(stats.turn.max)}`,
    );
    log(`   あなたの待機 : ${formatHumanDays(turnLatencyDays)}`);
  }

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
    staleAhead: queueInfo.staleAheadCount,
    staleDays: options.staleDays,
    behind: queueInfo.behindCount,
    totalLifetimeDays,
    turnLatencyDays,
    waitDays,
    commitCount,
    stats,
  });

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
      StaleAhead: queueInfo.staleAheadCount,
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

// 直接実行時のエントリポイント
if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runProgressCli(options);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`エラー: ${message}`);
    process.exit(1);
  }
}
