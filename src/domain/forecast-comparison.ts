/**
 * マージ時期の 3 つの仮説（順位消化・更新順・作成順）による予想を 1 つに束ねる純粋関数群。
 * 外部 I/O を行わず、src/models の型定義と同一ドメイン内のモジュールだけに依存する。
 */

import type { HistoryRecord } from "../models/dashboard";
import type { DepthsSnapshot } from "../models/depths";
import type { StaleFrontierForecast, StaleFrontierSample } from "../models/forecast";
import type {
  ForecastComparison,
  ForecastEstimate,
  HypothesisSummary,
} from "../models/forecast-comparison";
import type { ProgressSnapshot } from "../models/progress";
import { calculateVelocityMetrics } from "./dashboard";
import { calculateLifetimeForecast, calculateStaleFrontierForecast } from "./forecast";
import { DAY_MS, round1 } from "./formatters";

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_FIRST_TIMER_LOOKBACK_DAYS = 90;
const positiveDays = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;

/** 観測速度モデルが算出できない理由の説明 */
export const FORECAST_UNAVAILABLE_TEXT: Record<string, string> = {
  "no-samples": "優等生の底の観測がありません",
  "no-target": "基準 PR の更新時刻が未記録です（次回の観測から記録されます）",
  "insufficient-window": "速度を測る観測期間が足りません（6 時間以上の間隔が必要）",
  "no-progress": "観測期間内に先頭が進んでいないため算出できません",
};

export interface ForecastComparisonSource {
  /** 観測時刻（UTC ミリ秒）。不明なら NaN */
  nowMs: number;
  /** 基準 PR の起票時刻（UTC ミリ秒）。不明なら NaN */
  targetCreatedMs: number;
  /** 基準 PR の最終更新時刻（UTC ミリ秒）。不明なら null */
  targetUpdatedMs: number | null;
  /** 現在の実質待ち件数（更新順の順位） */
  activeAhead: number;
  /** 通算所要日数の中央値・75%点（旧スナップショットでは無い） */
  totalMedianDays?: number | null;
  /** 現在の定義（更新順）で記録された履歴 */
  totalP75Days?: number | null;
  history: HistoryRecord[];
  /** 優等生の底の先頭の観測列 */
  frontierSamples: StaleFrontierSample[];
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

function summarizeUpdateOrder(stale: StaleFrontierForecast, nowMs: number): HypothesisSummary {
  const estimates: ForecastEstimate[] = [];
  const parts: string[] = [];

  if (stale.frontier === null) {
    parts.push(FORECAST_UNAVAILABLE_TEXT["no-samples"]);
  } else {
    const base = stale.frontier.observedMs;
    parts.push(
      `先頭 #${stale.frontier.pr} の遅れ ${stale.lagDays ?? "-"} 日 / 基準 PR との更新差 ${stale.gapDays ?? "-"} 日`,
    );
    if (stale.steadyEtaDays !== null) {
      estimates.push(
        estimate(
          nowMs,
          "update-order:steady",
          "先頭が実時間と同じ速度（1 日/日）で進む場合",
          base + stale.steadyEtaDays * DAY_MS,
          true,
        ),
      );
    }
    if (stale.observedEtaDays !== null) {
      estimates.push(
        estimate(
          nowMs,
          "update-order:observed",
          "実測した先頭の進みが続く場合",
          base + stale.observedEtaDays * DAY_MS,
          true,
        ),
      );
    }
    parts.push(
      stale.observedUnavailable
        ? `実測の進み: ${FORECAST_UNAVAILABLE_TEXT[stale.observedUnavailable] ?? stale.observedUnavailable}`
        : `実測の進み: ${stale.observedSpeed} 日/日（直近 ${stale.windowHours} 時間）`,
    );
  }

  return {
    id: "update-order",
    title: "② 更新順",
    premise:
      "更新の古い順に処理され、優等生の底の先頭が基準 PR の更新時刻に届いた時点でマージされる",
    progressText: parts.join("。"),
    progressRatio: null,
    estimates,
    note: null,
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
    title: "③ 作成順",
    premise: `直近（${lookbackDays}日間）の全体マージ実績（常連・特急含む）の通算所要日数が基準 PR にも当てはまる（作成順に近く消化される）`,
    progressText,
    progressRatio,
    estimates,
    note: `更新の入れ替わりの影響を受けない（上部の初回提出者${firstTimerLookbackDays}日コホート統計とは母集団が異なります）`,
  };
}

/**
 * 3 つの仮説（順位消化・更新順・作成順）による予想日を束ね、主な予想日の範囲を求める。
 * 観測時刻が不明なときは、日付の基準が無いため、どの仮説も予想日を出さない。
 */
export function calculateForecastComparison(source: ForecastComparisonSource): ForecastComparison {
  const stale = calculateStaleFrontierForecast(source.frontierSamples, source.targetUpdatedMs);
  const nowMs = source.nowMs;

  const hypotheses = [
    summarizeRankVelocity(source, nowMs),
    summarizeUpdateOrder(stale, nowMs),
    summarizeCreationOrder(source, nowMs),
  ];

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
 * 遭難の底の最新観測の順に使う。
 */
export function buildForecastSource(input: {
  progress: Partial<ProgressSnapshot> | null;
  depths: Partial<DepthsSnapshot> | null;
  /** 現在の定義（更新順）で記録された履歴 */
  history: HistoryRecord[];
  frontierSamples: StaleFrontierSample[];
}): ForecastComparisonSource {
  const { progress, depths, history, frontierSamples } = input;
  const lookbackDays = positiveDays(progress?.LookbackDays);
  const firstTimerLookbackDays = positiveDays(progress?.FirstTimerLookbackDays) ?? lookbackDays;
  return {
    nowMs:
      Date.parse(progress?.Timestamp ?? "") ||
      history[history.length - 1]?.timestampMs ||
      frontierSamples[frontierSamples.length - 1]?.timestampMs ||
      Number.NaN,
    targetCreatedMs: Date.parse(depths?.TargetPr?.CreatedAt ?? ""),
    targetUpdatedMs: depths?.TargetPr?.UpdatedAt ? Date.parse(depths.TargetPr.UpdatedAt) : null,
    activeAhead: Number(progress?.ActiveAhead) || 0,
    totalMedianDays: progress?.TotalMedianDays,
    totalP75Days: progress?.TotalP75Days,
    history,
    frontierSamples,
    lookbackDays,
    firstTimerLookbackDays,
  };
}
