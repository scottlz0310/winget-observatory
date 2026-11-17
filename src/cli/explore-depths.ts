import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient, parseRepository, resolvePrInterventionWithPaging } from "../api/github";
import {
  buildPullRequestBatchInterventionQuery,
  FIRST_TIMER_GRAPHQL_QUERY,
  SEARCH_PR_NUMBERS_QUERY,
} from "../api/graphql-queries";
import type { GraphQLPullRequestNode } from "../api/graphql-types";
import {
  buildAbsoluteBaseQuery,
  buildExpressQuery,
  buildHealthyBaseQuery,
  createDepthsSnapshot,
  formatDepthsRow,
  formatGraphQLDepthsRow,
  formatTargetPrInfo,
  isFirstTimerCandidate,
  isStaleCandidate,
} from "../domain/depths";
import { DEFAULT_AUTHOR_MERGED_BATCH_SIZE, resolveAuthorMergedCounts } from "../domain/first-timer";
import { summarizeInterventionFrontier } from "../domain/intervention";
import type {
  DepthsRow,
  DepthsSnapshot,
  ExploreDepthsOptions,
  GraphQLPrNode,
  TargetPrInfo,
} from "../models/depths";
import {
  DEFAULT_REPOSITORY,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultDataDir,
  resolveDefaultTargetPr,
} from "./args";

export { resolveDefaultDataDir };

/** 遭難の底（更新が最も古い健康な PR）として取得・表示する件数 */
export const STALE_BOTTOM_LIMIT = 10;

/** 初回提出者の底を走査する際の 1 ページあたりの取得件数（GraphQL search の上限値） */
export const FIRST_TIMER_PAGE_SIZE = 100;

/** 初回提出者の底を走査する際の探索安全上限（終端に達する前の過剰走査を防止するガード） */
export const FIRST_TIMER_MAX_NODES = 1000;

export interface GraphQLSearchFirstTimerResponse {
  search?: {
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
    nodes?: GraphQLPrNode[];
  };
}

/** 生涯マージ件数チェックの 1 バッチあたり最大作者数 */
const AUTHOR_MERGED_BATCH_SIZE = DEFAULT_AUTHOR_MERGED_BATCH_SIZE;

interface CollectBottomOptions {
  client: GitHubApiClient;
  query: string;
  limit: number;
  maxTraverseNodes: number;
  label: string;
  filterNodes: (
    nodes: GraphQLPrNode[],
    needed: number,
  ) => Promise<GraphQLPrNode[]> | GraphQLPrNode[];
}

/**
 * GraphQL Search をページング走査して、条件に一致する底の候補を limit 件まで収集する共通ヘルパー。
 */
