import type {
  DepthsRow,
  DepthsSnapshot,
  FirstReviewFrontier,
  GitHubPrView,
  GitHubSearchItem,
  GraphQLPrNode,
  PrInterventionSummary,
  TargetPrInfo,
} from "../models/depths";

import { isPrivilegedOrBotAuthor } from "./first-timer";
import { DAY_MS, formatJstDateTime, round1 } from "./formatters";
import { extractThirdPartyAssignees } from "./intervention";
import { buildHealthyQueryParts } from "./labels";

export { extractThirdPartyAssignees, formatJstDateTime };

/**
 * GraphQL PullRequest ノードから第三者 Assignees 一覧を取得する。
 */
export function getThirdPartyAssignees(
  node: Pick<GraphQLPrNode, "author" | "assignees">,
): string[] {
  return extractThirdPartyAssignees(node.assignees?.nodes, node.author?.login);
}

/**
 * 現行の底スナップショット定義バージョン。
 * - 未設定 / 1: 旧定義（StaleBottom=全コミット、FirstTimerBottom=updatedAt順・生涯マージ未検証）
 * - 2: 役割分離版（StaleBottom=1コミット限定、FirstTimerBottom=createdAt順・生涯マージ0回検証済み、Unassigned/Assigned）
 * - 3: 介入判定分離版（UnreviewedBottom / IntervenedBottom: 人間レビュー・手動コメント・第三者アサイン OR 分離）
 * - 4: 主戦場ライン版（FirstReviewFrontier: 直近7日間初回人間介入コホートの createdAt 中央値・オープン＋マージ済み）
 * - 5: 2×2 待機ライン統一版（HealthyBottom GraphQL TOP 10、SingleCommitBottom / FirstTimerSingleCommitBottom / FirstTimerUnreviewedBottom、全象限作者メタデータ統一）
 */
export const CURRENT_DEPTHS_VERSION = 5;

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
    ...(view.author !== undefined ? { Author: view.author } : {}),
    ...(view.thirdPartyAssignees !== undefined
      ? { ThirdPartyAssignees: view.thirdPartyAssignees }
      : {}),
    ...(view.intervention !== undefined ? { Intervention: view.intervention } : {}),
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
export function formatGraphQLDepthsRow(
  node: GraphQLPrNode,
  intervention?: PrInterventionSummary,
): DepthsRow {
  const thirdPartyAssignees =
    intervention !== undefined
      ? intervention.ThirdPartyAssignees
      : node.assignees !== undefined
        ? getThirdPartyAssignees(node)
        : undefined;

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
    CommitCount: node.commits?.totalCount,
    ...(thirdPartyAssignees !== undefined ? { ThirdPartyAssignees: thirdPartyAssignees } : {}),
    ...(intervention !== undefined ? { Intervention: intervention } : {}),
  };
}

/**
 * GraphQL 検索ノードが「優等生の底（1コミット限定）」の条件を満たすか判定する。
 * 阻害ラベルの除外は Search クエリ（`-label:...`）側で実施済み。
 */
export function isStaleCandidate(node: GraphQLPrNode): boolean {
  return node.commits?.totalCount === 1;
}

/**
 * GraphQL 検索ノードが「初回提出者（authorAssociation = NONE）」の条件を満たすか判定する。
 * 阻害ラベルの除外は Search クエリ（`-label:...`）側で実施済み。
 * PR #65（初回提出者コホートのコミット数制限撤廃）に準拠し、手直しコミットが入った健康な初回提出者も許容する。
 */
export function isFirstTimerCandidate(node: GraphQLPrNode): boolean {
  if (!node.author?.login) {
    return false;
  }
  return node.authorAssociation === "NONE";
}

/**
 * DepthsRow が初回提出者（オープン中 PR 基準: 非特権・非 Bot・authorAssociation=NONE・生涯マージ 0 回）か判定する SSoT ヘルパー。
 */
export function isFirstTimerDepthsRow(
  row: Pick<DepthsRow, "Author" | "AuthorAssociation" | "AuthorMergedCount">,
): boolean {
  if (!row.Author) {
    return false;
  }
  if (
    isPrivilegedOrBotAuthor({
      author: row.Author,
      authorAssociation: row.AuthorAssociation,
    })
  ) {
    return false;
  }
  return row.AuthorAssociation === "NONE" && row.AuthorMergedCount === 0;
}

