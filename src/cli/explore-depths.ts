import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitHubApiClient } from "../api/github";
import {
  buildAbsoluteBaseQuery,
  buildExpressQuery,
  buildHealthyBaseQuery,
  createDepthsSnapshot,
  formatDepthsRow,
  formatTargetPrInfo,
} from "../domain/depths";
import { summarizeInterventionFrontier } from "../domain/intervention";
import type {
  DepthsRow,
  DepthsSnapshot,
  ExploreDepthsOptions,
  TargetPrInfo,
} from "../models/depths";
import {
  DEFAULT_REPOSITORY,
  parseTargetPrArg,
  readOptionValue,
  resolveDefaultDataDir,
  resolveDefaultTargetPr,
} from "./args";
import {
  BOTTOM_LIST_LIMIT,
  type BottomPairResult,
  FIRST_TIMER_MAX_NODES,
  FIRST_TIMER_PAGE_SIZE,
  fetchFirstTimerBottom,
  fetchHealthyBottoms,
  type GraphQLSearchFirstTimerResponse,
} from "./depths-bottom-collector";
import {
  fetchInterventionFrontiers,
  INTERVENTION_BATCH_SIZE,
  type InterventionFrontiersResult,
} from "./depths-intervention-collector";
import {
  type FirstReviewFrontiersResult,
  fetchFirstReviewFrontiers,
  fetchFirstReviewMainstreamFrontier,
  MAINSTREAM_SEARCH_PAGE_SIZE,
} from "./depths-mainstream-collector";

export type {
  BottomPairResult,
  FirstReviewFrontiersResult,
  GraphQLSearchFirstTimerResponse,
  InterventionFrontiersResult,
};
export {
  BOTTOM_LIST_LIMIT,
  FIRST_TIMER_MAX_NODES,
  FIRST_TIMER_PAGE_SIZE,
  fetchFirstReviewFrontiers,
  fetchFirstReviewMainstreamFrontier,
  fetchFirstTimerBottom,
  fetchHealthyBottoms,
  fetchInterventionFrontiers,
  INTERVENTION_BATCH_SIZE,
  MAINSTREAM_SEARCH_PAGE_SIZE,
  resolveDefaultDataDir,
};

