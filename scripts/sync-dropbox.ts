#!/usr/bin/env bun
// data/ 配下のメトリクスファイルを Dropbox App folder と同期するスクリプト

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DROPBOX_ROOT, DropboxClient } from "./lib/dropbox";

export interface SyncOptions {
  direction: "upload" | "download";
  dataDir: string;
  dryRun: boolean;
  allowSkip: boolean;
}

const TARGET_FILES = [
  "progress-history.csv",
  "latest-progress.json",
  "depths-history.jsonl",
  "latest-depths.json",
];

export function parseArgs(args: string[], cwd: string = process.cwd()): SyncOptions {
  let direction: "upload" | "download" | undefined;
  let dataDir = resolve(cwd, "data");
  let dryRun = false;
  let allowSkip = false;

  const requireValue = (i: number, name: string): string => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      throw new Error(`${name} オプションには値が必要です`);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--direction") {
      const val = requireValue(i++, arg);
      if (val !== "upload" && val !== "download") {
        throw new Error(`無効な direction: ${val}（upload または download を指定）`);
      }
      direction = val;
    } else if (arg === "--data-dir") {
      dataDir = resolve(cwd, requireValue(i++, arg));
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--allow-skip") {
      allowSkip = true;
    } else {
      throw new Error(`未知のオプションです: ${arg}`);
    }
  }

  // リモートを上書きし得る upload を暗黙の既定にしない
  if (direction === undefined) {
    throw new Error("--direction オプション（upload または download）が必要です");
  }

  return { direction, dataDir, dryRun, allowSkip };
}

export interface DownloadSummary {
  downloaded: string[];
  skipped: string[];
}

/**
 * Dropbox からメトリクスファイルをダウンロードする。リモートに存在しないファイルはスキップする。
 */
export async function downloadMetricsFiles(
  client: Pick<DropboxClient, "download">,
  dataDir: string,
  targetFiles: string[] = TARGET_FILES,
  log: (msg: string) => void = console.log,
): Promise<DownloadSummary> {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const summary: DownloadSummary = {
    downloaded: [],
    skipped: [],
  };

  for (const filename of targetFiles) {
    const remotePath = `${DROPBOX_ROOT}${filename}`;
    const localPath = join(dataDir, filename);

    log(`[Dropbox Sync] ダウンロード確認中: ${remotePath}...`);
    const content = await client.download(remotePath);

    if (content !== undefined) {
      writeFileSync(localPath, content, "utf-8");
      log(`[Dropbox Sync] 保存完了: ${localPath} (${content.length} bytes)`);
      summary.downloaded.push(filename);
    } else {
      log(`[Dropbox Sync] リモートにファイルが存在しません（スキップ）: ${remotePath}`);
      summary.skipped.push(filename);
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log(`[Dropbox Sync] モード: ${options.direction}, 対象ディレクトリ: ${options.dataDir}`);

  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;

  if (!appKey || !appSecret || !refreshToken) {
    if (options.allowSkip) {
      console.log(
        "[Dropbox Sync] DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN が未設定のため同期をスキップします。",
      );
      process.exit(0);
    } else {
      console.error(
        "[Dropbox Sync] エラー: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN の環境変数を設定してください。",
      );
      process.exit(1);
    }
  }

  const client = new DropboxClient({
    appKey,
    appSecret,
    refreshToken,
    trace: (line) => console.log(`[Trace] ${line}`),
  });

  if (options.direction === "upload") {
    if (!existsSync(options.dataDir)) {
      console.warn(`[Dropbox Sync] 対象ディレクトリが存在しません: ${options.dataDir}`);
      return;
    }

    const availableFiles = readdirSync(options.dataDir);
    const filesToUpload = TARGET_FILES.filter((f) => availableFiles.includes(f));

    if (filesToUpload.length === 0) {
      console.log("[Dropbox Sync] アップロード対象ファイルがありません。");
      return;
    }

    for (const filename of filesToUpload) {
      const localPath = join(options.dataDir, filename);
      const remotePath = `${DROPBOX_ROOT}${filename}`;
      const content = readFileSync(localPath, "utf-8");

      if (options.dryRun) {
        console.log(
          `[DryRun] アップロード予定: ${localPath} -> ${remotePath} (${content.length} bytes)`,
        );
      } else {
        console.log(`[Dropbox Sync] アップロード中: ${filename} -> ${remotePath}...`);
        const result = await client.upload(remotePath, content);
        console.log(`[Dropbox Sync] 完了: ${result.path} (${result.size} bytes)`);
      }
    }
  } else {
    // download
    if (options.dryRun) {
      for (const filename of TARGET_FILES) {
        console.log(
          `[DryRun] ダウンロード予定: ${DROPBOX_ROOT}${filename} -> ${join(options.dataDir, filename)}`,
        );
      }
    } else {
      await downloadMetricsFiles(client, options.dataDir, TARGET_FILES, console.log);
    }
  }

  console.log("[Dropbox Sync] すべての処理が完了しました。");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      `[Dropbox Sync 致命的エラー]: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
