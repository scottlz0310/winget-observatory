/**
 * 初回提出 PR の差し戻し指摘を動的二分窓走査・増分キャッシュ・GraphQL バッチで収集するオーケストレーター。
 */

import {
  type BlobFetchTarget,
  DEFAULT_BLOB_BATCH_SIZE,
  DEFAULT_FEEDBACK_BATCH_SIZE,
  fetchInstallerManifestBlobs,
  fetchPullRequestFeedbackDetails,
} from "../api/feedback-queries";
import { type GitHubApiClient, parseRepository } from "../api/github";
import { isPrivilegedOrBotAuthor, resolveAuthorMergedCounts } from "../domain/first-timer";
import { DAY_MS } from "../domain/formatters";
import {
  buildFeedbackSearchQueryParts,
  buildReviewFeedbackEntry,
  CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
  canReuseCachedFeedbackEntry,
  detectFeedbackTriggers,
  extractReviewFeedbackItems,
  getReviewFeedbackCorpusKey,
  indexReviewFeedbackCorpus,
  isNewPackageTitle,
  parseInstallerManifestMetadata,
  selectInstallerManifestPaths,
} from "../domain/review-feedback";
import type {
  InstallerManifestMetadata,
  ReviewFeedbackCorpusEntry,
  ReviewFeedbackPrState,
  ReviewFeedbackStateFilter,
} from "../models/review-feedback";

export interface FeedbackCollectionStats {
  candidateCount: number;
  reusedFromCacheCount: number;
  fetchedCount: number;
  skippedByBudgetCount: number;
  newFeedbackCount: number;
  newNoFeedbackCount: number;
  incompleteCount: number;
  blobFetchCount: number;
}

export interface OrchestrateFeedbackCollectionParams {
  client: Pick<GitHubApiClient, "searchIssuesDetailed" | "graphql">;
  repository: string;
  states: readonly ReviewFeedbackStateFilter[];
  lookbackDays: number;
  fetchBudget: number;
  fetchLimit: number;
  existingEntries: readonly ReviewFeedbackCorpusEntry[];
  now: Date;
  batchSize?: number;
  blobBatchSize?: number;
  maxExtraPages?: number;
  pageSize?: number;
  maxPagesPerWindow?: number;
  log?: (msg: string) => void;
}

export interface OrchestrateFeedbackCollectionResult {
  entries: ReviewFeedbackCorpusEntry[];
  stats: FeedbackCollectionStats;
}

interface SearchCandidate {
  number: number;
  title: string;
  state: ReviewFeedbackPrState;
  updatedAt: string;
  sortKeyMs: number;
}

interface WindowSlice {
  since: Date;
  until: Date;
}

interface CollectCandidatesForQueryResult {
  observedCount: number;
  reusedCount: number;
}

/**
 * Search API の 1,000 件上限を回避する動的二分窓走査で未処理・要再取得の候補 PR 一覧を収集する。
 * 再利用可能なキャッシュ済み候補は読み飛ばし、`fetchLimit` 枠を消費しないことで再実行時の前進を保証する。
 */
