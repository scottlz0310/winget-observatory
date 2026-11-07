// ダッシュボード向けの各種メトリクス（前回比差分、消化速度、到着予測、カレンダーギャップ）を計算する純粋関数群

import type {
  CalendarGapMetrics,
  DashboardCalculatedMetrics,
  DeltaMetrics,
  HistoryRecord,
  HistoryRowWithDelta,
  VelocityMetrics,
} from "../models/dashboard";
import type { ProgressHistoryRow } from "../models/progress";
import { QUEUE_BASIS } from "./progress";

/**
 * タイムスタンプ文字列（JST "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD(曜日) HH:mm" または ISO 文字列）を UTC ミリ秒にパースする。
 * 日本語曜日付き形式および "YYYY-MM-DD HH:mm:ss" 形式は JST (UTC+9) として厳格に解釈し、実行環境のローカルタイムゾーンに依存しない。
 */
export function parseTimestampToMs(timestampStr: string): number {
  if (!timestampStr) return Number.NaN;
  const trimmed = timestampStr.trim();

  // "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm", "YYYY-MM-DD(曜日) HH:mm:ss", "YYYY-MM-DD(曜日) HH:mm" (JST)
  const jstMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:\([^)]+\))?[ T](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (jstMatch) {
    const [, year, month, day, hour, min, sec] = jstMatch;
    const isoString = `${year}-${month}-${day}T${hour}:${min}:${sec ?? "00"}+09:00`;
    return Date.parse(isoString);
  }

  return Date.parse(trimmed);
}

/** 空欄や非数を 0 にせず NaN として扱う（0 件と誤認させない） */
function toNumber(value: number | string): number {
  return value === "" ? Number.NaN : Number(value);
}

/**
 * 履歴 CSV の行から、速度・前回比の計算に使える履歴を選別する。
 * - 基準 PR が異なる行は混ぜない（別 PR を観測した履歴との差分は意味を持たない）
 * - 待ち件数の算出基準（QueueBasis）が現行と異なる、または空欄の旧定義の行は除く
 * - 必須の数値が欠けた行・時刻が不正な行は除く
 */
export function selectComparableHistory(
  rows: ProgressHistoryRow[],
  targetPr: number,
  queueBasis: string = QUEUE_BASIS,
): HistoryRecord[] {
  const records: HistoryRecord[] = [];
  for (const row of rows) {
    if (Number(row.TargetPr) !== targetPr || row.QueueBasis !== queueBasis) continue;

    const timestampMs = parseTimestampToMs(row.Timestamp);
    const frontNumber = toNumber(row.FrontNumber);
    const activeAhead = toNumber(row.ActiveAhead);
    const totalAhead = toNumber(row.TotalAhead);
    const behind = toNumber(row.Behind);
    const waitDays = toNumber(row.WaitDays);
    if ([timestampMs, frontNumber, activeAhead, totalAhead, behind].some(Number.isNaN)) continue;

    records.push({
      timestamp: row.Timestamp,
      timestampMs,
      targetPr,
      frontNumber,
      frontCreatedAt: row.FrontCreatedAt || undefined,
      activeAhead,
      totalAhead,
      behind,
      waitDays,
    });
  }
  return records;
}

/**
 * UTC ミリ秒を JST の "YYYY-MM-DD" 形式の日付文字列に変換する
 */
