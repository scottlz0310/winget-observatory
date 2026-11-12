/**
 * マージ済み PR のサンプルキャッシュの変換・パース・直列化を行う純粋関数群。
 * 外部 I/O を行わず、src/models の型定義だけに依存する。
 */

import type { MergedCandidateSample } from "../models/progress";
import type { CachedSampleEntry, SampleCacheEntry } from "../models/sample-cache";

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
    ...(sample.isFirstTimer !== undefined ? { IsFirstTimer: sample.isFirstTimer } : {}),
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
    ...(entry.IsFirstTimer !== undefined ? { isFirstTimer: entry.IsFirstTimer } : {}),
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
    if (entry.Reason !== "no-ready" && entry.Reason !== "negative-ready") {
      return fail(`Reason が不正です: ${String(entry.Reason)}`);
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
    if (entry.IsFirstTimer !== undefined && typeof entry.IsFirstTimer !== "boolean") {
      return fail("IsFirstTimer が真偽値ではありません");
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

/** PR 番号で引けるようにする。同じ番号が複数あれば、先に記録されたものを正とする */
export function indexSampleCache(entries: SampleCacheEntry[]): Map<number, SampleCacheEntry> {
  const index = new Map<number, SampleCacheEntry>();
  for (const entry of entries) {
    if (!index.has(entry.Number)) index.set(entry.Number, entry);
  }
  return index;
}

/** 追記用の JSONL（各行の末尾に改行）にする。空配列なら空文字列 */
export function serializeSampleCacheEntries(entries: SampleCacheEntry[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}
