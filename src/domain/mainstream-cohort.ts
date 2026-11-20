/**
 * 直近 7 日間の初回人間介入コホート（主戦場ライン）の重複排除・中央値・ラグ日数を集計する純粋関数群。
 * 外部 I/O を行わず、src/models の型定義と同一ドメイン内のモジュールだけに依存する。
 */

import type {
  FirstReviewCohortItem,
  FirstReviewFrontier,
  PrInterventionSummary,
} from "../models/depths";
import { calculateNumericMedian, DAY_MS, round1 } from "./formatters";

/** 主戦場ライン（初回介入コホート中央値）のモード識別子 */
export const FIRST_REVIEW_MAINSTREAM_MODE = "cohort-median-7d" as const;

/** 主戦場ラインのコホート集計窓（日） */
export const FIRST_REVIEW_COHORT_WINDOW_DAYS = 7;

/** スナップショットに保存するコホート内訳アイテムの最大件数 */
export const FIRST_REVIEW_COHORT_ITEM_LIMIT = 30;

export interface FirstReviewCohortCandidate {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED";
  author?: string;
  authorAssociation?: string;
  authorMergedCount?: number;
  isFirstTimer?: boolean;
  commitCount?: number;
  createdAt: string;
  mergedAt?: string | null;
  intervention: PrInterventionSummary;
}

/**
 * オープン中・直近マージ済みの初回提出者 PR 候補群から、
 * 最初の人間介入日時（FirstHumanInterventionAt）が [now - windowDays, now] に入る PR を抽出し、
 * 起票日時（CreatedAt）の中央値に基づく「主戦場ライン」を集計する。
 */
export function calculateFirstReviewMainstreamFrontier(
  candidates: readonly FirstReviewCohortCandidate[],
  observedAt: Date | string | number,
  options: { windowDays?: number; itemLimit?: number } = {},
): FirstReviewFrontier {
  const windowDays = options.windowDays ?? FIRST_REVIEW_COHORT_WINDOW_DAYS;
  const itemLimit = options.itemLimit ?? FIRST_REVIEW_COHORT_ITEM_LIMIT;
  const observedMs =
    observedAt instanceof Date
      ? observedAt.getTime()
      : typeof observedAt === "number"
        ? observedAt
        : Date.parse(observedAt);

  if (!Number.isFinite(observedMs)) {
    return {
      Mode: FIRST_REVIEW_MAINSTREAM_MODE,
      WindowDays: windowDays,
      CohortCount: 0,
      OpenCount: 0,
      MergedCount: 0,
      MedianCreatedAt: null,
      LagDays: null,
      OldestCreatedAt: null,
      NewestCreatedAt: null,
      Items: [],
    };
  }

  const windowStartMs = observedMs - windowDays * DAY_MS;
  // 同一 PR がオープン探索・マージキャッシュの両方に現れた場合は後続または MERGED 状態を優先して重複排除
  const deduped = new Map<
    number,
    {
      candidate: FirstReviewCohortCandidate;
      createdMs: number;
      interventionMs: number;
    }
  >();

  for (const candidate of candidates) {
    if (!candidate.intervention.FirstHumanInterventionAt) {
      continue;
    }
    const createdMs = Date.parse(candidate.createdAt);
    const interventionMs = Date.parse(candidate.intervention.FirstHumanInterventionAt);
    if (!Number.isFinite(createdMs) || !Number.isFinite(interventionMs)) {
      continue;
    }
    if (interventionMs < windowStartMs || interventionMs > observedMs) {
      continue;
    }
    const existing = deduped.get(candidate.number);
    if (!existing || (existing.candidate.state === "OPEN" && candidate.state === "MERGED")) {
      deduped.set(candidate.number, { candidate, createdMs, interventionMs });
    }
  }

  const entries = [...deduped.values()];
  if (entries.length === 0) {
    return {
      Mode: FIRST_REVIEW_MAINSTREAM_MODE,
      WindowDays: windowDays,
      CohortCount: 0,
      OpenCount: 0,
      MergedCount: 0,
      MedianCreatedAt: null,
      LagDays: null,
      OldestCreatedAt: null,
      NewestCreatedAt: null,
      Items: [],
    };
  }

  const sortedCreatedMs = entries.map((e) => e.createdMs).sort((a, b) => a - b);
  const medianCreatedMs = calculateNumericMedian(sortedCreatedMs);
  const openCount = entries.filter((e) => e.candidate.state === "OPEN").length;
  const mergedCount = entries.filter((e) => e.candidate.state === "MERGED").length;

  const items: FirstReviewCohortItem[] = entries
    .sort((a, b) => b.interventionMs - a.interventionMs || b.candidate.number - a.candidate.number)
    .slice(0, itemLimit)
    .map(({ candidate }) => ({
      Number: candidate.number,
      Title: candidate.title,
      Url: candidate.url,
      State: candidate.state,
      ...(candidate.author !== undefined ? { Author: candidate.author } : {}),
      ...(candidate.authorAssociation !== undefined
        ? { AuthorAssociation: candidate.authorAssociation }
        : {}),
      ...(candidate.authorMergedCount !== undefined
        ? { AuthorMergedCount: candidate.authorMergedCount }
        : {}),
      ...(candidate.isFirstTimer !== undefined ? { IsFirstTimer: candidate.isFirstTimer } : {}),
      ...(candidate.commitCount !== undefined ? { CommitCount: candidate.commitCount } : {}),
      CreatedAt: candidate.createdAt,
      FirstHumanInterventionAt: candidate.intervention.FirstHumanInterventionAt as string,
      ...(candidate.intervention.FirstInterventionKind
        ? { InterventionKind: candidate.intervention.FirstInterventionKind }
        : {}),
      ...(candidate.intervention.FirstInterventionActor
        ? { InterventionActor: candidate.intervention.FirstInterventionActor }
        : {}),
      ...(candidate.mergedAt !== undefined ? { MergedAt: candidate.mergedAt } : {}),
    }));

  return {
    Mode: FIRST_REVIEW_MAINSTREAM_MODE,
    WindowDays: windowDays,
    CohortCount: entries.length,
    OpenCount: openCount,
    MergedCount: mergedCount,
    MedianCreatedAt: medianCreatedMs !== null ? new Date(medianCreatedMs).toISOString() : null,
    LagDays: medianCreatedMs !== null ? round1((observedMs - medianCreatedMs) / DAY_MS) : null,
    OldestCreatedAt: new Date(sortedCreatedMs[0]).toISOString(),
    NewestCreatedAt: new Date(sortedCreatedMs[sortedCreatedMs.length - 1]).toISOString(),
    Items: items,
  };
}
