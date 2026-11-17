import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { buildDashboard, enrichProgressSamplesWithCache } from "../scripts/build-pages";
import {
  formatCreatedToMergedRange,
  formatSamplePackageName,
  renderSamplesSection,
  summarizeRecentSamplesPace,
} from "../scripts/pages/sections/stats-and-samples";
import type { ProgressSnapshotSample } from "../src/models/progress";
import type { SampleCacheEntry } from "../src/models/sample-cache";

function makeSample(overrides: Partial<ProgressSnapshotSample> = {}): ProgressSnapshotSample {
  return {
    Number: 100,
    Title: "New package: Vendor.App version 1.0.0",
    Relation: "older",
    CommitCount: 1,
    CreatedAt: "2026-10-10T00:00:00Z",
    LatestCommittedDate: "2026-10-10T01:00:00Z",
    ReadyAt: "2026-10-11T00:00:00Z",
    MergedAt: "2026-11-10T00:00:00Z",
    TotalDays: 31.0,
    TurnDays: 30.9,
    ReadyDays: 30.0,
    IsFirstTimer: true,
    ...overrides,
  };
}

describe("Pages: 直近サンプル集計・整形ヘルパー", () => {
  test("summarizeRecentSamplesPace は初回のみ・同条件・手直し有無比較を正しく算出する", () => {
    const samples: ProgressSnapshotSample[] = [
      // 初回 x 1コミット: TotalDays 10, 20, 30 -> P50 = 20.0
      makeSample({ Number: 1, IsFirstTimer: true, CommitCount: 1, TotalDays: 10 }),
      makeSample({ Number: 2, IsFirstTimer: true, CommitCount: 1, TotalDays: 20 }),
      makeSample({ Number: 3, IsFirstTimer: true, CommitCount: 1, TotalDays: 30 }),
      // 初回 x 複数コミット: TotalDays 40, 50 -> 初回全体 P50 = 30.0
      makeSample({ Number: 4, IsFirstTimer: true, CommitCount: 3, TotalDays: 40 }),
      makeSample({ Number: 5, IsFirstTimer: true, CommitCount: 4, TotalDays: 50 }),
      // 常連 x 1コミット: TotalDays 2 -> 1コミット全体 [2, 10, 20, 30] -> P50 = 15.0
      makeSample({ Number: 6, IsFirstTimer: false, CommitCount: 1, TotalDays: 2 }),
      // 常連 x 複数コミット: TotalDays 6 -> 複数コミット全体 [6, 40, 50] -> P50 = 40.0
      makeSample({ Number: 7, IsFirstTimer: false, CommitCount: 2, TotalDays: 6 }),
      // 未判定 x 複数コミット: TotalDays 8 -> 複数コミット全体 [6, 8, 40, 50] -> P50 = 24.0
      makeSample({ Number: 8, IsFirstTimer: undefined, CommitCount: 2, TotalDays: 8 }),
    ];

    const summary = summarizeRecentSamplesPace(samples);
    expect(summary.totalCount).toBe(8);
    expect(summary.firstTimerCount).toBe(5);
    expect(summary.firstTimerMedianDays).toBe(30);
    expect(summary.sameConditionCount).toBe(3);
    expect(summary.sameConditionMedianDays).toBe(20);
    expect(summary.singleCommitCount).toBe(4);
    expect(summary.singleCommitRatePct).toBe(50);
    expect(summary.singleCommitMedianDays).toBe(15);
    expect(summary.multiCommitCount).toBe(4);
    expect(summary.multiCommitMedianDays).toBe(24);
  });

  test("summarizeRecentSamplesPace は該当 0 件のグループを null で返す", () => {
    const empty = summarizeRecentSamplesPace([]);
    expect(empty).toEqual({
      totalCount: 0,
      firstTimerCount: 0,
      firstTimerMedianDays: null,
      sameConditionCount: 0,
      sameConditionMedianDays: null,
      singleCommitCount: 0,
      singleCommitRatePct: null,
      singleCommitMedianDays: null,
      multiCommitCount: 0,
      multiCommitMedianDays: null,
    });

    const onlyRepeatMulti = summarizeRecentSamplesPace([
      makeSample({ IsFirstTimer: false, CommitCount: 3, TotalDays: 12 }),
    ]);
    expect(onlyRepeatMulti.firstTimerMedianDays).toBeNull();
    expect(onlyRepeatMulti.sameConditionMedianDays).toBeNull();
    expect(onlyRepeatMulti.singleCommitRatePct).toBe(0);
    expect(onlyRepeatMulti.singleCommitMedianDays).toBeNull();
    expect(onlyRepeatMulti.multiCommitMedianDays).toBe(12);
  });

  test.each([
    [
      "New package: Zubyr.Devpit version 0.1.0",
      {
        displayName: "Zubyr.Devpit version 0.1.0",
        fullTitle: "New package: Zubyr.Devpit version 0.1.0",
      },
    ],
    [
      "New version: Foo.Bar version 2.0",
      { displayName: "Foo.Bar version 2.0", fullTitle: "New version: Foo.Bar version 2.0" },
    ],
    [
      "dagaza.Qube.CUDA 1.3.53",
      { displayName: "dagaza.Qube.CUDA 1.3.53", fullTitle: "dagaza.Qube.CUDA 1.3.53" },
    ],
    [undefined, { displayName: "", fullTitle: "" }],
  ])("formatSamplePackageName: %j", (input, expected) => {
    expect(formatSamplePackageName(input)).toEqual(expected);
  });

  test("formatCreatedToMergedRange は JST 暦日境界で基準 PR 起票日との日差を計算する（同日内時刻差・日跨ぎ短時間差）", () => {
    // 基準 10/29 23:50 JST (2026-10-29T14:50:00Z) vs サンプル 10/30 00:10 JST (2026-10-29T15:10:00Z) -> 20分差でも翌日 +1日
    const nextDay = formatCreatedToMergedRange(
      "2026-10-29T15:10:00Z",
      "2026-11-16T20:00:00Z",
      Date.parse("2026-10-29T14:50:00Z"),
    );
    expect(nextDay.rangeText).toBe("10/30 → 11/17");
    expect(nextDay.diffText).toBe("基準より +1日");
    expect(nextDay.isOvertakenByCreated).toBeTrue();

    // 逆方向: 基準 10/30 00:10 JST vs サンプル 10/29 23:50 JST -> 20分差でも前日 -1日
    const prevDay = formatCreatedToMergedRange(
      "2026-10-29T14:50:00Z",
      "2026-11-16T20:00:00Z",
      Date.parse("2026-10-29T15:10:00Z"),
    );
    expect(prevDay.rangeText).toBe("10/29 → 11/17");
    expect(prevDay.diffText).toBe("基準より -1日");
    expect(prevDay.isOvertakenByCreated).toBeFalse();

    // 同日内の時刻差: 基準 10/29 00:10 JST (2026-10-28T15:10:00Z) vs サンプル 10/29 23:50 JST (2026-10-29T14:50:00Z) -> 23時間40分差でも基準と同日
    const sameJstDay = formatCreatedToMergedRange(
      "2026-10-29T14:50:00Z",
      "2026-11-16T20:00:00Z",
      Date.parse("2026-10-28T15:10:00Z"),
    );
    expect(sameJstDay.rangeText).toBe("10/29 → 11/17");
    expect(sameJstDay.diffText).toBe("基準と同日");
    expect(sameJstDay.isOvertakenByCreated).toBeTrue();

    // 日差が大きいケース（09/23 vs 10/29 -> -36日）
    const targetCreatedMs = Date.parse("2026-10-28T21:47:38Z"); // 10/29 06:47 JST
    const earlier = formatCreatedToMergedRange(
      "2026-09-22T20:00:00Z",
      "2026-11-16T20:00:00Z",
      targetCreatedMs,
    );
    expect(earlier.rangeText).toBe("09/23 → 11/17");
    expect(earlier.diffText).toBe("基準より -36日");
    expect(earlier.isOvertakenByCreated).toBeFalse();

    const missingTarget = formatCreatedToMergedRange(
      "2026-09-22T20:00:00Z",
      "2026-11-16T20:00:00Z",
      null,
    );
    expect(missingTarget.rangeText).toBe("09/23 → 11/17");
    expect(missingTarget.diffText).toBe("");
    expect(missingTarget.isOvertakenByCreated).toBeNull();
  });
});

