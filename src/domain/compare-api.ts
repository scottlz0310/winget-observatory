import type {
  FieldDiff,
  PrDetailDiffResult,
  SearchDiffResult,
  SearchResultComparison,
  TimelineDiffResult,
} from "../models/api-compare";
import type { ProgressPrDetail, ProgressTimelineEvent } from "../models/progress";
import { hasBlockingOrDraftHistory } from "./first-timer";
import { simulateReadySince } from "./progress";

/**
 * 2 つの検索結果（REST と GraphQL）の差分を詳細に検証する純粋関数。
 */
export function diffSearchResults(
  rest: SearchResultComparison,
  graphql: SearchResultComparison,
): SearchDiffResult {
  const totalCountMatch = rest.totalCount === graphql.totalCount;
  const countDiff = graphql.totalCount - rest.totalCount;

  const restNumbers = rest.items.map((i) => i.number);
  const graphqlNumbers = graphql.items.map((i) => i.number);

  const graphqlSet = new Set(graphqlNumbers);
  const restSet = new Set(restNumbers);

  const missingInGraphql = restNumbers.filter((n) => !graphqlSet.has(n));
  const missingInRest = graphqlNumbers.filter((n) => !restSet.has(n));

  const itemCountMatch = rest.items.length === graphql.items.length;
  const orderMatch = itemCountMatch && restNumbers.every((n, idx) => n === graphqlNumbers[idx]);

  const graphqlItemMap = new Map(graphql.items.map((i) => [i.number, i]));
  const fieldDiffs: Array<{ number: number; diffs: FieldDiff[] }> = [];

  for (const rItem of rest.items) {
    const gItem = graphqlItemMap.get(rItem.number);
    if (!gItem) continue;

    const diffs: FieldDiff[] = [];

    if (rItem.title !== gItem.title) {
      diffs.push({ field: "title", rest: rItem.title, graphql: gItem.title });
    }
    if (rItem.created_at !== gItem.created_at) {
      diffs.push({ field: "created_at", rest: rItem.created_at, graphql: gItem.created_at });
    }
    if (rItem.updated_at !== gItem.updated_at) {
      diffs.push({ field: "updated_at", rest: rItem.updated_at, graphql: gItem.updated_at });
    }
    if (Boolean(rItem.is_draft) !== Boolean(gItem.is_draft)) {
      diffs.push({ field: "is_draft", rest: rItem.is_draft, graphql: gItem.is_draft });
    }

    const rMerged = rItem.pull_request?.merged_at ?? null;
    const gMerged = gItem.pull_request?.merged_at ?? null;
    if (rMerged !== gMerged) {
      diffs.push({ field: "merged_at", rest: rMerged, graphql: gMerged });
    }

    const rLabels = (rItem.labels?.map((l) => l.name) ?? []).slice().sort();
    const gLabels = (gItem.labels?.map((l) => l.name) ?? []).slice().sort();
    if (JSON.stringify(rLabels) !== JSON.stringify(gLabels)) {
      diffs.push({ field: "labels", rest: rLabels, graphql: gLabels });
    }

    if (diffs.length > 0) {
      fieldDiffs.push({ number: rItem.number, diffs });
    }
  }

  return {
    totalCountMatch,
    restTotalCount: rest.totalCount,
    graphqlTotalCount: graphql.totalCount,
    countDiff,
    itemCountMatch,
    restNumbers,
    graphqlNumbers,
    missingInGraphql,
    missingInRest,
    orderMatch,
    fieldDiffs,
  };
}

/**
 * 2 つの PR 詳細（REST と GraphQL）の差分を検証する純粋関数。
 */
export function diffPrDetails(
  rest: ProgressPrDetail,
  graphql: ProgressPrDetail,
): PrDetailDiffResult {
  const diffs: FieldDiff[] = [];

  const check = (field: keyof ProgressPrDetail) => {
    const rVal = rest[field];
    const gVal = graphql[field];
    if (rVal !== gVal) {
      diffs.push({ field: String(field), rest: rVal, graphql: gVal });
    }
  };

  check("number");
  check("title");
  check("url");
  check("state");
  check("isDraft");
  check("createdAt");
  check("updatedAt");
  check("mergedAt");
  check("closedAt");
  check("author");
  check("authorAssociation");

  const rLabels = rest.labels.slice().sort();
  const gLabels = graphql.labels.slice().sort();
  if (JSON.stringify(rLabels) !== JSON.stringify(gLabels)) {
    diffs.push({ field: "labels", rest: rLabels, graphql: gLabels });
  }

  if (rest.commits.length !== graphql.commits.length) {
    diffs.push({
      field: "commits.length",
      rest: rest.commits.length,
      graphql: graphql.commits.length,
    });
  } else {
    for (let i = 0; i < rest.commits.length; i++) {
      const rc = rest.commits[i];
      const gc = graphql.commits[i];
      if (rc.oid !== gc.oid || rc.committedDate !== gc.committedDate) {
        diffs.push({
          field: `commits[${i}]`,
          rest: rc,
          graphql: gc,
        });
        break;
      }
    }
  }

  return {
    match: diffs.length === 0,
    diffs,
  };
}

/**
 * 2 つのタイムラインイベント配列（REST と GraphQL）の差分と判定影響を検証する純粋関数。
 */
export function diffTimelines(
  rest: ProgressTimelineEvent[],
  graphql: ProgressTimelineEvent[],
  isDraft: boolean,
  endAt: Date,
): TimelineDiffResult {
  const diffs: FieldDiff[] = [];

  const countMatch = rest.length === graphql.length;
  if (!countMatch) {
    diffs.push({ field: "eventCount", rest: rest.length, graphql: graphql.length });
  }

  const restHasBlocking = hasBlockingOrDraftHistory(rest, isDraft);
  const graphqlHasBlocking = hasBlockingOrDraftHistory(graphql, isDraft);
  const blockingHistoryMatch = restHasBlocking === graphqlHasBlocking;
  if (!blockingHistoryMatch) {
    diffs.push({
      field: "hasBlockingOrDraftHistory",
      rest: restHasBlocking,
      graphql: graphqlHasBlocking,
    });
  }

  const restReady = simulateReadySince(rest, isDraft, endAt);
  const graphqlReady = simulateReadySince(graphql, isDraft, endAt);
  const restReadyStr = restReady ? restReady.toISOString() : null;
  const graphqlReadyStr = graphqlReady ? graphqlReady.toISOString() : null;
  const readySinceMatch = restReadyStr === graphqlReadyStr;
  if (!readySinceMatch) {
    diffs.push({
      field: "simulateReadySince",
      rest: restReadyStr,
      graphql: graphqlReadyStr,
    });
  }

  let eventSequenceMatch = countMatch;
  if (countMatch) {
    for (let i = 0; i < rest.length; i++) {
      const re = rest[i];
      const ge = graphql[i];
      if (
        re.event !== ge.event ||
        re.created_at !== ge.created_at ||
        re.label?.name !== ge.label?.name
      ) {
        eventSequenceMatch = false;
        diffs.push({
          field: `event[${i}]`,
          rest: re,
          graphql: ge,
        });
        break;
      }
    }
  }

  return {
    countMatch,
    restEventCount: rest.length,
    graphqlEventCount: graphql.length,
    eventSequenceMatch,
    blockingHistoryMatch,
    restHasBlocking,
    graphqlHasBlocking,
    readySinceMatch,
    restReadySince: restReadyStr,
    graphqlReadySince: graphqlReadyStr,
    diffs,
  };
}
