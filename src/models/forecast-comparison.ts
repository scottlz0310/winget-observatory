/**
 * マージ時期を 2 つの仮説（順位消化・作成順）で予想し、比較するための型定義。
 */

/** マージ時期を予想する現行 2 つの仮説 */
export type HypothesisId = "rank-velocity" | "creation-order";

/** 過去履歴互換用を含む仮説識別子（旧 update-order 行の読み込み用） */
export type LegacyHypothesisId = HypothesisId | "update-order";

/** ある仮説・モデルが出した予想日 1 件 */
export interface ForecastEstimate {
  /** 履歴・採点で個別に追えるキー（例: "rank-velocity", "creation-order:median"） */
  key: string;
  /** 画面に出す説明（どの前提・どの統計で出した予想か） */
  label: string;
  /** 予想日（UTC ミリ秒） */
  dateMs: number;
  /** 観測時点から予想日までの日数。到達済みなら 0 */
  etaDays: number;
  /** 見出しの範囲に使う主な予想か（補助の予想は false） */
  primary: boolean;
}

export interface HypothesisSummary {
  id: HypothesisId;
  /** 例: "① 順位消化" */
  title: string;
  /** 仮説の前提 */
  premise: string;
  /** 現在の進捗の説明。算出できない場合はその理由 */
  progressText: string;
  /** 進捗の割合（0〜1）。自然な割合が定義できる仮説だけ持つ */
  progressRatio: number | null;
  estimates: ForecastEstimate[];
  /** この仮説を読むときの注意 */
  note: string | null;
}

/** 3 つの仮説による予想の比較（ダッシュボードの最上部に出す） */
export interface ForecastComparison {
  /** 観測時刻（UTC ミリ秒） */
  nowMs: number;
  hypotheses: HypothesisSummary[];
  /** 主な予想日の範囲。予想が 1 件も無ければ null */
  range: { startMs: number; endMs: number; minDays: number; maxDays: number } | null;
}
