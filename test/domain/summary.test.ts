import { describe, expect, test } from "bun:test";
import { escapeMermaidLabel, generateSummaryMarkdown } from "../../src/domain/summary";
import type { DepthsSnapshot } from "../../src/models/depths";
import type { ProgressHistoryRow, ProgressSnapshot } from "../../src/models/progress";

describe("Domain: generateSummaryMarkdown", () => {
  test("完全なデータが揃っている場合に各セクションを含む Markdown を生成する", () => {
    const progress: ProgressSnapshot = {
      Timestamp: "2026-11-07T11:30:00Z",
      TimestampJst: "2026-11-07 20:30:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: 464302,
      PrTitle: "New package: sample app",
      PrUrl: "https://github.com/microsoft/winget-pkgs/pull/464302",
      PrState: "OPEN",
      FrontNumber: 464100,
      FrontCreatedAt: "2026-11-06 12:00",
      ActiveAhead: 25,
      TotalAhead: 150,
      Behind: 10,
      TotalLifetimeDays: 3.5,
      TurnLatencyDays: 2.1,
      WaitDays: 2.0,
      CommitCount: 1,
      TotalMedianDays: 4.0,
      TotalP75Days: 6.0,
      TurnMedianDays: 2.5,
      TurnP75Days: 4.0,
      ReadyMedianDays: 2.0,
      ReadyP75Days: 3.5,
    };

    const depths: DepthsSnapshot = {
      Timestamp: "2026-11-07T11:30:00Z",
      TimestampJst: "2026-11-07 20:30:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: {
        Number: 464302,
        Title: "New package: sample app",
        Url: "https://github.com/microsoft/winget-pkgs/pull/464302",
        CreatedAt: "2026-11-04 10:00",
        CreatedAtJst: "2026-11-04 19:00",
      },
      HealthyBottom: [
        {
          PR: "#400000",
          Number: 400000,
          作成日時: "2026-08-01 10:00",
          更新日時: "2026-11-05 10:00",
          CreatedAt: "2026-08-01 10:00",
          UpdatedAt: "2026-11-05 10:00",
          タイトル: "Old healthy package",
          Title: "Old healthy package",
          Url: "https://github.com/microsoft/winget-pkgs/pull/400000",
        },
      ],
      AbsoluteBottom: [],
      StaleBottom: [
        {
          PR: "#410000",
          Number: 410000,
          作成日時: "2026-09-01 10:00",
          更新日時: "2026-09-05 10:00",
          CreatedAt: "2026-09-01 10:00",
          UpdatedAt: "2026-09-05 10:00",
          タイトル: "Stale package",
          Title: "Stale package",
          Url: "https://github.com/microsoft/winget-pkgs/pull/410000",
        },
      ],
      ExpressLane: [
        {
          PR: "#465000",
          Number: 465000,
          作成日時: "2026-11-05 10:00",
          更新日時: "2026-11-06 10:00",
          CreatedAt: "2026-11-05 10:00",
          UpdatedAt: "2026-11-06 10:00",
          タイトル: "Express merged package",
          Title: "Express merged package",
          Url: "https://github.com/microsoft/winget-pkgs/pull/465000",
        },
      ],
    };

    const historyRecords: ProgressHistoryRow[] = [
      {
        Timestamp: "2026-11-07 10:00:00",
        TargetPr: 464302,
        FrontNumber: 464100,
        FrontCreatedAt: "2026-11-06 12:00",
        ActiveAhead: 25,
        TotalAhead: 150,
        Behind: 10,
        TotalLifetimeDays: 3.5,
        TurnLatencyDays: 2.1,
        WaitDays: 2.0,
        CommitCount: 1,
      },
    ];

    const md = generateSummaryMarkdown({ progress, depths, historyRecords });

    expect(md).toContain("# Winget Observatory Dashboard");
    expect(md).toContain("[#464302 (New package: sample app)]");
    expect(md).toContain("## 1. 現在のキュー状況・メトリクス");
    expect(md).toContain("**#464100**");
    expect(md).toContain("## 2. キュー構造の視覚化");
    expect(md).toContain("flowchart LR");
    expect(md).toContain("## 3. 過去 30 日間マージ実績との統計比較");
    expect(md).toContain("中央値以内（順調）");
    expect(md).toContain("## 4. キュー境界探索スナップショット");
    expect(md).toContain("[#400000]");
    expect(md).toContain("[#465000]");
    expect(md).toContain("[#410000]");
    expect(md).toContain("## 5. 直近の消化推移履歴");
  });

  test("進捗データがない場合もフォールバック表示で正しく Markdown を生成する", () => {
    const md = generateSummaryMarkdown({
      progress: null,
      depths: null,
      historyRecords: [],
    });

    expect(md).toContain("# Winget Observatory Dashboard");
    expect(md).toContain("データ未集計");
    expect(md).not.toContain("## 3. 過去 30 日間マージ実績との統計比較");
    expect(md).not.toContain("## 4. キュー境界探索スナップショット");
    expect(md).not.toContain("## 5. 直近の消化推移履歴");
  });

  test("Mermaid ラベルのエスケープが正しく二重引用符を置換する", () => {
    expect(escapeMermaidLabel('Sample "quoted" title')).toBe("Sample #quot;quoted#quot; title");
  });

  test("PR タイトルに二重引用符が含まれる場合も Mermaid 構文を壊さずエスケープする", () => {
    const progress: ProgressSnapshot = {
      Timestamp: "2026-11-07T11:30:00Z",
      TimestampJst: "2026-11-07 20:30:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: 464302,
      PrTitle: 'New "Example" package with "quotes"',
      PrUrl: "https://github.com/microsoft/winget-pkgs/pull/464302",
      PrState: "OPEN",
      FrontNumber: 464100,
      FrontCreatedAt: "2026-11-06 12:00",
      ActiveAhead: 25,
      TotalAhead: 150,
      Behind: 10,
      TotalLifetimeDays: 3.5,
      TurnLatencyDays: 2.1,
      WaitDays: 2.0,
      CommitCount: 1,
      TotalMedianDays: 4.0,
      TotalP75Days: 6.0,
      TurnMedianDays: 2.5,
      TurnP75Days: 4.0,
      ReadyMedianDays: 2.0,
      ReadyP75Days: 3.5,
    };

    const md = generateSummaryMarkdown({
      progress,
      depths: null,
      historyRecords: [],
    });

    // Mermaid ブロック内の Target ノードに生引用符が含まれず、#quot; に置換されていること
    const targetMatch = md.match(/Target\["([^"]+)"\]/);
    expect(targetMatch).not.toBeNull();
    expect(targetMatch?.[1]).toContain("#quot;Example#quot;");
    expect(targetMatch?.[1]).not.toContain('"Example"');
  });
});
