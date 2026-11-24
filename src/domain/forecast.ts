/**
 * 待機ライン（前線・正常底）の推移から基準 PR のマージ時期を予想するモデル。
 * 外部 I/O を行わない純粋関数群であり、src/models の型定義のみに依存する。
 */

import type { DepthsRow, DepthsSnapshot, PrInterventionSummary } from "../models/depths";
import type {
  FirstReviewForecast,
  FirstTimerFrontierSample,
  HealthyFrontierSample,
  LifetimeForecast,
  MainstreamFrontierSample,
  UnreviewedFrontierSample,
} from "../models/forecast";
import { CURRENT_DEPTHS_VERSION } from "./depths";
import { DAY_MS, round1 } from "./formatters";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "./intervention";

/** マージ正常底（健康的大底）の定義が現行と互換な最小バージョン（v7 以降不変） */
export const MIN_HEALTHY_DEPTHS_VERSION = 7;

/** 初回提出者の底の定義が現行と互換な最小バージョン（v7 以降不変） */
export const MIN_FIRST_TIMER_DEPTHS_VERSION = 7;

/** 主戦場ライン（初回介入コホート中央値）の最小定義バージョン */
export const MIN_MAINSTREAM_DEPTHS_VERSION = CURRENT_DEPTHS_VERSION;

/**
 * depths-history.jsonl（1 行 1 JSON、先頭に BOM があり得る）を DepthsSnapshot の配列にパースする。
 * 壊れた行は握りつぶさず、行番号付きで例外にする。
 */
