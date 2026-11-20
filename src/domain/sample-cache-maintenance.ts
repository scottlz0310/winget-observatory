/**
 * サンプルキャッシュからの最速ランキング抽出、TTL/検索対象外パージ、軽量メタデータ補完候補抽出、および世代別サマリ集計を行う純粋関数群。
 * 外部 I/O を行わず、src/models の型定義と同一ドメイン内のモジュールだけに依存する。
 */

import type {
  CachedSampleEntry,
  FirstTimerFastestRanking,
  SampleCacheEntry,
} from "../models/sample-cache";
import {
  CURRENT_FIRST_TIMER_VERSION,
  hasValidatedReadyVersion,
  isPrivilegedOrBotAuthor,
  MIN_VALID_READY_VERSION,
  shouldReevaluateCachedSample,
} from "./first-timer";
import { DAY_MS } from "./formatters";

/** PR 番号で引けるようにする。同じ番号が複数あれば、後続に記録されたものを正とする */
export function indexSampleCache(
  entries: readonly SampleCacheEntry[],
): Map<number, SampleCacheEntry> {
  const index = new Map<number, SampleCacheEntry>();
  for (const entry of entries) {
    index.set(entry.Number, entry);
  }
  return index;
}

/** 初回提出者 最速マージランキングの既定表示上限件数 */
export const FIRST_TIMER_FASTEST_RANKING_LIMIT = 10;

/** 初回提出者 最速マージランキングの既定集計窓（起票日時 CreatedAt 起点の日数） */
export const FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS = 90;

/** バイパス即マージを除外するための条件成立後経過日数（ReadyDays）の下限 */
export const FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS = 0.5;

/** 旧判定基準のゾンビキャッシュ（Ready 基準更新前）を除外するための最低判定バージョン */
export const FIRST_TIMER_FASTEST_RANKING_MIN_VERSION = MIN_VALID_READY_VERSION;

/** 初回提出者 最速マージランキング抽出オプション */
export interface ExtractFirstTimerFastestRankingOptions {
  /** 表示上限件数（既定: 10） */
  limit?: number;
  /** 起票日時（CreatedAt）起点の集計窓日数。0 以下指定時は期間フィルタ無効（既定: 90） */
  windowDays?: number;
  /** 条件成立後経過日数（ReadyDays）の下限（既定: 0.5） */
  minReadyDays?: number;
  /** 対象とする初回判定ロジックの最低バージョン（既定: 5） */
  minFirstTimerVersion?: number;
  /** 集計窓の基準時刻（既定: 現在時刻） */
  now?: Date;
}

/**
 * 蓄積済みサンプルキャッシュから、初回提出者（IsFirstTimer === true）の
 * 最速マージランキング（TotalDays 昇順・上位 limit 件）を抽出する。
 *
 * - Type === "sample" のみを対象に Number キーで重複排除する（後続行優先）
 * - 特権ロール（MEMBER / OWNER / COLLABORATOR）および Bot を除外する
 * - ReadyDays >= minReadyDays（既定 0.5 日）でエラー/CLA 解除直後のバイパス即マージを除外する
 * - FirstTimerVersion >= minFirstTimerVersion（既定 5）で v4 以前のゾンビキャッシュを除外する
 * - CreatedAt が直近 windowDays（既定 90 日）以内のサンプルに限定する
 */
