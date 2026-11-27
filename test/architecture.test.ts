import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative, resolve } from "node:path";
import { type Expression, parseSync, Visitor } from "oxc-parser";

function extractModuleSpecifiers(code: string, filename = "fixture.ts"): string[] {
  const { program, errors } = parseSync(filename, code, { preserveParens: false });
  if (errors.length > 0) {
    const diagnostics = errors.map((error) => error.codeframe ?? error.message);
    throw new Error(`依存関係を解析できません: ${filename}\n${diagnostics.join("\n")}`);
  }

  const specifiers = new Set<string>();
  function addLiteralSpecifier(source: Expression): void {
    if (source.type === "Literal" && typeof source.value === "string") {
      specifiers.add(source.value);
    } else if (source.type === "TemplateLiteral" && source.expressions.length === 0) {
      const value = source.quasis[0]?.value.cooked;
      if (typeof value === "string") specifiers.add(value);
    }
  }

  new Visitor({
    ImportDeclaration: ({ source }) => {
      specifiers.add(source.value);
    },
    ExportNamedDeclaration: ({ source }) => {
      if (source) specifiers.add(source.value);
    },
    ExportAllDeclaration: ({ source }) => {
      specifiers.add(source.value);
    },
    ImportExpression: ({ source }) => addLiteralSpecifier(source),
    TSExternalModuleReference: ({ expression }) => {
      specifiers.add(expression.value);
    },
    CallExpression: ({ callee, arguments: args }) => {
      const [source] = args;
      if (
        callee.type === "Identifier" &&
        callee.name === "require" &&
        source &&
        source.type !== "SpreadElement"
      ) {
        addLiteralSpecifier(source);
      }
    },
  }).visit(program);

  return [...specifiers];
}

/**
 * 相対パスまたは @/ エイリアスのモジュール指定子を、Bun と同じ解決優先順で対象 .ts ファイル集合へ解決する。
 * - 実在するファイル（例: b.js）が優先解決される場合はそちらを採用し、同居する b/index.ts 等へ誤解決しない。
 * - 明示拡張子 (.js / .ts 等) 付き指定子はファイル候補のみを探索し、ディレクトリ index.ts にはフォールバックしない。
 */
function resolveImportTarget(
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
  rootDir = resolve("."),
  existingFiles: ReadonlySet<string> = fileSet,
): string | null {
  const fromDir = dirname(fromFile);
  let baseTarget: string;
  if (specifier.startsWith(".")) {
    baseTarget = resolve(fromDir, specifier);
  } else if (specifier.startsWith("@/")) {
    baseTarget = resolve(rootDir, "src", specifier.slice(2));
  } else {
    return null;
  }

  // ディスク上に実ファイルが存在する場合は Bun.resolveSync の解決結果を最優先で採用する
  if (existsSync(fromFile)) {
    try {
      const lookupSpec = specifier.startsWith("@/")
        ? resolve(rootDir, "src", specifier.slice(2))
        : specifier;
      const bunResolved = normalize(Bun.resolveSync(lookupSpec, fromDir));
      return fileSet.has(bunResolved) ? bunResolved : null;
    } catch {
      // メモリ上の仮想ファイル集合を検査する場合は下の候補解決へ進む
    }
  }

  const fileExists = (candidate: string): boolean =>
    existingFiles.has(candidate) || existsSync(candidate);

  const ext = extname(baseTarget).toLowerCase();
  let orderedCandidates: string[];
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    const stripped = baseTarget.slice(0, -ext.length);
    const tsExt = ext === ".mjs" ? ".mts" : ext === ".cjs" ? ".cts" : ".ts";
    // 明示 .js 指定は 1) 実在する .js、2) 対応する .ts の順で解決し、ディレクトリ index.ts へは解決しない
    orderedCandidates = [normalize(baseTarget), normalize(`${stripped}${tsExt}`)];
  } else if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
    orderedCandidates = [normalize(baseTarget)];
  } else {
    orderedCandidates = [
      normalize(baseTarget),
      normalize(`${baseTarget}.ts`),
      normalize(`${baseTarget}.js`),
      normalize(join(baseTarget, "index.ts")),
      normalize(join(baseTarget, "index.js")),
    ];
  }

  for (const candidate of orderedCandidates) {
    if (fileExists(candidate)) {
      return fileSet.has(candidate) ? candidate : null;
    }
  }
  return null;
}