describe("Pages: enrichProgressSamplesWithCache & renderSamplesSection", () => {
  test("merged-samples.jsonl から欠落した Title / CreatedAt を補完し、既存値は上書きしない", () => {
    const progress = {
      Samples: [
        {
          Number: 9001,
          Title: "",
          CreatedAt: "",
          Relation: "older" as const,
          CommitCount: 1,
          LatestCommittedDate: "2026-11-10T00:00:00Z",
          ReadyAt: "2026-11-10T01:00:00Z",
          MergedAt: "2026-11-11T00:00:00Z",
          TotalDays: 11,
          TurnDays: 1,
          ReadyDays: 0.9,
          IsFirstTimer: true,
        },
        {
          Number: 9002,
          Title: "Keep existing title",
          CreatedAt: "2026-10-05T00:00:00Z",
          Relation: "older" as const,
          CommitCount: 2,
          LatestCommittedDate: "2026-11-10T00:00:00Z",
          ReadyAt: "2026-11-10T01:00:00Z",
          MergedAt: "2026-11-11T00:00:00Z",
          TotalDays: 37,
          TurnDays: 1,
          ReadyDays: 0.9,
          IsFirstTimer: false,
        },
      ],
    };

    const cacheEntries: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 9001,
        Title: "New package: Restored.Pkg version 1.0",
        CreatedAt: "2026-10-31T00:00:00Z",
        LatestCommittedDate: "2026-11-10T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-11-10T01:00:00Z",
        MergedAt: "2026-11-11T00:00:00Z",
        TotalDays: 11,
        TurnDays: 1,
        ReadyDays: 0.9,
        IsFirstTimer: true,
      },
      {
        Type: "sample",
        Number: 9002,
        Title: "Should not override",
        CreatedAt: "2026-09-01T00:00:00Z",
        LatestCommittedDate: "2026-11-10T00:00:00Z",
        CommitCount: 2,
        ReadyAt: "2026-11-10T01:00:00Z",
        MergedAt: "2026-11-11T00:00:00Z",
        TotalDays: 37,
        TurnDays: 1,
        ReadyDays: 0.9,
        IsFirstTimer: false,
      },
    ];

    const enriched = enrichProgressSamplesWithCache(progress, cacheEntries);
    expect(enriched?.Samples?.[0]?.Title).toBe("New package: Restored.Pkg version 1.0");
    expect(enriched?.Samples?.[0]?.CreatedAt).toBe("2026-10-31T00:00:00Z");
    expect(enriched?.Samples?.[1]?.Title).toBe("Keep existing title");
    expect(enriched?.Samples?.[1]?.CreatedAt).toBe("2026-10-05T00:00:00Z");
  });

  test("通過ペースサマリー・3種フィルタボタン・6列テーブル・後発バッジ・HTMLエスケープ・JS構文を出力する", () => {
    const targetCreatedAtMs = Date.parse("2026-10-28T21:47:38Z");
    const samples: ProgressSnapshotSample[] = [
      makeSample({
        Number: 439519,
        Title: "New package: Zubyr.Devpit <script> version 0.1.0",
        Relation: "older",
        CommitCount: 1,
        CreatedAt: "2026-09-22T20:00:00Z",
        MergedAt: "2026-11-16T20:00:00Z",
        TotalDays: 54.9,
        TurnDays: 54.9,
        ReadyDays: 12.5,
        IsFirstTimer: true,
      }),
      makeSample({
        Number: 465000,
        Title: "New version: Fast.Runner version 2.0",
        Relation: "newer",
        CommitCount: 3,
        CreatedAt: "2026-11-02T21:47:38Z",
        MergedAt: "2026-11-16T20:00:00Z",
        TotalDays: 14.0,
        TurnDays: 2.0,
        ReadyDays: 1.5,
        IsFirstTimer: false,
      }),
      makeSample({
        Number: 464303,
        Title: "SameDay.FirstTimer",
        Relation: "newer",
        CommitCount: 2,
        CreatedAt: "2026-10-29T00:00:00Z", // 10/29 09:00 JST (基準と同日)
        MergedAt: "2026-11-16T20:00:00Z",
        TotalDays: 18.0,
        TurnDays: 3.0,
        ReadyDays: 2.0,
        IsFirstTimer: true,
      }),
    ];

    const html = renderSamplesSection(
      { SampleCount: 3, Samples: samples },
      "microsoft/winget-pkgs",
      targetCreatedAtMs,
    );

    // サマリーカード
    expect(html).toContain("🌱 初回のみ（直近出口 P50）");
    expect(html).toContain("36.5 日");
    expect(html).toContain("🎯 同条件（初回 × 1 コミット）P50");
    expect(html).toContain("54.9 日");
    expect(html).toContain("✏️ 手直し有無の比較（直近サンプル内）");
    expect(html).toContain("1コミット完走率: 33%");

    // フィルタボタン & 空状態
    expect(html).toContain('data-sample-filter="all" aria-pressed="true">すべて');
    expect(html).toContain("(3)");
    expect(html).toContain('data-sample-filter="first-timer" aria-pressed="false">🌱 初回のみ');
    expect(html).toContain("(2)");
    expect(html).toContain(
      'data-sample-filter="first-timer-single" aria-pressed="false">🎯 同条件: 初回×1コミット',
    );
    expect(html).toContain("(1)");
    expect(html).toContain("該当するサンプルはありません");

    // 列構造（作成順列は廃止、新 6 列 + nowrap）
    expect(html).not.toContain("<th>作成順</th>");
    expect(html).toContain("<th>PR / パッケージ</th>");
    expect(html).toContain('<th class="sample-nowrap">コホート / コミット</th>');
    expect(html).toContain('<th class="sample-nowrap">起票 → マージ（起票日差）</th>');
    expect(html).toContain('<th class="sample-nowrap">通算日数</th>');
    expect(html).toContain('<th class="sample-nowrap">レビュー待ち</th>');
    expect(html).toContain('<th class="sample-nowrap">成立後</th>');

    // パッケージ名短縮 + ホバーフルタイトル + エスケープ
    expect(html).toContain("Zubyr.Devpit &lt;script&gt; version 0.1.0");
    expect(html).toContain('title="New package: Zubyr.Devpit &lt;script&gt; version 0.1.0"');
    expect(html).not.toContain("<script> version");
    expect(html).toContain("Fast.Runner version 2.0");

    // 同条件行・初回行の強調と後発バッジ・暦日差
    expect(html).toContain('class="sample-row-same-condition"');
    expect(html).toContain('class="sample-row-first-timer"');
    expect(html).toContain("1回");
    expect(html).toContain("3回");
    expect(html).toContain("09/23 → 11/17");
    expect(html).toContain("基準より -36日");
    expect(html).toContain("11/03 → 11/17");
    expect(html).toContain("基準より +5日");
    expect(html).toContain("基準と同日");
    expect(html).toContain("⚡後発");
    // 基準より前の PR 439519 の行には ⚡後発 を付けない
    const row439519 = html.slice(html.indexOf("#439519"), html.indexOf("#465000"));
    expect(row439519).not.toContain("⚡後発");

    // インラインスクリプトの構文チェックおよびフィルタ動作検証
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    expect(() => new vm.Script(scriptMatch?.[1] ?? "")).not.toThrow();

    // 該当 0 件時に空状態表示になることも確認
    const zeroSingleHtml = renderSamplesSection(
      {
        SampleCount: 1,
        Samples: [makeSample({ Number: 500, IsFirstTimer: false, CommitCount: 2 })],
      },
      "microsoft/winget-pkgs",
      targetCreatedAtMs,
    );
    expect(zeroSingleHtml).toContain("🎯 同条件: 初回×1コミット");
    expect(zeroSingleHtml).toContain("(0)");
  });

  test("buildDashboard は Title / CreatedAt 欠落サンプルを merged-samples.jsonl から補完して描画する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-samples-enrich-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    try {
      writeFileSync(
        join(dataDir, "latest-progress.json"),
        JSON.stringify({
          Timestamp: "2026-11-17T03:00:00Z",
          TargetPr: 464302,
          SampleCount: 1,
          Samples: [
            {
              Number: 439519,
              Relation: "older",
              CommitCount: 1,
              LatestCommittedDate: "2026-09-23T04:50:38.000Z",
              MergedAt: "2026-11-17T03:07:51.000Z",
              TotalDays: 54.93,
              TurnDays: 54.93,
              ReadyDays: 12.47,
              IsFirstTimer: true,
            },
          ],
        }),
        "utf-8",
      );
      writeFileSync(
        join(dataDir, "latest-depths.json"),
        JSON.stringify({
          TargetPr: { Number: 464302, CreatedAt: "2026-10-28T21:47:38Z" },
        }),
        "utf-8",
      );
      writeFileSync(
        join(dataDir, "merged-samples.jsonl"),
        `${JSON.stringify({
          Type: "sample",
          Number: 439519,
          Title: "New package: Zubyr.Devpit version 0.1.0",
          CreatedAt: "2026-09-23T04:50:42Z",
          LatestCommittedDate: "2026-09-23T04:50:38.000Z",
          CommitCount: 1,
          ReadyAt: "2026-11-04T15:45:44.000Z",
          MergedAt: "2026-11-17T03:07:51.000Z",
          TotalDays: 54.93,
          TurnDays: 54.93,
          ReadyDays: 12.47,
          IsFirstTimer: true,
        })}\n`,
        "utf-8",
      );

      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");
      const samplesSection = html.slice(html.indexOf("🧪 比較に使ったサンプル"));
      expect(samplesSection).toContain("Zubyr.Devpit version 0.1.0");
      expect(samplesSection).toContain("09/23 → 11/17");
      expect(samplesSection).toContain("基準より -36日");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
