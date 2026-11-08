import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient, GitHubDetailedSearchResult } from "../../src/api/github";
import { type ProgressCliOptions, runProgressCli } from "../../src/cli/progress";
import { parseCsvRows } from "../../src/domain/progress";

const TARGET = 500;
const LABELS = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"];
const TARGET_CREATED = "2026-11-01T00:00:00Z";

function createClient(options: {
  mergedOlder: number;
  closedOlder: number;
  queries: string[];
  failClosedQuery?: boolean;
}): GitHubApiClient {
  return {
    getPullRequestDetails: async (_repo: string, num: number) => ({
      number: num,
      title: `PR ${num}`,
      url: `https://github.com/test/repo/pull/${num}`,
      state: "OPEN" as const,
      isDraft: false,
      // 履歴に残る起票時刻（ミリ秒を含む表記でも、検索クエリでは秒までにする）
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00Z",
      mergedAt: null,
      closedAt: null,
      labels: LABELS,
      commits: [{ oid: "abc", messageHeadline: "fix", committedDate: "2026-11-01T00:00:00Z" }],
    }),
    getIssueTimeline: async () =>
      LABELS.map((name) => ({
        event: "labeled",
        created_at: "2026-11-01T01:00:00Z",
        label: { name },
      })),
    searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
      options.queries.push(query);
      if (query.includes("created:<") && query.includes("is:merged")) {
        return { totalCount: options.mergedOlder, items: [] };
      }
      if (query.includes("created:<") && query.includes("is:closed")) {
        if (options.failClosedQuery) throw new Error("search boom");
        return { totalCount: options.closedOlder, items: [] };
      }
      if (query.includes("is:merged")) return { totalCount: 0, items: [] };
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

describe("CLI: 待ち行列からの離脱の累積件数の記録", () => {
  let dir: string;
  let csvPath: string;
  const options = (): ProgressCliOptions => ({
    targetPr: TARGET,
    repository: "test/repo",
    lookbackDays: 30,
    fetchBudget: 10,
    fetchLimit: 100,
    noLog: false,
    asJson: false,
    logPath: csvPath,
    snapshotPath: join(dir, "latest-progress.json"),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "winget-exit-"));
    csvPath = join(dir, "progress-history.csv");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("基準 PR の起票以降のマージ・クローズの累積件数を、履歴 CSV の行に残す", async () => {
    const queries: string[] = [];
    const logs: string[] = [];
    await runProgressCli(
      options(),
      createClient({ mergedOlder: 192, closedOlder: 27, queries }),
      (m) => logs.push(m),
    );

    const [row] = parseCsvRows(readFileSync(csvPath, "utf-8"));
    expect(row.MergedOlder).toBe("192");
    expect(row.ClosedOlder).toBe("27");
    expect(logs.join("\n")).toContain("マージ 192 件・未マージでクローズ 27 件");
  });

  test("検索クエリは、基準 PR の起票時刻（ミリ秒なし）を境に、必須ラベル付きの PR を数える", async () => {
    const queries: string[] = [];
    await runProgressCli(
      options(),
      createClient({ mergedOlder: 1, closedOlder: 1, queries }),
      () => {},
    );

    const labels = LABELS.map((l) => `label:"${l}"`).join(" ");
    expect(queries).toContain(
      `repo:test/repo is:pr created:<${TARGET_CREATED} ${labels} is:merged merged:>=${TARGET_CREATED}`,
    );
    expect(queries).toContain(
      `repo:test/repo is:pr created:<${TARGET_CREATED} ${labels} is:closed is:unmerged closed:>=${TARGET_CREATED}`,
    );
  });

  test("観測のたびに累積件数を行として積み上げる（旧い行は空欄のまま残る）", async () => {
    await runProgressCli(
      options(),
      createClient({ mergedOlder: 100, closedOlder: 10, queries: [] }),
      () => {},
    );
    await runProgressCli(
      options(),
      createClient({ mergedOlder: 124, closedOlder: 14, queries: [] }),
      () => {},
    );

    const rows = parseCsvRows(readFileSync(csvPath, "utf-8"));
    expect(rows.map((r) => [r.MergedOlder, r.ClosedOlder])).toEqual([
      ["100", "10"],
      ["124", "14"],
    ]);
  });

  test("件数の取得に失敗したら、握りつぶさず中断し、履歴に行を追加しない", async () => {
    await expect(
      runProgressCli(
        options(),
        createClient({ mergedOlder: 1, closedOlder: 1, queries: [], failClosedQuery: true }),
        () => {},
      ),
    ).rejects.toThrow("search boom");
    expect(existsSync(csvPath)).toBe(false);
  });
});
