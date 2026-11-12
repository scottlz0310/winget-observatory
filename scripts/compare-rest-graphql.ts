#!/usr/bin/env bun
/**
 * REST API と GraphQL API の応答比較・整合性検証用スクリプト（Phase 0）。
 * 同一のクエリ・PR を両方式で取得し、件数・フィールド値・判定結果の差分を検証する。
 * 観測データ（data/）への書き込みは一切行わない読み取り専用ツール。
 */

import { GitHubApiClient } from "../src/api/github";
import {
  adaptGraphQLRateLimitBucket,
  adaptGraphQLTimelineItems,
  adaptGraphQLToDetailedSearchResult,
  adaptGraphQLToPrDetail,
  buildGraphQLSearchQuery,
} from "../src/api/graphql-adapters";
import type {
  GraphQLPullRequestNode,
  GraphQLRateLimitData,
  GraphQLSearchConnection,
  GraphQLTimelineItemNode,
} from "../src/api/graphql-types";
import { diffPrDetails, diffSearchResults, diffTimelines } from "../src/domain/compare-api";
import type {
  PrDetailDiffResult,
  SearchDiffResult,
  TimelineDiffResult,
} from "../src/models/api-compare";

const GRAPHQL_SEARCH_QUERY = `
query CompareSearch($query: String!, $first: Int!) {
  search(query: $query, type: ISSUE, first: $first) {
    issueCount
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
      }
    }
  }
}
`;

const GRAPHQL_PR_DETAIL_QUERY = `
query ComparePullRequest($owner: String!, $name: String!, $number: Int!) {
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
      commits(last: 100) {
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

const GRAPHQL_TIMELINE_QUERY = `
query CompareTimeline($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(first: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT, CONVERT_TO_DRAFT_EVENT, READY_FOR_REVIEW_EVENT]) {
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

const GRAPHQL_RATELIMIT_QUERY = `
query CompareRateLimit {
  rateLimit {
    limit
    cost
    remaining
    resetAt
  }
}
`;

export interface CompareOptions {
  repository: string;
  targetPr?: number;
  query?: string;
  sort?: string;
  order?: string;
  perPage?: number;
  asJson?: boolean;
}

export interface ComparisonReport {
  timestamp: string;
  repository: string;
  rateLimit: {
    rest: {
      core: { limit: number; remaining: number };
      search: { limit: number; remaining: number };
    };
    graphql: { limit: number; remaining: number; cost: number };
  };
  search: SearchDiffResult;
  prDetail?: {
    number: number;
    diff: PrDetailDiffResult;
  };
  timeline?: {
    number: number;
    diff: TimelineDiffResult;
  };
}

export function parseCliArgs(argv: string[]): CompareOptions {
  let repository = process.env.WINGET_REPOSITORY ?? "microsoft/winget-pkgs";
  let targetPr: number | undefined = process.env.WINGET_TARGET_PR
    ? Number(process.env.WINGET_TARGET_PR)
    : undefined;
  let query: string | undefined;
  let sort = "created";
  let order = "asc";
  let perPage = 10;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repository" || arg === "-r") {
      repository = argv[++i];
    } else if (arg === "--target-pr" || arg === "-p") {
      targetPr = Number(argv[++i]);
    } else if (arg === "--query" || arg === "-q") {
      query = argv[++i];
    } else if (arg === "--sort") {
      sort = argv[++i];
    } else if (arg === "--order") {
      order = argv[++i];
    } else if (arg === "--per-page") {
      perPage = Number(argv[++i]);
    } else if (arg === "--json") {
      asJson = true;
    }
  }

  // クエリ文字列内に sort:xxx-yyy が直接含まれている場合、REST パラメータと整合させる
  if (query && !argv.includes("--sort")) {
    const sortMatch = query.match(/\bsort:(\w+)-(asc|desc)\b/i);
    if (sortMatch) {
      sort = sortMatch[1].toLowerCase();
      order = sortMatch[2].toLowerCase();
    }
  }

  return { repository, targetPr, query, sort, order, perPage, asJson };
}