export function parseArgs(argv: string[]): ExploreDepthsOptions {
  let targetPr = resolveDefaultTargetPr();
  let repository = process.env.WINGET_REPOSITORY ?? DEFAULT_REPOSITORY;
  let outputPath: string | undefined = process.env.WINGET_DEPTHS_OUTPUT_PATH;
  let historyPath: string | undefined = process.env.WINGET_DEPTHS_HISTORY_PATH;
  let samplesPath: string | undefined = process.env.WINGET_SAMPLES_PATH;
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
    } else if (arg === "--samples-path") {
      samplesPath = readOptionValue(argv, i++, "ファイルパス");
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
    samplesPath,
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

  const healthyBase = buildHealthyBaseQuery(options.repository);
  const mergedCountCache = new Map<string, number>();

  // 1. マージ正常底（健康的大底 TOP 10）＋ 初回提出者の底（TOP 10）を GraphQL で同時取得
  const { healthyBottom, firstTimerBottom, firstTimerBottomTruncated } = await fetchHealthyBottoms(
    client,
    healthyBase,
    BOTTOM_LIST_LIMIT,
    FIRST_TIMER_MAX_NODES,
    mergedCountCache,
  );

  // 2. 真の大底（Absolute Bottom）
  const absoluteBase = buildAbsoluteBaseQuery(options.repository);
  const absoluteItems = await client.searchIssues(absoluteBase, "created", "asc", 3);
  const absoluteBottom = absoluteItems.map(formatDepthsRow);

  // 3. 未レビュー（完全未着手）正常底（全体 ＋ 初回提出者のみ）／介入済み前線（起票日時順）
  const {
    unreviewedBottom,
    firstTimerUnreviewedBottom,
    intervenedBottom,
    unreviewedTruncated,
    firstTimerUnreviewedTruncated,
    intervenedTruncated,
  } = await fetchInterventionFrontiers(
    client,
    healthyBase,
    BOTTOM_LIST_LIMIT,
    FIRST_TIMER_MAX_NODES,
    INTERVENTION_BATCH_SIZE,
    mergedCountCache,
  );

  // 6. 特急レーン（Express Lane）
  let expressBottom: DepthsRow[] = [];
  if (hasTarget && targetCreatedAtIso) {
    const expressQuery = buildExpressQuery(options.repository, targetCreatedAtIso);
    const expressItems = await client.searchIssues(expressQuery, "updated", "desc", 5);
    expressBottom = expressItems.map(formatDepthsRow);
  }

  const now = new Date();
  const defaultDataDir = resolveDefaultDataDir();
  const resolvedSamplesPath = options.samplesPath
    ? resolve(process.cwd(), options.samplesPath)
    : options.outputPath
      ? resolve(dirname(resolve(process.cwd(), options.outputPath)), "merged-samples.jsonl")
      : options.historyPath
        ? resolve(dirname(resolve(process.cwd(), options.historyPath)), "merged-samples.jsonl")
        : resolve(defaultDataDir, "merged-samples.jsonl");

  // 5B. 主戦場ライン（直近 7 日間に初めて人間介入が入ったコホート: 初回提出者限定 ＋ 常連含む全体）
  const { firstReviewFrontier, allAuthorsFirstReviewFrontier } = await fetchFirstReviewFrontiers({
    client,
    repository: options.repository,
    now,
    mergedCountCache,
    samplesPath: resolvedSamplesPath,
  });

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

    log("【3. 初回提出者の底 (First-Timer Bottom)】");
    log(
      "説明: 初回提出者（authorAssociation = NONE・生涯マージ 0 回）の健康なPR全体（手直し込み）の、起票日時(created)が最も古い先頭",
    );
    printRowTable(firstTimerBottom, log, { showCommitCount: true, showThirdPartyAssignees: true });
    log("");

    log("【5A. 未レビュー（完全未着手）前線 (Unreviewed Frontier)】");
    const unreviewedTruncatedNote = unreviewedTruncated ? " [※走査上限到達のため一部未完了]" : "";
    log(
      `説明: 人間レビュー・手動コメント・第三者 Assignees・Collaborator 以上の自動指摘がいずれも無い健康なPR（作成者本人・一般ボット除く）の起票順先頭 (上位 ${unreviewedSummary.count} 件 / 先頭: ${unreviewedSummary.head ? `${unreviewedSummary.head.PR} 起票 ${unreviewedSummary.head.作成日時}・経過 ${unreviewedSummary.headElapsedDays ?? "-"} 日` : unreviewedTruncated ? "走査上限到達・未確定" : "該当なし"})${unreviewedTruncatedNote}`,
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
    log(`【7. 主戦場ライン（直近 ${firstReviewFrontier.WindowDays} 日初回人間介入コホート）】`);
    log(
      `  対象件数: ${firstReviewFrontier.CohortCount} 件 (Open ${firstReviewFrontier.OpenCount} / Merged ${firstReviewFrontier.MergedCount}) | 起票中央値: ${firstReviewFrontier.MedianCreatedAt ?? "データ不足"} (経過 ${firstReviewFrontier.LagDays ?? "-"} 日)`,
    );
    log("");
  }

  const snapshot = createDepthsSnapshot({
    now,
    repository: options.repository,
    targetPr: targetInfo,
    healthyBottom,
    absoluteBottom,
    firstTimerBottom,
    firstTimerBottomTruncated,
    unreviewedBottom,
    firstTimerUnreviewedBottom,
    intervenedBottom,
    unreviewedTruncated,
    firstTimerUnreviewedTruncated,
    intervenedTruncated,
    firstReviewFrontier,
    allAuthorsFirstReviewFrontier,
    expressLane: expressBottom,
  });

  if (options.asJson) {
    log(JSON.stringify(snapshot, null, 2));
  }

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
