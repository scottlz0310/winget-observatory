/**
 * マージ済み PR のサンプリング・キャッシュ管理・初回提出者判定・詳細取得のオーケストレーション。
 * 外部通信クライアントをインターフェース経由で受け取り、API レイヤーへの直接依存を持たない純粋なドメイン関数として提供する。
 */

import type {
  GitHubDetailedSearchItem,
  MergedCandidateSample,
  ProgressPrDetail,
  ProgressTimelineEvent,
} from "../models/progress";
import type { CachedSkippedEntry, SampleCacheEntry } from "../models/sample-cache";
import {
  CURRENT_FIRST_TIMER_VERSION,
  countCandidateAuthors,
  extractSingleHitCandidateLogins,
  isCandidateEligibleForFirstTimerDetail,
  isFirstTimerSampleCandidate,
  resolveAuthorMergedCounts,
  shouldReevaluateCachedSample,
  shouldReevaluateSkippedCandidate,
} from "./first-timer";
import { DAY_MS, round2 } from "./formatters";
import { fromCachedSample, indexSampleCache, toCachedSample } from "./sample-cache";
import { simulateReadySince } from "./timeline";

export interface SampleCollectorClient {
  getIssueTimeline(repo: string, prNumber: number): Promise<ProgressTimelineEvent[]>;
  getPullRequestDetails(repo: string, prNumber: number): Promise<ProgressPrDetail>;
  graphql<T = unknown>(query: string): Promise<T>;
}

export interface CollectSamplesParams {
  client: SampleCollectorClient;
  repository: string;
  candidates: GitHubDetailedSearchItem[];
  overallSinceDate: Date;
  fetchBudget: number;
  initialCache: SampleCacheEntry[];
  onCacheUpdated?: (entries: SampleCacheEntry[]) => void;
}

export interface CollectSamplesResult {
  samples: MergedCandidateSample[];
  skippedCandidates: { number: number; mergedAt: Date }[];
  skippedCount: number;
  fetchedCount: number;
  deferredCount: number;
  cacheModified: boolean;
  finalCache: SampleCacheEntry[];
}

type FetchCandidateOutcome =
  | { kind: "sample"; sample: MergedCandidateSample; cacheEntry: SampleCacheEntry }
  | { kind: "skipped"; skippedEntry: CachedSkippedEntry };

interface CachedCandidateResolution {
  needsReevaluation: boolean;
  updatedEntry?: SampleCacheEntry;
}

function createSkippedEntry(
  prNumber: number,
  mergedAt: Date,
  reason: CachedSkippedEntry["Reason"],
): CachedSkippedEntry {
  return {
    Type: "skipped",
    Number: prNumber,
    MergedAt: mergedAt.toISOString(),
    Reason: reason,
  };
}

function isCandidateEligible(
  cand: GitHubDetailedSearchItem,
  candidateAuthorCounts: Map<string, number>,
): boolean {
  return isCandidateEligibleForFirstTimerDetail(
    {
      commitCount: cand.commitCount,
      isDraft: cand.is_draft,
      labels: cand.labels,
      author: cand.author,
    },
    candidateAuthorCounts,
  );
}

/**
 * キャッシュヒット時の再評価要否および既存エントリのバージョン補完を判定する。
 */
function resolveCachedCandidate(params: {
  cand: GitHubDetailedSearchItem;
  cached: SampleCacheEntry;
  isWithinOverallWindow: boolean;
  candidateAuthorCounts: Map<string, number>;
  canFetchMore: boolean;
}): CachedCandidateResolution {
  const { cand, cached, isWithinOverallWindow, candidateAuthorCounts, canFetchMore } = params;
  const candAuthorCount = cand.author ? (candidateAuthorCounts.get(cand.author) ?? 0) : 0;

  if (cached.Type === "skipped" && cached.Reason === "not-first-timer-candidate") {
    const needsReevaluation = shouldReevaluateSkippedCandidate({
      isWithinOverallWindow,
      isEligibleForDetail: isCandidateEligible(cand, candidateAuthorCounts),
    });
    return { needsReevaluation };
  }

  if (cached.Type === "sample") {
    const shouldReevaluate = shouldReevaluateCachedSample({
      isFirstTimer: cached.IsFirstTimer,
      firstTimerReason: cached.FirstTimerReason,
      firstTimerVersion: cached.FirstTimerVersion,
      commitCount: cached.CommitCount,
      authorCountInCandidates: candAuthorCount,
    });

    if (shouldReevaluate) {
      return { needsReevaluation: canFetchMore };
    }

    if (
      cached.IsFirstTimer === false &&
      (cached.FirstTimerVersion === undefined ||
        cached.FirstTimerVersion < CURRENT_FIRST_TIMER_VERSION) &&
      cached.FirstTimerReason === undefined &&
      cached.CommitCount > 1 &&
      candAuthorCount > 1
    ) {
      return {
        needsReevaluation: false,
        updatedEntry: {
          ...cached,
          FirstTimerReason: "recurring-author",
          FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        },
      };
    }
  }

  return { needsReevaluation: false };
}

