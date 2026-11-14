/**
 * GitHub GraphQL API 用のクエリ文字列定数。
 */

export const SEARCH_ISSUES_QUERY = `
query SearchIssues($query: String!, $first: Int!, $after: String) {
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
        isDraft
        mergedAt
        author {
          login
        }
        authorAssociation
        labels(first: 100) {
          nodes {
            name
          }
        }
        commits(first: 1) {
          totalCount
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
    cost
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
      author {
        login
      }
      authorAssociation
      labels(first: 100) {
        nodes {
          name
        }
      }
      commits(first: 100) {
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
        labels(first: 30) {
          nodes {
            name
          }
        }
      }
    }
  }
}`;
