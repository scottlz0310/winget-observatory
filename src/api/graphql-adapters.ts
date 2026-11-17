import { extractThirdPartyAssignees } from "../domain/depths";
import { classifyPrIntervention } from "../domain/intervention";
import type { GitHubPrView, GitHubSearchItem, PrInterventionInput } from "../models/depths";
import type {
  GitHubDetailedSearchItem,
  GitHubDetailedSearchResult,
  ProgressCommitSummary,
  ProgressPrDetail,
  ProgressPrSampleData,
  ProgressPrState,
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
 * GraphQL の PullRequest ノードを GitHubSearchItem に変換する。
 */
export function adaptGraphQLToSearchItem(node: GraphQLPullRequestNode): GitHubSearchItem {
  return {
    number: Number(node.number),
    title: String(node.title),
    html_url: String(node.url),
    created_at: String(node.createdAt),
    updated_at: String(node.updatedAt),
  };
}

/**
 * GraphQL の PullRequest ノードを GitHubDetailedSearchItem に変換する。
 */
export function adaptGraphQLToDetailedSearchItem(
  node: GraphQLPullRequestNode,
): GitHubDetailedSearchItem {
  return {
    number: Number(node.number),
    title: String(node.title),
    html_url: String(node.url ?? ""),
    created_at: String(node.createdAt ?? ""),
    updated_at: String(node.updatedAt ?? ""),
    author: node.author?.login ?? undefined,
    pull_request: node.mergedAt !== undefined ? { merged_at: node.mergedAt ?? null } : undefined,
  };
}

/**
 * GraphQL の Search コネクションを GitHubDetailedSearchResult に変換する。
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
 * GraphQL の PullRequest ノードを GitHubPrView に変換する。
 */
export function adaptGraphQLToPrView(node: GraphQLPullRequestNode): GitHubPrView {
  const hasInterventionEdges = node.reviews !== undefined || node.comments !== undefined;
  const intervention = hasInterventionEdges
    ? classifyPrIntervention(node as PrInterventionInput)
    : undefined;

  return {
    number: Number(node.number),
    title: String(node.title),
    url: String(node.url),
    createdAt: String(node.createdAt),
    updatedAt: String(node.updatedAt),
    ...(node.author?.login ? { author: node.author.login } : {}),
    ...(intervention !== undefined
      ? {
          thirdPartyAssignees: intervention.ThirdPartyAssignees,
          intervention,
        }
      : node.assignees !== undefined
        ? {
            thirdPartyAssignees: extractThirdPartyAssignees(
              node.assignees?.nodes,
              node.author?.login,
            ),
          }
        : {}),
  };
}

/**
 * GraphQL の PullRequest ノードから状態（OPEN / CLOSED / MERGED）と mergedAt を抽出する。
 */
export function adaptGraphQLToPrState(node: GraphQLPullRequestNode): ProgressPrState {
  const rawState = String(node.state ?? "OPEN").toUpperCase();
  const isMerged = Boolean(node.mergedAt);
  const state: "OPEN" | "CLOSED" | "MERGED" = isMerged
    ? "MERGED"
    : rawState === "OPEN"
      ? "OPEN"
      : "CLOSED";

  return {
    state,
    mergedAt: node.mergedAt ? String(node.mergedAt) : null,
  };
}

/**
 * GraphQL の PullRequest ノードを ProgressPrDetail に変換する。
 */
export function adaptGraphQLToPrDetail(node: GraphQLPullRequestNode): ProgressPrDetail {
  const commits: ProgressCommitSummary[] = Array.isArray(node.commits?.nodes)
    ? node.commits.nodes.map((c) => ({
        oid: c.commit.oid ? String(c.commit.oid) : undefined,
        messageHeadline: c.commit.messageHeadline ? String(c.commit.messageHeadline) : undefined,
        committedDate: String(c.commit.committedDate),
      }))
    : [];

  const { state, mergedAt } = adaptGraphQLToPrState(node);

  const labels = Array.isArray(node.labels?.nodes)
    ? node.labels.nodes.map((l) => String(l.name))
    : [];

  const commitCount =
    node.commits?.totalCount !== undefined ? Number(node.commits.totalCount) : commits.length;

  return {
    number: Number(node.number),
    title: String(node.title),
    url: String(node.url),
    state,
    isDraft: Boolean(node.isDraft),
    createdAt: String(node.createdAt),
    updatedAt: String(node.updatedAt),
    mergedAt,
    closedAt: node.closedAt ? String(node.closedAt) : null,
    labels,
    commits,
    commitCount,
  };
}

/**
 * GraphQL の PullRequest ノードとタイムラインイベント列を ProgressPrSampleData に変換する。
 */
export function adaptGraphQLToPrSampleData(
  node: GraphQLPullRequestNode,
  timeline: ProgressTimelineEvent[],
): ProgressPrSampleData {
  const createdAt = String(node.createdAt);
  const commitNodes = Array.isArray(node.commits?.nodes) ? node.commits.nodes : [];
  const latestNode = commitNodes.length > 0 ? commitNodes[commitNodes.length - 1] : null;
  const latestCommittedDate = latestNode?.commit?.committedDate
    ? String(latestNode.commit.committedDate)
    : createdAt;
  const commitCount =
    node.commits?.totalCount !== undefined ? Number(node.commits.totalCount) : commitNodes.length;

  return {
    createdAt,
    commitCount,
    latestCommittedDate,
    ...(node.author?.login ? { author: node.author.login } : {}),
    timeline,
  };
}

/**
 * 単一の GraphQL TimelineItem ノードを ProgressTimelineEvent に変換する。
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
 * GraphQL TimelineItem の配列を ProgressTimelineEvent[] に変換する。
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
 * GraphQL の rateLimit データを GitHubRateLimitBucket 形式に変換する。
 */
export function adaptGraphQLRateLimitBucket(data: GraphQLRateLimitData): GitHubRateLimitBucket {
  return {
    limit: Number(data.limit),
    remaining: Number(data.remaining),
    resetAt: data.resetAt ? new Date(data.resetAt).toISOString() : null,
  };
}

/**
 * sort / order 指定を GitHub 検索クエリ構文（GraphQL search 用）に付加する。
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
