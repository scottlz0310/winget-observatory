import { describe, expect, test } from "bun:test";
import {
  adaptGraphQLRateLimitBucket,
  adaptGraphQLTimelineItem,
  adaptGraphQLTimelineItems,
  adaptGraphQLToDetailedSearchItem,
  adaptGraphQLToDetailedSearchResult,
  adaptGraphQLToPrDetail,
  adaptGraphQLToPrView,
  adaptGraphQLToSearchItem,
  buildGraphQLSearchQuery,
} from "../../src/api/graphql-adapters";
import type {
  GraphQLPullRequestNode,
  GraphQLRateLimitData,
  GraphQLSearchConnection,
  GraphQLTimelineItemNode,
} from "../../src/api/graphql-types";
import { hasBlockingOrDraftHistory } from "../../src/domain/first-timer";
import { simulateReadySince } from "../../src/domain/progress";

describe("GraphQL Adapters", () => {
  describe("adaptGraphQLToSearchItem", () => {
    test("通常の PullRequest ノードを GitHubSearchItem に変換できる", () => {
      const node: GraphQLPullRequestNode = {
        number: 12345,
        title: "Test Package 1.0.0",
        url: "https://github.com/microsoft/winget-pkgs/pull/12345",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-02T12:00:00Z",
        author: { login: "testuser" },
        authorAssociation: "NONE",
      };

      const result = adaptGraphQLToSearchItem(node);
      expect(result).toEqual({
        number: 12345,
        title: "Test Package 1.0.0",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/12345",
        created_at: "2026-10-01T10:00:00Z",
        updated_at: "2026-10-02T12:00:00Z",
        author: "testuser",
        author_association: "NONE",
      });
    });

    test("author や authorAssociation が欠落している場合も安全にフォールバックする", () => {
      const node: GraphQLPullRequestNode = {
        number: 12346,
        title: "Ghost User PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/12346",
        createdAt: "2026-10-01T10:00:00Z",
        updatedAt: "2026-10-02T12:00:00Z",
        author: null,
        authorAssociation: null,
      };

      const result = adaptGraphQLToSearchItem(node);
      expect(result.author).toBeUndefined();
      expect(result.author_association).toBeUndefined();
    });
  });

  describe("adaptGraphQLToDetailedSearchItem", () => {
    test("ラベル、ドラフト状態、マージ日時を含むノードを変換できる", () => {
      const node: GraphQLPullRequestNode = {
        number: 100,
        title: "Detailed PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/100",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-05T00:00:00Z",
        isDraft: false,
        mergedAt: "2026-10-05T12:00:00Z",
        labels: {
          nodes: [{ name: "Area-Package" }, { name: "Validation-Passed" }],
        },
      };

      const result = adaptGraphQLToDetailedSearchItem(node);
      expect(result).toEqual({
        number: 100,
        title: "Detailed PR",
        html_url: "https://github.com/microsoft/winget-pkgs/pull/100",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-05T00:00:00Z",
        labels: [{ name: "Area-Package" }, { name: "Validation-Passed" }],
        is_draft: false,
        pull_request: {
          merged_at: "2026-10-05T12:00:00Z",
        },
      });
    });

    test("未マージの PR は pull_request.merged_at が null になる", () => {
      const node: GraphQLPullRequestNode = {
        number: 101,
        title: "Open PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/101",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        isDraft: true,
        mergedAt: null,
      };

      const result = adaptGraphQLToDetailedSearchItem(node);
      expect(result.is_draft).toBeTrue();
      expect(result.pull_request?.merged_at).toBeNull();
      expect(result.labels).toEqual([]);
    });
  });

  describe("adaptGraphQLToDetailedSearchResult", () => {
    test("コネクション全体の件数とアイテム配列を変換できる", () => {
      const connection: GraphQLSearchConnection = {
        issueCount: 42,
        nodes: [
          {
            number: 1,
            title: "PR 1",
            url: "https://github.com/repo/pull/1",
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
          },
          {
            number: 2,
            title: "PR 2",
            url: "https://github.com/repo/pull/2",
            createdAt: "2026-10-02T00:00:00Z",
            updatedAt: "2026-10-02T00:00:00Z",
          },
        ],
      };

      const result = adaptGraphQLToDetailedSearchResult(connection);
      expect(result.totalCount).toBe(42);
      expect(result.items.length).toBe(2);
      expect(result.items[0].number).toBe(1);
      expect(result.items[1].number).toBe(2);
    });

    test("nodes が空または未定義の場合も安全に動作する", () => {
      const result = adaptGraphQLToDetailedSearchResult({ issueCount: 0 });
      expect(result.totalCount).toBe(0);
      expect(result.items).toEqual([]);
    });
  });

  describe("adaptGraphQLToPrView", () => {
    test("基本フィールドを GitHubPrView に変換できる", () => {
      const node: GraphQLPullRequestNode = {
        number: 200,
        title: "View PR",
        url: "https://github.com/repo/pull/200",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
      };

      const result = adaptGraphQLToPrView(node);
      expect(result).toEqual({
        number: 200,
        title: "View PR",
        url: "https://github.com/repo/pull/200",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
      });
    });
  });

  describe("adaptGraphQLToPrDetail", () => {
    test("コミット履歴や作者情報を含む完全な PR 詳細を ProgressPrDetail に変換できる", () => {
      const node: GraphQLPullRequestNode = {
        number: 300,
        title: "Full Detail PR",
        url: "https://github.com/repo/pull/300",
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-03T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        author: { login: "alice" },
        authorAssociation: "CONTRIBUTOR",
        labels: {
          nodes: [{ name: "Automated-Merge" }],
        },
        commits: {
          nodes: [
            {
              commit: {
                oid: "abc1234",
                messageHeadline: "feat: add package",
                committedDate: "2026-10-01T00:00:00Z",
              },
            },
            {
              commit: {
                oid: "def5678",
                messageHeadline: "fix: update url",
                committedDate: "2026-10-02T00:00:00Z",
              },
            },
          ],
        },
      };

      const result = adaptGraphQLToPrDetail(node);
      expect(result).toEqual({
        number: 300,
        title: "Full Detail PR",
        url: "https://github.com/repo/pull/300",
        state: "OPEN",
        isDraft: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-03T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        labels: ["Automated-Merge"],
        commits: [
          {
            oid: "abc1234",
            messageHeadline: "feat: add package",
            committedDate: "2026-10-01T00:00:00Z",
          },
          {
            oid: "def5678",
            messageHeadline: "fix: update url",
            committedDate: "2026-10-02T00:00:00Z",
          },
        ],
        author: "alice",
        authorAssociation: "CONTRIBUTOR",
      });
    });

    test("mergedAt が存在する場合、state は MERGED に正規化される", () => {
      const node: GraphQLPullRequestNode = {
        number: 301,
        title: "Merged PR",
        url: "https://github.com/repo/pull/301",
        state: "CLOSED",
        isDraft: false,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-03T00:00:00Z",
        mergedAt: "2026-10-03T12:00:00Z",
      };

      const result = adaptGraphQLToPrDetail(node);
      expect(result.state).toBe("MERGED");
      expect(result.mergedAt).toBe("2026-10-03T12:00:00Z");
    });
  });

  describe("adaptGraphQLTimelineItem & adaptGraphQLTimelineItems", () => {
    test("adaptGraphQLTimelineItem は単一イベントを変換し、対象外や不完全な入力では null を返す", () => {
      const valid = adaptGraphQLTimelineItem({
        __typename: "LabeledEvent",
        createdAt: "2026-10-01T10:00:00Z",
        label: { name: "New-Package" },
      });
      expect(valid).toEqual({
        event: "labeled",
        created_at: "2026-10-01T10:00:00Z",
        label: { name: "New-Package" },
      });

      expect(
        adaptGraphQLTimelineItem({ __typename: "UnknownEvent", createdAt: "2026-10-01T00:00:00Z" }),
      ).toBeNull();
      expect(
        adaptGraphQLTimelineItem({
          __typename: "LabeledEvent",
        } as unknown as GraphQLTimelineItemNode),
      ).toBeNull();
    });

    test("主要なタイムラインイベントを既存の ProgressTimelineEvent 形式に変換できる", () => {
      const items: GraphQLTimelineItemNode[] = [
        {
          __typename: "LabeledEvent",
          createdAt: "2026-10-01T10:00:00Z",
          label: { name: "Needs-Author-Feedback" },
        },
        {
          __typename: "UnlabeledEvent",
          createdAt: "2026-10-02T10:00:00Z",
          label: { name: "Needs-Author-Feedback" },
        },
        {
          __typename: "ConvertedToDraftEvent",
          createdAt: "2026-10-03T10:00:00Z",
        },
        {
          __typename: "ReadyForReviewEvent",
          createdAt: "2026-10-04T10:00:00Z",
        },
        {
          __typename: "IssueComment",
          createdAt: "2026-10-05T10:00:00Z",
        },
      ];

      const results = adaptGraphQLTimelineItems(items);
      expect(results.length).toBe(4); // IssueComment は除外
      expect(results).toEqual([
        {
          event: "labeled",
          created_at: "2026-10-01T10:00:00Z",
          label: { name: "Needs-Author-Feedback" },
        },
        {
          event: "unlabeled",
          created_at: "2026-10-02T10:00:00Z",
          label: { name: "Needs-Author-Feedback" },
        },
        {
          event: "converted_to_draft",
          created_at: "2026-10-03T10:00:00Z",
        },
        {
          event: "ready_for_review",
          created_at: "2026-10-04T10:00:00Z",
        },
      ]);
    });

    test("変換後のイベント列が hasBlockingOrDraftHistory で正しく判定される", () => {
      const healthyItems: GraphQLTimelineItemNode[] = [
        {
          __typename: "LabeledEvent",
          createdAt: "2026-10-01T10:00:00Z",
          label: { name: "Area-Package" },
        },
      ];
      const healthyAdapted = adaptGraphQLTimelineItems(healthyItems);
      expect(hasBlockingOrDraftHistory(healthyAdapted, false)).toBeFalse();

      const blockedItems: GraphQLTimelineItemNode[] = [
        {
          __typename: "LabeledEvent",
          createdAt: "2026-10-01T10:00:00Z",
          label: { name: "Error-TestFailure" },
        },
      ];
      const blockedAdapted = adaptGraphQLTimelineItems(blockedItems);
      expect(hasBlockingOrDraftHistory(blockedAdapted, false)).toBeTrue();

      const draftItems: GraphQLTimelineItemNode[] = [
        {
          __typename: "ReadyForReviewEvent",
          createdAt: "2026-10-02T10:00:00Z",
        },
      ];
      const draftAdapted = adaptGraphQLTimelineItems(draftItems);
      expect(hasBlockingOrDraftHistory(draftAdapted, false)).toBeTrue();
    });

    test("変換後のイベント列が simulateReadySince で正しくシミュレートされる", () => {
      const items: GraphQLTimelineItemNode[] = [
        {
          __typename: "LabeledEvent",
          createdAt: "2026-10-01T10:00:00Z",
          label: { name: "New-Package" },
        },
        {
          __typename: "LabeledEvent",
          createdAt: "2026-10-01T11:00:00Z",
          label: { name: "Azure-Pipeline-Passed" },
        },
        {
          __typename: "LabeledEvent",
          createdAt: "2026-10-01T12:00:00Z",
          label: { name: "Validation-Completed" },
        },
      ];
      const adapted = adaptGraphQLTimelineItems(items);
      const readySince = simulateReadySince(adapted, false, new Date("2026-10-10T00:00:00Z"));
      expect(readySince?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    });
  });

  describe("adaptGraphQLRateLimitBucket", () => {
    test("GraphQL の rateLimit オブジェクトを GitHubRateLimitBucket に変換できる", () => {
      const data: GraphQLRateLimitData = {
        limit: 5000,
        cost: 1,
        remaining: 4990,
        resetAt: "2026-10-01T12:00:00Z",
      };

      const result = adaptGraphQLRateLimitBucket(data);
      expect(result).toEqual({
        limit: 5000,
        remaining: 4990,
        resetAt: "2026-10-01T12:00:00.000Z",
      });
    });
  });

  describe("buildGraphQLSearchQuery", () => {
    test("sort と order を付加できる", () => {
      expect(buildGraphQLSearchQuery("is:pr is:open", "created", "asc")).toBe(
        "is:pr is:open sort:created-asc",
      );
      expect(buildGraphQLSearchQuery("is:pr is:open", "updated", "desc")).toBe(
        "is:pr is:open sort:updated-desc",
      );
    });

    test("sort が未指定の場合はクエリをそのまま返す", () => {
      expect(buildGraphQLSearchQuery("is:pr is:open")).toBe("is:pr is:open");
    });

    test("既に sort: が含まれている場合は二重付与しない", () => {
      expect(buildGraphQLSearchQuery("is:pr sort:created-asc", "updated", "desc")).toBe(
        "is:pr sort:created-asc",
      );
    });

    test("order 省略時は asc が既定となる", () => {
      expect(buildGraphQLSearchQuery("is:pr", "created")).toBe("is:pr sort:created-asc");
    });
  });
});
