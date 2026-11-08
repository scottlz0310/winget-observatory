import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GitHubApiClient } from "../../src/api/github";
import {
  parseArgs,
  type RecordForecastOptions,
  resolveDefaultDataDir,
  runRecordForecast,
} from "../../src/cli/record-forecast";
import type { ProgressPrDetail } from "../../src/models/progress";

const CSV_HEADER =
  '"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis"';
const csvRow = (jst: string, activeAhead: number) =>
  `"${jst}","123","1","2026-10-01 10:00","${activeAhead}","${activeAhead}","0","1","1","1","1","updated"`;

const pr = (overrides: Partial<ProgressPrDetail>): ProgressPrDetail => ({
  number: 123,
  title: "t",
  url: "u",
  state: "OPEN",
  isDraft: false,
  createdAt: "2026-10-29T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  labels: [],
  commits: [],
  ...overrides,
});

const clientOf = (detail: ProgressPrDetail) =>
  ({
    getPullRequestDetails: async () => detail,
  }) as Pick<GitHubApiClient, "getPullRequestDetails">;

describe("CLI: record-forecast parseArgs", () => {
  test("既定値: 基準 PR とリポジトリは共通の既定、保存先はリポジトリルートの data/", () => {
    const options = parseArgs([]);
    expect(options.targetPr).toBe(464302);
    expect(options.repository).toBe("microsoft/winget-pkgs");
    expect(options.dataDir).toBe(resolveDefaultDataDir());
    expect(options.dataDir).toBe(resolve(import.meta.dirname, "../../data"));
  });

  test("引数を解釈し、--data-dir は cwd 基準で解決する", () => {
    const options = parseArgs(["--target-pr", "99", "--repo", "o/r", "--data-dir", "rel/data"]);
    expect(options).toEqual({
      targetPr: 99,
      repository: "o/r",
      dataDir: resolve(process.cwd(), "rel/data"),
    });
  });

  test.each([
    [["--target-pr", "abc"], "--target-pr に無効な値"],
    [["--target-pr"], "必要です"],
    [["--repo", "--data-dir"], "必要です"],
    [["--data-dir"], "必要です"],
    [["--unknown"], "未知のオプションです: --unknown"],
  ])("不正な引数 %j を拒否する", (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });
});