export async function runCompare(
  options: CompareOptions,
  client = new GitHubApiClient(),
): Promise<ComparisonReport> {
  const [owner, name] = options.repository.split("/");
  if (!owner || !name) {
    throw new Error(`無効なリポジトリ指定です: ${options.repository}`);
  }

  // 1. レート制限の比較取得
  const [restRate, gqlRateRaw] = await Promise.all([
    client.getRateLimit(),
    client.graphql<{ rateLimit: GraphQLRateLimitData }>(GRAPHQL_RATELIMIT_QUERY),
  ]);
  const gqlRate = adaptGraphQLRateLimitBucket(gqlRateRaw.rateLimit);

  // 2. 検索クエリの比較
  const baseQuery =
    options.query ??
    `repo:${options.repository} is:pr is:open -label:Needs-Author-Feedback,Blocked-FileIssue`;
  const gqlSearchQueryStr = buildGraphQLSearchQuery(baseQuery, options.sort, options.order);

  const [restSearch, gqlSearchRaw] = await Promise.all([
    client.searchIssuesDetailed(
      baseQuery,
      options.sort ?? "created",
      options.order ?? "asc",
      options.perPage ?? 10,
    ),
    client.graphql<{ search: GraphQLSearchConnection }>(GRAPHQL_SEARCH_QUERY, {
      query: gqlSearchQueryStr,
      first: options.perPage ?? 10,
    }),
  ]);

  const gqlSearch = adaptGraphQLToDetailedSearchResult(gqlSearchRaw.search);
  const searchDiff = diffSearchResults(restSearch, gqlSearch);

  // 3. PR 詳細・タイムラインの比較（targetPr または検索結果の先頭PR）
  const comparePrNumber = options.targetPr ?? restSearch.items[0]?.number;
  let prDetailReport: ComparisonReport["prDetail"];
  let timelineReport: ComparisonReport["timeline"];

  if (comparePrNumber) {
    const [restPrDetail, gqlPrDetailRaw, restTimeline, gqlTimelineRaw] = await Promise.all([
      client.getPullRequestDetails(options.repository, comparePrNumber),
      client.graphql<{ repository: { pullRequest: GraphQLPullRequestNode } }>(
        GRAPHQL_PR_DETAIL_QUERY,
        {
          owner,
          name,
          number: comparePrNumber,
        },
      ),
      client.getIssueTimeline(options.repository, comparePrNumber),
      client.graphql<{
        repository: {
          pullRequest: { timelineItems: { nodes: GraphQLTimelineItemNode[] } };
        };
      }>(GRAPHQL_TIMELINE_QUERY, {
        owner,
        name,
        number: comparePrNumber,
      }),
    ]);

    const gqlPrDetail = adaptGraphQLToPrDetail(gqlPrDetailRaw.repository.pullRequest);
    const prDiff = diffPrDetails(restPrDetail, gqlPrDetail);
    prDetailReport = { number: comparePrNumber, diff: prDiff };

    const gqlTimelineEvents = adaptGraphQLTimelineItems(
      gqlTimelineRaw.repository.pullRequest.timelineItems.nodes ?? [],
    );
    const timelineDiff = diffTimelines(
      restTimeline,
      gqlTimelineEvents,
      gqlPrDetail.isDraft,
      new Date(),
    );
    timelineReport = { number: comparePrNumber, diff: timelineDiff };
  }

  return {
    timestamp: new Date().toISOString(),
    repository: options.repository,
    rateLimit: {
      rest: {
        core: { limit: restRate.core.limit, remaining: restRate.core.remaining },
        search: { limit: restRate.search.limit, remaining: restRate.search.remaining },
      },
      graphql: {
        limit: gqlRate.limit,
        remaining: gqlRate.remaining,
        cost: gqlRateRaw.rateLimit.cost,
      },
    },
    search: searchDiff,
    prDetail: prDetailReport,
    timeline: timelineReport,
  };
}

