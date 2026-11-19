/**
 * マージ済み PR のサンプリング・キャッシュ管理・初回提出者判定・詳細取得のオーケストレーション。
 * 外部通信クライアントをインターフェース経由で受け取り、API レイヤーへの直接依存を持たない純粋なドメイン関数として提供する。
 */

import type {
  GitHubDetailedSearchItem,
  MergedCandidateSample,
  ProgressPrSampleData,
} from "../models/progress";
import type {
  CachedSampleEntry,
  CachedSkippedEntry,
  SampleCacheEntry,
} from "../models/sample-cache";
import {
  CURRENT_FIRST_TIMER_VERSION,
  countCandidateAuthors,
  DEFAULT_AUTHOR_MERGED_BATCH_SIZE,
  DEFAULT_AUTHOR_METADATA_BATCH_SIZE,
  extractSingleHitCandidateLogins,
  hasValidatedReadyVersion,
  isCandidateEligibleForFirstTimerDetail,
  isPrivilegedOrBotAuthor,
  type PullRequestAuthorMetadataQueryResponse,
  resolveAuthorMergedCounts,
  resolvePullRequestAuthorMetadata,
  shouldReevaluateAuthorFirstTimer,
  shouldReevaluateCachedSample,
  shouldReevaluateSkippedCandidate,
} from "./first-timer";
import { DAY_MS, round2 } from "./formatters";
import {
  DEFAULT_METADATA_REFRESH_BUDGET,
  fromCachedSample,
  indexSampleCache,
  selectMetadataRefreshCandidates,
  toCachedSample,
} from "./sample-cache";
import { simulateReadySince } from "./timeline";

export interface SampleCollectorClient {
  getPullRequestSampleData(repo: string, prNumber: number): Promise<ProgressPrSampleData>;
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
  needsAuthorReevaluation?: boolean;
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
    FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
  };
}

