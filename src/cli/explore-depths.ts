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
import type {
  DepthsRow,
  DepthsSnapshot,
  ExploreDepthsOptions,
  TargetPrInfo,
} from "../models/depths";

/** 遭難の底（更新が最も古い健康な PR）として取得・表示する件数 */
const STALE_BOTTOM_LIMIT = 10;

export function parseArgs(argv: string[]): ExploreDepthsOptions {
  let targetPr = 464302;
  if (process.env.WINGET_TARGET_PR) {
    const envVal = process.env.WINGET_TARGET_PR;
    const parsed = Number.parseInt(envVal, 10);
    if (Number.isNaN(parsed) || parsed <= 0 || !/^\d+$/.test(envVal)) {
      throw new Error(
        `無効な環境変数 WINGET_TARGET_PR です: ${envVal}（正の整数を指定してください）`,
      );
    }
    targetPr = parsed;
  }

  let repository = process.env.WINGET_REPOSITORY ?? "microsoft/winget-pkgs";
  let outputPath: string | undefined = process.env.WINGET_DEPTHS_OUTPUT_PATH;
  let historyPath: string | undefined = process.env.WINGET_DEPTHS_HISTORY_PATH;
  let noTargetPr = false;
  let noHistory = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--target-pr") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--target-pr オプションには正の整数の値が必要です");
      }
      const val = argv[++i];
      const parsed = Number.parseInt(val, 10);
      if (Number.isNaN(parsed) || parsed <= 0 || !/^\d+$/.test(val)) {
        throw new Error(
          `--target-pr に無効な値が指定されました: ${val}（正の整数を指定してください）`,
        );
      }
      targetPr = parsed;
    } else if (arg === "--repository") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--repository オプションにはリポジトリ名 (owner/repo) の値が必要です");
      }
      repository = argv[++i];
    } else if (arg === "--output-path") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--output-path オプションにはファイルパスが必要です");
      }
      outputPath = argv[++i];
    } else if (arg === "--history-path") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("--history-path オプションにはファイルパスが必要です");
      }
      historyPath = argv[++i];
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

function printRowTable(rows: DepthsRow[]): void {
  if (rows.length === 0) {
    console.log("  （該当なし）");
    return;
  }
  for (const row of rows) {
    console.log(`  ${row.PR.padEnd(8)} | ${row.作成日時} | ${row.更新日時} | ${row.タイトル}`);
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

  // 3. 遭難の底（Stale Bottom）: 指摘なく健康になり、そのまま順番を待っている PR の先頭
  const staleItems = await client.searchIssues(healthyBase, "updated", "asc", STALE_BOTTOM_LIMIT);
  const staleBottom = staleItems.map(formatDepthsRow);

  // 4. 特急レーン（Express Lane）
  let expressBottom: DepthsRow[] = [];
  if (hasTarget && targetCreatedAtIso) {
    const expressQuery = buildExpressQuery(options.repository, targetCreatedAtIso);
    const expressItems = await client.searchIssues(expressQuery, "updated", "desc", 5);
    expressBottom = expressItems.map(formatDepthsRow);
  }

  if (!options.asJson) {
    log("【1. 健康的な大底 (Healthy Bottom)】");
    log("説明: CI通過・エラーなしの健康体で、現在最も古いオープンPR (FIFOの正当な先頭)");
    printRowTable(healthyBottom);
    log("");

    log("【2. 真の大底 (Absolute Bottom)】");
    log("説明: 状態やエラーを問わず、未クローズの New-Package で最も古いPR");
    printRowTable(absoluteBottom);
    log("");

    log("【3. 遭難の底 (Stale Bottom)】");
    log("説明: 健康体の中で更新日時(updated)が最も古い、指摘なく順番待ちを続けているPR");
    printRowTable(staleBottom);
    log("");

    if (hasTarget && targetInfo) {
      log("【4. 特急レーン・追い越し (Express Lane)】");
      log(`説明: あなたのPR作成日(${targetInfo.CreatedAtJst})以降に作成され、すでにマージされたPR`);
      if (expressBottom.length > 0) {
        printRowTable(expressBottom);
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
