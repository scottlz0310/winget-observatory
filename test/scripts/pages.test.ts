import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  formatDaysStat,
  formatErrorDays,
  formatEtaDays,
  formatNumber,
  renderBadgeHtml,
} from "../../scripts/pages/formatters";
import {
  buildBandTimelineMarkers,
  renderIntegratedForecastHero,
} from "../../scripts/pages/sections/hero-and-kpi";
import { generateDashboardHtml } from "../../scripts/pages/template";
import { buildForecastBandSource, calculateForecastBand } from "../../src/domain/forecast-band";
import { DAY_MS } from "../../src/domain/formatters";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "../../src/domain/intervention";
import {
  calculateProgressStats,
  createProgressSnapshot,
  partitionSamplesByWindow,
} from "../../src/domain/progress";

describe("scripts/pages/formatters", () => {
  test.each([
    { input: undefined, expected: "-" },
    { input: null, expected: "-" },
    { input: "", expected: "-" },
    { input: "<script>\"&'</script>", expected: "&lt;script&gt;&quot;&amp;&#039;&lt;/script&gt;" },
    { input: 42, expected: "42" },
  ])("escapeHtml($input) -> $expected", ({ input, expected }) => {
    expect(escapeHtml(input)).toBe(expected);
  });

  test.each([
    { input: undefined, expected: "-" },
    { input: null, expected: "-" },
    { input: "", expected: "-" },
    { input: "not-a-number", expected: "-" },
    { input: 0, expected: "0" },
    { input: 1234, expected: (1234).toLocaleString() },
  ])("formatNumber($input) -> $expected", ({ input, expected }) => {
    expect(formatNumber(input)).toBe(expected);
  });

  test.each([
    { input: 0, expected: "到達済み" },
    { input: 3.5, expected: "約 3.5 日後" },
  ])("formatEtaDays($input) -> $expected", ({ input, expected }) => {
    expect(formatEtaDays(input)).toBe(expected);
  });

  test.each([
    { input: 0, expected: "±0 日" },
    { input: 2.5, expected: "+2.5 日" },
    { input: -1.5, expected: "-1.5 日" },
  ])("formatErrorDays($input) -> $expected", ({ input, expected }) => {
    expect(formatErrorDays(input)).toBe(expected);
  });

  test("formatDaysStat は欠損を '-' 表示、数値を太字で整形する", () => {
    expect(formatDaysStat(null)).toContain(">-<");
    expect(formatDaysStat(undefined)).toContain(">-<");
    expect(formatDaysStat(Number.NaN)).toContain(">-<");
    expect(formatDaysStat(4.2)).toContain("<strong>4.2</strong>");
  });

  test("renderBadgeHtml は属性値とテキストを HTML エスケープする", () => {
    const html = renderBadgeHtml({
      text: "<-2>",
      className: "delta-progress",
      label: '前回比 "改善"',
    });
    expect(html).toBe(
      '<span class="delta-badge delta-progress" title="前回比 &quot;改善&quot;">&lt;-2&gt;</span>',
    );
  });
});

