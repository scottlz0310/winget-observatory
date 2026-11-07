/**
 * 進捗メトリクス計測（progress）に関するドメインロジック。
 * 外部 I/O を行わない純粋関数群であり、src/models の型定義のみに依存する。
 */

import type {
  MergedCandidateSample,
  ProgressHistoryRow,
  ProgressPercentileMetrics,
  ProgressRivalPr,
  ProgressSnapshot,
  ProgressStatsSummary,
  ProgressTimelineEvent,
} from "../models/progress";
import { buildGuidance, compareWithSamples, toSnapshotSamples } from "./benchmark";

/**
 * 比較条件で必須とされるラベル一覧。
 */
export const REQUIRED_LABELS: readonly string[] = [
  "New-Package",
  "Azure-Pipeline-Passed",
  "Validation-Completed",
] as const;

/**
 * 明確な阻害要因となるラベル一覧。
 */
export const BLOCKED_LABELS: readonly string[] = [
  "Needs-CLA",
  "Needs-Author-Feedback",
  "Changes-Requested",
  "Blocking-Issue",
  "Blocked-InstallerType",
  "Author-Not-Authorized",
  "Author-Not-Verified",
  "Manifest-Content-Incomplete",
  "Package-Metadata-Invalid",
  "PullRequest-Error",
  "Unexpected-File",
  "Network-Blocker",
  "Possible-Duplicate",
  "Resolution-Duplicate",
  "Validation-Merge-Conflict",
  "Validation-Retry",
  "Timeout-Retry",
  "Testing",
] as const;

/**
 * 調査中・特殊な対応が必要なラベル一覧。
 */
export const INVESTIGATION_LABELS: readonly string[] = [
  "Package-Flagged",
  "PUA-Detection",
  "Needs-SmartScreen-Investigation",
  "Validate-Domain-Installer",
  "Validation-Agreement-Domain",
  "Validation-Certificate-Root",
  "Validation-Domain",
  "Validation-Domains-Mismatch",
  "Validation-Framework-Package",
  "Validation-Hash-Flagged",
  "Validation-Hash-Verification-Failed",
  "Validation-Unapproved-URL",
  "Validation-SmartScreen",
] as const;

/**
 * 名前パターンで判定する除外ラベル正規表現。
 */
export const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^Error-/,
  /-Error$/,
  /^Policy-Test-/,
  /^Validation-Submission-(Expired|Failed|Mismatch|Missing|Unsupported)$/,
] as const;

/**
 * 履歴 CSV の ActiveAhead の算出基準（更新順）。
 * 基準が変わったら値を変え、旧基準の行との前回比・速度計算を避ける。
 */
export const QUEUE_BASIS = "updated";

/**
 * 「健康な未マージ PR」（比較条件を満たす PR）を検索する GitHub Search クエリの条件部分。
 * progress（前線・待ち件数）と explore-depths（各底）で同じ定義を使い、判定のずれを防ぐ。
 * 名前パターンで判定する阻害ラベル（BLOCKED_PATTERNS）は検索クエリで表現できないため含まない。
 */
export function buildHealthyQueryParts(repository: string): string[] {
  return [
    `repo:${repository}`,
    "is:pr",
    "is:open",
    "draft:false",
    ...REQUIRED_LABELS.map((l) => `label:"${l}"`),
    ...BLOCKED_LABELS.map((b) => `-label:"${b}"`),
    ...INVESTIGATION_LABELS.map((inv) => `-label:"${inv}"`),
  ];
}

const BLOCKED_LABEL_SET = new Set<string>(BLOCKED_LABELS);
const INVESTIGATION_LABEL_SET = new Set<string>(INVESTIGATION_LABELS);

/**
 * 指定されたラベル名が阻害要因・除外対象に該当するか判定する。
 */
