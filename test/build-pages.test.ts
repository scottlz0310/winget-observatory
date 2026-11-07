import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../scripts/build-pages";

describe("buildDashboard", () => {
  test("データからダッシュボード HTML とコピーされたデータファイルを生成し、Velocity・ETA・Δ・パーセンタイル統計を出力する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-test-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");

    mkdirSync(dataDir, { recursive: true });

    // テスト用ダミーデータ作成（パーセンタイル統計を含む）
    const dummyProgress = {
      TimestampJst: "2026-11-07 12:00:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: 123456,
      PrTitle: "Test package",
      FrontNumber: 120000,
      FrontCreatedAt: "2026-10-01 10:00",
      ActiveAhead: 100,
      TotalAhead: 150,
      Behind: 50,
      WaitDays: 5.5,
      TotalMedianDays: 30.5,
      TotalP75Days: 45.0,
      TurnMedianDays: 4.2,
      TurnP75Days: 6.8,
      ReadyMedianDays: 2.5,
      ReadyP75Days: 5.0,
    };
    writeFileSync(join(dataDir, "latest-progress.json"), JSON.stringify(dummyProgress), "utf-8");

    const dummyDepths = {
      TimestampJst: "2026-11-07 12:00:00",
      TargetPr: {
        Number: 123456,
        Title: "Test package",
        CreatedAtJst: "2026-10-25 10:00", // 前線 2026-10-01 との差: 24 日
      },
      HealthyBottom: [
        {
          Number: 110000,
          Title: "Deepest PR",
          Url: "https://github.com/microsoft/winget-pkgs/pull/110000",
        },
      ],
      StaleBottom: [
        {
          Number: 449320,
          Title: "Stale package",
          Url: "https://github.com/microsoft/winget-pkgs/pull/449320",
          作成日時: "2026-10-09 13:39",
          更新日時: "2026-10-09 14:54",
        },
      ],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(dummyDepths), "utf-8");

    // 24 時間で 50 件消化（150 -> 100）の時系列推移
    const dummyCsv = `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount"
"2026-11-06 12:00:00","123456","119950","2026-09-30 10:00","150","200","40","4.5","4.5","4.5","1"
"2026-11-07 12:00:00","123456","120000","2026-10-01 10:00","100","150","50","5.5","5.5","5.5","1"
`;
    writeFileSync(join(dataDir, "progress-history.csv"), dummyCsv, "utf-8");

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      expect(existsSync(htmlPath)).toBe(true);

      const html = readFileSync(htmlPath, "utf-8");

      // 基本情報
      expect(html).toContain("123456");
      expect(html).toContain("Test package");
      expect(html).toContain("120000");
      expect(html).toContain("110000");
      expect(html).toContain("Deepest PR");
      expect(html).toContain("Winget Observatory Dashboard");

      // 新指標: 前回比 Δ バッジ
      expect(html).toContain("delta-badge delta-progress");
      expect(html).toContain("-50");

      // 新指標: Velocity & ETA（24時間で50件消化 = 日速50件、残り100件で約2日後）
      expect(html).toContain("到着予測 (ETA) &amp; 消化速度");
      expect(html).toContain("約 2");
      expect(html).toContain("日後");
      expect(html).toContain("50 件/日");

      // 新指標: カレンダー距離 (2026-10-01 〜 2026-10-25 = 24 日)
      expect(html).toContain("カレンダー距離 (日付ギャップ)");
      expect(html).toContain("差 24 日");

      // 新指標: パーセンタイル統計
      expect(html).toContain("マージ実績の所要日数統計");
      expect(html).toContain("手番所要日数 (Turn Latency)");
      expect(html).toContain("4.2");
      expect(html).toContain("6.8");
      expect(html).toContain("Ready 成立後所要日数 (Ready Latency)");
      expect(html).toContain("2.5");
      expect(html).toContain("5");
      expect(html).toContain("通算所要日数 (Total Lifetime)");
      expect(html).toContain("30.5");
      expect(html).toContain("45");

      // site/data へのコピー確認
      expect(existsSync(join(outputDir, "data", "latest-progress.json"))).toBe(true);
      expect(existsSync(join(outputDir, "data", "progress-history.csv"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
