/**
 * GitHub GraphQL API のレスポンス型定義。
 * GraphQL クエリの戻り値の型付けとドメイン層・API 層へのマッピングに使用する。
 */

export interface GraphQLAuthor {
  __typename?: string | null;
  login: string;
}

export interface GraphQLAssigneeNode {
  __typename?: string | null;
  login?: string | null;
}

export interface GraphQLAssigneeConnection {
  nodes?: Array<GraphQLAssigneeNode | null> | null;
}

export interface GraphQLReviewNode {
  author?: {
    __typename?: string | null;
    login?: string | null;
  } | null;
  state?: string | null;
  submittedAt?: string | null;
  createdAt?: string | null;
}

export interface GraphQLReviewConnection {
  totalCount?: number;
  pageInfo?: GraphQLPageInfo | null;
  nodes?: Array<GraphQLReviewNode | null> | null;
}

export interface GraphQLCommentNode {
  author?: {
    __typename?: string | null;
    login?: string | null;
  } | null;
  authorAssociation?: string | null;
  body?: string | null;
  createdAt?: string | null;
  lastEditedAt?: string | null;
  editor?: {
    __typename?: string | null;
    login?: string | null;
  } | null;
}

export interface GraphQLCommentConnection {
  totalCount?: number;
  pageInfo?: GraphQLPageInfo | null;
  nodes?: Array<GraphQLCommentNode | null> | null;
}

export interface GraphQLLabelNode {
  name: string;
}

export interface GraphQLLabelConnection {
  nodes?: GraphQLLabelNode[] | null;
}

export interface GraphQLCommitDetail {
  oid?: string | null;
  messageHeadline?: string | null;
  committedDate: string;
}

export interface GraphQLCommitNode {
  commit: GraphQLCommitDetail;
}

export interface GraphQLCommitConnection {
  totalCount?: number;
  nodes?: GraphQLCommitNode[] | null;
}

export interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export type GraphQLTimelineItemNode =
  | {
      __typename: "LabeledEvent";
      createdAt: string;
      label?: { name?: string | null } | null;
    }
  | {
      __typename: "UnlabeledEvent";
      createdAt: string;
      label?: { name?: string | null } | null;
    }
  | {
      __typename: "ConvertedToDraftEvent" | "ConvertToDraftEvent";
      createdAt: string;
    }
  | {
      __typename: "ReadyForReviewEvent";
      createdAt: string;
    }
  | {
      __typename: "AssignedEvent";
      createdAt: string;
      actor?: {
        __typename?: string | null;
        login?: string | null;
      } | null;
      assignee?: {
        __typename?: string | null;
        login?: string | null;
      } | null;
    }
  | {
      __typename: string;
      createdAt?: string;
      [key: string]: unknown;
    };

export interface GraphQLTimelineConnection {
  pageInfo?: GraphQLPageInfo;
  nodes?: GraphQLTimelineItemNode[] | null;
}

export interface GraphQLPullRequestNode {
  number?: number;
  title?: string;
  url?: string;
  state?: "OPEN" | "CLOSED" | "MERGED" | string;
  isDraft?: boolean | null;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  author?: GraphQLAuthor | null;
  authorAssociation?: string | null;
  labels?: GraphQLLabelConnection | null;
  commits?: GraphQLCommitConnection | null;
  assignees?: GraphQLAssigneeConnection | null;
  reviews?: GraphQLReviewConnection | null;
  comments?: GraphQLCommentConnection | null;
  timelineItems?: GraphQLTimelineConnection | null;
}

export interface GraphQLSearchConnection<T = GraphQLPullRequestNode> {
  issueCount: number;
  pageInfo?: GraphQLPageInfo;
  nodes?: Array<T | Record<string, unknown>> | null;
}

export interface GraphQLRateLimitData {
  limit: number;
  cost?: number;
  remaining: number;
  resetAt: string;
}

/** レート制限の 1 枠（graphql）の残量 */
export interface GitHubRateLimitBucket {
  limit: number;
  remaining: number;
  /** 枠がリセットされる時刻（ISO 8601, UTC）。不明なら null */
  resetAt: string | null;
}

export interface GraphQLRateLimitBucket extends GitHubRateLimitBucket {
  cost?: number;
}

export interface GitHubRateLimit {
  /** GraphQL レート制限枠 */
  graphql: GraphQLRateLimitBucket;
}
