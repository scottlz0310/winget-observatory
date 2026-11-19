import { describe, expect, it } from "bun:test";
import { indexSampleCache } from "../../src/domain/sample-cache";
import {
  orchestrateSampleCollection,
  refreshLegacyAuthorMetadata,
  type SampleCollectorClient,
} from "../../src/domain/sample-collector";
import type {
  GitHubDetailedSearchItem,
  MergedCandidateSample,
  ProgressPrSampleData,
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
    pull_request: { merged_at: mergedAt },
  });

  const createTimeline = (readyAt: string): ProgressTimelineEvent[] => [
    { event: "labeled", created_at: readyAt, label: { name: "New-Package" } },
    { event: "labeled", created_at: readyAt, label: { name: "Azure-Pipeline-Passed" } },
    { event: "labeled", created_at: readyAt, label: { name: "Validation-Completed" } },
  ];

  const createSampleData = (
    createdAt: string,
    readyAt: string | null,
    author: string = "user1",
    commitCount = 1,
  ): ProgressPrSampleData => ({
    createdAt,
    commitCount,
    latestCommittedDate: createdAt,
    author,
    timeline: readyAt ? createTimeline(readyAt) : [],
  });

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
      FirstTimerVersion: 7,
    };

    let apiCalled = false;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        apiCalled = true;
        return {} as ProgressPrSampleData;
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

  it("未キャッシュの候補は予算の範囲内で 1 PR につき 1 クエリ（getPullRequestSampleData）で取得し、累計マージ数を照会して判定する", async () => {
    let sampleCallCount = 0;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async (_repo, num) => {
        sampleCallCount++;
        return createSampleData("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", `author-${num}`);
      },
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

    expect(sampleCallCount).toBe(2);
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
      getPullRequestSampleData: async (_repo, num) =>
        createSampleData("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", `author-${num}`),
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
      getPullRequestSampleData: async (_repo, num) =>
        createSampleData("2026-10-01T00:00:00Z", null, `author-${num}`),
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
      getPullRequestSampleData: async () =>
        createSampleData("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "repeat-user"),
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

  it("全体窓（30日）外で初回候補になり得ない候補（複数回出現著者）は詳細取得をスキップして除外記録される", async () => {
    let detailCalled = false;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        detailCalled = true;
        return {} as ProgressPrSampleData;
      },
      graphql: async <T = unknown>() => ({}) as T,
    };

    // 60日前の PR で同一著者が 2 件（常連のため初回候補にならない）
    const item1 = createSearchItem(601, "2026-09-01T00:00:00Z", "repeat-outside-user");
    const item2 = createSearchItem(602, "2026-09-02T00:00:00Z", "repeat-outside-user");

    const overallSinceDate = new Date("2026-10-01T00:00:00Z"); // 30日前

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [item1, item2],
      overallSinceDate,
      fetchBudget: 10,
      initialCache: [],
    });

    expect(detailCalled).toBeFalse();
    expect(result.samples).toHaveLength(0);
    expect(result.skippedCount).toBe(2);
    const skipped601 = result.finalCache.find(
      (c): c is CachedSkippedEntry => c.Number === 601 && c.Type === "skipped",
    );
    expect(skipped601?.Reason).toBe("not-first-timer-candidate");
  });

  it("経過日数の境界値（1.045日）で従来の toFixed(2) 丸め（1.04）を維持する", async () => {
    const startIso = "2026-11-01T00:00:00Z";
    const mergedIso = "2026-11-02T01:04:48Z"; // 1.045 日後
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => createSampleData(startIso, startIso, "boundary-user"),
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    };

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(701, mergedIso, "boundary-user")],
      overallSinceDate: new Date("2026-10-01T00:00:00Z"),
      fetchBudget: 10,
      initialCache: [],
    });

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.totalDays).toBe(1.04);
    expect(result.samples[0]?.turnDays).toBe(1.04);
    expect(result.samples[0]?.days).toBe(1.04);
  });

  it("旧版キャッシュの複数コミット常連サンプルは API を呼ばずに recurring-author へ補完される", async () => {
    const legacyCached: SampleCacheEntry = {
      Type: "sample",
      Number: 901,
      CreatedAt: "2026-10-01T00:00:00Z",
      LatestCommittedDate: "2026-10-02T00:00:00Z",
      CommitCount: 2,
      ReadyAt: "2026-10-02T00:00:00Z",
      MergedAt: "2026-10-05T00:00:00Z",
      ReadyDays: 3.0,
      TotalDays: 4.0,
      TurnDays: 3.0,
      Title: "Legacy Recurring PR",
      Author: "repeat-legacy",
      IsFirstTimer: false,
      FirstTimerVersion: 1,
    };

    let apiCalled = false;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        apiCalled = true;
        return {} as ProgressPrSampleData;
      },
      graphql: async <T = unknown>() => {
        apiCalled = true;
        return {} as T;
      },
    };

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [
        createSearchItem(901, "2026-10-05T00:00:00Z", "repeat-legacy"),
        createSearchItem(902, "2026-10-06T00:00:00Z", "repeat-legacy"),
      ],
      overallSinceDate: new Date("2026-09-01T00:00:00Z"),
      fetchBudget: 0,
      initialCache: [legacyCached],
    });

    expect(apiCalled).toBeFalse();
    expect(result.cacheModified).toBeTrue();
    const updated901 = result.finalCache.find((c) => c.Number === 901 && c.Type === "sample");
    expect(updated901?.Type === "sample" && updated901.FirstTimerReason).toBe("recurring-author");
    expect(updated901?.Type === "sample" && updated901.FirstTimerVersion).toBe(1);
  });

  it("旧版 no-ready スキップキャッシュ（Waived-*-Error 付き PR）を再評価し、空キャッシュ時と同一のサンプル・ReadyAt・初回判定を得る", async () => {
    const waivedTimeline: ProgressTimelineEvent[] = [
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
        label: { name: "Waived-Validation-Defender-Error" },
      },
    ];

    let fetchCountWithLegacyCache = 0;
    const makeClient = (onFetch?: () => void): SampleCollectorClient => ({
      getPullRequestSampleData: async () => {
        onFetch?.();
        return {
          createdAt: "2026-10-01T00:00:00Z",
          commitCount: 1,
          latestCommittedDate: "2026-10-01T00:00:00Z",
          author: "waived-user",
          timeline: waivedTimeline,
        };
      },
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    });

    const candidates = [createSearchItem(1101, "2026-10-05T01:00:00Z", "waived-user")];
    const overallSinceDate = new Date("2026-09-01T00:00:00Z");

    // 1. 空キャッシュでの結果
    const emptyCacheResult = await orchestrateSampleCollection({
      client: makeClient(),
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 5,
      initialCache: [],
    });

    // 2. 旧版の no-ready キャッシュが存在する状態での結果
    const legacyNoReadyCache: SampleCacheEntry[] = [
      {
        Type: "skipped",
        Number: 1101,
        MergedAt: "2026-10-05T01:00:00Z",
        Reason: "no-ready",
      },
    ];
    const migratedResult = await orchestrateSampleCollection({
      client: makeClient(() => {
        fetchCountWithLegacyCache++;
      }),
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 5,
      initialCache: legacyNoReadyCache,
    });

    expect(fetchCountWithLegacyCache).toBe(1);
    expect(migratedResult.samples).toHaveLength(1);
    expect(migratedResult.skippedCount).toBe(0);
    expect(migratedResult.samples).toEqual(emptyCacheResult.samples);
    expect(migratedResult.samples[0]?.isFirstTimer).toBeTrue();
    expect(migratedResult.samples[0]?.readyAt).toBe("2026-10-01T01:00:00.000Z");
    expect(migratedResult.samples[0]?.days).toBe(4);
    expect(migratedResult.finalCache).toEqual(emptyCacheResult.finalCache);
  });

  it("旧版 sample キャッシュ（timeline-blocking かつ Waived-*-Error の一時付与で ReadyAt が後ろ倒しされていた PR）を再評価し、正しい ReadyAt と初回判定に更新する", async () => {
    // 旧実装では 10/02 に Waived-Validation-Defender-Error が付いて 10/04 に外れた場合、
    // ReadyAt が 10/04 にリセットされ、さらに timeline-blocking として IsFirstTimer: false になっていた。
    // 新実装では Waived-* は阻害ではないため ReadyAt は 10/01 のまま維持され、IsFirstTimer: true になる。
    const legacySampleCache: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 1102,
        Title: "PR #1102",
        CreatedAt: "2026-10-01T00:00:00Z",
        LatestCommittedDate: "2026-10-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-10-04T00:00:00.000Z", // 旧実装で誤って後ろ倒しされた ReadyAt
        MergedAt: "2026-10-05T00:00:00.000Z",
        TotalDays: 4,
        TurnDays: 4,
        ReadyDays: 1, // 旧実装の誤った ReadyDays
        Author: "waived-temp-user",
        IsFirstTimer: false,
        FirstTimerReason: "timeline-blocking",
        FirstTimerVersion: 2,
      },
    ];

    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => ({
        createdAt: "2026-10-01T00:00:00Z",
        commitCount: 1,
        latestCommittedDate: "2026-10-01T00:00:00Z",
        author: "waived-temp-user",
        timeline: [
          {
            event: "labeled",
            created_at: "2026-10-01T00:00:00Z",
            label: { name: "New-Package" },
          },
          {
            event: "labeled",
            created_at: "2026-10-01T00:00:00Z",
            label: { name: "Azure-Pipeline-Passed" },
          },
          {
            event: "labeled",
            created_at: "2026-10-01T00:00:00Z",
            label: { name: "Validation-Completed" },
          },
          {
            event: "labeled",
            created_at: "2026-10-02T00:00:00Z",
            label: { name: "Waived-Validation-Defender-Error" },
          },
          {
            event: "unlabeled",
            created_at: "2026-10-04T00:00:00Z",
            label: { name: "Waived-Validation-Defender-Error" },
          },
        ],
      }),
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    };

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(1102, "2026-10-05T00:00:00.000Z", "waived-temp-user")],
      overallSinceDate: new Date("2026-09-01T00:00:00Z"),
      fetchBudget: 5,
      initialCache: legacySampleCache,
    });

    expect(result.fetchedCount).toBe(1);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.readyAt).toBe("2026-10-01T00:00:00.000Z");
    expect(result.samples[0]?.days).toBe(4);
    expect(result.samples[0]?.isFirstTimer).toBeTrue();
    expect(result.samples[0]?.firstTimerReason).toBeUndefined();
    expect(result.samples[0]?.firstTimerVersion).toBe(7);
  });

  it("新版（FirstTimerVersion: 3）で記録済みの no-ready キャッシュは再取得せずスキップを維持する", async () => {
    let apiCalled = false;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        apiCalled = true;
        return {} as ProgressPrSampleData;
      },
      graphql: async <T = unknown>() => ({}) as T,
    };

    const v3NoReadyCache: SampleCacheEntry[] = [
      {
        Type: "skipped",
        Number: 1103,
        MergedAt: "2026-10-05T00:00:00.000Z",
        Reason: "no-ready",
        FirstTimerVersion: 3,
      },
    ];

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(1103, "2026-10-05T00:00:00.000Z", "user-1103")],
      overallSinceDate: new Date("2026-09-01T00:00:00Z"),
      fetchBudget: 5,
      initialCache: v3NoReadyCache,
    });

    expect(apiCalled).toBeFalse();
    expect(result.fetchedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
  });

  it("全体窓外の not-first-timer-candidate キャッシュが窓内判定になれば再評価して取得する", async () => {
    const skippedCached: SampleCacheEntry = {
      Type: "skipped",
      Number: 951,
      MergedAt: "2026-10-10T00:00:00Z",
      Reason: "not-first-timer-candidate",
    };

    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () =>
        createSampleData("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", "single-user"),
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    };

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(951, "2026-10-10T00:00:00Z", "single-user")],
      overallSinceDate: new Date("2026-10-01T00:00:00Z"),
      fetchBudget: 5,
      initialCache: [skippedCached],
    });

    expect(result.fetchedCount).toBe(1);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.isFirstTimer).toBeTrue();
  });

  it("途中失敗時も取得済みキャッシュを onCacheUpdated へ通知しエラーを伝播する", async () => {
    let notifiedEntries: SampleCacheEntry[] = [];
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async (_repo, num) => {
        if (num === 992) {
          throw new Error("timeline boom");
        }
        return createSampleData("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", `author-${num}`);
      },
      graphql: async <T = unknown>() => ({}) as T,
    };

    await expect(
      orchestrateSampleCollection({
        client,
        repository: "microsoft/winget-pkgs",
        candidates: [
          createSearchItem(991, "2026-10-10T00:00:00Z", "author-991"),
          createSearchItem(992, "2026-10-11T00:00:00Z", "author-992"),
        ],
        overallSinceDate: new Date("2026-09-01T00:00:00Z"),
        fetchBudget: 10,
        initialCache: [],
        onCacheUpdated: (entries) => {
          notifiedEntries = entries;
        },
      }),
    ).rejects.toThrow("マージ済み PR #992 のサンプル計測に失敗しました: timeline boom");

    expect(notifiedEntries.some((e) => e.Number === 991 && e.Type === "sample")).toBeTrue();
  });

  it("全候補キャッシュ済みで単発著者照会が失敗しても、先行確定した recurring-author 判定は onCacheUpdated で保存される", async () => {
    const createUnjudgedCachedSample = (number: number, author: string): SampleCacheEntry => ({
      Type: "sample",
      Number: number,
      CreatedAt: "2026-10-01T00:00:00Z",
      LatestCommittedDate: "2026-10-01T00:00:00Z",
      CommitCount: 1,
      ReadyAt: "2026-10-02T00:00:00Z",
      MergedAt: "2026-10-10T00:00:00Z",
      ReadyDays: 8.0,
      TotalDays: 9.0,
      TurnDays: 9.0,
      Title: `PR #${number}`,
      Author: author,
    });

    const initialCache: SampleCacheEntry[] = [
      createUnjudgedCachedSample(1001, "repeat-cached"),
      createUnjudgedCachedSample(1002, "repeat-cached"),
      createUnjudgedCachedSample(1003, "single-cached"),
    ];

    let notifyCount = 0;
    let notifiedEntries: SampleCacheEntry[] = [];
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => ({}) as ProgressPrSampleData,
      graphql: async <_T = unknown>() => {
        throw new Error("graphql failure");
      },
    };

    await expect(
      orchestrateSampleCollection({
        client,
        repository: "microsoft/winget-pkgs",
        candidates: [
          createSearchItem(1001, "2026-10-10T00:00:00Z", "repeat-cached"),
          createSearchItem(1002, "2026-10-10T00:00:00Z", "repeat-cached"),
          createSearchItem(1003, "2026-10-10T00:00:00Z", "single-cached"),
        ],
        overallSinceDate: new Date("2026-09-01T00:00:00Z"),
        fetchBudget: 0,
        initialCache,
        onCacheUpdated: (entries) => {
          notifyCount++;
          notifiedEntries = entries;
        },
      }),
    ).rejects.toThrow("graphql failure");

    expect(notifyCount).toBe(1);
    const saved1001 = notifiedEntries.find((e) => e.Number === 1001);
    const saved1002 = notifiedEntries.find((e) => e.Number === 1002);
    expect(saved1001?.Type === "sample" && saved1001.IsFirstTimer).toBeFalse();
    expect(saved1001?.Type === "sample" && saved1001.FirstTimerReason).toBe("recurring-author");
    expect(saved1002?.Type === "sample" && saved1002.IsFirstTimer).toBeFalse();
    expect(saved1002?.Type === "sample" && saved1002.FirstTimerReason).toBe("recurring-author");
  });

  it("過去の阻害ラベル履歴（needsCLA 等）・Draft 履歴・複数コミットがあっても、生涯マージ 1 件なら IsFirstTimer: true になる", async () => {
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => ({
        createdAt: "2026-10-01T00:00:00Z",
        commitCount: 4,
        latestCommittedDate: "2026-10-03T00:00:00Z",
        author: "first-timer-with-cla",
        timeline: [
          {
            event: "labeled",
            created_at: "2026-10-01T00:05:00Z",
            label: { name: "needsCLA" },
          },
          {
            event: "unlabeled",
            created_at: "2026-10-01T01:00:00Z",
            label: { name: "needsCLA" },
          },
          {
            event: "converted_to_draft",
            created_at: "2026-10-01T02:00:00Z",
          },
          {
            event: "ready_for_review",
            created_at: "2026-10-02T00:00:00Z",
          },
          {
            event: "labeled",
            created_at: "2026-10-03T01:00:00Z",
            label: { name: "New-Package" },
          },
          {
            event: "labeled",
            created_at: "2026-10-03T01:00:00Z",
            label: { name: "Azure-Pipeline-Passed" },
          },
          {
            event: "labeled",
            created_at: "2026-10-03T01:00:00Z",
            label: { name: "Validation-Completed" },
          },
        ],
      }),
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    };

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(449315, "2026-10-10T00:00:00Z", "first-timer-with-cla")],
      overallSinceDate: new Date("2026-09-01T00:00:00Z"),
      fetchBudget: 5,
      initialCache: [],
    });

    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.isFirstTimer).toBeTrue();
    expect(result.samples[0]?.firstTimerReason).toBeUndefined();
    expect(result.samples[0]?.firstTimerVersion).toBe(7);
    const saved = result.finalCache.find((e) => e.Number === 449315);
    expect(saved?.Type === "sample" && saved.IsFirstTimer).toBeTrue();
    expect(saved?.Type === "sample" && saved.FirstTimerReason).toBeUndefined();
    expect(saved?.Type === "sample" && saved.FirstTimerVersion).toBe(7);
  });

  it("Validation-Guide 阻害化に伴う v4 キャッシュ再評価: 一時付与→解除サンプルと未解除サンプルが、空キャッシュ時と同一の ReadyAt / ReadyDays / skipped になる", async () => {
    const tempGuideTimeline: ProgressTimelineEvent[] = [
      { event: "labeled", created_at: "2026-11-01T00:00:00Z", label: { name: "New-Package" } },
      {
        event: "labeled",
        created_at: "2026-11-01T00:00:00Z",
        label: { name: "Azure-Pipeline-Passed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-01T00:00:00Z",
        label: { name: "Validation-Completed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-02T00:00:00Z",
        label: { name: "Validation-Guide" },
      },
      {
        event: "unlabeled",
        created_at: "2026-11-15T00:00:00Z",
        label: { name: "Validation-Guide" },
      },
    ];
    const unresolvedGuideTimeline: ProgressTimelineEvent[] = [
      { event: "labeled", created_at: "2026-11-01T00:00:00Z", label: { name: "New-Package" } },
      {
        event: "labeled",
        created_at: "2026-11-01T00:00:00Z",
        label: { name: "Azure-Pipeline-Passed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-01T00:00:00Z",
        label: { name: "Validation-Completed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-02T00:00:00Z",
        label: { name: "Validation-Guide" },
      },
    ];

    const makeClient = (onFetch?: () => void): SampleCollectorClient => ({
      getPullRequestSampleData: async (_repo, num) => {
        onFetch?.();
        if (num === 1201) {
          return {
            createdAt: "2026-11-01T00:00:00Z",
            commitCount: 1,
            latestCommittedDate: "2026-11-01T00:00:00Z",
            author: "guide-temp-user",
            timeline: tempGuideTimeline,
          };
        }
        return {
          createdAt: "2026-11-01T00:00:00Z",
          commitCount: 1,
          latestCommittedDate: "2026-11-01T00:00:00Z",
          author: "guide-stuck-user",
          timeline: unresolvedGuideTimeline,
        };
      },
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    });

    const candidates = [
      createSearchItem(1201, "2026-11-17T00:00:00Z", "guide-temp-user"),
      createSearchItem(1202, "2026-11-17T00:00:00Z", "guide-stuck-user"),
    ];
    const overallSinceDate = new Date("2026-10-18T00:00:00Z");

    const emptyResult = await orchestrateSampleCollection({
      client: makeClient(),
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: [],
    });

    // 旧判定（Validation-Guide 阻害化前）で v4 として保存されていたキャッシュ
    const v4Cache: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 1201,
        Title: "PR #1201",
        CreatedAt: "2026-11-01T00:00:00Z",
        LatestCommittedDate: "2026-11-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-11-01T00:00:00.000Z",
        MergedAt: "2026-11-17T00:00:00.000Z",
        TotalDays: 16,
        TurnDays: 16,
        ReadyDays: 16,
        Author: "guide-temp-user",
        IsFirstTimer: true,
        FirstTimerVersion: 4,
      },
      {
        Type: "sample",
        Number: 1202,
        Title: "PR #1202",
        CreatedAt: "2026-11-01T00:00:00Z",
        LatestCommittedDate: "2026-11-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-11-01T00:00:00.000Z",
        MergedAt: "2026-11-17T00:00:00.000Z",
        TotalDays: 16,
        TurnDays: 16,
        ReadyDays: 16,
        Author: "guide-stuck-user",
        IsFirstTimer: true,
        FirstTimerVersion: 4,
      },
    ];

    let migratedFetches = 0;
    const migratedResult = await orchestrateSampleCollection({
      client: makeClient(() => {
        migratedFetches++;
      }),
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: v4Cache,
    });

    expect(migratedFetches).toBe(2);
    expect(migratedResult.samples).toEqual(emptyResult.samples);
    expect(migratedResult.skippedCount).toBe(emptyResult.skippedCount);
    expect(migratedResult.samples).toHaveLength(1);
    expect(migratedResult.samples[0]?.number).toBe(1201);
    expect(migratedResult.samples[0]?.readyAt).toBe("2026-11-15T00:00:00.000Z");
    expect(migratedResult.samples[0]?.days).toBe(2);
    expect(migratedResult.samples[0]?.firstTimerVersion).toBe(7);
    expect(migratedResult.finalCache).toEqual(emptyResult.finalCache);
  });

  it("予算枯渇時に markRecurringBatchAuthors 等で著者判定のみ更新されても未再計測 v4 キャッシュを v5 へ昇格させず、次回の予算あり実行で ReadyAt / ReadyDays を再計測する", async () => {
    const guideTimeline: ProgressTimelineEvent[] = [
      { event: "labeled", created_at: "2026-11-01T00:00:00Z", label: { name: "New-Package" } },
      {
        event: "labeled",
        created_at: "2026-11-01T00:00:00Z",
        label: { name: "Azure-Pipeline-Passed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-01T00:00:00Z",
        label: { name: "Validation-Completed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-02T00:00:00Z",
        label: { name: "Validation-Guide" },
      },
      {
        event: "unlabeled",
        created_at: "2026-11-15T00:00:00Z",
        label: { name: "Validation-Guide" },
      },
    ];

    let sampleFetches = 0;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        sampleFetches++;
        return {
          createdAt: "2026-11-01T00:00:00Z",
          commitCount: 1,
          latestCommittedDate: "2026-11-01T00:00:00Z",
          author: "batch-repeat-user",
          timeline: guideTimeline,
        };
      },
      graphql: async <T = unknown>() => ({}) as T,
    };

    const candidates = [
      createSearchItem(1211, "2026-11-17T00:00:00Z", "batch-repeat-user"),
      createSearchItem(1212, "2026-11-17T00:00:00Z", "batch-repeat-user"),
    ];
    const overallSinceDate = new Date("2026-10-18T00:00:00Z");

    const v4InitialCache: SampleCacheEntry[] = [1211, 1212].map((num) => ({
      Type: "sample",
      Number: num,
      Title: `PR #${num}`,
      CreatedAt: "2026-11-01T00:00:00Z",
      LatestCommittedDate: "2026-11-01T00:00:00Z",
      CommitCount: 1,
      ReadyAt: "2026-11-01T00:00:00.000Z",
      MergedAt: "2026-11-17T00:00:00.000Z",
      TotalDays: 16,
      TurnDays: 16,
      ReadyDays: 16,
      Author: "batch-repeat-user",
      IsFirstTimer: true,
      FirstTimerVersion: 4,
    }));

    // 第 1 回実行: 予算枯渇 (fetchBudget=0) で markRecurringBatchAuthors が動作
    const firstRun = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 0,
      initialCache: v4InitialCache,
    });

    expect(sampleFetches).toBe(0);
    expect(firstRun.fetchedCount).toBe(0);
    expect(firstRun.cacheModified).toBeTrue();
    for (const num of [1211, 1212]) {
      const saved = firstRun.finalCache.find((e) => e.Number === num);
      expect(saved?.Type === "sample" && saved.IsFirstTimer).toBeFalse();
      expect(saved?.Type === "sample" && saved.FirstTimerReason).toBe("recurring-author");
      // 未再計測のため v4 のまま維持（v5 へ昇格させない）
      expect(saved?.Type === "sample" && saved.FirstTimerVersion).toBe(4);
    }

    // 第 2 回実行: 予算あり (fetchBudget=10) でタイムライン再取得が走り、ReadyAt=11/15・ReadyDays=2・v5 へ修復される
    const secondRun = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates,
      overallSinceDate,
      fetchBudget: 10,
      initialCache: firstRun.finalCache,
    });

    expect(sampleFetches).toBe(2);
    expect(secondRun.fetchedCount).toBe(2);
    expect(secondRun.samples).toHaveLength(2);
    for (const s of secondRun.samples) {
      expect(s.readyAt).toBe("2026-11-15T00:00:00.000Z");
      expect(s.days).toBe(2);
      expect(s.isFirstTimer).toBeFalse();
      expect(s.firstTimerReason).toBe("recurring-author");
      expect(s.firstTimerVersion).toBe(7);
    }
    for (const num of [1211, 1212]) {
      const saved = secondRun.finalCache.find((e) => e.Number === num);
      expect(saved?.Type === "sample" && saved.ReadyAt).toBe("2026-11-15T00:00:00.000Z");
      expect(saved?.Type === "sample" && saved.ReadyDays).toBe(2);
      expect(saved?.Type === "sample" && saved.FirstTimerVersion).toBe(7);
    }
  });

  it("走査窓外の v3/v4 キャッシュはタイムライン未検証のまま v5 へ昇格させず、候補内のものはタイムライン再取得で v5 へ修復する", async () => {
    const initialCache: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 449315,
        Title: "New package: FirstTimer",
        CreatedAt: "2026-10-09T04:14:06Z",
        LatestCommittedDate: "2026-10-09T04:13:31.000Z",
        CommitCount: 2,
        ReadyAt: "2026-10-09T05:06:26.000Z",
        MergedAt: "2026-11-16T15:59:28.000Z",
        TotalDays: 38.49,
        TurnDays: 38.49,
        ReadyDays: 38.45,
        Author: "tamakichi23",
        IsFirstTimer: false,
        FirstTimerReason: "timeline-blocking",
        FirstTimerVersion: 3,
      },
      // 走査窓外の古いキャッシュ（candidates に含まれない）は窓外で勝手に昇格させない
      {
        Type: "sample",
        Number: 411138,
        Title: "Older FirstTimer",
        CreatedAt: "2026-06-01T00:00:00Z",
        LatestCommittedDate: "2026-06-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-06-02T00:00:00Z",
        MergedAt: "2026-07-01T00:00:00Z",
        TotalDays: 30,
        TurnDays: 30,
        ReadyDays: 29,
        Author: "older-first-timer",
        IsFirstTimer: false,
        FirstTimerReason: "timeline-blocking",
        FirstTimerVersion: 3,
      },
    ];

    let sampleDataCalled = 0;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        sampleDataCalled++;
        return {
          createdAt: "2026-10-09T04:14:06Z",
          commitCount: 2,
          latestCommittedDate: "2026-10-09T04:13:31.000Z",
          author: "tamakichi23",
          timeline: createTimeline("2026-10-09T05:06:26.000Z"),
        };
      },
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    };

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(449315, "2026-11-16T15:59:28.000Z", "tamakichi23")],
      overallSinceDate: new Date("2026-10-18T00:00:00Z"),
      fetchBudget: 10,
      initialCache,
    });

    expect(sampleDataCalled).toBe(1);
    expect(result.fetchedCount).toBe(1);
    expect(result.cacheModified).toBeTrue();

    const s449315 = result.samples.find((s) => s.number === 449315);
    expect(s449315?.isFirstTimer).toBeTrue();
    expect(s449315?.firstTimerReason).toBeUndefined();
    expect(s449315?.firstTimerVersion).toBe(7);

    const c411138 = result.finalCache.find((e) => e.Number === 411138);
    expect(c411138?.Type === "sample" && c411138.FirstTimerVersion).toBe(3);
  });

  it("走査窓外の v2 timeline-blocking（Waived-* による ReadyAt 未修正）は窓外処理で v4 へ昇格させず、候補復帰時にタイムライン再取得で正しい ReadyDays と初回判定へ修復する", async () => {
    const v2LegacyCache: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 1102,
        Title: "PR #1102",
        CreatedAt: "2026-10-01T00:00:00Z",
        LatestCommittedDate: "2026-10-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-10-04T00:00:00.000Z",
        MergedAt: "2026-10-05T00:00:00.000Z",
        TotalDays: 4,
        TurnDays: 4,
        ReadyDays: 1,
        Author: "waived-temp-user",
        IsFirstTimer: false,
        FirstTimerReason: "timeline-blocking",
        FirstTimerVersion: 2,
      },
    ];

    let sampleDataCalled = 0;
    let graphqlCalled = 0;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        sampleDataCalled++;
        return {
          createdAt: "2026-10-01T00:00:00Z",
          commitCount: 1,
          latestCommittedDate: "2026-10-01T00:00:00Z",
          author: "waived-temp-user",
          timeline: [
            {
              event: "labeled",
              created_at: "2026-10-01T00:00:00Z",
              label: { name: "New-Package" },
            },
            {
              event: "labeled",
              created_at: "2026-10-01T00:00:00Z",
              label: { name: "Azure-Pipeline-Passed" },
            },
            {
              event: "labeled",
              created_at: "2026-10-01T00:00:00Z",
              label: { name: "Validation-Completed" },
            },
            {
              event: "labeled",
              created_at: "2026-10-02T00:00:00Z",
              label: { name: "Waived-Validation-Defender-Error" },
            },
            {
              event: "unlabeled",
              created_at: "2026-10-04T00:00:00Z",
              label: { name: "Waived-Validation-Defender-Error" },
            },
          ],
        };
      },
      graphql: async <T = unknown>() => {
        graphqlCalled++;
        return { u_0: { issueCount: 1 } } as T;
      },
    };

    // 第 1 段階: 走査窓外（candidates: []）では v2 のまま保持され、v4 へ早まって昇格しない
    const outsideResult = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [],
      overallSinceDate: new Date("2026-10-10T00:00:00Z"),
      fetchBudget: 5,
      initialCache: v2LegacyCache,
    });

    expect(sampleDataCalled).toBe(0);
    expect(graphqlCalled).toBe(0);
    expect(outsideResult.cacheModified).toBeFalse();
    const kept1102 = outsideResult.finalCache.find((e) => e.Number === 1102);
    expect(kept1102?.Type === "sample" && kept1102.FirstTimerVersion).toBe(2);
    expect(kept1102?.Type === "sample" && kept1102.ReadyDays).toBe(1);
    expect(kept1102?.Type === "sample" && kept1102.FirstTimerReason).toBe("timeline-blocking");

    // 第 2 段階: 候補へ復帰するとタイムライン再取得が行われ、ReadyDays=4 かつ IsFirstTimer=true (v4) へ修復される
    const restoredResult = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(1102, "2026-10-05T00:00:00.000Z", "waived-temp-user")],
      overallSinceDate: new Date("2026-09-01T00:00:00Z"),
      fetchBudget: 5,
      initialCache: outsideResult.finalCache,
    });

    expect(sampleDataCalled).toBe(1);
    expect(graphqlCalled).toBe(1);
    expect(restoredResult.fetchedCount).toBe(1);
    expect(restoredResult.samples[0]?.readyAt).toBe("2026-10-01T00:00:00.000Z");
    expect(restoredResult.samples[0]?.days).toBe(4);
    expect(restoredResult.samples[0]?.isFirstTimer).toBeTrue();
    expect(restoredResult.samples[0]?.firstTimerReason).toBeUndefined();
    expect(restoredResult.samples[0]?.firstTimerVersion).toBe(7);
  });

  it("特権ロール (MEMBER/OWNER/COLLABORATOR) と Bot は累計マージ照会を行わず privileged-or-bot (v6) で除外し、CONTRIBUTOR は許容する", async () => {
    const capturedQueries: string[] = [];
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async (_repo, num) => {
        const meta: Record<
          number,
          { author: string; authorType: string; authorAssociation: string }
        > = {
          1301: { author: "asklar", authorType: "User", authorAssociation: "MEMBER" },
          1302: { author: "collab-dev", authorType: "User", authorAssociation: "COLLABORATOR" },
          1303: { author: "auto-app", authorType: "Bot", authorAssociation: "NONE" },
          1304: { author: "normal-user", authorType: "User", authorAssociation: "CONTRIBUTOR" },
        };
        const m = meta[num];
        return {
          createdAt: "2026-11-01T00:00:00Z",
          commitCount: 1,
          latestCommittedDate: "2026-11-01T00:00:00Z",
          author: m.author,
          authorType: m.authorType,
          authorAssociation: m.authorAssociation,
          timeline: createTimeline("2026-11-01T01:00:00Z"),
        };
      },
      graphql: async <T = unknown>(query: string) => {
        capturedQueries.push(query);
        return { u_0: { issueCount: 1 } } as T;
      },
    };

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [
        createSearchItem(1301, "2026-11-05T00:00:00Z", "asklar"),
        createSearchItem(1302, "2026-11-05T00:00:00Z", "collab-dev"),
        createSearchItem(1303, "2026-11-05T00:00:00Z", "auto-app"),
        createSearchItem(1304, "2026-11-05T00:00:00Z", "normal-user"),
      ],
      overallSinceDate: new Date("2026-10-18T00:00:00Z"),
      fetchBudget: 10,
      initialCache: [],
    });

    // 特権ロール・Bot の 3 件は累計マージ照会に回らず、normal-user のみ照会される
    expect(capturedQueries).toHaveLength(1);
    expect(capturedQueries[0]).toContain("author:normal-user");
    expect(capturedQueries[0]).not.toContain("author:asklar");

    for (const num of [1301, 1302, 1303]) {
      const s = result.samples.find((item) => item.number === num);
      expect(s?.isFirstTimer).toBeFalse();
      expect(s?.firstTimerReason).toBe("privileged-or-bot");
      expect(s?.firstTimerVersion).toBe(7);
      const cached = result.finalCache.find((e) => e.Number === num);
      expect(cached?.Type === "sample" && cached.FirstTimerReason).toBe("privileged-or-bot");
      expect(cached?.Type === "sample" && cached.FirstTimerVersion).toBe(7);
    }

    const normal = result.samples.find((item) => item.number === 1304);
    expect(normal?.isFirstTimer).toBeTrue();
    expect(normal?.authorAssociation).toBe("CONTRIBUTOR");
    expect(normal?.firstTimerVersion).toBe(7);
  });

  it("旧 FirstTimerVersion: 6 キャッシュ（Needs-Attention 等の一時付与を見落とした ReadyAt）を再取得して解除後の ReadyAt と v7 へ修復する（レビュー指摘回帰テスト）", async () => {
    let fetched = 0;
    const client: SampleCollectorClient = {
      getPullRequestSampleData: async () => {
        fetched++;
        return {
          createdAt: "2026-11-01T00:00:00Z",
          commitCount: 1,
          latestCommittedDate: "2026-11-01T00:00:00Z",
          author: "v6-user",
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
              label: { name: "Needs-Attention" },
            },
            {
              event: "labeled",
              created_at: "2026-11-01T01:00:00Z",
              label: { name: "Validation-Completed" },
            },
            {
              event: "unlabeled",
              created_at: "2026-11-09T00:00:00Z",
              label: { name: "Needs-Attention" },
            },
          ],
        };
      },
      graphql: async <T = unknown>() => ({ u_0: { issueCount: 1 } }) as T,
    };

    const v6Cache: SampleCacheEntry[] = [
      {
        Type: "sample",
        Number: 1401,
        Title: "PR #1401",
        CreatedAt: "2026-11-01T00:00:00Z",
        LatestCommittedDate: "2026-11-01T00:00:00Z",
        CommitCount: 1,
        ReadyAt: "2026-11-01T01:00:00.000Z",
        MergedAt: "2026-11-10T00:00:00.000Z",
        TotalDays: 9,
        TurnDays: 9,
        ReadyDays: 8.96,
        Author: "v6-user",
        AuthorType: "User",
        AuthorAssociation: "CONTRIBUTOR",
        IsFirstTimer: true,
        FirstTimerVersion: 6,
      },
    ];

    const result = await orchestrateSampleCollection({
      client,
      repository: "microsoft/winget-pkgs",
      candidates: [createSearchItem(1401, "2026-11-10T00:00:00.000Z", "v6-user")],
      overallSinceDate: new Date("2026-10-18T00:00:00Z"),
      fetchBudget: 10,
      initialCache: v6Cache,
    });

    expect(fetched).toBe(1);
    expect(result.fetchedCount).toBe(1);
    expect(result.samples[0]?.readyAt).toBe("2026-11-09T00:00:00.000Z");
    expect(result.samples[0]?.days).toBe(1);
    expect(result.samples[0]?.firstTimerVersion).toBe(7);
    const saved = result.finalCache.find((e) => e.Number === 1401);
    expect(saved?.Type === "sample" && saved.ReadyAt).toBe("2026-11-09T00:00:00.000Z");
    expect(saved?.Type === "sample" && saved.FirstTimerVersion).toBe(7);
  });
});

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
});
