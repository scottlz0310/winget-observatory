/**
 * GitHub GraphQL API 用のクエリ文字列定数。
 * 各呼び出し用途で実際に計算・表示に使用するフィールドのみを要求する。
 */

export const SEARCH_COUNT_QUERY = `
query SearchIssueCount($query: String!) {
  search(query: $query, type: ISSUE, first: 1) {
    issueCount
  }
}
`;

export const SEARCH_ISSUES_QUERY = `
query SearchIssues($query: String!, $first: Int!) {
  search(query: $query, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number
        title
        url
        createdAt
        updatedAt
      }
    }
  }
}
`;

export const SEARCH_ISSUES_DETAILED_QUERY = `
query SearchIssuesDetailed($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        title
        url
        createdAt
        updatedAt
        mergedAt
        author {
          login
        }
      }
    }
  }
}
`;

export const GET_RATE_LIMIT_QUERY = `
query GetRateLimit {
  rateLimit {
    limit
    remaining
    resetAt
  }
}
`;

export const GET_PULL_REQUEST_VIEW_QUERY = `
query GetPullRequestView($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      createdAt
      updatedAt
      author {
        __typename
        login
      }
      assignees(first: 10) {
        nodes {
          __typename
          login
        }
      }
      reviews(first: 20) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          state
          submittedAt
          createdAt
        }
      }
      comments(first: 20) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          body
          createdAt
          lastEditedAt
          editor {
            __typename
            login
          }
        }
      }
      timelineItems(itemTypes: [ASSIGNED_EVENT], first: 10) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on AssignedEvent {
            createdAt
            actor {
              __typename
              login
            }
            assignee {
              ... on User {
                login
              }
            }
          }
        }
      }
    }
  }
}
`;

export const GET_PULL_REQUEST_STATE_QUERY = `
query GetPullRequestState($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      mergedAt
    }
  }
}
`;

export const GET_PULL_REQUEST_DETAILS_QUERY = `
query GetPullRequestDetails($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      state
      isDraft
      createdAt
      updatedAt
      mergedAt
      closedAt
      labels(first: 100) {
        nodes {
          name
        }
      }
      commits(last: 1) {
        totalCount
        nodes {
          commit {
            oid
            messageHeadline
            committedDate
          }
        }
      }
    }
  }
}
`;

export const GET_PULL_REQUEST_SAMPLE_QUERY = `
query GetPullRequestSample($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      createdAt
      author {
        __typename
        login
      }
      authorAssociation
      commits(last: 1) {
        totalCount
        nodes {
          commit {
            committedDate
          }
        }
      }
      timelineItems(
        first: 100
        after: $after
        itemTypes: [
          LABELED_EVENT
          UNLABELED_EVENT
          CONVERT_TO_DRAFT_EVENT
          READY_FOR_REVIEW_EVENT
        ]
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on LabeledEvent {
            createdAt
            label {
              name
            }
          }
          ... on UnlabeledEvent {
            createdAt
            label {
              name
            }
          }
          ... on ConvertToDraftEvent {
            createdAt
          }
          ... on ReadyForReviewEvent {
            createdAt
          }
        }
      }
    }
  }
}
`;

export const GET_PULL_REQUEST_TIMELINE_QUERY = `
query GetPullRequestTimeline($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(
        first: 100
        after: $after
        itemTypes: [
          LABELED_EVENT
          UNLABELED_EVENT
          CONVERT_TO_DRAFT_EVENT
          READY_FOR_REVIEW_EVENT
        ]
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on LabeledEvent {
            createdAt
            label {
              name
            }
          }
          ... on UnlabeledEvent {
            createdAt
            label {
              name
            }
          }
          ... on ConvertToDraftEvent {
            createdAt
          }
          ... on ReadyForReviewEvent {
            createdAt
          }
        }
      }
    }
  }
}
`;

export const FIRST_TIMER_GRAPHQL_QUERY = `query($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        title
        url
        createdAt
        updatedAt
        author {
          login
        }
        authorAssociation
        commits {
          totalCount
        }
        assignees(first: 10) {
          nodes {
            login
          }
        }
      }
    }
  }
}`;

export const SEARCH_PR_NUMBERS_QUERY = `
query SearchPrNumbers($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
      }
    }
  }
}
`;

export const GET_PULL_REQUEST_REVIEWS_PAGE_QUERY = `
query GetPullRequestReviewsPage($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 50, after: $after) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          state
          submittedAt
          createdAt
        }
      }
    }
  }
}
`;

export const GET_PULL_REQUEST_COMMENTS_PAGE_QUERY = `
query GetPullRequestCommentsPage($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 50, after: $after) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          body
          createdAt
          lastEditedAt
          editor {
            __typename
            login
          }
        }
      }
    }
  }
}
`;

export const SEARCH_INTERVENTION_LIGHT_CANDIDATES_QUERY = `
query SearchInterventionLightCandidates($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        author {
          login
        }
        authorAssociation
      }
    }
  }
}
`;

/**
 * 複数 PR の介入判定用メタデータ・reviews・comments・assignees・AssignedEvent を 1 リクエストで取得する alias クエリを構築する。
 */
export function buildPullRequestBatchInterventionQuery(numbers: readonly number[]): string {
  const fields = numbers
    .map((num, idx) => {
      if (!Number.isInteger(num) || num <= 0) {
        throw new Error(`PR 番号が不正です: ${num}`);
      }
      return `
    pr${idx}: pullRequest(number: ${num}) {
      number
      title
      url
      state
      createdAt
      updatedAt
      mergedAt
      author {
        __typename
        login
      }
      authorAssociation
      commits {
        totalCount
      }
      assignees(first: 10) {
        nodes {
          __typename
          login
        }
      }
      reviews(first: 20) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          state
          submittedAt
          createdAt
        }
      }
      comments(first: 20) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          author {
            __typename
            login
          }
          body
          createdAt
          lastEditedAt
          editor {
            __typename
            login
          }
        }
      }
      timelineItems(itemTypes: [ASSIGNED_EVENT], first: 10) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          __typename
          ... on AssignedEvent {
            createdAt
            actor {
              __typename
              login
            }
            assignee {
              ... on User {
                login
              }
            }
          }
        }
      }
    }`;
    })
    .join("\n");

  return `query GetPullRequestInterventionBatch($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {${fields}
  }
}`;
}