export function extractFirstTimerFastestRanking(
  entries: readonly SampleCacheEntry[],
  options: ExtractFirstTimerFastestRankingOptions = {},
): FirstTimerFastestRanking {
  const rawLimit = options.limit ?? FIRST_TIMER_FASTEST_RANKING_LIMIT;
  const safeLimit = Number.isFinite(rawLimit)
    ? Math.max(0, Math.floor(rawLimit))
    : FIRST_TIMER_FASTEST_RANKING_LIMIT;

  const windowDays = options.windowDays ?? FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays < 0) {
    throw new RangeError(`windowDays は 0 以上の有限数値を指定してください: ${windowDays}`);
  }

  const minReadyDays = options.minReadyDays ?? FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS;
  if (!Number.isFinite(minReadyDays) || minReadyDays < 0) {
    throw new RangeError(`minReadyDays は 0 以上の有限数値を指定してください: ${minReadyDays}`);
  }

  const minFirstTimerVersion =
    options.minFirstTimerVersion ?? FIRST_TIMER_FASTEST_RANKING_MIN_VERSION;
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("now は有効な Date を指定してください");
  }
  const cutoffMs = windowDays > 0 ? nowMs - windowDays * DAY_MS : Number.NEGATIVE_INFINITY;

  const latestByNumber = indexSampleCache(entries);

  const firstTimers = [...latestByNumber.values()].filter((entry): entry is CachedSampleEntry => {
    if (entry.Type !== "sample" || entry.IsFirstTimer !== true) {
      return false;
    }
    if (
      isPrivilegedOrBotAuthor({
        author: entry.Author,
        authorType: entry.AuthorType,
        authorAssociation: entry.AuthorAssociation,
      })
    ) {
      return false;
    }
    if ((entry.FirstTimerVersion ?? 0) < minFirstTimerVersion) {
      return false;
    }
    if (entry.ReadyDays < minReadyDays) {
      return false;
    }
    if (windowDays > 0) {
      const createdMs = Date.parse(entry.CreatedAt);
      if (!Number.isFinite(createdMs) || createdMs < cutoffMs) {
        return false;
      }
    }
    return true;
  });

  firstTimers.sort(
    (a, b) =>
      a.TotalDays - b.TotalDays ||
      a.TurnDays - b.TurnDays ||
      a.ReadyDays - b.ReadyDays ||
      a.Number - b.Number,
  );

  return {
    totalCount: firstTimers.length,
    items: firstTimers.slice(0, safeLimit),
    windowDays,
  };
}

/** サンプルキャッシュの既定保持日数（TTL） */
export const DEFAULT_SAMPLE_CACHE_RETENTION_DAYS = 120;

/** 1 回の実行あたり軽量メタデータバッチで更新する既定件数（50件/クエリで 2 クエリ相当） */
export const DEFAULT_METADATA_REFRESH_BUDGET = 100;

export interface PruneSampleCacheOptions {
  /** 保持期間判定の基準時刻（既定: 現在時刻） */
  now?: Date;
  /** MergedAt の保持日数。0 指定時は TTL 削除を無効化（既定: 120 日） */
  retentionDays?: number;
  /** 今回の検索走査（candidates）にヒットした PR 番号集合 */
  scannedCandidateNumbers?: ReadonlySet<number>;
  /** 今回の検索走査が上限打ち切りなく完了したか（false/未設定時は検索候補外パージを行わない） */
  scanComplete?: boolean;
  /** 検索走査の開始日時（この日時〜now の間に MergedAt がある未ヒット旧版のみパージ対象） */
  scanSinceDate?: Date;
  /** 再計測不要とみなす判定バージョン下限（既定: MIN_VALID_READY_VERSION） */
  minReadyVersion?: number;
}

export interface PruneSampleCacheResult {
  entries: SampleCacheEntry[];
  ttlRemovedCount: number;
  staleRemovedCount: number;
}

/**
 * サンプルキャッシュから期限切れ（TTL 超過）および検索対象外の旧世代ゾンビレコードを除去する。
 */
