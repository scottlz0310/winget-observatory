import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("Architecture Boundary Rules", () => {
  test("src/domain は src/models の型定義および同一ドメイン内モジュールのみ import を許可する", () => {
    const domainDir = "src/domain";
    if (!existsSync(domainDir)) {
      return;
    }
    const files = readdirSync(domainDir);

    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const code = readFileSync(join(domainDir, file), "utf-8");

      // すべての import 文を抽出
      const importMatches = code.matchAll(/from\s+["']([^"']+)["']/g);
      for (const match of importMatches) {
        const importPath = match[1];

        // ホワイトリスト: models への相対パス or 同一ドメイン内モジュールのみ許可
        const isAllowed =
          importPath.startsWith("../models") ||
          importPath.startsWith("@/models") ||
          importPath === "../models" ||
          importPath.startsWith("./");

        expect(isAllowed).toBeTrue();
      }

      // I/O や副作用を誘発するグローバル API / 環境変数の直接呼び出しを禁止
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/\bprocess\.env\b/);
    }
  });

  test("src/models は他レイヤー（domain / api / cli）を逆参照しないこと", () => {
    const modelsDir = "src/models";
    if (!existsSync(modelsDir)) {
      return;
    }
    const files = readdirSync(modelsDir);

    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const code = readFileSync(join(modelsDir, file), "utf-8");

      // domain, api, cli への参照を一切禁止
      expect(code).not.toMatch(/from\s+["'].*\/(domain|api|cli)(\/|["'])/);
    }
  });
});
