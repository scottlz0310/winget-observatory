import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compareExtractedDirectories,
  verifySlsaProvenance,
} from "../scripts/verify-published-package";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const BUILT_CLI_PATH = join(PACKAGE_ROOT, "dist", "cli.mjs");

let builtInThisRun = false;

function ensureBuiltBundle(): string {
  if (!builtInThisRun) {
    const proc = Bun.spawnSync(["bun", "run", join(PACKAGE_ROOT, "scripts", "build.ts")], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`build.ts failed: ${new TextDecoder().decode(proc.stderr)}`);
    }
    builtInThisRun = true;
  }
  return BUILT_CLI_PATH;
}

function makeAttestationResponse(overrides?: {
  subjectName?: string;
  sha512?: string;
  repository?: string;
  workflowPath?: string;
  gitCommit?: string;
  predicateType?: string;
}) {
  const statement = {
    subject: [
      {
        name: overrides?.subjectName ?? "pkg:npm/%40scottlz0310/winget-verify-gate@0.7.0",
        digest: { sha512: overrides?.sha512 ?? "a".repeat(128) },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository:
              overrides?.repository ?? "https://github.com/scottlz0310/winget-observatory",
            path: overrides?.workflowPath ?? ".github/workflows/release.yml",
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/scottlz0310/winget-observatory@refs/heads/main",
            digest: {
              gitCommit: overrides?.gitCommit ?? "1234567890abcdef1234567890abcdef12345678",
            },
          },
        ],
      },
    },
  };
  return {
    attestations: [
      {
        predicateType: overrides?.predicateType ?? "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
          },
        },
      },
    ],
  };
}