/**
 * ファイルパス -> ソースコードのマップから循環インポートのパス一覧を検出する。
 */
function detectImportCycles(
  fileContents: ReadonlyMap<string, string>,
  rootDir = resolve("."),
  existingFiles?: ReadonlySet<string>,
): string[] {
  const allFiles = [...fileContents.keys()].filter((f) => f.endsWith(".ts"));
  const fileSet = new Set(allFiles);
  const allKnownFiles = existingFiles ?? new Set(fileContents.keys());
  const graph = new Map<string, string[]>();

  for (const file of allFiles) {
    const code = fileContents.get(file) ?? "";
    const deps = new Set<string>();
    for (const specifier of extractModuleSpecifiers(code, file)) {
      const target = resolveImportTarget(file, specifier, fileSet, rootDir, allKnownFiles);
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

  return cycles;
}

function findReverseScriptImports(code: string, filename?: string): string[] {
  return extractModuleSpecifiers(code, filename).filter((spec) =>
    /(?:^|\/)scripts(?:\/|$)/.test(spec),
  );
}

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

      for (const importPath of extractModuleSpecifiers(code, file)) {
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
      for (const spec of extractModuleSpecifiers(code, file)) {
        expect(spec).not.toMatch(/(?:^|\/)(domain|api|cli)(?:\/|$)/);
      }
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
      expect(findReverseScriptImports(code, file)).toEqual([]);
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

    const allFiles = [
      ...collectTsFiles(resolve("src")),
      ...collectTsFiles(resolve("scripts")),
      ...collectTsFiles(resolve("packages/verify-gate/src")),
    ];
    const fileContents = new Map<string, string>();
    for (const file of allFiles) {
      fileContents.set(file, readFileSync(file, "utf-8"));
    }

    expect(detectImportCycles(fileContents, rootDir)).toEqual([]);
  });

  test.each([
    'import type { 型 } from /* 型のみ参照 */ "../scripts/b";',
    'export type { 型 } from /* 型のみ参照 */ "../scripts/b";',
    'import { type 型 } from /* 型のみ参照 */ "../scripts/b";',
    'export { type 型 } from /* 型のみ参照 */ "../scripts/b";',
    'export type * from /* 型のみ参照 */ "../scripts/b";',
  ])("型専用の逆参照を検出する: %s", (code) => {
    expect(findReverseScriptImports(code)).toEqual(["../scripts/b"]);
  });

  test("shebang 付きのファイルでも動的 import と require を検出する", () => {
    const code = [
      "#!/usr/bin/env bun",
      "const dynamic = import((`../scripts/dynamic`));",
      'const required = require("../scripts/required");',
      'import legacy = require("../scripts/legacy");',
    ].join("\n");
    expect(findReverseScriptImports(code)).toEqual([
      "../scripts/dynamic",
      "../scripts/required",
      "../scripts/legacy",
    ]);
  });

  test("extractModuleSpecifiers と detectImportCycles はコメント内の記述を無視し、動的 import および .js 拡張子指定の循環参照を検出する", () => {
    const code = [
      '// import "../scripts/commented-out";',
      '/* import("../scripts/in-block-comment"); */',
      'const literal = "import \\"../scripts/in-string\\"";',
      'import { a } from "./a.js";',
      'import type { B } from "./b";',
      'export { c } from "./c.js";',
      'const mod = await import("../scripts/dynamic-target");',
    ].join("\n");

    expect(extractModuleSpecifiers(code)).toEqual([
      "./a.js",
      "./b",
      "./c.js",
      "../scripts/dynamic-target",
    ]);

    // コメント内の逆参照は誤検出せず、文字列リテラルの動的 import("../scripts/b") は逆参照として検出する
    expect(findReverseScriptImports('// import "../scripts/b";\nexport const x = 1;')).toEqual([]);
    expect(findReverseScriptImports('const m = await import("../scripts/b");')).toEqual([
      "../scripts/b",
    ]);
    // テンプレート補間内の文字列に "}" が含まれていても補間が途中終了せず、後続の動的 import を検出できること
    const interpolatedImportCode = [
      "const s = `$",
      '{"}" + (await import("../scripts/b")).b}`;',
    ].join("");
    expect(findReverseScriptImports(interpolatedImportCode)).toEqual(["../scripts/b"]);

    // 制御ブロック直後の正規表現リテラル (/import "..\/scripts\/b"/.exec(code)) を依存として誤検出しないこと
    const regexAfterControlBlockCode = [
      "export function matchImportPattern(code: string, enabled: boolean) {",
      "  if (!enabled) { return null; }",
      '  return /import "..\\/scripts\\/b"/.exec(code);',
      "}",
    ].join("\n");
    expect(findReverseScriptImports(regexAfterControlBlockCode)).toEqual([]);

    const rootDir = resolve(".");
    const fileA = normalize(resolve(rootDir, "src/a.ts"));
    const fileB = normalize(resolve(rootDir, "src/b.ts"));

    // 1. .js 拡張子指定による静的循環参照 (a.ts -> ./b.js, b.ts -> ./a.js) を検出できること
    const jsCycleMap = new Map<string, string>([
      [fileA, 'import { b } from "./b.js";\nexport const a = b;'],
      [fileB, 'import { a } from "./a.js";\nexport const b = a;'],
    ]);
    expect(detectImportCycles(jsCycleMap, rootDir)).toEqual(["src/a.ts -> src/b.ts -> src/a.ts"]);

    // 2. 文字列リテラルの動的 import による循環参照を検出できること
    const dynamicCycleMap = new Map<string, string>([
      [fileA, 'export const loadB = () => import("./b.js");'],
      [fileB, 'export const loadA = () => import("./a");'],
    ]);
    expect(detectImportCycles(dynamicCycleMap, rootDir)).toEqual([
      "src/a.ts -> src/b.ts -> src/a.ts",
    ]);

    // 3. コメント内の import 記述だけでは循環として誤検出しないこと
    const commentedMap = new Map<string, string>([
      [fileA, '// import { b } from "./b.js";\nexport const a = 1;'],
      [fileB, '/* import("./a.js") */\nexport const b = 2;'],
    ]);
    expect(detectImportCycles(commentedMap, rootDir)).toEqual([]);

    // 4. a.ts が実在する ./b.js を import し、同居する b/index.ts が ../a.js を import する構成では循環を誤検出しないこと（実ファイル + メモリ双方）
    const tmpDir = mkdtempSync(join(tmpdir(), "winget-arch-test-"));
    try {
      const diskSrc = join(tmpDir, "src");
      const diskBDir = join(diskSrc, "b");
      mkdirSync(diskBDir, { recursive: true });
      const diskA = normalize(join(diskSrc, "a.ts"));
      const diskBJs = normalize(join(diskSrc, "b.js"));
      const diskBIndex = normalize(join(diskBDir, "index.ts"));

      writeFileSync(diskA, 'import { b } from "./b.js";\nexport const a = b;\n', "utf-8");
      writeFileSync(diskBJs, "export const b = 2;\n", "utf-8");
      writeFileSync(diskBIndex, 'import { a } from "../a.js";\nexport const idx = a;\n', "utf-8");

      const diskMap = new Map<string, string>([
        [diskA, readFileSync(diskA, "utf-8")],
        [diskBIndex, readFileSync(diskBIndex, "utf-8")],
      ]);
      expect(detectImportCycles(diskMap, tmpDir, new Set([diskA, diskBJs, diskBIndex]))).toEqual(
        [],
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