export function pruneSampleCache(
  entries: readonly SampleCacheEntry[],
  options: PruneSampleCacheOptions = {},
): PruneSampleCacheResult {
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("now は有効な Date を指定してください");
  }

  const retentionDays = options.retentionDays ?? DEFAULT_SAMPLE_CACHE_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new RangeError(`retentionDays は 0 以上の有限数値を指定してください: ${retentionDays}`);
  }

  let scanSinceMs = Number.NEGATIVE_INFINITY;
  if (options.scanSinceDate !== undefined) {
    scanSinceMs = options.scanSinceDate.getTime();
    if (!Number.isFinite(scanSinceMs)) {
      throw new RangeError("scanSinceDate は有効な Date を指定してください");
    }
  }

  const minReadyVersion = options.minReadyVersion ?? MIN_VALID_READY_VERSION;
  const retentionCutoffMs =
    retentionDays > 0 ? nowMs - retentionDays * DAY_MS : Number.NEGATIVE_INFINITY;
  const canPruneOutsideCandidates =
    options.scanComplete === true &&
    options.scannedCandidateNumbers !== undefined &&
    options.scannedCandidateNumbers.size > 0;

  const latestByNumber = indexSampleCache(entries);
  const kept: SampleCacheEntry[] = [];
  let ttlRemovedCount = 0;
  let staleRemovedCount = 0;

  for (const entry of latestByNumber.values()) {
    const mergedMs = Date.parse(entry.MergedAt);
    if (retentionDays > 0 && (!Number.isFinite(mergedMs) || mergedMs < retentionCutoffMs)) {
      ttlRemovedCount++;
      continue;
    }

    if (
      canPruneOutsideCandidates &&
      entry.Type === "sample" &&
      !hasValidatedReadyVersion(entry.FirstTimerVersion, minReadyVersion) &&
      Number.isFinite(mergedMs) &&
      mergedMs >= scanSinceMs &&
      mergedMs <= nowMs &&
      !options.scannedCandidateNumbers?.has(entry.Number)
    ) {
      staleRemovedCount++;
      continue;
    }

    kept.push(entry);
  }

  return {
    entries: kept,
    ttlRemovedCount,
    staleRemovedCount,
  };
}

export interface SelectMetadataRefreshOptions {
  /** 集計窓の基準時刻（既定: 現在時刻） */
  now?: Date;
  /** 対象とする MergedAt 窓日数。0 指定時は期間無制限（既定: 90 日） */
  windowDays?: number;
  /** 最大抽出件数（既定: 100） */
  budget?: number;
  /** ReadyAt 再計測が不要な最低バージョン（既定: MIN_VALID_READY_VERSION） */
  minReadyVersion?: number;
  /** 到達目標とする最新バージョン（既定: CURRENT_FIRST_TIMER_VERSION） */
  targetVersion?: number;
}

/**
 * タイムライン再計算は不要だが最新バージョンのメタデータが未補完なサンプルを、
 * 初回候補（IsFirstTimer !== false）・新しい MergedAt を優先して budget 件抽出する。
 */
export function selectMetadataRefreshCandidates(
  entries: readonly SampleCacheEntry[],
  options: SelectMetadataRefreshOptions = {},
): CachedSampleEntry[] {
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("now は有効な Date を指定してください");
  }

  const windowDays = options.windowDays ?? FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays < 0) {
    throw new RangeError(`windowDays は 0 以上の有限数値を指定してください: ${windowDays}`);
  }

  const budget = options.budget ?? DEFAULT_METADATA_REFRESH_BUDGET;
  if (!Number.isFinite(budget) || budget < 0) {
    throw new RangeError(`budget は 0 以上の有限数値を指定してください: ${budget}`);
  }

  const safeBudget = Math.floor(budget);
  if (safeBudget === 0) {
    return [];
  }

  const minReadyVersion = options.minReadyVersion ?? MIN_VALID_READY_VERSION;
  const targetVersion = options.targetVersion ?? CURRENT_FIRST_TIMER_VERSION;
  const cutoffMs = windowDays > 0 ? nowMs - windowDays * DAY_MS : Number.NEGATIVE_INFINITY;

  const latestByNumber = indexSampleCache(entries);
  const candidates = [...latestByNumber.values()].filter((entry): entry is CachedSampleEntry => {
    if (entry.Type !== "sample") return false;
    const version = entry.FirstTimerVersion ?? 0;
    if (!hasValidatedReadyVersion(version, minReadyVersion) || version >= targetVersion) {
      return false;
    }
    // 初回判定の再評価（timeline-blocking 解除待ち等）が残っているレコードは
    // 軽量メタデータ補完だけで最新版へ昇格すると再評価がスキップされるため除外する
    if (
      shouldReevaluateCachedSample({
        isFirstTimer: entry.IsFirstTimer,
        firstTimerReason: entry.FirstTimerReason,
        firstTimerVersion: entry.FirstTimerVersion,
        commitCount: entry.CommitCount,
        authorCountInCandidates: 1,
        author: entry.Author,
        minReadyVersion,
        currentVersion: targetVersion,
      })
    ) {
      return false;
    }
    if (windowDays > 0) {
      const mergedMs = Date.parse(entry.MergedAt);
      if (!Number.isFinite(mergedMs) || mergedMs < cutoffMs) {
        return false;
      }
    }
    return true;
  });

  candidates.sort((a, b) => {
    const aPriority = a.IsFirstTimer !== false ? 0 : 1;
    const bPriority = b.IsFirstTimer !== false ? 0 : 1;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return Date.parse(b.MergedAt) - Date.parse(a.MergedAt) || b.Number - a.Number;
  });

  return candidates.slice(0, safeBudget);
}

