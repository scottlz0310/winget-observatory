import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EmbeddedSkillAssets {
  version: string;
  skillMd: string;
  submissionGuide: string;
  prTemplate: string;
}

/**
 * ソース直接実行（開発・テスト）時は null。
 * npm 配布用バンドル（dist/cli.mjs）および単体バイナリ（bun build --compile）のビルド時に、
 * packages/verify-gate/scripts/build.ts の Bun.build プラグインがこのモジュールを差し替えて
 * 実ファイル（SKILL.md / docs/* / package.json version）を埋め込む。
 */
export const EMBEDDED_SKILL_ASSETS: EmbeddedSkillAssets | null = null;

function readVersionFromPackageJson(pkgPath: string): string | null {
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * verify-gate のバージョンを単一情報源（ビルド埋め込み版 → ルート package.json → パッケージ package.json）から解決する。
 */
export function resolveVerifyGateVersion(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
  embedded: EmbeddedSkillAssets | null = EMBEDDED_SKILL_ASSETS,
): string {
  if (embedded?.version) {
    return embedded.version;
  }
  const packageRoot = resolve(moduleDir, "..");
  const repoRoot = resolve(packageRoot, "..", "..");
  return (
    readVersionFromPackageJson(resolve(repoRoot, "package.json")) ??
    readVersionFromPackageJson(resolve(packageRoot, "package.json")) ??
    "0.0.0-dev"
  );
}
