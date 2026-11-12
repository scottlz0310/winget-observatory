import { describe, expect, test } from "bun:test";
import { diffPrDetails, diffSearchResults, diffTimelines } from "../../src/domain/compare-api";
import type { SearchResultComparison } from "../../src/models/api-compare";
import type { ProgressPrDetail, ProgressTimelineEvent } from "../../src/models/progress";

describe("Domain: compare-api", () => {
  describe("diffSearchResults", () => {
    test("完全一致する場合は差分なしで判定される", () => {
      const result: SearchResultComparison = {
        totalCount: 2,
        items: [
          {
            number: 10,
            title: "PR 10",
            html_url: "url/10",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            labels: [{ name: "A" }],
            is_draft: false,
          },
          {
            number: 20,
            title: "PR 20",
            html_url: "url/20",
            created_at: "2026-10-02T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
            labels: [],
            is_draft: true,
          },
        ],
      };

      const diff = diffSearchResults(result, result);
      expect(diff.totalCountMatch).toBeTrue();
      expect(diff.countDiff).toBe(0);
      expect(diff.itemCountMatch).toBeTrue();
      expect(diff.orderMatch).toBeTrue();
      expect(diff.missingInGraphql).toEqual([]);
      expect(diff.missingInRest).toEqual([]);
      expect(diff.fieldDiffs).toEqual([]);
    });

    test("件数不一致・アイテム欠落・フィールド差分を正しく検知する", () => {
      const rest: SearchResultComparison = {
        totalCount: 100,
        items: [
          {
            number: 1,
            title: "Old Title",
            html_url: "url/1",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            labels: [{ name: "A" }],
            is_draft: false,
          },
          {
            number: 2,
            title: "PR 2",
            html_url: "url/2",
            created_at: "2026-10-02T00:00:00Z",
            updated_at: "2026-10-02T00:00:00Z",
          },
        ],
      };

      const graphql: SearchResultComparison = {
        totalCount: 105,
        items: [
          {
            number: 1,
            title: "New Title", // 差分
            html_url: "url/1",
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
            labels: [{ name: "B" }], // 差分
            is_draft: false,
          },
          {
            number: 3, // 差分（2がなく3がある）
            title: "PR 3",
            html_url: "url/3",
            created_at: "2026-10-03T00:00:00Z",
            updated_at: "2026-10-03T00:00:00Z",
          },
        ],
      };

      const diff = diffSearchResults(rest, graphql);
      expect(diff.totalCountMatch).toBeFalse();
      expect(diff.countDiff).toBe(5);
      expect(diff.orderMatch).toBeFalse();
      expect(diff.missingInGraphql).toEqual([2]);
      expect(diff.missingInRest).toEqual([3]);
      expect(diff.fieldDiffs.length).toBe(1);
      expect(diff.fieldDiffs[0].number).toBe(1);
      expect(diff.fieldDiffs[0].diffs.map((d) => d.field)).toEqual(["title", "labels"]);
    });
  });

  describe("diffPrDetails", () => {
    test("完全一致する PR 詳細を一致と判定する", () => {
      const detail: ProgressPrDetail = {
        number: 123,
        title: "Test PR",
        url: "url/123",
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels: ["Package"],
        commits: [{ oid: "abc", messageHeadline: "feat", committedDate: "2026-10-01T00:00:00Z" }],
        author: "alice",
        authorAssociation: "NONE",
      };

      const diff = diffPrDetails(detail, detail);
      expect(diff.match).toBeTrue();
      expect(diff.diffs).toEqual([]);
    });

    test("フィールドやコミットの不一致を検知する", () => {
      const rest: ProgressPrDetail = {
        number: 123,
        title: "Test PR",
        url: "url/123",
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels: ["A"],
        commits: [{ oid: "abc", messageHeadline: "feat", committedDate: "2026-10-01T00:00:00Z" }],
        author: "alice",
        authorAssociation: "NONE",
      };

      const graphql: ProgressPrDetail = {
        ...rest,
        authorAssociation: "CONTRIBUTOR", // 差分
        labels: ["B"], // 差分
        commits: [{ oid: "def", messageHeadline: "feat", committedDate: "2026-10-01T00:00:00Z" }], // 差分
      };

      const diff = diffPrDetails(rest, graphql);
      expect(diff.match).toBeFalse();
      expect(diff.diffs.map((d) => d.field)).toEqual(["authorAssociation", "labels", "commits[0]"]);
    });
  });

  describe("diffTimelines", () => {
    test("タイムラインが一致し判定結果も一致することを検証する", () => {
      const events: ProgressTimelineEvent[] = [
        { event: "labeled", created_at: "2026-10-01T10:00:00Z", label: { name: "New-Package" } },
        {
          event: "labeled",
          created_at: "2026-10-01T11:00:00Z",
          label: { name: "Azure-Pipeline-Passed" },
        },
        {
          event: "labeled",
          created_at: "2026-10-01T12:00:00Z",
          label: { name: "Validation-Completed" },
        },
      ];

      const diff = diffTimelines(events, events, false, new Date("2026-10-10T00:00:00Z"));
      expect(diff.countMatch).toBeTrue();
      expect(diff.eventSequenceMatch).toBeTrue();
      expect(diff.blockingHistoryMatch).toBeTrue();
      expect(diff.readySinceMatch).toBeTrue();
      expect(diff.restHasBlocking).toBeFalse();
      expect(diff.graphqlHasBlocking).toBeFalse();
      expect(diff.diffs).toEqual([]);
    });

    test("阻害イベントの有無や日付の不一致を検知する", () => {
      const restEvents: ProgressTimelineEvent[] = [
        { event: "labeled", created_at: "2026-10-01T10:00:00Z", label: { name: "New-Package" } },
      ];
      const graphqlEvents: ProgressTimelineEvent[] = [
        {
          event: "labeled",
          created_at: "2026-10-01T10:00:00Z",
          label: { name: "Error-TestFailure" }, // 阻害ラベル
        },
      ];

      const diff = diffTimelines(
        restEvents,
        graphqlEvents,
        false,
        new Date("2026-10-10T00:00:00Z"),
      );
      expect(diff.blockingHistoryMatch).toBeFalse();
      expect(diff.restHasBlocking).toBeFalse();
      expect(diff.graphqlHasBlocking).toBeTrue();
      expect(diff.eventSequenceMatch).toBeFalse();
    });
  });
});
