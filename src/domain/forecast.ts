/**
 * 優等生の底の推移から基準 PR のマージ時期を予想するモデル。
 * 外部 I/O を行わない純粋関数群であり、src/models の型定義のみに依存する。
 */

import type { DepthsSnapshot } from "../models/depths";
import type {
  FirstTimerFrontierSample,
  LifetimeForecast,
  StaleFrontierForecast,
  StaleFrontierSample,
} from "../models/forecast";
import { CURRENT_DEPTHS_VERSION } from "./depths";
import { DAY_MS, HOUR_MS, round1 } from "./formatters";

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

/**
 * スナップショット列から、優等生の底の先頭（1コミット限定・更新が最古の健康な PR）の観測列を時刻昇順で取り出す。
 * 観測定義が異なる旧履歴（DepthsVersion 不一致・未設定）、優等生の底が空の観測、日時が不正な観測は除く。
 */
export function extractStaleFrontierSamples(
  snapshots: DepthsSnapshot[],
  definitionVersion = CURRENT_DEPTHS_VERSION,
): StaleFrontierSample[] {
  const samples: StaleFrontierSample[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.DepthsVersion !== definitionVersion) continue;
    const head = snapshot.StaleBottom?.[0];
    if (!head) continue;
    const timestampMs = Date.parse(snapshot.Timestamp);
    const updatedMs = Date.parse(head.UpdatedAt);
    if (Number.isNaN(timestampMs) || Number.isNaN(updatedMs)) continue;
    samples.push({ timestampMs, pr: head.Number, updatedMs });
  }
  return samples.sort((a, b) => a.timestampMs - b.timestampMs);
}

/**
 * スナップショット列から、初回提出者の底の先頭（起票が最古の初回提出者 PR）の
 * 観測列を時刻昇順で取り出す。
 * 観測定義が異なる旧履歴（DepthsVersion 不一致・未設定）、未記録・空の観測、日時が不正な観測は除く。
 */
export function extractFirstTimerFrontierSamples(
  snapshots: DepthsSnapshot[],
  definitionVersion = CURRENT_DEPTHS_VERSION,
): FirstTimerFrontierSample[] {
  const samples: FirstTimerFrontierSample[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.DepthsVersion !== definitionVersion) continue;
    const head = snapshot.FirstTimerBottom?.[0];
    if (!head) continue;
    const timestampMs = Date.parse(snapshot.Timestamp);
    const createdMs = Date.parse(head.CreatedAt);
    if (Number.isNaN(timestampMs) || Number.isNaN(createdMs)) continue;
    samples.push({ timestampMs, pr: head.Number, createdMs });
  }
  return samples.sort((a, b) => a.timestampMs - b.timestampMs);
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

  // 速度を測る起点: 期間内で最も古い観測（最新との間隔が最小間隔以上のもの）
  const windowStart = latest.timestampMs - windowHours * HOUR_MS;
  const base = samples.find(
    (s) =>
      s.timestampMs >= windowStart &&
      latest.timestampMs - s.timestampMs >= MIN_WINDOW_HOURS * HOUR_MS,
  );

  const result: StaleFrontierForecast = {
    frontier,
    lagDays,
    gapDays,
    steadyEtaDays,
    observedSpeed: null,
    observedEtaDays: null,
    windowHours: 0,
    observedUnavailable: "insufficient-window",
  };

  if (!base) {
    return result;
  }

  const elapsedMs = latest.timestampMs - base.timestampMs;
  const progressMs = latest.updatedMs - base.updatedMs;
  result.windowHours = round1(elapsedMs / HOUR_MS);

  if (progressMs <= 0) {
    result.observedUnavailable = "no-progress";
    return result;
  }

  const speed = progressMs / elapsedMs;
  result.observedSpeed = Math.round(speed * 100) / 100;
  result.observedUnavailable = null;
  result.observedEtaDays = gapMs <= 0 ? 0 : round1(gapMs / DAY_MS / speed);
  return result;
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
