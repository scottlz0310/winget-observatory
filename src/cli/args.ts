/**
 * CLI 共通の引数解釈ヘルパーと既定値。
 * 各 CLI の parseArgs で同型の検証コードが複製されないよう、ここに集約する。
 */

import { resolve } from "node:path";

/** 観測対象の既定の基準 PR 番号 */
export const DEFAULT_TARGET_PR = 464302;

/** 観測対象の既定のリポジトリ */
export const DEFAULT_REPOSITORY = "microsoft/winget-pkgs";

/**
 * 既定の data/ ディレクトリをエントリポイント位置からリポジトリルートを起点に解決する。
 */
export function resolveDefaultDataDir(baseDir: string = import.meta.dirname): string {
  return resolve(baseDir, "../../data");
}

/**
 * argv[flagIndex] のフラグに続く値を返す。値が無い、または次のフラグが続く場合は拒否する。
 * @param hint 値の説明（エラーメッセージ用。例: "ファイルパス"）
 */
export function readOptionValue(argv: readonly string[], flagIndex: number, hint = "値"): string {
  const value = argv[flagIndex + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${argv[flagIndex]} オプションには${hint}が必要です`);
  }
  return value;
}

/** min 以上 max 以下の整数だけを受理する（符号や小数点を含む文字列は拒否）。 */
export function parseBoundedInt(val: string, name: string, min: number, max: number): number {
  const parsed = Number.parseInt(val, 10);
  if (Number.isNaN(parsed) || !/^\d+$/.test(val) || parsed < min || parsed > max) {
    throw new Error(
      `--${name} に無効な値が指定されました: ${val}（${min} 以上 ${max} 以下の整数を指定してください）`,
    );
  }
  return parsed;
}

function parsePositiveInt(val: string): number | null {
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) || parsed <= 0 || !/^\d+$/.test(val) ? null : parsed;
}

/** `--target-pr` の値を解釈する。 */
export function parseTargetPrArg(val: string): number {
  const parsed = parsePositiveInt(val);
  if (parsed === null) {
    throw new Error(`--target-pr に無効な値が指定されました: ${val}（正の整数を指定してください）`);
  }
  return parsed;
}

/** 環境変数 WINGET_TARGET_PR（未設定なら既定値）から基準 PR 番号を解決する。 */
export function resolveDefaultTargetPr(env: NodeJS.ProcessEnv = process.env): number {
  const envVal = env.WINGET_TARGET_PR;
  if (!envVal) {
    return DEFAULT_TARGET_PR;
  }
  const parsed = parsePositiveInt(envVal);
  if (parsed === null) {
    throw new Error(
      `無効な環境変数 WINGET_TARGET_PR です: ${envVal}（正の整数を指定してください）`,
    );
  }
  return parsed;
}
