import { describe, expect, test } from "bun:test";
import {
  extractFirstTimerFastestRanking,
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
      firstTimerReason: undefined,
      firstTimerVersion: 2,
    };
    const cached = toCachedSample(sampleWithFirstTimer);
    expect(cached.Author).toBe("firstTimerUser");
    expect(cached.IsFirstTimer).toBe(true);
    expect(cached.FirstTimerVersion).toBe(2);
    expect(fromCachedSample(cached)).toEqual(sampleWithFirstTimer);
  });

  test("FirstTimerReason（timeline-blocking 等）を含む除外サンプルも相互変換できる", () => {
    const sampleExcluded: MergedCandidateSample = {
      ...sample,
      author: "blockedUser",
      isFirstTimer: false,
      firstTimerReason: "timeline-blocking",
      firstTimerVersion: 2,
    };
    const cached = toCachedSample(sampleExcluded);
    expect(cached.Author).toBe("blockedUser");
    expect(cached.IsFirstTimer).toBe(false);
    expect(cached.FirstTimerReason).toBe("timeline-blocking");
    expect(cached.FirstTimerVersion).toBe(2);
    expect(fromCachedSample(cached)).toEqual(sampleExcluded);
  });
});

describe("Domain: parseSampleCache", () => {
  const skipped: SampleCacheEntry = {
    Type: "skipped",
    Number: 7,
    MergedAt: "2026-11-01T00:00:00.000Z",
    Reason: "no-ready",
    FirstTimerVersion: 3,
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
    [
      "FirstTimerReason が不正",
      `${JSON.stringify(entry({ FirstTimerReason: "invalid-reason" }))}\n`,
      "FirstTimerReason が不正です: invalid-reason",
    ],
    [
      "FirstTimerVersion が整数ではない",
      `${JSON.stringify(entry({ FirstTimerVersion: "v2" }))}\n`,
      "FirstTimerVersion が整数ではありません",
    ],
    [
      "skipped の FirstTimerVersion が整数ではない",
      `${JSON.stringify({ ...skipped, FirstTimerVersion: "v3" })}\n`,
      "FirstTimerVersion が整数ではありません",
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
  test("PR 番号で引け、同じ番号が複数あれば後続に記録されたものを正とする", () => {
    const first = entry({
      Title: "first",
      IsFirstTimer: false,
      FirstTimerReason: "timeline-blocking",
    });
    const later = entry({ Title: "later", IsFirstTimer: true, FirstTimerVersion: 4 });
    const other = entry({ Number: 43 });
    const index = indexSampleCache([first, other, later]);

    expect(index.size).toBe(2);
    const resolved = index.get(42) as CachedSampleEntry;
    expect(resolved.Title).toBe("later");
    expect(resolved.IsFirstTimer).toBe(true);
    expect(resolved.FirstTimerReason).toBeUndefined();
    expect(resolved.FirstTimerVersion).toBe(4);
    expect(index.get(43)).toBe(other);
    expect(index.get(99)).toBeUndefined();
  });
});

describe("Domain: extractFirstTimerFastestRanking", () => {
  test("Type=sample のみ対象・Number重複は後続行優先・IsFirstTimer=true のみを TotalDays 昇順 TOP 10 で抽出する", () => {
    const firstTimerEntries: CachedSampleEntry[] = Array.from({ length: 12 }, (_, idx) =>
      entry({
        Number: 100 + idx,
        Title: `FT #${100 + idx}`,
        TotalDays: 20 - idx, // 20, 19, ..., 9 -> 昇順では 111(9日), 110(10日), ..., 102(18日) が上位10件
        TurnDays: 1.5,
        ReadyDays: 1.0,
        IsFirstTimer: true,
        MergedAt: "2026-08-01T00:00:00.000Z", // 30日超の古いデータも含める
      }),
    );

    const mixedEntries: SampleCacheEntry[] = [
      // 先に IsFirstTimer=true で記録されたが、後続行で false に再評価された -> 除外されること
      entry({ Number: 201, Title: "Disqualified later", TotalDays: 0.1, IsFirstTimer: true }),
      // 先に IsFirstTimer=false だったが、後続行で true かつ TotalDays=0.5 に更新 -> 採用され1位になること
      entry({ Number: 202, Title: "Promoted later old", TotalDays: 50, IsFirstTimer: false }),
      // skipped 行、IsFirstTimer=false、IsFirstTimer 未設定 -> 除外
      { Type: "skipped", Number: 203, MergedAt: "2026-10-01T00:00:00Z", Reason: "no-ready" },
      entry({ Number: 204, TotalDays: 0.2, IsFirstTimer: false }),
      entry({ Number: 205, TotalDays: 0.3 }), // IsFirstTimer undefined
      ...firstTimerEntries,
      // 後続行の上書き
      entry({ Number: 201, Title: "Disqualified now", TotalDays: 0.1, IsFirstTimer: false }),
      entry({ Number: 202, Title: "Promoted later new", TotalDays: 0.5, IsFirstTimer: true }),
    ];

    const ranking = extractFirstTimerFastestRanking(mixedEntries);
    expect(ranking.totalCount).toBe(13); // firstTimerEntries 12件 + #202 1件
    expect(ranking.items).toHaveLength(10);
    expect(ranking.items.map((item) => item.Number)).toEqual([
      202, 111, 110, 109, 108, 107, 106, 105, 104, 103,
    ]);
    expect(ranking.items[0].Title).toBe("Promoted later new");
    expect(ranking.items[0].TotalDays).toBe(0.5);
  });

  test("同点の TotalDays は TurnDays / ReadyDays / Number の順で安定ソートし、空入力時は 0 件を返す", () => {
    const tied: SampleCacheEntry[] = [
      entry({ Number: 302, TotalDays: 2.0, TurnDays: 1.5, ReadyDays: 1.0, IsFirstTimer: true }),
      entry({ Number: 301, TotalDays: 2.0, TurnDays: 1.5, ReadyDays: 1.0, IsFirstTimer: true }),
      entry({ Number: 303, TotalDays: 2.0, TurnDays: 1.0, ReadyDays: 1.0, IsFirstTimer: true }),
    ];

    const ranking = extractFirstTimerFastestRanking(tied);
    expect(ranking.totalCount).toBe(3);
    expect(ranking.items.map((i) => i.Number)).toEqual([303, 301, 302]);
    expect(extractFirstTimerFastestRanking([])).toEqual({ totalCount: 0, items: [] });
  });
});
