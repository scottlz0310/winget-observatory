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

type Token =
  | { type: "ident"; value: string }
  | { type: "string"; value: string }
  | { type: "punct"; value: string };

const bunTranspiler = new Bun.Transpiler({ loader: "ts" });

/**
 * TypeScript / JavaScript ソースを字句解析し、行コメント・ブロックコメント・正規表現リテラルを除外したトークン列を返す。
 * テンプレートリテラル補間 `${ ... }` はブレース深さスタック（templateDepthStack）によってメインループ内で再帰的にトークン化するため、
 * 補間内の文字列リテラル `"}"` やコメント内の `}` で補間が途中終了しない。
 */
function tokenizeTypeScript(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = code.length;
  let braceDepth = 0;
  const templateDepthStack: number[] = [];

  const canStartRegex = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === "ident") {
      return ["return", "throw", "case", "typeof", "void", "delete", "await", "yield"].includes(
        prev.value,
      );
    }
    if (prev.type === "punct") {
      return ["(", "{", "[", "=", ":", ",", ";", "!", "&", "|", "?", "+", "-", "~", "^"].includes(
        prev.value,
      );
    }
    return false;
  };

  const scanTemplateChunk = (isStartOfTemplate: boolean): void => {
    let value = "";
    while (i < len) {
      if (code[i] === "\\") {
        value += code[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (code[i] === "`") {
        i++;
        if (isStartOfTemplate) {
          tokens.push({ type: "string", value });
        }
        return;
      }
      if (code[i] === "$" && code[i + 1] === "{") {
        i += 2;
        templateDepthStack.push(braceDepth);
        tokens.push({ type: "punct", value: "${" });
        return;
      }
      value += code[i];
      i++;
    }
  };

  while (i < len) {
    const ch = code[i];

    // 空白
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }

    // 行コメント
    if (ch === "/" && code[i + 1] === "/") {
      i += 2;
      while (i < len && code[i] !== "\n") i++;
      continue;
    }

    // ブロックコメント
    if (ch === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < len && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    // 正規表現リテラル
    if (ch === "/" && canStartRegex()) {
      i++;
      let inCharClass = false;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "[") inCharClass = true;
        else if (code[i] === "]") inCharClass = false;
        else if (code[i] === "/" && !inCharClass) {
          i++;
          while (i < len && /[a-z]/i.test(code[i])) i++;
          break;
        } else if (code[i] === "\n") {
          break;
        }
        i++;
      }
      tokens.push({ type: "punct", value: "/regex/" });
      continue;
    }

    // シングルクォート / ダブルクォート文字列リテラル
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = "";
      while (i < len && code[i] !== quote) {
        if (code[i] === "\\") {
          value += code[i + 1] ?? "";
          i += 2;
        } else {
          value += code[i];
          i++;
        }
      }
      i++; // closing quote
      tokens.push({ type: "string", value });
      continue;
    }

    // テンプレートリテラル開始
    if (ch === "`") {
      i++;
      scanTemplateChunk(true);
      continue;
    }

    // ブレース深さ管理とテンプレート補間 `${ ... }` の終端復帰
    if (ch === "{") {
      braceDepth++;
      tokens.push({ type: "punct", value: "{" });
      i++;
      continue;
    }

    if (ch === "}") {
      if (
        templateDepthStack.length > 0 &&
        braceDepth === templateDepthStack[templateDepthStack.length - 1]
      ) {
        templateDepthStack.pop();
        tokens.push({ type: "punct", value: "}" });
        i++;
        scanTemplateChunk(false);
        continue;
      }
      if (braceDepth > 0) braceDepth--;
      tokens.push({ type: "punct", value: "}" });
      i++;
      continue;
    }

    // 識別子 / キーワード
    if (/[A-Za-z_$]/.test(ch)) {
      let value = "";
      while (i < len && /[A-Za-z0-9_$]/.test(code[i])) {
        value += code[i];
        i++;
      }
      tokens.push({ type: "ident", value });
      continue;
    }

    // 記号・演算子
    tokens.push({ type: "punct", value: ch });
    i++;
  }

  return tokens;
}

/**
 * Bun.Transpiler.scanImports による AST スキャンと字句解析トークン列（import type / export type 含む）を併用し、
 * コメントや通常文字列リテラルを除外して静的 import / import type / export ... from / 動的 import("...") の指定子を抽出する。
 */
