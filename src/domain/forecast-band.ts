/**
 * 統合処理バンド（前線・本命中央値・大底）モデルを算出する純粋関数群。
 * 外部 I/O を行わず、src/models の型定義と同一ドメイン内のモジュールだけに依存する。
 */

import type { HistoryRecord } from "../models/dashboard";
import type { DepthsSnapshot, PrInterventionSummary } from "../models/depths";
import type { MainstreamFrontierSample } from "../models/forecast";
import type {
  BandPointEstimate,
  BandPointKey,
  ForecastBandRange,
  ForecastBandSnapshot,
  ForecastBottomBand,
  ForecastFrontBand,
  ForecastMainstreamBand,
} from "../models/forecast-band";
import type { ProgressSnapshot } from "../models/progress";
import { parseTimestampToMs } from "./dashboard";
import { calculateFirstReviewForecast } from "./forecast";
import { buildForecastSource, calculateForecastComparison } from "./forecast-comparison";
import { calculateNumericMedian, DAY_MS, round1 } from "./formatters";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "./intervention";

const positiveDays = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

function parseIsoOrJstMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = parseTimestampToMs(value);
  return Number.isFinite(ms) ? ms : null;
}

export interface ForecastBandSource {
  nowMs: number;
  targetCreatedMs: number;
  activeAhead: number;
  totalMedianDays?: number | null;
  totalP75Days?: number | null;
  firstTimerMedianDays?: number | null;
  firstTimerP75Days?: number | null;
  history: HistoryRecord[];
  lookbackDays?: number;
  firstTimerLookbackDays?: number;
  staleBottomPr: number | null;
  staleBottomCreatedMs: number | null;
  healthyBottomPr: number | null;
  healthyBottomCreatedMs: number | null;
  mainstreamSamples: MainstreamFrontierSample[];
  targetIntervention: PrInterventionSummary | null;
  targetThirdPartyAssignees: string[];
}

/**
 * progress / depths / history / mainstreamFrontierSamples から、
 * 処理バンドおよび既存 2 仮説比較に共通で使う入力ソースを組み立てる（SSoT）。
 */
export function buildForecastBandSource(input: {
  progress: Partial<ProgressSnapshot> | null;
  depths: Partial<DepthsSnapshot> | null;
  history: HistoryRecord[];
  mainstreamFrontierSamples?: MainstreamFrontierSample[];
}): ForecastBandSource {
  const { progress, depths, history, mainstreamFrontierSamples } = input;
  const base = buildForecastSource({ progress, depths, history });

  const staleHead = depths?.StaleBottom?.[0];
  const staleBottomCreatedMs =
    parseIsoOrJstMs(staleHead?.CreatedAt) ?? parseIsoOrJstMs(staleHead?.UpdatedAt);

  const healthyHead = depths?.HealthyBottom?.[0];
  const healthyBottomCreatedMs =
    parseIsoOrJstMs(healthyHead?.CreatedAt) ?? parseIsoOrJstMs(progress?.FrontCreatedAt);

  let samples = mainstreamFrontierSamples ?? [];
  if (samples.length === 0 && depths?.FirstReviewFrontier && depths.Timestamp) {
    const frontier = depths.FirstReviewFrontier;
    const tsMs = Date.parse(depths.Timestamp);
    const createdMs = frontier.MedianCreatedAt ? Date.parse(frontier.MedianCreatedAt) : Number.NaN;
    if (
      frontier.Mode === FIRST_REVIEW_MAINSTREAM_MODE &&
      frontier.CohortCount > 0 &&
      Number.isFinite(tsMs) &&
      Number.isFinite(createdMs)
    ) {
      samples = [
        {
          timestampMs: tsMs,
          createdMs,
          cohortCount: frontier.CohortCount,
          openCount: frontier.OpenCount,
          mergedCount: frontier.MergedCount,
          mode: frontier.Mode,
        },
      ];
    }
  }

  return {
    ...base,
    firstTimerMedianDays: progress?.FirstTimerMedianDays,
    firstTimerP75Days: progress?.FirstTimerP75Days,
    staleBottomPr: staleHead?.Number ?? null,
    staleBottomCreatedMs,
    healthyBottomPr:
      healthyHead?.Number ?? (progress?.FrontNumber ? Number(progress.FrontNumber) : null),
    healthyBottomCreatedMs,
    mainstreamSamples: samples,
    targetIntervention: depths?.TargetPr?.Intervention ?? null,
    targetThirdPartyAssignees: depths?.TargetPr?.ThirdPartyAssignees ?? [],
  };
}

