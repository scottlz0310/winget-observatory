/**
 * マージ済み PR のサンプルキャッシュ（merged-samples.jsonl）の型定義。
 *
 * マージ済み PR の履歴（起票・コミット・条件成立・マージの時刻）は後から変わらないため、
 * 一度計測した結果を保存して再利用し、GitHub API の呼び出しを新規にマージされた PR の分だけにする。
 * 1 行 1 JSON。
 */

/** 初回提出者判定から除外された理由、または判定由来 */
export type FirstTimerDisqualificationReason =
  | "multi-commit"
  | "timeline-blocking"
  | "recurring-author"
  | "lifetime-merged";

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
  IsFirstTimer?: boolean;
  /** 初回判定の除外理由（旧版キャッシュとの区別および再評価の判断用） */
  FirstTimerReason?: FirstTimerDisqualificationReason;
  /** 初回判定ロジックのバージョン（1: コミット数制限あり旧版, 2: コミット数制限撤廃新版） */
  FirstTimerVersion?: number;
}

/** 条件不成立などで統計から除いた PR 1 件。再取得を避けるために記録する */
export interface CachedSkippedEntry {
  Type: "skipped";
  Number: number;
  MergedAt: string;
  /** no-ready: 条件が成立した時刻を特定できない / negative-ready: 成立がマージより後 / not-first-timer-candidate: 30日超の窓で初回候補になり得ないため取得スキップ */
  Reason: "no-ready" | "negative-ready" | "not-first-timer-candidate";
}

export type SampleCacheEntry = CachedSampleEntry | CachedSkippedEntry;