async function collectCandidatesForQuery(params: {
  client: Pick<GitHubApiClient, "searchIssuesDetailed">;
  buildQuery: (sinceIso: string, untilIso: string) => string;
  state: ReviewFeedbackPrState;
  sortField: "updated" | "created";
  since: Date;
  until: Date;
  fetchLimit: number;
  pageSize: number;
  maxPagesPerWindow: number;
  seen: Set<number>;
  isReusableCached: (candidate: SearchCandidate) => boolean;
  out: SearchCandidate[];
}): Promise<CollectCandidatesForQueryResult> {
  const {
    client,
    buildQuery,
    state,
    sortField,
    since,
    until,
    fetchLimit,
    pageSize,
    maxPagesPerWindow,
    seen,
    isReusableCached,
    out,
  } = params;

  let observedCount = 0;
  let reusedCount = 0;

  if (since.getTime() >= until.getTime() || fetchLimit <= 0) {
    return { observedCount, reusedCount };
  }

  const stack: WindowSlice[] = [{ since, until }];
  const windowCapacity = maxPagesPerWindow * pageSize;

  while (stack.length > 0 && out.length < fetchLimit) {
    const slice = stack.pop();
    if (!slice || slice.since.getTime() >= slice.until.getTime()) {
      continue;
    }

    const query = buildQuery(slice.since.toISOString(), slice.until.toISOString());
    const firstPage = await client.searchIssuesDetailed(
      query,
      sortField,
      "desc",
      pageSize,
      1,
      null,
    );

    if (firstPage.totalCount === 0) {
      continue;
    }

    if (firstPage.totalCount > windowCapacity) {
      const durationMs = slice.until.getTime() - slice.since.getTime();
      if (durationMs <= 1000) {
        throw new Error(
          `期間 (${slice.since.toISOString()} .. ${slice.until.toISOString()}) の候補 PR 件数が Search API 上限 (${windowCapacity} 件) を超過しており、これ以上分割できません。`,
        );
      }
      const mid = new Date(Math.floor((slice.since.getTime() + slice.until.getTime()) / 2));
      stack.push({ since: slice.since, until: mid });
      stack.push({ since: mid, until: slice.until });
      continue;
    }

    if (!firstPage.items || firstPage.items.length === 0) {
      continue;
    }

    const consume = (
      items: ReadonlyArray<{
        number: number;
        title: string;
        updated_at: string;
        pull_request?: { merged_at?: string | null };
      }>,
    ): boolean => {
      for (const item of items) {
        if (out.length >= fetchLimit) {
          return false;
        }
        if (!isNewPackageTitle(item.title)) {
          continue;
        }
        if (seen.has(item.number)) {
          continue;
        }
        seen.add(item.number);
        observedCount++;
        const sortTs = Date.parse(item.pull_request?.merged_at ?? item.updated_at);
        const candidate: SearchCandidate = {
          number: item.number,
          title: item.title,
          state,
          updatedAt: item.updated_at,
          sortKeyMs: Number.isFinite(sortTs) ? sortTs : 0,
        };
        if (isReusableCached(candidate)) {
          reusedCount++;
          continue;
        }
        out.push(candidate);
      }
      return out.length < fetchLimit;
    };

    if (!consume(firstPage.items)) {
      break;
    }

    let hasNextPage = Boolean(
      firstPage.pageInfo ? firstPage.pageInfo.hasNextPage : firstPage.items.length >= pageSize,
    );
    let cursor = firstPage.pageInfo?.endCursor ?? null;
    let page = 2;

    while (hasNextPage && page <= maxPagesPerWindow && out.length < fetchLimit) {
      const res = await client.searchIssuesDetailed(
        query,
        sortField,
        "desc",
        pageSize,
        page,
        cursor,
      );
      if (!res.items || res.items.length === 0) {
        break;
      }
      if (!consume(res.items)) {
        break;
      }
      hasNextPage = Boolean(res.pageInfo ? res.pageInfo.hasNextPage : res.items.length >= pageSize);
      cursor = res.pageInfo?.endCursor ?? null;
      page++;
    }

    if (hasNextPage && page > maxPagesPerWindow) {
      const durationMs = slice.until.getTime() - slice.since.getTime();
      if (durationMs <= 1000) {
        throw new Error(
          `期間 (${slice.since.toISOString()} .. ${slice.until.toISOString()}) の候補 PR 件数が Search API 上限を超過しており、これ以上分割できません。`,
        );
      }
      const mid = new Date(Math.floor((slice.since.getTime() + slice.until.getTime()) / 2));
      stack.push({ since: slice.since, until: mid });
      stack.push({ since: mid, until: slice.until });
    }
  }

  return { observedCount, reusedCount };
}

/**
 * 状態・期間・キャッシュ・予算制御を組み合わせて差し戻し指摘コーパスを増分収集する。
 */
