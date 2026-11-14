import type { GitHubPrView, GitHubSearchItem } from "../models/depths";
import type {
  GitHubDetailedSearchItem,
  GitHubDetailedSearchResult,
  ProgressCommitSummary,
  ProgressPrDetail,
  ProgressTimelineEvent,
} from "../models/progress";
import type {
  GitHubRateLimitBucket,
  GraphQLPullRequestNode,
  GraphQLRateLimitData,
  GraphQLSearchConnection,
  GraphQLTimelineItemNode,
} from "./graphql-types";

/**
 * GraphQL の PullRequest ノードを既存の GitHubSearchItem（REST searchIssues 互換）に変換する。
 */
export function adaptGraphQLToSearchItem(node: GraphQLPullRequestNode): GitHubSearchItem {
  return {
    number: Number(node.number),
    title: String(node.title),
    html_url: String(node.url),
    created_at: String(node.createdAt),
    updated_at: String(node.updatedAt),
    author: node.author?.login ?? undefined,
    author_association: node.authorAssociation ?? undefined,
  };
}

/**
 * GraphQL の PullRequest ノードを既存の GitHubDetailedSearchItem（REST searchIssuesDetailed アイテム互換）に変換する。
 */
export function adaptGraphQLToDetailedSearchItem(
  node: GraphQLPullRequestNode,
): GitHubDetailedSearchItem {
  return {
    number: Number(node.number),
    title: String(node.title),
    html_url: String(node.url),
    created_at: String(node.createdAt),
    updated_at: String(node.updatedAt),
    author: node.author?.login ?? undefined,
    commitCount:
      node.commits?.totalCount !== undefined ? Number(node.commits.totalCount) : undefined,
    labels: Array.isArray(node.labels?.nodes)
      ? node.labels.nodes.map((l) => ({ name: String(l.name) }))
      : [],
    is_draft: Boolean(node.isDraft),
    pull_request: node.mergedAt !== undefined ? { merged_at: node.mergedAt ?? null } : undefined,
  };
}

/**
 * GraphQL の Search コネクションを既存の GitHubDetailedSearchResult（REST searchIssuesDetailed 結果互換）に変換する。
 */
export function adaptGraphQLToDetailedSearchResult(
  connection: GraphQLSearchConnection,
): GitHubDetailedSearchResult {
  const totalCount = Number(connection.issueCount ?? 0);
  const items: GitHubDetailedSearchItem[] = [];

  if (Array.isArray(connection.nodes)) {
    for (const raw of connection.nodes) {
      if (raw && typeof raw === "object" && "number" in raw && "title" in raw) {
        items.push(adaptGraphQLToDetailedSearchItem(raw as GraphQLPullRequestNode));
      }
    }
  }

  return { totalCount, items, pageInfo: connection.pageInfo };
}

/**
 * GraphQL の PullRequest ノードを既存の GitHubPrView（REST getPullRequest 互換）に変換する。
 */
export function adaptGraphQLToPrView(node: GraphQLPullRequestNode): GitHubPrView {
  return {
    number: Number(node.number),
    title: String(node.title),
    url: String(node.url),
    createdAt: String(node.createdAt),
    updatedAt: String(node.updatedAt),
  };
}

/**
 * GraphQL の PullRequest ノードを既存の ProgressPrDetail（REST getPullRequestDetails 互換）に変換する。
 */
export function adaptGraphQLToPrDetail(node: GraphQLPullRequestNode): ProgressPrDetail {
  const commits: ProgressCommitSummary[] = Array.isArray(node.commits?.nodes)
    ? node.commits.nodes.map((c) => ({
        oid: c.commit.oid ? String(c.commit.oid) : undefined,
        messageHeadline: c.commit.messageHeadline ? String(c.commit.messageHeadline) : undefined,
        committedDate: String(c.commit.committedDate),
      }))
    : [];

  const rawState = String(node.state ?? "OPEN").toUpperCase();
  const isMerged = Boolean(node.mergedAt);
  const state: "OPEN" | "CLOSED" | "MERGED" = isMerged
    ? "MERGED"
    : rawState === "OPEN"
      ? "OPEN"
      : "CLOSED";

  const labels = Array.isArray(node.labels?.nodes)
    ? node.labels.nodes.map((l) => String(l.name))
    : [];

  return {
    number: Number(node.number),
    title: String(node.title),
    url: String(node.url),
    state,
    isDraft: Boolean(node.isDraft),
    createdAt: String(node.createdAt),
    updatedAt: String(node.updatedAt),
    mergedAt: node.mergedAt ? String(node.mergedAt) : null,
    closedAt: node.closedAt ? String(node.closedAt) : null,
    labels,
    commits,
    author: node.author?.login ?? undefined,
    authorAssociation: node.authorAssociation ?? undefined,
  };
}

/**
 * 単一の GraphQL TimelineItem ノードを既存の ProgressTimelineEvent（REST getIssueTimeline 互換）に変換する。
 * 対象外イベントや日時情報が欠落している場合は null を返す。
 */
export function adaptGraphQLTimelineItem(
  item: GraphQLTimelineItemNode,
): ProgressTimelineEvent | null {
  if (!item || typeof item !== "object" || !item.__typename || !item.createdAt) {
    return null;
  }

  const createdAt = String(item.createdAt);

  switch (item.__typename) {
    case "LabeledEvent": {
      const labelObj = item.label as { name?: string | null } | undefined;
      return {
        event: "labeled",
        created_at: createdAt,
        label: labelObj?.name ? { name: String(labelObj.name) } : undefined,
      };
    }
    case "UnlabeledEvent": {
      const labelObj = item.label as { name?: string | null } | undefined;
      return {
        event: "unlabeled",
        created_at: createdAt,
        label: labelObj?.name ? { name: String(labelObj.name) } : undefined,
      };
    }
    case "ConvertedToDraftEvent":
    case "ConvertToDraftEvent": {
      return {
        event: "converted_to_draft",
        created_at: createdAt,
      };
    }
    case "ReadyForReviewEvent": {
      return {
        event: "ready_for_review",
        created_at: createdAt,
      };
    }
    default:
      return null;
  }
}

/**
 * GraphQL TimelineItem の配列を既存の ProgressTimelineEvent[] に変換する。
 */
export function adaptGraphQLTimelineItems(
  items: GraphQLTimelineItemNode[],
): ProgressTimelineEvent[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const result: ProgressTimelineEvent[] = [];
  for (const raw of items) {
    const adapted = adaptGraphQLTimelineItem(raw);
    if (adapted) {
      result.push(adapted);
    }
  }
  return result;
}

/**
 * GraphQL の rateLimit データを既存の GitHubRateLimitBucket 形式に変換する。
 */
export function adaptGraphQLRateLimitBucket(data: GraphQLRateLimitData): GitHubRateLimitBucket {
  return {
    limit: Number(data.limit),
    remaining: Number(data.remaining),
    resetAt: data.resetAt ? new Date(data.resetAt).toISOString() : null,
  };
}

/**
 * REST の sort / order 指定を GitHub 検索クエリ構文（GraphQL search 用）に付加する。
 */
export function buildGraphQLSearchQuery(baseQuery: string, sort?: string, order?: string): string {
  const trimmed = baseQuery.trim();
  if (!sort) {
    return trimmed;
  }
  const ord = (order ?? "asc").toLowerCase();
  const sortToken = `sort:${sort.toLowerCase()}-${ord}`;
  // 既にクエリ内に sort: が含まれている場合は二重付与しない
  if (trimmed.includes("sort:")) {
    return trimmed;
  }
  return trimmed ? `${trimmed} ${sortToken}` : sortToken;
}
