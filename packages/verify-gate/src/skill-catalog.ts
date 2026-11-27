import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface SkillResourceManifestEntry {
  uri: string;
  digest: string;
  size: number;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  metadata?: Record<string, unknown>;
}

export interface SkillEntry {
  uri: string;
  frontmatter: SkillFrontmatter;
  resources: SkillResourceManifestEntry[];
}

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  size?: number;
}

export interface McpResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export interface SkillExportResult {
  skillName: string;
  outputDir: string;
  files: Array<{ relativePath: string; path: string; size: number; digest: string }>;
}

export interface SkillCatalogPaths {
  skillMdPath: string;
  submissionGuidePath: string;
  prTemplatePath: string;
}

interface InternalResource {
  uri: string;
  relativePath: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
  size: number;
  digest: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_SCHEME_PREFIX = "skill://winget-verify-gate/";

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function parseSkillFrontmatter(markdown: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (!match) {
    throw new Error("SKILL.md に YAML frontmatter が見つかりません");
  }
  const parsed = Bun.YAML.parse(match[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("SKILL.md の frontmatter は YAML オブジェクトである必要があります");
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.name !== "string" || !rec.name.trim()) {
    throw new Error("SKILL.md の frontmatter に必須フィールド name がありません");
  }
  if (typeof rec.description !== "string" || !rec.description.trim()) {
    throw new Error("SKILL.md の frontmatter に必須フィールド description がありません");
  }

  const frontmatter: SkillFrontmatter = {
    name: rec.name.trim(),
    description: rec.description.trim(),
  };
  if (typeof rec.license === "string" && rec.license.trim()) {
    frontmatter.license = rec.license.trim();
  }
  if (typeof rec.metadata === "object" && rec.metadata !== null && !Array.isArray(rec.metadata)) {
    frontmatter.metadata = rec.metadata as Record<string, unknown>;
  }
  return frontmatter;
}

export function resolveDefaultSkillCatalogPaths(
  moduleDir: string = import.meta.dir,
): SkillCatalogPaths {
  const packageRoot = resolve(moduleDir, "..");
  const repoRoot = resolve(packageRoot, "..", "..");
  return {
    skillMdPath: join(packageRoot, "skills", "winget-verify-gate", "SKILL.md"),
    submissionGuidePath: join(repoRoot, "docs", "winget-pkgs-submission-guide.md"),
    prTemplatePath: join(repoRoot, "docs", "templates", "winget-pkgs-pr-template.md"),
  };
}

function loadTextResource(
  filePath: string,
  relativePath: string,
  name: string,
  description: string,
  mimeType = "text/markdown",
): InternalResource {
  if (!existsSync(filePath)) {
    throw new Error(`スキルリソースが見つかりません: ${filePath}`);
  }
  const raw = readFileSync(filePath);
  const text = raw.toString("utf8");
  return {
    uri: `${SKILL_SCHEME_PREFIX}${relativePath}`,
    relativePath,
    name,
    description,
    mimeType,
    text,
    size: raw.byteLength,
    digest: sha256Digest(raw),
  };
}

export class SkillCatalog {
  private readonly skillEntry: SkillEntry;
  private readonly resourcesByUri: Map<string, InternalResource>;
  private readonly allResources: InternalResource[];

  constructor(paths: SkillCatalogPaths = resolveDefaultSkillCatalogPaths()) {
    const skillMd = loadTextResource(
      paths.skillMdPath,
      "SKILL.md",
      "SKILL.md",
      "WinGet pre-submission verification gate workflow instructions",
    );
    const frontmatter = parseSkillFrontmatter(skillMd.text);
    const guide = loadTextResource(
      paths.submissionGuidePath,
      "references/submission-guide.md",
      "submission-guide.md",
      "Distribution x app-type checklist and real PR evidence guide",
    );
    const template = loadTextResource(
      paths.prTemplatePath,
      "templates/pr-template.md",
      "pr-template.md",
      "Proactive PR body template for microsoft/winget-pkgs",
    );

    this.allResources = [skillMd, guide, template];
    this.resourcesByUri = new Map(this.allResources.map((r) => [r.uri, r]));
    this.skillEntry = {
      uri: skillMd.uri,
      frontmatter,
      resources: this.allResources.map((r) => ({
        uri: r.uri,
        digest: r.digest,
        size: r.size,
      })),
    };
  }

  listSkills(): { skills: SkillEntry[] } {
    return { skills: [this.skillEntry] };
  }

  getSkill(uri: string): SkillEntry | null {
    if (uri === this.skillEntry.uri) {
      return this.skillEntry;
    }
    return null;
  }

  listResources(): { resources: McpResourceDescriptor[] } {
    return {
      resources: this.allResources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
        size: r.size,
      })),
    };
  }

  readResource(uri: string): { contents: McpResourceContent[] } | null {
    const resource = this.resourcesByUri.get(uri);
    if (!resource) return null;
    return {
      contents: [
        {
          uri: resource.uri,
          mimeType: resource.mimeType,
          text: resource.text,
        },
      ],
    };
  }

  readDirectory(uri: string): { resources: McpResourceDescriptor[] } | null {
    // 既存ファイル URI へのディレクトリ読込は拒否する（SEP-2640: 非ディレクトリは -32602）
    if (this.resourcesByUri.has(uri)) {
      return null;
    }
    const stripped = uri.endsWith("/") ? uri.slice(0, -1) : uri;
    const rootNoSlash = SKILL_SCHEME_PREFIX.slice(0, -1);
    if (stripped !== rootNoSlash && !stripped.startsWith(SKILL_SCHEME_PREFIX)) {
      return null;
    }
    const prefixRel =
      stripped === rootNoSlash ? "" : `${stripped.slice(SKILL_SCHEME_PREFIX.length)}/`;
    const children = new Map<string, McpResourceDescriptor>();

    for (const res of this.allResources) {
      if (!res.relativePath.startsWith(prefixRel)) continue;
      const remainder = res.relativePath.slice(prefixRel.length);
      if (!remainder) continue;
      const slashIdx = remainder.indexOf("/");
      if (slashIdx === -1) {
        children.set(res.uri, {
          uri: res.uri,
          name: remainder,
          description: res.description,
          mimeType: res.mimeType,
          size: res.size,
        });
      } else {
        const dirName = remainder.slice(0, slashIdx);
        // SEP-2640: ディレクトリ URI は末尾スラッシュなし、mimeType は "inode/directory"
        const dirUri = `${stripped}/${dirName}`;
        if (!children.has(dirUri)) {
          children.set(dirUri, {
            uri: dirUri,
            name: dirName,
            mimeType: "inode/directory",
          });
        }
      }
    }

    if (children.size === 0) {
      return null;
    }
    return {
      resources: [...children.values()].sort((a, b) => a.uri.localeCompare(b.uri)),
    };
  }

  exportSkill(outDirInput: string): SkillExportResult {
    const skillName = this.skillEntry.frontmatter.name;
    const targetRoot = resolve(outDirInput, skillName);
    const written: SkillExportResult["files"] = [];
    for (const res of this.allResources) {
      const destPath = join(targetRoot, ...res.relativePath.split("/"));
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, res.text, "utf8");
      written.push({
        relativePath: res.relativePath,
        path: destPath,
        size: res.size,
        digest: res.digest,
      });
    }
    return {
      skillName,
      outputDir: targetRoot,
      files: written,
    };
  }
}
