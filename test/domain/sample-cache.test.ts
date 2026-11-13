import { describe, expect, test } from "bun:test";
import {
  fromCachedSample,
  indexSampleCache,
  parseSampleCache,
  serializeSampleCacheEntries,
  toCachedSample,
} from "../../src/domain/sample-cache";
import type { MergedCandidateSample } from "../../src/models/progress";
import type { CachedSampleEntry, SampleCacheEntry } from "../../src/models/sample-cache";

const sample: MergedCandidateSample = {
  number: 42,
  title: "New package: x.y",
  createdAt: "2026-10-20T00:00:00Z",
  latestCommittedDate: "2026-10-21T00:00:00.000Z",
  commitCount: 3,
  readyAt: "2026-10-22T00:00:00.000Z",
  mergedAt: "2026-11-02T00:00:00.000Z",
  totalDays: 13,
  turnDays: 12,
  days: 11,
};

const entry = (overrides: Record<string, unknown> = {}): CachedSampleEntry => ({
  ...toCachedSample(sample),
  ...overrides,
});

describe("Domain: サンプルキャッシュの変換", () => {
  test("サンプルとキャッシュの 1 件は、値を失わず相互に変換できる", () => {
    expect(toCachedSample(sample)).toEqual({
      Type: "sample",
      Number: 42,
      Title: "New package: x.y",
      CreatedAt: "2026-10-20T00:00:00Z",
      LatestCommittedDate: "2026-10-21T00:00:00.000Z",
      CommitCount: 3,
      ReadyAt: "2026-10-22T00:00:00.000Z",
      MergedAt: "2026-11-02T00:00:00.000Z",
      TotalDays: 13,
      TurnDays: 12,
      ReadyDays: 11,
    });
    expect(fromCachedSample(toCachedSample(sample))).toEqual(sample);
  });

  test("Author と IsFirstTimer を含むサンプルも相互変換できる", () => {
    const sampleWithFirstTimer: MergedCandidateSample = {
      ...sample,
      author: "firstTimerUser",
      isFirstTimer: true,
    };
    const cached = toCachedSample(sampleWithFirstTimer);
    expect(cached.Author).toBe("firstTimerUser");
    expect(cached.IsFirstTimer).toBe(true);
    expect(fromCachedSample(cached)).toEqual(sampleWithFirstTimer);
  });
});

describe("Domain: parseSampleCache", () => {
  const skipped: SampleCacheEntry = {
    Type: "skipped",
    Number: 7,
    MergedAt: "2026-11-01T00:00:00.000Z",
    Reason: "no-ready",
  };
  const skippedNotFirstTimer: SampleCacheEntry = {
    Type: "skipped",
    Number: 8,
    MergedAt: "2026-10-15T00:00:00.000Z",
    Reason: "not-first-timer-candidate",
  };

  test("BOM 付き・空行を含む JSONL を、採用と除外の両方でパースする", () => {
    const text = `﻿${JSON.stringify(entry())}\n\n${JSON.stringify(skipped)}\n${JSON.stringify(skippedNotFirstTimer)}\n`;
    expect(parseSampleCache(text)).toEqual([entry(), skipped, skippedNotFirstTimer]);
  });

  test("空のテキストは空配列", () => {
    expect(parseSampleCache("")).toEqual([]);
  });

  test("直列化したものを、そのままパースして元に戻せる", () => {
    const entries = [entry(), skipped];
    expect(parseSampleCache(serializeSampleCacheEntries(entries))).toEqual(entries);
    expect(serializeSampleCacheEntries([])).toBe("");
  });

  test.each([
    ["壊れた JSON", "{ broken\n", "サンプルキャッシュ 1 行目のパースに失敗しました"],
    ["配列", "[1]\n", "1 行目が不正です: Number が正の整数ではありません"],
    ["null", "null\n", "1 行目が不正です: オブジェクトではありません"],
    [
      "Number が文字列",
      `${JSON.stringify(entry({ Number: "42" }))}\n`,
      "Number が正の整数ではありません",
    ],
    ["Number が 0", `${JSON.stringify(entry({ Number: 0 }))}\n`, "Number が正の整数ではありません"],
    [
      "MergedAt が解釈できない",
      `${JSON.stringify(entry({ MergedAt: "not-a-date" }))}\n`,
      "MergedAt を解釈できません",
    ],
    ["種別が不明", `${JSON.stringify(entry({ Type: "other" }))}\n`, "種別が不正です: other"],
    [
      "除外の理由が不明",
      `${JSON.stringify({ ...skipped, Reason: "weird" })}\n`,
      "Reason が不正です: weird",
    ],
    [
      "文字列の項目が欠けている",
      `${JSON.stringify(entry({ ReadyAt: undefined }))}\n`,
      "ReadyAt が文字列ではありません",
    ],
    [
      "数値の項目が NaN 相当（null）",
      `${JSON.stringify(entry({ TotalDays: null }))}\n`,
      "TotalDays が数値ではありません",
    ],
    [
      "Author が文字列ではない",
      `${JSON.stringify(entry({ Author: 123 }))}\n`,
      "Author が文字列ではありません",
    ],
    [
      "IsFirstTimer が真偽値ではない",
      `${JSON.stringify(entry({ IsFirstTimer: "true" }))}\n`,
      "IsFirstTimer が真偽値ではありません",
    ],
  ])("壊れた行は握りつぶさず行番号つきで例外にする: %s", (_name, text, message) => {
    expect(() => parseSampleCache(text)).toThrow(message);
  });

  test("2 行目以降の不正も行番号を示す", () => {
    const text = `${JSON.stringify(entry())}\n${JSON.stringify(entry({ Number: -1 }))}\n`;
    expect(() => parseSampleCache(text)).toThrow("サンプルキャッシュ 2 行目が不正です");
  });
});

describe("Domain: indexSampleCache", () => {
  test("PR 番号で引け、同じ番号が複数あれば先に記録されたものを正とする", () => {
    const first = entry({ Title: "first" });
    const later = entry({ Title: "later" });
    const other = entry({ Number: 43 });
    const index = indexSampleCache([first, other, later]);

    expect(index.size).toBe(2);
    expect((index.get(42) as CachedSampleEntry).Title).toBe("first");
    expect(index.get(43)).toBe(other);
    expect(index.get(99)).toBeUndefined();
  });
});
