import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

type Token =
  | { type: "ident"; value: string }
  | { type: "string"; value: string }
  | { type: "punct"; value: string };

/**
 * TypeScript / JavaScript ソースを字句解析し、行コメント・ブロックコメント・正規表現リテラルを除外したトークン列を返す。
 * 通常の文字列リテラル内容は "string" トークンとして分離されるため、文字列中の "import ..." 等は識別子として解釈されない。
 */
function tokenizeTypeScript(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = code.length;

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

    // テンプレートリテラル（補間なしは string トークン、補間ありは非文字列としてスキップ）
    if (ch === "`") {
      i++;
      let value = "";
      let hasInterpolation = false;
      while (i < len && code[i] !== "`") {
        if (code[i] === "\\") {
          value += code[i + 1] ?? "";
          i += 2;
        } else if (code[i] === "$" && code[i + 1] === "{") {
          hasInterpolation = true;
          i += 2;
          let depth = 1;
          let inner = "";
          while (i < len && depth > 0) {
            if (code[i] === "\\") {
              inner += code.slice(i, i + 2);
              i += 2;
              continue;
            }
            if (code[i] === "{") depth++;
            else if (code[i] === "}") {
              depth--;
              if (depth === 0) {
                i++;
                break;
              }
            }
            inner += code[i];
            i++;
          }
          tokens.push(...tokenizeTypeScript(inner));
        } else {
          value += code[i];
          i++;
        }
      }
      i++; // closing backtick
      if (!hasInterpolation) {
        tokens.push({ type: "string", value });
      }
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
 * 字句解析トークン列から、コメントや通常文字列リテラルを除外し、
 * 静的 import / import type / export ... from / 文字列リテラルの動的 import("...") のモジュール指定子を抽出する。
 */
function extractModuleSpecifiers(code: string): string[] {
  const tokens = tokenizeTypeScript(code);
  const specifiers: string[] = [];
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
          specifiers.push(arg.value);
        }
        continue;
      }

      // 2. 副作用 import "specifier"
      if (next.type === "string") {
        specifiers.push(next.value);
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
          specifiers.push((tokens[cursor + 1] as { type: "string"; value: string }).value);
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
        specifiers.push((tokens[cursor + 1] as { type: "string"; value: string }).value);
      }
    }
  }

  return specifiers;
}

/**
 * 相対パスまたは @/ エイリアスのモジュール指定子を、対象ファイル集合内の .ts ファイルへ解決する。
 * Bun / TypeScript (moduleResolution: bundler / node16) と同様に .js -> .ts 解決にも対応する。
 */
function resolveImportTarget(
  fromFile: string,
  specifier: string,
  fileSet: ReadonlySet<string>,
  rootDir = resolve("."),
): string | null {
  let baseTarget: string;
  if (specifier.startsWith(".")) {
    baseTarget = resolve(dirname(fromFile), specifier);
  } else if (specifier.startsWith("@/")) {
    baseTarget = resolve(rootDir, "src", specifier.slice(2));
  } else {
    return null;
  }

  const strippedJs = baseTarget.replace(/\.(?:js|mjs|cjs)$/i, "");
  const candidates = [
    normalize(baseTarget),
    normalize(`${baseTarget}.ts`),
    normalize(join(baseTarget, "index.ts")),
    normalize(`${strippedJs}.ts`),
    normalize(join(strippedJs, "index.ts")),
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) {
      return candidate;
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
): string[] {
  const allFiles = [...fileContents.keys()];
  const fileSet = new Set(allFiles);
  const graph = new Map<string, string[]>();

  for (const [file, code] of fileContents.entries()) {
    const deps = new Set<string>();
    for (const specifier of extractModuleSpecifiers(code)) {
      const target = resolveImportTarget(file, specifier, fileSet, rootDir);
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
  });
});