export interface AssigneeFrontierSummary {
  /** 抽出された上位件数 */
  count: number;
  /** 先頭 PR（起票日時が最古の行）。該当なしなら null */
  head: DepthsRow | null;
  /** 先頭 PR の起票日時からの経過日数（日）。算出不能なら null */
  headElapsedDays: number | null;
  /** 第三者 Assignees 別の件数内訳（件数降順） */
  assigneeCounts: Array<{ login: string; count: number }>;
}

/**
 * 未アサイン前線／アサイン済み前線の行リストから、先頭位置・経過日数・アサイン内訳を算出する。
 */
export function summarizeAssigneeFrontier(
  rows: DepthsRow[],
  observedAt: Date | string | number,
): AssigneeFrontierSummary {
  const head = rows[0] ?? null;
  const observedMs =
    observedAt instanceof Date
      ? observedAt.getTime()
      : typeof observedAt === "number"
        ? observedAt
        : Date.parse(observedAt);
  const headCreatedMs = head ? Date.parse(head.CreatedAt) : Number.NaN;
  const headElapsedDays =
    Number.isFinite(observedMs) && Number.isFinite(headCreatedMs)
      ? round1((observedMs - headCreatedMs) / DAY_MS)
      : null;

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const login of row.ThirdPartyAssignees ?? []) {
      counts.set(login, (counts.get(login) ?? 0) + 1);
    }
  }
  const assigneeCounts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([login, count]) => ({ login, count }));

  return {
    count: rows.length,
    head,
    headElapsedDays,
    assigneeCounts,
  };
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
  singleCommitBottom?: DepthsRow[];
  firstTimerSingleCommitBottom?: DepthsRow[];
  singleCommitTruncated?: boolean;
  firstTimerSingleCommitTruncated?: boolean;
  staleBottom: DepthsRow[];
  firstTimerBottom?: DepthsRow[];
  firstTimerBottomTruncated?: boolean;
  unreviewedBottom?: DepthsRow[];
  firstTimerUnreviewedBottom?: DepthsRow[];
  intervenedBottom?: DepthsRow[];
  unreviewedTruncated?: boolean;
  firstTimerUnreviewedTruncated?: boolean;
  intervenedTruncated?: boolean;
  firstReviewFrontier?: FirstReviewFrontier;
  allAuthorsFirstReviewFrontier?: FirstReviewFrontier;
  expressLane: DepthsRow[];
}): DepthsSnapshot {
  return {
    DepthsVersion: CURRENT_DEPTHS_VERSION,
    Timestamp: params.now.toISOString(),
    TimestampJst: formatJstDateTime(params.now, true),
    Repository: params.repository,
    TargetPr: params.targetPr,
    HealthyBottom: params.healthyBottom,
    AbsoluteBottom: params.absoluteBottom,
    ...(params.singleCommitBottom ? { SingleCommitBottom: params.singleCommitBottom } : {}),
    ...(params.firstTimerSingleCommitBottom
      ? { FirstTimerSingleCommitBottom: params.firstTimerSingleCommitBottom }
      : {}),
    ...(params.singleCommitTruncated ? { SingleCommitTruncated: true } : {}),
    ...(params.firstTimerSingleCommitTruncated ? { FirstTimerSingleCommitTruncated: true } : {}),
    StaleBottom: params.staleBottom,
    ...(params.firstTimerBottom ? { FirstTimerBottom: params.firstTimerBottom } : {}),
    ...(params.firstTimerBottomTruncated ? { FirstTimerBottomTruncated: true } : {}),
    ...(params.unreviewedBottom ? { UnreviewedBottom: params.unreviewedBottom } : {}),
    ...(params.firstTimerUnreviewedBottom
      ? { FirstTimerUnreviewedBottom: params.firstTimerUnreviewedBottom }
      : {}),
    ...(params.intervenedBottom ? { IntervenedBottom: params.intervenedBottom } : {}),
    ...(params.unreviewedTruncated ? { UnreviewedTruncated: true } : {}),
    ...(params.firstTimerUnreviewedTruncated ? { FirstTimerUnreviewedTruncated: true } : {}),
    ...(params.intervenedTruncated ? { IntervenedTruncated: true } : {}),
    ...(params.firstReviewFrontier ? { FirstReviewFrontier: params.firstReviewFrontier } : {}),
    ...(params.allAuthorsFirstReviewFrontier
      ? { AllAuthorsFirstReviewFrontier: params.allAuthorsFirstReviewFrontier }
      : {}),
    ExpressLane: params.expressLane,
  };
}