/**
 * 全体集計窓（30日等）外の候補について、初回提出者候補になり得ない場合に事前スキップエントリを生成する。
 */
function createOutsideWindowPreSkipEntry(
  cand: GitHubDetailedSearchItem,
  mergedAt: Date,
  isWithinOverallWindow: boolean,
  candidateAuthorCounts: Map<string, number>,
): CachedSkippedEntry | null {
  if (isWithinOverallWindow) {
    return null;
  }
  if (isCandidateEligible(cand, candidateAuthorCounts)) {
    return null;
  }
  return createSkippedEntry(cand.number, mergedAt, "not-first-timer-candidate");
}

/**
 * 未キャッシュ候補 PR のタイムラインと詳細を取得し、待機指標を計測する。
 */
async function fetchUncachedCandidateSample(
  client: SampleCollectorClient,
  repository: string,
  cand: GitHubDetailedSearchItem,
  mergedAt: Date,
): Promise<FetchCandidateOutcome> {
  try {
    const candTimeline = await client.getIssueTimeline(repository, cand.number);
    const readyAt = simulateReadySince(candTimeline, Boolean(cand.is_draft), mergedAt);

    if (!readyAt) {
      return {
        kind: "skipped",
        skippedEntry: createSkippedEntry(cand.number, mergedAt, "no-ready"),
      };
    }

    const readyDays = (mergedAt.getTime() - readyAt.getTime()) / DAY_MS;
    if (readyDays < 0) {
      return {
        kind: "skipped",
        skippedEntry: createSkippedEntry(cand.number, mergedAt, "negative-ready"),
      };
    }

    const candDetail = await client.getPullRequestDetails(repository, cand.number);
    const candCreatedAt = new Date(candDetail.createdAt);
    const candCommits = candDetail.commits;
    const candLatestCommit = candCommits.length > 0 ? candCommits[candCommits.length - 1] : null;
    const candLatestCommittedDate = candLatestCommit
      ? new Date(candLatestCommit.committedDate)
      : candCreatedAt;

    const totalDays = (mergedAt.getTime() - candCreatedAt.getTime()) / DAY_MS;
    const turnDays = (mergedAt.getTime() - candLatestCommittedDate.getTime()) / DAY_MS;

    const isCandidate = isFirstTimerSampleCandidate({
      commitCount: candCommits.length,
      timeline: candTimeline,
      isDraft: Boolean(cand.is_draft),
    });

    const sample: MergedCandidateSample = {
      number: cand.number,
      title: cand.title,
      createdAt: candDetail.createdAt,
      latestCommittedDate: candLatestCommittedDate.toISOString(),
      commitCount: candCommits.length,
      readyAt: readyAt.toISOString(),
      mergedAt: mergedAt.toISOString(),
      totalDays: round2(totalDays),
      turnDays: round2(turnDays),
      days: round2(readyDays),
      author: candDetail.author,
      firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
      ...(!isCandidate
        ? {
            isFirstTimer: false,
            firstTimerReason: "timeline-blocking",
          }
        : {}),
    };

    return { kind: "sample", sample, cacheEntry: toCachedSample(sample) };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`マージ済み PR #${cand.number} のサンプル計測に失敗しました: ${msg}`, {
      cause: err,
    });
  }
}

function syncFirstTimerMetadataToCache(
  cacheIndex: Map<number, SampleCacheEntry>,
  sample: MergedCandidateSample,
): boolean {
  const cached = cacheIndex.get(sample.number);
  if (cached?.Type !== "sample") {
    return false;
  }
  cached.IsFirstTimer = sample.isFirstTimer;
  cached.FirstTimerVersion = sample.firstTimerVersion;
  if (sample.firstTimerReason !== undefined) {
    cached.FirstTimerReason = sample.firstTimerReason;
  }
  return true;
}

/**
 * バッチ内の複数回登場著者を常連（recurring-author）として確定し、キャッシュへ反映する。
 */
function markRecurringBatchAuthors(
  samples: MergedCandidateSample[],
  candidateAuthorCounts: Map<string, number>,
  cacheIndex: Map<number, SampleCacheEntry>,
): boolean {
  let modified = false;

  const sampleAuthorCounts = new Map<string, number>();
  for (const s of samples) {
    if (s.author) {
      sampleAuthorCounts.set(s.author, (sampleAuthorCounts.get(s.author) ?? 0) + 1);
    }
  }

  for (const s of samples) {
    const countInCandidates = s.author ? (candidateAuthorCounts.get(s.author) ?? 0) : 0;
    const countInSamples = s.author ? (sampleAuthorCounts.get(s.author) ?? 0) : 0;
    if ((countInCandidates > 1 || countInSamples > 1) && s.isFirstTimer !== false) {
      s.isFirstTimer = false;
      s.firstTimerReason = "recurring-author";
      s.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
      if (syncFirstTimerMetadataToCache(cacheIndex, s)) {
        modified = true;
      }
    }
  }

  return modified;
}