describe("generateDashboardHtml", () => {
  test("I/O なしで空スナップショットから完全な HTML 文書を生成できる", () => {
    const html = generateDashboardHtml({
      progress: null,
      depths: null,
      csvRows: [],
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Winget Observatory Dashboard</title>");
    expect(html).toContain("未観測");
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("renderIntegratedForecastHero & buildBandTimelineMarkers: 前線・本命・大底マーカーとスナップショットを描画する", () => {
    const t0 = Date.parse("2026-11-18T20:05:00Z");
    const created = "2026-10-28T21:47:38Z";
    const band = calculateForecastBand(
      buildForecastBandSource({
        progress: {
          Timestamp: new Date(t0).toISOString(),
          TargetPr: 464302,
          FrontNumber: 436234,
          FrontCreatedAt: "2026-09-17(木) 06:01",
          ActiveAhead: 1609,
          TotalMedianDays: 38.55,
          FirstTimerMedianDays: 31.14,
          FirstTimerP75Days: 39.19,
        },
        depths: {
          DepthsVersion: 4,
          Timestamp: new Date(t0).toISOString(),
          TargetPr: {
            Number: 464302,
            Title: "t",
            Url: "u",
            CreatedAt: created,
            CreatedAtJst: "2026-10-29 06:47",
            UpdatedAt: new Date(t0).toISOString(),
          },
          HealthyBottom: [
            {
              PR: "#436234",
              Number: 436234,
              作成日時: "2026-09-17 06:01",
              更新日時: "2026-11-16 22:32",
              CreatedAt: "2026-09-16T21:01:02Z",
              UpdatedAt: "2026-11-16T13:32:58Z",
              タイトル: "h",
              Title: "h",
              Url: "u1",
            },
          ],
          StaleBottom: [
            {
              PR: "#449390",
              Number: 449390,
              作成日時: "2026-10-09 16:57",
              更新日時: "2026-10-09 17:42",
              CreatedAt: "2026-10-09T07:57:34Z",
              UpdatedAt: "2026-10-09T08:42:30Z",
              タイトル: "s",
              Title: "s",
              Url: "u2",
            },
          ],
        },
        history: [],
        mainstreamFrontierSamples: [
          {
            timestampMs: t0,
            createdMs: t0 - 45.1 * DAY_MS,
            cohortCount: 80,
            openCount: 41,
            mergedCount: 39,
            mode: FIRST_REVIEW_MAINSTREAM_MODE,
          },
        ],
      }),
    );

    const markers = buildBandTimelineMarkers(band);
    expect(markers.map((m) => m.label.slice(0, 4))).toEqual(["▼前線 ", "★本命 ", "▼正常底"]);

    const html = renderIntegratedForecastHero({
      targetPrNum: 464302,
      repo: "microsoft/winget-pkgs",
      progress: {
        ActiveAhead: 1609,
        TotalMedianDays: 38.55,
        SampleCount: 488,
        LookbackDays: 30,
        FirstTimerMedianDays: 31.14,
        FirstTimerP75Days: 39.19,
        Samples: [
          {
            Number: 441393,
            Title: "New package: Sample.App version 1.0",
            Relation: "older",
            CommitCount: 1,
            CreatedAt: "2026-09-26T01:18:25Z",
            LatestCommittedDate: "2026-09-26T01:18:25Z",
            ReadyAt: "2026-09-26T02:00:00Z",
            MergedAt: "2026-11-18T16:15:27Z",
            TotalDays: 53.6,
            TurnDays: 53.6,
            ReadyDays: 53.5,
            Author: "ft-author",
            IsFirstTimer: true,
          },
        ],
      },
      band,
      timelineSvg: "<svg></svg>",
    });
    expect(html).toContain("🎯 基準 PR #464302 着地予測（統合処理バンド）");
    expect(html).toContain("代表中央値:");
    expect(html).toContain("👀 初動前線（主戦場ライン・初回提出者 7日介入中央値）");
    expect(html).toContain("🚀 マージ前線（直近マージ実績・全体 30 日）");
    expect(html).toContain("#441393");
    expect(html).toContain("⚓ 実質待ち順位 / マージ正常底（健康的大底・全体）差");
    expect(html).toContain("マージ正常底（#436234）と差");
    expect(html).toContain("🔍 統合処理バンドの内訳と 2 仮説比較（検証用詳細）");
  });

  test("2×2 待機ラインマトリクスは 4 象限が所定 DOM 順序で描画され、マージ前線は progress.Samples を表示し、レスポンシブ CSS と共通トグルを含む", () => {
    const html = generateDashboardHtml({
      progress: {
        LookbackDays: 30,
        FirstTimerLookbackDays: 90,
        SampleCount: 120,
        FirstTimerSampleCount: 60,
        TotalMedianDays: 38.6,
        FirstTimerMedianDays: 30.8,
        Samples: [
          {
            Number: 200,
            Title: "New package: Merged.All version 1.0",
            Relation: "older",
            CommitCount: 2,
            CreatedAt: "2026-10-05T00:00:00Z",
            LatestCommittedDate: "2026-10-05T00:00:00Z",
            ReadyAt: "2026-10-05T01:00:00Z",
            MergedAt: "2026-11-19T00:00:00Z",
            TotalDays: 45.0,
            TurnDays: 45.0,
            ReadyDays: 44.9,
            Author: "contrib-user",
            IsFirstTimer: false,
          },
          {
            Number: 201,
            Title: "New package: Merged.Ft version 1.0",
            Relation: "older",
            CommitCount: 1,
            CreatedAt: "2026-10-06T00:00:00Z",
            LatestCommittedDate: "2026-10-06T00:00:00Z",
            ReadyAt: "2026-10-06T01:00:00Z",
            MergedAt: "2026-11-18T00:00:00Z",
            TotalDays: 43.0,
            TurnDays: 43.0,
            ReadyDays: 42.9,
            Author: "ft-merged",
            IsFirstTimer: true,
          },
        ],
      },
      depths: {
        DepthsVersion: 6,
        Timestamp: "2026-11-20T00:00:00Z",
        HealthyBottom: [
          {
            PR: "#100",
            Number: 100,
            作成日時: "2026-10-01 09:00",
            更新日時: "2026-11-01 09:00",
            CreatedAt: "2026-10-01T00:00:00Z",
            UpdatedAt: "2026-11-01T00:00:00Z",
            タイトル: "Healthy FT",
            Title: "Healthy FT",
            Url: "https://example.com/100",
            Author: "ft-user",
            AuthorAssociation: "NONE",
            AuthorMergedCount: 0,
            CommitCount: 2,
          },
        ],
        UnreviewedBottom: [
          {
            PR: "#300",
            Number: 300,
            作成日時: "2026-10-10 09:00",
            更新日時: "2026-10-10 09:00",
            CreatedAt: "2026-10-10T00:00:00Z",
            UpdatedAt: "2026-10-10T00:00:00Z",
            タイトル: "Unreviewed",
            Title: "Unreviewed",
            Url: "https://example.com/300",
            Author: "ft-unrev",
            AuthorAssociation: "NONE",
            AuthorMergedCount: 0,
            CommitCount: 3,
          },
        ],
      },
      csvRows: [],
    });

    // レスポンシブ CSS（狭幅 1 カラム & モバイル横溢れ防止）
    expect(html).toContain(".matrix-phase-grid");
    expect(html).toContain("@media (max-width: 960px)");
    expect(html).toContain("@media (max-width: 640px)");
    expect(html).toContain(".table-scroll");

    // 共通フィルタバー（セクション上部）
    expect(html).toContain('data-matrix-filter="all"');
    expect(html).toContain('data-matrix-filter="first-timer"');

    // DOM 順序: 初動前線（主戦場） → 初動正常底（未レビュー最古） → マージ前線（直近マージ実績） → マージ正常底（健康的大底）
    const idx1 = html.indexOf("🎯 初動前線（主戦場ライン・早ければ）");
    const idx2 = html.indexOf("🟦 初動正常底（未レビュー最古・遅くとも）");
    const idx3 = html.indexOf("🚀 マージ前線（直近マージ実績・早ければ）");
    const idx4 = html.indexOf("⚓ マージ正常底（健康的大底・遅くとも）");
    expect(idx1).toBeGreaterThan(-1);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);
    expect(idx4).toBeGreaterThan(idx3);

    // マージ前線の全体／初回提出者ビュー
    const mergeFrontSection = html
      .split("🚀 マージ前線（直近マージ実績・早ければ）")[1]
      .split("⚓ マージ正常底（健康的大底・遅くとも）")[0];
    const mergeFrontAll = mergeFrontSection.split('data-matrix-view="first-timer"')[0];
    const mergeFrontFt = mergeFrontSection.split('data-matrix-view="first-timer"')[1];
    expect(mergeFrontAll).toContain("#200");
    expect(mergeFrontAll).toContain("#201");
    expect(mergeFrontFt).not.toContain("#200");
    expect(mergeFrontFt).toContain("#201");

    // 補助境界テーブルは例外・特殊境界に特化し、健康的大底を重複表示しない
    const boundarySection = html.slice(html.indexOf("🚧 例外・特殊境界（真の大底・特急レーン）"));
    expect(boundarySection).not.toContain(">健康的大底<");
  });

  test("旧スナップショット（HealthyBottom 3件・progress なし・AllAuthorsFirstReviewFrontier なし）でも安全にフォールバック描画する", () => {
    const html = generateDashboardHtml({
      progress: null,
      depths: {
        DepthsVersion: 4,
        Timestamp: "2026-11-18T00:00:00Z",
        HealthyBottom: [
          {
            PR: "#101",
            Number: 101,
            作成日時: "2026-09-10 09:00",
            更新日時: "2026-11-01 09:00",
            CreatedAt: "2026-09-10T00:00:00Z",
            UpdatedAt: "2026-11-01T00:00:00Z",
            タイトル: "Legacy Healthy",
            Title: "Legacy Healthy",
            Url: "https://example.com/101",
          },
        ],
        FirstReviewFrontier: {
          Mode: FIRST_REVIEW_MAINSTREAM_MODE,
          WindowDays: 7,
          CohortCount: 1,
          OpenCount: 1,
          MergedCount: 0,
          MedianCreatedAt: "2026-10-05T00:00:00Z",
          LagDays: 44,
          Items: [],
        },
      },
      csvRows: [],
    });

    expect(html).toContain("#101");
    expect(html).toContain("旧スナップショットのため初回提出者コホートを表示中");
    expect(html).toContain("直近マージ実績のデータはまだありません。");
  });

  test("初動前線の全体表示は収集時の IsFirstTimer 判定を使い、生涯マージ 1 件の MEMBER には初回バッジを付けずキャッシュ由来初回には付与する", () => {
    const html = generateDashboardHtml({
      progress: null,
      depths: {
        DepthsVersion: 5,
        Timestamp: "2026-11-20T00:00:00Z",
        AllAuthorsFirstReviewFrontier: {
          Mode: FIRST_REVIEW_MAINSTREAM_MODE,
          WindowDays: 7,
          CohortCount: 2,
          OpenCount: 0,
          MergedCount: 2,
          MedianCreatedAt: "2026-10-10T00:00:00Z",
          LagDays: 41,
          Items: [
            {
              Number: 7001,
              Title: "New package: Member.App version 1.0",
              Url: "https://example.com/7001",
              State: "MERGED",
              Author: "repo-member",
              AuthorAssociation: "MEMBER",
              AuthorMergedCount: 1,
              IsFirstTimer: false,
              CreatedAt: "2026-10-10T00:00:00Z",
              FirstHumanInterventionAt: "2026-11-18T00:00:00Z",
            },
            {
              Number: 7002,
              Title: "New package: CachedFirstTimer.App version 1.0",
              Url: "https://example.com/7002",
              State: "MERGED",
              Author: "ft-cached",
              AuthorAssociation: "CONTRIBUTOR",
              IsFirstTimer: true,
              CreatedAt: "2026-10-11T00:00:00Z",
              FirstHumanInterventionAt: "2026-11-19T00:00:00Z",
            },
          ],
        },
        FirstReviewFrontier: {
          Mode: FIRST_REVIEW_MAINSTREAM_MODE,
          WindowDays: 7,
          CohortCount: 1,
          OpenCount: 0,
          MergedCount: 1,
          MedianCreatedAt: "2026-10-11T00:00:00Z",
          LagDays: 40,
          Items: [
            {
              Number: 7002,
              Title: "New package: CachedFirstTimer.App version 1.0",
              Url: "https://example.com/7002",
              State: "MERGED",
              Author: "ft-cached",
              AuthorAssociation: "CONTRIBUTOR",
              IsFirstTimer: true,
              CreatedAt: "2026-10-11T00:00:00Z",
              FirstHumanInterventionAt: "2026-11-19T00:00:00Z",
            },
          ],
        },
      },
      csvRows: [],
    });

    const allView = html
      .split("🎯 初動前線（主戦場ライン・早ければ）")[1]
      .split('data-matrix-view="first-timer"')[0];
    const memberRow = allView.split("#7001")[1].split("</tr>")[0];
    const ftRow = allView.split("#7002")[1].split("</tr>")[0];
    expect(memberRow).not.toContain("🌱 初回");
    expect(ftRow).toContain("🌱 初回");
  });

  test("統合時系列チャートは全体・初回提出者の両履歴があるとき右軸トグルと 2 つの切替ビューを生成する", () => {
    const t1 = Date.parse("2026-11-18T00:00:00Z");
    const t2 = Date.parse("2026-11-19T00:00:00Z");
    const html = generateDashboardHtml({
      progress: { TargetPr: 464302, ActiveAhead: 1000 },
      depths: null,
      csvRows: [
        {
          Timestamp: "2026-11-18 09:00:00",
          TargetPr: 464302,
          FrontNumber: 430000,
          FrontCreatedAt: "2026-09-20 09:00",
          ActiveAhead: 1100,
          TotalAhead: 1500,
          Behind: 200,
          TotalLifetimeDays: 20,
          TurnLatencyDays: 20,
          WaitDays: 20,
          CommitCount: 1,
          QueueBasis: "updated",
        },
        {
          Timestamp: "2026-11-19 09:00:00",
          TargetPr: 464302,
          FrontNumber: 431000,
          FrontCreatedAt: "2026-09-21 09:00",
          ActiveAhead: 1000,
          TotalAhead: 1400,
          Behind: 220,
          TotalLifetimeDays: 21,
          TurnLatencyDays: 21,
          WaitDays: 21,
          CommitCount: 1,
          QueueBasis: "updated",
        },
      ],
      healthyFrontierSamples: [
        { timestampMs: t1, pr: 430000, createdMs: t1 - 50 * DAY_MS },
        { timestampMs: t2, pr: 431000, createdMs: t2 - 49 * DAY_MS },
      ],
      firstTimerFrontierSamples: [
        { timestampMs: t1, pr: 435000, createdMs: t1 - 40 * DAY_MS },
        { timestampMs: t2, pr: 436000, createdMs: t2 - 39 * DAY_MS },
      ],
    });

    expect(html).toContain('data-chart-filter="all"');
    expect(html).toContain('data-chart-filter="first-timer"');
    const allChart = html
      .split('data-chart-view="all"')[1]
      .split('data-chart-view="first-timer"')[0];
    const ftChart = html.split('data-chart-view="first-timer"')[1].split("</section>")[0];
    expect(allChart).toContain("⚓ マージ正常底（健康的大底）起票経過");
    expect(allChart).not.toContain("🌱 マージ正常底（初回提出者のみ）起票経過");
    expect(ftChart).toContain("🌱 マージ正常底（初回提出者のみ）起票経過");
    expect(ftChart).not.toContain("⚓ マージ正常底（健康的大底）起票経過");
  });

  test("統合時系列チャートは疎な履歴（別日 1 件ずつ／片方のみ描画可能）でも空トグルを出さず描画可能な SVG を表示する", () => {
    const t1 = Date.parse("2026-11-18T00:00:00Z");
    const t2 = Date.parse("2026-11-19T00:00:00Z");

    // ケース 1: 進捗 CSV なし＋全体と初回が別日に 1 件ずつ -> 統合すれば 2 時点で描画可能
    const combinedHtml = generateDashboardHtml({
      progress: null,
      depths: null,
      csvRows: [],
      healthyFrontierSamples: [{ timestampMs: t1, pr: 430000, createdMs: t1 - 50 * DAY_MS }],
      firstTimerFrontierSamples: [{ timestampMs: t2, pr: 435000, createdMs: t2 - 40 * DAY_MS }],
    });
    expect(combinedHtml).not.toContain('data-chart-filter="all"');
    const combinedSection = combinedHtml
      .split("<section data-chart-section>")[1]
      .split("</section>")[0];
    expect(combinedSection).toContain("<svg ");
    expect(combinedSection).toContain("⚓ マージ正常底（健康的大底）起票経過");
    expect(combinedSection).toContain("🌱 マージ正常底（初回提出者のみ）起票経過");

    // ケース 2: 進捗 CSV なし＋初回のみ 2 時点（描画可）、全体は 1 時点（描画不可）
    const singleSideHtml = generateDashboardHtml({
      progress: null,
      depths: null,
      csvRows: [],
      healthyFrontierSamples: [{ timestampMs: t1, pr: 430000, createdMs: t1 - 50 * DAY_MS }],
      firstTimerFrontierSamples: [
        { timestampMs: t1, pr: 435000, createdMs: t1 - 40 * DAY_MS },
        { timestampMs: t2, pr: 436000, createdMs: t2 - 39 * DAY_MS },
      ],
    });
    expect(singleSideHtml).not.toContain('data-chart-filter="all"');
    const singleSideSection = singleSideHtml
      .split("<section data-chart-section>")[1]
      .split("</section>")[0];
    expect(singleSideSection).toContain("<svg ");
    expect(singleSideSection).toContain("🌱 マージ正常底（初回提出者のみ）起票経過");
  });

  test("マージ前線の初回提出者ビューは全体窓（30日）外・初回提出者窓（90日）内の採用例を FirstTimerSamples から描画し 0 件表示にならない", () => {
    const now = new Date("2026-11-20T00:00:00Z");
    const merged45DaysAgo = "2026-10-06T00:00:00Z";
    const created80DaysAgo = "2026-09-01T00:00:00Z";
    const partitioned = partitionSamplesByWindow({
      samples: [
        {
          number: 445566,
          title: "New package: OlderWindow.FirstTimer version 1.0",
          createdAt: created80DaysAgo,
          latestCommittedDate: created80DaysAgo,
          commitCount: 1,
          readyAt: created80DaysAgo,
          mergedAt: merged45DaysAgo,
          totalDays: 35,
          turnDays: 35,
          days: 35,
          author: "ft-45d",
          isFirstTimer: true,
        },
      ],
      skippedCandidates: [],
      now,
      lookbackDays: 30,
      firstTimerLookbackDays: 90,
    });
    const overallStats = calculateProgressStats(
      partitioned.overallSamples,
      partitioned.overallSkippedCount,
    );
    const ftStats = calculateProgressStats(partitioned.firstTimerSamples);
    const progress = createProgressSnapshot({
      now,
      repository: "microsoft/winget-pkgs",
      targetPr: 464302,
      prTitle: "Target",
      prUrl: "https://github.com/microsoft/winget-pkgs/pull/464302",
      prState: "OPEN",
      frontNumber: 430000,
      frontCreatedAt: "2026-09-01 09:00",
      activeAhead: 100,
      totalAhead: 120,
      behind: 10,
      totalLifetimeDays: 20,
      turnLatencyDays: 20,
      waitDays: 20,
      commitCount: 1,
      stats: overallStats,
      lookbackDays: 30,
      skippedCount: partitioned.overallSkippedCount,
      rivals: [],
      samples: partitioned.overallSamples,
      targetCreatedAt: new Date("2026-10-31T00:00:00Z"),
      targetReadyAt: new Date("2026-10-31T00:00:00Z"),
      firstTimerStats: ftStats,
      firstTimerSampleCount: partitioned.firstTimerSamples.length,
      firstTimerSamples: partitioned.firstTimerSamples,
      firstTimerLookbackDays: 90,
    });

    expect(progress.Samples).toEqual([]);
    expect(progress.FirstTimerSampleCount).toBe(1);
    expect(progress.FirstTimerSamples?.map((s) => s.Number)).toEqual([445566]);

    const html = generateDashboardHtml({ progress, depths: null, csvRows: [] });
    const mergeFrontSection = html
      .split("🚀 マージ前線（直近マージ実績・早ければ）")[1]
      .split("⚓ マージ正常底（健康的大底・遅くとも）")[0];
    const mergeFrontFt = mergeFrontSection.split('data-matrix-view="first-timer"')[1];

    expect(mergeFrontFt).toContain("#445566");
    expect(mergeFrontFt).toContain("直近 1 件表示（過去 90 日・採用 1 件）");
    expect(mergeFrontFt).toContain("通算中央値: 35 日");
    expect(mergeFrontFt).toContain("直近サンプル起票中央値: 2026-09-01 09:00");
    expect(mergeFrontFt).not.toContain("該当 0 件（過去 90 日）");

    // 旧スナップショット（FirstTimerSamples 未記録）でも採用件数 > 0 なら「該当 0 件」と矛盾表示しない
    const legacyProgress = { ...progress, FirstTimerSamples: undefined };
    const legacyHtml = generateDashboardHtml({
      progress: legacyProgress,
      depths: null,
      csvRows: [],
    });
    const legacyFt = legacyHtml
      .split("🚀 マージ前線（直近マージ実績・早ければ）")[1]
      .split("⚓ マージ正常底（健康的大底・遅くとも）")[0]
      .split('data-matrix-view="first-timer"')[1];
    expect(legacyFt).toContain("過去 90 日・採用 1 件（一覧未保存）");
    expect(legacyFt).not.toContain("該当 0 件（過去 90 日）");

    // 旧スナップショットで初回提出者窓（30日）が全体窓（90日）より短い場合、45日前の PR を期間外として除外し矛盾表示しない
    const shorterFtWindowLegacyHtml = generateDashboardHtml({
      progress: {
        Timestamp: now.toISOString(),
        LookbackDays: 90,
        FirstTimerLookbackDays: 30,
        SampleCount: 1,
        FirstTimerSampleCount: 0,
        TotalMedianDays: 35,
        FirstTimerMedianDays: null,
        Samples: [
          {
            Number: 445566,
            Title: "New package: OlderWindow.FirstTimer version 1.0",
            Relation: "older",
            CommitCount: 1,
            CreatedAt: created80DaysAgo,
            LatestCommittedDate: created80DaysAgo,
            ReadyAt: created80DaysAgo,
            MergedAt: merged45DaysAgo,
            TotalDays: 35,
            TurnDays: 35,
            ReadyDays: 35,
            Author: "ft-45d",
            IsFirstTimer: true,
          },
        ],
      },
      depths: null,
      csvRows: [],
    });
    const shorterFtView = shorterFtWindowLegacyHtml
      .split("🚀 マージ前線（直近マージ実績・早ければ）")[1]
      .split("⚓ マージ正常底（健康的大底・遅くとも）")[0]
      .split('data-matrix-view="first-timer"')[1];
    expect(shorterFtView).toContain("該当 0 件（過去 30 日）");
    expect(shorterFtView).not.toContain("#445566");
    expect(shorterFtView).not.toContain("直近サンプル起票中央値:");
  });

  test("renderIntegratedForecastHero は TotalMedianDays 未算出でも最新マージサンプルがあればフォールバック表示する", () => {
    const band = calculateForecastBand(
      buildForecastBandSource({ progress: null, depths: null, history: [] }),
    );
    const html = renderIntegratedForecastHero({
      targetPrNum: 464302,
      repo: "microsoft/winget-pkgs",
      progress: {
        LookbackDays: 30,
        SampleCount: 1,
        TotalMedianDays: null,
        Samples: [
          {
            Number: 449999,
            Title: "New package: Fallback.App version 1.0",
            Relation: "older",
            CommitCount: 1,
            CreatedAt: "2026-10-01T00:00:00Z",
            LatestCommittedDate: "2026-10-01T00:00:00Z",
            ReadyAt: "2026-10-01T01:00:00Z",
            MergedAt: "2026-11-18T00:00:00Z",
            TotalDays: 48.0,
            TurnDays: 48.0,
            ReadyDays: 47.9,
          },
        ],
      },
      band,
      timelineSvg: null,
    });
    expect(html).toContain("#449999");
    expect(html).toContain("最新マージ（所要 48.0 日 / 採用 1 件）");
  });
});
