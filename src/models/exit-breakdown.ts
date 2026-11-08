/**
 * 待ち行列からの離脱の内訳（実質待ちの減少が、何によるものか）の型定義。
 *
 * 実質待ち（更新順の順位）の減少は、マージだけでなく、待ち行列からの離脱全般を含む。
 * 速度から出す予想（仮説①）がどれだけ実際のマージを反映しているかを見るために分解する。
 */

/** 件数。いずれも「減少」を正とする（増えた場合は負） */
export interface ExitCounts {
  /** 実質待ち（更新順の順位）の減少 */
  rank: number;
  /** 累積待ち（作成順）の減少 */
  created: number;
  /** マージされた PR（起票が基準 PR より前で、必須ラベル付き） */
  merged: number;
  /** 未マージのままクローズされた PR（同条件） */
  closed: number;
  /** 作成順の減少のうち、マージ・クローズで説明できない分（阻害ラベルの付与など健康条件の変化。負なら新たに健康になった分が多い） */
  healthChange: number;
  /** 更新順の順位だけが動いた分（待ち行列の前にいた PR に更新が入り、基準 PR より後ろへ移った分など） */
  reshuffle: number;
}

export interface ExitBreakdown {
  available: true;
  /** 比較した 2 回の観測の間隔（時間） */
  hours: number;
  /** 比較した 2 回の観測時刻（UTC ミリ秒） */
  baseMs: number;
  latestMs: number;
  counts: ExitCounts;
  /** 1 日あたりに換算した値（小数 1 桁） */
  perDay: ExitCounts;
  /** 実質待ちの減少のうち、実際のマージが占める割合（0〜1 を超えうる）。実質待ちが減っていなければ null */
  mergeShare: number | null;
}

export type ExitBreakdownUnavailableReason =
  /** 内訳の記録がある観測が 2 回に満たない（記録は次回の観測から貯まる） */
  | "no-records"
  /** 観測の間隔が短すぎて、速度が不安定になる */
  | "short-window"
  /** 累積件数が減っているなど、記録が矛盾している */
  | "inconsistent";

export interface ExitBreakdownUnavailable {
  available: false;
  reason: ExitBreakdownUnavailableReason;
}

export type ExitBreakdownResult = ExitBreakdown | ExitBreakdownUnavailable;
