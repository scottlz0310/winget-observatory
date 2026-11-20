import { describe, expect, it } from "bun:test";
import { indexSampleCache } from "../../src/domain/sample-cache";
import {
  orchestrateSampleCollection,
  refreshLegacyAuthorMetadata,
  type SampleCollectorClient,
} from "../../src/domain/sample-collector";
import { refreshLegacyAuthorMetadata as directRefreshLegacyAuthorMetadata } from "../../src/domain/sample-metadata-refresh";
import type { GitHubDetailedSearchItem, MergedCandidateSample } from "../../src/models/progress";
import type { SampleCacheEntry } from "../../src/models/sample-cache";

describe("refreshLegacyAuthorMetadata", () => {
  it("中間世代（v7 -> targetVersion: 8 想定）キャッシュの作者メタデータを軽量バッチで補完し、特権ロール/Bot は降格しつつ上位版へ昇格させる", async () => {
    const fixedNow = new Date("2026-11-19T00:00:00Z");
    const initialEntries: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 1501,
        Title: "PR 1501",
        CreatedAt: "2026-11-01T00:00:00Z",
        LatestCommittedDate: "2026-11-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-11-01T01:00:00.000Z",
        MergedAt: "2026-11-10T00:00:00.000Z",
        TotalDays: 9,
        TurnDays: 9,
        ReadyDays: 8.96,
        Author: "asklar",
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      },
      {
        Type: "sample",
        Number: 1502,
        Title: "PR 1502",
        CreatedAt: "2026-11-01T00:00:00Z",
        LatestCommittedDate: "2026-11-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-11-01T01:00:00.000Z",
        MergedAt: "2026-11-09T00:00:00.000Z",
        TotalDays: 8,
        TurnDays: 8,
        ReadyDays: 7.96,
        Author: "normal-dev",
        IsFirstTimer: true,
        FirstTimerVersion: 7,
      },
    ];
    const cacheIndex = indexSampleCache(initialEntries);
    const samples: MergedCandidateSample[] = [
      {
        number: 1501,
        title: "PR 1501",
        createdAt: "2026-11-01T00:00:00Z",
        latestCommittedDate: "2026-11-01T00:00:00Z",
        commitCount: 1,
        readyAt: "2026-11-01T01:00:00.000Z",
        mergedAt: "2026-11-10T00:00:00.000Z",
        totalDays: 9,
        turnDays: 9,
        days: 8.96,
        author: "asklar",
        isFirstTimer: true,
        firstTimerVersion: 7,
      },
    ];

    let queryCount = 0;
    const client = {
      graphql: async <T = unknown>() => {
        queryCount++;
        return {
          repository: {
            p_0: { author: { __typename: "User", login: "asklar" }, authorAssociation: "MEMBER" },
            p_1: {
              author: { __typename: "User", login: "normal-dev" },
              authorAssociation: "CONTRIBUTOR",
            },
          },
        } as T;
      },
    };

    const disabled = await refreshLegacyAuthorMetadata({
      cacheIndex,
      samples,
      client,
      repository: "microsoft/winget-pkgs",
      now: fixedNow,
      windowDays: 90,
      budget: 0,
      targetVersion: 8,
    });
    expect(queryCount).toBe(0);
    expect(disabled.cacheModified).toBeFalse();

    const result = await refreshLegacyAuthorMetadata({
      cacheIndex,
      samples,
      client,
      repository: "microsoft/winget-pkgs",
      now: fixedNow,
      windowDays: 90,
      budget: 10,
      targetVersion: 8,
    });
    expect(queryCount).toBe(1);
    expect(result).toEqual({ updatedCount: 2, privilegedDemotedCount: 1, cacheModified: true });

    const c1501 = cacheIndex.get(1501);
    expect(c1501?.Type === "sample" && c1501.IsFirstTimer).toBeFalse();
    expect(c1501?.Type === "sample" && c1501.FirstTimerReason).toBe("privileged-or-bot");
    expect(c1501?.Type === "sample" && c1501.AuthorAssociation).toBe("MEMBER");
    expect(c1501?.Type === "sample" && c1501.FirstTimerVersion).toBe(8);

    const c1502 = cacheIndex.get(1502);
    expect(c1502?.Type === "sample" && c1502.IsFirstTimer).toBeTrue();
    expect(c1502?.Type === "sample" && c1502.AuthorAssociation).toBe("CONTRIBUTOR");
    expect(c1502?.Type === "sample" && c1502.FirstTimerVersion).toBe(8);

    // メモリ上の samples 配列へも同期されている
    expect(samples[0]?.isFirstTimer).toBeFalse();
    expect(samples[0]?.firstTimerReason).toBe("privileged-or-bot");
    expect(samples[0]?.firstTimerVersion).toBe(8);
  });

  it("budget 切れで保留された timeline-blocking の旧レコードは軽量補完で昇格せず、次回 budget 回復時に再評価される（レビュー指摘回帰テスト）", async () => {
    const fixedNow = new Date("2026-11-20T00:00:00Z");
    const initialCache: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 1601,
        Title: "PR 1601",
        CreatedAt: "2026-11-01T00:00:00Z",
        LatestCommittedDate: "2026-11-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-11-01T01:00:00.000Z",
        MergedAt: "2026-11-10T00:00:00.000Z",
        TotalDays: 9,
        TurnDays: 9,
        ReadyDays: 8.96,
        Author: "first-time-user",
        IsFirstTimer: false,
        FirstTimerReason: "timeline-blocking",
        FirstTimerVersion: 6,
      },
    ];
    const candidates: GitHubDetailedSearchItem[] = [
      {
        number: 1601,
        title: "PR #1601",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/1601",
        created_at: "2026-11-01T00:00:00Z",
        updated_at: "2026-11-10T00:00:00.000Z",
        author: "first-time-user",
        pull_request: { merged_at: "2026-11-10T00:00:00.000Z" },
      },
    ];
    const overallSinceDate = new Date("2026-10-01T00:00:00Z");

    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => ({
        createdAt: "2026-11-01T00:00:00Z",
        commitCount: 1,
        latestCommittedDate: "2026-11-01T00:00:00Z",
        author: "first-time-user",
        authorType: "User",
        authorAssociation: "CONTRIBUTOR",
        timeline: [
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
        ],
      }),
      graphql: async <T = unknown>(query: string) => {
        if (query.includes("authorAssociation")) {
          return {
            repository: {
              p_0: {
                author: { __typename: "User", login: "first-time-user" },
                authorAssociation: "CONTRIBUTOR",
              },
            },
          } as T;
        }
        // resolveAuthorMergedCounts: 生涯マージ数 1 件（初回提出者）
        return {
          u_0: { issueCount: 1 },
        } as T;
      },
    };

    // 1回目: fetchBudget: 0 のため通常再評価が保留され、既存の v6/timeline-blocking のまま残る
    const firstRun = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 0,
      initialCache,
    });
    expect(firstRun.fetchedCount).toBe(0);
    expect(firstRun.samples[0]?.isFirstTimer).toBeFalse();
    expect(firstRun.samples[0]?.firstTimerReason).toBe("timeline-blocking");
    expect(firstRun.samples[0]?.firstTimerVersion).toBe(6);

    const cacheIndex = indexSampleCache(firstRun.finalCache);
    const refreshResult = await refreshLegacyAuthorMetadata({
      cacheIndex,
      samples: firstRun.samples,
      client,
      repository: "microsoft/winget-pkgs",
      now: fixedNow,
      windowDays: 90,
      budget: 10,
      targetVersion: 8,
    });
    expect(refreshResult).toEqual({
      updatedCount: 0,
      privilegedDemotedCount: 0,
      cacheModified: false,
    });

    const afterRefresh = cacheIndex.get(1601);
    expect(afterRefresh?.Type === "sample" && afterRefresh.FirstTimerVersion).toBe(6);
    expect(afterRefresh?.Type === "sample" && afterRefresh.IsFirstTimer).toBeFalse();
    expect(afterRefresh?.Type === "sample" && afterRefresh.FirstTimerReason).toBe(
      "timeline-blocking",
    );

    // 2回目: budget 回復後、v6 のまま残っているため正しく初回提出者 v7 として再評価される
    const secondRun = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: Array.from(cacheIndex.values()),
    });
    expect(secondRun.fetchedCount).toBe(1);
    expect(secondRun.samples[0]?.isFirstTimer).toBeTrue();
    expect(secondRun.samples[0]?.firstTimerReason).toBeUndefined();
    expect(secondRun.samples[0]?.firstTimerVersion).toBe(7);
  });

  it("sample-metadata-refresh.ts のエクスポートと sample-collector.ts の互換 re-export が完全一致する", () => {
    expect(refreshLegacyAuthorMetadata).toBe(directRefreshLegacyAuthorMetadata);
  });
});
