/**
 * GitHub GraphQL API のレスポンス型定義。
 * REST から GraphQL への段階移行において、GraphQL クエリの戻り値の型付けと
 * ドメイン層・既存 API 層へのマッピングに使用する。
 */

export interface GraphQLAuthor {
  login: string;
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

export interface GraphQLPullRequestNode {
  number: number;
  title: string;
  url: string;
  state?: "OPEN" | "CLOSED" | "MERGED" | string;
  isDraft?: boolean | null;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  author?: GraphQLAuthor | null;
  authorAssociation?: string | null;
  labels?: GraphQLLabelConnection | null;
  commits?: GraphQLCommitConnection | null;
}

export interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GraphQLSearchConnection<T = GraphQLPullRequestNode> {
  issueCount: number;
  pageInfo?: GraphQLPageInfo;
  nodes?: Array<T | Record<string, unknown>> | null;
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
      __typename: string;
      createdAt?: string;
      [key: string]: unknown;
    };

export interface GraphQLTimelineConnection {
  pageInfo?: GraphQLPageInfo;
  nodes?: GraphQLTimelineItemNode[] | null;
}

export interface GraphQLRateLimitData {
  limit: number;
  cost: number;
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