describe("verify-gate distribution bundle & release provenance", () => {
  test("配布バンドル dist/cli.mjs は大きい JSON（>250KB）をパイプ stdout 経由で途中切断せず完全出力する", () => {
    const cliPath = ensureBuiltBundle();
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-large-pipe-"));
    try {
      const manifestDir = join(tmpDir, "manifest");
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(
        join(manifestDir, "Example.Large.yaml"),
        [
          "# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.12.0.schema.json",
          "PackageIdentifier: Example.Large",
          "PackageVersion: 1.0.0",
          "DefaultLocale: en-US",
          "ManifestType: version",
          "ManifestVersion: 1.12.0",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(manifestDir, "Example.Large.locale.en-US.yaml"),
        [
          "# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.12.0.schema.json",
          "PackageIdentifier: Example.Large",
          "PackageVersion: 1.0.0",
          "PackageLocale: en-US",
          "Publisher: Example Corp",
          "PublisherUrl: https://example.invalid",
          "PackageName: LargeApp",
          "License: MIT",
          "LicenseUrl: https://example.invalid/license",
          "ShortDescription: Large manifest pipe test",
          "ManifestType: defaultLocale",
          "ManifestVersion: 1.12.0",
        ].join("\n"),
        "utf8",
      );
      // 800 件の不備あり installer を生成し、>300KB の JSON レポートをパイプ出力させる
      const installerLines = [
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json",
        "PackageIdentifier: Example.Large",
        "PackageVersion: 1.0.0",
        "Installers:",
      ];
      for (let i = 0; i < 800; i++) {
        installerLines.push(
          "  - Architecture: x64",
          "    InstallerType: portable",
          `    InstallerUrl: http://example.invalid/releases/latest/app-${i}.exe`,
          "    InstallerSha256: invalid",
        );
      }
      installerLines.push("ManifestType: installer", "ManifestVersion: 1.12.0");
      writeFileSync(
        join(manifestDir, "Example.Large.installer.yaml"),
        installerLines.join("\n"),
        "utf8",
      );

      // Node.js が利用可能な環境では Node.js で、そうでなければ Bun でパイプ出力を検証
      const nodeBin = Bun.which("node");
      const runner = nodeBin ? [nodeBin, cliPath] : [process.execPath, cliPath];
      const proc = Bun.spawnSync([...runner, "check", manifestDir, "--offline", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(proc.exitCode).toBe(1);
      const stdout = new TextDecoder().decode(proc.stdout);
      expect(Buffer.byteLength(stdout, "utf8")).toBeGreaterThan(250_000);
      const parsed = JSON.parse(stdout) as {
        passed: boolean;
        findings: Array<{ id: string }>;
      };
      expect(parsed.passed).toBe(false);
      expect(parsed.findings.length).toBeGreaterThanOrEqual(800);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Node.js が PATH に無い純 Bun 環境でも配布バンドルが --bun 指定で起動・埋め込みスキル読込できる", () => {
    const cliPath = ensureBuiltBundle();
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-nobin-node-"));
    try {
      // リポジトリ外へ dist/cli.mjs 単体をコピーし、PATH を Bun のディレクトリのみに限定（node を除外）
      const isolatedCli = join(tmpDir, "cli.mjs");
      copyFileSync(cliPath, isolatedCli);
      const bunDir = dirname(process.execPath);
      const proc = Bun.spawnSync(
        [process.execPath, "--bun", isolatedCli, "skill", "list", "--json"],
        {
          cwd: tmpDir,
          env: {
            ...process.env,
            PATH: bunDir,
            Path: bunDir,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(proc.exitCode).toBe(0);
      const out = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
        skills: Array<{ resources: unknown[] }>;
      };
      expect(out.skills).toHaveLength(1);
      expect(out.skills[0]?.resources).toHaveLength(3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "正常な SLSA provenance（リポジトリ・workflow・SHA・tarball sha512 すべて一致）",
      att: makeAttestationResponse(),
      expectedOk: true,
    },
    {
      name: "別コミット SHA の公開物は拒否",
      att: makeAttestationResponse({ gitCommit: "ffffffffffffffffffffffffffffffffffffffff" }),
      expectedOk: false,
    },
    {
      name: "別リポジトリからの公開物は拒否",
      att: makeAttestationResponse({ repository: "https://github.com/other/repo" }),
      expectedOk: false,
    },
    {
      name: "別ワークフローからの公開物は拒否",
      att: makeAttestationResponse({ workflowPath: ".github/workflows/other.yml" }),
      expectedOk: false,
    },
    {
      name: "tarball sha512 不一致は拒否",
      att: makeAttestationResponse({ sha512: "b".repeat(128) }),
      expectedOk: false,
    },
    {
      name: "パッケージ PURL 不一致は拒否",
      att: makeAttestationResponse({ subjectName: "pkg:npm/%40scottlz0310/other@0.7.0" }),
      expectedOk: false,
    },
    {
      name: "SLSA provenance エントリ欠落は拒否",
      att: makeAttestationResponse({
        predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
      }),
      expectedOk: false,
    },
  ])("verifySlsaProvenance: $name", ({ att, expectedOk }) => {
    const result = verifySlsaProvenance({
      attestationsResponse: att,
      expectedPackageName: "@scottlz0310/winget-verify-gate",
      expectedVersion: "0.7.0",
      expectedRepository: "scottlz0310/winget-observatory",
      expectedWorkflowPath: ".github/workflows/release.yml",
      expectedCommitSha: "1234567890abcdef1234567890abcdef12345678",
      expectedTarballSha512Hex: "a".repeat(128),
    });
    expect(result.ok).toBe(expectedOk);
  });

  test("compareExtractedDirectories はファイル集合と各バイト内容の一致・不一致を正確に検出する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-cmp-dir-"));
    try {
      const a = join(tmpDir, "a");
      const b = join(tmpDir, "b");
      mkdirSync(join(a, "dist"), { recursive: true });
      mkdirSync(join(b, "dist"), { recursive: true });
      writeFileSync(join(a, "dist", "cli.mjs"), "console.log(1);\n", "utf8");
      writeFileSync(join(b, "dist", "cli.mjs"), "console.log(1);\n", "utf8");
      expect(compareExtractedDirectories(a, b).ok).toBe(true);

      // 1 バイト改変 → 不一致
      writeFileSync(join(b, "dist", "cli.mjs"), "console.log(2);\n", "utf8");
      expect(compareExtractedDirectories(a, b).ok).toBe(false);

      // 余分なファイル追加 → 不一致
      writeFileSync(join(b, "dist", "cli.mjs"), "console.log(1);\n", "utf8");
      writeFileSync(join(b, "extra.txt"), "extra", "utf8");
      expect(compareExtractedDirectories(a, b).ok).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
