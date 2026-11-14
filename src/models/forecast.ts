/**
 * 遭難の底（更新が最も古い健康な PR）の推移から基準 PR のマージ時期を予想するモデルの型定義。
 *
 * 遭難の底は、指摘が付かずにすぐ健康になり順番を待つだけの PR（基準 PR と同種）で、
 * 更新が古い順に処理されるなら、その更新時刻の進みが待ち行列の実質的な先頭の進みを表す。
 */

/** 遭難の底の先頭（更新が最古の健康な PR）の 1 回分の観測 */
export interface StaleFrontierSample {
  /** 観測時刻（UTC ミリ秒） */
  timestampMs: number;
  /** 先頭 PR の番号 */
  pr: number;
  /** 先頭 PR の最終更新時刻（UTC ミリ秒） */
  updatedMs: number;
}

/** 初回提出者の底の先頭（起票が最古の初回提出者 PR）の 1 回分の観測 */
export interface FirstTimerFrontierSample {
  /** 観測時刻（UTC ミリ秒） */
  timestampMs: number;
  /** 先頭 PR の番号 */
  pr: number;
  /** 先頭 PR の起票時刻（UTC ミリ秒） */
  createdMs: number;
}

export type ForecastUnavailableReason =
  /** 先頭の観測が無い */
  | "no-samples"
  /** 基準 PR の更新時刻が不明 */
  | "no-target"
  /** 観測期間が短く速度を測れない */
  | "insufficient-window"
  /** 観測期間内に先頭が進んでいない（または後退した） */
  | "no-progress";

export interface StaleFrontierForecast {
  /** 最新の先頭 PR */
  frontier: { pr: number; updatedMs: number; observedMs: number } | null;
  /** 先頭の遅れ: 観測時刻 − 先頭の更新時刻（日） */
  lagDays: number | null;
  /** 基準 PR の更新時刻 − 先頭の更新時刻（日）。0 以下なら先頭が基準 PR に到達済み */
  gapDays: number | null;
  /** 定常待ち時間モデル: 先頭の遅れが一定（速度 1 日/日）と仮定した予想日数 */
  steadyEtaDays: number | null;
  /** 観測速度モデル: 先頭の更新時刻の進み（日/日）。測れない場合は null */
  observedSpeed: number | null;
  /** 観測速度モデルの予想日数 */
  observedEtaDays: number | null;
  /** 観測速度の算出に使った期間（時間） */
  windowHours: number;
  /** 観測速度が算出できない理由 */
  observedUnavailable: ForecastUnavailableReason | null;
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