function isCandidateEligible(
  cand: GitHubDetailedSearchItem,
  candidateAuthorCounts: Map<string, number>,
): boolean {
  return isCandidateEligibleForFirstTimerDetail({ author: cand.author }, candidateAuthorCounts);
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

  if (cached.Type === "skipped") {
    const shouldReevaluate = shouldReevaluateSkippedCandidate({
      reason: cached.Reason,
      firstTimerVersion: cached.FirstTimerVersion,
      isWithinOverallWindow,
      isEligibleForDetail: isCandidateEligible(cand, candidateAuthorCounts),
    });
    if (cached.Reason === "no-ready") {
      return { needsReevaluation: shouldReevaluate && canFetchMore };
    }
    return { needsReevaluation: shouldReevaluate };
  }

  if (cached.Type === "sample") {
    const shouldReevaluate = shouldReevaluateCachedSample({
      isFirstTimer: cached.IsFirstTimer,
      firstTimerReason: cached.FirstTimerReason,
      firstTimerVersion: cached.FirstTimerVersion,
      commitCount: cached.CommitCount,
      authorCountInCandidates: candAuthorCount,
      author: cached.Author,
    });

    if (shouldReevaluate && canFetchMore) {
      return { needsReevaluation: true };
    }

    if (
      !shouldReevaluate &&
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: cached.FirstTimerReason,
        firstTimerVersion: cached.FirstTimerVersion,
        author: cached.Author,
      })
    ) {
      return { needsReevaluation: false, needsAuthorReevaluation: true };
    }

    if (
      cached.IsFirstTimer === false &&
      cached.FirstTimerReason === undefined &&
      cached.CommitCount > 1 &&
      candAuthorCount > 1
    ) {
      return {
        needsReevaluation: false,
        updatedEntry: {
          ...cached,
          FirstTimerReason: "recurring-author",
          ...(hasValidatedReadyVersion(cached.FirstTimerVersion)
            ? { FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION }
            : {}),
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
 * 未キャッシュ候補 PR のタイムラインとサンプル詳細を 1 クエリで取得し、待機指標を計測する。
 */
async function fetchUncachedCandidateSample(
  client: SampleCollectorClient,
  repository: string,
  cand: GitHubDetailedSearchItem,
  mergedAt: Date,
): Promise<FetchCandidateOutcome> {
  try {
    const sampleData = await client.getPullRequestSampleData(repository, cand.number);
    const candTimeline = sampleData.timeline;
    const readyAt = simulateReadySince(candTimeline, false, mergedAt);

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

    const candCreatedAt = new Date(sampleData.createdAt);
    const candLatestCommittedDate = new Date(sampleData.latestCommittedDate);
    const commitCount = sampleData.commitCount;

    const totalDays = (mergedAt.getTime() - candCreatedAt.getTime()) / DAY_MS;
    const turnDays = (mergedAt.getTime() - candLatestCommittedDate.getTime()) / DAY_MS;

    const sample: MergedCandidateSample = {
      number: cand.number,
      title: cand.title,
      createdAt: sampleData.createdAt,
      latestCommittedDate: candLatestCommittedDate.toISOString(),
      commitCount,
      readyAt: readyAt.toISOString(),
      mergedAt: mergedAt.toISOString(),
      totalDays: round2(totalDays),
      turnDays: round2(turnDays),
      days: round2(readyDays),
      author: sampleData.author ?? cand.author,
      ...(sampleData.authorType !== undefined ? { authorType: sampleData.authorType } : {}),
      ...(sampleData.authorAssociation !== undefined
        ? { authorAssociation: sampleData.authorAssociation }
        : {}),
      firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
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
  const updated: CachedSampleEntry = {
    ...cached,
    IsFirstTimer: sample.isFirstTimer,
    ...(sample.firstTimerVersion !== undefined
      ? { FirstTimerVersion: sample.firstTimerVersion }
      : {}),
  };
  if (sample.firstTimerReason !== undefined) {
    updated.FirstTimerReason = sample.firstTimerReason;
  } else {
    delete updated.FirstTimerReason;
  }
  cacheIndex.set(sample.number, updated);
  return true;
}

/**
 * 特権ロール（MEMBER / OWNER / COLLABORATOR）または Bot のサンプルを初回対象外（privileged-or-bot）として確定する。
 */
function markPrivilegedOrBotAuthors(
  samples: MergedCandidateSample[],
  cacheIndex: Map<number, SampleCacheEntry>,
): boolean {
  let modified = false;

  for (const s of samples) {
    if (!isPrivilegedOrBotAuthor(s) || s.isFirstTimer === false) {
      continue;
    }
    s.isFirstTimer = false;
    s.firstTimerReason = "privileged-or-bot";
    if (hasValidatedReadyVersion(s.firstTimerVersion)) {
      s.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
    }
    if (syncFirstTimerMetadataToCache(cacheIndex, s)) {
      modified = true;
    }
  }

  return modified;
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
      if (hasValidatedReadyVersion(s.firstTimerVersion)) {
        s.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
      }
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
  authorCountCache: Map<string, number>;
}): Promise<boolean> {
  const { samples, cacheIndex, client, repository, authorCountCache } = params;
  const candidateAuthors = extractSingleHitCandidateLogins(samples);
  if (candidateAuthors.length === 0) {
    return false;
  }

  const authorMergedCounts = await resolveAuthorMergedCounts(
    repository,
    candidateAuthors,
    (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query),
    { batchSize: DEFAULT_AUTHOR_MERGED_BATCH_SIZE, cache: authorCountCache },
  );

  let modified = false;
  for (const s of samples) {
    if (!s.author || !authorMergedCounts.has(s.author)) continue;
    const count = authorMergedCounts.get(s.author);
    if (count === undefined) continue;

    s.isFirstTimer = count === 1;
    if (hasValidatedReadyVersion(s.firstTimerVersion)) {
      s.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
    }
    if (count !== 1) {
      s.firstTimerReason = "lifetime-merged";
    } else {
      delete s.firstTimerReason;
    }
    if (syncFirstTimerMetadataToCache(cacheIndex, s)) {
      modified = true;
    }
  }

  return modified;
}

/**
 * 走査窓外のキャッシュ等に残存する旧版 timeline-blocking レコード（Author 保存済み）について、
 * タイムラインを再取得せず累計マージ実績のみで初回提出者判定を再評価・更新する。
 */
async function resolveRemainingTimelineBlockingCacheEntries(params: {
  cacheIndex: Map<number, SampleCacheEntry>;
  candidateNumbers: ReadonlySet<number>;
  client: SampleCollectorClient;
  repository: string;
  authorCountCache: Map<string, number>;
}): Promise<boolean> {
  const { cacheIndex, candidateNumbers, client, repository, authorCountCache } = params;
  const pendingEntries: CachedSampleEntry[] = [];
  const pendingAuthors: string[] = [];

  for (const entry of cacheIndex.values()) {
    if (entry.Type !== "sample" || candidateNumbers.has(entry.Number)) continue;
    if (
      !shouldReevaluateAuthorFirstTimer({
        firstTimerReason: entry.FirstTimerReason,
        firstTimerVersion: entry.FirstTimerVersion,
        author: entry.Author,
      })
    ) {
      continue;
    }
    pendingEntries.push(entry);
    if (entry.Author) {
      pendingAuthors.push(entry.Author);
    }
  }

  if (pendingEntries.length === 0) {
    return false;
  }

  const authorMergedCounts = await resolveAuthorMergedCounts(
    repository,
    pendingAuthors,
    (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query),
    { batchSize: DEFAULT_AUTHOR_MERGED_BATCH_SIZE, cache: authorCountCache },
  );

  let modified = false;
  for (const entry of pendingEntries) {
    if (!entry.Author) continue;
    const count = authorMergedCounts.get(entry.Author);
    if (count === undefined) continue;

    const updated: CachedSampleEntry = {
      ...entry,
      IsFirstTimer: count === 1,
      FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
    };
    if (count !== 1) {
      updated.FirstTimerReason = "lifetime-merged";
    } else {
      delete updated.FirstTimerReason;
    }
    cacheIndex.set(entry.Number, updated);
    modified = true;
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
            const sample = fromCachedSample(entry);
            if (resolution.needsAuthorReevaluation) {
              sample.isFirstTimer = undefined;
              sample.firstTimerReason = undefined;
              sample.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
            }
            samples.push(sample);
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

    const authorCountCache = new Map<string, number>();
    if (markPrivilegedOrBotAuthors(samples, cacheIndex)) {
      cacheModified = true;
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
        authorCountCache,
      })
    ) {
      cacheModified = true;
    }
    const candidateNumbers = new Set(candidates.map((c) => c.number));
    if (
      await resolveRemainingTimelineBlockingCacheEntries({
        cacheIndex,
        candidateNumbers,
        client,
        repository,
        authorCountCache,
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

export interface RefreshLegacyAuthorMetadataParams {
  cacheIndex: Map<number, SampleCacheEntry>;
  samples?: MergedCandidateSample[];
  client: Pick<SampleCollectorClient, "graphql">;
  repository: string;
  now?: Date;
  windowDays?: number;
  budget?: number;
  batchSize?: number;
}

export interface RefreshLegacyAuthorMetadataResult {
  updatedCount: number;
  privilegedDemotedCount: number;
  cacheModified: boolean;
}

/**
 * タイムライン再計算不要で最新バージョンの作者メタデータが未補完なサンプルを
 * 軽量 GraphQL alias バッチで段階的に補完・昇格する。
 */
export async function refreshLegacyAuthorMetadata(
  params: RefreshLegacyAuthorMetadataParams,
): Promise<RefreshLegacyAuthorMetadataResult> {
  const {
    cacheIndex,
    samples,
    client,
    repository,
    now = new Date(),
    windowDays,
    budget = DEFAULT_METADATA_REFRESH_BUDGET,
    batchSize = DEFAULT_AUTHOR_METADATA_BATCH_SIZE,
  } = params;

  const targets = selectMetadataRefreshCandidates(Array.from(cacheIndex.values()), {
    now,
    windowDays,
    budget,
  });
  if (targets.length === 0) {
    return { updatedCount: 0, privilegedDemotedCount: 0, cacheModified: false };
  }

  const targetNumbers = targets.map((entry) => entry.Number);
  const resolved = await resolvePullRequestAuthorMetadata(
    repository,
    targetNumbers,
    (query) => client.graphql<PullRequestAuthorMetadataQueryResponse>(query),
    { batchSize },
  );

  if (resolved.size === 0) {
    return { updatedCount: 0, privilegedDemotedCount: 0, cacheModified: false };
  }

  const sampleByNumber = new Map<number, MergedCandidateSample>();
  if (samples) {
    for (const s of samples) {
      sampleByNumber.set(s.number, s);
    }
  }

  let updatedCount = 0;
  let privilegedDemotedCount = 0;

  for (const existing of targets) {
    const meta = resolved.get(existing.Number);
    if (!meta) continue;

    const nextAuthor = meta.author ?? existing.Author;
    const nextAuthorType = meta.authorType ?? existing.AuthorType;
    const nextAuthorAssociation = meta.authorAssociation ?? existing.AuthorAssociation;
    const privilegedOrBot = isPrivilegedOrBotAuthor({
      author: nextAuthor,
      authorType: nextAuthorType,
      authorAssociation: nextAuthorAssociation,
    });

    const updated: CachedSampleEntry = {
      ...existing,
      ...(nextAuthor !== undefined ? { Author: nextAuthor } : {}),
      ...(nextAuthorType !== undefined ? { AuthorType: nextAuthorType } : {}),
      ...(nextAuthorAssociation !== undefined ? { AuthorAssociation: nextAuthorAssociation } : {}),
      FirstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
    };

    if (privilegedOrBot) {
      if (existing.IsFirstTimer !== false) {
        privilegedDemotedCount++;
      }
      updated.IsFirstTimer = false;
      updated.FirstTimerReason = "privileged-or-bot";
    }

    cacheIndex.set(existing.Number, updated);
    updatedCount++;

    const sample = sampleByNumber.get(existing.Number);
    if (sample) {
      if (nextAuthor !== undefined) sample.author = nextAuthor;
      if (nextAuthorType !== undefined) sample.authorType = nextAuthorType;
      if (nextAuthorAssociation !== undefined) sample.authorAssociation = nextAuthorAssociation;
      sample.firstTimerVersion = CURRENT_FIRST_TIMER_VERSION;
      if (privilegedOrBot) {
        sample.isFirstTimer = false;
        sample.firstTimerReason = "privileged-or-bot";
      }
    }
  }

  return {
    updatedCount,
    privilegedDemotedCount,
    cacheModified: updatedCount > 0,
  };
}
