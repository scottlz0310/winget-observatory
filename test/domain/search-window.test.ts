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

  it("上限（10ページ/1,000件）到達時に最古mergedAtへ窓をスライドして過去へ前進する", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const until = new Date("2026-11-01T00:00:00Z");
    const queries: string[] = [];

    // テスト用に maxPagesPerWindow = 2, pageSize = 2 とし、4件取得でスライドをシミュレート
    const slideDateIso = "2026-10-10T00:00:00.000Z";

    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (
        query,
        _sort,
        _order,
        _perPage,
        page,
      ): Promise<GitHubDetailedSearchResult> => {
        queries.push(query);

        if (query.includes(`..${until.toISOString()}`)) {
          // 窓1 (until 〜 slideDate)
          if (page === 1) {
            return {
              totalCount: 10,
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              items: [
                createMockItem(204, "2026-10-28T00:00:00Z"),
                createMockItem(203, "2026-10-20T00:00:00Z"),
              ],
            };
          }
          // 窓1 の最終ページ (maxPagesPerWindow = 2 到達、さらに続きあり)
          return {
            totalCount: 10,
            pageInfo: { hasNextPage: true, endCursor: "c2" },
            items: [
              createMockItem(202, "2026-10-15T00:00:00Z"),
              createMockItem(201, slideDateIso), // 最古
            ],
          };
        }

        // 窓2 (slideDate 〜 since)
        return {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: null },
          items: [
            createMockItem(201, slideDateIso), // 境界重複アイテム
            createMockItem(200, "2026-09-01T00:00:00Z"),
          ],
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
      pageSize: 2,
      maxPagesPerWindow: 2,
    });

    // 204, 203, 202, 201, 200 (201の重複が除去され5件)
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.number)).toEqual([204, 203, 202, 201, 200]);

    // 窓2 のクエリ上限がスライド位置（slideDateIso）になっていること
    expect(queries.some((q) => q.includes(`..${slideDateIso}`))).toBeTrue();
  });

  it("同一タイムスタンプで上限超過し前進不能な場合は安全に例外をスローする", async () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const until = new Date("2026-10-10T00:00:00Z");

    const mockClient: CandidateSearchClient = {
      searchIssuesDetailed: async (): Promise<GitHubDetailedSearchResult> => {
        // 全アイテムが until と同一時刻でマージされている
        return {
          totalCount: 1000,
          pageInfo: { hasNextPage: true, endCursor: "c1" },
          items: [
            createMockItem(301, until.toISOString()),
            createMockItem(302, until.toISOString()),
          ],
        };
      },
    };

    await expect(
      collectMergedCandidates({
        client: mockClient,
        repository: "microsoft/winget-pkgs",
        since,
        until,
        targetPr: 999,
        requiredLabels: ["New-Package"],
        pageSize: 2,
        maxPagesPerWindow: 1,
      }),
    ).rejects.toThrow("Search API の上限 1,000 件を超過しており");
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
