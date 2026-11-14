import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient } from "../api/github";
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
import { buildAuthorMergedCountQuery, parseAuthorMergedCounts } from "../domain/first-timer";
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
  resolveDefaultTargetPr,
} from "./args";

/** 遭難の底（更新が最も古い健康な PR）として取得・表示する件数 */
export const STALE_BOTTOM_LIMIT = 10;

/** 初回提出者の底を走査する際の 1 ページあたりの取得件数（GraphQL search の上限値） */
export const FIRST_TIMER_PAGE_SIZE = 100;

/** 初回提出者の底を走査する際の探索安全上限（終端に達する前の過剰走査を防止するガード） */
export const FIRST_TIMER_MAX_NODES = 1000;

export const FIRST_TIMER_GRAPHQL_QUERY = `query($query: String!, $first: Int!, $after: String) {
  search(query: $query, type: ISSUE, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      ... on PullRequest {
        number
        title
        url
        createdAt
        updatedAt
        author {
          login
        }
        authorAssociation
        commits {
          totalCount
        }
        labels(first: 30) {
          nodes {
            name
          }
        }
      }
    }
  }
}`;

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
const AUTHOR_MERGED_BATCH_SIZE = 25;

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

/**
 * GraphQL API を用いて優等生の底（Stale Bottom: 1コミット限定・更新日時古い順）を取得する。
 */
export async function fetchStaleBottom(
  client: GitHubApiClient,
  baseQuery: string,
  limit = STALE_BOTTOM_LIMIT,
  maxTraverseNodes = FIRST_TIMER_MAX_NODES,
): Promise<DepthsRow[]> {
  const rows = await collectBottomCandidates({
    client,
    query: `${baseQuery} sort:updated-asc`,
    limit,
    maxTraverseNodes,
    label: "優等生の底",
    filterNodes: (nodes) => nodes.filter(isStaleCandidate),
  });
  return rows.sort((a, b) => Date.parse(a.UpdatedAt) - Date.parse(b.UpdatedAt)).slice(0, limit);
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
): Promise<DepthsRow[]> {
  const repository = baseQuery.match(/\brepo:([^\s]+)/)?.[1];
  const mergedCountCache = new Map<string, number>();

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
        const unknownAuthors = Array.from(
          new Set(
            slice
              .map((n) => n.author?.login)
              .filter((login): login is string => Boolean(login))
              .filter((login) => !mergedCountCache.has(login)),
          ),
        );

        if (unknownAuthors.length > 0 && repository) {
          const mergedQuery = buildAuthorMergedCountQuery(repository, unknownAuthors);
          if (mergedQuery) {
            const res = await client.graphql<Record<string, { issueCount?: number } | undefined>>(
              mergedQuery,
              {},
            );
            const counts = parseAuthorMergedCounts(unknownAuthors, res ?? {});
            for (const [author, count] of counts) {
              mergedCountCache.set(author, count);
            }
          }
        }

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

  return rows.sort((a, b) => Date.parse(a.CreatedAt) - Date.parse(b.CreatedAt)).slice(0, limit);
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

function printRowTable(rows: DepthsRow[], log = console.log, showCommitCount = false): void {
  if (rows.length === 0) {
    log("  （該当なし）");
    return;
  }
  for (const row of rows) {
    const commitCol = showCommitCount ? ` | ${String(row.CommitCount ?? "-").padStart(2)}c` : "";
    log(`  ${row.PR.padEnd(8)}${commitCol} | ${row.作成日時} | ${row.更新日時} | ${row.タイトル}`);
  }
}

/**
 * 既定の data/ ディレクトリをエントリポイント位置からリポジトリルートを起点に解決する
 */
export function resolveDefaultDataDir(): string {
  const repoRoot = resolve(import.meta.dirname, "../..");
  return resolve(repoRoot, "data");
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

  // 3. 優等生の底（Stale Bottom）: 指摘なく健康な1コミット限定 PR の中で更新日時が古い先頭
  const staleBottom = await fetchStaleBottom(client, healthyBase, STALE_BOTTOM_LIMIT);

  // 4. 初回提出者の底（First-Timer Bottom）: 初回提出者（NONE・生涯マージ 0 回）の健康な PR 全体（手直し込み・起票日時順）
  const firstTimerBottom = await fetchFirstTimerBottom(client, healthyBase, STALE_BOTTOM_LIMIT);

  // 5. 特急レーン（Express Lane）
  let expressBottom: DepthsRow[] = [];
  if (hasTarget && targetCreatedAtIso) {
    const expressQuery = buildExpressQuery(options.repository, targetCreatedAtIso);
    const expressItems = await client.searchIssues(expressQuery, "updated", "desc", 5);
    expressBottom = expressItems.map(formatDepthsRow);
  }

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
    printRowTable(staleBottom, log);
    log("");

    log("【4. 初回提出者の底 (First-Timer Bottom)】");
    log(
      "説明: 初回提出者（authorAssociation = NONE・生涯マージ 0 回）の健康なPR全体（手直し込み）の、起票日時(created)が最も古い先頭",
    );
    printRowTable(firstTimerBottom, log, true);
    log("");

    if (hasTarget && targetInfo) {
      log("【5. 特急レーン・追い越し (Express Lane)】");
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
    now: new Date(),
    repository: options.repository,
    targetPr: targetInfo,
    healthyBottom,
    absoluteBottom,
    staleBottom,
    firstTimerBottom,
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
