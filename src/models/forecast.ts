/**
 * 待機ライン（前線・正常底）の推移から基準 PR のマージ時期を予想するモデルの型定義。
 */

import type { FirstReviewFrontierMode, PrInterventionSummary } from "./depths";

/** 初回提出者の底の先頭（起票が最古の初回提出者 PR）の 1 回分の観測 */
export interface FirstTimerFrontierSample {
  /** 観測時刻（UTC ミリ秒） */
  timestampMs: number;
  /** 先頭 PR の番号 */
  pr: number;
  /** 先頭 PR の起票時刻（UTC ミリ秒） */
  createdMs: number;
}

/** マージ正常底（健康的大底）の先頭（起票が最古の健康な PR）の 1 回分の観測 */
export interface HealthyFrontierSample {
  /** 観測時刻（UTC ミリ秒） */
  timestampMs: number;
  /** 先頭 PR の番号 */
  pr: number;
  /** 先頭 PR の起票時刻（UTC ミリ秒） */
  createdMs: number;
}

/** 未レビュー（完全未着手）正常底の先頭（起票が最古の健康な PR）の 1 回分の観測（旧 v3 用） */
export interface UnreviewedFrontierSample {
  /** 観測時刻（UTC ミリ秒） */
  timestampMs: number;
  /** 先頭 PR の番号 */
  pr: number;
  /** 先頭 PR の起票時刻（UTC ミリ秒） */
  createdMs: number;
}

/** 主戦場ライン方式（直近 7 日間の初回人間介入コホートの起票日時中央値）の 1 回分の観測（v4 以降） */
export interface MainstreamFrontierSample {
  /** 観測時刻（UTC ミリ秒） */
  timestampMs: number;
  /** 主戦場ライン（起票日時の中央値、UTC ミリ秒） */
  createdMs: number;
  /** コホート件数合計（Open + Merged） */
  cohortCount: number;
  /** オープン中 PR 件数 */
  openCount: number;
  /** 直近マージ済み PR 件数 */
  mergedCount: number;
  /** 指標モード識別子（旧未着手底との混在ガード用） */
  mode: FirstReviewFrontierMode;
}

export type FirstReviewForecastStatus =
  | "no-samples"
  | "no-target"
  /** 基準 PR 自身に人間レビューまたは手動コメントが付与済み（初回レビュー・介入到達済み） */
  | "target-intervened"
  /** 主戦場ライン（起票日時中央値）が基準 PR の起票時刻に到達済み */
  | "reached"
  /** 主戦場ラインを現在位置スナップショット＋定常ペース（1.0 日/日）換算で観測中 */
  | "steady";

export interface FirstReviewForecast {
  /** 主戦場ライン（初回人間介入コホート）のスナップショット状態 */
  status: FirstReviewForecastStatus;
  /** 最新の主戦場ライン位置（旧互換で pr はオプショナル） */
  frontier: {
    pr?: number;
    createdMs: number;
    observedMs: number;
    cohortCount: number;
    openCount: number;
    mergedCount: number;
  } | null;
  /** 先頭の経過日数: 観測時刻 − 先頭の起票時刻（日） */
  lagDays: number | null;
  /** 基準 PR の起票時刻 − 先頭の起票時刻（日）。0 以下なら前線が基準 PR に到達済み */
  gapDays: number | null;
  /** 基準 PR 自身の介入判定結果（未記録時は null） */
  targetIntervention: PrInterventionSummary | null;
  /** 基準 PR 自身の第三者 Assignees 一覧（互換・補助表示用） */
  targetAssignees: string[];
  /** 定常ペース（速度 1.0 日/日）仮定での目安日数 */
  steadyEtaDays: number | null;
  /** 定常ペース（速度 1.0 日/日）仮定での到達目安日（UTC ミリ秒） */
  steadyDateMs: number | null;
}

/**
 * 通算所要日数ベースの予想: 直近にマージされた PR の起票からマージまでの日数（通算所要日数）が、
 * 基準 PR の起票日に対しても同じ分布で成り立つと仮定する。作成順に近い消化なら、
 * 更新の入れ替わりの影響を受けないため、速度ベースの ETA の妥当性を見る目安になる。
 */
export interface LifetimeForecast {
  /** 予想に使った通算所要日数の中央値（日） */
  medianDays: number;
  /** 中央値で見たマージ予想日（UTC ミリ秒） */
  medianDateMs: number;
  /** 観測時点から中央値の予想日までの日数。超過済みなら 0 */
  medianEtaDays: number;
  /** 基準 PR の経過日数が、すでに中央値を超えているか */
  exceededMedian: boolean;
  /** 75%点で見たマージ予想日（UTC ミリ秒）。75%点が不明なら null */
  p75DateMs: number | null;
  /** 観測時点から 75%点の予想日までの日数。超過済みなら 0。不明なら null */
  p75EtaDays: number | null;
}
