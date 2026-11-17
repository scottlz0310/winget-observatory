/**
 * マージ時期の 2 つの仮説（順位消化・作成順）による予想を 1 つに束ねる純粋関数群。
 * 外部 I/O を行わず、src/models の型定義と同一ドメイン内のモジュールだけに依存する。
 */

import type { HistoryRecord } from "../models/dashboard";
import type { DepthsSnapshot } from "../models/depths";
import type {
  ForecastComparison,
  ForecastEstimate,
  HypothesisSummary,
} from "../models/forecast-comparison";
import type { ProgressSnapshot } from "../models/progress";
import { calculateVelocityMetrics } from "./dashboard";
import { calculateLifetimeForecast } from "./forecast";
import { DAY_MS, round1 } from "./formatters";

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_FIRST_TIMER_LOOKBACK_DAYS = 90;
const positiveDays = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

export interface ForecastComparisonSource {
  /** 観測時刻（UTC ミリ秒）。不明なら NaN */
  nowMs: number;
  /** 基準 PR の起票時刻（UTC ミリ秒）。不明なら NaN */
  targetCreatedMs: number;
  /** 現在の実質待ち件数（更新順の順位） */
  activeAhead: number;
  /** 通算所要日数の中央値・75%点（旧スナップショットでは無い） */
  totalMedianDays?: number | null;
  totalP75Days?: number | null;
  /** 現在の定義（更新順）で記録された履歴 */
  history: HistoryRecord[];
  /** 全体マージ実績の集計期間（日）。省略時は 30 */
  lookbackDays?: number;
  /** 初回提出者コホートの集計期間（日）。省略時は lookbackDays または 90 */
  firstTimerLookbackDays?: number;
}

function estimate(
  nowMs: number,
  key: string,
  label: string,
  dateMs: number,
  primary: boolean,
): ForecastEstimate {
  return {
    key,
    label,
    dateMs,
    etaDays: Math.max(0, round1((dateMs - nowMs) / DAY_MS)),
    primary,
  };
}

function summarizeRankVelocity(source: ForecastComparisonSource, nowMs: number): HypothesisSummary {
  const velocity = calculateVelocityMetrics(source.history, source.activeAhead);
  const latest = source.history[source.history.length - 1];
  const estimates: ForecastEstimate[] = [];
  let progressText: string;

  if (velocity.velocityPerDay === null) {
    progressText = `実質待ち ${source.activeAhead.toLocaleString("en-US")} 件。速度を測る観測が足りません（30 分以上の推移が必要）`;
  } else {
    const windowSpan = `${(velocity.sampleHours / 24).toFixed(1)} 日（${velocity.sampleHours.toFixed(1)} 時間）`;
    if (velocity.velocityPerDay <= 0 || velocity.etaDays === null || !latest) {
      progressText = `実質待ち ${source.activeAhead.toLocaleString("en-US")} 件。直近 ${windowSpan}は停滞または後退中（${velocity.velocityPerDay} 件/日）`;
    } else {
      progressText = `実質待ち ${source.activeAhead.toLocaleString("en-US")} 件。直近 ${windowSpan}で ${velocity.consumedCount} 件減（${velocity.velocityPerDay} 件/日）`;
      estimates.push(
        estimate(
          nowMs,
          "rank-velocity",
          "現在の消化速度が続く場合",
          latest.timestampMs + velocity.etaDays * DAY_MS,
          true,
        ),
      );
    }
  }

  return {
    id: "rank-velocity",
    title: "① 順位消化",
    premise: "実質待ち件数（更新順の順位）が、直近の速度で減り続ける",
    progressText,
    progressRatio: null,
    estimates,
    note: "前にいた PR が更新されて順位が入れ替わった分も減少に含むため、実際の消化より速く出ることがあります（内訳は「待ち行列からの離脱の内訳」を参照）",
  };
}