export async function orchestrateFeedbackCollection(
  params: OrchestrateFeedbackCollectionParams,
): Promise<OrchestrateFeedbackCollectionResult> {
  const {
    client,
    repository,
    states,
    lookbackDays,
    fetchBudget,
    fetchLimit,
    existingEntries,
    now,
    batchSize = DEFAULT_FEEDBACK_BATCH_SIZE,
    blobBatchSize = DEFAULT_BLOB_BATCH_SIZE,
    maxExtraPages,
    pageSize = 100,
    maxPagesPerWindow = 10,
    log = () => {},
  } = params;

  const cacheMap = indexReviewFeedbackCorpus(existingEntries);

  // fetchBudget === 0 はオフライン集計（キャッシュ再利用のみ）モード
  if (fetchBudget <= 0) {
    return {
      entries: [...cacheMap.values()].sort(
        (a, b) => b.number - a.number || a.repository.localeCompare(b.repository),
      ),
      stats: {
        candidateCount: 0,
        reusedFromCacheCount: cacheMap.size,
        fetchedCount: 0,
        skippedByBudgetCount: 0,
        newFeedbackCount: 0,
        newNoFeedbackCount: 0,
        incompleteCount: 0,
        blobFetchCount: 0,
      },
    };
  }

  const { owner, name } = parseRepository(repository);
  const since = new Date(now.getTime() - lookbackDays * DAY_MS);
  const until = now;

  // 1. 候補 PR を状態・期間で網羅検索（ラベル解除済み履歴も拾うため全状態でトリガー修飾子なし）
  //    先行状態が fetchLimit 全体を占有せず、かつ再利用可能なキャッシュ済み候補で上限枠を消費しないよう
  //    未処理・要再取得候補のみを残り状態数で均等配分した stateLimit まで収集する
  const toFetchQueues: number[][] = [];
  const seenNumbers = new Set<number>();
  let totalObservedCandidates = 0;
  let reusedFromCacheCount = 0;
  let totalToFetch = 0;

  const isReusableCached = (candidate: SearchCandidate): boolean => {
    const cached = cacheMap.get(getReviewFeedbackCorpusKey(repository, candidate.number));
    return canReuseCachedFeedbackEntry(cached, {
      currentSchemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
      currentState: candidate.state,
      currentUpdatedAt: candidate.updatedAt,
    });
  };

  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    const remainingStates = states.length - i;
    const remainingLimit = Math.max(0, fetchLimit - totalToFetch);
    if (remainingLimit <= 0) {
      break;
    }
    const stateLimit = Math.max(1, Math.ceil(remainingLimit / remainingStates));
    const uncachedCandidates: SearchCandidate[] = [];
    const normalizedState = state.toUpperCase() as ReviewFeedbackPrState;

    const scanResult = await collectCandidatesForQuery({
      client,
      buildQuery: (sinceIso, untilIso) =>
        buildFeedbackSearchQueryParts({
          repository,
          state,
          sinceIso,
          untilIso,
        }).join(" "),
      state: normalizedState,
      sortField: "updated",
      since,
      until,
      fetchLimit: stateLimit,
      pageSize,
      maxPagesPerWindow,
      seen: seenNumbers,
      isReusableCached,
      out: uncachedCandidates,
    });

    totalObservedCandidates += scanResult.observedCount;
    reusedFromCacheCount += scanResult.reusedCount;
    uncachedCandidates.sort((a, b) => b.sortKeyMs - a.sortKeyMs || b.number - a.number);
    if (uncachedCandidates.length > 0) {
      toFetchQueues.push(uncachedCandidates.map((c) => c.number));
      totalToFetch += uncachedCandidates.length;
    }
  }

  // 状態間ラウンドロビンで fetchBudget を公平配分する
  const budgetedNumbers: number[] = [];
  const queueOffsets = toFetchQueues.map(() => 0);
  while (budgetedNumbers.length < fetchBudget) {
    let pickedAny = false;
    for (let q = 0; q < toFetchQueues.length && budgetedNumbers.length < fetchBudget; q++) {
      const idx = queueOffsets[q];
      if (idx < toFetchQueues[q].length) {
        budgetedNumbers.push(toFetchQueues[q][idx]);
        queueOffsets[q]++;
        pickedAny = true;
      }
    }
    if (!pickedAny) {
      break;
    }
  }

  const skippedByBudgetCount = Math.max(0, totalToFetch - budgetedNumbers.length);

  log(
    `[Feedback Crawler] 候補 ${totalObservedCandidates} 件 / キャッシュ再利用 ${reusedFromCacheCount} 件 / 新規取得対象 ${budgetedNumbers.length} 件 (予算超過スキップ ${skippedByBudgetCount} 件)`,
  );

  if (budgetedNumbers.length === 0) {
    return {
      entries: [...cacheMap.values()].sort(
        (a, b) => b.number - a.number || a.repository.localeCompare(b.repository),
      ),
      stats: {
        candidateCount: totalObservedCandidates,
        reusedFromCacheCount,
        fetchedCount: 0,
        skippedByBudgetCount,
        newFeedbackCount: 0,
        newNoFeedbackCount: 0,
        incompleteCount: 0,
        blobFetchCount: 0,
      },
    };
  }

  // 2. GraphQL alias バッチで詳細（reviews / comments / timelineItems / files）を取得
  const fetchedDetails = await fetchPullRequestFeedbackDetails({
    graphqlFn: (query, variables) => client.graphql(query, variables),
    owner,
    name,
    repository,
    prNumbers: budgetedNumbers,
    batchSize,
    maxExtraPages,
  });

  // 3. 完全取得できた採用候補のみ抽出し、.installer.yaml の Blob と作者生涯マージ数をバッチ照会
  const blobTargets: BlobFetchTarget[] = [];
  const manifestPathsByPr = new Map<number, string[]>();
  const eligibleAuthorLogins = new Set<string>();
  let incompleteCount = 0;

  for (const detail of fetchedDetails) {
    if (detail.incomplete) {
      incompleteCount++;
      log(
        `[Feedback Crawler] 警告: PR #${detail.input.number} はページング上限到達により未完了 (${detail.incompleteConnections.join(", ")}) のため、確定キャッシュへ保存せずスキップします`,
      );
      continue;
    }

    const { input, manifestOid } = detail;
    if (!isNewPackageTitle(input.title)) {
      continue;
    }
    const feedbackItems = extractReviewFeedbackItems({
      prAuthorLogin: input.author?.login,
      reviews: input.reviews,
      comments: input.comments,
    });
    if (feedbackItems.length === 0) {
      continue;
    }
    const { triggers } = detectFeedbackTriggers({
      prAuthorLogin: input.author?.login,
      state: input.state,
      currentLabels: input.currentLabels,
      labeledEvents: input.labeledEvents,
      reviews: input.reviews,
      feedbackItems,
    });
    if (triggers.length === 0) {
      continue;
    }

    const installerPaths = selectInstallerManifestPaths(input.filePaths);
    manifestPathsByPr.set(input.number, installerPaths);
    if (manifestOid) {
      for (const path of installerPaths) {
        blobTargets.push({
          key: `${input.number}:${path}`,
          oid: manifestOid,
          path,
        });
      }
    }

    const authorLogin = input.author?.login?.trim();
    if (
      authorLogin &&
      !isPrivilegedOrBotAuthor({
        author: authorLogin,
        authorType: input.author?.__typename ?? undefined,
        authorAssociation: input.authorAssociation ?? undefined,
      })
    ) {
      eligibleAuthorLogins.add(authorLogin);
    }
  }

  const blobMap =
    blobTargets.length > 0
      ? await fetchInstallerManifestBlobs({
          graphqlFn: (query, variables) => client.graphql(query, variables),
          owner,
          name,
          targets: blobTargets,
          batchSize: blobBatchSize,
        })
      : new Map<string, string>();

  const authorMergedCounts =
    eligibleAuthorLogins.size > 0
      ? await resolveAuthorMergedCounts(repository, [...eligibleAuthorLogins], (query) =>
          client.graphql<Record<string, { issueCount?: number } | undefined>>(query),
        )
      : new Map<string, number>();

  // 4. コーパスエントリ構築 & キャッシュへ反映（未完了詳細は確定キャッシュへ保存しない）
  const collectedAt = now.toISOString();
  let newFeedbackCount = 0;
  let newNoFeedbackCount = 0;

  for (const detail of fetchedDetails) {
    if (detail.incomplete) {
      continue;
    }
    const { input } = detail;
    const installerPaths = manifestPathsByPr.get(input.number) ?? [];
    const installer: InstallerManifestMetadata = parseInstallerManifestMetadata(
      installerPaths.map((path) => ({
        path,
        text: blobMap.get(`${input.number}:${path}`),
      })),
    );

    let isFirstTimeAuthor: boolean | undefined;
    let authorMergedCount: number | undefined;
    const authorLogin = input.author?.login?.trim();
    if (authorLogin) {
      if (
        isPrivilegedOrBotAuthor({
          author: authorLogin,
          authorType: input.author?.__typename ?? undefined,
          authorAssociation: input.authorAssociation ?? undefined,
        })
      ) {
        isFirstTimeAuthor = false;
      } else if (authorMergedCounts.has(authorLogin)) {
        authorMergedCount = authorMergedCounts.get(authorLogin);
        if (authorMergedCount !== undefined) {
          isFirstTimeAuthor =
            input.state === "MERGED" ? authorMergedCount <= 1 : authorMergedCount === 0;
        }
      }
    }

    const entry = buildReviewFeedbackEntry({
      pr: input,
      installer,
      isFirstTimeAuthor,
      authorMergedCount,
      collectedAt,
    });

    cacheMap.set(getReviewFeedbackCorpusKey(entry.repository, entry.number), entry);
    if (entry.entryType === "feedback") {
      newFeedbackCount++;
    } else {
      newNoFeedbackCount++;
    }
  }

  return {
    entries: [...cacheMap.values()].sort(
      (a, b) => b.number - a.number || a.repository.localeCompare(b.repository),
    ),
    stats: {
      candidateCount: totalObservedCandidates,
      reusedFromCacheCount,
      fetchedCount: fetchedDetails.length,
      skippedByBudgetCount,
      newFeedbackCount: newFeedbackCount,
      newNoFeedbackCount: newNoFeedbackCount,
      incompleteCount,
      blobFetchCount: blobTargets.length,
    },
  };
}