export function parseDepthsHistory(text: string): DepthsSnapshot[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const snapshots: DepthsSnapshot[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      snapshots.push(JSON.parse(line) as DepthsSnapshot);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`キュー境界履歴 ${index + 1} 行目のパースに失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }
  return snapshots;
}

function extractFrontierSamples<T extends { timestampMs: number }>(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion: number,
  selectHead: (snapshot: DepthsSnapshot) => DepthsRow | undefined,
  selectAnchorIso: (head: DepthsRow) => string,
  buildSample: (timestampMs: number, pr: number, anchorMs: number) => T,
): T[] {
  const samples: T[] = [];
  for (const snapshot of snapshots) {
    if (
      minDefinitionVersion > 0 &&
      (snapshot.DepthsVersion === undefined || snapshot.DepthsVersion < minDefinitionVersion)
    ) {
      continue;
    }
    const head = selectHead(snapshot);
    if (!head) continue;
    const timestampMs = Date.parse(snapshot.Timestamp);
    const anchorMs = Date.parse(selectAnchorIso(head));
    if (Number.isNaN(timestampMs) || Number.isNaN(anchorMs)) continue;
    samples.push(buildSample(timestampMs, head.Number, anchorMs));
  }
  return samples.sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * スナップショット列から、初回提出者の底の先頭（起票が最古の初回提出者 PR）の
 * 観測列を時刻昇順で取り出す。
 * 観測定義が異なる旧履歴（DepthsVersion 未設定または比較条件変更前）、未記録・空の観測、日時が不正な観測は除く。
 */
export function extractFirstTimerFrontierSamples(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion = MIN_FIRST_TIMER_DEPTHS_VERSION,
): FirstTimerFrontierSample[] {
  return extractFrontierSamples(
    snapshots,
    minDefinitionVersion,
    (s) => s.FirstTimerBottom?.[0],
    (head) => head.CreatedAt,
    (timestampMs, pr, createdMs) => ({ timestampMs, pr, createdMs }),
  );
}

/**
 * スナップショット列から、マージ正常底（健康的大底）の先頭（起票が最古の健康な PR）の
 * 観測列を時刻昇順で取り出す。
 */
export function extractHealthyFrontierSamples(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion = MIN_HEALTHY_DEPTHS_VERSION,
): HealthyFrontierSample[] {
  return extractFrontierSamples(
    snapshots,
    minDefinitionVersion,
    (s) => s.HealthyBottom?.[0],
    (head) => head.CreatedAt,
    (timestampMs, pr, createdMs) => ({ timestampMs, pr, createdMs }),
  );
}

/**
 * スナップショット列から、未レビュー（完全未着手）正常底の先頭（起票が最古の健康な PR）の
 * 観測列を時刻昇順で取り出す。
 */
export function extractUnreviewedFrontierSamples(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion = CURRENT_DEPTHS_VERSION,
): UnreviewedFrontierSample[] {
  return extractFrontierSamples(
    snapshots,
    minDefinitionVersion,
    (s) => s.UnreviewedBottom?.[0],
    (head) => head.CreatedAt,
    (timestampMs, pr, createdMs) => ({ timestampMs, pr, createdMs }),
  );
}

/**
 * スナップショット列から、主戦場ライン方式（Mode === "cohort-median-7d"）の
 * 観測列を時刻昇順で抽出する。
 * 旧定義（未着手の底 / UnreviewedBottom）しか持たない履歴行は完全に除外し、指標切り替え直後の速度スパイクを防ぐ。
 */
export function extractMainstreamFrontierSamples(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion = MIN_MAINSTREAM_DEPTHS_VERSION,
): MainstreamFrontierSample[] {
  const samples: MainstreamFrontierSample[] = [];
  for (const snapshot of snapshots) {
    if ((snapshot.DepthsVersion ?? 0) < minDefinitionVersion) continue;
    const frontier = snapshot.FirstReviewFrontier;
    if (!frontier || frontier.Mode !== FIRST_REVIEW_MAINSTREAM_MODE) continue;
    if (frontier.CohortCount <= 0 || !frontier.MedianCreatedAt) continue;
    const timestampMs = Date.parse(snapshot.Timestamp);
    const createdMs = Date.parse(frontier.MedianCreatedAt);
    if (!Number.isFinite(timestampMs) || !Number.isFinite(createdMs)) continue;
    samples.push({
      timestampMs,
      createdMs,
      cohortCount: frontier.CohortCount,
      openCount: frontier.OpenCount,
      mergedCount: frontier.MergedCount,
      mode: frontier.Mode,
    });
  }
  return samples.sort((a, b) => a.timestampMs - b.timestampMs);
}

export interface FirstReviewForecastOptions {
  /** 基準 PR 自身の介入判定結果（人間レビューまたは手動コメントの OR） */
  targetIntervention?: PrInterventionSummary | null;
}

function resolveTargetIntervention(
  options: FirstReviewForecastOptions,
): PrInterventionSummary | null {
  return options.targetIntervention ?? null;
}

/**
 * 主戦場ライン（直近 7 日間初回人間介入コホートの起票日時中央値）の現在位置を評価し、
 * 基準 PR との起票日差に基づくスナップショット情報および定常ペース（1.0 日/日）換算目安を返す。
 * 短期実測速度による割り算外挿はノイズ・時間軸逆転を招くため行わない。
 */
export function calculateFirstReviewForecast(
  samples: MainstreamFrontierSample[],
  targetCreatedMs: number | null,
  options: FirstReviewForecastOptions = {},
): FirstReviewForecast {
  const targetIntervention = resolveTargetIntervention(options);
  const targetAssignees = targetIntervention?.ThirdPartyAssignees ?? [];
  const hasTargetIntervention = Boolean(targetIntervention?.Intervened);

  const validSamples = samples
    .filter(
      (s) =>
        s.mode === FIRST_REVIEW_MAINSTREAM_MODE &&
        s.cohortCount > 0 &&
        Number.isFinite(s.timestampMs) &&
        Number.isFinite(s.createdMs),
    )
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const latest = validSamples[validSamples.length - 1];
  if (!latest) {
    return {
      status: hasTargetIntervention ? "target-intervened" : "no-samples",
      frontier: null,
      lagDays: null,
      gapDays: null,
      targetIntervention,
      targetAssignees,
      steadyEtaDays: hasTargetIntervention ? 0 : null,
      steadyDateMs: null,
    };
  }

  const frontier = {
    createdMs: latest.createdMs,
    observedMs: latest.timestampMs,
    cohortCount: latest.cohortCount,
    openCount: latest.openCount,
    mergedCount: latest.mergedCount,
  };
  const lagDays = round1((latest.timestampMs - latest.createdMs) / DAY_MS);

  if (targetCreatedMs === null || Number.isNaN(targetCreatedMs)) {
    return {
      status: hasTargetIntervention ? "target-intervened" : "no-target",
      frontier,
      lagDays,
      gapDays: null,
      targetIntervention,
      targetAssignees,
      steadyEtaDays: hasTargetIntervention ? 0 : null,
      steadyDateMs: hasTargetIntervention ? latest.timestampMs : null,
    };
  }

  const gapMs = targetCreatedMs - latest.createdMs;
  const gapDays = round1(gapMs / DAY_MS);
  const steadyEtaDays = gapMs <= 0 ? 0 : round1(gapMs / DAY_MS);
  const steadyDateMs = latest.timestampMs + steadyEtaDays * DAY_MS;

  if (hasTargetIntervention) {
    return {
      status: "target-intervened",
      frontier,
      lagDays,
      gapDays,
      targetIntervention,
      targetAssignees,
      steadyEtaDays: 0,
      steadyDateMs: latest.timestampMs,
    };
  }

  if (gapMs <= 0) {
    return {
      status: "reached",
      frontier,
      lagDays,
      gapDays,
      targetIntervention,
      targetAssignees,
      steadyEtaDays: 0,
      steadyDateMs: latest.timestampMs,
    };
  }

  return {
    status: "steady",
    frontier,
    lagDays,
    gapDays,
    targetIntervention,
    targetAssignees,
    steadyEtaDays,
    steadyDateMs,
  };
}

/**
 * 通算所要日数（起票からマージまで）の中央値・75%点から、基準 PR のマージ予想日を求める。
 * 統計が無い（旧スナップショット）、または日時が解釈できないときは null。
 *
 * @param targetCreatedMs 基準 PR の起票時刻（UTC ミリ秒）
 * @param medianDays 通算所要日数の中央値
 * @param p75Days 通算所要日数の 75%点
 * @param nowMs 観測時刻（UTC ミリ秒）
 */
export function calculateLifetimeForecast(
  targetCreatedMs: number,
  medianDays: number | null | undefined,
  p75Days: number | null | undefined,
  nowMs: number,
): LifetimeForecast | null {
  if (!Number.isFinite(targetCreatedMs) || !Number.isFinite(nowMs)) return null;
  if (medianDays === null || medianDays === undefined || !Number.isFinite(medianDays)) return null;

  const etaDaysOf = (dateMs: number): number => Math.max(0, round1((dateMs - nowMs) / DAY_MS));
  const medianDateMs = targetCreatedMs + medianDays * DAY_MS;
  const hasP75 = p75Days !== null && p75Days !== undefined && Number.isFinite(p75Days);
  const p75DateMs = hasP75 ? targetCreatedMs + p75Days * DAY_MS : null;

  return {
    medianDays,
    medianDateMs,
    medianEtaDays: etaDaysOf(medianDateMs),
    exceededMedian: medianDateMs <= nowMs,
    p75DateMs,
    p75EtaDays: p75DateMs === null ? null : etaDaysOf(p75DateMs),
  };
}
