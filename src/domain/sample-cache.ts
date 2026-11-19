/**
 * マージ済み PR のサンプルキャッシュの変換・パース・直列化を行う純粋関数群。
 * 外部 I/O を行わず、src/models の型定義だけに依存する。
 */

import type { MergedCandidateSample } from "../models/progress";
import type {
  CachedSampleEntry,
  FirstTimerFastestRanking,
  SampleCacheEntry,
} from "../models/sample-cache";
import { isPrivilegedOrBotAuthor, MIN_VALIDATION_GUIDE_READY_VERSION } from "./first-timer";
import { DAY_MS } from "./formatters";

/** 統計に採用したサンプルを、キャッシュの 1 件にする */
export function toCachedSample(sample: MergedCandidateSample): CachedSampleEntry {
  return {
    Type: "sample",
    Number: sample.number,
    Title: sample.title,
    CreatedAt: sample.createdAt,
    LatestCommittedDate: sample.latestCommittedDate,
    CommitCount: sample.commitCount,
    ReadyAt: sample.readyAt,
    MergedAt: sample.mergedAt,
    TotalDays: sample.totalDays,
    TurnDays: sample.turnDays,
    ReadyDays: sample.days,
    ...(sample.author !== undefined ? { Author: sample.author } : {}),
    ...(sample.authorType !== undefined ? { AuthorType: sample.authorType } : {}),
    ...(sample.authorAssociation !== undefined
      ? { AuthorAssociation: sample.authorAssociation }
      : {}),
    ...(sample.isFirstTimer !== undefined ? { IsFirstTimer: sample.isFirstTimer } : {}),
    ...(sample.firstTimerReason !== undefined ? { FirstTimerReason: sample.firstTimerReason } : {}),
    ...(sample.firstTimerVersion !== undefined
      ? { FirstTimerVersion: sample.firstTimerVersion }
      : {}),
  };
}

/** キャッシュの 1 件を、統計に使うサンプルへ戻す */
export function fromCachedSample(entry: CachedSampleEntry): MergedCandidateSample {
  return {
    number: entry.Number,
    title: entry.Title,
    createdAt: entry.CreatedAt,
    latestCommittedDate: entry.LatestCommittedDate,
    commitCount: entry.CommitCount,
    readyAt: entry.ReadyAt,
    mergedAt: entry.MergedAt,
    totalDays: entry.TotalDays,
    turnDays: entry.TurnDays,
    days: entry.ReadyDays,
    ...(entry.Author !== undefined ? { author: entry.Author } : {}),
    ...(entry.AuthorType !== undefined ? { authorType: entry.AuthorType } : {}),
    ...(entry.AuthorAssociation !== undefined
      ? { authorAssociation: entry.AuthorAssociation }
      : {}),
    ...(entry.IsFirstTimer !== undefined ? { isFirstTimer: entry.IsFirstTimer } : {}),
    ...(entry.FirstTimerReason !== undefined ? { firstTimerReason: entry.FirstTimerReason } : {}),
    ...(entry.FirstTimerVersion !== undefined
      ? { firstTimerVersion: entry.FirstTimerVersion }
      : {}),
  };
}

const SAMPLE_NUMERIC_KEYS = ["CommitCount", "TotalDays", "TurnDays", "ReadyDays"] as const;
const SAMPLE_STRING_KEYS = [
  "Title",
  "CreatedAt",
  "LatestCommittedDate",
  "ReadyAt",
  "MergedAt",
] as const;