function extractModuleSpecifiers(code: string): string[] {
  const tokens = tokenizeTypeScript(code);
  const specifiers: string[] = [];
  const seen = new Set<string>();
  const addSpecifier = (s: string): void => {
    if (!seen.has(s)) {
      seen.add(s);
      specifiers.push(s);
    }
  };
  const n = tokens.length;

  const skipBraceBlock = (startIdx: number): number => {
    if (tokens[startIdx]?.type !== "punct" || tokens[startIdx]?.value !== "{") {
      return startIdx;
    }
    let depth = 1;
    let idx = startIdx + 1;
    while (idx < n && depth > 0) {
      const t = tokens[idx];
      if (t.type === "punct" && t.value === "{") depth++;
      else if (t.type === "punct" && t.value === "}") depth--;
      idx++;
    }
    return idx;
  };

  for (let i = 0; i < n; i++) {
    const tok = tokens[i];
    const prev = tokens[i - 1];
    if (tok.type !== "ident") continue;
    if (prev?.type === "punct" && prev.value === ".") continue;

    if (tok.value === "import") {
      const next = tokens[i + 1];
      if (!next) continue;

      // 1. 動的 import("specifier")
      if (next.type === "punct" && next.value === "(") {
        const arg = tokens[i + 2];
        if (arg?.type === "string") {
          addSpecifier(arg.value);
        }
        continue;
      }

      // 2. 副作用 import "specifier"
      if (next.type === "string") {
        addSpecifier(next.value);
        continue;
      }

      // 3. 静的 import [type] <Clause> from "specifier"
      let cursor = i + 1;
      if (
        tokens[cursor]?.type === "ident" &&
        tokens[cursor]?.value === "type" &&
        !(tokens[cursor + 1]?.type === "ident" && tokens[cursor + 1]?.value === "from") &&
        !(tokens[cursor + 1]?.type === "punct" && tokens[cursor + 1]?.value === ",")
      ) {
        cursor++;
      }

      while (cursor < n) {
        const c = tokens[cursor];
        if (c.type === "punct" && c.value === "{") {
          cursor = skipBraceBlock(cursor);
          continue;
        }
        if (c.type === "ident" && c.value === "from" && tokens[cursor + 1]?.type === "string") {
          addSpecifier((tokens[cursor + 1] as { type: "string"; value: string }).value);
          break;
        }
        if (c.type === "punct" && (c.value === ";" || c.value === "=")) {
          break;
        }
        cursor++;
      }
      continue;
    }

    if (tok.value === "export") {
      let cursor = i + 1;
      if (tokens[cursor]?.type === "ident" && tokens[cursor]?.value === "type") {
        cursor++;
      }

      const clauseStart = tokens[cursor];
      if (clauseStart?.type !== "punct") continue;

      if (clauseStart.value === "{") {
        cursor = skipBraceBlock(cursor);
      } else if (clauseStart.value === "*") {
        cursor++;
        if (tokens[cursor]?.type === "ident" && tokens[cursor]?.value === "as") {
          cursor += 2;
        }
      } else {
        continue;
      }

      if (
        tokens[cursor]?.type === "ident" &&
        tokens[cursor]?.value === "from" &&
        tokens[cursor + 1]?.type === "string"
      ) {
        addSpecifier((tokens[cursor + 1] as { type: "string"; value: string }).value);
      }
    }
  }

  try {
    for (const imp of bunTranspiler.scanImports(code)) {
      addSpecifier(imp.path);
    }
  } catch {
    // 構文断片等で scanImports が失敗した場合はトークナイザ抽出結果を使用する
  }

  return specifiers;
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
    for (const specifier of extractModuleSpecifiers(code)) {
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

function findReverseScriptImports(code: string): string[] {
  return extractModuleSpecifiers(code).filter((spec) => /(?:^|\/)scripts(?:\/|$)/.test(spec));
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

      for (const importPath of extractModuleSpecifiers(code)) {
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
      for (const spec of extractModuleSpecifiers(code)) {
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
      expect(findReverseScriptImports(code)).toEqual([]);
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
    const fileContents = new Map<string, string>();
    for (const file of allFiles) {
      fileContents.set(file, readFileSync(file, "utf-8"));
    }

    expect(detectImportCycles(fileContents, rootDir)).toEqual([]);
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
    expect(
      findReverseScriptImports('const s = `${"}" + (await import("../scripts/b")).b}`;'),
    ).toEqual(["../scripts/b"]);

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
