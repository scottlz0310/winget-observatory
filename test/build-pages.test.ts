import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../scripts/build-pages";

describe("buildDashboard", () => {
  test("データからダッシュボード HTML とコピーされたデータファイルを生成する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-test-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");

    const fs = require("node:fs");
    fs.mkdirSync(dataDir, { recursive: true });

    // テスト用ダミーデータ作成
    const dummyProgress = {
      TimestampJst: "2026-11-07 12:00:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: 123456,
      PrTitle: "Test package",
      FrontNumber: 120000,
      ActiveAhead: 100,
      TotalAhead: 150,
      Behind: 50,
      WaitDays: 5.5,
    };
    writeFileSync(join(dataDir, "latest-progress.json"), JSON.stringify(dummyProgress), "utf-8");

    const dummyDepths = {
      TimestampJst: "2026-11-07 12:00:00",
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

    const dummyCsv = `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount"
"2026-11-07 12:00:00","123456","120000","2026-10-01 10:00","100","150","50","5.5","5.5","5.5","1"
`;
    writeFileSync(join(dataDir, "progress-history.csv"), dummyCsv, "utf-8");

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      expect(existsSync(htmlPath)).toBe(true);

      const html = readFileSync(htmlPath, "utf-8");
      expect(html).toContain("123456");
      expect(html).toContain("Test package");
      expect(html).toContain("120000");
      expect(html).toContain("110000");
      expect(html).toContain("Deepest PR");
      expect(html).toContain("449320");
      expect(html).toContain("Stale package");
      expect(html).toContain("Winget Observatory Dashboard");

      // site/data へのコピーも確認
      expect(existsSync(join(outputDir, "data", "latest-progress.json"))).toBe(true);
      expect(existsSync(join(outputDir, "data", "progress-history.csv"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