function validateEntry(parsed: unknown, lineNumber: number): SampleCacheEntry {
  const fail = (reason: string): never => {
    throw new Error(`サンプルキャッシュ ${lineNumber} 行目が不正です: ${reason}`);
  };
  if (parsed === null || typeof parsed !== "object") return fail("オブジェクトではありません");
  const entry = parsed as Record<string, unknown>;

  if (!Number.isInteger(entry.Number) || (entry.Number as number) <= 0) {
    return fail("Number が正の整数ではありません");
  }
  if (typeof entry.MergedAt !== "string" || !Number.isFinite(Date.parse(entry.MergedAt))) {
    return fail("MergedAt を解釈できません");
  }

  if (entry.Type === "skipped") {
    if (
      entry.Reason !== "no-ready" &&
      entry.Reason !== "negative-ready" &&
      entry.Reason !== "not-first-timer-candidate"
    ) {
      return fail(`Reason が不正です: ${String(entry.Reason)}`);
    }
    if (entry.FirstTimerVersion !== undefined) {
      if (
        typeof entry.FirstTimerVersion !== "number" ||
        !Number.isInteger(entry.FirstTimerVersion)
      ) {
        return fail("FirstTimerVersion が整数ではありません");
      }
    }
    return entry as unknown as SampleCacheEntry;
  }
  if (entry.Type === "sample") {
    for (const key of SAMPLE_STRING_KEYS) {
      if (typeof entry[key] !== "string") return fail(`${key} が文字列ではありません`);
    }
    for (const key of SAMPLE_NUMERIC_KEYS) {
      if (typeof entry[key] !== "number" || !Number.isFinite(entry[key])) {
        return fail(`${key} が数値ではありません`);
      }
    }
    if (entry.Author !== undefined && typeof entry.Author !== "string") {
      return fail("Author が文字列ではありません");
    }
    if (entry.AuthorType !== undefined && typeof entry.AuthorType !== "string") {
      return fail("AuthorType が文字列ではありません");
    }
    if (entry.AuthorAssociation !== undefined && typeof entry.AuthorAssociation !== "string") {
      return fail("AuthorAssociation が文字列ではありません");
    }
    if (entry.IsFirstTimer !== undefined && typeof entry.IsFirstTimer !== "boolean") {
      return fail("IsFirstTimer が真偽値ではありません");
    }
    if (entry.FirstTimerReason !== undefined) {
      if (
        entry.FirstTimerReason !== "multi-commit" &&
        entry.FirstTimerReason !== "timeline-blocking" &&
        entry.FirstTimerReason !== "recurring-author" &&
        entry.FirstTimerReason !== "lifetime-merged" &&
        entry.FirstTimerReason !== "privileged-or-bot"
      ) {
        return fail(`FirstTimerReason が不正です: ${String(entry.FirstTimerReason)}`);
      }
    }
    if (entry.FirstTimerVersion !== undefined) {
      if (
        typeof entry.FirstTimerVersion !== "number" ||
        !Number.isInteger(entry.FirstTimerVersion)
      ) {
        return fail("FirstTimerVersion が整数ではありません");
      }
    }
    return entry as unknown as SampleCacheEntry;
  }
  return fail(`種別が不正です: ${String(entry.Type)}`);
}

/**
 * merged-samples.jsonl（1 行 1 JSON、先頭に BOM があり得る）をパースする。
 * 壊れた行や不正な値は、握りつぶして統計を歪めないよう、行番号付きで例外にする。
 */
export function parseSampleCache(text: string): SampleCacheEntry[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const entries: SampleCacheEntry[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`サンプルキャッシュ ${index + 1} 行目のパースに失敗しました: ${msg}`, {
        cause: err,
      });
    }
    entries.push(validateEntry(parsed, index + 1));
  }
  return entries;
}

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

/** 追記用の JSONL（各行の末尾に改行）にする。空配列なら空文字列 */
export function serializeSampleCacheEntries(entries: SampleCacheEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/** 初回提出者 最速マージランキングの既定表示上限件数 */
export const FIRST_TIMER_FASTEST_RANKING_LIMIT = 10;

/** 初回提出者 最速マージランキングの既定集計窓（起票日時 CreatedAt 起点の日数） */
export const FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS = 90;

/** バイパス即マージを除外するための条件成立後経過日数（ReadyDays）の下限 */
export const FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS = 0.5;

/** v4 以前のゾンビキャッシュ（Validation-Guide 阻害化前）を除外するための最低判定バージョン */
export const FIRST_TIMER_FASTEST_RANKING_MIN_VERSION = MIN_VALIDATION_GUIDE_READY_VERSION;

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
