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
import type { SampleCacheEntry } from "../models/sample-cache";
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
import { simulateReadySince } from "./progress";
import { fromCachedSample, indexSampleCache, toCachedSample } from "./sample-cache";

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

export async function orchestrateSampleCollection(
  params: CollectSamplesParams,
): Promise<CollectSamplesResult> {
  const {
    client,
    repository,
    candidates,
    overallSinceDate,
    fetchBudget,
    initialCache,
    onCacheUpdated,
  } = params;

  const candidateAuthorCounts = countCandidateAuthors(candidates);
  const samples: MergedCandidateSample[] = [];
  const skippedCandidates: { number: number; mergedAt: Date }[] = [];
  let skipped = 0;

  const cacheIndex = indexSampleCache(initialCache);
  let cacheModified = false;
  let fetched = 0;
  let deferred = 0;

  try {
    for (const cand of candidates) {
      const cached = cacheIndex.get(cand.number);
      const mergedAtStr = cand.pull_request?.merged_at ?? cand.updated_at;
      const mergedAt = new Date(mergedAtStr);
      const isWithinOverallWindow = mergedAt.getTime() >= overallSinceDate.getTime();
      const candAuthor = cand.author;
      const candAuthorCount = candAuthor ? (candidateAuthorCounts.get(candAuthor) ?? 0) : 0;

      if (cached) {
        let needsReevaluation = false;

        if (cached.Type === "skipped" && cached.Reason === "not-first-timer-candidate") {
          const isEligibleNow = isCandidateEligibleForFirstTimerDetail(
            {
              commitCount: cand.commitCount,
              isDraft: cand.is_draft,
              labels: cand.labels,
              author: cand.author,
            },
            candidateAuthorCounts,
          );
          needsReevaluation = shouldReevaluateSkippedCandidate({
            isWithinOverallWindow,
            isEligibleForDetail: isEligibleNow,
          });
        } else if (cached.Type === "sample") {
          const shouldReevaluate = shouldReevaluateCachedSample({
            isFirstTimer: cached.IsFirstTimer,
            firstTimerReason: cached.FirstTimerReason,
            firstTimerVersion: cached.FirstTimerVersion,
            commitCount: cached.CommitCount,
            authorCountInCandidates: candAuthorCount,
          });

          if (shouldReevaluate) {
            if (fetched < fetchBudget) {
              needsReevaluation = true;
            }
          } else if (
            cached.IsFirstTimer === false &&
            (cached.FirstTimerVersion === undefined ||
              cached.FirstTimerVersion < CURRENT_FIRST_TIMER_VERSION) &&
            cached.FirstTimerReason === undefined &&
            cached.CommitCount > 1 &&
            candAuthorCount > 1
          ) {
            cached.FirstTimerReason = "recurring-author";
            cached.FirstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
            cacheModified = true;
          }
        }

        if (!needsReevaluation) {
          if (cached.Type === "sample") {
            const s = fromCachedSample(cached);
            samples.push(s);
          } else {
            skipped++;
            skippedCandidates.push({ number: cand.number, mergedAt: new Date(cached.MergedAt) });
          }
          continue;
        }
      }

      if (!isWithinOverallWindow) {
        const isEligible = isCandidateEligibleForFirstTimerDetail(
          {
            commitCount: cand.commitCount,
            isDraft: cand.is_draft,
            labels: cand.labels,
            author: cand.author,
          },
          candidateAuthorCounts,
        );

        if (!isEligible) {
          skipped++;
          skippedCandidates.push({ number: cand.number, mergedAt });
          const skippedEntry: SampleCacheEntry = {
            Type: "skipped",
            Number: cand.number,
            MergedAt: mergedAt.toISOString(),
            Reason: "not-first-timer-candidate",
          };
          cacheIndex.set(cand.number, skippedEntry);
          cacheModified = true;
          continue;
        }
      }

      if (fetched >= fetchBudget) {
        deferred++;
        continue;
      }
      fetched++;

      try {
        const candTimeline = await client.getIssueTimeline(repository, cand.number);
        const readyAt = simulateReadySince(candTimeline, Boolean(cand.is_draft), mergedAt);

        if (!readyAt) {
          skipped++;
          skippedCandidates.push({ number: cand.number, mergedAt });
          const skippedEntry: SampleCacheEntry = {
            Type: "skipped",
            Number: cand.number,
            MergedAt: mergedAt.toISOString(),
            Reason: "no-ready",
          };
          cacheIndex.set(cand.number, skippedEntry);
          cacheModified = true;
          continue;
        }

        const readyDays = (mergedAt.getTime() - readyAt.getTime()) / DAY_MS;
        if (readyDays < 0) {
          skipped++;
          skippedCandidates.push({ number: cand.number, mergedAt });
          const skippedEntry: SampleCacheEntry = {
            Type: "skipped",
            Number: cand.number,
            MergedAt: mergedAt.toISOString(),
            Reason: "negative-ready",
          };
          cacheIndex.set(cand.number, skippedEntry);
          cacheModified = true;
          continue;
        }

        const candDetail = await client.getPullRequestDetails(repository, cand.number);
        const candCreatedAt = new Date(candDetail.createdAt);
        const candCommits = candDetail.commits;
        const candLatestCommit =
          candCommits.length > 0 ? candCommits[candCommits.length - 1] : null;
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
        samples.push(sample);
        const newCached = toCachedSample(sample);
        cacheIndex.set(cand.number, newCached);
        cacheModified = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`マージ済み PR #${cand.number} のサンプル計測に失敗しました: ${msg}`, {
          cause: err,
        });
      }
    }

    // 初回提出者判定
    const authorCounts = new Map<string, number>();
    for (const s of samples) {
      if (s.author) {
        authorCounts.set(s.author, (authorCounts.get(s.author) ?? 0) + 1);
      }
    }
    for (const s of samples) {
      const countInCandidates = s.author ? (candidateAuthorCounts.get(s.author) ?? 0) : 0;
      const countInSamples = s.author ? (authorCounts.get(s.author) ?? 0) : 0;
      if (countInCandidates > 1 || countInSamples > 1) {
        if (s.isFirstTimer !== false) {
          s.isFirstTimer = false;
          s.firstTimerReason = "recurring-author";
          s.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
          const cached = cacheIndex.get(s.number);
          if (cached && cached.Type === "sample") {
            cached.IsFirstTimer = false;
            cached.FirstTimerReason = "recurring-author";
            cached.FirstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
            cacheModified = true;
          }
        }
      }
    }

    const candidateAuthors = extractSingleHitCandidateLogins(samples);
    if (candidateAuthors.length > 0) {
      const authorMergedCounts = await resolveAuthorMergedCounts(
        repository,
        candidateAuthors,
        (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query),
        { batchSize: 30 },
      );

      for (const s of samples) {
        if (s.author && authorMergedCounts.has(s.author)) {
          const count = authorMergedCounts.get(s.author);
          if (count !== undefined) {
            s.isFirstTimer = count === 1;
            s.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
            if (count !== 1) {
              s.firstTimerReason = "lifetime-merged";
            }
            const cached = cacheIndex.get(s.number);
            if (cached && cached.Type === "sample") {
              cached.IsFirstTimer = s.isFirstTimer;
              cached.FirstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
              if (count !== 1) {
                cached.FirstTimerReason = "lifetime-merged";
              }
              cacheModified = true;
            }
          }
        }
      }
    }
  } finally {
    if (cacheModified && onCacheUpdated) {
      onCacheUpdated(Array.from(cacheIndex.values()));
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
