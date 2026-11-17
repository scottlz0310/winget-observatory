/**
 * 優等生の底の推移から基準 PR のマージ時期を予想するモデル。
 * 外部 I/O を行わない純粋関数群であり、src/models の型定義のみに依存する。
 */

import type { DepthsRow, DepthsSnapshot, PrInterventionSummary } from "../models/depths";
import type {
  FirstReviewForecast,
  FirstReviewForecastStatus,
  FirstTimerFrontierSample,
  ForecastUnavailableReason,
  LifetimeForecast,
  MainstreamFrontierSample,
  StaleFrontierForecast,
  StaleFrontierSample,
  UnreviewedFrontierSample,
} from "../models/forecast";
import { DAY_MS, HOUR_MS, round1 } from "./formatters";
import { FIRST_REVIEW_MAINSTREAM_MODE } from "./intervention";

/** 優等生の底・初回提出者の底の定義が現行と互換な最小バージョン（v2 以降で定義不変） */
export const MIN_STALE_DEPTHS_VERSION = 2;

/** 主戦場ライン（初回介入コホート中央値）の最小定義バージョン */
export const MIN_MAINSTREAM_DEPTHS_VERSION = 4;

/** 速度を測るために必要な最小の観測間隔（これ未満は誤差が大きいため測らない） */
export const MIN_WINDOW_HOURS = 6;

