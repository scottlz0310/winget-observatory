/**
 * マージ済み PR のサンプルキャッシュ（merged-samples.jsonl）の型定義。
 *
 * マージ済み PR の履歴（起票・コミット・条件成立・マージの時刻）は後から変わらないため、
 * 一度計測した結果を保存して再利用し、GitHub API の呼び出しを新規にマージされた PR の分だけにする。
 * 1 行 1 JSON。
 */

/** 初回提出者判定から除外された理由、または判定由来（multi-commit / timeline-blocking は旧版キャッシュ互換用） */
export type FirstTimerDisqualificationReason =
  | "multi-commit"
  | "timeline-blocking"
  | "recurring-author"
  | "lifetime-merged"
  | "privileged-or-bot";

/** 統計に採用できたサンプル 1 件（MergedCandidateSample と同じ値を、保存用のキーで持つ） */
export interface CachedSampleEntry {
  Type: "sample";
  Number: number;
  Title: string;
  CreatedAt: string;
  LatestCommittedDate: string;
  CommitCount: number;
  ReadyAt: string;
  MergedAt: string;
  TotalDays: number;
  TurnDays: number;
  ReadyDays: number;
  Author?: string;
  AuthorType?: string;
  AuthorAssociation?: string;
  IsFirstTimer?: boolean;
  /** 初回判定の除外理由（旧版キャッシュとの区別および再評価の判断用） */
  FirstTimerReason?: FirstTimerDisqualificationReason;
  /** 初回・健康体判定ロジックのバージョン（1: コミット数制限あり旧版, 2: コミット数制限撤廃版, 3: Waived-* 免除ラベル健康体扱い版, 4: timeline-blocking 除外廃止・累計マージ実績統一版, 5: Validation-Guide 阻害化・ReadyAt 再計測版, 6: 特権ロール・Bot 除外版） */
  FirstTimerVersion?: number;
}

/** 条件不成立などで統計から除いた PR 1 件。再取得を避けるために記録する */
export interface CachedSkippedEntry {
  Type: "skipped";
  Number: number;
  MergedAt: string;
  /** no-ready: 条件が成立した時刻を特定できない / negative-ready: 成立がマージより後 / not-first-timer-candidate: 30日超の窓で初回候補になり得ないため取得スキップ */
  Reason: "no-ready" | "negative-ready" | "not-first-timer-candidate";
  /** 判定ロジックのバージョン（3: Waived-* 免除ラベル健康体扱い版。旧版の no-ready 再評価区別用） */
  FirstTimerVersion?: number;
}

export type SampleCacheEntry = CachedSampleEntry | CachedSkippedEntry;

/** 初回提出者 最速マージランキングの集計結果 */
export interface FirstTimerFastestRanking {
  /** 抽出条件を満たす該当全件数 */
  totalCount: number;
  /** TotalDays 昇順の上位最大 N 件 */
  items: CachedSampleEntry[];
  /** 集計対象とした起票日時窓（日数） */
  windowDays?: number;
}
