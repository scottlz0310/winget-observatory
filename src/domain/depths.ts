import type {
  DepthsRow,
  DepthsSnapshot,
  GitHubPrView,
  GitHubSearchItem,
  GraphQLPrNode,
  TargetPrInfo,
} from "../models/depths";

import { BLOCKED_PATTERNS, buildHealthyQueryParts } from "./progress";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * UTC の日時（ISO 8601 文字列または Date）を JST (+09:00) の指定フォーマット文字列へ変換する。
 * 外部 I/O・環境変数に依存しない純粋関数。
 */
export function formatJstDateTime(dateOrIso: string | Date, includeSeconds = false): string {
  const date = typeof dateOrIso === "string" ? new Date(dateOrIso) : dateOrIso;
  const jstDate = new Date(date.getTime() + JST_OFFSET_MS);

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
 * タイトル文字列をコンソール/表示用に切り詰める（45文字超は先頭42文字 + "..."）。
 */
export function truncateTitle(title: string, maxLength = 45): string {
  if (title.length > maxLength) {
    return `${title.substring(0, maxLength - 3)}...`;
  }
  return title;
}

/**
 * GitHub Search API のアイテムを DepthsRow 出力形式へ変換する。
 */
export function formatDepthsRow(item: GitHubSearchItem): DepthsRow {
  return {
    PR: `#${item.number}`,
    Number: item.number,
    作成日時: formatJstDateTime(item.created_at, false),
    更新日時: formatJstDateTime(item.updated_at, false),
    CreatedAt: item.created_at,
    UpdatedAt: item.updated_at,
    タイトル: truncateTitle(item.title, 45),
    Title: item.title,
    Url: item.html_url,
  };
}

/**
 * 基準 PR の情報を TargetPrInfo 形式へ変換する。
 */
export function formatTargetPrInfo(view: GitHubPrView): TargetPrInfo {
  return {
    Number: view.number,
    Title: view.title,
    Url: view.url,
    CreatedAt: view.createdAt,
    CreatedAtJst: formatJstDateTime(view.createdAt, false),
    UpdatedAt: view.updatedAt,
  };
}

/**
 * 健康的な大底（Healthy Bottom）のベースクエリを構築する。
 */
export function buildHealthyBaseQuery(repository: string): string {
  return buildHealthyQueryParts(repository).join(" ");
}

/**
 * 真の大底（Absolute Bottom）のベースクエリを構築する。
 */
export function buildAbsoluteBaseQuery(repository: string): string {
  return `repo:${repository} is:pr is:open draft:false label:New-Package`;
}

/**
 * 特急レーン（Express Lane）のクエリを構築する。
 */
export function buildExpressQuery(repository: string, targetCreatedIso: string): string {
  return `repo:${repository} is:pr is:merged label:New-Package created:>${targetCreatedIso}`;
}

/**
 * GraphQL 検索ノードを DepthsRow 出力形式へ変換する。
 */
export function formatGraphQLDepthsRow(node: GraphQLPrNode): DepthsRow {
  return {
    PR: `#${node.number}`,
    Number: node.number,
    作成日時: formatJstDateTime(node.createdAt, false),
    更新日時: formatJstDateTime(node.updatedAt, false),
    CreatedAt: node.createdAt,
    UpdatedAt: node.updatedAt,
    タイトル: truncateTitle(node.title, 45),
    Title: node.title,
    Url: node.url,
    Author: node.author?.login,
    AuthorAssociation: node.authorAssociation,
  };
}

/**
 * GraphQL 検索ノードが「初回提出者（authorAssociation = NONE × 1コミット・除外ラベルなし）」の条件を満たすか判定する。
 */
export function isFirstTimerCandidate(node: GraphQLPrNode): boolean {
  if (!node.author?.login) {
    return false;
  }
  if (node.commits.totalCount !== 1) {
    return false;
  }
  if (node.authorAssociation !== "NONE") {
    return false;
  }
  const labelNames = node.labels?.nodes?.map((l) => l.name) ?? [];
  const hasBlockedPattern = labelNames.some((name) =>
    BLOCKED_PATTERNS.some((pattern) => pattern.test(name)),
  );
  return !hasBlockedPattern;
}

/**
 * GraphQL 検索ノードから「初回提出者（authorAssociation = NONE × 1コミット・除外ラベルなし）」を抽出し、
 * DepthsRow 形式で返す。
 */
export function filterFirstTimerCandidates(nodes: GraphQLPrNode[], limit = 10): DepthsRow[] {
  return nodes.filter(isFirstTimerCandidate).slice(0, limit).map(formatGraphQLDepthsRow);
}

/**
 * 各底の行リストとメタデータから DepthsSnapshot を組み立てる。
 */
export function createDepthsSnapshot(params: {
  now: Date;
  repository: string;
  targetPr: TargetPrInfo | null;
  healthyBottom: DepthsRow[];
  absoluteBottom: DepthsRow[];
  staleBottom: DepthsRow[];
  firstTimerBottom?: DepthsRow[];
  expressLane: DepthsRow[];
}): DepthsSnapshot {
  return {
    Timestamp: params.now.toISOString(),
    TimestampJst: formatJstDateTime(params.now, true),
    Repository: params.repository,
    TargetPr: params.targetPr,
    HealthyBottom: params.healthyBottom,
    AbsoluteBottom: params.absoluteBottom,
    StaleBottom: params.staleBottom,
    ...(params.firstTimerBottom ? { FirstTimerBottom: params.firstTimerBottom } : {}),
    ExpressLane: params.expressLane,
  };
}