/** 速度を測る観測期間の既定（遭難の底の進みは断続的なため、長めに取る） */
export const DEFAULT_WINDOW_HOURS = 72;

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
    if (snapshot.DepthsVersion === undefined || snapshot.DepthsVersion < minDefinitionVersion) {
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
 * スナップショット列から、優等生の底の先頭（1コミット限定・更新が最古の健康な PR）の観測列を時刻昇順で取り出す。
 * 観測定義が異なる旧履歴（DepthsVersion 未設定・1）、優等生の底が空の観測、日時が不正な観測は除く。
 */
export function extractStaleFrontierSamples(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion = MIN_STALE_DEPTHS_VERSION,
): StaleFrontierSample[] {
  return extractFrontierSamples(
    snapshots,
    minDefinitionVersion,
    (s) => s.StaleBottom?.[0],
    (head) => head.UpdatedAt,
    (timestampMs, pr, updatedMs) => ({ timestampMs, pr, updatedMs }),
  );
}

/**
 * スナップショット列から、初回提出者の底の先頭（起票が最古の初回提出者 PR）の
 * 観測列を時刻昇順で取り出す。
 * 観測定義が異なる旧履歴（DepthsVersion 未設定・1）、未記録・空の観測、日時が不正な観測は除く。
 */
export function extractFirstTimerFrontierSamples(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion = MIN_STALE_DEPTHS_VERSION,
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
 * スナップショット列から、未レビュー（完全未着手）前線の先頭（人間レビュー・手動コメント・第三者アサインなし・起票が最古の健康な PR）の
 * 観測列を時刻昇順で取り出す（v3 互換用）。
 */
export function extractUnreviewedFrontierSamples(
  snapshots: DepthsSnapshot[],
  minDefinitionVersion = 3,
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
 * スナップショット列から、主戦場ライン方式（Mode === "cohort-median-7d" かつ DepthsVersion >= 4）の
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

interface FrontierVelocityMeasurement {
  windowHours: number;
  rawSpeed: number | null;
  observedSpeed: number | null;
  unavailableReason: ForecastUnavailableReason | null;
}

/**
 * 時刻昇順の前線サンプル列から、指定ウィンドウ内の先頭進行速度（日/日）を計測する共通ヘルパー。
 */
function measureFrontierVelocity<T extends { timestampMs: number }>(
  samples: T[],
  getAnchorMs: (sample: T) => number,
  windowHours: number,
): FrontierVelocityMeasurement {
  const latest = samples[samples.length - 1];
  if (!latest) {
    return {
      windowHours: 0,
      rawSpeed: null,
      observedSpeed: null,
      unavailableReason: "no-samples",
    };
  }

  const windowStart = latest.timestampMs - windowHours * HOUR_MS;
  const base = samples.find(
    (s) =>
      s.timestampMs >= windowStart &&
      latest.timestampMs - s.timestampMs >= MIN_WINDOW_HOURS * HOUR_MS,
  );

  if (!base) {
    return {
      windowHours: 0,
      rawSpeed: null,
      observedSpeed: null,
      unavailableReason: "insufficient-window",
    };
  }

  const elapsedMs = latest.timestampMs - base.timestampMs;
  const progressMs = getAnchorMs(latest) - getAnchorMs(base);
  const measuredWindowHours = round1(elapsedMs / HOUR_MS);

  if (progressMs <= 0) {
    return {
      windowHours: measuredWindowHours,
      rawSpeed: null,
      observedSpeed: null,
      unavailableReason: "no-progress",
    };
  }

  const rawSpeed = progressMs / elapsedMs;
  return {
    windowHours: measuredWindowHours,
    rawSpeed,
    observedSpeed: Math.round(rawSpeed * 100) / 100,
    unavailableReason: null,
  };
}

/**
 * 遭難の底の先頭の進みから、基準 PR が先頭に到達するまでの日数を予想する。
 *
 * - 定常待ち時間モデル: 先頭の遅れが一定（先頭の更新時刻が実時間と同じ速度で進む）と仮定する。
 * - 観測速度モデル: 履歴から先頭の更新時刻の進み（日/日）を実測して予想する。
 *
 * @param samples 先頭の観測列
 * @param targetUpdatedMs 基準 PR の最終更新時刻（UTC ミリ秒）。不明なら null
 * @param windowHours 速度を測る期間の上限（時間）
 */
export function calculateStaleFrontierForecast(
  samples: StaleFrontierSample[],
  targetUpdatedMs: number | null,
  windowHours = DEFAULT_WINDOW_HOURS,
): StaleFrontierForecast {
  const empty: StaleFrontierForecast = {
    frontier: null,
    lagDays: null,
    gapDays: null,
    steadyEtaDays: null,
    observedSpeed: null,
    observedEtaDays: null,
    windowHours: 0,
    observedUnavailable: "no-samples",
  };

  const latest = samples[samples.length - 1];
  if (!latest) {
    return empty;
  }

  const frontier = { pr: latest.pr, updatedMs: latest.updatedMs, observedMs: latest.timestampMs };
  const lagDays = round1((latest.timestampMs - latest.updatedMs) / DAY_MS);

  if (targetUpdatedMs === null || Number.isNaN(targetUpdatedMs)) {
    return { ...empty, frontier, lagDays, observedUnavailable: "no-target" };
  }

  const gapMs = targetUpdatedMs - latest.updatedMs;
  const gapDays = round1(gapMs / DAY_MS);
  // 先頭が基準 PR に到達済みなら、予想日数は 0 とする
  const steadyEtaDays = gapMs <= 0 ? 0 : round1(gapMs / DAY_MS);

  const velocity = measureFrontierVelocity(samples, (s) => s.updatedMs, windowHours);

  if (velocity.rawSpeed === null) {
    return {
      frontier,
      lagDays,
      gapDays,
      steadyEtaDays,
      observedSpeed: null,
      observedEtaDays: null,
      windowHours: velocity.windowHours,
      observedUnavailable: velocity.unavailableReason,
    };
  }

  return {
    frontier,
    lagDays,
    gapDays,
    steadyEtaDays,
    observedSpeed: velocity.observedSpeed,
    observedEtaDays: gapMs <= 0 ? 0 : round1(gapMs / DAY_MS / velocity.rawSpeed),
    windowHours: velocity.windowHours,
    observedUnavailable: null,
  };
}

export interface FirstReviewForecastOptions {
  /** 速度を測る期間の上限（時間） */
  windowHours?: number;
  /** 基準 PR 自身の介入判定結果（人間レビュー・手動コメント・第三者アサインの OR） */
  targetIntervention?: PrInterventionSummary | null;
  /** 基準 PR 自身の第三者 Assignees（旧データ互換フォールバック用） */
  targetThirdPartyAssignees?: readonly string[] | null;
}

function resolveTargetIntervention(
  options: FirstReviewForecastOptions,
): PrInterventionSummary | null {
  if (options.targetIntervention) {
    return options.targetIntervention;
  }
  const assignees = (options.targetThirdPartyAssignees ?? []).filter((a) => Boolean(a));
  if (assignees.length === 0) {
    return null;
  }
  return {
    Intervened: true,
    ThirdPartyAssignees: assignees,
    HumanReviewCount: 0,
    ManualCommentCount: 0,
    PrimaryBadge: {
      Kind: "assignee",
      Actor: assignees[0],
      Label: `アサイン済: ${assignees.join(", ")}`,
    },
  };
}

/**
 * 主戦場ライン（直近 7 日間初回人間介入コホートの起票日時中央値）の進みから、
 * 基準 PR へ初回レビュー（メンテナの最初の介入）が到達する見込み日を予想する。
 * モード識別子が異なる混入サンプルは除外して速度スパイクを防ぐ。
 */
export function calculateFirstReviewForecast(
  samples: MainstreamFrontierSample[],
  targetCreatedMs: number | null,
  options: FirstReviewForecastOptions = {},
): FirstReviewForecast {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
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
      observedSpeed: null,
      observedEtaDays: hasTargetIntervention ? 0 : null,
      observedDateMs: null,
      windowHours: 0,
      observedUnavailable: "no-samples",
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
  const velocity = measureFrontierVelocity(validSamples, (s) => s.createdMs, windowHours);

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
      observedSpeed: velocity.observedSpeed,
      observedEtaDays: hasTargetIntervention ? 0 : null,
      observedDateMs: hasTargetIntervention ? latest.timestampMs : null,
      windowHours: velocity.windowHours,
      observedUnavailable: hasTargetIntervention ? velocity.unavailableReason : "no-target",
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
      observedSpeed: velocity.observedSpeed,
      observedEtaDays: 0,
      observedDateMs: latest.timestampMs,
      windowHours: velocity.windowHours,
      observedUnavailable: velocity.unavailableReason,
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
      observedSpeed: velocity.observedSpeed,
      observedEtaDays: 0,
      observedDateMs: latest.timestampMs,
      windowHours: velocity.windowHours,
      observedUnavailable: velocity.unavailableReason,
    };
  }

  if (velocity.rawSpeed === null) {
    const status: FirstReviewForecastStatus = velocity.unavailableReason ?? "insufficient-window";
    return {
      status,
      frontier,
      lagDays,
      gapDays,
      targetIntervention,
      targetAssignees,
      steadyEtaDays,
      steadyDateMs,
      observedSpeed: null,
      observedEtaDays: null,
      observedDateMs: null,
      windowHours: velocity.windowHours,
      observedUnavailable: velocity.unavailableReason,
    };
  }

  const observedEtaDays = round1(gapMs / DAY_MS / velocity.rawSpeed);
  return {
    status: "forecasted",
    frontier,
    lagDays,
    gapDays,
    targetIntervention,
    targetAssignees,
    steadyEtaDays,
    steadyDateMs,
    observedSpeed: velocity.observedSpeed,
    observedEtaDays,
    observedDateMs: latest.timestampMs + observedEtaDays * DAY_MS,
    windowHours: velocity.windowHours,
    observedUnavailable: null,
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
