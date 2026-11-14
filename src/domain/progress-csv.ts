/**
 * progress-history.csv のヘッダー定義・行パース・直列化・履歴行変換に関する純粋ドメインロジック。
 * 外部 I/O を行わない純粋関数であり、src/models の型定義のみに依存する。
 */

import type { ProgressHistoryRow } from "../models/progress";

/**
 * 履歴 CSV の ActiveAhead の算出基準（更新順）。
 * 基準が変わったら値を変え、旧基準の行との前回比・速度計算を避ける。
 */
export const QUEUE_BASIS = "updated";

/**
 * 簡易 CSV 行パース処理。
 */
export function parseCsvRows(csvContent: string): ProgressHistoryRow[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length <= 1) {
    return [];
  }

  const header = lines[0].split(",").map((c) => c.replace(/^"(.*)"$/, "$1").trim());
  const rows: ProgressHistoryRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.replace(/^"(.*)"$/, "$1").trim());
    const raw: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      raw[header[j]] = cols[j] ?? "";
    }
    rows.push(toHistoryRow(raw));
  }

  return rows;
}

/**
 * CSV 1 行分の列マップを ProgressHistoryRow へ変換する。列が欠けている旧スキーマの行は空文字で補う。
 */
export function toHistoryRow(raw: Record<string, string>): ProgressHistoryRow {
  return {
    Timestamp: raw.Timestamp ?? "",
    TargetPr: raw.TargetPr ?? "",
    FrontNumber: raw.FrontNumber ?? "",
    FrontCreatedAt: raw.FrontCreatedAt ?? "",
    ActiveAhead: raw.ActiveAhead ?? "",
    TotalAhead: raw.TotalAhead ?? "",
    QueueBasis: raw.QueueBasis ?? "",
    Behind: raw.Behind ?? "",
    TotalLifetimeDays: raw.TotalLifetimeDays ?? "",
    TurnLatencyDays: raw.TurnLatencyDays ?? "",
    WaitDays: raw.WaitDays ?? "",
    CommitCount: raw.CommitCount ?? "",
    MergedOlder: raw.MergedOlder ?? "",
    ClosedOlder: raw.ClosedOlder ?? "",
  };
}

/**
 * ProgressHistoryRow 配列を CSV 文字列にシリアライズする。
 */
export function serializeCsvRows(rows: ProgressHistoryRow[]): string {
  const headers: (keyof ProgressHistoryRow)[] = [
    "Timestamp",
    "TargetPr",
    "FrontNumber",
    "FrontCreatedAt",
    "ActiveAhead",
    "TotalAhead",
    "Behind",
    "TotalLifetimeDays",
    "TurnLatencyDays",
    "WaitDays",
    "CommitCount",
    "QueueBasis",
    "MergedOlder",
    "ClosedOlder",
  ];

  const headerLine = headers.map((h) => `"${h}"`).join(",");
  const lines = [headerLine];
  for (const row of rows) {
    const line = headers.map((h) => `"${row[h] ?? ""}"`).join(",");
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}
