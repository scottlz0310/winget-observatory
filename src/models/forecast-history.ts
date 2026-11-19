/**
 * 予想日の履歴（forecast-history.jsonl）と、実際のマージ日との答え合わせの型定義。
 *
 * 1 行 1 JSON。観測のたびに予想日を記録し、基準 PR がマージされたら結果を記録する。
 * 廃止された旧仮説（update-order）を含む過去レコードの読み込み互換も保持する。
 */

import type { LegacyHypothesisId } from "./forecast-comparison";

/** 1 回の観測で、ある仮説・モデルが出した予想日 */
export interface ForecastRecordEstimate {
  /** 例: "rank-velocity", "creation-order:median"（過去レコードでは "update-order:steady" 等も含む） */
  Key: string;
  Hypothesis: LegacyHypothesisId;
  /** 予想日（ISO 8601, UTC） */
  Date: string;
  /** 観測時点から予想日までの日数 */
  EtaDays: number;
  /** 見出しの範囲に使った主な予想か */
  Primary: boolean;
}

/** 1 回の観測で記録した統合処理バンドの予想（ISO 8601, UTC） */
export interface ForecastBandRecord {
  /** 前線（最短目安）の代表日 */
  FrontDate: string | null;
  /** 本命中央値バンドの開始日 */
  MainstreamStartDate: string | null;
  /** 本命中央値バンドの終了日 */
  MainstreamEndDate: string | null;
  /** 本命中央値バンドの代表中央日 */
  MainstreamMedianDate: string | null;
  /** 大底（最長目安）の日付 */
  BottomDate: string | null;
  /** 全体レンジ（前線〜大底）の開始日 */
  OverallStartDate?: string | null;
  /** 全体レンジ（前線〜大底）の終了日 */
  OverallEndDate?: string | null;
}

/** 1 回の観測で記録した予想日の一覧 */
export interface ForecastRecord {
  Type: "forecast";
  /** 観測時刻（進捗スナップショットの Timestamp。ISO 8601, UTC） */
  Timestamp: string;
  Repository: string;
  TargetPr: number;
  Estimates: ForecastRecordEstimate[];
  /** 統合処理バンドの予想記録（対応版以降の行に付与） */
  Band?: ForecastBandRecord;
}

/** 基準 PR がマージされた結果 */
export interface ForecastOutcomeRecord {
  Type: "outcome";
  /** 結果を記録した時刻（ISO 8601, UTC） */
  Timestamp: string;
  Repository: string;
  TargetPr: number;
  /** 実際にマージされた時刻（ISO 8601, UTC） */
  MergedAt: string;
}

export type ForecastHistoryLine = ForecastRecord | ForecastOutcomeRecord;

/** あるキー（仮説・モデル）の予想の当たり具合。誤差は「予想日 − 実際のマージ日」（日）で、正なら予想が遅すぎた */
export interface ForecastKeyScore {
  key: string;
  hypothesis: LegacyHypothesisId;
  /** 採点に使った予想の件数（マージ前に記録されたもの） */
  count: number;
  meanErrorDays: number;
  meanAbsErrorDays: number;
  /** マージ直前に記録された最後の予想の誤差 */
  lastErrorDays: number;
}

/** 統合処理バンドの答え合わせ評価（JST 暦日基準のバンド内包含判定＋中央値誤差） */
export interface ForecastBandScore {
  /** 本命中央値バンドを記録していた観測回数 */
  count: number;
  /** 本命中央値バンド内に実マージ日が収まった回数 */
  mainstreamHitCount: number;
  /** 本命中央値バンド的中率（%） */
  mainstreamHitRatePct: number;
  /** マージ直前の最後の観測が本命中央値バンド内だったか */
  lastInMainstreamBand: boolean | null;
  /** 本命中央値代表日の平均誤差（予想 − 実績, 日） */
  medianMeanErrorDays: number | null;
  /** 本命中央値代表日の平均絶対誤差（日） */
  medianMeanAbsErrorDays: number | null;
  /** 最後の観測の本命中央値代表日誤差（日） */
  medianLastErrorDays: number | null;
  /** 全体レンジ（前線〜大底）を記録していた観測回数 */
  overallCount: number;
  /** 全体レンジ内に実マージ日が収まった回数 */
  overallHitCount: number;
  /** 全体レンジ包含率（%） */
  overallHitRatePct: number;
}

/** 1 つの基準 PR の答え合わせ */
export interface ForecastScore {
  repository: string;
  targetPr: number;
  /** 実際にマージされた時刻（UTC ミリ秒） */
  mergedAtMs: number;
  /** この PR の予想を記録した件数（観測の回数） */
  observationCount: number;
  keys: ForecastKeyScore[];
  /** 統合処理バンドの答え合わせ結果（バンド記録を含む場合のみ設定） */
  bandScore?: ForecastBandScore;
}
