/**
 * 予想日の履歴（forecast-history.jsonl）と、実際のマージ日との答え合わせの型定義。
 *
 * 1 行 1 JSON。観測のたびに 3 つの仮説の予想日を記録し、基準 PR がマージされたら結果を記録する。
 */

import type { HypothesisId } from "./forecast-comparison";

/** 1 回の観測で、ある仮説・モデルが出した予想日 */
export interface ForecastRecordEstimate {
  /** 例: "update-order:steady" */
  Key: string;
  Hypothesis: HypothesisId;
  /** 予想日（ISO 8601, UTC） */
  Date: string;
  /** 観測時点から予想日までの日数 */
  EtaDays: number;
  /** 見出しの範囲に使った主な予想か */
  Primary: boolean;
}

/** 1 回の観測で記録した予想日の一覧 */
export interface ForecastRecord {
  Type: "forecast";
  /** 観測時刻（進捗スナップショットの Timestamp。ISO 8601, UTC） */
  Timestamp: string;
  Repository: string;
  TargetPr: number;
  Estimates: ForecastRecordEstimate[];
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
  hypothesis: HypothesisId;
  /** 採点に使った予想の件数（マージ前に記録されたもの） */
  count: number;
  meanErrorDays: number;
  meanAbsErrorDays: number;
  /** マージ直前に記録された最後の予想の誤差 */
  lastErrorDays: number;
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
}
