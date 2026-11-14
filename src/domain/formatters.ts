/**
 * ドメイン共通の時刻・期間・数値丸めフォーマッタおよび定数。
 * 外部 I/O や環境変数に依存しない純粋関数群として提供する。
 */

/** 1 時間のミリ秒数 */
export const HOUR_MS = 3_600_000;

/** 1 日のミリ秒数 */
export const DAY_MS = 86_400_000;

/** JST (UTC+9) の UTC からのオフセットミリ秒数 */
export const JST_OFFSET_MS = 9 * HOUR_MS;

/**
 * 数値を小数第 1 位で四捨五入する。
 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 数値を小数第 2 位で丸める（従来の `Number(value.toFixed(2))` 互換）。
 */
export function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * UTC ミリ秒を JST (UTC+9) の "YYYY-MM-DD" 形式の日付文字列に変換する。
 * 不正な数値（NaN / 非有限値）の場合は "-" を返す。
 */
export function formatJstDate(timeMs: number): string {
  if (!Number.isFinite(timeMs)) return "-";
  const jstDate = new Date(timeMs + JST_OFFSET_MS);
  const y = jstDate.getUTCFullYear();
  const m = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jstDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * UTC の日時（ISO 8601 文字列・Date・UTC ミリ秒）を JST (+09:00) の文字列
 * （"YYYY-MM-DD HH:mm" または "YYYY-MM-DD HH:mm:ss"）へ変換する。
 */
export function formatJstDateTime(input: string | Date | number, includeSeconds = false): string {
  const date = input instanceof Date ? input : new Date(input);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "-";
  const jstDate = new Date(ms + JST_OFFSET_MS);

  const yyyy = jstDate.getUTCFullYear();
  const MM = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jstDate.getUTCDate()).padStart(2, "0");
  const HH = String(jstDate.getUTCHours()).padStart(2, "0");
  const mm = String(jstDate.getUTCMinutes()).padStart(2, "0");

  if (includeSeconds) {
    const ss = String(jstDate.getUTCSeconds()).padStart(2, "0");
    return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
  }

  return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
}

/**
 * 日時を JST (UTC+9) 形式の曜日付き文字列にフォーマットする。
 * 例: "2026-11-07(土) 20:30"
 */
export function formatDateTimeWithDay(input: Date | string, offsetHours = 9): string {
  const date = typeof input === "string" ? new Date(input) : input;
  // 実行環境のタイムゾーンに依存しないよう、オフセット加算後の値を UTC として読む
  const target = new Date(date.getTime() + offsetHours * HOUR_MS);

  const daysJa = ["日", "月", "火", "水", "木", "金", "土"];
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(target.getUTCDate()).padStart(2, "0");
  const day = daysJa[target.getUTCDay()];
  const hh = String(target.getUTCHours()).padStart(2, "0");
  const min = String(target.getUTCMinutes()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}(${day}) ${hh}:${min}`;
}

/**
 * UTC ミリ秒を JST (UTC+9) の "MM/DD" 形式の月日文字列に変換する。
 */
export function formatMonthDay(timeMs: number): string {
  if (!Number.isFinite(timeMs)) return "-";
  const jstDate = new Date(timeMs + JST_OFFSET_MS);
  const mm = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(jstDate.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}`;
}

/**
 * 日数を人間が読みやすい形式に整形する。
 * 例: 3.5日 (3日 12時間)、0.5日 (12時間)
 */
export function formatHumanDays(days: number): string {
  const totalHours = Math.round(days * 24);
  const wholeDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  const formattedDays = days.toFixed(1);
  if (wholeDays > 0) {
    return `${formattedDays}日 (${wholeDays}日 ${hours}時間)`;
  }
  return `${formattedDays}日 (${totalHours}時間)`;
}

/**
 * 前回比の差分文字列を生成する。
 * 例: [前回比 +2 件]、[前回比 -1 件]、[前回比 ±0 件]
 */
export function formatDelta(current: number, previous: number, unit = "件"): string {
  const diff = current - previous;
  if (diff > 0) {
    return `[前回比 +${diff} ${unit}]`;
  }
  if (diff < 0) {
    return `[前回比 ${diff} ${unit}]`;
  }
  return `[前回比 ±0 ${unit}]`;
}