async function collectBottomCandidates({
  client,
  query,
  limit,
  maxTraverseNodes,
  label,
  filterNodes,
}: CollectBottomOptions): Promise<DepthsRow[]> {
  let cursor: string | null = null;
  let hasNext = true;
  let traversedCount = 0;
  const collectedRows: DepthsRow[] = [];

  while (hasNext && collectedRows.length < limit) {
    if (traversedCount >= maxTraverseNodes) {
      throw new Error(
        `${label}の探索上限 (${maxTraverseNodes}件) に達しましたが、未走査の PR が残っています (採用件数: ${collectedRows.length}/${limit}件)。不完全な結果を避けるため中断します。`,
      );
    }

    const fetchCount = Math.min(FIRST_TIMER_PAGE_SIZE, maxTraverseNodes - traversedCount);
    try {
      const gqlRes: GraphQLSearchFirstTimerResponse =
        await client.graphql<GraphQLSearchFirstTimerResponse>(FIRST_TIMER_GRAPHQL_QUERY, {
          query,
          first: fetchCount,
          ...(cursor ? { after: cursor } : {}),
        });

      const nodes = gqlRes.search?.nodes ?? [];
      traversedCount += nodes.length;

      const needed = limit - collectedRows.length;
      const matched = await filterNodes(nodes, needed);
      for (const node of matched) {
        if (collectedRows.length >= limit) break;
        collectedRows.push(formatGraphQLDepthsRow(node));
      }

      hasNext = Boolean(gqlRes.search?.pageInfo?.hasNextPage);
      cursor = gqlRes.search?.pageInfo?.endCursor ?? null;

      if (!cursor || nodes.length === 0) {
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${label}の GraphQL 取得に失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }

  return collectedRows.slice(0, limit);
}

/** baseQuery から `repo:owner/name` 部分を抽出する */
function extractRepositoryFromQuery(baseQuery: string): string | undefined {
  return baseQuery.match(/\brepo:([^\s]+)/)?.[1];
}

/**
 * GraphQL API を用いて優等生の底（Stale Bottom: 1コミット限定・更新日時古い順）を取得する。
 * `authorAssociation === "NONE"` の行については生涯マージ数を照会し、`AuthorMergedCount` に記録する。
 */
export async function fetchStaleBottom(
  client: GitHubApiClient,
  baseQuery: string,
  limit = STALE_BOTTOM_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  mergedCountCache = new Map<string, number>(),
): Promise<DepthsRow[]> {
  const repository = extractRepositoryFromQuery(baseQuery);
  const rows = await collectBottomCandidates({
    client,
    query: `${baseQuery} sort:updated-asc`,
    limit,
    maxTraverseNodes,
    label: "優等生の底",
    filterNodes: (nodes) => nodes.filter(isStaleCandidate),
  });
  const sorted = rows.slice(0, limit);

  const noneAuthors = sorted
    .filter((row) => row.AuthorAssociation === "NONE" && Boolean(row.Author))
    .map((row) => row.Author as string);

  if (noneAuthors.length > 0 && repository) {
    try {
      await resolveAuthorMergedCounts(
        repository,
        noneAuthors,
        (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query, {}),
        { batchSize: AUTHOR_MERGED_BATCH_SIZE, cache: mergedCountCache },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`優等生の底の GraphQL 取得に失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }

  return sorted.map((row) => {
    if (row.AuthorAssociation === "NONE" && row.Author && mergedCountCache.has(row.Author)) {
      return { ...row, AuthorMergedCount: mergedCountCache.get(row.Author) };
    }
    return row;
  });
}

/**
 * GraphQL API を用いて初回提出者の底（First-Timer Bottom: 起票日時古い順・手直し込み・生涯マージ0回）を取得する。
 * 採用件数（limit）に達するか走査終了（hasNextPage=false）まで最大 maxTraverseNodes 件までページング走査する。
 * 通信障害や認証エラー時は例外を握りつぶさずコンテキスト付き例外として伝播させる。
 */
export async function fetchFirstTimerBottom(
  client: GitHubApiClient,
  baseQuery: string,
  limit = STALE_BOTTOM_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  mergedCountCache = new Map<string, number>(),
): Promise<DepthsRow[]> {
  const repository = extractRepositoryFromQuery(baseQuery);

  const rows = await collectBottomCandidates({
    client,
    query: `${baseQuery} sort:created-asc`,
    limit,
    maxTraverseNodes,
    label: "初回提出者の底",
    filterNodes: async (nodes, needed) => {
      const candidates = nodes.filter(isFirstTimerCandidate);
      const zeroMergedNodes: GraphQLPrNode[] = [];

      for (
        let i = 0;
        i < candidates.length && zeroMergedNodes.length < needed;
        i += AUTHOR_MERGED_BATCH_SIZE
      ) {
        const slice = candidates.slice(i, i + AUTHOR_MERGED_BATCH_SIZE);
        const authors = slice
          .map((n) => n.author?.login)
          .filter((login): login is string => Boolean(login));

        await resolveAuthorMergedCounts(
          repository ?? "",
          authors,
          (query) => client.graphql<Record<string, { issueCount?: number } | undefined>>(query, {}),
          { batchSize: AUTHOR_MERGED_BATCH_SIZE, cache: mergedCountCache },
        );

        for (const node of slice) {
          const login = node.author?.login;
          if (!login) continue;
          if ((mergedCountCache.get(login) ?? 0) === 0) {
            zeroMergedNodes.push(node);
            if (zeroMergedNodes.length >= needed) break;
          }
        }
      }

      return zeroMergedNodes;
    },
  });

  return rows.slice(0, limit);
}

/** 介入判定バッチ 1 リクエストあたりの PR 取得件数 */
export const INTERVENTION_BATCH_SIZE = 15;

export interface InterventionFrontiersResult {
  unreviewedBottom: DepthsRow[];
  intervenedBottom: DepthsRow[];
  unreviewedTruncated: boolean;
  intervenedTruncated: boolean;
}

interface GraphQLSearchNumbersResponse {
  search?: {
    pageInfo?: {
      hasNextPage?: boolean;
      endCursor?: string | null;
    };
    nodes?: Array<{ number?: number | null } | null>;
  };
}

/**
 * 2 段階パイプライン（第1段階: 軽量 Search で PR 番号収集 → 第2段階: GraphQL alias バッチで詳細エッジ判定）により、
 * 健康な待機 PR（sort:created-asc）を「未レビュー（完全未着手）前線」と「レビュー・介入済み前線」に分離して各上位 limit 件を抽出する。
 * 両区分が limit 件に到達した時点で後続バッチ・後続 Search ページの取得を即打ち切る。
 * 走査上限到達により未走査 PR を残したまま打ち切られた区分は *Truncated=true として記録する。
 */
export async function fetchInterventionFrontiers(
  client: GitHubApiClient,
  baseQuery: string,
  limit = STALE_BOTTOM_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
  batchSize = INTERVENTION_BATCH_SIZE,
): Promise<InterventionFrontiersResult> {
  const { owner, name } = parseRepository(
    extractRepositoryFromQuery(baseQuery) ?? DEFAULT_REPOSITORY,
  );
  let cursor: string | null = null;
  let hasNext = true;
  let traversedCount = 0;
  let reachedNaturalEnd = false;
  const unreviewedBottom: DepthsRow[] = [];
  const intervenedBottom: DepthsRow[] = [];
  const query = `${baseQuery} sort:created-asc`;
  const graphqlInvoker = <T = unknown>(q: string, vars?: Record<string, unknown>) =>
    client.graphql<T>(q, vars);

  while (
    hasNext &&
    traversedCount < maxTraverseNodes &&
    (unreviewedBottom.length < limit || intervenedBottom.length < limit)
  ) {
    const fetchCount = Math.min(FIRST_TIMER_PAGE_SIZE, maxTraverseNodes - traversedCount);
    try {
      const searchRes: GraphQLSearchNumbersResponse =
        await client.graphql<GraphQLSearchNumbersResponse>(SEARCH_PR_NUMBERS_QUERY, {
          query,
          first: fetchCount,
          ...(cursor ? { after: cursor } : {}),
        });

      const rawNodes = searchRes.search?.nodes ?? [];
      traversedCount += rawNodes.length;
      const numbers = rawNodes
        .map((n) => n?.number)
        .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0);

      for (let i = 0; i < numbers.length; i += batchSize) {
        if (unreviewedBottom.length >= limit && intervenedBottom.length >= limit) {
          break;
        }
        const chunk = numbers.slice(i, i + batchSize);
        const batchQuery = buildPullRequestBatchInterventionQuery(chunk);
        const batchRes = await client.graphql<{
          repository?: Record<string, (GraphQLPullRequestNode & GraphQLPrNode) | null> | null;
        }>(batchQuery, { owner, name });

        const repoNodes = batchRes.repository ?? {};
        for (let idx = 0; idx < chunk.length; idx++) {
          const prNode = repoNodes[`pr${idx}`];
          if (!prNode?.number) continue;

          const { node: resolvedNode, summary } = await resolvePrInterventionWithPaging(
            graphqlInvoker,
            owner,
            name,
            prNode,
          );
          const row = formatGraphQLDepthsRow(resolvedNode, summary);

          if (!summary.Intervened) {
            if (unreviewedBottom.length < limit) {
              unreviewedBottom.push(row);
            }
          } else if (intervenedBottom.length < limit) {
            intervenedBottom.push(row);
          }

          if (unreviewedBottom.length >= limit && intervenedBottom.length >= limit) {
            break;
          }
        }
      }

      hasNext = Boolean(searchRes.search?.pageInfo?.hasNextPage);
      cursor = searchRes.search?.pageInfo?.endCursor ?? null;

      if (!hasNext || !cursor || rawNodes.length === 0) {
        reachedNaturalEnd = true;
        break;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`未レビュー前線・介入済み前線の GraphQL 取得に失敗しました: ${msg}`, {
        cause: err,
      });
    }
  }

  return {
    unreviewedBottom: unreviewedBottom.slice(0, limit),
    intervenedBottom: intervenedBottom.slice(0, limit),
    unreviewedTruncated: !reachedNaturalEnd && unreviewedBottom.length < limit,
    intervenedTruncated: !reachedNaturalEnd && intervenedBottom.length < limit,
  };
}

export function parseArgs(argv: string[]): ExploreDepthsOptions {
  let targetPr = resolveDefaultTargetPr();
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let outputPath: string | undefined = process.env.WINGET_DEPTHS_OUTPUT_PATH;
  let historyPath: string | undefined = process.env.WINGET_DEPTHS_HISTORY_PATH;
  let noTargetPr = false;
  let noHistory = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target-pr") {
      targetPr = parseTargetPrArg(readOptionValue(argv, i++, "正の整数の値"));
    } else if (arg === "--repository") {
      repository = readOptionValue(argv, i++, "リポジトリ名 (owner/repo) の値");
    } else if (arg === "--output-path") {
      outputPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--history-path") {
      historyPath = readOptionValue(argv, i++, "ファイルパス");
    } else if (arg === "--no-target-pr") {
      noTargetPr = true;
    } else if (arg === "--no-history") {
      noHistory = true;
    } else if (arg === "--as-json") {
      asJson = true;
    } else {
      throw new Error(`未知の引数が指定されました: ${arg}`);
    }
  }

  return {
    targetPr,
    repository,
    outputPath,
    historyPath,
    noTargetPr,
    noHistory,
    asJson,
  };
}

function printRowTable(
  rows: DepthsRow[],
  log = console.log,
  options:
    | { showCommitCount?: boolean; showThirdPartyAssignees?: boolean; showIntervention?: boolean }
    | boolean = false,
): void {
  const showCommitCount =
    typeof options === "boolean" ? options : (options.showCommitCount ?? false);
  const showThirdPartyAssignees =
    typeof options === "boolean" ? false : (options.showThirdPartyAssignees ?? false);
  const showIntervention =
    typeof options === "boolean" ? false : (options.showIntervention ?? false);
  if (rows.length === 0) {
    log("  （該当なし）");
    return;
  }
  for (const row of rows) {
    const commitCol = showCommitCount ? ` | ${String(row.CommitCount ?? "-").padStart(2)}c` : "";
    const badgeLabel = showIntervention ? row.Intervention?.PrimaryBadge?.Label : undefined;
    const assigneeCol = badgeLabel
      ? ` | [${badgeLabel}]`
      : (showThirdPartyAssignees || showIntervention) &&
          row.ThirdPartyAssignees &&
          row.ThirdPartyAssignees.length > 0
        ? ` | [${row.ThirdPartyAssignees.join(", ")}]`
        : "";
    log(
      `  ${row.PR.padEnd(8)}${commitCol} | ${row.作成日時} | ${row.更新日時}${assigneeCol} | ${row.タイトル}`,
    );
  }
}

/**
 * キュー境界探索の実行コア関数
 */
export async function runExploreDepths(
  options: ExploreDepthsOptions,
  client = new GitHubApiClient(),
  log = console.log,
): Promise<DepthsSnapshot> {
  const hasTarget = options.targetPr > 0 && !options.noTargetPr;
  let targetInfo: TargetPrInfo | null = null;
  let targetCreatedAtIso: string | null = null;

  if (hasTarget) {
    // 基準 PR 無しのスナップショットを履歴へ追記すると時系列が汚れるため、取得失敗は中断する
    // （基準 PR 無しで実行したい場合は --no-target-pr を明示する）
    const prView = await client.getPullRequest(options.repository, options.targetPr);
    targetInfo = formatTargetPrInfo(prView);
    targetCreatedAtIso = prView.createdAt;

    if (!options.asJson) {
      log("=== winget-pkgs キュー境界探索 ===");
      log(`基準PR : #${targetInfo.Number} (${targetInfo.Title})`);
      log(`作成日 : ${targetInfo.CreatedAtJst}`);
      log("");
    }
  } else if (!options.asJson) {
    log("=== winget-pkgs キュー境界探索 (全体観測モード) ===");
    log(`対象リポジトリ: ${options.repository}`);
    log("");
  }

  // 1. 健康的な大底（Healthy Bottom）
  const healthyBase = buildHealthyBaseQuery(options.repository);
  const healthyItems = await client.searchIssues(healthyBase, "created", "asc", 3);
  const healthyBottom = healthyItems.map(formatDepthsRow);

  // 2. 真の大底（Absolute Bottom）
  const absoluteBase = buildAbsoluteBaseQuery(options.repository);
  const absoluteItems = await client.searchIssues(absoluteBase, "created", "asc", 3);
  const absoluteBottom = absoluteItems.map(formatDepthsRow);

  const mergedCountCache = new Map<string, number>();

  // 3. 優等生の底（Stale Bottom）: 指摘なく健康な1コミット限定 PR の中で更新日時が古い先頭
  const staleBottom = await fetchStaleBottom(
    client,
    healthyBase,
    STALE_BOTTOM_LIMIT,
    FIRST_TIMER_MAX_NODES,
    mergedCountCache,
  );

  // 4. 初回提出者の底（First-Timer Bottom）: 初回提出者（NONE・生涯マージ 0 回）の健康な PR 全体（手直し込み・起票日時順）
  const firstTimerBottom = await fetchFirstTimerBottom(
    client,
    healthyBase,
    STALE_BOTTOM_LIMIT,
    FIRST_TIMER_MAX_NODES,
    mergedCountCache,
  );

  // 5. 未レビュー（完全未着手）前線／レビュー・介入済み前線（健康な待機 PR を 2 段階判定で分離・起票日時順）
  const { unreviewedBottom, intervenedBottom, unreviewedTruncated, intervenedTruncated } =
    await fetchInterventionFrontiers(
      client,
      healthyBase,
      STALE_BOTTOM_LIMIT,
      FIRST_TIMER_MAX_NODES,
    );

  // 6. 特急レーン（Express Lane）
  let expressBottom: DepthsRow[] = [];
  if (hasTarget && targetCreatedAtIso) {
    const expressQuery = buildExpressQuery(options.repository, targetCreatedAtIso);
    const expressItems = await client.searchIssues(expressQuery, "updated", "desc", 5);
    expressBottom = expressItems.map(formatDepthsRow);
  }

  const now = new Date();
  const unreviewedSummary = summarizeInterventionFrontier(unreviewedBottom, now);
  const intervenedSummary = summarizeInterventionFrontier(intervenedBottom, now);

  if (!options.asJson) {
    log("【1. 健康的な大底 (Healthy Bottom)】");
    log("説明: CI通過・エラーなしの健康体で、現在最も古いオープンPR (FIFOの正当な先頭)");
    printRowTable(healthyBottom, log);
    log("");

    log("【2. 真の大底 (Absolute Bottom)】");
    log("説明: 状態やエラーを問わず、未クローズの New-Package で最も古いPR");
    printRowTable(absoluteBottom, log);
    log("");

    log("【3. 優等生の底 (Stale Bottom / Healthy Oldest)】");
    log(
      "説明: 指摘なく健康な1コミット限定PR（常連含む）の中で、更新日時(updated)が最も古い放置前線",
    );
    printRowTable(staleBottom, log, { showThirdPartyAssignees: true });
    log("");

    log("【4. 初回提出者の底 (First-Timer Bottom)】");
    log(
      "説明: 初回提出者（authorAssociation = NONE・生涯マージ 0 回）の健康なPR全体（手直し込み）の、起票日時(created)が最も古い先頭",
    );
    printRowTable(firstTimerBottom, log, { showCommitCount: true, showThirdPartyAssignees: true });
    log("");

    log("【5A. 未レビュー（完全未着手）前線 (Unreviewed Frontier)】");
    const unreviewedTruncatedNote = unreviewedTruncated ? " [※走査上限到達のため一部未完了]" : "";
    log(
      `説明: 人間レビュー・手動コメント・第三者 Assignees がすべて無い健康なPR（ボット・作成者本人・自動ログ除く）の起票順先頭 (上位 ${unreviewedSummary.count} 件 / 先頭: ${unreviewedSummary.head ? `${unreviewedSummary.head.PR} 起票 ${unreviewedSummary.head.作成日時}・経過 ${unreviewedSummary.headElapsedDays ?? "-"} 日` : unreviewedTruncated ? "走査上限到達・未確定" : "該当なし"})${unreviewedTruncatedNote}`,
    );
    if (unreviewedBottom.length === 0 && unreviewedTruncated) {
      log("  走査上限に到達し、未走査の PR が残っているため有無は未確定です");
    } else {
      printRowTable(unreviewedBottom, log, { showCommitCount: true });
    }
    log("");

    log("【5B. レビュー・介入済み前線 (Intervened Frontier)】");
    const intervenedTruncatedNote = intervenedTruncated ? " [※走査上限到達のため一部未完了]" : "";
    const kindParts: string[] = [];
    if (intervenedSummary.kindCounts.review > 0) {
      kindParts.push(`レビュー(${intervenedSummary.kindCounts.review})`);
    }
    if (intervenedSummary.kindCounts.comment > 0) {
      kindParts.push(`コメント(${intervenedSummary.kindCounts.comment})`);
    }
    if (intervenedSummary.kindCounts.assignee > 0) {
      kindParts.push(`アサイン(${intervenedSummary.kindCounts.assignee})`);
    }
    const intervenedBreakdown = kindParts.length > 0 ? ` / 内訳: ${kindParts.join(", ")}` : "";
    log(
      `説明: 人間レビュー・手動コメント・第三者 Assignees のいずれかが付いている健康なPRの起票順先頭 (上位 ${intervenedSummary.count} 件 / 先頭: ${intervenedSummary.head ? `${intervenedSummary.head.PR} 起票 ${intervenedSummary.head.作成日時}・経過 ${intervenedSummary.headElapsedDays ?? "-"} 日` : intervenedTruncated ? "走査上限到達・未確定" : "該当なし"}${intervenedBreakdown})${intervenedTruncatedNote}`,
    );
    if (intervenedBottom.length === 0 && intervenedTruncated) {
      log("  走査上限に到達し、未走査の PR が残っているため有無は未確定です");
    } else {
      printRowTable(intervenedBottom, log, { showCommitCount: true, showIntervention: true });
    }
    log("");

    if (hasTarget && targetInfo) {
      log("【6. 特急レーン・追い越し (Express Lane)】");
      log(`説明: あなたのPR作成日(${targetInfo.CreatedAtJst})以降に作成され、すでにマージされたPR`);
      if (expressBottom.length > 0) {
        printRowTable(expressBottom, log);
      } else {
        log("  該当なし（追い越しマージはありません）");
      }
      log("");
    }
  }

  const snapshot = createDepthsSnapshot({
    now,
    repository: options.repository,
    targetPr: targetInfo,
    healthyBottom,
    absoluteBottom,
    staleBottom,
    firstTimerBottom,
    unreviewedBottom,
    intervenedBottom,
    unreviewedTruncated,
    intervenedTruncated,
    expressLane: expressBottom,
  });

  if (options.asJson) {
    log(JSON.stringify(snapshot, null, 2));
  }

  // 既定の data/ ディレクトリはエントリポイント位置（src/cli/explore-depths.ts）を起点にリポジトリルートから解決する
  const defaultDataDir = resolveDefaultDataDir();

  // 1. JSONL 履歴ファイルへの追記（蓄積）
  if (!options.noHistory) {
    const historyPath = options.historyPath
      ? resolve(process.cwd(), options.historyPath)
      : resolve(defaultDataDir, "depths-history.jsonl");

    const historyDir = dirname(historyPath);
    if (!existsSync(historyDir)) {
      mkdirSync(historyDir, { recursive: true });
    }

    try {
      const line = `${JSON.stringify(snapshot)}\n`;
      appendFileSync(historyPath, line, "utf-8");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`キュー境界履歴 (JSONL) の保存に失敗しました (${historyPath}): ${message}`);
    }
  }

  // 2. 最新スナップショット JSON の上書き保存
  const outputPath = options.outputPath
    ? resolve(process.cwd(), options.outputPath)
    : resolve(defaultDataDir, "latest-depths.json");

  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  try {
    writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`最新スナップショット (JSON) の保存に失敗しました (${outputPath}): ${message}`);
  }

  return snapshot;
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await runExploreDepths(options);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`エラー: ${message}`);
    process.exit(1);
  }
}