function summarizeCreationOrder(
  source: ForecastComparisonSource,
  nowMs: number,
): HypothesisSummary {
  const lifetime = calculateLifetimeForecast(
    source.targetCreatedMs,
    source.totalMedianDays,
    source.totalP75Days,
    nowMs,
  );
  const estimates: ForecastEstimate[] = [];
  let progressText = "通算所要日数の統計または基準 PR の起票日時が未記録です";
  let progressRatio: number | null = null;

  if (lifetime) {
    const elapsedMs = nowMs - source.targetCreatedMs;
    progressRatio = Math.min(1, Math.max(0, elapsedMs / (lifetime.medianDays * DAY_MS)));
    progressText = `起票から ${round1(elapsedMs / DAY_MS)} 日 / 通算所要日数の中央値 ${lifetime.medianDays} 日（${Math.round(progressRatio * 100)}%）${lifetime.exceededMedian ? "。中央値を超過" : ""}`;
    estimates.push(
      estimate(
        nowMs,
        "creation-order:median",
        "中央値の日数でマージされる場合",
        lifetime.medianDateMs,
        true,
      ),
    );
    if (lifetime.p75DateMs !== null) {
      estimates.push(
        estimate(
          nowMs,
          "creation-order:p75",
          "75%点の日数でマージされる場合",
          lifetime.p75DateMs,
          false,
        ),
      );
    }
  }

  const lookbackDays = positiveDays(source.lookbackDays) ?? DEFAULT_LOOKBACK_DAYS;
  const firstTimerLookbackDays =
    positiveDays(source.firstTimerLookbackDays) ??
    positiveDays(source.lookbackDays) ??
    DEFAULT_FIRST_TIMER_LOOKBACK_DAYS;

  return {
    id: "creation-order",
    title: "② 作成順",
    premise: `直近（${lookbackDays}日間）の全体マージ実績（常連・特急含む）の通算所要日数が基準 PR にも当てはまる（作成順に近く消化される）`,
    progressText,
    progressRatio,
    estimates,
    note: `更新の入れ替わりの影響を受けない（上部の初回提出者${firstTimerLookbackDays}日コホート統計とは母集団が異なります）`,
  };
}

/**
 * 2 つの仮説（順位消化・作成順）による予想日を束ね、主な予想日の範囲を求める。
 * 観測時刻が不明なときは、日付の基準が無いため、どの仮説も予想日を出さない。
 */
export function calculateForecastComparison(source: ForecastComparisonSource): ForecastComparison {
  const nowMs = source.nowMs;

  const hypotheses = [summarizeRankVelocity(source, nowMs), summarizeCreationOrder(source, nowMs)];

  if (!Number.isFinite(nowMs)) {
    return {
      nowMs,
      hypotheses: hypotheses.map((h) => ({
        ...h,
        progressText: "観測時刻が不明なため予想できません",
        progressRatio: null,
        estimates: [],
      })),
      range: null,
    };
  }

  const primary = hypotheses.flatMap((h) => h.estimates).filter((e) => e.primary);
  const range =
    primary.length === 0
      ? null
      : {
          startMs: Math.min(...primary.map((e) => e.dateMs)),
          endMs: Math.max(...primary.map((e) => e.dateMs)),
          minDays: Math.min(...primary.map((e) => e.etaDays)),
          maxDays: Math.max(...primary.map((e) => e.etaDays)),
        };

  return { nowMs, hypotheses, range };
}

/**
 * 最新の進捗スナップショット・境界探索スナップショットと履歴から、比較の入力を組み立てる。
 * ダッシュボードの表示と、予想日の履歴への記録で、同じ入力になるようここに集約する。
 *
 * 観測時刻は進捗スナップショットの Timestamp を優先し、無ければ履歴の最新観測、
 * 境界探索スナップショットの順に使う。
 */
export function buildForecastSource(input: {
  progress: Partial<ProgressSnapshot> | null;
  depths: Partial<DepthsSnapshot> | null;
  /** 現在の定義（更新順）で記録された履歴 */
  history: HistoryRecord[];
}): ForecastComparisonSource {
  const { progress, depths, history } = input;
  const lookbackDays = positiveDays(progress?.LookbackDays);
  const firstTimerLookbackDays = positiveDays(progress?.FirstTimerLookbackDays) ?? lookbackDays;
  const parsedDepthsTimestampMs = depths?.Timestamp ? Date.parse(depths.Timestamp) : Number.NaN;
  return {
    nowMs:
      Date.parse(progress?.Timestamp ?? "") ||
      history[history.length - 1]?.timestampMs ||
      (Number.isFinite(parsedDepthsTimestampMs) ? parsedDepthsTimestampMs : Number.NaN),
    targetCreatedMs: Date.parse(depths?.TargetPr?.CreatedAt ?? ""),
    activeAhead: Number(progress?.ActiveAhead) || 0,
    totalMedianDays: progress?.TotalMedianDays,
    totalP75Days: progress?.TotalP75Days,
    history,
    lookbackDays,
    firstTimerLookbackDays,
  };
}
