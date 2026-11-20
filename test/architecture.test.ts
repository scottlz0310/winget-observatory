import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

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

  test("src/ 配下全体で GitHub REST API エンドポイント（/search/issues, /repos/, /rate_limit）を直接参照しないこと（GraphQL 一本化の強制）", () => {
    function scanDir(dir: string): string[] {
      const results: string[] = [];
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scanDir(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const files = scanDir("src");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = readFileSync(file, "utf-8");
      // REST エンドポイント URL パターンの直接参照を禁止
      expect(code).not.toMatch(/\/search\/issues/);
      expect(code).not.toMatch(/\/repos\//);
      expect(code).not.toMatch(/\/rate_limit/);
    }
  });

  test("src/ 配下のモジュールは scripts/ 配下を逆参照しないこと", () => {
    function scanDir(dir: string): string[] {
      const results: string[] = [];
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scanDir(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const files = scanDir("src");
    for (const file of files) {
      const code = readFileSync(file, "utf-8");
      const matches = code.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g);
      for (const match of matches) {
        const spec = match[1];
        expect(spec).not.toMatch(/(?:^|\/)scripts(?:\/|$)/);
      }
    }
  });

  test("src/ および scripts/ 配下の全 TypeScript モジュール間に循環インポートが存在しないこと", () => {
    const rootDir = resolve(".");

    function collectTsFiles(dir: string): string[] {
      const results: string[] = [];
      if (!existsSync(dir)) return results;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...collectTsFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          results.push(normalize(fullPath));
        }
      }
      return results;
    }

    const allFiles = [...collectTsFiles(resolve("src")), ...collectTsFiles(resolve("scripts"))];
    const fileSet = new Set(allFiles);

    function resolveImportTarget(fromFile: string, specifier: string): string | null {
      let baseTarget: string;
      if (specifier.startsWith(".")) {
        baseTarget = resolve(dirname(fromFile), specifier);
      } else if (specifier.startsWith("@/")) {
        baseTarget = resolve(rootDir, "src", specifier.slice(2));
      } else {
        return null;
      }

      const candidates = [
        normalize(baseTarget),
        normalize(`${baseTarget}.ts`),
        normalize(join(baseTarget, "index.ts")),
      ];
      for (const candidate of candidates) {
        if (fileSet.has(candidate) && statSync(candidate).isFile()) {
          return candidate;
        }
      }
      return null;
    }

    const graph = new Map<string, string[]>();
    for (const file of allFiles) {
      const code = readFileSync(file, "utf-8");
      const deps = new Set<string>();
      const matches = code.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g);
      for (const match of matches) {
        const target = resolveImportTarget(file, match[1]);
        if (target) {
          deps.add(target);
        }
      }
      graph.set(file, [...deps]);
    }

    const state = new Map<string, "visiting" | "visited">();
    const stack: string[] = [];
    const cycles: string[] = [];

    function dfs(node: string): void {
      state.set(node, "visiting");
      stack.push(node);

      for (const next of graph.get(node) ?? []) {
        const nextState = state.get(next);
        if (nextState === "visiting") {
          const cycleStart = stack.indexOf(next);
          const cyclePath = [...stack.slice(cycleStart), next]
            .map((p) => relative(rootDir, p).replaceAll("\\", "/"))
            .join(" -> ");
          cycles.push(cyclePath);
        } else if (!nextState) {
          dfs(next);
        }
      }

      stack.pop();
      state.set(node, "visited");
    }

    for (const file of allFiles) {
      if (!state.has(file)) {
        dfs(file);
      }
    }

    expect(cycles).toEqual([]);
  });
});
