import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient, GitHubDetailedSearchResult } from "../../src/api/github";
import { runProgressCli } from "../../src/cli/progress";
import { REQUIRED_LABELS } from "../../src/domain/progress";
import { parseSampleCache, serializeSampleCacheEntries } from "../../src/domain/sample-cache";
import type { CachedSampleEntry, SampleCacheEntry } from "../../src/models/sample-cache";

describe("CLI: 過去実績との比較・ライバル PR", () => {
  const labels = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"].map((name) => ({
    name,
  }));
  const created: Record<number, string> = {
    500: "2026-11-01T00:00:00Z",
    400: "2026-10-20T00:00:00Z",
    450: "2026-10-25T00:00:00Z",
    600: "2026-11-02T00:00:00Z",
  };
  const merged: Record<number, string> = {
    400: "2026-11-04T00:00:00Z",
    450: "2026-11-03T00:00:00Z",
    600: "2026-11-02T12:00:00Z",
  };

  const buildClient = (): GitHubApiClient =>
    ({
      graphql: async <T = unknown>(_query: string): Promise<T> => ({}) as T,
      getPullRequestDetails: async (_repo: string, num: number) => ({
        number: num,
        title: `PR ${num}`,
        url: `https://github.com/test/repo/pull/${num}`,
        state: "OPEN" as const,
        isDraft: false,
        createdAt: created[num],
        updatedAt: created[num],
        mergedAt: null,
        closedAt: null,
        labels: labels.map((l) => l.name),
        commits: [{ oid: "abcdef0123", messageHeadline: "fix", committedDate: created[num] }],
      }),
      getIssueTimeline: async (_repo: string, num: number) =>
        labels.map((l) => ({
          event: "labeled",
          created_at: new Date(Date.parse(created[num]) + 3_600_000).toISOString(),
          label: { name: l.name },
        })),
      getPullRequestSampleData: async (_repo: string, num: number) => ({
        createdAt: created[num],
        commitCount: 1,
        latestCommittedDate: created[num],
        timeline: labels.map((l) => ({
          event: "labeled",
          created_at: new Date(Date.parse(created[num]) + 3_600_000).toISOString(),
          label: { name: l.name },
        })),
      }),
      searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
        if (query.includes("is:merged")) {
          return {
            totalCount: 3,
            items: [400, 450, 600].map((n) => ({
              number: n,
              title: `Merged ${n}`,
              html_url: `https://github.com/test/repo/pull/${n}`,
              created_at: created[n],
              updated_at: merged[n],
              pull_request: { merged_at: merged[n] },
            })),
          };
        }
        return {
          totalCount: 4,
          items: [
            // 基準 PR より新しい番号はライバルから除く（阻害ラベルは Search クエリ側で除外済み）
            {
              number: 700,
              title: "Newer",
              html_url: "u",
              created_at: "2026-11-03T00:00:00Z",
              updated_at: "2026-11-03T00:00:00Z",
            },
            {
              number: 470,
              title: "Healthy rival",
              html_url: "https://github.com/test/repo/pull/470",
              created_at: "2026-10-28T00:00:00Z",
              updated_at: "2026-10-29T00:00:00Z",
            },
          ],
        };
      },
    }) as unknown as GitHubApiClient;

  const options = {
    targetPr: 500,
    repository: "test/repo",
    lookbackDays: 30,
    fetchBudget: 10,
    fetchLimit: 100,
    noLog: true,
    asJson: false,
  };

  test("過去に IsFirstTimer: true でキャッシュされていた作者について、走査対象に別 PR が存在する場合に常連判定されて IsFirstTimer: false に更新される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-cache-invalidation-test-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;

      // 60日前の PR #601: 以前の観測で IsFirstTimer: true としてキャッシュ保存されている
      const merged60d = new Date(now.getTime() - 60 * dayMs).toISOString();
      const initialCachedEntry: SampleCacheEntry = {
        Type: "sample",
        Number: 601,
        Title: "PR 601 (Initial)",
        CreatedAt: new Date(now.getTime() - 65 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 65 * dayMs).toISOString(),
        CommitCount: 1,
        ReadyAt: new Date(now.getTime() - 63 * dayMs).toISOString(),
        MergedAt: merged60d,
        TotalDays: 5,
        TurnDays: 5,
        ReadyDays: 3,
        Author: "repeat-author",
        IsFirstTimer: true, // キャッシュ時点では初回扱い
        FirstTimerVersion: 7,
      };
      writeFileSync(cachePath, serializeSampleCacheEntries([initialCachedEntry]), "utf-8");

      // 今回の観測: 45日前に同じ author "repeat-author" の別 PR #602 が見つかる
      const merged45d = new Date(now.getTime() - 45 * dayMs).toISOString();

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            return {
              totalCount: 2,
              items: [
                {
                  number: 601,
                  title: "PR 601",
                  html_url: "u601",
                  created_at: new Date(now.getTime() - 65 * dayMs).toISOString(),
                  updated_at: merged60d,
                  author: "repeat-author",
                  pull_request: { merged_at: merged60d },
                },
                {
                  number: 602,
                  title: "PR 602 (Another PR by same author)",
                  html_url: "u602",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  author: "repeat-author", // 同一作者！
                  pull_request: { merged_at: merged45d },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 100,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        () => {},
      );

      // #601 は同じ author の #602 が存在するため、IsFirstTimer が false に取り消され、初回コホートから除外されること
      expect(snapshot?.FirstTimerSampleCount).toBe(0);

      // キャッシュファイル内でも IsFirstTimer: false に更新・永続化されていること
      const updatedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached601 = updatedCache.find((e) => e.Number === 601);
      expect(cached601?.Type).toBe("sample");
      if (cached601?.Type === "sample") {
        expect(cached601.IsFirstTimer).toBe(false);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("not-first-timer-candidate として除外された PR が、全体集計窓の拡大（lookbackDays=60）により全体枠に入った場合はキャッシュのスキップが解除されて再評価・採用される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-reeval-test-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;

      // 45日前の 2コミット PR #701: 以前の lookbackDays=30 の実行で
      // 30日超の窓で 2 コミットだったため not-first-timer-candidate として除外キャッシュ保存されている
      const merged45d = new Date(now.getTime() - 45 * dayMs).toISOString();
      const initialSkippedEntry: SampleCacheEntry = {
        Type: "skipped",
        Number: 701,
        MergedAt: merged45d,
        Reason: "not-first-timer-candidate",
      };
      writeFileSync(cachePath, serializeSampleCacheEntries([initialSkippedEntry]), "utf-8");

      let detailsFetched = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            return {
              totalCount: 1,
              items: [
                {
                  number: 701,
                  title: "PR 701 (2 commits)",
                  html_url: "u701",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  author: "user-701",
                  pull_request: { merged_at: merged45d },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, prNumber: number) => {
          const isTarget = prNumber === options.targetPr;
          return {
            number: prNumber,
            title: `PR ${prNumber}`,
            url: `https://github.com/microsoft/winget-pkgs/pull/${prNumber}`,
            state: (isTarget ? "OPEN" : "MERGED") as "OPEN" | "MERGED",
            isDraft: false,
            createdAt: new Date(now.getTime() - 50 * dayMs).toISOString(),
            updatedAt: merged45d,
            mergedAt: isTarget ? null : merged45d,
            closedAt: null,
            commitCount: 2,
            commits: [
              {
                committedDate: new Date(now.getTime() - 48 * dayMs).toISOString(),
                oid: "c2",
              },
            ],
            labels: REQUIRED_LABELS,
          };
        },
        getPullRequestSampleData: async (_repo: string, prNumber: number) => {
          if (prNumber === 701) detailsFetched = true;
          return {
            createdAt: new Date(now.getTime() - 50 * dayMs).toISOString(),
            commitCount: 2,
            latestCommittedDate: new Date(now.getTime() - 48 * dayMs).toISOString(),
            author: "user-701",
            timeline: REQUIRED_LABELS.map((name) => ({
              event: "labeled",
              created_at: new Date(now.getTime() - 48 * dayMs).toISOString(),
              label: { name },
            })),
          };
        },
        getIssueTimeline: async () => {
          return REQUIRED_LABELS.map((name) => ({
            event: "labeled",
            created_at: new Date(now.getTime() - 48 * dayMs).toISOString(),
            label: { name },
          }));
        },
      } as unknown as GitHubApiClient;

      // lookbackDays: 60 に変更して実行！
      // 45日前の PR #701 は 60 日窓（全体集計枠）に入るため、キャッシュの skipped が解除されて詳細取得される
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 100,
          lookbackDays: 60, // 30日 -> 60日に拡大！
          firstTimerLookbackDays: 90,
        },
        client,
        () => {},
      );

      // 詳細 API が呼ばれたこと
      expect(detailsFetched).toBe(true);
      // 全体実績サンプルとして採用されたこと（SampleCount = 1）
      expect(snapshot?.SampleCount).toBe(1);
      // SkippedCount は 0 であること（除外されなくなった）
      expect(snapshot?.SkippedCount).toBe(0);

      // キャッシュファイル内でも sample に上書き更新されていること
      const updatedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached701 = updatedCache.find((e) => e.Number === 701);
      expect(cached701?.Type).toBe("sample");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("コミット数制限の撤廃: 複数コミット（手直しあり）の初回提出者（生涯マージ1件）がコホートに採用され、通算とTurn Latencyの両指標が記録される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-first-timer-multi-commits-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;
      const labels = REQUIRED_LABELS.map((name) => ({ name }));

      // 20日前にマージされた 3 コミットの PR #801（手直しありの初回提出者）
      // 作成: 35日前 (通算 15日)
      // 最終コミット: 25日前 (Turn Latency 5日)
      // 累計マージ数照会で issueCount: 1（生涯マージ1件の初回提出者）
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            return {
              totalCount: 1,
              items: [
                {
                  number: 801,
                  title: "PR 801 (3 commits, first timer)",
                  html_url: "u801",
                  created_at: new Date(now.getTime() - 35 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 20 * dayMs).toISOString(),
                  author: "newbie-dev",
                  pull_request: { merged_at: new Date(now.getTime() - 20 * dayMs).toISOString() },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === options.targetPr) {
            return {
              number: options.targetPr,
              title: "Target PR",
              url: "uTarget",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: new Date(now.getTime() - 10 * dayMs).toISOString(),
              updatedAt: new Date(now.getTime() - 10 * dayMs).toISOString(),
              mergedAt: null,
              closedAt: null,
              labels: labels.map((l) => l.name),
              commitCount: 1,
              commits: [
                {
                  oid: "c0",
                  messageHeadline: "init",
                  committedDate: new Date(now.getTime() - 10 * dayMs).toISOString(),
                },
              ],
            };
          }
          throw new Error(`Unexpected PR #${num}`);
        },
        getPullRequestSampleData: async () => ({
          createdAt: new Date(now.getTime() - 35 * dayMs).toISOString(),
          commitCount: 3,
          latestCommittedDate: new Date(now.getTime() - 25 * dayMs).toISOString(),
          author: "newbie-dev",
          timeline: labels.map((l) => ({
            event: "labeled",
            created_at: new Date(now.getTime() - 34 * dayMs).toISOString(),
            label: { name: l.name },
          })),
        }),
        getIssueTimeline: async () => {
          return labels.map((l) => ({
            event: "labeled",
            created_at: new Date(now.getTime() - 34 * dayMs).toISOString(),
            label: { name: l.name },
          }));
        },
        graphql: async () => {
          // 生涯マージ数は 1 件（初回提出者！）
          return { u_0: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 10,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        (m) => logs.push(m),
      );

      // 20日前の手直しありPR #801 が、初回コホートに正常に採用されていること！
      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      expect(snapshot?.FirstTimerMedianDays).toBe(15.0); // 通算 15日
      expect(snapshot?.FirstTimerTurnMedianDays).toBe(5.0); // Turn Latency 5日

      // キャッシュファイル内で IsFirstTimer: true かつ CommitCount: 3 で保存されていること
      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached801 = savedCache.find((e) => e.Number === 801);
      expect(cached801?.Type).toBe("sample");
      if (cached801?.Type === "sample") {
        expect(cached801.IsFirstTimer).toBe(true);
        expect(cached801.CommitCount).toBe(3);
      }

      // ログに通算と最終コミット後の両方が出力されていること
      const logText = logs.join("\n");
      expect(logText).toContain("通算所要日数   : 中央値: 15.0日");
      expect(logText).toContain("最終コミット後 : 中央値: 5.0日");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("旧版キャッシュの再評価: sample/IsFirstTimer:false（複数コミット・健康体・生涯マージ1件）が事前投入されている場合に再評価されてコホートに採用される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-legacy-sample-"));
    try {
      const cachePath = join(tmpDir, "merged-samples.jsonl");
      const dayMs = 24 * 60 * 60 * 1000;
      const now = new Date("2026-11-01T00:00:00Z");

      const labels = [
        { name: "New-Package" },
        { name: "Azure-Pipeline-Passed" },
        { name: "Validation-Completed" },
      ];

      // 旧版キャッシュ: 複数コミット（CommitCount: 3）のため IsFirstTimer: false として記録されていた
      const legacySample: CachedSampleEntry = {
        Type: "sample",
        Number: 801,
        Title: "PR 801",
        CreatedAt: new Date(now.getTime() - 35 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 25 * dayMs).toISOString(),
        CommitCount: 3,
        ReadyAt: new Date(now.getTime() - 34 * dayMs).toISOString(),
        MergedAt: new Date(now.getTime() - 20 * dayMs).toISOString(),
        TotalDays: 15.0,
        TurnDays: 5.0,
        ReadyDays: 14.0,
        Author: "newbie-dev",
        IsFirstTimer: false, // 旧版の判定（由来記録なし）
      };
      writeFileSync(cachePath, `${JSON.stringify(legacySample)}\n`, "utf-8");

      let timelineFetched = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 1,
              items: [
                {
                  number: 801,
                  title: "PR 801",
                  html_url: "https://github.com/test/repo/pull/801",
                  created_at: new Date(now.getTime() - 35 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 20 * dayMs).toISOString(),
                  author: "newbie-dev",
                  pull_request: {
                    merged_at: new Date(now.getTime() - 20 * dayMs).toISOString(),
                  },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: labels.map((l) => l.name),
              commitCount: 1,
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          throw new Error(`Unexpected PR #${num}`);
        },
        getPullRequestSampleData: async () => {
          timelineFetched = true;
          return {
            createdAt: new Date(now.getTime() - 35 * dayMs).toISOString(),
            commitCount: 3,
            latestCommittedDate: new Date(now.getTime() - 25 * dayMs).toISOString(),
            author: "newbie-dev",
            timeline: labels.map((l) => ({
              event: "labeled",
              created_at: new Date(now.getTime() - 34 * dayMs).toISOString(),
              label: { name: l.name },
            })),
          };
        },
        getIssueTimeline: async () => {
          timelineFetched = true;
          return labels.map((l) => ({
            event: "labeled",
            created_at: new Date(now.getTime() - 34 * dayMs).toISOString(),
            label: { name: l.name },
          }));
        },
        graphql: async () => {
          return { u_0: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 10,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        (m) => logs.push(m),
      );

      // 旧キャッシュの IsFirstTimer: false が再評価され、コホートに採用されたこと！
      expect(timelineFetched).toBe(true);
      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      expect(snapshot?.FirstTimerMedianDays).toBe(15.0);
      expect(snapshot?.FirstTimerTurnMedianDays).toBe(5.0);

      // キャッシュファイルが IsFirstTimer: true, FirstTimerVersion: 7 で更新されたこと
      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached801 = savedCache.find((e) => e.Number === 801);
      expect(cached801?.Type).toBe("sample");
      if (cached801?.Type === "sample") {
        expect(cached801.IsFirstTimer).toBe(true);
        expect(cached801.FirstTimerVersion).toBe(7);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("旧版キャッシュの再評価: sample/IsFirstTimer:false（阻害履歴あり・累計マージ1件）は再評価されて初回提出者に昇格する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-legacy-blocked-"));
    try {
      const cachePath = join(tmpDir, "merged-samples.jsonl");
      const dayMs = 24 * 60 * 60 * 1000;
      const now = new Date("2026-11-01T00:00:00Z");

      const labels = [
        { name: "New-Package" },
        { name: "Azure-Pipeline-Passed" },
        { name: "Validation-Completed" },
      ];

      // 旧版キャッシュ: IsFirstTimer: false
      const legacySample: CachedSampleEntry = {
        Type: "sample",
        Number: 802,
        Title: "PR 802",
        CreatedAt: new Date(now.getTime() - 35 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 25 * dayMs).toISOString(),
        CommitCount: 3,
        ReadyAt: new Date(now.getTime() - 34 * dayMs).toISOString(),
        MergedAt: new Date(now.getTime() - 20 * dayMs).toISOString(),
        TotalDays: 15.0,
        TurnDays: 5.0,
        ReadyDays: 14.0,
        Author: "blocked-dev",
        IsFirstTimer: false,
      };
      writeFileSync(cachePath, `${JSON.stringify(legacySample)}\n`, "utf-8");

      let graphqlCalled = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 1,
              items: [
                {
                  number: 802,
                  title: "PR 802",
                  html_url: "https://github.com/test/repo/pull/802",
                  created_at: new Date(now.getTime() - 35 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 20 * dayMs).toISOString(),
                  author: "blocked-dev",
                  pull_request: {
                    merged_at: new Date(now.getTime() - 20 * dayMs).toISOString(),
                  },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: labels.map((l) => l.name),
              commitCount: 1,
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          throw new Error(`Unexpected PR #${num}`);
        },
        getPullRequestSampleData: async () => ({
          createdAt: new Date(now.getTime() - 35 * dayMs).toISOString(),
          commitCount: 3,
          latestCommittedDate: new Date(now.getTime() - 25 * dayMs).toISOString(),
          author: "blocked-dev",
          timeline: [
            {
              event: "labeled",
              created_at: new Date(now.getTime() - 34 * dayMs).toISOString(),
              label: { name: "Needs-Author-Feedback" }, // 阻害ラベル
            },
            {
              event: "unlabeled",
              created_at: new Date(now.getTime() - 33 * dayMs).toISOString(),
              label: { name: "Needs-Author-Feedback" }, // 解除
            },
            ...labels.map((l) => ({
              event: "labeled",
              created_at: new Date(now.getTime() - 32 * dayMs).toISOString(),
              label: { name: l.name },
            })),
          ],
        }),
        getIssueTimeline: async (_repo: string, num: number) => {
          if (num === 500) {
            return labels.map((l) => ({
              event: "labeled",
              created_at: new Date(now.getTime() - 34 * dayMs).toISOString(),
              label: { name: l.name },
            }));
          }
          return [
            {
              event: "labeled",
              created_at: new Date(now.getTime() - 34 * dayMs).toISOString(),
              label: { name: "Needs-Author-Feedback" },
            },
            {
              event: "unlabeled",
              created_at: new Date(now.getTime() - 33 * dayMs).toISOString(),
              label: { name: "Needs-Author-Feedback" },
            },
            ...labels.map((l) => ({
              event: "labeled",
              created_at: new Date(now.getTime() - 32 * dayMs).toISOString(),
              label: { name: l.name },
            })),
          ];
        },
        graphql: async () => {
          graphqlCalled = true;
          return { u_0: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 10,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        (m) => logs.push(m),
      );

      // 阻害履歴があっても累計マージ 1 件であれば初回提出者として採用される
      expect(graphqlCalled).toBe(true);
      expect(snapshot?.FirstTimerSampleCount).toBe(1);

      // キャッシュファイルで IsFirstTimer: true, FirstTimerVersion: 7 に更新されたこと
      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached802 = savedCache.find((e) => e.Number === 802);
      expect(cached802?.Type).toBe("sample");
      if (cached802?.Type === "sample") {
        expect(cached802.IsFirstTimer).toBe(true);
        expect(cached802.FirstTimerReason).toBeUndefined();
        expect(cached802.FirstTimerVersion).toBe(7);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("旧版キャッシュの再評価: skipped/Reason:not-first-timer-candidate（31〜90日前・複数コミット・健康体・生涯マージ1件）が事前投入されている場合に再評価されてコホートに採用される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-legacy-skipped-"));
    try {
      const cachePath = join(tmpDir, "merged-samples.jsonl");
      const dayMs = 24 * 60 * 60 * 1000;
      const now = new Date("2026-11-01T00:00:00Z");

      const labels = [
        { name: "New-Package" },
        { name: "Azure-Pipeline-Passed" },
        { name: "Validation-Completed" },
      ];

      // 45日前（全体集計窓30日外、90日初回窓内）の PR が旧版で not-first-timer-candidate として除外されていた
      const legacySkipped: SampleCacheEntry = {
        Type: "skipped",
        Number: 803,
        MergedAt: new Date(now.getTime() - 45 * dayMs).toISOString(),
        Reason: "not-first-timer-candidate",
      };
      writeFileSync(cachePath, `${JSON.stringify(legacySkipped)}\n`, "utf-8");

      let detailsFetched = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 1,
              items: [
                {
                  number: 803,
                  title: "PR 803",
                  html_url: "https://github.com/test/repo/pull/803",
                  created_at: new Date(now.getTime() - 55 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 45 * dayMs).toISOString(),
                  author: "older-first-timer",
                  pull_request: {
                    merged_at: new Date(now.getTime() - 45 * dayMs).toISOString(),
                  },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: labels.map((l) => l.name),
              commitCount: 1,
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          throw new Error(`Unexpected PR #${num}`);
        },
        getPullRequestSampleData: async () => {
          detailsFetched = true;
          return {
            createdAt: new Date(now.getTime() - 55 * dayMs).toISOString(),
            commitCount: 3,
            latestCommittedDate: new Date(now.getTime() - 48 * dayMs).toISOString(),
            author: "older-first-timer",
            timeline: labels.map((l) => ({
              event: "labeled",
              created_at: new Date(now.getTime() - 54 * dayMs).toISOString(),
              label: { name: l.name },
            })),
          };
        },
        getIssueTimeline: async () => {
          return labels.map((l) => ({
            event: "labeled",
            created_at: new Date(now.getTime() - 54 * dayMs).toISOString(),
            label: { name: l.name },
          }));
        },
        graphql: async () => {
          return { u_0: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 10,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        (m) => logs.push(m),
      );

      // 全体窓外（45日前）であってもスキップが解除されて詳細取得が実行され、コホートに採用されたこと！
      expect(detailsFetched).toBe(true);
      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      expect(snapshot?.FirstTimerMedianDays).toBe(10.0); // 通算 10日
      expect(snapshot?.FirstTimerTurnMedianDays).toBe(3.0); // Turn Latency 3日

      // キャッシュファイルが sample に置き換わり、IsFirstTimer: true, FirstTimerVersion: 7 で記録されたこと
      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached803 = savedCache.find((e) => e.Number === 803);
      expect(cached803?.Type).toBe("sample");
      if (cached803?.Type === "sample") {
        expect(cached803.IsFirstTimer).toBe(true);
        expect(cached803.FirstTimerVersion).toBe(7);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("旧版キャッシュの再評価: skipped/Reason:not-first-timer-candidate（31〜90日前・常連author）は依然として不適格のため再取得されずスキップが維持される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-legacy-repeat-skipped-"));
    try {
      const cachePath = join(tmpDir, "merged-samples.jsonl");
      const dayMs = 24 * 60 * 60 * 1000;
      const now = new Date("2026-11-01T00:00:00Z");

      const labels = [
        { name: "New-Package" },
        { name: "Azure-Pipeline-Passed" },
        { name: "Validation-Completed" },
      ];

      // 45日前（全体窓外、90日初回窓内）の PR が not-first-timer-candidate として除外されていた
      const legacySkipped804: SampleCacheEntry = {
        Type: "skipped",
        Number: 804,
        MergedAt: new Date(now.getTime() - 45 * dayMs).toISOString(),
        Reason: "not-first-timer-candidate",
      };
      const legacySkipped805: SampleCacheEntry = {
        Type: "skipped",
        Number: 805,
        MergedAt: new Date(now.getTime() - 44 * dayMs).toISOString(),
        Reason: "not-first-timer-candidate",
      };
      writeFileSync(
        cachePath,
        `${JSON.stringify(legacySkipped804)}\n${JSON.stringify(legacySkipped805)}\n`,
        "utf-8",
      );

      let detailsFetched = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 2,
              items: [
                {
                  number: 804,
                  title: "PR 804",
                  html_url: "https://github.com/test/repo/pull/804",
                  created_at: new Date(now.getTime() - 55 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 45 * dayMs).toISOString(),
                  author: "frequent-dev", // 複数件提出の常連のため依然として不適格
                  pull_request: {
                    merged_at: new Date(now.getTime() - 45 * dayMs).toISOString(),
                  },
                },
                {
                  number: 805,
                  title: "PR 805",
                  html_url: "https://github.com/test/repo/pull/805",
                  created_at: new Date(now.getTime() - 54 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 44 * dayMs).toISOString(),
                  author: "frequent-dev",
                  pull_request: {
                    merged_at: new Date(now.getTime() - 44 * dayMs).toISOString(),
                  },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: labels.map((l) => l.name),
              commitCount: 1,
              commits: [
                {
                  oid: "oid500",
                  messageHeadline: "initial",
                  committedDate: "2026-11-01T00:00:00Z",
                },
              ],
            };
          }
          detailsFetched = true;
          throw new Error("不適格なため詳細フェッチは呼ばれないはず");
        },
        getPullRequestSampleData: async () => {
          detailsFetched = true;
          throw new Error("不適格なためサンプルフェッチは呼ばれないはず");
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 10,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        (m) => logs.push(m),
      );

      // 常連 author のため再取得されず、スキップが維持されること
      expect(detailsFetched).toBe(false);
      expect(snapshot?.FirstTimerSampleCount).toBe(0);

      // キャッシュファイルで skipped のまま維持されていること
      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached804 = savedCache.find((e) => e.Number === 804);
      expect(cached804?.Type).toBe("skipped");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("自己修復パイプライン: TTL超過・検索外v6旧版（高速枠等）のローカル削除と、候補内v6のタイムライン再計測・特権ロール降格および世代ログ出力を行う", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-self-heal-"));
    try {
      const cachePath = join(tmpDir, "merged-samples.jsonl");
      const dayMs = 24 * 60 * 60 * 1000;
      const now = new Date("2026-11-19T00:00:00Z");

      const labels = [
        { name: "New-Package" },
        { name: "Azure-Pipeline-Passed" },
        { name: "Validation-Completed" },
      ];

      const initialEntries: SampleCacheEntry[] = [
        // #850: 130日前 -> TTL (120日) 超過で削除
        {
          Type: "sample",
          Number: 850,
          Title: "PR 850 (Expired TTL)",
          CreatedAt: new Date(now.getTime() - 140 * dayMs).toISOString(),
          LatestCommittedDate: new Date(now.getTime() - 135 * dayMs).toISOString(),
          CommitCount: 1,
          ReadyAt: new Date(now.getTime() - 134 * dayMs).toISOString(),
          MergedAt: new Date(now.getTime() - 130 * dayMs).toISOString(),
          TotalDays: 10,
          TurnDays: 5,
          ReadyDays: 4,
          Author: "old-ttl-user",
          IsFirstTimer: true,
          FirstTimerVersion: 7,
        },
        // #851: 10日前・検索候補外（Publisher-Verified 等で新検索除外）・v6 -> 検索外旧版として削除
        {
          Type: "sample",
          Number: 851,
          Title: "PR 851 (v6 publisher-verified outside search)",
          CreatedAt: new Date(now.getTime() - 15 * dayMs).toISOString(),
          LatestCommittedDate: new Date(now.getTime() - 15 * dayMs).toISOString(),
          CommitCount: 1,
          ReadyAt: new Date(now.getTime() - 15 * dayMs).toISOString(),
          MergedAt: new Date(now.getTime() - 10 * dayMs).toISOString(),
          TotalDays: 5,
          TurnDays: 5,
          ReadyDays: 5,
          Author: "publisher-verified-user",
          IsFirstTimer: true,
          FirstTimerVersion: 6,
        },
        // #852: 5日前・検索候補内・v6 (MEMBER) -> タイムライン再評価で privileged-or-bot へ降格＆v7昇格
        {
          Type: "sample",
          Number: 852,
          Title: "PR 852 (v6 MEMBER)",
          CreatedAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
          LatestCommittedDate: new Date(now.getTime() - 6 * dayMs).toISOString(),
          CommitCount: 1,
          ReadyAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
          MergedAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
          TotalDays: 1,
          TurnDays: 1,
          ReadyDays: 1,
          Author: "asklar",
          IsFirstTimer: true,
          FirstTimerVersion: 6,
        },
        // #853: 4日前・検索候補内・v6 (Needs-Attention 一時付与の見落とし旧版) -> 解除日時で ReadyAt 再計測 & v7 昇格
        {
          Type: "sample",
          Number: 853,
          Title: "PR 853 (v6 Needs-Attention missed)",
          CreatedAt: new Date(now.getTime() - 20 * dayMs).toISOString(),
          LatestCommittedDate: new Date(now.getTime() - 20 * dayMs).toISOString(),
          CommitCount: 1,
          ReadyAt: new Date(now.getTime() - 20 * dayMs).toISOString(),
          MergedAt: new Date(now.getTime() - 4 * dayMs).toISOString(),
          TotalDays: 16,
          TurnDays: 16,
          ReadyDays: 16,
          Author: "normal-ft",
          IsFirstTimer: true,
          FirstTimerVersion: 6,
        },
      ];
      writeFileSync(cachePath, serializeSampleCacheEntries(initialEntries), "utf-8");

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            return {
              totalCount: 2,
              items: [
                {
                  number: 852,
                  title: "PR 852",
                  html_url: "https://github.com/test/repo/pull/852",
                  created_at: new Date(now.getTime() - 6 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 5 * dayMs).toISOString(),
                  author: "asklar",
                  pull_request: { merged_at: new Date(now.getTime() - 5 * dayMs).toISOString() },
                },
                {
                  number: 853,
                  title: "PR 853",
                  html_url: "https://github.com/test/repo/pull/853",
                  created_at: new Date(now.getTime() - 20 * dayMs).toISOString(),
                  updated_at: new Date(now.getTime() - 4 * dayMs).toISOString(),
                  author: "normal-ft",
                  pull_request: { merged_at: new Date(now.getTime() - 4 * dayMs).toISOString() },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: labels.map((l) => l.name),
              commitCount: 1,
              commits: [
                { oid: "o1", messageHeadline: "init", committedDate: "2026-11-01T00:00:00Z" },
              ],
            };
          }
          throw new Error(`Unexpected PR #${num}`);
        },
        getIssueTimeline: async () =>
          labels.map((l) => ({
            event: "labeled",
            created_at: "2026-11-01T00:00:00Z",
            label: { name: l.name },
          })),
        getPullRequestSampleData: async (_repo: string, num: number) => {
          if (num === 852) {
            return {
              createdAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
              latestCommittedDate: new Date(now.getTime() - 6 * dayMs).toISOString(),
              commitCount: 1,
              author: "asklar",
              authorType: "User",
              authorAssociation: "MEMBER",
              timeline: labels.map((l) => ({
                event: "labeled" as const,
                created_at: new Date(now.getTime() - 6 * dayMs).toISOString(),
                label: { name: l.name },
              })),
            };
          }
          return {
            createdAt: new Date(now.getTime() - 20 * dayMs).toISOString(),
            latestCommittedDate: new Date(now.getTime() - 20 * dayMs).toISOString(),
            commitCount: 1,
            author: "normal-ft",
            authorType: "User",
            authorAssociation: "CONTRIBUTOR",
            timeline: [
              ...labels.map((l) => ({
                event: "labeled" as const,
                created_at: new Date(now.getTime() - 20 * dayMs).toISOString(),
                label: { name: l.name },
              })),
              {
                event: "labeled" as const,
                created_at: new Date(now.getTime() - 19 * dayMs).toISOString(),
                label: { name: "Needs-Attention" },
              },
              {
                event: "unlabeled" as const,
                created_at: new Date(now.getTime() - 8 * dayMs).toISOString(),
                label: { name: "Needs-Attention" },
              },
            ],
          };
        },
        graphql: async (query: string) => {
          if (query.includes("u_0")) {
            return { u_0: { issueCount: 1 } };
          }
          return { repository: {} };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          now,
          cachePath,
          fetchBudget: 10,
          fetchLimit: 100,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
          metadataRefreshBudget: 10,
          cacheRetentionDays: 120,
        },
        client,
        (m) => logs.push(m),
      );

      // 特権ロール #852 は除外、#853 は Needs-Attention 解除（8日前）〜 マージ（4日前）の ReadyDays=4・TotalDays=16 になる
      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      expect(snapshot?.FirstTimerMedianDays).toBe(16.0);

      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      expect(savedCache.find((e) => e.Number === 850)).toBeUndefined();
      expect(savedCache.find((e) => e.Number === 851)).toBeUndefined();

      const c852 = savedCache.find((e) => e.Number === 852);
      expect(c852?.Type === "sample" && c852.IsFirstTimer).toBeFalse();
      expect(c852?.Type === "sample" && c852.FirstTimerReason).toBe("privileged-or-bot");
      expect(c852?.Type === "sample" && c852.FirstTimerVersion).toBe(7);

      const c853 = savedCache.find((e) => e.Number === 853);
      expect(c853?.Type === "sample" && c853.IsFirstTimer).toBeTrue();
      expect(c853?.Type === "sample" && c853.AuthorAssociation).toBe("CONTRIBUTOR");
      expect(c853?.Type === "sample" && c853.ReadyDays).toBe(4);
      expect(c853?.Type === "sample" && c853.FirstTimerVersion).toBe(7);

      const logText = logs.join("\n");
      expect(logText).toContain("キャッシュ自己修復 : TTL削除 1 件・検索外旧版削除 1 件");
      expect(logText).toContain(
        "キャッシュ世代     : 全 2 件（最新: 2 / 中間版: 0 / 要再計測旧版: 0 / skipped: 0 / 直近90日 補完待ち: 0 件）",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("不完全なページング応答（2ページ目が空）時は候補数が fetchLimit 未満でも検索対象外パージを実行しない（レビュー指摘回帰テスト）", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "progress-incomplete-scan-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");
    const dayMs = 24 * 60 * 60 * 1000;
    const now = new Date("2026-11-20T00:00:00Z");

    try {
      const initialEntries: SampleCacheEntry[] = [
        // 1ページ目から取得される新しめの v6 サンプル
        {
          Type: "sample",
          Number: 860,
          Title: "PR 860",
          CreatedAt: new Date(now.getTime() - 10 * dayMs).toISOString(),
          LatestCommittedDate: new Date(now.getTime() - 9 * dayMs).toISOString(),
          CommitCount: 1,
          ReadyAt: new Date(now.getTime() - 9 * dayMs).toISOString(),
          MergedAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
          TotalDays: 5,
          TurnDays: 4,
          ReadyDays: 4,
          Author: "user-860",
          IsFirstTimer: false,
          FirstTimerReason: "lifetime-merged",
          FirstTimerVersion: 6,
        },
        // 2ページ目にあるはずの TTL 内正常 v4 キャッシュ（2ページ目が空応答でも誤削除されてはならない）
        {
          Type: "sample",
          Number: 861,
          Title: "PR 861",
          CreatedAt: new Date(now.getTime() - 12 * dayMs).toISOString(),
          LatestCommittedDate: new Date(now.getTime() - 11 * dayMs).toISOString(),
          CommitCount: 1,
          ReadyAt: new Date(now.getTime() - 11 * dayMs).toISOString(),
          MergedAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
          TotalDays: 6,
          TurnDays: 5,
          ReadyDays: 5,
          Author: "user-861",
          IsFirstTimer: false,
          FirstTimerVersion: 4,
        },
      ];
      writeFileSync(cachePath, serializeSampleCacheEntries(initialEntries), "utf-8");

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (
          query: string,
          _sort?: string,
          _order?: string,
          _perPage?: number,
          page = 1,
        ): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            if (page === 1) {
              return {
                totalCount: 2,
                pageInfo: { hasNextPage: true, endCursor: "c1" },
                items: [
                  {
                    number: 860,
                    title: "PR 860",
                    html_url: "https://github.com/test/repo/pull/860",
                    created_at: new Date(now.getTime() - 10 * dayMs).toISOString(),
                    updated_at: new Date(now.getTime() - 5 * dayMs).toISOString(),
                    author: "user-860",
                    pull_request: { merged_at: new Date(now.getTime() - 5 * dayMs).toISOString() },
                  },
                ],
              };
            }
            // 2ページ目が空配列（途中終了）
            return {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              items: [],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getPullRequestDetails: async (_repo: string, num: number) => {
          if (num === 500) {
            return {
              number: 500,
              title: "Target PR",
              url: "https://github.com/test/repo/pull/500",
              state: "OPEN" as const,
              isDraft: false,
              createdAt: "2026-11-01T00:00:00Z",
              updatedAt: "2026-11-01T00:00:00Z",
              mergedAt: null,
              closedAt: null,
              labels: labels.map((l) => l.name),
              commitCount: 1,
              commits: [
                { oid: "o1", messageHeadline: "init", committedDate: "2026-11-01T00:00:00Z" },
              ],
            };
          }
          throw new Error(`unexpected getPullRequestDetails(${num})`);
        },
        getIssueTimeline: async () =>
          labels.map((l) => ({
            event: "labeled",
            created_at: "2026-11-01T00:00:00Z",
            label: { name: l.name },
          })),
      } as unknown as GitHubApiClient;

      await runProgressCli(
        {
          ...options,
          now,
          cachePath,
          fetchBudget: 0,
          fetchLimit: 100,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
          metadataRefreshBudget: 0,
          cacheRetentionDays: 120,
        },
        client,
        () => {},
      );

      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      expect(savedCache.find((e) => e.Number === 860)).toBeDefined();
      expect(savedCache.find((e) => e.Number === 861)).toBeDefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
