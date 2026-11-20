/**
 * 統合処理バンド（前線〜本命中央値〜大底）予想モデルの型定義。
 * 外部依存を持たない純粋な TypeScript 型定義のみを提供する。
 */

import type { FirstReviewForecast } from "./forecast";
import type { ForecastComparison } from "./forecast-comparison";

export type BandPointKey =
  | "first-timer:p50"
  | "creation-order:median"
  | "first-timer:p75"
  | "rank-velocity"
  | "mainstream-steady"
  | "healthy-bottom:steady";

export interface BandPointEstimate {
  key: BandPointKey;
  label: string;
  /** 予想日（UTC ミリ秒） */
  dateMs: number;
  /** 観測時点からの残り目安日数 */
  etaDays: number;
}

export interface ForecastBandRange {
  startMs: number;
  endMs: number;
  minDays: number;
  maxDays: number;
}

export interface ForecastFrontBand {
  range: ForecastBandRange;
  /** 最短目安の代表日（最も早い日付、UTC ミリ秒） */
  dateMs: number;
  etaDays: number;
  estimates: BandPointEstimate[];
}

export interface ForecastMainstreamBand {
  range: ForecastBandRange;
  /** 本命中央値の代表日（採用指標の中央値、UTC ミリ秒） */
  medianDateMs: number;
  medianEtaDays: number;
  estimates: BandPointEstimate[];
}

export interface ForecastBottomBand {
  dateMs: number;
  etaDays: number;
  estimate: BandPointEstimate;
}

export interface ForecastBandSnapshot {
  /** 観測時刻（UTC ミリ秒）。不明なら NaN */
  nowMs: number;
  /** 基準 PR の起票時刻（UTC ミリ秒）。不明なら NaN */
  targetCreatedMs: number;
  /** 前線（最短目安） */
  front: ForecastFrontBand | null;
  /** 中央値（本命ライン） */
  mainstream: ForecastMainstreamBand | null;
  /** 大底（最長目安） */
  bottom: ForecastBottomBand | null;
  /** 全体レンジ（前線〜大底） */
  overallRange: ForecastBandRange | null;
  /** 現在の処理帯スナップショット */
  snapshot: {
    healthyBottomPr: number | null;
    healthyBottomCreatedMs: number | null;
    healthyBottomGapDays: number | null;
    firstReview: FirstReviewForecast;
  };
  /** 検証用に保持する既存 2 仮説の比較結果 */
  comparison: ForecastComparison;
}
