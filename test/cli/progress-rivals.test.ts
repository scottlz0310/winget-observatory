import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubApiClient, GitHubDetailedSearchResult } from "../../src/api/github";
import { runProgressCli } from "../../src/cli/progress";
import { REQUIRED_LABELS } from "../../src/domain/progress";
import { parseSampleCache, serializeSampleCacheEntries } from "../../src/domain/sample-cache";
import type { SampleCacheEntry } from "../../src/models/sample-cache";

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

  test("ライバル PR・統計・追い越し・サンプル一覧をスナップショットとログに出す", async () => {
    const logs: string[] = [];
    const { snapshot } = await runProgressCli(options, buildClient(), (m) => logs.push(m));
    const text = logs.join("\n");

    expect(snapshot?.Rivals.map((r) => r.Number)).toEqual([470]);
    expect(snapshot?.Rivals[0].UpdatedAt).toBe("2026-10-29T00:00:00Z");
    expect(snapshot?.SampleCount).toBe(3);
    expect(snapshot?.SkippedCount).toBe(0);
    expect(snapshot?.LookbackDays).toBe(30);
    expect(snapshot?.Samples.map((s) => `${s.Number}:${s.Relation}`)).toEqual([
      "400:older",
      "450:older",
      "600:newer",
    ]);
    expect(snapshot?.Comparison).toMatchObject({ LaterCreated: 1, NewerNumber: 1 });
    expect(snapshot?.Comparison?.Verdict).toBe("mostly-older");
    expect(snapshot?.TotalMaxDays).not.toBeNull();
    expect(snapshot?.Guidance?.Ready.ShorterSharePct).toBeGreaterThanOrEqual(0);

    expect(text).toContain("直前のライバルPR");
    expect(text).toContain("#470");
    expect(text).not.toContain("Blocked rival");
    expect(text).toContain("3. （参考）条件成立後");
    expect(text).toContain("参考目安:");
    expect(text).toContain("【条件成立日時の比較（ReadyAt）】");
    expect(text).toContain("自分より後に作成されマージ済み   : 1 件");
    expect(text).toContain("参考サンプル（マージ日時順）:");
    expect(text).toContain("採用サンプル     : 3 件");
    expect(text).toContain("サンプルが少ないため");
  });

  test("マージ済みサンプルの初回提出者を常連から分離し、GraphQL で累計マージ数を照会してキャッシュ・スナップショットに記録する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-first-timer-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");
    const snapshotPath = join(tmpDir, "latest-progress.json");

    try {
      let graphqlCalled = false;
      let graphqlQuery = "";

      const client = {
        ...buildClient(),
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
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
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
        getPullRequestSampleData: async (_repo: string, num: number) => {
          const baseTimeline = [
            {
              event: "labeled",
              created_at:
                num === 400
                  ? "2026-10-21T00:00:00Z"
                  : num === 450
                    ? "2026-10-25T12:00:00Z"
                    : "2026-11-02T12:00:00Z",
              label: { name: "New-Package" },
            },
            {
              event: "labeled",
              created_at:
                num === 400
                  ? "2026-10-21T00:00:00Z"
                  : num === 450
                    ? "2026-10-25T12:00:00Z"
                    : "2026-11-02T12:00:00Z",
              label: { name: "Azure-Pipeline-Passed" },
            },
            {
              event: "labeled",
              created_at:
                num === 400
                  ? "2026-10-21T00:00:00Z"
                  : num === 450
                    ? "2026-10-25T12:00:00Z"
                    : "2026-11-02T12:00:00Z",
              label: { name: "Validation-Completed" },
            },
          ];
          if (num === 400) {
            return {
              createdAt: "2026-10-20T00:00:00Z",
              commitCount: 1,
              latestCommittedDate: "2026-10-20T00:00:00Z",
              author: "repeatUser",
              timeline: baseTimeline,
            };
          }
          if (num === 450) {
            return {
              createdAt: "2026-10-25T00:00:00Z",
              commitCount: 1,
              latestCommittedDate: "2026-10-25T00:00:00Z",
              author: "repeatUser", // 同一バッチ内で2回登場
              timeline: baseTimeline,
            };
          }
          if (num === 600) {
            return {
              createdAt: "2026-11-02T00:00:00Z",
              commitCount: 1,
              latestCommittedDate: "2026-11-02T00:00:00Z",
              author: "firstTimerUser", // 単発
              timeline: baseTimeline,
            };
          }
          throw new Error(`Unexpected sample PR #${num}`);
        },
        graphql: async (query: string) => {
          graphqlCalled = true;
          graphqlQuery = query;
          return {
            u_0: { issueCount: 1 },
          };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          snapshotPath,
        },
        client,
        (m) => logs.push(m),
      );

      expect(graphqlCalled).toBeTrue();
      expect(graphqlQuery).toContain("firstTimerUser");
      expect(graphqlQuery).not.toContain("repeatUser");

      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      expect(snapshot?.FirstTimerMedianDays).not.toBeNull();

      const samples = snapshot?.Samples ?? [];
      const ftSample = samples.find((s) => s.Number === 600);
      const repeatSample = samples.find((s) => s.Number === 400);

      expect(ftSample?.IsFirstTimer).toBeTrue();
      expect(repeatSample?.IsFirstTimer).toBeFalse();

      // キャッシュファイルへの保存検証
      expect(existsSync(cachePath)).toBeTrue();
      const cacheEntries = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const cached600 = cacheEntries.find((e) => e.Number === 600);
      expect(cached600?.Type).toBe("sample");
      if (cached600?.Type === "sample") {
        expect(cached600.Author).toBe("firstTimerUser");
        expect(cached600.IsFirstTimer).toBeTrue();
      }

      const text = logs.join("\n");
      expect(text).toContain("初回提出者コホート実績");
      expect(text).toContain("うち初回提出者による追い越し   : 1 件");
      expect(text).toContain("うち常連・特急レーンによる追い越し: 0 件");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("1コミット・累計マージ1件であれば途中で阻害ラベル履歴があるPRも初回提出者として採用され isFirstTimer: true となる", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-blocked-history-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      let graphqlCalled = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 1,
              items: [
                {
                  number: 600,
                  title: "Merged 600",
                  html_url: "https://github.com/test/repo/pull/600",
                  created_at: "2026-10-01T00:00:00Z",
                  updated_at: "2026-11-01T00:00:00Z",
                  pull_request: { merged_at: "2026-11-01T00:00:00Z" },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getIssueTimeline: async (_repo: string, num: number) => {
          if (num === 500) {
            return [
              {
                event: "labeled",
                created_at: "2026-11-01T01:00:00Z",
                label: { name: "New-Package" },
              },
              {
                event: "labeled",
                created_at: "2026-11-01T01:00:00Z",
                label: { name: "Azure-Pipeline-Passed" },
              },
              {
                event: "labeled",
                created_at: "2026-11-01T01:00:00Z",
                label: { name: "Validation-Completed" },
              },
            ];
          }
          return [];
        },
        getPullRequestSampleData: async (_repo: string, _num: number) => {
          // PR 600: 途中で Error-TestFailure が付与され、その後解除された
          return {
            createdAt: "2026-10-01T00:00:00Z",
            commitCount: 1,
            latestCommittedDate: "2026-10-01T00:00:00Z",
            author: "userWithBlockedHistory",
            timeline: [
              {
                event: "labeled",
                created_at: "2026-10-01T01:00:00Z",
                label: { name: "New-Package" },
              },
              {
                event: "labeled",
                created_at: "2026-10-01T01:00:00Z",
                label: { name: "Azure-Pipeline-Passed" },
              },
              {
                event: "labeled",
                created_at: "2026-10-01T01:00:00Z",
                label: { name: "Validation-Completed" },
              },
              {
                event: "labeled",
                created_at: "2026-10-02T01:00:00Z",
                label: { name: "Error-TestFailure" },
              },
              {
                event: "unlabeled",
                created_at: "2026-10-30T01:00:00Z",
                label: { name: "Error-TestFailure" },
              },
            ],
          };
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
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
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
        graphql: async () => {
          graphqlCalled = true;
          return { u_0: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli({ ...options, cachePath }, client, (m) =>
        logs.push(m),
      );

      // 阻害履歴があっても作者累計マージ判定に進み、累計マージ 1 件なら初回として採用される
      expect(graphqlCalled).toBeTrue();
      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      const s600 = snapshot?.Samples.find((s) => s.Number === 600);
      expect(s600?.IsFirstTimer).toBeTrue();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("1コミット・累計マージ1件であればDraft履歴（converted_to_draft や ready_for_review）があるPRも初回提出者として採用される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-draft-history-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      let graphqlCalled = false;
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 2,
              items: [600, 601].map((n) => ({
                number: n,
                title: `Merged ${n}`,
                html_url: `https://github.com/test/repo/pull/${n}`,
                created_at: "2026-10-01T00:00:00Z",
                updated_at: "2026-11-01T00:00:00Z",
                pull_request: { merged_at: "2026-11-01T00:00:00Z" },
              })),
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
        getIssueTimeline: async (_repo: string, num: number) => {
          if (num === 500) {
            return [
              {
                event: "labeled",
                created_at: "2026-11-01T01:00:00Z",
                label: { name: "New-Package" },
              },
              {
                event: "labeled",
                created_at: "2026-11-01T01:00:00Z",
                label: { name: "Azure-Pipeline-Passed" },
              },
              {
                event: "labeled",
                created_at: "2026-11-01T01:00:00Z",
                label: { name: "Validation-Completed" },
              },
            ];
          }
          return [];
        },
        getPullRequestSampleData: async (_repo: string, num: number) => {
          const timeline =
            num === 600
              ? [
                  {
                    event: "labeled",
                    created_at: "2026-10-01T01:00:00Z",
                    label: { name: "New-Package" },
                  },
                  {
                    event: "labeled",
                    created_at: "2026-10-01T01:00:00Z",
                    label: { name: "Azure-Pipeline-Passed" },
                  },
                  {
                    event: "labeled",
                    created_at: "2026-10-01T01:00:00Z",
                    label: { name: "Validation-Completed" },
                  },
                  {
                    event: "converted_to_draft",
                    created_at: "2026-10-02T01:00:00Z",
                  },
                  {
                    event: "ready_for_review",
                    created_at: "2026-10-15T01:00:00Z",
                  },
                ]
              : [
                  {
                    event: "labeled",
                    created_at: "2026-10-01T01:00:00Z",
                    label: { name: "New-Package" },
                  },
                  {
                    event: "labeled",
                    created_at: "2026-10-01T01:00:00Z",
                    label: { name: "Azure-Pipeline-Passed" },
                  },
                  {
                    event: "labeled",
                    created_at: "2026-10-01T01:00:00Z",
                    label: { name: "Validation-Completed" },
                  },
                  {
                    event: "ready_for_review",
                    created_at: "2026-10-10T01:00:00Z",
                  },
                ];
          return {
            createdAt: "2026-10-01T00:00:00Z",
            commitCount: 1,
            latestCommittedDate: "2026-10-01T00:00:00Z",
            author: `draftUser${num}`,
            timeline,
          };
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
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
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
        graphql: async () => {
          graphqlCalled = true;
          return { u_0: { issueCount: 1 }, u_1: { issueCount: 1 } };
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli({ ...options, cachePath }, client, (m) =>
        logs.push(m),
      );

      // Draft 履歴があっても累計マージ 1 件なら初回提出者として採用される
      expect(graphqlCalled).toBeTrue();
      expect(snapshot?.FirstTimerSampleCount).toBe(2);
      const s600 = snapshot?.Samples.find((s) => s.Number === 600);
      expect(s600?.IsFirstTimer).toBeTrue();
      const s601 = snapshot?.Samples.find((s) => s.Number === 601);
      expect(s601?.IsFirstTimer).toBeTrue();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("旧形式キャッシュ（Author/IsFirstTimer欠落）が存在する場合に未判定として正しく分離され常連に誤合算されない", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-progress-legacy-cache-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const legacyEntry1 = {
        Type: "sample",
        Number: 600,
        Title: "Legacy PR 600",
        CreatedAt: "2026-11-02T00:00:00.000Z",
        LatestCommittedDate: "2026-11-02T00:00:00.000Z",
        CommitCount: 1,
        ReadyAt: "2026-11-02T01:00:00.000Z",
        MergedAt: "2026-11-03T00:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      const legacyEntry2 = {
        Type: "sample",
        Number: 601,
        Title: "Legacy PR 601",
        CreatedAt: "2026-11-02T00:00:00.000Z",
        LatestCommittedDate: "2026-11-02T00:00:00.000Z",
        CommitCount: 1,
        ReadyAt: "2026-11-02T01:00:00.000Z",
        MergedAt: "2026-11-03T01:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      const legacyEntry3 = {
        Type: "sample",
        Number: 602,
        Title: "Legacy PR 602",
        CreatedAt: "2026-11-02T00:00:00.000Z",
        LatestCommittedDate: "2026-11-02T00:00:00.000Z",
        CommitCount: 1,
        ReadyAt: "2026-11-02T01:00:00.000Z",
        MergedAt: "2026-11-03T02:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      const legacyMultiCommit = {
        Type: "sample",
        Number: 450,
        Title: "Legacy PR 450",
        CreatedAt: "2026-10-25T00:00:00.000Z",
        LatestCommittedDate: "2026-10-25T00:00:00.000Z",
        CommitCount: 2,
        ReadyAt: "2026-10-25T01:00:00.000Z",
        MergedAt: "2026-10-26T00:00:00.000Z",
        TotalDays: 1,
        TurnDays: 1,
        ReadyDays: 0.96,
      };
      writeFileSync(
        cachePath,
        `${JSON.stringify(legacyEntry1)}\n${JSON.stringify(legacyEntry2)}\n${JSON.stringify(legacyEntry3)}\n${JSON.stringify(legacyMultiCommit)}\n`,
        "utf-8",
      );

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 4,
              items: [450, 600, 601, 602].map((n) => ({
                number: n,
                title: `Merged ${n}`,
                html_url: `https://github.com/test/repo/pull/${n}`,
                created_at: n === 450 ? "2026-10-25T00:00:00Z" : "2026-11-02T00:00:00Z",
                updated_at: "2026-11-03T00:00:00Z",
                pull_request: { merged_at: "2026-11-03T00:00:00Z" },
              })),
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
              labels: ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
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
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        { ...options, cachePath, fetchBudget: 0 },
        client,
        (m) => logs.push(m),
      );

      // PR 600, 601, 602 は自分より後に作成された未判定サンプル
      expect(snapshot?.Comparison?.LaterCreated).toBe(3);
      expect(snapshot?.Comparison?.FirstTimerLaterCreated).toBe(0);
      expect(snapshot?.Comparison?.RepeatOrExpressLaterCreated).toBe(0); // 常連に誤合算されない！
      expect(snapshot?.Comparison?.UnknownLaterCreated).toBe(3); // 未判定に計上される！

      // 旧形式キャッシュで Author が欠落している PR は、自動的に常連と決めつけず未判定（undefined）として保持される
      const s450 = snapshot?.Samples.find((s) => s.Number === 450);
      expect(s450?.IsFirstTimer).toBeUndefined();

      const text = logs.join("\n");
      expect(text).toContain("うち未判定による追い越し       : 3 件");
      expect(text).not.toContain("すべて常連・特急レーンによるもので"); // 誤って常連のみと断定しない！
      expect(text).toContain("確定した初回提出者による追い越しはありません）。");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("サンプルが 1 件もないときは比較不能と明示し、比較系は空にする", async () => {
    const client = buildClient();
    const original = client.searchIssuesDetailed.bind(client);
    client.searchIssuesDetailed = (async (query: string, ...rest: unknown[]) => {
      if (query.includes("is:merged")) return { totalCount: 0, items: [] };
      return (original as (q: string, ...r: unknown[]) => Promise<GitHubDetailedSearchResult>)(
        query,
        ...rest,
      );
    }) as typeof client.searchIssuesDetailed;

    const logs: string[] = [];
    const { snapshot } = await runProgressCli(options, client, (m) => logs.push(m));

    expect(logs.join("\n")).toContain("比較可能なサンプルがありませんでした。");
    expect(snapshot?.SampleCount).toBe(0);
    expect(snapshot?.Samples).toEqual([]);
    expect(snapshot?.Comparison).toBeNull();
    expect(snapshot?.Guidance).toBeNull();
  });

  test("全体実績（30日窓）と初回提出者コホート（90日窓）がハイブリッド集計される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-obs-hybrid-lookback-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    // 15日前（30日窓内、初回）
    const merged15d = new Date(now.getTime() - 15 * dayMs).toISOString();
    // 50日前（30日窓外・90日窓内、初回）
    const merged50d = new Date(now.getTime() - 50 * dayMs).toISOString();
    // 5日前（30日窓内、常連）
    const merged5d = new Date(now.getTime() - 5 * dayMs).toISOString();

    const cacheEntries: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 101,
        MergedAt: merged15d,
        CreatedAt: new Date(now.getTime() - 17 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 17 * dayMs).toISOString(),
        CommitCount: 1,
        ReadyAt: new Date(now.getTime() - 16 * dayMs).toISOString(),
        TotalDays: 2.0,
        TurnDays: 2.0,
        ReadyDays: 1.0,
        Title: "Sample 101 (FirstTimer 15d)",
        Author: "author-first1",
        IsFirstTimer: true,
      },
      {
        Type: "sample",
        Number: 102,
        MergedAt: merged50d,
        CreatedAt: new Date(now.getTime() - 55 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 55 * dayMs).toISOString(),
        CommitCount: 1,
        ReadyAt: new Date(now.getTime() - 52 * dayMs).toISOString(),
        TotalDays: 5.0,
        TurnDays: 5.0,
        ReadyDays: 2.0,
        Title: "Sample 102 (FirstTimer 50d)",
        Author: "author-first2",
        IsFirstTimer: true,
      },
      {
        Type: "sample",
        Number: 103,
        MergedAt: merged5d,
        CreatedAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 6 * dayMs).toISOString(),
        CommitCount: 2,
        ReadyAt: new Date(now.getTime() - 6 * dayMs).toISOString(),
        TotalDays: 1.0,
        TurnDays: 1.0,
        ReadyDays: 1.0,
        Title: "Sample 103 (Repeat 5d)",
        Author: "author-repeat",
        IsFirstTimer: false,
      },
    ];
    writeFileSync(cachePath, serializeSampleCacheEntries(cacheEntries), "utf-8");

    try {
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 3,
              items: [
                {
                  number: 103,
                  title: "Sample 103",
                  html_url: "u103",
                  created_at: new Date(now.getTime() - 6 * dayMs).toISOString(),
                  updated_at: merged5d,
                  pull_request: { merged_at: merged5d },
                },
                {
                  number: 101,
                  title: "Sample 101",
                  html_url: "u101",
                  created_at: new Date(now.getTime() - 17 * dayMs).toISOString(),
                  updated_at: merged15d,
                  pull_request: { merged_at: merged15d },
                },
                {
                  number: 102,
                  title: "Sample 102",
                  html_url: "u102",
                  created_at: new Date(now.getTime() - 55 * dayMs).toISOString(),
                  updated_at: merged50d,
                  pull_request: { merged_at: merged50d },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
          fetchBudget: 0,
        },
        client,
        (m) => logs.push(m),
      );

      // 全体サンプルの検証（30日窓）: 101 と 103 のみ採用（2件）
      expect(snapshot?.LookbackDays).toBe(30);
      expect(snapshot?.SampleCount).toBe(2);
      expect(snapshot?.Samples.map((s) => s.Number).sort()).toEqual([101, 103]);

      // 初回提出者コホートの検証（90日窓）: 101 と 102 の両方が採用（2件）
      expect(snapshot?.FirstTimerLookbackDays).toBe(90);
      expect(snapshot?.FirstTimerSampleCount).toBe(2);
      expect(snapshot?.FirstTimerMedianDays).toBe(3.5); // (2.0 + 5.0) / 2 = 3.5

      // ログに「過去 90 日間」が明記されていること
      const logText = logs.join("\n");
      expect(logText).toContain(
        "[初回提出者コホート実績 (過去 90 日間・単発・累計マージ1件: 2件)]",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("キャッシュなしで取得予算を超えて保留（deferred）された候補は SkippedCount に誤混入しない", async () => {
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const merged5d = new Date(now.getTime() - 5 * dayMs).toISOString();
    const merged10d = new Date(now.getTime() - 10 * dayMs).toISOString();

    // 候補 PR が 2 件（#201, #202）存在
    const client = {
      ...buildClient(),
      graphql: async () => ({}),
      searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
        if (query.includes("is:merged")) {
          return {
            totalCount: 2,
            items: [
              {
                number: 201,
                title: "PR 201",
                html_url: "u201",
                created_at: new Date(now.getTime() - 7 * dayMs).toISOString(),
                updated_at: merged5d,
                pull_request: { merged_at: merged5d },
              },
              {
                number: 202,
                title: "PR 202",
                html_url: "u202",
                created_at: new Date(now.getTime() - 12 * dayMs).toISOString(),
                updated_at: merged10d,
                pull_request: { merged_at: merged10d },
              },
            ],
          };
        }
        return (
          buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
        )(query);
      },
      getPullRequestDetails: async (_repo: string, num: number) => ({
        number: num,
        title: `PR ${num}`,
        url: `https://github.com/test/repo/pull/${num}`,
        state: "OPEN" as const,
        isDraft: false,
        createdAt: new Date(now.getTime() - 7 * dayMs).toISOString(),
        updatedAt: merged5d,
        mergedAt: null,
        closedAt: null,
        labels: labels.map((l) => l.name),
        commitCount: 1,
        commits: [{ oid: "abc", messageHeadline: "fix", committedDate: merged5d }],
      }),
      getPullRequestSampleData: async () => ({
        createdAt: new Date(now.getTime() - 7 * dayMs).toISOString(),
        commitCount: 1,
        latestCommittedDate: merged5d,
        author: "author-test",
        timeline: labels.map((l) => ({
          event: "labeled",
          created_at: new Date(now.getTime() - 6 * dayMs).toISOString(),
          label: { name: l.name },
        })),
      }),
      getIssueTimeline: async () =>
        labels.map((l) => ({
          event: "labeled",
          created_at: new Date(now.getTime() - 6 * dayMs).toISOString(),
          label: { name: l.name },
        })),
    } as unknown as GitHubApiClient;

    const logs: string[] = [];
    // fetchBudget: 1 のため、#201 を取得した時点で予算上限となり #202 は保留（deferred）される
    const { snapshot } = await runProgressCli(
      {
        ...options,
        fetchBudget: 1,
        lookbackDays: 30,
        firstTimerLookbackDays: 90,
      },
      client,
      (m) => logs.push(m),
    );

    // 採用 1 件、保留 1 件、除外は 0 件であること（保留分が SkippedCount に誤算入されない）
    expect(snapshot?.SampleCount).toBe(1);
    expect(snapshot?.SkippedCount).toBe(0);
    const logText = logs.join("\n");
    expect(logText).toContain("採用 1 件・除外 0 件");
    expect(logText).toContain("未取得の候補 1 件は次回以降に取得します");
  });

  test("一部キャッシュ済みで取得予算を超えて保留された場合も、実際の除外判定のみが SkippedCount に計上される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-obs-deferred-skipped-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const merged3d = new Date(now.getTime() - 3 * dayMs).toISOString();
    const merged6d = new Date(now.getTime() - 6 * dayMs).toISOString();
    const merged10d = new Date(now.getTime() - 10 * dayMs).toISOString();

    // キャッシュには #301（採用サンプル）と #302（除外サンプル: no-ready）がある
    const cacheEntries: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 301,
        MergedAt: merged3d,
        CreatedAt: new Date(now.getTime() - 5 * dayMs).toISOString(),
        LatestCommittedDate: new Date(now.getTime() - 5 * dayMs).toISOString(),
        CommitCount: 1,
        ReadyAt: new Date(now.getTime() - 4 * dayMs).toISOString(),
        TotalDays: 2.0,
        TurnDays: 2.0,
        ReadyDays: 1.0,
        Title: "Sample 301",
        Author: "author-301",
        IsFirstTimer: true,
      },
      {
        Type: "skipped",
        Number: 302,
        MergedAt: merged6d,
        Reason: "no-ready",
      },
    ];
    writeFileSync(cachePath, serializeSampleCacheEntries(cacheEntries), "utf-8");

    try {
      // 候補には #301, #302 に加え、未キャッシュの #303 が存在する
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged")) {
            return {
              totalCount: 3,
              items: [
                {
                  number: 301,
                  title: "PR 301",
                  html_url: "u301",
                  created_at: new Date(now.getTime() - 5 * dayMs).toISOString(),
                  updated_at: merged3d,
                  pull_request: { merged_at: merged3d },
                },
                {
                  number: 302,
                  title: "PR 302",
                  html_url: "u302",
                  created_at: new Date(now.getTime() - 8 * dayMs).toISOString(),
                  updated_at: merged6d,
                  pull_request: { merged_at: merged6d },
                },
                {
                  number: 303,
                  title: "PR 303",
                  html_url: "u303",
                  created_at: new Date(now.getTime() - 12 * dayMs).toISOString(),
                  updated_at: merged10d,
                  pull_request: { merged_at: merged10d },
                },
              ],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      const logs: string[] = [];
      // fetchBudget: 0 のため、未キャッシュの #303 は保留（deferred）される
      const { snapshot } = await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 0,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        (m) => logs.push(m),
      );

      // 採用 1 件（#301）、除外 1 件（#302 のみ）、保留 1 件（#303）
      expect(snapshot?.SampleCount).toBe(1);
      expect(snapshot?.SkippedCount).toBe(1); // #303 は保留なので SkippedCount は 2 にならず 1 のまま！
      const logText = logs.join("\n");
      expect(logText).toContain("採用 1 件・除外 1 件");
      expect(logText).toContain("未取得の候補 1 件は次回以降に取得します");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("マージ済み候補の走査で日付窓スライス分割クエリが発行され、30日超の非初回候補は詳細取得をスキップして除外記録される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-slice-filter-test-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;

      const searchQueries: string[] = [];
      const detailFetchedPrs: number[] = [];
      const timelineFetchedPrs: number[] = [];

      // 45日前（30日超）の PR:
      // #501: 常連author（author: frequent-user, 同一期間に3件 -> スキップされるべき）
      // #502: 単発author（初回候補 -> サンプル詳細取得されるべき）
      // #503: 常連author（author: frequent-user, 同一期間に3件 -> スキップされるべき）
      // #504: 常連author（author: frequent-user, 同一期間に3件 -> スキップされるべき）
      const merged45d = new Date(now.getTime() - 45 * dayMs).toISOString();

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          searchQueries.push(query);
          if (query.includes("is:merged") && !query.includes("created:<")) {
            // スライス分割クエリ（merged:ISO..ISO）が使われていること
            expect(query).toMatch(/merged:\d{4}-\d{2}-\d{2}T.*..\d{4}-\d{2}-\d{2}T/);

            return {
              totalCount: 4,
              items: [
                {
                  number: 501,
                  title: "PR 501 (frequent author)",
                  html_url: "u501",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  author: "frequent-user",
                  pull_request: { merged_at: merged45d },
                },
                {
                  number: 502,
                  title: "PR 502 (first timer)",
                  html_url: "u502",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  author: "first-timer-user",
                  pull_request: { merged_at: merged45d },
                },
                {
                  number: 503,
                  title: "PR 503 (frequent author)",
                  html_url: "u503",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  author: "frequent-user",
                  pull_request: { merged_at: merged45d },
                },
                {
                  number: 504,
                  title: "PR 504 (frequent author)",
                  html_url: "u504",
                  created_at: new Date(now.getTime() - 50 * dayMs).toISOString(),
                  updated_at: merged45d,
                  author: "frequent-user",
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
          detailFetchedPrs.push(prNumber);
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
            commitCount: 1,
            commits: [
              {
                committedDate: new Date(now.getTime() - 50 * dayMs).toISOString(),
                oid: "abc1234",
              },
            ],
            labels: REQUIRED_LABELS,
          };
        },
        getPullRequestSampleData: async (_repo: string, prNumber: number) => {
          detailFetchedPrs.push(prNumber);
          timelineFetchedPrs.push(prNumber);
          return {
            createdAt: new Date(now.getTime() - 50 * dayMs).toISOString(),
            commitCount: 1,
            latestCommittedDate: new Date(now.getTime() - 50 * dayMs).toISOString(),
            author: "first-timer-user",
            timeline: REQUIRED_LABELS.map((name) => ({
              event: "labeled",
              created_at: new Date(now.getTime() - 48 * dayMs).toISOString(),
              label: { name },
            })),
          };
        },
        getIssueTimeline: async (_repo: string, prNumber: number) => {
          timelineFetchedPrs.push(prNumber);
          return REQUIRED_LABELS.map((name) => ({
            event: "labeled",
            created_at: new Date(now.getTime() - 48 * dayMs).toISOString(),
            label: { name },
          }));
        },
        graphql: async <T>() => {
          return {
            u_0: { issueCount: 1 },
          } as unknown as T;
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

      // 詳細・タイムライン API が呼ばれたのは 自PR(#500) と候補中では #502 のみであること！
      // #501（Draft）と #503, #504（常連author）は詳細フェッチをスキップ！
      expect(detailFetchedPrs).toEqual([500, 502]);
      expect(timelineFetchedPrs).toEqual([500, 502]);

      // スナップショットの確認:
      // #502 は45日前（30日超）のため全体窓 SampleCount には入らず、初回コホート FirstTimerSampleCount に採用されること
      expect(snapshot?.SampleCount).toBe(0);
      expect(snapshot?.FirstTimerSampleCount).toBe(1);
      // 30日以内の除外ではないため全体 SkippedCount は 0
      expect(snapshot?.SkippedCount).toBe(0);

      // キャッシュファイルの内容を確認: スキップされた PR が not-first-timer-candidate として記録されていること
      const savedCache = parseSampleCache(readFileSync(cachePath, "utf-8"));
      const skippedEntries = savedCache.filter((e) => e.Type === "skipped");
      expect(skippedEntries).toHaveLength(3);
      for (const entry of skippedEntries) {
        expect(entry.Reason).toBe("not-first-timer-candidate");
      }
      expect(skippedEntries.map((e) => e.Number).sort()).toEqual([501, 503, 504]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("上限（1,000件）到達時に時間範囲が二分（bisect）されて未走査範囲を捨てずに全件走査される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-bisect-test-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const now = new Date();
      const dayMs = 24 * 60 * 60 * 1000;

      // クエリごとの呼び出し回数と走査された PR 番号を記録
      const queriedFilters: string[] = [];
      const collectedNumbers: number[] = [];

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (
          query: string,
          _sort?: string,
          _order?: string,
          _perPage?: number,
          _page = 1,
        ): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            queriedFilters.push(query);

            const match = query.match(/merged:([0-9T:.Z-]+?)\.\.([0-9T:.Z-]+)/);
            if (match) {
              const start = new Date(match[1]);
              const end = new Date(match[2]);
              const durationDays = (end.getTime() - start.getTime()) / dayMs;

              if (durationDays > 40) {
                // 全期間（約90日幅）: 1,200件と報告して二分を促す
                return {
                  totalCount: 1200,
                  items: [],
                };
              }

              // 二分された約45日幅の窓: それぞれアイテムを返す
              const baseNum = start.getTime() > now.getTime() - 45 * dayMs ? 800 : 900;
              const items = [baseNum + 1, baseNum + 2].map((num) => {
                collectedNumbers.push(num);
                return {
                  number: num,
                  title: `PR ${num}`,
                  html_url: `u${num}`,
                  created_at: new Date(start.getTime()).toISOString(),
                  updated_at: new Date(start.getTime() + dayMs).toISOString(),
                  author: `user-${num}`,
                  pull_request: {
                    merged_at: new Date(start.getTime() + dayMs).toISOString(),
                  },
                };
              });

              return {
                totalCount: 2,
                pageInfo: { hasNextPage: false, endCursor: null },
                items,
              };
            }

            return { totalCount: 0, items: [] };
          }

          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 0, // サンプル詳細取得はスキップし走査のみ検証
          fetchLimit: 5000,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        () => {},
      );

      // 二分されたクエリが発行されていること
      expect(queriedFilters.length).toBeGreaterThan(1);
      // 両方の窓からアイテムが漏れなく収集されていること
      expect(collectedNumbers).toContain(801);
      expect(collectedNumbers).toContain(802);
      expect(collectedNumbers).toContain(901);
      expect(collectedNumbers).toContain(902);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("複数回連続して上限を超過する過密期間でも、漏れなく再帰分割されて全件走査される", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-multi-bisect-test-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const now = new Date();
      const collectedNumbers: number[] = [];
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            const match = query.match(/merged:([0-9T:.Z-]+?)\.\.([0-9T:.Z-]+)/);
            if (match) {
              const start = new Date(match[1]);
              const end = new Date(match[2]);
              const durationMs = end.getTime() - start.getTime();

              // 直近の過密スライス（end が now 付近）において 5 分間に集中した 1,200 件を模倣
              if (end.getTime() >= fiveMinAgo.getTime()) {
                // 150秒（2.5分）を超える幅なら 1,200 件として分割を促す
                if (durationMs > 150_000) {
                  return {
                    totalCount: 1200,
                    items: [],
                  };
                }

                // 2.5分以下に分割された場合:
                const isNewerHalf = start.getTime() >= now.getTime() - 150_000;
                const num = isNewerHalf ? 951 : 952;
                if (!collectedNumbers.includes(num)) {
                  collectedNumbers.push(num);
                }
                return {
                  totalCount: 1,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  items: [
                    {
                      number: num,
                      title: `PR ${num}`,
                      html_url: `u${num}`,
                      created_at: start.toISOString(),
                      updated_at: end.toISOString(),
                      author: `user-${num}`,
                      pull_request: { merged_at: end.toISOString() },
                    },
                  ],
                };
              }
            }
            return { totalCount: 0, items: [] };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      await runProgressCli(
        {
          ...options,
          cachePath,
          fetchBudget: 0,
          fetchLimit: 5000,
          lookbackDays: 30,
          firstTimerLookbackDays: 90,
        },
        client,
        () => {},
      );

      expect(collectedNumbers).toContain(951);
      expect(collectedNumbers).toContain(952);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("最小時間幅（1秒以下）でも 1,000 件を超過している分割不能な極限状態では、データを欠落させず明示的に例外をスローする", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-indivisible-test-"));
    const cachePath = join(tmpDir, "merged-samples.jsonl");

    try {
      const client = {
        ...buildClient(),
        searchIssuesDetailed: async (query: string): Promise<GitHubDetailedSearchResult> => {
          if (query.includes("is:merged") && !query.includes("created:<")) {
            // どんな時間幅でも（最小幅でも）常に 1,200 件を返す
            return {
              totalCount: 1200,
              items: [],
            };
          }
          return (
            buildClient().searchIssuesDetailed as (q: string) => Promise<GitHubDetailedSearchResult>
          )(query);
        },
      } as unknown as GitHubApiClient;

      await expect(
        runProgressCli(
          {
            ...options,
            cachePath,
            fetchBudget: 0,
            fetchLimit: 5000,
            lookbackDays: 30,
            firstTimerLookbackDays: 90,
          },
          client,
          () => {},
        ),
      ).rejects.toThrow("これ以上分割できないため安全に全件走査できません");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
