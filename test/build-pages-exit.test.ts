import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../scripts/build-pages";

const HEADER =
  '"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis","MergedOlder","ClosedOlder"';

/** JST の時刻（"YYYY-MM-DD HH:mm:ss"）と待ち件数・離脱の累積件数から、基準 PR 464302 の履歴行を作る */
const row = (
  jst: string,
  activeAhead: number,
  totalAhead: number,
  mergedOlder: number | "",
  closedOlder: number | "",
) =>
  `"${jst}","464302","1","2026-10-01 10:00","${activeAhead}","${totalAhead}","0","1","1","1","1","updated","${mergedOlder}","${closedOlder}"`;

describe("buildDashboard: 待ち行列からの離脱の内訳", () => {
  let tempDir: string;
  let dataDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "winget-obs-exit-"));
    dataDir = join(tempDir, "data");
    outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const build = (rows: string[]) => {
    writeFileSync(
      join(dataDir, "progress-history.csv"),
      `${HEADER}\n${rows.join("\n")}\n`,
      "utf-8",
    );
    return readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
  };

  test("実質待ちの減少を、マージ・クローズ・健康条件の変化・順位の入れ替わりに分けて表に示す", () => {
    // 24 時間で、実質待ち 100 件減、累積待ち 30 件減、マージ 24 件、クローズ 4 件
    const html = build([
      row("2026-11-07 09:00:00", 2500, 2100, 100, 10),
      row("2026-11-08 09:00:00", 2400, 2070, 124, 14),
    ]);

    expect(html).toContain("🧮 待ち行列からの離脱の内訳");
    expect(html).toContain("2026-11-07 09:00 〜 2026-11-08 09:00（24 時間）の変化");
    expect(html).toContain("実質待ちの減少のうち、実際のマージは約 <strong>24%</strong> です");

    const section = html.slice(
      html.indexOf("🧮 待ち行列からの離脱の内訳"),
      html.indexOf("マージ実績の所要日数統計"),
    );
    const cells = (label: string) =>
      [
        ...section.matchAll(
          new RegExp(
            `${label}</td>\\s*<td>([^<]*)</td>\\s*<td>([^<]*)</td>\\s*<td>([^<]*)</td>`,
            "g",
          ),
        ),
      ][0]?.slice(1);
    expect(cells("実質待ち（更新順）の減少")).toEqual(["100 件", "100 件/日", "100%"]);
    expect(cells("マージ")).toEqual(["24 件", "24 件/日", "24%"]);
    expect(cells("未マージでクローズ")).toEqual(["4 件", "4 件/日", "4%"]);
    expect(cells("健康条件の変化など（推定）")).toEqual(["2 件", "2 件/日", "2%"]);
    expect(cells("更新による順位の入れ替わり（推定）")).toEqual(["70 件", "70 件/日", "70%"]);
  });

  test("待ち件数の推移の直後、所要日数統計の前に置く", () => {
    const html = build([
      row("2026-11-07 09:00:00", 2500, 2100, 100, 10),
      row("2026-11-08 09:00:00", 2400, 2070, 124, 14),
    ]);
    const chart = html.indexOf("📉 待ち件数の推移");
    const exit = html.indexOf("🧮 待ち行列からの離脱の内訳");
    const stats = html.indexOf("⏱️ マージ実績の所要日数統計");
    expect(chart).toBeGreaterThan(-1);
    expect(chart).toBeLessThan(exit);
    expect(exit).toBeLessThan(stats);
  });

  test("離脱の累積件数が無い旧い行だけなら、記録が貯まるまで内訳を出さない", () => {
    const html = build([
      row("2026-11-07 09:00:00", 2500, 2100, "", ""),
      row("2026-11-08 09:00:00", 2400, 2070, "", ""),
    ]);
    expect(html).toContain("内訳の記録は、この機能の導入後の観測から貯まります");
    expect(html).not.toContain("実際のマージは約");
  });

  test("観測の間隔が短ければ、内訳を出さず理由を示す", () => {
    const html = build([
      row("2026-11-08 09:00:00", 2500, 2100, 100, 10),
      row("2026-11-08 10:00:00", 2490, 2095, 102, 10),
    ]);
    expect(html).toContain("観測の間隔が短いため、内訳を出せません（6 時間以上の間隔が必要です）");
  });

  test("累積件数が減っているなど記録が矛盾していれば、内訳を出さず理由を示す", () => {
    const html = build([
      row("2026-11-07 09:00:00", 2500, 2100, 100, 10),
      row("2026-11-08 09:00:00", 2400, 2070, 90, 14),
    ]);
    expect(html).toContain("記録が矛盾しているため、内訳を出せません");
  });

  test("実質待ちが減っていなければ、マージの割合は出さない", () => {
    const html = build([
      row("2026-11-07 09:00:00", 2400, 2000, 100, 10),
      row("2026-11-08 09:00:00", 2450, 2010, 120, 10),
    ]);
    expect(html).toContain("実質待ちが減っていないため、マージの割合は出せません");
    expect(html).toContain("<td>-50 件</td>");
  });
});
