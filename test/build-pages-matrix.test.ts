import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../scripts/build-pages";
import type { GitHubApiClient } from "../src/api/github";
import { runExploreDepths } from "../src/cli/explore-depths";
import { CURRENT_DEPTHS_VERSION } from "../src/domain/depths";
import { CURRENT_FIRST_TIMER_VERSION } from "../src/domain/first-timer";

describe("buildDashboard: 2×2 マトリクス・主戦場ライン・最速ランキング", () => {
  test("runExploreDepths で探索された実際の StaleBottom データから、CONTRIBUTOR 行に常連除外バッジが描画される", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-explore-badge-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const outputPath = join(dataDir, "latest-depths.json");
    const historyPath = join(dataDir, "depths-history.jsonl");

    const mockClient = {
      getPullRequest: async () => ({
        number: 123456,
        title: "Target",
        url: "https://github.com/microsoft/winget-pkgs/pull/123456",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      }),
      searchIssues: async () => [
        {
          number: 550001,
          title: "PR by Frequent Contributor",
          html_url: "https://github.com/microsoft/winget-pkgs/pull/550001",
          created_at: "2026-09-10T00:00:00Z",
          updated_at: "2026-09-10T00:00:00Z",
          author: "frequent-contributor",
          author_association: "CONTRIBUTOR",
        },
      ],
      graphql: async (_query: string, variables?: Record<string, unknown>) => {
        const searchQuery = String(variables?.query ?? "");
        if (searchQuery.includes("sort:created-asc") || searchQuery.includes("sort:updated-asc")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 550001,
                  title: "PR by Frequent Contributor",
                  url: "https://github.com/microsoft/winget-pkgs/pull/550001",
                  createdAt: "2026-09-10T00:00:00Z",
                  updatedAt: "2026-09-10T00:00:00Z",
                  author: { login: "frequent-contributor" },
                  authorAssociation: "CONTRIBUTOR",
                  commits: { totalCount: 1 },
                  labels: { nodes: [{ name: "New-Package" }] },
                },
              ],
            },
          };
        }
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      },
    } as unknown as GitHubApiClient;

    await runExploreDepths(
      {
        targetPr: 123456,
        repository: "microsoft/winget-pkgs",
        outputPath,
        historyPath,
        noTargetPr: false,
        noHistory: false,
        asJson: true,
      },
      mockClient,
      () => {},
    );

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");
      // Search API で取得された CONTRIBUTOR の行がマージ前線に表示され、初回提出者バッジは付かないこと
      expect(html).toContain("550001");
      expect(html).not.toContain(">🌱 初回提出者<");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount>=1 の隠れ常連には初回提出者バッジが付かない",
      association: "NONE",
      mergedCount: 2,
      expectFirstTimerBadge: false,
    },
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount=0 の初回提出者には初回提出者バッジが付く",
      association: "NONE",
      mergedCount: 0,
      expectFirstTimerBadge: true,
    },
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount 未設定（旧データ）には初回提出者バッジが付かない",
      association: "NONE",
      mergedCount: undefined,
      expectFirstTimerBadge: false,
    },
    {
      label: "AuthorAssociation=CONTRIBUTOR には初回提出者バッジが付かない",
      association: "CONTRIBUTOR",
      mergedCount: undefined,
      expectFirstTimerBadge: false,
    },
  ])(
    "マージ正常底（健康的大底）初回提出者バッジ判定と起票日時順統一: $label",
    ({ association, mergedCount, expectFirstTimerBadge }) => {
      const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-repeater-badge-"));
      const dataDir = join(tempDir, "data");
      const outputDir = join(tempDir, "site");
      mkdirSync(dataDir, { recursive: true });

      const dummyDepths = {
        Timestamp: "2026-11-08T12:00:00Z",
        TimestampJst: "2026-11-08 21:00:00",
        HealthyBottom: [
          {
            Number: 551001,
            Title: "Healthy Candidate",
            Url: "https://github.com/microsoft/winget-pkgs/pull/551001",
            Author: "candidate-user",
            AuthorAssociation: association,
            ...(mergedCount !== undefined ? { AuthorMergedCount: mergedCount } : {}),
            CreatedAt: "2026-10-01T12:00:00Z",
            UpdatedAt: "2026-10-10T12:00:00Z",
          },
        ],
        FirstTimerBottom: [
          {
            Number: 551002,
            Title: "Multi-commit Reworked First Timer",
            Url: "https://github.com/microsoft/winget-pkgs/pull/551002",
            Author: "reworked-first-timer",
            AuthorAssociation: "NONE",
            CommitCount: 4,
            // 起票は 36.0 日前、更新は 1.0 日前
            CreatedAt: "2026-10-03T12:00:00Z",
            UpdatedAt: "2026-11-07T12:00:00Z",
          },
        ],
      };
      writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(dummyDepths), "utf-8");

      try {
        const { htmlPath } = buildDashboard({ dataDir, outputDir });
        const html = readFileSync(htmlPath, "utf-8");

        const mergeBottomSection = html
          .split("⚓ マージ正常底（健康的大底・遅くとも）")[1]
          .split("🚧 例外・特殊境界（真の大底・特急レーン）")[0];
        const mergeBottomAll = mergeBottomSection.split('data-matrix-view="first-timer"')[0];

        // 全体ビューは「起票からの経過」（38 日）で初回提出者バッジを判定
        expect(mergeBottomAll).toContain("<th>起票からの経過</th>");
        expect(mergeBottomAll).toContain("<td>38 日</td>");
        if (expectFirstTimerBadge) {
          expect(mergeBottomAll).toContain(">🌱 初回提出者<");
        } else {
          expect(mergeBottomAll).not.toContain(">🌱 初回提出者<");
        }

        // マージ正常底（初回提出者ビュー）も「起票からの経過」（36 日）であり、更新からの経過（1 日）ではない
        expect(mergeBottomSection).toContain("<th>起票からの経過</th>");
        expect(mergeBottomSection).not.toContain("<th>更新からの経過</th>");
        expect(mergeBottomSection).toContain("<td>36 日</td>");
        expect(mergeBottomSection).not.toContain("<td>1 日</td>");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  test("renderOvertakeSection: 未観測・旧形式・未判定ありのフォールバックが安全に処理される", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-summary-fallback-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    // ケース 1: Comparison が存在しない（未観測）
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({ TargetPr: 123456 }),
      "utf-8",
    );
    let html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).not.toContain("🏃 追い越しの比較（採用サンプル内）");
    expect(html).not.toContain("完全な作成順で進行中");

    // ケース 2: 旧形式スナップショット（LaterCreated のみあり、コホート別内訳なし）
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        Comparison: {
          LaterCreated: 15,
          EarlierCreated: 30,
        },
      }),
      "utf-8",
    );
    html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("<strong>15</strong> 件");
    expect(html).toContain("初回/常連の内訳は未分類（旧データ）");
    expect(html).not.toContain("常連・特急レーン: <strong>15</strong> 件"); // 勝手に常連に計上しない
    expect(html).not.toContain("完全な作成順で進行中");

    // ケース 3: 未判定あり（FirstTimerLaterCreated: 0, UnknownLaterCreated: 7）
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        Comparison: {
          LaterCreated: 20,
          EarlierCreated: 30,
          FirstTimerLaterCreated: 0,
          RepeatOrExpressLaterCreated: 13,
          UnknownLaterCreated: 7,
        },
      }),
      "utf-8",
    );
    html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain(
      "うち初回提出者: <strong>0</strong> 件 / 常連・特急レーン: <strong>13</strong> 件 / 未判定: <strong>7</strong> 件",
    );
    expect(html).not.toContain("採用サンプル内で確定した初回提出者の追い越し: 0 件");
    expect(html).not.toContain("完全な作成順で進行中");

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("統合ヒーロー & renderFirstTimerCohortBlock: FirstTimerLookbackDays が集計期間表示に反映される", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-ft-lookback-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    // FirstTimerLookbackDays: 90 が指定された場合
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 30,
        FirstTimerLookbackDays: 90,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerSampleCount: 8,
      }),
      "utf-8",
    );
    let html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("過去 90 日・8 件");
    expect(html).toContain("過去 90 日間・採用 8 件");

    // FirstTimerLookbackDays 未指定で LookbackDays: 45 の場合
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 45,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerSampleCount: 4,
      }),
      "utf-8",
    );
    html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("過去 45 日・4 件");
    expect(html).toContain("過去 45 日間・採用 4 件");

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("統合ヒーロー: FirstTimerTurnMedianDays と FirstTimerTurnP75Days が設定されている場合に最終コミット後 (Turn) が出力される", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-ft-turn-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 30,
        FirstTimerLookbackDays: 90,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerTurnMedianDays: 5.5,
        FirstTimerTurnP75Days: 8.2,
        FirstTimerSampleCount: 8,
      }),
      "utf-8",
    );
    const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain(
      "最終コミット後 (Turn): <strong>5.5</strong> 日 / P75: <strong>8.2</strong> 日",
    );

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("Issue #81: 集計期間（90日/30日/7日）・母集団・上限・初期健康体・TotalLifetimeDays=0のフォールバックを正しく扱う", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-issue-81-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 30,
        FirstTimerLookbackDays: 90,
        SampleCount: 142,
        SkippedCount: 4,
        TotalLifetimeDays: 0,
        WaitDays: 12,
        TurnLatencyDays: 0,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerSampleCount: 8,
        Comparison: {
          LaterCreated: 5,
          EarlierCreated: 10,
          LaterReady: 2,
          FirstTimerLaterCreated: 0,
          RepeatOrExpressLaterCreated: 5,
          UnknownLaterCreated: 0,
        },
      }),
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      // TotalLifetimeDays=0 のとき WaitDays=12 に誤フォールバックしないこと
      expect(html).toContain("基準 PR 現在: 0 日");
      expect(html).not.toContain("基準 PR 現在: 12 日");

      // 追い越し分離内訳の 30 日全体サンプル表記
      expect(html).toContain("直近 30 日間の全体採用サンプル（142 件）内で");

      // KPI カード 4 見出し、用語統一、仮説②削除済み
      expect(html).toContain("準備完了後の待機 (Ready / 通算 / 手番)");
      expect(html).toContain("健康的大底（最古健康PR）");
      expect(html).not.toContain("現在の消化前線");
      expect(html).not.toContain("<th>消化前線 PR</th>");
      expect(html).toContain("直近最大 120 観測点を表示");
      expect(html).toContain("比較対象は直近約 7 日間 / 168 時間窓基準");
      expect(html).toContain("除外件数は、タイムライン上で Ready 条件");
      expect(html).toContain("生涯マージ1件の初回提出者（手直し・ラベル履歴を含む）");
      expect(html).not.toContain("🔮 仮説② の根拠");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("非既定の LookbackDays (14) / FirstTimerLookbackDays (60) でも仮説③と実績統計・初回提出者欄の表示期間が矛盾しない", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-lookback-custom-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: "2026-11-08T00:00:00Z",
        TargetPr: 123456,
        LookbackDays: 14,
        FirstTimerLookbackDays: 60,
        SampleCount: 55,
        SkippedCount: 2,
        TotalMedianDays: 18,
        TotalP75Days: 25,
        FirstTimerMedianDays: 32,
        FirstTimerP75Days: 40,
        FirstTimerSampleCount: 5,
        Comparison: {
          LaterCreated: 3,
          EarlierCreated: 4,
          LaterReady: 1,
          FirstTimerLaterCreated: 0,
          RepeatOrExpressLaterCreated: 3,
          UnknownLaterCreated: 0,
        },
      }),
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      expect(html).toContain("過去 60 日・5 件");
      expect(html).toContain("過去 60 日間・採用 5 件");
      expect(html).toContain("直近 14 日間の全体採用サンプル（55 件）内で");
      expect(html).toContain("マージ実績の所要日数統計 (直近 14 日間");
      expect(html).toContain("直近（14日間）の全体マージ実績（常連・特急含む）");
      expect(html).toContain("上部の初回提出者60日コホート統計とは母集団が異なります");
      expect(html).not.toContain("直近（30日間）の全体マージ実績");
      expect(html).not.toContain("上部の初回提出者90日コホート統計とは母集団が異なります");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("主戦場ライン方式（7日初回介入コホート中央値）・内訳テーブル・初回レビュー到達予想・時系列チャートを描画する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-intervention-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: "2026-11-15T00:00:00Z",
        TimestampJst: "2026-11-15 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: 464302,
        PrTitle: "Target Package",
        ActiveAhead: 100,
        TotalAhead: 150,
        Behind: 50,
      }),
      "utf-8",
    );

    const makeRow = (
      num: number,
      createdAt: string,
      updatedAt: string,
      thirdPartyAssignees: string[],
    ) => ({
      PR: `#${num}`,
      Number: num,
      作成日時: createdAt.slice(0, 16).replace("T", " "),
      更新日時: updatedAt.slice(0, 16).replace("T", " "),
      CreatedAt: createdAt,
      UpdatedAt: updatedAt,
      タイトル: `PR ${num}`,
      Title: `PR ${num}`,
      Url: `https://github.com/microsoft/winget-pkgs/pull/${num}`,
      Author: `author-${num}`,
      AuthorAssociation: "NONE",
      CommitCount: 1,
      ThirdPartyAssignees: thirdPartyAssignees,
    });

    const latestDepths = {
      DepthsVersion: CURRENT_DEPTHS_VERSION,
      Timestamp: "2026-11-15T00:00:00Z",
      TimestampJst: "2026-11-15 09:00:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: {
        Number: 464302,
        Title: "Target Package",
        Url: "https://github.com/microsoft/winget-pkgs/pull/464302",
        CreatedAt: "2026-11-05T00:00:00Z",
        CreatedAtJst: "2026-11-05 09:00",
        UpdatedAt: "2026-11-05T00:00:00Z",
        Author: "scottlz0310",
        ThirdPartyAssignees: [],
        Intervention: {
          Intervened: false,
          ThirdPartyAssignees: [],
          HumanReviewCount: 0,
          ManualCommentCount: 0,
        },
      },
      HealthyBottom: [],
      AbsoluteBottom: [],
      StaleBottom: [
        makeRow(440001, "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z", []),
        makeRow(440002, "2026-10-22T00:00:00Z", "2026-10-22T00:00:00Z", ["stephengillie"]),
      ],
      FirstTimerBottom: [
        makeRow(440003, "2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z", ["stephengillie"]),
        {
          ...makeRow(440004, "2026-10-24T00:00:00Z", "2026-10-25T00:00:00Z", ["stephengillie"]),
          Intervention: {
            Intervened: true,
            ThirdPartyAssignees: ["stephengillie"],
            HumanReviewCount: 0,
            ManualCommentCount: 1,
            PrimaryBadge: {
              Kind: "comment",
              Actor: "stephengillie",
              Label: "コメント済: stephengillie",
            },
          },
        },
      ],
      UnreviewedBottom: [makeRow(441002, "2026-10-27T00:00:00Z", "2026-10-27T00:00:00Z", [])],
      FirstReviewFrontier: {
        Mode: "cohort-median-7d",
        WindowDays: 7,
        CohortCount: 12,
        OpenCount: 5,
        MergedCount: 7,
        MedianCreatedAt: "2026-10-27T00:00:00Z",
        LagDays: 19,
        OldestCreatedAt: "2026-10-15T00:00:00Z",
        NewestCreatedAt: "2026-11-01T00:00:00Z",
        Items: [
          {
            Number: 441001,
            Title: "New package: Vendor.App version 1.0.0",
            Url: "https://github.com/microsoft/winget-pkgs/pull/441001",
            State: "MERGED",
            Author: "ft-1",
            CommitCount: 1,
            CreatedAt: "2026-10-21T00:00:00Z",
            FirstHumanInterventionAt: "2026-11-14T10:00:00Z",
            InterventionKind: "review",
            InterventionActor: "matteozanettii",
            MergedAt: "2026-11-14T10:05:00Z",
          },
          {
            Number: 441003,
            Title: "New version: Another.Pkg version 2.1.0",
            Url: "https://github.com/microsoft/winget-pkgs/pull/441003",
            State: "OPEN",
            Author: "ft-2",
            CommitCount: 2,
            CreatedAt: "2026-10-22T00:00:00Z",
            FirstHumanInterventionAt: "2026-11-13T05:00:00Z",
            InterventionKind: "comment",
            InterventionActor: "stephengillie",
          },
        ],
      },
      ExpressLane: [],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(latestDepths), "utf-8");

    // v3 履歴 (UnreviewedBottom) は混入させず、v4 主戦場ラインの 24 時間進行 (2026-10-25 -> 2026-10-27 => 速度 2 日/日、残り 9 日 / 2 = 4.5 日後) で算出
    const historyLines = [
      {
        DepthsVersion: 3,
        Timestamp: "2026-11-13T00:00:00Z",
        TimestampJst: "2026-11-13 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: latestDepths.TargetPr,
        HealthyBottom: [],
        AbsoluteBottom: [],
        StaleBottom: latestDepths.StaleBottom,
        UnreviewedBottom: [makeRow(440999, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", [])],
        ExpressLane: [],
      },
      {
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-14T00:00:00Z",
        TimestampJst: "2026-11-14 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: latestDepths.TargetPr,
        HealthyBottom: [],
        AbsoluteBottom: [],
        StaleBottom: latestDepths.StaleBottom,
        UnreviewedBottom: latestDepths.UnreviewedBottom,
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 10,
          OpenCount: 4,
          MergedCount: 6,
          MedianCreatedAt: "2026-10-25T00:00:00Z",
          LagDays: 20,
        },
        ExpressLane: [],
      },
      latestDepths,
    ];
    writeFileSync(
      join(dataDir, "depths-history.jsonl"),
      `${historyLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      // 統合ヒーローカード内の初動前線現在位置（外挿廃止・定常換算・初回提出者明記）
      expect(html).toContain("👀 初動前線（主戦場ライン・初回提出者 7日介入中央値）");
      expect(html).toContain("自PRと差 9 日（定常 1.0 日/日換算:");
      expect(html).toContain("7日初回介入 12件 [Open 5 / Merged 7]");

      // 統合時系列チャートに初動前線系列
      expect(html).toContain("👀 初動前線（主戦場ライン・初回提出者 7日介入中央値）");

      // 2×2 マトリクス内のマージ正常底で人間介入バッジを表示し、ThirdPartyAssignees のみの行にはアサイン済バッジを出さない
      const mergeBottomSection = html
        .split("⚓ マージ正常底（健康的大底・遅くとも）")[1]
        .split("🚧 例外・特殊境界（真の大底・特急レーン）")[0];
      expect(mergeBottomSection).toContain("コメント済: stephengillie");
      expect(mergeBottomSection).not.toContain("アサイン済: stephengillie");

      // 2×2 マトリクス内の初動前線（主戦場ライン）・初動正常底（未レビュー最古）
      expect(html).toContain("🧭 待機ライン 2×2 マトリクス（フェーズ × レンジ）");
      expect(html).not.toContain("（(");
      expect(html).toContain("🎯 初動前線（主戦場ライン・早ければ）");
      expect(html).toContain("計 12 件 (Open 5 / Merged 7)");
      expect(html).toContain("直近介入順 30 件表示");
      const mainstreamCardHtml = html
        .split("🎯 初動前線（主戦場ライン・早ければ）")[1]
        .split("🟦 初動正常底（未レビュー最古・遅くとも）")[0];
      expect(mainstreamCardHtml).toContain("<th>PR / パッケージ</th>");
      expect(mainstreamCardHtml).not.toContain("<th>タイトル</th>");
      expect(mainstreamCardHtml).toContain('title="New package: Vendor.App version 1.0.0"');
      expect(mainstreamCardHtml).toContain("Vendor.App version 1.0.0");
      expect(mainstreamCardHtml).toContain('title="New version: Another.Pkg version 2.1.0"');
      expect(mainstreamCardHtml).toContain("Another.Pkg version 2.1.0");
      expect(html).toContain("🟦 初動正常底（未レビュー最古・遅くとも）");
      expect(html).toContain("MERGED");
      expect(html).toContain("OPEN");
      expect(html).toContain("レビュー: matteozanettii");
      expect(html).toContain("コメント: stephengillie");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("基準 PR 自身がコメント／レビュー等で介入済みの場合は初回レビュー到達済みとして表示し、旧 Depthsv2 データとも後方互換を保つ", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-target-intervened-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-depths.json"),
      JSON.stringify({
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-15T00:00:00Z",
        TimestampJst: "2026-11-15 09:00:00",
        TargetPr: {
          Number: 464302,
          Title: "Target Package",
          Url: "https://github.com/microsoft/winget-pkgs/pull/464302",
          CreatedAt: "2026-11-05T00:00:00Z",
          CreatedAtJst: "2026-11-05 09:00",
          UpdatedAt: "2026-11-05T00:00:00Z",
          Intervention: {
            Intervened: true,
            ThirdPartyAssignees: [],
            HumanReviewCount: 0,
            ManualCommentCount: 1,
            PrimaryBadge: {
              Kind: "comment",
              Actor: "stephengillie",
              Label: "コメント済: stephengillie",
            },
          },
        },
        StaleBottom: [
          {
            Number: 440001,
            Title: "Legacy Row Without ThirdPartyAssignees",
            Url: "https://github.com/microsoft/winget-pkgs/pull/440001",
            CreatedAt: "2026-10-20T00:00:00Z",
            UpdatedAt: "2026-10-21T00:00:00Z",
          },
        ],
      }),
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      expect(html).toContain("基準PR介入済み");
      expect(html).toContain("（コメント済: stephengillie）");
      expect(html).toContain(
        "未レビュー最古のデータはまだありません（次回の定期観測から記録されます）。",
      );
      expect(html).toContain(
        "主戦場ラインのデータはまだありません（次回の定期観測から記録されます）。",
      );
      expect(html).not.toContain("アサイン済: undefined");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("主戦場ライン コホートが 0 件時はデータ不足として安全にフォールバックし、起票日差 <= 0 は到達済みと明示する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-mainstream-fallback-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const targetPr = {
      Number: 464302,
      Title: "Target Package",
      Url: "https://github.com/microsoft/winget-pkgs/pull/464302",
      CreatedAt: "2026-10-10T00:00:00Z",
      CreatedAtJst: "2026-10-10 09:00",
      UpdatedAt: "2026-10-10T00:00:00Z",
      Intervention: {
        Intervened: false,
        ThirdPartyAssignees: [],
        HumanReviewCount: 0,
        ManualCommentCount: 0,
      },
    };

    try {
      // ケース1: 0件フォールバック（NaN や例外なし）
      const zeroSnapshot = {
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-15T00:00:00Z",
        TimestampJst: "2026-11-15 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: targetPr,
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 0,
          OpenCount: 0,
          MergedCount: 0,
          MedianCreatedAt: null,
          LagDays: null,
          Items: [],
        },
      };
      writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(zeroSnapshot), "utf-8");
      writeFileSync(
        join(dataDir, "depths-history.jsonl"),
        `${JSON.stringify(zeroSnapshot)}\n`,
        "utf-8",
      );

      const zeroHtml = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(zeroHtml).toContain("データ不足");
      expect(zeroHtml).not.toContain("NaN");

      // ケース2: 主戦場ライン中央値が基準 PR 起票日以降（gapDays <= 0）
      const reachedSnapshot = {
        ...zeroSnapshot,
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 5,
          OpenCount: 2,
          MergedCount: 3,
          MedianCreatedAt: "2026-10-12T00:00:00Z",
          LagDays: 34,
          Items: [],
        },
      };
      writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(reachedSnapshot), "utf-8");
      writeFileSync(
        join(dataDir, "depths-history.jsonl"),
        `${JSON.stringify(reachedSnapshot)}\n`,
        "utf-8",
      );

      const reachedHtml = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(reachedHtml).toContain("基準 PR の起票日ラインに到達済み");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("走査上限到達（UnreviewedTruncated）時は未確定として表示し該当なしと断定しない", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-intervention-truncated-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const baseDepths = {
      DepthsVersion: CURRENT_DEPTHS_VERSION,
      Timestamp: "2026-11-15T00:00:00Z",
      TimestampJst: "2026-11-15 09:00:00",
      TargetPr: null,
      HealthyBottom: [],
      AbsoluteBottom: [],
      StaleBottom: [],
      UnreviewedBottom: [] as unknown[],
      UnreviewedTruncated: true,
      ExpressLane: [],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(baseDepths), "utf-8");

    try {
      const htmlEmpty = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(htmlEmpty).toContain("探索上限到達・未確定");
      expect(htmlEmpty).toContain(
        "走査上限に到達したため探索を打ち切りました（未走査の PR が残っており、対象 PR の有無は未確定です）。",
      );
      expect(htmlEmpty).not.toContain("現在、完全未着手の健康な待機 PR はありません。");

      writeFileSync(
        join(dataDir, "latest-depths.json"),
        JSON.stringify({
          ...baseDepths,
          UnreviewedBottom: [
            {
              Number: 442001,
              Title: "Unreviewed PR",
              Url: "https://github.com/microsoft/winget-pkgs/pull/442001",
              CreatedAt: "2026-10-20T00:00:00Z",
              UpdatedAt: "2026-10-21T00:00:00Z",
              Author: "user1",
              CommitCount: 1,
            },
          ],
        }),
        "utf-8",
      );
      const htmlPartial = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(htmlPartial).toContain("上位 1 件（上限到達・一部未完）");
      expect(htmlPartial).toContain(
        "※ 走査上限に到達したため途中で打ち切りました（未走査の PR が残っています）。",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("merged-samples.jsonl から初回提出者 最速マージランキング（TOP 10）を比較サンプルセクション直前に描画する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-first-timer-ranking-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: "2026-11-17T00:00:00Z",
        TimestampJst: "2026-11-17 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: 464302,
        PrTitle: "Target Package",
        SampleCount: 1,
        Samples: [
          {
            Number: 9001,
            Relation: "older",
            CommitCount: 1,
            TurnDays: 1.0,
            TotalDays: 1.0,
            ReadyDays: 1.0,
            LatestCommittedDate: "2026-11-10T00:00:00Z",
            MergedAt: "2026-11-11T00:00:00Z",
            IsFirstTimer: false,
          },
        ],
      }),
      "utf-8",
    );

    const makeCacheSample = (
      num: number,
      totalDays: number,
      isFirstTimer: boolean,
      title = `New package: Pkg.${num}`,
      overrides: Record<string, unknown> = {},
    ) => ({
      Type: "sample",
      Number: num,
      Title: title,
      CreatedAt: "2026-10-01T00:00:00Z",
      LatestCommittedDate: "2026-10-01T01:00:00.000Z",
      CommitCount: 2,
      ReadyAt: "2026-10-01T02:00:00.000Z",
      MergedAt: "2026-10-02T00:00:00.000Z",
      TotalDays: totalDays,
      TurnDays: Math.max(0.1, totalDays - 0.1),
      ReadyDays: Math.max(0.5, totalDays - 0.2),
      Author: `author-${num}`,
      AuthorType: "User",
      AuthorAssociation: "CONTRIBUTOR",
      IsFirstTimer: isFirstTimer,
      FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
      ...overrides,
    });

    // 11 件の初回提出者 + 常連 + 後続行上書き + 不純物（v4/v6旧版 / ReadyDays<0.5 / 90日窓外 / MEMBER / Bot）
    const cacheLines = [
      makeCacheSample(410001, 0.8, true, "Should be excluded later"),
      makeCacheSample(410002, 50.0, false, "Old false row"),
      makeCacheSample(410003, 0.8, false, "Regular contributor"),
      makeCacheSample(410004, 0.04, true, "v4 zombie cache", { FirstTimerVersion: 4 }),
      makeCacheSample(410009, 0.05, true, "v6 legacy cache", { FirstTimerVersion: 6 }),
      makeCacheSample(410005, 0.6, true, "Bypass ready < 0.5", { ReadyDays: 0.1 }),
      makeCacheSample(410006, 0.7, true, "Too old createdAt (>90d)", {
        CreatedAt: "2026-07-01T00:00:00Z",
      }),
      makeCacheSample(410007, 0.6, true, "Privileged member", { AuthorAssociation: "MEMBER" }),
      makeCacheSample(410008, 0.6, true, "Bot account", { AuthorType: "Bot" }),
      ...Array.from({ length: 11 }, (_, idx) => makeCacheSample(420000 + idx, idx + 1.0, true)),
      makeCacheSample(410001, 0.8, false, "Disqualified in later line"),
      makeCacheSample(410002, 0.8, true, "Fastest updated entry", {
        CommitCount: 3,
        ReadyDays: 0.7,
      }),
    ];
    writeFileSync(
      join(dataDir, "merged-samples.jsonl"),
      `${cacheLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      const rankingPos = html.indexOf(
        "🏆 初回提出者 最速マージランキング（直近 90 日起票 TOP 10）",
      );
      const samplesPos = html.indexOf("🧪 比較に使ったサンプル");
      expect(rankingPos).toBeGreaterThan(-1);
      expect(samplesPos).toBeGreaterThan(rankingPos);

      const rankingSection = html.slice(rankingPos, samplesPos);
      // 該当全件数 = 11 + 1 (#410002) = 12 件のうち TOP 10
      expect(rankingSection).toContain("全 12 件");
      expect(rankingSection).toContain("上位 10 件");
      expect(rankingSection).toContain(
        `成立後 0.5 日以上・v${CURRENT_FIRST_TIMER_VERSION} 以上・特権ロール/Bot 除外`,
      );
      expect(rankingSection).not.toContain("v6 legacy cache");
      expect(rankingSection).toContain("<th>順位</th>");
      expect(rankingSection).toContain("<th>PR 番号</th>");
      expect(rankingSection).toContain("<th>コミット数</th>");
      expect(rankingSection).toContain("<th>通算日数</th>");
      expect(rankingSection).toContain("<th>最終コミット後</th>");
      expect(rankingSection).toContain("<th>成立後</th>");
      expect(rankingSection).toContain("<th>起票日時 (JST)</th>");
      expect(rankingSection).toContain("<th>マージ日時 (JST)</th>");
      expect(rankingSection).toContain("<th>タイトル</th>");

      expect(rankingSection).toContain(
        'href="https://github.com/microsoft/winget-pkgs/pull/410002"',
      );
      expect(rankingSection).toContain("Fastest updated entry");
      expect(rankingSection).toContain("0.8 日");
      expect(rankingSection).toContain("2026-10-01(木) 09:00");
      expect(rankingSection).toContain("2026-10-02(金) 09:00");
      // 後続行で除外された #410001、常連 #410003、不純物 #410004〜#410008、11位以下 (#420009, #420010) は含まれない
      for (const excluded of [
        410001, 410003, 410004, 410005, 410006, 410007, 410008, 420009, 420010,
      ]) {
        expect(rankingSection).not.toContain(`#${excluded}`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("初回提出者サンプルが 0 件または merged-samples.jsonl 未存在時は代替メッセージを表示する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-first-timer-ranking-empty-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("🏆 初回提出者 最速マージランキング（直近 90 日起票 TOP 10）");
      expect(html).toContain("対象の初回提出者サンプルがまだありません");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