export function isBlockedLabel(name: string): boolean {
  if (BLOCKED_LABEL_SET.has(name) || INVESTIGATION_LABEL_SET.has(name)) {
    return true;
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * ラベル一覧が比較条件（必須ラベルすべて存在、除外ラベルなし）を満たすか判定する。
 */
export function isEligibleLabels(labels: Iterable<string>): boolean {
  const labelSet = new Set(labels);
  for (const required of REQUIRED_LABELS) {
    if (!labelSet.has(required)) {
      return false;
    }
  }
  for (const name of labelSet) {
    if (isBlockedLabel(name)) {
      return false;
    }
  }
  return true;
}

/**
 * パーセンタイル値を線形補間（R-7 / Excel PERCENTILE.INC 相当）で算出する。
 */
export function getPercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    throw new Error("集計対象がありません。");
  }
  if (percentile < 0 || percentile > 1) {
    throw new RangeError("パーセンタイルは 0 以上 1 以下の数値を指定してください。");
  }

  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;

  return sorted[lower] + (sorted[upper] - sorted[lower]) * fraction;
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

/**
 * 日時を JST (UTC+9) 形式の曜日付き文字列にフォーマットする。
 * 例: "2026-11-07(土) 20:30"
 */
export function formatDateTimeWithDay(input: Date | string, offsetHours = 9): string {
  const date = typeof input === "string" ? new Date(input) : input;
  // 実行環境のタイムゾーンに依存しないよう、オフセット加算後の値を UTC として読む
  const target = new Date(date.getTime() + offsetHours * 3600000);

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
 * タイムラインイベント履歴を走査し、条件成立（Ready）となった日時を特定する。
 */
export function simulateReadySince(
  events: ProgressTimelineEvent[],
  currentIsDraft: boolean,
  endAt: Date,
): Date | null {
  // 有効なイベントのみ抽出して日付昇順ソート
  const targetEvents = events
    .filter((e) =>
      ["labeled", "unlabeled", "converted_to_draft", "ready_for_review"].includes(e.event),
    )
    .filter((e) => e.created_at && !Number.isNaN(new Date(e.created_at).getTime()))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  // 最初の Draft イベントから初期状態を逆算（なければ現在状態を採用）
  let isDraft = currentIsDraft;
  for (const event of targetEvents) {
    if (event.event === "ready_for_review") {
      isDraft = true;
      break;
    }
    if (event.event === "converted_to_draft") {
      isDraft = false;
      break;
    }
  }

  const labels = new Set<string>();
  let readySince: Date | null = null;
  const endTimestamp = endAt.getTime();

  for (const event of targetEvents) {
    const eventTime = new Date(event.created_at);
    if (eventTime.getTime() > endTimestamp) {
      break;
    }

    switch (event.event) {
      case "labeled": {
        if (event.label?.name) {
          labels.add(event.label.name);
        }
        break;
      }
      case "unlabeled": {
        if (event.label?.name) {
          labels.delete(event.label.name);
        }
        break;
      }
      case "converted_to_draft": {
        isDraft = true;
        break;
      }
      case "ready_for_review": {
        isDraft = false;
        break;
      }
    }

    const eligible = !isDraft && isEligibleLabels(labels);
    if (eligible) {
      if (readySince === null) {
        readySince = eventTime;
      }
    } else {
      readySince = null;
    }
  }

  return readySince;
}

/**
 * 収集したマージ済みサンプル群から統計値（中央値、P75、最大値）を計算する。
 */
export function calculateProgressStats(
  samples: MergedCandidateSample[],
  skippedCount = 0,
): ProgressStatsSummary | null {
  if (samples.length === 0) {
    return null;
  }

  const totalValues = samples.map((s) => s.totalDays);
  const turnValues = samples.map((s) => s.turnDays);
  const readyValues = samples.map((s) => s.days);

  const calcMetrics = (values: number[]): ProgressPercentileMetrics => {
    return {
      median: Number(getPercentile(values, 0.5).toFixed(2)),
      p75: Number(getPercentile(values, 0.75).toFixed(2)),
      max: Number(Math.max(...values).toFixed(2)),
    };
  };

  return {
    sampleCount: samples.length,
    skippedCount,
    total: calcMetrics(totalValues),
    turn: calcMetrics(turnValues),
    ready: calcMetrics(readyValues),
  };
}

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
function toHistoryRow(raw: Record<string, string>): ProgressHistoryRow {
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
  ];

  const headerLine = headers.map((h) => `"${h}"`).join(",");
  const lines = [headerLine];
  for (const row of rows) {
    const line = headers.map((h) => `"${row[h]}"`).join(",");
    lines.push(line);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * スナップショット JSON オブジェクトを構築する。
 */
export function createProgressSnapshot(params: {
  now: Date;
  repository: string;
  targetPr: number;
  prTitle: string;
  prUrl: string;
  prState: string;
  frontNumber: number;
  frontCreatedAt: string;
  activeAhead: number;
  totalAhead: number;
  behind: number;
  totalLifetimeDays: number;
  turnLatencyDays: number;
  waitDays: number;
  commitCount: number;
  stats: ProgressStatsSummary | null;
  lookbackDays: number;
  /** 条件不成立などで比較から除いた候補数（サンプルが 0 件でも記録する） */
  skippedCount: number;
  rivals: ProgressRivalPr[];
  /** 統計に採用したサンプル（stats が null のときは空） */
  samples: MergedCandidateSample[];
  targetCreatedAt: Date;
  /** 基準 PR の条件成立日時（ReadyAt） */
  targetReadyAt: Date;
}): ProgressSnapshot {
  const {
    now,
    repository,
    targetPr,
    prTitle,
    prUrl,
    prState,
    frontNumber,
    frontCreatedAt,
    activeAhead,
    totalAhead,
    behind,
    totalLifetimeDays,
    turnLatencyDays,
    waitDays,
    commitCount,
    stats,
    lookbackDays,
    skippedCount,
    rivals,
    samples,
    targetCreatedAt,
    targetReadyAt,
  } = params;

  return {
    Timestamp: now.toISOString(),
    TimestampJst: formatDateTimeWithDay(now),
    Repository: repository,
    TargetPr: targetPr,
    PrTitle: prTitle,
    PrUrl: prUrl,
    PrState: prState,
    FrontNumber: frontNumber,
    FrontCreatedAt: frontCreatedAt,
    ActiveAhead: activeAhead,
    TotalAhead: totalAhead,
    Behind: behind,
    TotalLifetimeDays: Number(totalLifetimeDays.toFixed(2)),
    TurnLatencyDays: Number(turnLatencyDays.toFixed(2)),
    WaitDays: Number(waitDays.toFixed(2)),
    CommitCount: commitCount,
    TotalMedianDays: stats ? stats.total.median : null,
    TotalP75Days: stats ? stats.total.p75 : null,
    TurnMedianDays: stats ? stats.turn.median : null,
    TurnP75Days: stats ? stats.turn.p75 : null,
    ReadyMedianDays: stats ? stats.ready.median : null,
    ReadyP75Days: stats ? stats.ready.p75 : null,
    TotalMaxDays: stats ? stats.total.max : null,
    TurnMaxDays: stats ? stats.turn.max : null,
    ReadyMaxDays: stats ? stats.ready.max : null,
    LookbackDays: lookbackDays,
    SampleCount: stats ? stats.sampleCount : 0,
    SkippedCount: skippedCount,
    Rivals: rivals.map((r) => ({
      Number: r.number,
      Title: r.title,
      Url: r.url,
      CreatedAt: r.createdAt,
      UpdatedAt: r.updatedAt,
    })),
    Samples: stats ? toSnapshotSamples(samples, targetPr) : [],
    Comparison: stats
      ? compareWithSamples(samples, {
          number: targetPr,
          createdAt: targetCreatedAt,
          readyAt: targetReadyAt,
        })
      : null,
    Guidance: stats
      ? buildGuidance(stats, samples, {
          totalDays: totalLifetimeDays,
          turnDays: turnLatencyDays,
          readyDays: waitDays,
        })
      : null,
  };
}