export interface SampleCacheVersionSummary {
  totalUnique: number;
  sampleCount: number;
  skippedCount: number;
  /** ReadyAt 再計測基準未満（v4 以下）または初回判定のフル再評価待ちのサンプル数 */
  legacyBeforeReadyCount: number;
  /** タイムライン再評価不要かつ最新未満（v5 等、軽量バッチ対象）のサンプル数 */
  intermediateCount: number;
  /** 最新バージョン以上のサンプル数 */
  currentCount: number;
  /** 直近 windowDays 以内に残っている軽量バッチ対象数 */
  windowRefreshRemainingCount: number;
}

/**
 * サンプルキャッシュ内の判定バージョン別内訳と直近窓内の未移行残件数を集計する。
 */
export function summarizeSampleCacheVersions(
  entries: readonly SampleCacheEntry[],
  options: Pick<
    SelectMetadataRefreshOptions,
    "now" | "windowDays" | "minReadyVersion" | "targetVersion"
  > = {},
): SampleCacheVersionSummary {
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("now は有効な Date を指定してください");
  }
  const windowDays = options.windowDays ?? FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS;
  if (!Number.isFinite(windowDays) || windowDays < 0) {
    throw new RangeError(`windowDays は 0 以上の有限数値を指定してください: ${windowDays}`);
  }

  const minReadyVersion = options.minReadyVersion ?? MIN_VALID_READY_VERSION;
  const targetVersion = options.targetVersion ?? CURRENT_FIRST_TIMER_VERSION;
  const cutoffMs = windowDays > 0 ? nowMs - windowDays * DAY_MS : Number.NEGATIVE_INFINITY;

  const latestByNumber = indexSampleCache(entries);
  let sampleCount = 0;
  let skippedCount = 0;
  let legacyBeforeReadyCount = 0;
  let intermediateCount = 0;
  let currentCount = 0;
  let windowRefreshRemainingCount = 0;

  for (const entry of latestByNumber.values()) {
    if (entry.Type === "skipped") {
      skippedCount++;
      continue;
    }
    sampleCount++;
    const version = entry.FirstTimerVersion ?? 0;
    if (!hasValidatedReadyVersion(version, minReadyVersion)) {
      legacyBeforeReadyCount++;
    } else if (version < targetVersion) {
      const requiresFirstTimerReeval = shouldReevaluateCachedSample({
        isFirstTimer: entry.IsFirstTimer,
        firstTimerReason: entry.FirstTimerReason,
        firstTimerVersion: entry.FirstTimerVersion,
        commitCount: entry.CommitCount,
        authorCountInCandidates: 1,
        author: entry.Author,
        minReadyVersion,
        currentVersion: targetVersion,
      });
      if (requiresFirstTimerReeval) {
        legacyBeforeReadyCount++;
      } else {
        intermediateCount++;
        const mergedMs = Date.parse(entry.MergedAt);
        if (windowDays === 0 || (Number.isFinite(mergedMs) && mergedMs >= cutoffMs)) {
          windowRefreshRemainingCount++;
        }
      }
    } else {
      currentCount++;
    }
  }

  return {
    totalUnique: latestByNumber.size,
    sampleCount,
    skippedCount,
    legacyBeforeReadyCount,
    intermediateCount,
    currentCount,
    windowRefreshRemainingCount,
  };
}
