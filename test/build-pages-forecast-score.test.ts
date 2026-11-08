import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../scripts/build-pages";

const DAY = 24 * 60 * 60 * 1000;
const MERGED = Date.parse("2026-12-10T00:00:00Z");

const forecast = (timestamp: string, daysFromMerge: number) =>
  JSON.stringify({
    Type: "forecast",
    Timestamp: timestamp,
    Repository: "microsoft/winget-pkgs",
    TargetPr: 123,
    Estimates: [
      {
        Key: "rank-velocity",
        Hypothesis: "rank-velocity",
        Date: new Date(MERGED + daysFromMerge * DAY).toISOString(),
        EtaDays: 1,
        Primary: true,
      },
    ],
  });

const outcome = JSON.stringify({
  Type: "outcome",
  Timestamp: "2026-12-10T01:00:00Z",
  Repository: "microsoft/winget-pkgs",
  TargetPr: 123,
  MergedAt: new Date(MERGED).toISOString(),
});

describe("buildDashboard: 予想の答え合わせ", () => {
  let tempDir: string;
  let dataDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "winget-obs-score-"));
    dataDir = join(tempDir, "data");
    outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const build = () => readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

  test("予想履歴が無ければ、結果が出たら採点する旨と記録件数 0 を示す", () => {
    const html = build();
    expect(html).toContain("🎯 予想の答え合わせ");
    expect(html).toContain("記録済みの予想 0 件");
  });

  test("結果が未記録なら、記録済みの予想の件数だけを示して採点表は出さない", () => {
    writeFileSync(
      join(dataDir, "forecast-history.jsonl"),
      `${forecast("2026-11-08T00:00:00Z", 4)}\n${forecast("2026-11-09T00:00:00Z", 3)}\n`,
      "utf-8",
    );
    const html = build();
    expect(html).toContain("記録済みの予想 2 件");
    expect(html).not.toContain("平均絶対誤差");
  });

  test("結果が記録されていれば、仮説・モデルごとの誤差を符号つきで表に示す", () => {
    writeFileSync(
      join(dataDir, "forecast-history.jsonl"),
      // 予想が 4 日遅い → +4、次は 2 日早い → -2。平均 +1、平均絶対 3、最後 -2
      `${forecast("2026-11-08T00:00:00Z", 4)}\n${forecast("2026-11-20T00:00:00Z", -2)}\n${outcome}\n`,
      "utf-8",
    );
    const html = build();
    expect(html).toContain("microsoft/winget-pkgs #123（マージ: 2026-12-10、予想の記録 2 回）");
    expect(html).toContain("① 順位消化");
    expect(html).toContain("<td>2 件</td>");
    expect(html).toContain("<td>+1 日</td>");
    expect(html).toContain("<td>3 日</td>");
    expect(html).toContain("<td>-2 日</td>");
    expect(html).not.toContain(
      "基準 PR がマージされると、仮説・モデルごとの予想誤差をここに表示します",
    );
  });

  test("予想履歴が壊れていれば、空の採点を出さずパスつきで中断する", () => {
    writeFileSync(join(dataDir, "forecast-history.jsonl"), "{ broken\n", "utf-8");
    expect(() => buildDashboard({ dataDir, outputDir })).toThrow("予想履歴");
    expect(() => buildDashboard({ dataDir, outputDir })).toThrow("forecast-history.jsonl");
  });

  test("予想履歴を公開データとしてコピーし、フッターからリンクする", () => {
    writeFileSync(
      join(dataDir, "forecast-history.jsonl"),
      `${forecast("2026-11-08T00:00:00Z", 4)}\n`,
      "utf-8",
    );
    const html = build();
    expect(existsSync(join(outputDir, "data", "forecast-history.jsonl"))).toBe(true);
    expect(html).toContain('href="data/forecast-history.jsonl"');
  });
});