/**
 * 単発候補著者の生涯マージ数を GraphQL で一括解決し、サンプルとキャッシュを更新する。
 */
async function resolveSingleHitAuthorMergedCounts(params: {
  samples: MergedCandidateSample[];
  cacheIndex: Map<number, SampleCacheEntry>;
  client: SampleCollectorClient;
  repository: string;
}): Promise<boolean> {
  const { samples, cacheIndex, client, repository } = params;
  const candidateAuthors = extractSingleHitCandidateLogins(samples);
  if (candidateAuthors.length === 0) {
    return false;
  }

  const authorMergedCounts = await resolveAuthorMergedCounts(
    repository,
    candidateAuthors,
    (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query),
    { batchSize: 30 },
  );

  let modified = false;
  for (const s of samples) {
    if (!s.author || !authorMergedCounts.has(s.author)) continue;
    const count = authorMergedCounts.get(s.author);
    if (count === undefined) continue;

    s.isFirstTimer = count === 1;
    s.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
    if (count !== 1) {
      s.firstTimerReason = "lifetime-merged";
    }
    if (syncFirstTimerMetadataToCache(cacheIndex, s)) {
      modified = true;
    }
  }

  return modified;
}

/**
 * マージ済み候補群のサンプリング・キャッシュ解決・初回提出者判定をオーケストレーションする。
 */
export async function orchestrateSampleCollection(
  params: CollectSamplesParams,
): Promise<CollectSamplesResult> {
  const { client, repository, candidates, overallSinceDate, fetchBudget, initialCache } = params;
  const candidateAuthorCounts = countCandidateAuthors(candidates);
  const samples: MergedCandidateSample[] = [];
  const skippedCandidates: { number: number; mergedAt: Date }[] = [];
  const cacheIndex = indexSampleCache(initialCache);

  let skipped = 0;
  let cacheModified = false;
  let fetched = 0;
  let deferred = 0;

  const recordSkipped = (prNumber: number, mergedAt: Date, entry?: CachedSkippedEntry) => {
    skipped++;
    skippedCandidates.push({ number: prNumber, mergedAt });
    if (entry) {
      cacheIndex.set(prNumber, entry);
      cacheModified = true;
    }
  };

  try {
    for (const cand of candidates) {
      const mergedAt = new Date(cand.pull_request?.merged_at ?? cand.updated_at);
      const isWithinOverallWindow = mergedAt.getTime() >= overallSinceDate.getTime();
      const cached = cacheIndex.get(cand.number);

      if (cached) {
        const resolution = resolveCachedCandidate({
          cand,
          cached,
          isWithinOverallWindow,
          candidateAuthorCounts,
          canFetchMore: fetched < fetchBudget,
        });
        if (!resolution.needsReevaluation) {
          const entry = resolution.updatedEntry ?? cached;
          if (resolution.updatedEntry) {
            cacheIndex.set(cand.number, resolution.updatedEntry);
            cacheModified = true;
          }
          if (entry.Type === "sample") {
            samples.push(fromCachedSample(entry));
          } else {
            recordSkipped(cand.number, new Date(entry.MergedAt));
          }
          continue;
        }
      }

      const preSkipEntry = createOutsideWindowPreSkipEntry(
        cand,
        mergedAt,
        isWithinOverallWindow,
        candidateAuthorCounts,
      );
      if (preSkipEntry) {
        recordSkipped(cand.number, mergedAt, preSkipEntry);
        continue;
      }

      if (fetched >= fetchBudget) {
        deferred++;
        continue;
      }
      fetched++;

      const outcome = await fetchUncachedCandidateSample(client, repository, cand, mergedAt);
      if (outcome.kind === "skipped") {
        recordSkipped(cand.number, mergedAt, outcome.skippedEntry);
      } else {
        samples.push(outcome.sample);
        cacheIndex.set(cand.number, outcome.cacheEntry);
        cacheModified = true;
      }
    }

    if (markRecurringBatchAuthors(samples, candidateAuthorCounts, cacheIndex)) {
      cacheModified = true;
    }
    if (
      await resolveSingleHitAuthorMergedCounts({
        samples,
        cacheIndex,
        client,
        repository,
      })
    ) {
      cacheModified = true;
    }
  } finally {
    if (cacheModified && params.onCacheUpdated) {
      params.onCacheUpdated(Array.from(cacheIndex.values()));
    }
  }

  return {
    samples,
    skippedCandidates,
    skippedCount: skipped,
    fetchedCount: fetched,
    deferredCount: deferred,
    cacheModified,
    finalCache: Array.from(cacheIndex.values()),
  };
}
