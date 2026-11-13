import { describe, expect, it } from "bun:test";
import {
  orchestrateSampleCollection,
  type SampleCollectorClient,
} from "../../src/domain/sample-collector";
import type {
  GitHubDetailedSearchItem,
  ProgressPrDetail,
  ProgressTimelineEvent,
} from "../../src/models/progress";
import type { CachedSkippedEntry, SampleCacheEntry } from "../../src/models/sample-cache";

describe("orchestrateSampleCollection", () => {
  const createSearchItem = (
    number: number,
    mergedAt: string,
    author: string = "user1",
  ): GitHubDetailedSearchItem => ({
    number,
    title: `PR #${number}`,
    html_url: `https://github.com/microsoft/winget-pkgs/pull/${number}`,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: mergedAt,
    author,
    commitCount: 1,
    is_draft: false,
    pull_request: { merged_at: mergedAt },
    labels: [{ name: "New-Package" }],
  });

  const createPrDetail = (
    number: number,
    createdAt: string,
    author: string = "user1",
  ): ProgressPrDetail => ({
    number,
    title: `PR #${number}`,
    url: `https://github.com/microsoft/winget-pkgs/pull/${number}`,
    state: "MERGED",
    isDraft: false,
    createdAt,
    updatedAt: "2026-10-20T00:00:00Z",
    mergedAt: "2026-10-20T00:00:00Z",
    closedAt: null,
    labels: ["New-Package"],
    commits: [{ oid: "c1", messageHeadline: "feat", committedDate: createdAt }],
    author,
  });

  const createTimeline = (readyAt: string): ProgressTimelineEvent[] => [
    { event: "labeled", created_at: readyAt, label: { name: "New-Package" } },
    { event: "labeled", created_at: readyAt, label: { name: "Azure-Pipeline-Passed" } },
    { event: "labeled", created_at: readyAt, label: { name: "Validation-Completed" } },
  ];

  it("キャッシュ済みのサンプルは API を呼ばずにそのまま採用する", async () => {
    const cachedEntry: SampleCacheEntry = {
      Type: "sample",
      Number: 101,
      CreatedAt: "2026-10-01T00:00:00Z",
      LatestCommittedDate: "2026-10-01T00:00:00Z",
      CommitCount: 1,
      ReadyAt: "2026-10-02T00:00:00Z",
      MergedAt: "2026-10-05T00:00:00Z",
      ReadyDays: 3.0,
      TotalDays: 4.0,
      TurnDays: 4.0,
      Title: "Cached PR",
      Author: "cachedUser",
      IsFirstTimer: true,
      FirstTimerVersion: 2,
    };

    let apiCalled = false;
    const client: SampleCollectorClient = {
      getIssueTimeline: async () => {
        apiCalled = true;
        return [];
      },
      getPullRequestDetails: async () => {
        apiCalled = true;
        return {} as ProgressPrDetail;
      },
      graphql: async <T = unknown>() => {
        apiCalled = true;
        return {} as T;
      },
    };

    const candidates = [createSearchItem(101, "2026-10-05T00:00:00Z", "cachedUser")];
    const overallSinceDate = new Date("2026-09-01T00:00:00Z");

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: [cachedEntry],
    });

    expect(apiCalled).toBeFalse();
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].number).toBe(101);
    expect(result.samples[0].isFirstTimer).toBeTrue();
    expect(result.fetchedCount).toBe(0);
    expect(result.cacheModified).toBeFalse();
  });

  it("未キャッシュの候補は予算の範囲内で詳細・タイムラインを取得し、累計マージ数を照会して判定する", async () => {
    const client: SampleCollectorClient = {
      getIssueTimeline: async (_repo, _num) => createTimeline("2026-10-02T00:00:00Z"),
      getPullRequestDetails: async (_repo, num) =>
        createPrDetail(num, "2026-10-01T00:00:00Z", `author-${num}`),
      graphql: async <T = unknown>() => {
        // author-201 は 1 件、author-202 は 2 件マージ済みと模倣（エイリアスは u_0, u_1）
        return {
          u_0: { issueCount: 1 },
          u_1: { issueCount: 2 },
        } as unknown as T;
      },
    };

    const candidates = [
      createSearchItem(201, "2026-10-10T00:00:00Z", "author-201"),
      createSearchItem(202, "2026-10-11T00:00:00Z", "author-202"),
    ];
    const overallSinceDate = new Date("2026-09-01T00:00:00Z");

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: [],
    });

    expect(result.samples).toHaveLength(2);
    expect(result.fetchedCount).toBe(2);
    expect(result.cacheModified).toBeTrue();

    const sample201 = result.samples.find((s) => s.number === 201);
    const sample202 = result.samples.find((s) => s.number === 202);

    expect(sample201?.firstTimerReason).toBeUndefined();
    expect(sample201?.isFirstTimer).toBeTrue();
    expect(sample202?.isFirstTimer).toBeFalse();
    expect(sample202?.firstTimerReason).toBe("lifetime-merged");
  });

  it("予算上限（fetchBudget）を超えた候補は保留（deferredCount）され取得を先送りする", async () => {
    const client: SampleCollectorClient = {
      getIssueTimeline: async (_repo, _num) => createTimeline("2026-10-02T00:00:00Z"),
      getPullRequestDetails: async (_repo, num) =>
        createPrDetail(num, "2026-10-01T00:00:00Z", `author-${num}`),
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as unknown as T,
    };

    const candidates = [
      createSearchItem(301, "2026-10-10T00:00:00Z", "author-301"),
      createSearchItem(302, "2026-10-11T00:00:00Z", "author-302"),
    ];
    const overallSinceDate = new Date("2026-09-01T00:00:00Z");

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 1, // 予算 1 件
      initialCache: [],
    });

    expect(result.samples).toHaveLength(1);
    expect(result.fetchedCount).toBe(1);
    expect(result.deferredCount).toBe(1);
  });

  it("条件成立日時が特定できない候補はスキップ（no-ready）として記録される", async () => {
    const client: SampleCollectorClient = {
      getIssueTimeline: async (_repo, _num) => [], // no-ready
      getPullRequestDetails: async (_repo, num) =>
        createPrDetail(num, "2026-10-01T00:00:00Z", `author-${num}`),
      graphql: async <T = unknown>() => ({}) as T,
    };

    const candidates = [createSearchItem(401, "2026-10-10T00:00:00Z", "author-401")];
    const overallSinceDate = new Date("2026-09-01T00:00:00Z");

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: [],
    });

    expect(result.samples).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
    const skipped401 = result.finalCache.find(
      (c): c is CachedSkippedEntry => c.Number === 401 && c.Type === "skipped",
    );
    expect(skipped401?.Reason).toBe("no-ready");
  });

  it("走査期間内に別 PR が存在する作者は常連（recurring-author）として除外される", async () => {
    const client: SampleCollectorClient = {
      getIssueTimeline: async (_repo, _num) => createTimeline("2026-10-02T00:00:00Z"),
      getPullRequestDetails: async (_repo, num) =>
        createPrDetail(num, "2026-10-01T00:00:00Z", "repeat-user"),
      graphql: async <T = unknown>() => ({}) as T,
    };

    const candidates = [
      createSearchItem(501, "2026-10-10T00:00:00Z", "repeat-user"),
      createSearchItem(502, "2026-10-11T00:00:00Z", "repeat-user"),
    ];
    const overallSinceDate = new Date("2026-09-01T00:00:00Z");

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: [],
    });

    expect(result.samples).toHaveLength(2);
    for (const sample of result.samples) {
      expect(sample.isFirstTimer).toBeFalse();
      expect(sample.firstTimerReason).toBe("recurring-author");
    }
  });

  it("全体窓（30日）外で初回候補になり得ない候補は詳細取得をスキップして除外記録される", async () => {
    let detailCalled = false;
    const client: SampleCollectorClient = {
      getIssueTimeline: async () => {
        detailCalled = true;
        return [];
      },
      getPullRequestDetails: async () => {
        detailCalled = true;
        return {} as ProgressPrDetail;
      },
      graphql: async <T = unknown>() => ({}) as T,
    };

    // 60日前の PR で draft 状態（初回候補にならない）
    const item = createSearchItem(601, "2026-09-01T00:00:00Z", "draft-user");
    item.is_draft = true;

    const overallSinceDate = new Date("2026-10-01T00:00:00Z"); // 30日前

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [item],
      overallSinceDate,
      fetchBudget: 10,
      initialCache: [],
    });

    expect(detailCalled).toBeFalse();
    expect(result.samples).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
    const skipped601 = result.finalCache.find(
      (c): c is CachedSkippedEntry => c.Number === 601 && c.Type === "skipped",
    );
    expect(skipped601?.Reason).toBe("not-first-timer-candidate");
  });
});