export function printHumanReport(report: ComparisonReport): void {
  console.log("============================================================");
  console.log("  REST vs GraphQL API 整合性比較レポート (Phase 0)");
  console.log("============================================================");
  console.log(`計測日時      : ${report.timestamp}`);
  console.log(`対象リポジトリ: ${report.repository}`);
  console.log("");
  console.log("--- 1. レート制限 ---");
  console.log(
    `REST Core    : 残り ${report.rateLimit.rest.core.remaining} / ${report.rateLimit.rest.core.limit}`,
  );
  console.log(
    `REST Search  : 残り ${report.rateLimit.rest.search.remaining} / ${report.rateLimit.rest.search.limit}`,
  );
  console.log(
    `GraphQL      : 残り ${report.rateLimit.graphql.remaining} / ${report.rateLimit.graphql.limit} (今回のクエリ消費: ${report.rateLimit.graphql.cost}pt)`,
  );
  console.log("");
  console.log("--- 2. 検索結果の比較 (Search) ---");
  console.log(
    `総件数 (totalCount) : REST=${report.search.restTotalCount}, GraphQL=${report.search.graphqlTotalCount} [差: ${report.search.countDiff >= 0 ? "+" : ""}${report.search.countDiff}] -> ${report.search.totalCountMatch ? "✅ 一致" : "⚠️ 不一致"}`,
  );
  console.log(
    `取得件数            : REST=${report.search.restNumbers.length}, GraphQL=${report.search.graphqlNumbers.length} -> ${report.search.itemCountMatch ? "✅ 一致" : "⚠️ 不一致"}`,
  );
  console.log(`順序の一致          : ${report.search.orderMatch ? "✅ 完全一致" : "⚠️ 順序相違"}`);
  if (report.search.missingInGraphql.length > 0) {
    console.log(`REST にのみ存在     : ${report.search.missingInGraphql.join(", ")}`);
  }
  if (report.search.missingInRest.length > 0) {
    console.log(`GraphQL にのみ存在  : ${report.search.missingInRest.join(", ")}`);
  }
  if (report.search.fieldDiffs.length > 0) {
    console.log("共通 PR のフィールド差分:");
    for (const item of report.search.fieldDiffs) {
      console.log(`  PR #${item.number}:`);
      for (const d of item.diffs) {
        console.log(
          `    - ${d.field}: REST=${JSON.stringify(d.rest)} vs GraphQL=${JSON.stringify(d.graphql)}`,
        );
      }
    }
  } else {
    console.log("取得アイテムの主要フィールド: ✅ すべて一致");
  }

  if (report.prDetail) {
    console.log("");
    console.log(`--- 3. PR 詳細の比較 (#${report.prDetail.number}) ---`);
    console.log(`総合一致判定: ${report.prDetail.diff.match ? "✅ 完全一致" : "⚠️ 差分あり"}`);
    if (report.prDetail.diff.diffs.length > 0) {
      for (const d of report.prDetail.diff.diffs) {
        console.log(
          `  - ${d.field}: REST=${JSON.stringify(d.rest)} vs GraphQL=${JSON.stringify(d.graphql)}`,
        );
      }
    }
  }

  if (report.timeline) {
    console.log("");
    console.log(`--- 4. タイムライン・イベント判定の比較 (#${report.timeline.number}) ---`);
    console.log(
      `イベント件数: REST=${report.timeline.diff.restEventCount}, GraphQL=${report.timeline.diff.graphqlEventCount} -> ${report.timeline.diff.countMatch ? "✅ 一致" : "⚠️ 相違"}`,
    );
    console.log(
      `阻害/Draft履歴判定 (hasBlockingOrDraftHistory): REST=${report.timeline.diff.restHasBlocking}, GraphQL=${report.timeline.diff.graphqlHasBlocking} -> ${report.timeline.diff.blockingHistoryMatch ? "✅ 一致" : "⚠️ 相違"}`,
    );
    console.log(
      `Ready 日時 (simulateReadySince): REST=${report.timeline.diff.restReadySince ?? "null"}, GraphQL=${report.timeline.diff.graphqlReadySince ?? "null"} -> ${report.timeline.diff.readySinceMatch ? "✅ 一致" : "⚠️ 相違"}`,
    );
    if (report.timeline.diff.diffs.length > 0) {
      console.log("タイムライン差分一覧:");
      for (const d of report.timeline.diff.diffs) {
        console.log(
          `  - ${d.field}: REST=${JSON.stringify(d.rest)} vs GraphQL=${JSON.stringify(d.graphql)}`,
        );
      }
    }
  }
  console.log("============================================================");
}

if (import.meta.main) {
  const options = parseCliArgs(process.argv.slice(2));
  try {
    const report = await runCompare(options);
    if (options.asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
  } catch (err) {
    console.error("比較実行中にエラーが発生しました:", err);
    process.exit(1);
  }
}
