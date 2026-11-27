import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ManifestBundle, ManifestFileKind, ParsedManifestFile } from "./types";

const SCHEMA_COMMENT_PATTERN = /^\s*#\s*yaml-language-server:\s*\$schema=(https?:\/\/\S+)\s*$/im;
const SCHEMA_VERSION_PATTERN = /\.(\d+\.\d+\.\d+)\.json(?:$|[?#])/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyManifestKind(data: Record<string, unknown>): ManifestFileKind {
  const manifestType = typeof data.ManifestType === "string" ? data.ManifestType.trim() : "";
  switch (manifestType) {
    case "version":
    case "installer":
    case "defaultLocale":
    case "locale":
    case "singleton":
      return manifestType;
    default:
      return "unknown";
  }
}

export function extractSchemaInfo(yamlText: string): {
  schemaUrl: string | null;
  schemaVersion: string | null;
} {
  const head = yamlText.split(/\r?\n/, 10).join("\n");
  const match = SCHEMA_COMMENT_PATTERN.exec(head);
  if (!match) {
    return { schemaUrl: null, schemaVersion: null };
  }
  const schemaUrl = match[1].trim();
  const verMatch = SCHEMA_VERSION_PATTERN.exec(schemaUrl);
  return {
    schemaUrl,
    schemaVersion: verMatch ? verMatch[1] : null,
  };
}

export function parseManifestFileContent(
  filePath: string,
  fileName: string,
  yamlText: string,
): ParsedManifestFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`YAML パースに失敗しました (${fileName}): ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`マニフェストのルートは YAML マップである必要があります (${fileName})`);
  }
  const { schemaUrl, schemaVersion } = extractSchemaInfo(yamlText);
  return {
    filePath,
    fileName,
    kind: classifyManifestKind(parsed),
    schemaUrl,
    schemaVersion,
    data: parsed,
  };
}

export function loadManifestBundle(manifestDirInput: string): ManifestBundle {
  const manifestDir = resolve(manifestDirInput);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(manifestDir);
  } catch {
    throw new Error(`マニフェストディレクトリが見つかりません: ${manifestDir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`ディレクトリを指定してください: ${manifestDir}`);
  }

  const yamlNames = readdirSync(manifestDir)
    .filter((name) => {
      const ext = extname(name).toLowerCase();
      return ext === ".yaml" || ext === ".yml";
    })
    .sort((a, b) => a.localeCompare(b));

  if (yamlNames.length === 0) {
    throw new Error(`マニフェスト YAML ファイルが見つかりません: ${manifestDir}`);
  }

  const files = yamlNames.map((fileName) => {
    const filePath = join(manifestDir, fileName);
    const content = readFileSync(filePath, "utf8");
    return parseManifestFileContent(filePath, fileName, content);
  });

  const versionFile = files.find((f) => f.kind === "version") ?? null;
  const installerFile = files.find((f) => f.kind === "installer") ?? null;
  const defaultLocaleFile = files.find((f) => f.kind === "defaultLocale") ?? null;
  const localeFiles = files.filter((f) => f.kind === "locale");
  const singletonFile = files.find((f) => f.kind === "singleton") ?? null;

  return {
    manifestDir,
    files,
    versionFile,
    installerFile,
    defaultLocaleFile,
    localeFiles,
    singletonFile,
  };
}
