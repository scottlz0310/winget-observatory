// HTML ダッシュボード描画向けの純粋表示フォーマッタ群

import type { DeltaBadge } from "./types";

/** HTML 特殊文字をエスケープし、空値（undefined / null / ""）は "-" として返す */
export function escapeHtml(str: string | number | undefined | null): string {
  if (str === undefined || str === null || str === "") return "-";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** 数値をロケール区切り文字列に整形し、欠損・非数は "-" として返す */
export function formatNumber(num: number | string | undefined | null): string {
  if (num === undefined || num === null || num === "" || Number.isNaN(Number(num))) return "-";
  return Number(num).toLocaleString();
}

/** 前回比などの差分バッジ HTML を生成する */
export function renderBadgeHtml(badge: DeltaBadge): string {
  return `<span class="delta-badge ${badge.className}" title="${escapeHtml(badge.label)}">${escapeHtml(badge.text)}</span>`;
}

/** 日数統計値（中央値・75%点・最大）を HTML スパンとして整形する */
export function formatDaysStat(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) {
    return `<span style="color: var(--text-muted);">-</span>`;
  }
  return `<strong>${val}</strong> <span style="font-size: 0.875rem; font-weight: normal;">日</span>`;
}

/** 到着予定までの日数を表示用文言に整形する */
export function formatEtaDays(days: number): string {
  return days === 0 ? "到達済み" : `約 ${days} 日後`;
}

/** 誤差（日）を符号つきで表示する。+ は予想が実際より遅かった */
export function formatErrorDays(days: number): string {
  if (days === 0) return "±0 日";
  return `${days > 0 ? "+" : ""}${days} 日`;
}
