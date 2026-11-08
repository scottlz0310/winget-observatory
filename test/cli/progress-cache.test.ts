import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient, GitHubDetailedSearchResult } from "../../src/api/github";
import { logRateLimit, type ProgressCliOptions, runProgressCli } from "../../src/cli/progress";

const TARGET = 500;
const LABELS = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"];

const labeledAt = (iso: string) =>
  LABELS.map((name) => ({ event: "labeled", created_at: iso, label: { name } }));

/** 候補の PR 番号 → マージ時刻。番号が大きいほど新しくマージされたものとする */
const mergedAtOf = (n: number) => `2026-11-0${n - 2000}T12:00:00Z`;

interface Calls {
  timeline: number[];
  detail: number[];
}

function createClient(options: {
  candidates: number[];
  /** 条件が成立した時刻を特定できない（ラベルが付いていない）候補 */
  noReady?: number[];
  /** タイムライン取得に失敗する候補 */
  failTimeline?: number[];
  calls: Calls;
}): GitHubApiClient {
  const { candidates, noReady = [], failTimeline = [], calls } = options;
  return {
    getPullRequestDetails: async (_repo: string, num: number) => {
      if (num !== TARGET) calls.detail.push(num);
      return {
        number: num,
        title: `PR ${num}`,
        url: `https://github.com/test/repo/pull/${num}`,
        state: "OPEN" as const,
        isDraft: false,
        createdAt: num === TARGET ? "2026-11-01T00:00:00Z" : "2026-10-20T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels: LABELS,
        commits: [{ oid: "abc", messageHeadline: "fix", committedDate: "2026-10-21T00:00:00Z" }],
      };
    },
    getIssueTimeline: async (_repo: string, num: number) => {
      if (num !== TARGET) calls.timeline.push(num);
      if (failTimeline.includes(num)) throw new Error("timeline boom");
      if (noReady.includes(num)) return [];
      return labeledAt(num === TARGET ? "2026-11-01T01:00:00Z" : "2026-10-20T01:00:00Z");
    },
    searchIssuesDetailed: async (
      query: string,
      _sort?: string,
      _order?: string,
      _perPage?: number,
      page = 1,
    ): Promise<GitHubDetailedSearchResult> => {
      if (query.includes("is:merged")) {
        if (page > 1) return { totalCount: candidates.length, items: [] };
        return {
          totalCount: candidates.length,
          // 検索は更新順で返るため、わざと並べ替えて渡す（CLI がマージ順に整える）
          items: [...candidates].reverse().map((n) => ({
            number: n,
            title: `Merged ${n}`,
            html_url: `https://github.com/test/repo/pull/${n}`,
            created_at: "2026-10-20T00:00:00Z",
            updated_at: mergedAtOf(n),
            labels: LABELS.map((name) => ({ name })),
            is_draft: false,
            pull_request: { merged_at: mergedAtOf(n) },
          })),
        };
      }
      return {
        totalCount: 3,
        items: [
          {
            number: 100,
            title: "Oldest healthy PR",
            html_url: "https://github.com/test/repo/pull/100",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            labels: [],
          },
        ],
      };
    },
  } as unknown as GitHubApiClient;
}

