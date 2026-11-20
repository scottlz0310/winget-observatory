import { describe, expect, test } from "bun:test";
import {
  DEFAULT_METADATA_REFRESH_BUDGET,
  DEFAULT_SAMPLE_CACHE_RETENTION_DAYS,
  extractFirstTimerFastestRanking,
  FIRST_TIMER_FASTEST_RANKING_LIMIT,
  FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS,
  FIRST_TIMER_FASTEST_RANKING_MIN_VERSION,
  FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS,
  fromCachedSample,
  indexSampleCache,
  parseSampleCache,
  pruneSampleCache,
  selectMetadataRefreshCandidates,
  serializeSampleCacheEntries,
  summarizeSampleCacheVersions,
  toCachedSample,
} from "../../src/domain/sample-cache";
import {
  DEFAULT_METADATA_REFRESH_BUDGET as DIRECT_DEFAULT_METADATA_REFRESH_BUDGET,
  DEFAULT_SAMPLE_CACHE_RETENTION_DAYS as DIRECT_DEFAULT_SAMPLE_CACHE_RETENTION_DAYS,
  FIRST_TIMER_FASTEST_RANKING_LIMIT as DIRECT_FIRST_TIMER_FASTEST_RANKING_LIMIT,
  FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS as DIRECT_FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS,
  FIRST_TIMER_FASTEST_RANKING_MIN_VERSION as DIRECT_FIRST_TIMER_FASTEST_RANKING_MIN_VERSION,
  FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS as DIRECT_FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS,
  extractFirstTimerFastestRanking as directExtractFirstTimerFastestRanking,
  indexSampleCache as directIndexSampleCache,
  pruneSampleCache as directPruneSampleCache,
  selectMetadataRefreshCandidates as directSelectMetadataRefreshCandidates,
  summarizeSampleCacheVersions as directSummarizeSampleCacheVersions,
} from "../../src/domain/sample-cache-maintenance";
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

  test("Author / AuthorType / AuthorAssociation と IsFirstTimer を含むサンプルも相互変換できる", () => {
    const sampleWithFirstTimer: MergedCandidateSample = {
      ...sample,
      author: "firstTimerUser",
      authorType: "User",
      authorAssociation: "CONTRIBUTOR",
      isFirstTimer: true,
      firstTimerReason: undefined,
      firstTimerVersion: 6,
    };
    const cached = toCachedSample(sampleWithFirstTimer);
    expect(cached.Author).toBe("firstTimerUser");
    expect(cached.AuthorType).toBe("User");
    expect(cached.AuthorAssociation).toBe("CONTRIBUTOR");
    expect(cached.IsFirstTimer).toBe(true);
    expect(cached.FirstTimerVersion).toBe(6);
    expect(fromCachedSample(cached)).toEqual(sampleWithFirstTimer);
  });

  test("FirstTimerReason（timeline-blocking / privileged-or-bot 等）を含む除外サンプルも相互変換できる", () => {
    const sampleExcluded: MergedCandidateSample = {
      ...sample,
      author: "blockedUser",
      authorType: "User",
      authorAssociation: "MEMBER",
      isFirstTimer: false,
      firstTimerReason: "privileged-or-bot",
      firstTimerVersion: 6,
    };
    const cached = toCachedSample(sampleExcluded);
    expect(cached.Author).toBe("blockedUser");
    expect(cached.AuthorType).toBe("User");
    expect(cached.AuthorAssociation).toBe("MEMBER");
    expect(cached.IsFirstTimer).toBe(false);
    expect(cached.FirstTimerReason).toBe("privileged-or-bot");
    expect(cached.FirstTimerVersion).toBe(6);
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
      "AuthorType が文字列ではない",
      `${JSON.stringify(entry({ AuthorType: 123 }))}\n`,
      "AuthorType が文字列ではありません",
    ],
    [
      "AuthorAssociation が文字列ではない",
      `${JSON.stringify(entry({ AuthorAssociation: true }))}\n`,
      "AuthorAssociation が文字列ではありません",
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
  const fixedNow = new Date("2026-11-19T00:00:00Z");

  test("Type=sample のみ対象・Number重複は後続行優先・有効な初回提出者を TotalDays 昇順 TOP 10 で抽出する（複数コミットも許容）", () => {
    const firstTimerEntries: CachedSampleEntry[] = Array.from({ length: 12 }, (_, idx) =>
      entry({
        Number: 100 + idx,
        Title: `FT #${100 + idx}`,
        CommitCount: (idx % 3) + 1, // 1〜3 コミットの通常調整ケースを混在させる
        TotalDays: 20 - idx, // 20, 19, ..., 9 -> 昇順では 111(9日), 110(10日), ..., 102(18日) が上位10件
        TurnDays: 1.5,
        ReadyDays: 1.0,
        IsFirstTimer: true,
        FirstTimerVersion: 7,
        CreatedAt: "2026-10-15T00:00:00.000Z", // 90日窓内
        MergedAt: "2026-11-01T00:00:00.000Z",
      }),
    );

    const mixedEntries: SampleCacheEntry[] = [
      // 先に IsFirstTimer=true で記録されたが、後続行で false に再評価された -> 除外されること
      entry({
        Number: 201,
        Title: "Disqualified later",
        TotalDays: 0.6,
        ReadyDays: 0.6,
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      }),
      // 先に IsFirstTimer=false だったが、後続行で true かつ TotalDays=0.8 に更新 -> 採用され1位になること
      entry({
        Number: 202,
        Title: "Promoted later old",
        TotalDays: 50,
        ReadyDays: 1.0,
        IsFirstTimer: false,
        FirstTimerVersion: 6,
      }),
      // skipped 行、IsFirstTimer=false、IsFirstTimer 未設定 -> 除外
      { Type: "skipped", Number: 203, MergedAt: "2026-10-01T00:00:00Z", Reason: "no-ready" },
      entry({
        Number: 204,
        TotalDays: 0.8,
        ReadyDays: 0.8,
        IsFirstTimer: false,
        FirstTimerVersion: 7,
      }),
      entry({ Number: 205, TotalDays: 0.8, ReadyDays: 0.8, FirstTimerVersion: 7 }), // IsFirstTimer undefined
      ...firstTimerEntries,
      // 後続行の上書き
      entry({
        Number: 201,
        Title: "Disqualified now",
        TotalDays: 0.6,
        ReadyDays: 0.6,
        IsFirstTimer: false,
        FirstTimerVersion: 7,
      }),
      entry({
        Number: 202,
        Title: "Promoted later new",
        TotalDays: 0.8,
        ReadyDays: 0.7,
        CommitCount: 2,
        AuthorAssociation: "CONTRIBUTOR",
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      }),
    ];

    const ranking = extractFirstTimerFastestRanking(mixedEntries, { now: fixedNow });
    expect(ranking.windowDays).toBe(90);
    expect(ranking.totalCount).toBe(13); // firstTimerEntries 12件 + #202 1件
    expect(ranking.items).toHaveLength(10);
    expect(ranking.items.map((item) => item.Number)).toEqual([
      202, 111, 110, 109, 108, 107, 106, 105, 104, 103,
    ]);
    expect(ranking.items[0].Title).toBe("Promoted later new");
    expect(ranking.items[0].TotalDays).toBe(0.8);
    expect(ranking.items[0].CommitCount).toBe(2);
  });

  test("同点の TotalDays は TurnDays / ReadyDays / Number の順で安定ソートし、空入力時は 0 件を返す", () => {
    const tied: SampleCacheEntry[] = [
      entry({
        Number: 302,
        TotalDays: 2.0,
        TurnDays: 1.5,
        ReadyDays: 1.0,
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      }),
      entry({
        Number: 301,
        TotalDays: 2.0,
        TurnDays: 1.5,
        ReadyDays: 1.0,
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      }),
      entry({
        Number: 303,
        TotalDays: 2.0,
        TurnDays: 1.0,
        ReadyDays: 1.0,
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      }),
    ];

    const ranking = extractFirstTimerFastestRanking(tied, { now: fixedNow });
    expect(ranking.totalCount).toBe(3);
    expect(ranking.items.map((i) => i.Number)).toEqual([303, 301, 302]);
    expect(extractFirstTimerFastestRanking([], { now: fixedNow })).toEqual({
      totalCount: 0,
      items: [],
      windowDays: 90,
    });
  });

  test.each([
    ["v4 ゾンビキャッシュ (FirstTimerVersion: 4)", { Number: 401, FirstTimerVersion: 4 }],
    [
      "v6 旧ラベル定義キャッシュ（高速枠混入防止）(FirstTimerVersion: 6)",
      { Number: 412, FirstTimerVersion: 6 },
    ],
    [
      "バージョン未設定 (FirstTimerVersion: undefined)",
      { Number: 402, FirstTimerVersion: undefined },
    ],
    ["バイパス即マージ (ReadyDays: 0.49)", { Number: 403, ReadyDays: 0.49, FirstTimerVersion: 7 }],
    ["バイパス即マージ (ReadyDays: 0)", { Number: 404, ReadyDays: 0, FirstTimerVersion: 7 }],
    [
      "90日起票窓外 (91日前起票)",
      { Number: 405, CreatedAt: "2026-08-20T00:00:00Z", FirstTimerVersion: 7 },
    ],
    ["不正な CreatedAt", { Number: 406, CreatedAt: "invalid-date", FirstTimerVersion: 7 }],
    [
      "特権ロール MEMBER",
      { Number: 407, Author: "asklar", AuthorAssociation: "MEMBER", FirstTimerVersion: 7 },
    ],
    [
      "特権ロール OWNER",
      { Number: 408, Author: "owner", AuthorAssociation: "OWNER", FirstTimerVersion: 7 },
    ],
    [
      "特権ロール COLLABORATOR",
      { Number: 409, Author: "collab", AuthorAssociation: "COLLABORATOR", FirstTimerVersion: 7 },
    ],
    [
      "Bot (AuthorType: Bot)",
      { Number: 410, Author: "helper", AuthorType: "Bot", FirstTimerVersion: 7 },
    ],
    ["Bot (login 末尾 [bot])", { Number: 411, Author: "renovate[bot]", FirstTimerVersion: 7 }],
  ])("不純物はランキングから除外される: %s", (_name, overrides) => {
    const target = entry({
      TotalDays: 0.6,
      TurnDays: 0.6,
      ReadyDays: 0.6,
      CreatedAt: "2026-10-20T00:00:00Z",
      IsFirstTimer: true,
      ...overrides,
    });
    const ranking = extractFirstTimerFastestRanking([target], { now: fixedNow });
    expect(ranking.totalCount).toBe(0);
    expect(ranking.items).toEqual([]);
  });

  test("境界値（ReadyDays=0.5 / v7 / ちょうど90日前 / CONTRIBUTOR / 複数コミット）とオプション上書きが正しく動作する", () => {
    const boundaryEntries: SampleCacheEntry[] = [
      // ちょうど 90 日前（2026-08-21T00:00:00Z）かつ ReadyDays === 0.5, v7, CONTRIBUTOR, 3コミット -> 採用
      entry({
        Number: 501,
        CommitCount: 3,
        TotalDays: 1.0,
        TurnDays: 1.0,
        ReadyDays: 0.5,
        CreatedAt: "2026-08-21T00:00:00Z",
        Author: "contrib",
        AuthorType: "User",
        AuthorAssociation: "CONTRIBUTOR",
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      }),
      // 90日より古い（120日前）
      entry({
        Number: 502,
        CommitCount: 1,
        TotalDays: 0.7,
        TurnDays: 0.7,
        ReadyDays: 0.6,
        CreatedAt: "2026-07-22T00:00:00Z",
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      }),
    ];

    const defaultRanking = extractFirstTimerFastestRanking(boundaryEntries, { now: fixedNow });
    expect(defaultRanking.totalCount).toBe(1);
    expect(defaultRanking.items.map((i) => i.Number)).toEqual([501]);

    // windowDays: 0 で期間無制限、limit: 1 で上限変更
    const allTimeRanking = extractFirstTimerFastestRanking(boundaryEntries, {
      now: fixedNow,
      windowDays: 0,
      limit: 1,
    });
    expect(allTimeRanking.windowDays).toBe(0);
    expect(allTimeRanking.totalCount).toBe(2);
    expect(allTimeRanking.items.map((i) => i.Number)).toEqual([502]);
  });

  test("不正なオプション（負の windowDays / 負の minReadyDays / 無効な now）は RangeError を投げる", () => {
    expect(() => extractFirstTimerFastestRanking([], { windowDays: -1 })).toThrow(RangeError);
    expect(() => extractFirstTimerFastestRanking([], { minReadyDays: -0.1 })).toThrow(RangeError);
    expect(() => extractFirstTimerFastestRanking([], { now: new Date("invalid-date") })).toThrow(
      RangeError,
    );
  });
});