function clampEstimate(
  nowMs: number,
  key: BandPointKey,
  label: string,
  rawDateMs: number,
): BandPointEstimate {
  const dateMs = Math.max(nowMs, rawDateMs);
  return {
    key,
    label,
    dateMs,
    etaDays: Math.max(0, round1((dateMs - nowMs) / DAY_MS)),
  };
}

function summarizeBandRange(nowMs: number, dateMsList: number[]): ForecastBandRange | null {
  if (dateMsList.length === 0) return null;
  const startMs = Math.min(...dateMsList);
  const endMs = Math.max(...dateMsList);
  return {
    startMs,
    endMs,
    minDays: Math.max(0, round1((startMs - nowMs) / DAY_MS)),
    maxDays: Math.max(0, round1((endMs - nowMs) / DAY_MS)),
  };
}

/**
 * 処理バンド（前線・本命中央値・大底）およびスナップショット指標を算出する。
 * 観測時刻（nowMs）が不明な場合は予想レンジをすべて null とする。
 */
export function calculateForecastBand(source: ForecastBandSource): ForecastBandSnapshot {
  const { nowMs, targetCreatedMs } = source;
  const comparison = calculateForecastComparison(source);
  const firstReview = calculateFirstReviewForecast(
    source.mainstreamSamples,
    Number.isFinite(targetCreatedMs) ? targetCreatedMs : null,
    {
      targetIntervention: source.targetIntervention,
      targetThirdPartyAssignees: source.targetThirdPartyAssignees,
    },
  );

  const hasTarget = Number.isFinite(targetCreatedMs);
  const staleBottomGapDays =
    hasTarget && source.staleBottomCreatedMs !== null
      ? round1((targetCreatedMs - source.staleBottomCreatedMs) / DAY_MS)
      : null;
  const healthyBottomGapDays =
    hasTarget && source.healthyBottomCreatedMs !== null
      ? round1((targetCreatedMs - source.healthyBottomCreatedMs) / DAY_MS)
      : null;

  const snapshot = {
    staleBottomPr: source.staleBottomPr,
    staleBottomCreatedMs: source.staleBottomCreatedMs,
    staleBottomGapDays,
    healthyBottomPr: source.healthyBottomPr,
    healthyBottomCreatedMs: source.healthyBottomCreatedMs,
    healthyBottomGapDays,
    firstReview,
  };

  if (!Number.isFinite(nowMs)) {
    return {
      nowMs,
      targetCreatedMs,
      front: null,
      mainstream: null,
      bottom: null,
      overallRange: null,
      snapshot,
      comparison,
    };
  }

  // 1. 前線（最短目安）: 初回コホート P50 と 優等生の底の定常換算
  const frontEstimates: BandPointEstimate[] = [];
  const ftMedian = positiveDays(source.firstTimerMedianDays);
  if (hasTarget && ftMedian !== undefined) {
    frontEstimates.push(
      clampEstimate(
        nowMs,
        "first-timer:p50",
        "初回提出者コホート P50",
        targetCreatedMs + ftMedian * DAY_MS,
      ),
    );
  }
  if (hasTarget && source.staleBottomCreatedMs !== null) {
    const gapMs = Math.max(0, targetCreatedMs - source.staleBottomCreatedMs);
    frontEstimates.push(
      clampEstimate(nowMs, "stale-bottom:steady", "優等生の底（定常 1.0 日/日）", nowMs + gapMs),
    );
  }
  const frontRange = summarizeBandRange(
    nowMs,
    frontEstimates.map((e) => e.dateMs),
  );
  const front: ForecastFrontBand | null =
    frontRange && frontEstimates.length > 0
      ? {
          range: frontRange,
          dateMs: frontRange.startMs,
          etaDays: frontRange.minDays,
          estimates: frontEstimates,
        }
      : null;

  // 2. 中央値（本命ライン）: 作成順全体 P50・初回 P75・順位消化・主戦場ライン定常換算の統合帯
  const mainstreamEstimates: BandPointEstimate[] = [];
  const creationMedian = comparison.hypotheses
    .find((h) => h.id === "creation-order")
    ?.estimates.find((e) => e.key === "creation-order:median");
  if (creationMedian) {
    mainstreamEstimates.push(
      clampEstimate(nowMs, "creation-order:median", "作成順（全体 P50）", creationMedian.dateMs),
    );
  }
  const ftP75 = positiveDays(source.firstTimerP75Days);
  if (hasTarget && ftP75 !== undefined) {
    mainstreamEstimates.push(
      clampEstimate(
        nowMs,
        "first-timer:p75",
        "初回提出者コホート P75",
        targetCreatedMs + ftP75 * DAY_MS,
      ),
    );
  }
  const rankVelocity = comparison.hypotheses
    .find((h) => h.id === "rank-velocity")
    ?.estimates.find((e) => e.key === "rank-velocity");
  if (rankVelocity) {
    mainstreamEstimates.push(
      clampEstimate(nowMs, "rank-velocity", "① 順位消化（168h 速度）", rankVelocity.dateMs),
    );
  }
  if (firstReview.status === "steady" && firstReview.steadyEtaDays !== null) {
    mainstreamEstimates.push(
      clampEstimate(
        nowMs,
        "mainstream-steady",
        "主戦場ライン（定常 1.0 日/日）",
        nowMs + firstReview.steadyEtaDays * DAY_MS,
      ),
    );
  }
  const mainstreamRange = summarizeBandRange(
    nowMs,
    mainstreamEstimates.map((e) => e.dateMs),
  );
  const sortedMainstreamDates = mainstreamEstimates.map((e) => e.dateMs).sort((a, b) => a - b);
  const medianDateMs = calculateNumericMedian(sortedMainstreamDates);
  const mainstream: ForecastMainstreamBand | null =
    mainstreamRange && medianDateMs !== null && mainstreamEstimates.length > 0
      ? {
          range: mainstreamRange,
          medianDateMs,
          medianEtaDays: Math.max(0, round1((medianDateMs - nowMs) / DAY_MS)),
          estimates: mainstreamEstimates,
        }
      : null;

  // 3. 大底（最長目安）: 健康的大底（最古健康 PR）の定常換算
  let bottom: ForecastBottomBand | null = null;
  if (hasTarget && source.healthyBottomCreatedMs !== null) {
    const gapMs = Math.max(0, targetCreatedMs - source.healthyBottomCreatedMs);
    const estimate = clampEstimate(
      nowMs,
      "healthy-bottom:steady",
      "健康的大底（定常 1.0 日/日）",
      nowMs + gapMs,
    );
    bottom = {
      dateMs: estimate.dateMs,
      etaDays: estimate.etaDays,
      estimate,
    };
  }

  // 4. 全体レンジ（前線〜大底）
  const overallDates: number[] = [];
  if (front) {
    overallDates.push(front.range.startMs, front.range.endMs);
  }
  if (mainstream) {
    overallDates.push(mainstream.range.startMs, mainstream.range.endMs);
  }
  if (bottom) {
    overallDates.push(bottom.dateMs);
  }
  const overallRange = summarizeBandRange(nowMs, overallDates);

  return {
    nowMs,
    targetCreatedMs,
    front,
    mainstream,
    bottom,
    overallRange,
    snapshot,
    comparison,
  };
}