describe("CLI: runRecordForecast", () => {
  let dir: string;
  let options: RecordForecastOptions;
  const historyPath = () => join(dir, "forecast-history.jsonl");
  const lines = () =>
    readFileSync(historyPath(), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  /** 24 時間で 100 件減（100 件/日、残り 2400 件 → 24 日後）と、先頭が進んでいない遭難の底 */
  const writeSnapshots = (timestamp = "2026-11-08T00:00:00Z", targetPr = 123) => {
    writeFileSync(
      join(dir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: timestamp,
        TargetPr: targetPr,
        ActiveAhead: 2400,
        TotalMedianDays: 44,
        TotalP75Days: 45,
      }),
      "utf-8",
    );
    writeFileSync(
      join(dir, "latest-depths.json"),
      JSON.stringify({
        TargetPr: {
          Number: targetPr,
          CreatedAt: "2026-10-29T00:00:00Z",
          UpdatedAt: "2026-11-05T00:00:00Z",
        },
      }),
      "utf-8",
    );
    writeFileSync(
      join(dir, "progress-history.csv"),
      `${CSV_HEADER}\n${csvRow("2026-11-07 09:00:00", 2500)}\n${csvRow("2026-11-08 09:00:00", 2400)}\n`,
      "utf-8",
    );
    const stale = (t: string) =>
      JSON.stringify({
        Timestamp: t,
        StaleBottom: [{ Number: 10, UpdatedAt: "2026-10-09T00:00:00Z" }],
      });
    writeFileSync(
      join(dir, "depths-history.jsonl"),
      `${stale("2026-11-07T00:00:00Z")}\n${stale("2026-11-08T00:00:00Z")}\n`,
      "utf-8",
    );
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winget-record-forecast-"));
    options = { targetPr: 123, repository: "o/r", dataDir: dir };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("未マージなら、3 つの仮説の予想日を観測時刻つきで 1 行追記する", async () => {
    writeSnapshots();
    const result = await runRecordForecast(options, clientOf(pr({})), () => {});

    expect(result.action).toBe("recorded");
    const [record] = lines();
    expect(record).toMatchObject({
      Type: "forecast",
      Timestamp: "2026-11-08T00:00:00Z",
      Repository: "o/r",
      TargetPr: 123,
    });
    const byKey = Object.fromEntries(
      record.Estimates.map((e: { Key: string; Date: string }) => [e.Key, e.Date.slice(0, 10)]),
    );
    // 順位消化: 最新の観測 (2026-11-08T00:00Z) + 24 日
    expect(byKey["rank-velocity"]).toBe("2026-12-02");
    // 更新順（定常）: 基準 PR の更新 11-05 − 先頭の更新 10-09 = 27 日、観測 11-08 + 27 日
    expect(byKey["update-order:steady"]).toBe("2026-12-05");
    // 作成順: 起票 10-29 + 中央値 44 日 / 75%点 45 日
    expect(byKey["creation-order:median"]).toBe("2026-12-12");
    expect(byKey["creation-order:p75"]).toBe("2026-12-13");
    // 先頭が進んでいないため、実測の進みによる予想は無い
    expect(byKey["update-order:observed"]).toBeUndefined();
  });

  test("同じ観測時刻の予想は二重に記録しない（古いスナップショットの再実行に備える）", async () => {
    writeSnapshots();
    await runRecordForecast(options, clientOf(pr({})), () => {});
    const second = await runRecordForecast(options, clientOf(pr({})), () => {});

    expect(second).toEqual({
      action: "skipped",
      reason: "観測時刻 2026-11-08T00:00:00Z の予想は記録済みです",
    });
    expect(lines()).toHaveLength(1);
  });

  test("観測時刻が新しければ追記して履歴を積み上げる", async () => {
    writeSnapshots("2026-11-08T00:00:00Z");
    await runRecordForecast(options, clientOf(pr({})), () => {});
    writeSnapshots("2026-11-08T04:00:00Z");
    await runRecordForecast(options, clientOf(pr({})), () => {});

    expect(lines().map((l) => l.Timestamp)).toEqual([
      "2026-11-08T00:00:00Z",
      "2026-11-08T04:00:00Z",
    ]);
  });

  test("マージ済みなら、予想ではなく結果を 1 回だけ記録し、以後は予想を記録しない", async () => {
    writeSnapshots();
    const merged = pr({ state: "MERGED", mergedAt: "2026-12-10T03:21:00Z" });
    const first = await runRecordForecast(options, clientOf(merged), () => {});
    const second = await runRecordForecast(options, clientOf(merged), () => {});

    expect(first.action).toBe("outcome");
    expect(second.action).toBe("skipped");
    const all = lines();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      Type: "outcome",
      Repository: "o/r",
      TargetPr: 123,
      MergedAt: "2026-12-10T03:21:00.000Z",
    });
  });

  test("未マージのままクローズされていれば何も記録しない", async () => {
    writeSnapshots();
    const result = await runRecordForecast(
      options,
      clientOf(pr({ state: "CLOSED", closedAt: "2026-11-08T00:00:00Z" })),
      () => {},
    );
    expect(result.action).toBe("skipped");
    expect(existsSync(historyPath())).toBe(false);
  });

  test("予想日を出せる仮説が 1 つも無ければ記録しない", async () => {
    writeSnapshots();
    // 統計・遭難の底・履歴をすべて外す
    writeFileSync(
      join(dir, "latest-progress.json"),
      JSON.stringify({ Timestamp: "2026-11-08T00:00:00Z", TargetPr: 123, ActiveAhead: 2400 }),
      "utf-8",
    );
    rmSync(join(dir, "progress-history.csv"));
    rmSync(join(dir, "depths-history.jsonl"));
    rmSync(join(dir, "latest-depths.json"));

    const result = await runRecordForecast(options, clientOf(pr({})), () => {});
    expect(result).toEqual({
      action: "skipped",
      reason: "予想日を出せる仮説がないため、記録しません",
    });
    expect(existsSync(historyPath())).toBe(false);
  });

  test("末尾が改行で終わっていない履歴にも、行が連結しないよう追記する", async () => {
    writeSnapshots();
    writeFileSync(
      historyPath(),
      JSON.stringify({
        Type: "outcome",
        Timestamp: "2026-01-01T00:00:00Z",
        Repository: "o/r",
        TargetPr: 999,
        MergedAt: "2026-01-01T00:00:00Z",
      }),
      "utf-8",
    );
    await runRecordForecast(options, clientOf(pr({})), () => {});
    expect(lines().map((l) => l.Type)).toEqual(["outcome", "forecast"]);
  });

  test.each([
    [
      "進捗スナップショットが無い",
      () => {},
      "進捗スナップショットが見つからないか、観測時刻がありません",
    ],
    [
      "進捗スナップショットが別の基準 PR のもの",
      () =>
        writeFileSync(
          join(dir, "latest-progress.json"),
          JSON.stringify({ Timestamp: "2026-11-08T00:00:00Z", TargetPr: 999 }),
        ),
      "基準 PR (#999) が対象 (#123) と一致しません",
    ],
    [
      "進捗スナップショットが壊れている",
      () => writeFileSync(join(dir, "latest-progress.json"), "{ broken"),
      "進捗スナップショットの読み込みに失敗しました",
    ],
  ])("握りつぶさず例外にする: %s", async (_name, setup, message) => {
    mkdirSync(dir, { recursive: true });
    setup();
    await expect(runRecordForecast(options, clientOf(pr({})), () => {})).rejects.toThrow(message);
  });

  test("予想履歴が壊れていればパスつきで中断し、GitHub へ問い合わせない", async () => {
    writeSnapshots();
    writeFileSync(historyPath(), "{ broken\n", "utf-8");
    let called = false;
    const client = {
      getPullRequestDetails: async () => {
        called = true;
        return pr({});
      },
    } as Pick<GitHubApiClient, "getPullRequestDetails">;

    await expect(runRecordForecast(options, client, () => {})).rejects.toThrow(
      /予想履歴の読み込みに失敗しました \(.*forecast-history\.jsonl\)/,
    );
    expect(called).toBe(false);
  });
});
