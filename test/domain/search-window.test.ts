import { describe, expect, it } from "bun:test";
import {
  type CandidateSearchClient,
  collectMergedCandidates,
} from "../../src/domain/search-window";
import type {
  GitHubDetailedSearchItem,
  GitHubDetailedSearchResult,
} from "../../src/models/progress";

describe("collectMergedCandidates（カーソルスライド方式）", () => {
  const createMockItem = (
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
    author_association: "NONE",
    commitCount: 1,
    is_draft: false,
    pull_request: {
      merged_at: mergedAt,
    },
    labels: [{ name: "New-Package" }],
  });

  it("1,000件未満の場合は単一窓のページネーションのみで全件収集する", async () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const until = new Date("2026-11-01T00:00:00Z");
    const queries: string[] = [];

    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (
        query,
        _sort,
        _order,
        _perPage,
        page,
      ): Promise<GitHubDetailedSearchResult> => {
        queries.push(query);
        if (page === 1) {
          return {
            totalCount: 3,
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            items: [
              createMockItem(103, "2026-10-25T00:00:00Z"),
              createMockItem(102, "2026-10-20T00:00:00Z"),
            ],
          };
        }
        return {
          totalCount: 3,
          pageInfo: { hasNextPage: false, endCursor: null },
          items: [createMockItem(101, "2026-10-05T00:00:00Z")],
        };
      },
    };

    const results = await collectMergedCandidates({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      since,
      until,
      targetPr: 999,
      requiredLabels: ["New-Package"],
      fetchLimit: 100,
    });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.number)).toEqual([103, 102, 101]);
    expect(queries).toHaveLength(2);
    // 単一窓なのでクエリの日付範囲は不変
    expect(queries[0]).toContain(`merged:${since.toISOString()}..${until.toISOString()}`);
    expect(queries[1]).toContain(`merged:${since.toISOString()}..${until.toISOString()}`);
  });

  it("検索順（更新日時）とマージ日時が逆転していても、窓分割により未走査候補が欠落せず全件走査される（指摘1回帰テスト）", async () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const until = new Date("2026-10-31T00:00:00Z");
    const mid = new Date(Math.floor((since.getTime() + until.getTime()) / 2));

    // 全期間（since..until）は 1,001 件。
    // そのうち、PR 1 は 10-02 マージ（古い）だが更新日時が最新（10-30）。
    // PR 2 は 10-25 マージ（新しい）だが更新日時が古い（10-05）。
    // 旧スライド方式だと PR 1 のマージ日時に飛んで PR 2 が欠落するが、
    // 動的二分方式なら時間範囲で分割されるため漏れなく走査される。
    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (
        query,
        _sort,
        _order,
        _perPage,
        _page = 1,
      ): Promise<GitHubDetailedSearchResult> => {
        if (
          query.includes(`..${until.toISOString()}`) &&
          query.includes(`${since.toISOString()}..`)
        ) {
          // 全期間は 1,001 件として二分を促す
          return {
            totalCount: 1001,
            pageInfo: { hasNextPage: true, endCursor: "c1" },
            items: [],
          };
        }

        if (
          query.includes(`..${until.toISOString()}`) &&
          query.includes(`${mid.toISOString()}..`)
        ) {
          // 後半（新しい期間 mid..until）: PR 2 (10-25 マージ)
          return {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            items: [createMockItem(2, "2026-10-25T00:00:00Z")],
          };
        }

        if (
          query.includes(`..${mid.toISOString()}`) &&
          query.includes(`${since.toISOString()}..`)
        ) {
          // 前半（古い期間 since..mid）: PR 1 (10-02 マージ)
          return {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            items: [createMockItem(1, "2026-10-02T00:00:00Z")],
          };
        }

        return { totalCount: 0, items: [] };
      },
    };

    const results = await collectMergedCandidates({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      since,
      until,
      targetPr: 9999,
      requiredLabels: ["New-Package"],
      fetchLimit: 5000,
      pageSize: 100,
      maxPagesPerWindow: 10,
    });

    // PR 2 と PR 1 の両方が欠落せず収集されていること
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.number)).toEqual([2, 1]);
  });

  it("fetchLimit が 1 や 100 の倍数でない場合でも、ページ内の超過アイテムを追加せず厳格に上限を守る（指摘2回帰テスト）", async () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const until = new Date("2026-11-01T00:00:00Z");

    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (): Promise<GitHubDetailedSearchResult> => {
        // 1 ページで 100 件のアイテムを返す
        const items = Array.from({ length: 100 }, (_, i) =>
          createMockItem(i + 1, "2026-10-15T00:00:00Z"),
        );
        return {
          totalCount: 100,
          pageInfo: { hasNextPage: false, endCursor: null },
          items,
        };
      },
    };

    // fetchLimit: 1 の場合、厳密に 1 件のみ返ること
    const results1 = await collectMergedCandidates({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      since,
      until,
      targetPr: 999,
      requiredLabels: ["New-Package"],
      fetchLimit: 1,
    });
    expect(results1).toHaveLength(1);

    // fetchLimit: 25 の場合、厳密に 25 件のみ返ること
    const results25 = await collectMergedCandidates({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      since,
      until,
      targetPr: 999,
      requiredLabels: ["New-Package"],
      fetchLimit: 25,
    });
    expect(results25).toHaveLength(25);
  });

  it("ちょうど 1,000 件で hasNextPage: false の場合、例外を投げず全 1,000 件を正常に収集して完了する（指摘3回帰テスト）", async () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const until = new Date("2026-11-01T00:00:00Z");
    const fixedMergedAt = "2026-10-15T12:00:00.000Z";

    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (
        _query,
        _sort,
        _order,
        _perPage,
        page = 1,
      ): Promise<GitHubDetailedSearchResult> => {
        // 10 ページ各 100 件で計 1,000 件
        const items = Array.from({ length: 100 }, (_, i) =>
          createMockItem((page - 1) * 100 + i + 1, fixedMergedAt),
        );
        return {
          totalCount: 1000,
          pageInfo: {
            hasNextPage: page < 10,
            endCursor: page < 10 ? `c${page}` : null,
          },
          items,
        };
      },
    };

    const results = await collectMergedCandidates({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      since,
      until,
      targetPr: 9999,
      requiredLabels: ["New-Package"],
      fetchLimit: 5000,
      pageSize: 100,
      maxPagesPerWindow: 10,
    });

    expect(results).toHaveLength(1000);
  });

  it("最小時間幅（1秒以下）でも 1,000 件を超過している分割不能な極限状態では安全に例外をスローする", async () => {
    const since = new Date("2026-10-10T12:00:00.000Z");
    const until = new Date("2026-10-10T12:00:00.500Z"); // 500ms 幅

    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (): Promise<GitHubDetailedSearchResult> => ({
        totalCount: 1200,
        pageInfo: { hasNextPage: true, endCursor: "c1" },
        items: [],
      }),
    };

    await expect(
      collectMergedCandidates({
        client: mockClient,
        repository: "microsoft/winget-pkgs",
        since,
        until,
        targetPr: 999,
        requiredLabels: ["New-Package"],
        pageSize: 100,
        maxPagesPerWindow: 10,
      }),
    ).rejects.toThrow("これ以上分割できないため安全に全件走査できません");
  });

  it("targetPr や since より古い PR は除外される", async () => {
    const since = new Date("2026-10-05T00:00:00Z");
    const until = new Date("2026-10-10T00:00:00Z");

    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (): Promise<GitHubDetailedSearchResult> => ({
        totalCount: 3,
        pageInfo: { hasNextPage: false, endCursor: null },
        items: [
          createMockItem(401, "2026-10-08T00:00:00Z"),
          createMockItem(999, "2026-10-07T00:00:00Z"), // targetPr
          createMockItem(402, "2026-10-01T00:00:00Z"), // sinceより古い
        ],
      }),
    };

    const results = await collectMergedCandidates({
      client: mockClient,
      repository: "microsoft/winget-pkgs",
      since,
      until,
      targetPr: 999,
      requiredLabels: ["New-Package"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].number).toBe(401);
  });
});