describe("CLI: マージ済み PR のサンプルキャッシュ", () => {
  let dir: string;
  let cachePath: string;
  let calls: Calls;
  const options = (overrides: Partial<ProgressCliOptions> = {}): ProgressCliOptions => ({
    targetPr: TARGET,
    repository: "test/repo",
    lookbackDays: 30,
    fetchBudget: 2,
    fetchLimit: 1000,
    noLog: true,
    asJson: false,
    cachePath,
    ...overrides,
  });
  const cacheLines = () =>
    readFileSync(cachePath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winget-sample-cache-"));
    cachePath = join(dir, "merged-samples.jsonl");
    calls = { timeline: [], detail: [] };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (
    candidates: number[],
    overrides: Partial<ProgressCliOptions> = {},
    extra: Partial<Parameters<typeof createClient>[0]> = {},
  ) => {
    const logs: string[] = [];
    const res = await runProgressCli(
      options(overrides),
      createClient({ candidates, calls, ...extra }),
      (msg) => logs.push(msg),
    );
    return { snapshot: res.snapshot, logs };
  };

  test("取得予算の範囲で新しい順に取得して保存し、未取得の候補は次回に回す", async () => {
    const { snapshot, logs } = await run([2001, 2002, 2003, 2004, 2005]);

    // 新しくマージされた 2005, 2004 だけを取得
    expect(calls.timeline).toEqual([2005, 2004]);
    expect(snapshot?.SampleCount).toBe(2);
    expect(cacheLines().map((l) => l.Number)).toEqual([2005, 2004]);
    expect(cacheLines()[0]).toMatchObject({ Type: "sample", Number: 2005, Title: "Merged 2005" });
    expect(logs.join("\n")).toContain("今回の新規取得 2 件／予算 2 件");
    expect(logs.join("\n")).toContain("未取得の候補 3 件は次回以降に取得します");
  });

  test("次回以降はキャッシュを再利用し、古い候補を予算の分だけ取得して、統計の件数が積み上がる", async () => {
    const all = [2001, 2002, 2003, 2004, 2005];
    const counts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const { snapshot } = await run(all);
      counts.push(snapshot?.SampleCount ?? -1);
    }

    // 2 → 4 → 5（全件）→ 5（新規取得なし）
    expect(counts).toEqual([2, 4, 5, 5]);
    // 各 PR のタイムライン取得は 1 回だけ（再取得しない）
    expect([...calls.timeline].sort()).toEqual([2001, 2002, 2003, 2004, 2005]);
    expect([...calls.detail].sort()).toEqual([2001, 2002, 2003, 2004, 2005]);
    // キャッシュは重複せず 5 行
    expect(cacheLines().map((l) => l.Number)).toEqual([2005, 2004, 2003, 2002, 2001]);
  });

  test("新しくマージされた PR は、次回の予算でまず取得する", async () => {
    await run([2001, 2002, 2003]);
    calls.timeline.length = 0;
    // 2004 が新しくマージされた
    const { snapshot } = await run([2001, 2002, 2003, 2004]);

    expect(calls.timeline).toEqual([2004, 2001]);
    expect(snapshot?.SampleCount).toBe(4);
  });

  test("条件不成立で除外した PR も記録し、再取得せず、除外件数に数える", async () => {
    const first = await run([2001, 2002], { fetchBudget: 10 }, { noReady: [2002] });
    expect(first.snapshot?.SkippedCount).toBe(1);
    expect(cacheLines().find((l) => l.Number === 2002)).toMatchObject({
      Type: "skipped",
      Reason: "no-ready",
    });

    calls.timeline.length = 0;
    const second = await run([2001, 2002], { fetchBudget: 10 }, { noReady: [2002] });
    expect(calls.timeline).toEqual([]);
    expect(second.snapshot?.SkippedCount).toBe(1);
    expect(second.snapshot?.SampleCount).toBe(1);
  });

  test("キャッシュを指定しなければ毎回取得し直し、ファイルも作らない（従来の挙動）", async () => {
    const noCache = { cachePath: undefined };
    const first = await run([2001, 2002, 2003], noCache);
    await run([2001, 2002, 2003], noCache);

    expect(first.snapshot?.SampleCount).toBe(2);
    // 2 回とも新しい 2 件を取得
    expect(calls.timeline).toEqual([2003, 2002, 2003, 2002]);
    expect(existsSync(cachePath)).toBe(false);
  });

  test("期間外になった（候補に出てこない）キャッシュは統計に使わない", async () => {
    writeFileSync(
      cachePath,
      `${JSON.stringify({
        Type: "sample",
        Number: 9999,
        Title: "old",
        CreatedAt: "2025-01-01T00:00:00Z",
        LatestCommittedDate: "2025-01-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2025-01-01T01:00:00Z",
        MergedAt: "2025-02-01T00:00:00Z",
        TotalDays: 31,
        TurnDays: 31,
        ReadyDays: 30,
      })}\n`,
      "utf-8",
    );
    const { snapshot } = await run([2001]);
    expect(snapshot?.SampleCount).toBe(1);
  });

  test("計測が途中で失敗しても、取得済みの分はキャッシュに保存して、次回の再取得を避ける", async () => {
    await expect(
      run([2001, 2002, 2003], { fetchBudget: 10 }, { failTimeline: [2002] }),
    ).rejects.toThrow("マージ済み PR #2002 のサンプル計測に失敗しました: timeline boom");

    // 失敗した 2002 より前に処理した 2003 は保存される
    expect(cacheLines().map((l) => l.Number)).toEqual([2003]);

    calls.timeline.length = 0;
    const { snapshot } = await run([2001, 2002, 2003], { fetchBudget: 10 });
    expect(calls.timeline).toEqual([2002, 2001]);
    expect(snapshot?.SampleCount).toBe(3);
  });

  test("キャッシュが壊れていれば、統計を歪めないよう、パスつきで中断する", async () => {
    writeFileSync(cachePath, "{ broken\n", "utf-8");
    await expect(run([2001])).rejects.toThrow(
      /サンプルキャッシュの読み込みに失敗しました \(.*merged-samples\.jsonl\).*1 行目/,
    );
    expect(calls.timeline).toEqual([]);
  });

  test("末尾が改行で終わっていないキャッシュにも、行が連結しないよう追記する", async () => {
    await run([2001], { fetchBudget: 1 });
    writeFileSync(cachePath, readFileSync(cachePath, "utf-8").trimEnd(), "utf-8");
    await run([2001, 2002], { fetchBudget: 1 });
    expect(cacheLines().map((l) => l.Number)).toEqual([2001, 2002]);
  });
});

describe("CLI: logRateLimit", () => {
  const bucket = (limit: number, remaining: number) => ({
    limit,
    remaining,
    resetAt: "2026-11-08T07:00:00.000Z",
  });

  test("core と search の残量・使用量・リセット時刻を 1 行で出す", async () => {
    const logs: string[] = [];
    await logRateLimit(
      { getRateLimit: async () => ({ core: bucket(1000, 640), search: bucket(30, 22) }) },
      (m) => logs.push(m),
    );
    expect(logs).toEqual([
      "[RateLimit] core: 残り 640 / 1000（使用 360） リセット 2026-11-08T07:00:00.000Z / search: 残り 22 / 30（使用 8） リセット 2026-11-08T07:00:00.000Z",
    ]);
  });

  test("取得に失敗しても例外にせず、警告として原因を残す（診断は計測の成否に影響させない）", async () => {
    const logs: string[] = [];
    await logRateLimit(
      {
        getRateLimit: async () => {
          throw new Error("503 boom");
        },
      },
      (m) => logs.push(m),
    );
    expect(logs).toEqual(["::warning::レート制限の残量を取得できませんでした: 503 boom"]);
  });
});