describe("Domain: キャッシュ自己修復（pruneSampleCache / selectMetadataRefreshCandidates / summarizeSampleCacheVersions）", () => {
  const fixedNow = new Date("2026-11-19T00:00:00Z");

  test("pruneSampleCache は TTL 超過（120日超）と走査完了時の検索対象外旧版（v6以下、高速枠除外前等）を削除し、v7は保持する", () => {
    const entries: SampleCacheEntry[] = [
      // 130日前 (TTL 超過で削除)
      entry({
        Number: 1,
        MergedAt: "2026-07-10T00:00:00Z",
        FirstTimerVersion: 7,
      }),
      // 130日前の skipped (TTL 超過で削除)
      {
        Type: "skipped",
        Number: 2,
        MergedAt: "2026-07-10T00:00:00Z",
        Reason: "not-first-timer-candidate",
      },
      // 10日前・検索候補外（Publisher-Verified 等で新クエリ除外）・v6 -> 走査完了時は削除される
      entry({
        Number: 3,
        MergedAt: "2026-11-09T00:00:00Z",
        FirstTimerVersion: 6,
      }),
      // 10日前・検索候補内・v6 (budget 待ち等で残った想定) -> 保持される
      entry({
        Number: 4,
        MergedAt: "2026-11-09T00:00:00Z",
        FirstTimerVersion: 6,
      }),
      // 100日前（scanSince=90日前 より前かつ TTL=120日 内）・検索候補外・v4 -> scanSince 前なので保持
      entry({
        Number: 5,
        MergedAt: "2026-08-10T00:00:00Z",
        FirstTimerVersion: 4,
      }),
      // 10日前・検索候補外・v7 -> v7 以上なので保持
      entry({
        Number: 6,
        MergedAt: "2026-11-09T00:00:00Z",
        FirstTimerVersion: 7,
      }),
    ];

    // 走査不完全（scanComplete: false）の場合は TTL 超過のみ削除し、候補外旧版 #3 は残す
    const incomplete = pruneSampleCache(entries, {
      now: fixedNow,
      retentionDays: 120,
      scannedCandidateNumbers: new Set([4]),
      scanComplete: false,
      scanSinceDate: new Date("2026-08-21T00:00:00Z"),
    });
    expect(incomplete.ttlRemovedCount).toBe(2);
    expect(incomplete.staleRemovedCount).toBe(0);
    expect(incomplete.entries.map((e) => e.Number)).toEqual([3, 4, 5, 6]);

    // 走査完了（scanComplete: true）の場合は候補外旧版 #3 (v6) も安全に削除される
    const complete = pruneSampleCache(entries, {
      now: fixedNow,
      retentionDays: 120,
      scannedCandidateNumbers: new Set([4]),
      scanComplete: true,
      scanSinceDate: new Date("2026-08-21T00:00:00Z"),
    });
    expect(complete.ttlRemovedCount).toBe(2);
    expect(complete.staleRemovedCount).toBe(1);
    expect(complete.entries.map((e) => e.Number)).toEqual([4, 5, 6]);
  });

  test("pruneSampleCache は retentionDays=0 で TTL を無効化し、不正値で RangeError を投げる", () => {
    const oldEntry = entry({ Number: 10, MergedAt: "2025-01-01T00:00:00Z", FirstTimerVersion: 6 });
    const res = pruneSampleCache([oldEntry], { now: fixedNow, retentionDays: 0 });
    expect(res.ttlRemovedCount).toBe(0);
    expect(res.entries).toHaveLength(1);

    expect(() => pruneSampleCache([], { retentionDays: -1 })).toThrow(RangeError);
    expect(() => pruneSampleCache([], { now: new Date("invalid") })).toThrow(RangeError);
    expect(() => pruneSampleCache([], { scanSinceDate: new Date("invalid") })).toThrow(RangeError);
  });

  test("selectMetadataRefreshCandidates は中間世代から初回候補・新着優先で budget 件抽出し、将来バージョン（v8等）にも汎用対応する", () => {
    const list: SampleCacheEntry[] = [
      entry({
        Number: 1,
        MergedAt: "2026-11-18T00:00:00Z",
        FirstTimerVersion: 6,
        IsFirstTimer: true,
      }),
      entry({
        Number: 2,
        MergedAt: "2026-11-18T00:00:00Z",
        FirstTimerVersion: 8,
        IsFirstTimer: true,
      }),
      entry({
        Number: 3,
        MergedAt: "2026-07-01T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: true,
      }),
      entry({
        Number: 4,
        MergedAt: "2026-11-10T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: false,
        FirstTimerReason: "lifetime-merged",
      }),
      entry({
        Number: 5,
        MergedAt: "2026-11-12T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: true,
      }),
      entry({
        Number: 6,
        MergedAt: "2026-11-18T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: true,
      }),
      { Type: "skipped", Number: 7, MergedAt: "2026-11-18T00:00:00Z", Reason: "no-ready" },
    ];

    expect(
      selectMetadataRefreshCandidates(list, { now: fixedNow, windowDays: 90, budget: 0 }),
    ).toEqual([]);

    // 現行既定値（minReadyVersion: 7, targetVersion: 7）では中間世代は 0 件（v6 以下は要再計測）
    expect(
      selectMetadataRefreshCandidates(list, { now: fixedNow, windowDays: 90, budget: 10 }),
    ).toEqual([]);

    // 将来 targetVersion: 8 へ上げた場合、v7 (#6, #5, #4) が初回・新着優先で段階移行対象として選ばれる
    const picked = selectMetadataRefreshCandidates(list, {
      now: fixedNow,
      windowDays: 90,
      budget: 2,
      targetVersion: 8,
    });
    expect(picked.map((e) => e.Number)).toEqual([6, 5]);

    const pickedAll = selectMetadataRefreshCandidates(list, {
      now: fixedNow,
      windowDays: 90,
      budget: 10,
      targetVersion: 8,
    });
    expect(pickedAll.map((e) => e.Number)).toEqual([6, 5, 4]);

    // 将来 targetVersion: 9 へ上げた場合、v8 (#2) も自動的に対象に含まれる
    const futurePicked = selectMetadataRefreshCandidates(list, {
      now: fixedNow,
      windowDays: 90,
      budget: 10,
      targetVersion: 9,
    });
    expect(futurePicked.map((e) => e.Number)).toEqual([6, 2, 5, 4]);
  });

  test("summarizeSampleCacheVersions は世代別内訳と直近窓内の補完残件数を正しく集計する", () => {
    const list: SampleCacheEntry[] = [
      entry({ Number: 1, MergedAt: "2026-11-18T00:00:00Z", FirstTimerVersion: 6 }),
      entry({ Number: 2, MergedAt: "2026-11-18T00:00:00Z", FirstTimerVersion: 7 }),
      entry({ Number: 3, MergedAt: "2026-07-01T00:00:00Z", FirstTimerVersion: 7 }),
      entry({ Number: 4, MergedAt: "2026-11-18T00:00:00Z", FirstTimerVersion: 8 }),
      { Type: "skipped", Number: 5, MergedAt: "2026-11-18T00:00:00Z", Reason: "no-ready" },
    ];

    expect(summarizeSampleCacheVersions(list, { now: fixedNow, windowDays: 90 })).toEqual({
      totalUnique: 5,
      sampleCount: 4,
      skippedCount: 1,
      legacyBeforeReadyCount: 1,
      intermediateCount: 0,
      currentCount: 3,
      windowRefreshRemainingCount: 0,
    });

    // 将来 targetVersion: 8 移行時の中間世代内訳も正しく集計する
    expect(
      summarizeSampleCacheVersions(list, { now: fixedNow, windowDays: 90, targetVersion: 8 }),
    ).toEqual({
      totalUnique: 5,
      sampleCount: 4,
      skippedCount: 1,
      legacyBeforeReadyCount: 1,
      intermediateCount: 2,
      currentCount: 1,
      windowRefreshRemainingCount: 1,
    });
  });

  test("selectMetadataRefreshCandidates と summarizeSampleCacheVersions は再評価待ち（timeline-blocking 等）を補完対象から除外する", () => {
    const fixedNow = new Date("2026-11-20T00:00:00Z");
    const list: SampleCacheEntry[] = [
      // タイムライン阻害中で再評価待ち -> 軽量補完だけで上位版へ昇格させてはいけない
      entry({
        Number: 10,
        MergedAt: "2026-11-18T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: false,
        FirstTimerReason: "timeline-blocking",
      }),
      // 複数コミット理由未確定（要再評価） -> 除外
      entry({
        Number: 11,
        MergedAt: "2026-11-18T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: false,
        CommitCount: 3,
      }),
      // 初回提出者確定済みの中間版（将来 targetVersion: 8 移行時） -> 補完対象
      entry({
        Number: 12,
        MergedAt: "2026-11-18T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: true,
        FirstTimerReason: "first-timer",
      }),
      // 常連理由確定済みの中間版（将来 targetVersion: 8 移行時） -> 補完対象
      entry({
        Number: 13,
        MergedAt: "2026-11-17T00:00:00Z",
        FirstTimerVersion: 7,
        IsFirstTimer: false,
        FirstTimerReason: "lifetime-merged",
      }),
    ];

    const picked = selectMetadataRefreshCandidates(list, {
      now: fixedNow,
      windowDays: 90,
      budget: 10,
      targetVersion: 8,
    });
    expect(picked.map((e) => e.Number)).toEqual([12, 13]);

    expect(
      summarizeSampleCacheVersions(list, { now: fixedNow, windowDays: 90, targetVersion: 8 }),
    ).toEqual({
      totalUnique: 4,
      sampleCount: 4,
      skippedCount: 0,
      legacyBeforeReadyCount: 2,
      intermediateCount: 2,
      currentCount: 0,
      windowRefreshRemainingCount: 2,
    });
  });

  test("sample-cache-maintenance.ts のエクスポートと sample-cache.ts の互換 re-export が完全一致する", () => {
    expect(FIRST_TIMER_FASTEST_RANKING_LIMIT).toBe(DIRECT_FIRST_TIMER_FASTEST_RANKING_LIMIT);
    expect(FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS).toBe(
      DIRECT_FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS,
    );
    expect(FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS).toBe(
      DIRECT_FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS,
    );
    expect(FIRST_TIMER_FASTEST_RANKING_MIN_VERSION).toBe(
      DIRECT_FIRST_TIMER_FASTEST_RANKING_MIN_VERSION,
    );
    expect(DEFAULT_SAMPLE_CACHE_RETENTION_DAYS).toBe(DIRECT_DEFAULT_SAMPLE_CACHE_RETENTION_DAYS);
    expect(DEFAULT_METADATA_REFRESH_BUDGET).toBe(DIRECT_DEFAULT_METADATA_REFRESH_BUDGET);
    expect(indexSampleCache).toBe(directIndexSampleCache);
    expect(extractFirstTimerFastestRanking).toBe(directExtractFirstTimerFastestRanking);
    expect(pruneSampleCache).toBe(directPruneSampleCache);
    expect(selectMetadataRefreshCandidates).toBe(directSelectMetadataRefreshCandidates);
    expect(summarizeSampleCacheVersions).toBe(directSummarizeSampleCacheVersions);
  });
});
