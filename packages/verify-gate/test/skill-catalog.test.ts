import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillFrontmatter, SkillCatalog } from "../src/skill-catalog";

describe("SkillCatalog (SSoT & Skills over MCP resources)", () => {
  test("実リポジトリの SKILL.md・ガイド・PR テンプレートを読み込み、SHA-256 と byte size が完全一致する", () => {
    const catalog = new SkillCatalog();
    const { skills } = catalog.listSkills();
    expect(skills).toHaveLength(1);

    const skill = skills[0];
    expect(skill.uri).toBe("skill://winget-verify-gate/SKILL.md");
    expect(skill.frontmatter.name).toBe("winget-verify-gate");
    expect(skill.frontmatter.license).toBe("MIT");
    expect(skill.frontmatter.metadata).toEqual({
      author: "scottlz0310",
      version: "0.2.0",
      guide: "references/submission-guide.md",
      template: "templates/pr-template.md",
    });
    expect(skill.frontmatter.description.length).toBeGreaterThan(20);
    expect(skill.resources).toHaveLength(3);

    for (const entry of skill.resources) {
      expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const content = catalog.readResource(entry.uri);
      expect(content).not.toBeNull();
      const rawBytes = Buffer.from(content?.contents[0].text ?? "", "utf8");
      expect(rawBytes.byteLength).toBe(entry.size);
      const actualDigest = `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`;
      expect(actualDigest).toBe(entry.digest);
    }

    expect(catalog.getSkill("skill://winget-verify-gate/SKILL.md")).toEqual(skill);
    expect(catalog.getSkill("skill://unknown/SKILL.md")).toBeNull();
  });

  test("readDirectory は SEP-2640 形式でルート・サブディレクトリを列挙しファイル URI を拒否する", () => {
    const catalog = new SkillCatalog();
    const rootDir = catalog.readDirectory("skill://winget-verify-gate");
    expect(rootDir).not.toBeNull();
    expect(rootDir?.resources.map((r) => `${r.mimeType}:${r.uri}`)).toEqual([
      "inode/directory:skill://winget-verify-gate/references",
      "text/markdown:skill://winget-verify-gate/SKILL.md",
      "inode/directory:skill://winget-verify-gate/templates",
    ]);

    const rootDirWithSlash = catalog.readDirectory("skill://winget-verify-gate/");
    expect(rootDirWithSlash).toEqual(rootDir);

    const refsDir = catalog.readDirectory("skill://winget-verify-gate/references");
    expect(refsDir?.resources).toHaveLength(1);
    expect(refsDir?.resources[0]?.name).toBe("submission-guide.md");
    expect(refsDir?.resources[0]?.mimeType).toBe("text/markdown");

    expect(catalog.readDirectory("skill://winget-verify-gate/SKILL.md")).toBeNull();
    expect(catalog.readDirectory("skill://winget-verify-gate/missing")).toBeNull();
  });

  test("exportSkill は非対応クライアント向けに全リソースを同一ダイジェストで書き出す", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-skill-export-"));
    try {
      const catalog = new SkillCatalog();
      const exported = catalog.exportSkill(tmpDir);
      expect(exported.skillName).toBe("winget-verify-gate");
      expect(exported.files).toHaveLength(3);

      for (const file of exported.files) {
        expect(existsSync(file.path)).toBe(true);
        const bytes = readFileSync(file.path);
        const actualDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        expect(actualDigest).toBe(file.digest);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("frontmatter が不正な SKILL.md を明示的に拒否する", () => {
    expect(() => parseSkillFrontmatter("# no frontmatter")).toThrow("frontmatter");
    expect(() => parseSkillFrontmatter("---\nname: only-name\n---\nbody")).toThrow("description");
  });
});