export function formatJstDate(timeMs: number): string {
  if (Number.isNaN(timeMs)) return "-";
  const jstDate = new Date(timeMs + 9 * 60 * 60 * 1000);
  const y = jstDate.getUTCFullYear();
  const m = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jstDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 直近レコードと直前レコードの増減差分（Δ）を計算する
 */
export function calculateDeltaMetrics(records: HistoryRecord[]): DeltaMetrics {
  if (records.length < 2) {
    return {
      activeAheadDelta: null,
      frontNumberDelta: null,
      behindDelta: null,
      waitDaysDelta: null,
    };
  }

  const latest = records[records.length - 1];
  const previous = records[records.length - 2];

  return {
    activeAheadDelta: latest.activeAhead - previous.activeAhead,
    frontNumberDelta: latest.frontNumber - previous.frontNumber,
    behindDelta: latest.behind - previous.behind,
    waitDaysDelta:
      Number.isNaN(latest.waitDays) || Number.isNaN(previous.waitDays)
        ? null
        : Math.round((latest.waitDays - previous.waitDays) * 100) / 100,
  };
}

/**
 * 履歴レコード一覧に、直前の行との activeAhead 差分を付与した行リストを生成する
 */
export function calculateHistoryWithDeltas(records: HistoryRecord[]): HistoryRowWithDelta[] {
  return records.map((record, index) => {
    let activeAheadDelta: number | null = null;
    if (index > 0) {
      const prev = records[index - 1];
      activeAheadDelta = record.activeAhead - prev.activeAhead;
    }

    return {
      timestamp: record.timestamp,
      targetPr: record.targetPr,
      frontNumber: record.frontNumber,
      frontCreatedAt: record.frontCreatedAt,
      activeAhead: record.activeAhead,
      activeAheadDelta,
      totalAhead: record.totalAhead,
      behind: record.behind,
      waitDays: record.waitDays,
    };
  });
}

/**
 * 直近の時系列推移から消化速度（Velocity: 件/日）と到着予測（ETA）を算出する
 *
 * @param records 時系列レコード一覧（昇順）
 * @param currentActiveAhead 現在の実質待ち件数
 * @param targetHours 算出基準期間（既定: 24時間）
 */
export function calculateVelocityMetrics(
  records: HistoryRecord[],
  currentActiveAhead: number,
  targetHours = 24,
): VelocityMetrics {
  const fallback: VelocityMetrics = {
    velocityPerDay: null,
    velocityPerHour: null,
    etaDays: null,
    etaDateJst: null,
    sampleHours: 0,
    consumedCount: 0,
  };

  if (records.length < 2) {
    return fallback;
  }

  const latest = records[records.length - 1];
  const latestMs = latest.timestampMs;
  if (Number.isNaN(latestMs)) return fallback;

  // targetHours 以前（または最古）の基準レコードを探す
  const targetDiffMs = targetHours * 60 * 60 * 1000;
  let baseRecord = records[0];

  for (let i = records.length - 2; i >= 0; i--) {
    const r = records[i];
    if (Number.isNaN(r.timestampMs)) continue;
    const diff = latestMs - r.timestampMs;
    baseRecord = r;
    if (diff >= targetDiffMs) {
      break;
    }
  }

  const timeDiffHours = (latestMs - baseRecord.timestampMs) / (1000 * 60 * 60);

  // 観測間隔が 30 分未満の場合は信頼できる速度が算出不能とする
  if (timeDiffHours < 0.5) {
    return fallback;
  }

  // キューが消化されると activeAhead は減少するため、消化件数 = base - latest
  const consumed = baseRecord.activeAhead - latest.activeAhead;
  const velocityPerHour = consumed / timeDiffHours;
  const velocityPerDay = velocityPerHour * 24;

  const roundedVelocityPerDay = Math.round(velocityPerDay * 10) / 10;
  const roundedVelocityPerHour = Math.round(velocityPerHour * 100) / 100;
  const roundedHours = Math.round(timeDiffHours * 10) / 10;

  // 消化が進んでいる（速度がプラス）かつ 実質待ちが残っている場合のみ ETA を算出
  let etaDays: number | null = null;
  let etaDateJst: string | null = null;

  if (roundedVelocityPerDay > 0 && currentActiveAhead > 0) {
    etaDays = Math.round((currentActiveAhead / roundedVelocityPerDay) * 10) / 10;
    const etaMs = latestMs + etaDays * 24 * 60 * 60 * 1000;
    etaDateJst = formatJstDate(etaMs);
  }

  return {
    velocityPerDay: roundedVelocityPerDay,
    velocityPerHour: roundedVelocityPerHour,
    etaDays,
    etaDateJst,
    sampleHours: roundedHours,
    consumedCount: consumed,
  };
}

/**
 * 消化前線の起票日と基準 PR の起票日とのカレンダー日数差を計算する
 */
export function calculateCalendarGap(
  frontCreatedAtStr?: string | null,
  targetCreatedAtStr?: string | null,
): CalendarGapMetrics {
  if (!frontCreatedAtStr || !targetCreatedAtStr) {
    return {
      gapDays: null,
      frontCreatedAt: frontCreatedAtStr ?? null,
      targetCreatedAt: targetCreatedAtStr ?? null,
    };
  }

  const frontMs = parseTimestampToMs(frontCreatedAtStr);
  const targetMs = parseTimestampToMs(targetCreatedAtStr);

  if (Number.isNaN(frontMs) || Number.isNaN(targetMs)) {
    return {
      gapDays: null,
      frontCreatedAt: frontCreatedAtStr,
      targetCreatedAt: targetCreatedAtStr,
    };
  }

  const gapDays = Math.round(((targetMs - frontMs) / (1000 * 60 * 60 * 24)) * 10) / 10;

  return {
    gapDays,
    frontCreatedAt: frontCreatedAtStr,
    targetCreatedAt: targetCreatedAtStr,
  };
}

export interface DeltaBadgeOptions {
  /**
   * 数値の増加が改善（進行）を意味するかどうか。
   * - false (既定): キュー待ち件数用（減少が改善・進行、増加が悪化・後退）
   * - true: PR番号用（増加が進捗・進行、減少が巻き戻り・後退）
   */
  higherIsBetter?: boolean;
  /** 表示単位（既定: "件"） */
  unit?: string;
}

/**
 * 差分（Δ）を表示用の文字列と属性にフォーマットする
 */
export function formatDeltaBadge(
  delta: number | null,
  options: DeltaBadgeOptions = {},
): {
  text: string;
  className: string;
  label: string;
} {
  if (delta === null || delta === undefined) {
    return { text: "-", className: "delta-neutral", label: "差分なし" };
  }

  const { higherIsBetter = false, unit = "件" } = options;
  const unitSuffix = unit ? ` ${unit}` : "";

  if (delta === 0) {
    return { text: "±0", className: "delta-neutral", label: "増減なし" };
  }

  if (higherIsBetter) {
    if (delta > 0) {
      return {
        text: `+${delta}`,
        className: "delta-progress",
        label: `+${delta}${unitSuffix}進行`,
      };
    }
    return {
      text: `${delta}`,
      className: "delta-rewind",
      label: `${delta}${unitSuffix}後退`,
    };
  }

  // 待ち件数用 (higherIsBetter = false: 減少が改善)
  if (delta < 0) {
    return {
      text: `${delta}`,
      className: "delta-progress",
      label: `${Math.abs(delta)}${unitSuffix}進行`,
    };
  }

  return {
    text: `+${delta}`,
    className: "delta-rewind",
    label: `+${delta}${unitSuffix}増加`,
  };
}

/**
 * すべてのダッシュボード追加指標を一括集計する
 */
export function calculateDashboardMetrics(
  records: HistoryRecord[],
  currentActiveAhead: number,
  frontCreatedAt?: string | null,
  targetCreatedAt?: string | null,
): DashboardCalculatedMetrics {
  const latestDelta = calculateDeltaMetrics(records);
  const velocity = calculateVelocityMetrics(records, currentActiveAhead, 24);
  const calendarGap = calculateCalendarGap(frontCreatedAt, targetCreatedAt);
  const historyWithDeltas = calculateHistoryWithDeltas(records);

  return {
    latestDelta,
    velocity,
    calendarGap,
    historyWithDeltas,
  };
}
