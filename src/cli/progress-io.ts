import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GitHubApiClient } from "../api/github";
import { buildExitCountQueries } from "../domain/exit-breakdown";
import { DAY_MS, formatDateTimeWithDay, formatHumanDays } from "../domain/formatters";
import { buildHealthyQueryParts, isBlockedLabel, REQUIRED_LABELS } from "../domain/labels";
import { extractRivalPrs } from "../domain/progress";
import { parseCsvRows, serializeCsvRows } from "../domain/progress-csv";
import { parseSampleCache, serializeSampleCacheEntries } from "../domain/sample-cache";
import { simulateReadySince } from "../domain/timeline";
import type {
  ProgressHistoryRow,
  ProgressPrDetail,
  ProgressQueueInfo,
  ProgressSnapshot,
} from "../models/progress";
import type { SampleCacheEntry } from "../models/sample-cache";

export interface ProgressCliOptions {
  targetPr: number;
  repository: string;
  lookbackDays: number;
  /** 初回提出者コホートの集計窓（日。省略時は 90） */
  firstTimerLookbackDays?: number;
  /** 1 回の実行で新規に取得するマージ済み PR の上限（キャッシュ済みの分は数えない） */
  fetchBudget: number;
  fetchLimit: number;
  /** 軽量メタデータバッチで中間世代を段階更新する上限件数（省略時は DEFAULT_METADATA_REFRESH_BUDGET、0 で無効） */
  metadataRefreshBudget?: number;
  /** キャッシュの保持日数（MergedAt TTL、省略時は DEFAULT_SAMPLE_CACHE_RETENTION_DAYS、0 で無効） */
  cacheRetentionDays?: number;
  /** マージ済み PR のサンプルキャッシュ（JSONL）。省略時はキャッシュを使わない */
  cachePath?: string;
  logPath?: string;
  snapshotPath?: string;
  noLog: boolean;
  asJson: boolean;
  /** テスト用等で基準時刻を固定する場合に指定 */
  now?: Date;
}

export function readSampleCache(path: string): SampleCacheEntry[] {
  if (!existsSync(path)) return [];
  try {
    return parseSampleCache(readFileSync(path, "utf-8"));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`サンプルキャッシュの読み込みに失敗しました (${path}): ${msg}`, { cause: err });
  }
}

/** キャッシュファイル全体を保存する（更新・属性補完を永続化する） */
export function saveSampleCache(path: string, entries: SampleCacheEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeSampleCacheEntries(entries), "utf-8");
}

export interface TargetPrContext {
  pr: ProgressPrDetail;
  created: Date;
  commitCount: number;
  totalLifetimeDays: number;
  turnLatencyDays: number;
  targetReady: Date;
  waitDays: number;
}

/**
 * 対象 PR の詳細・タイムラインを取得し、観測条件（OPEN / Draft でない / 必須ラベルあり / 除外ラベルなし）を検証する。
 */
export async function fetchAndValidateTargetPr(
  options: ProgressCliOptions,
  client: GitHubApiClient,
  now: Date,
  log: (msg: string) => void,
): Promise<TargetPrContext | null> {
  const pr = await client.getPullRequestDetails(options.repository, options.targetPr);
  const created = new Date(pr.createdAt);
  const commits = pr.commits;
  const commitCount = pr.commitCount ?? commits.length;
  const latestCommit = commits.length > 0 ? commits[commits.length - 1] : null;
  const latestCommittedDate = latestCommit ? new Date(latestCommit.committedDate) : created;

  const totalLifetimeDays = (now.getTime() - created.getTime()) / DAY_MS;
  const turnLatencyDays = (now.getTime() - latestCommittedDate.getTime()) / DAY_MS;

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
    const endTotalDays = (endAt.getTime() - created.getTime()) / DAY_MS;
    const endTurnDays = (endAt.getTime() - latestCommittedDate.getTime()) / DAY_MS;

    log(`通算所要日数 (作成〜終了)   : ${formatHumanDays(endTotalDays)}`);
    log(`最終ターン所要日数 (最新〜) : ${formatHumanDays(endTurnDays)}`);
    return null;
  }

  const missing = REQUIRED_LABELS.filter((l) => !pr.labels.includes(l));
  const blocking = pr.labels.filter((l) => isBlockedLabel(l));

  if (pr.isDraft || missing.length > 0 || blocking.length > 0) {
    log("");
    log("現在は今回の比較条件を満たしていません。");
    if (pr.isDraft) log("Draft            : はい");
    if (missing.length > 0) log(`不足ラベル       : ${missing.join(", ")}`);
    if (blocking.length > 0) log(`除外ラベル       : ${blocking.join(", ")}`);
    return null;
  }

  log(
    `比較条件                   : ${REQUIRED_LABELS.join("・")}あり・除外ラベルなし・Draftでない`,
  );

  // 対象 PR のタイムライン取得と成立日時特定
  const targetTimeline = await client.getIssueTimeline(options.repository, options.targetPr);
  const targetReady = simulateReadySince(targetTimeline, pr.isDraft, now);

  if (!targetReady) {
    throw new Error("対象PRの条件成立日時を履歴から特定できませんでした。");
  }

  const waitDays = (now.getTime() - targetReady.getTime()) / DAY_MS;
  log(`条件が整った日時 (ReadyAt) : ${formatDateTimeWithDay(targetReady)}`);
  log(`整ってからの待機 (Ready)   : ${formatHumanDays(waitDays)}`);

  return {
    pr,
    created,
    commitCount,
    totalLifetimeDays,
    turnLatencyDays,
    targetReady,
    waitDays,
  };
}

