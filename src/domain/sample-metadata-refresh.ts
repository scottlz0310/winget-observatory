/**
 * タイムライン再計算不要で最新バージョンの作者メタデータが未補完なサンプルを
 * 軽量 GraphQL alias バッチで段階的に補完・昇格する純粋オーケストレーション関数。
 */

import type { MergedCandidateSample } from "../models/progress";
import type { CachedSampleEntry, SampleCacheEntry } from "../models/sample-cache";
import {
  CURRENT_FIRST_TIMER_VERSION,
  DEFAULT_AUTHOR_METADATA_BATCH_SIZE,
  isPrivilegedOrBotAuthor,
  type PullRequestAuthorMetadataQueryResponse,
  resolvePullRequestAuthorMetadata,
  shouldReevaluateCachedSample,
} from "./first-timer";
import {
  DEFAULT_METADATA_REFRESH_BUDGET,
  selectMetadataRefreshCandidates,
} from "./sample-cache-maintenance";

export interface RefreshLegacyAuthorMetadataParams {
  cacheIndex: Map<number, SampleCacheEntry>;
  samples?: MergedCandidateSample[];
  client: {
    graphql<T = unknown>(query: string): Promise<T>;
  };
  repository: string;
  now?: Date;
  windowDays?: number;
  budget?: number;
  batchSize?: number;
  /** ReadyAt 再計測不要とみなす最低バージョン（テスト等で将来バージョン切替検証用） */
  minReadyVersion?: number;
  /** 到達目標とする最新バージョン（既定: CURRENT_FIRST_TIMER_VERSION） */
  targetVersion?: number;
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
    minReadyVersion,
    targetVersion = CURRENT_FIRST_TIMER_VERSION,
  } = params;

  const targets = selectMetadataRefreshCandidates(Array.from(cacheIndex.values()), {
    now,
    windowDays,
    budget,
    minReadyVersion,
    targetVersion,
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
    const requiresFirstTimerReeval =
      !privilegedOrBot &&
      shouldReevaluateCachedSample({
        isFirstTimer: existing.IsFirstTimer,
        firstTimerReason: existing.FirstTimerReason,
        firstTimerVersion: existing.FirstTimerVersion,
        commitCount: existing.CommitCount,
        authorCountInCandidates: 1,
        author: existing.Author,
        minReadyVersion,
        currentVersion: targetVersion,
      });

    const updated: CachedSampleEntry = {
      ...existing,
      ...(nextAuthor !== undefined ? { Author: nextAuthor } : {}),
      ...(nextAuthorType !== undefined ? { AuthorType: nextAuthorType } : {}),
      ...(nextAuthorAssociation !== undefined ? { AuthorAssociation: nextAuthorAssociation } : {}),
      ...(requiresFirstTimerReeval ? {} : { FirstTimerVersion: targetVersion }),
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
      sample.firstTimerVersion = targetVersion;
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