/**
 * 履歴 CSV から対象 PR の直近レコードを読み込む。
 */
export function loadTargetHistory(
  historyCsvPath: string,
  targetPr: number,
): ProgressHistoryRow | null {
  if (!existsSync(historyCsvPath)) {
    return null;
  }
  try {
    const csvText = readFileSync(historyCsvPath, "utf-8");
    const rows = parseCsvRows(csvText);
    let prevRecord: ProgressHistoryRow | null = null;
    for (const rec of rows) {
      if (Number(rec.TargetPr) === targetPr) {
        prevRecord = rec;
      }
    }
    return prevRecord;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`履歴ファイルの読み込みに失敗しました (${historyCsvPath}): ${msg}`, {
      cause: err,
    });
  }
}

/**
 * 現在の Open レビュー待ち行列（健康的大底・実質待ち・累積待ち・直前ライバル PR）を集計する。
 */
export async function collectOpenQueueInfo(
  client: GitHubApiClient,
  repository: string,
  targetPr: number,
  created: Date,
  prUpdatedAt: string,
): Promise<ProgressQueueInfo> {
  const baseParts = buildHealthyQueryParts(repository);
  const eligibleQuery = baseParts.join(" ");

  // 1. 健康的大底（健康な最古の未マージ PR）と全体の健康な PR 数
  const frontRes = await client.searchIssuesDetailed(eligibleQuery, "created", "asc", 1);
  const frontItem = frontRes.items[0];
  if (!frontItem) {
    throw new Error(
      "健康的大底（条件を満たす最古の未マージ PR）を検索結果から特定できませんでした。",
    );
  }
  const allTotal = frontRes.totalCount;

  // 2. 作成順での累積待ちと直前ライバル PR 抽出（阻害ラベルはクエリ側で除外済みのため必要最小限の 6 件取得）
  const aheadQuery = `${eligibleQuery} created:<${created.toISOString()}`;
  const aheadRes = await client.searchIssuesDetailed(aheadQuery, "created", "desc", 6);
  const aheadTotal = aheadRes.totalCount;

  // 3. 実質待ち: 指摘なく順番待ちをしている PR は更新が止まっているため、更新順が実際の待ち順位になる（件数のみ取得）
  const updatedAheadRes = await client.searchIssuesDetailed(
    `${eligibleQuery} updated:<${new Date(prUpdatedAt).toISOString()}`,
    "updated",
    "asc",
    0,
  );

  const rivals = extractRivalPrs(aheadRes.items, targetPr);
  const behindCount = Math.max(0, allTotal - aheadTotal - 1);

  return {
    front: { number: frontItem.number, createdAt: frontItem.created_at },
    activeAheadCount: updatedAheadRes.totalCount,
    aheadCount: aheadTotal,
    totalCount: allTotal,
    behindCount,
    rivals,
  };
}

/**
 * 待ち行列からの累積離脱件数（基準 PR より前に起票され、基準 PR の起票以降にマージ・クローズされた件数）を取得する。
 */
export async function fetchExitCounts(
  client: GitHubApiClient,
  repository: string,
  created: Date,
  log: (msg: string) => void,
): Promise<{ mergedOlder: number; closedOlder: number }> {
  // 実質待ちの減少の内訳（マージ・クローズ・その他）を、観測の間の差から求めるために履歴へ残す
  const exitQueries = buildExitCountQueries(
    repository,
    created.toISOString().replace(/\.\d{3}Z$/, "Z"),
    REQUIRED_LABELS,
  );
  const mergedOlder = (await client.searchIssuesDetailed(exitQueries.merged, "updated", "desc", 0))
    .totalCount;
  const closedOlder = (await client.searchIssuesDetailed(exitQueries.closed, "updated", "desc", 0))
    .totalCount;
  log(
    `離脱の累積         : 基準 PR の起票以降に、起票が前の PR がマージ ${mergedOlder} 件・未マージでクローズ ${closedOlder} 件`,
  );
  return { mergedOlder, closedOlder };
}

/**
 * 履歴 CSV への追記と最新スナップショット JSON の保存を行う。
 */
export function saveProgressOutputs(params: {
  historyCsvPath: string;
  defaultDataDir: string;
  snapshotPath?: string;
  logRow: ProgressHistoryRow;
  snapshot: ProgressSnapshot;
}): void {
  const { historyCsvPath, defaultDataDir, snapshotPath, logRow, snapshot } = params;

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

  const resolvedSnapshotPath = snapshotPath
    ? resolve(process.cwd(), snapshotPath)
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
