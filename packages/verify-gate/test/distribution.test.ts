import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  compareExtractedDirectories,
  EXIT_CODE_MISSING,
  EXIT_CODE_PROPAGATION_TIMEOUT,
  EXIT_CODE_VERIFIED,
  runVerifyPublishedPackage,
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

  test("runVerifyPublishedPackage は公開済み再利用・未公開 exit 3・未反映待機リトライ・タイムアウト exit 4・異常系即失敗を正確に判定する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-run-verify-pkg-"));
    try {
      const srcDir = join(tmpDir, "pkg-src", "package");
      mkdirSync(join(srcDir, "dist"), { recursive: true });
      writeFileSync(join(srcDir, "dist", "cli.mjs"), "console.log('ok');\n", "utf8");
      writeFileSync(join(srcDir, "README.md"), "# readme\n", "utf8");

      const expectedTgz = join(tmpDir, "expected.tgz");
      execFileSync("tar", ["-czf", expectedTgz, "-C", join(tmpDir, "pkg-src"), "package"]);

      // 内容同一だが別圧縮（別 gzip ヘッダ/タイムスタンプ等）でも展開内容一致で検証可能にするため、
      // 同一ファイルを再圧縮した tarball を registry 側として用意
      const registryTgz = join(tmpDir, "registry-src.tgz");
      execFileSync("tar", ["-czf", registryTgz, "-C", join(tmpDir, "pkg-src"), "package"]);
      const registryBytes = readFileSync(registryTgz);
      const regSha512Base64 = createHash("sha512").update(registryBytes).digest("base64");
      const regSha512Hex = createHash("sha512").update(registryBytes).digest("hex");

      const commitSha = "1234567890abcdef1234567890abcdef12345678";
      const validMetadata = JSON.stringify({
        dist: {
          tarball: "https://registry.npmjs.org/@scottlz0310/winget-verify-gate/-/pkg.tgz",
          integrity: `sha512-${regSha512Base64}`,
          attestations: {
            url: "https://registry.npmjs.org/-/npm/v1/attestations/@scottlz0310%2fwinget-verify-gate@0.7.0",
          },
        },
      });
      const validAttestation = makeAttestationResponse({
        sha512: regSha512Hex,
        gitCommit: commitSha,
      });

      const baseArgs = [
        "--package",
        "@scottlz0310/winget-verify-gate",
        "--version",
        "v0.7.0",
        "--repo",
        "scottlz0310/winget-observatory",
        "--workflow-path",
        ".github/workflows/release.yml",
        "--commit",
        commitSha,
        "--expected-tarball",
        expectedTgz,
      ];

      // 1. 公開済み同一版の照合（--allow-missing 付きでも存在すれば exit 0）
      const logs1: string[] = [];
      const code1 = await runVerifyPublishedPackage([...baseArgs, "--allow-missing"], {
        npmView: () => validMetadata,
        fetchBytes: async () => registryBytes,
        fetchJson: async () => validAttestation,
        stdout: (l) => logs1.push(l),
      });
      expect(code1).toBe(EXIT_CODE_VERIFIED);
      expect(logs1[0]).toContain("VERIFIED");
      expect(logs1[0]).toContain("attempts=1");

      // 2. 未反映（npm view 404 → tarball 404 → attestations 404）を待機リトライし、4 回目で成功
      let clockMs = 1_000_000;
      const sleepCalls: number[] = [];
      let npmViewCalls = 0;
      let fetchBytesCalls = 0;
      let fetchJsonCalls = 0;
      const retryLogs: string[] = [];
      const retryCode = await runVerifyPublishedPackage(
        [...baseArgs, "--wait-seconds", "120", "--poll-interval-seconds", "30"],
        {
          now: () => clockMs,
          sleep: async (ms) => {
            sleepCalls.push(ms);
            clockMs += ms;
          },
          npmView: () => {
            npmViewCalls += 1;
            if (npmViewCalls === 1) {
              const e = new Error("npm error code E404") as Error & { stderr?: string };
              e.stderr = "404 Not Found";
              throw e;
            }
            return validMetadata;
          },
          fetchBytes: async () => {
            fetchBytesCalls += 1;
            if (fetchBytesCalls === 1) {
              throw new Error("HTTP 404 (https://registry.npmjs.org/pkg.tgz)");
            }
            return registryBytes;
          },
          fetchJson: async () => {
            fetchJsonCalls += 1;
            if (fetchJsonCalls === 1) {
              const e = new Error("not found") as Error & { status?: number };
              e.status = 404;
              throw e;
            }
            return validAttestation;
          },
          stdout: (l) => retryLogs.push(l),
        },
      );
      expect(retryCode).toBe(EXIT_CODE_VERIFIED);
      expect(sleepCalls).toEqual([30_000, 30_000, 30_000]);
      expect(retryLogs.filter((l) => l.startsWith("WAITING"))).toHaveLength(3);
      expect(retryLogs.at(-1)).toContain("VERIFIED");
      expect(retryLogs.at(-1)).toContain("attempts=4");

      // 3. 制限時間到達まで未反映継続 → exit 4（PROPAGATION_TIMEOUT）
      let timeoutClockMs = 5_000_000;
      const timeoutSleeps: number[] = [];
      const timeoutErrors: string[] = [];
      const timeoutCode = await runVerifyPublishedPackage(
        [...baseArgs, "--wait-seconds", "50", "--poll-interval-seconds", "30"],
        {
          now: () => timeoutClockMs,
          sleep: async (ms) => {
            timeoutSleeps.push(ms);
            timeoutClockMs += ms;
          },
          npmView: () => {
            const e = new Error("npm error code E404") as Error & { stderr?: string };
            e.stderr = "No match found for version 0.7.0";
            throw e;
          },
          stdout: () => {},
          stderr: (l) => timeoutErrors.push(l),
        },
      );
      expect(timeoutCode).toBe(EXIT_CODE_PROPAGATION_TIMEOUT);
      expect(timeoutSleeps).toEqual([30_000, 20_000]);
      expect(timeoutErrors[0]).toContain("PROPAGATION_TIMEOUT");

      // 4. --wait-seconds > 0 でも改ざん・SLSA 不一致・HTTP 500 等の非未反映エラーはリトライせず即失敗
      let fatalSleepCount = 0;
      await expect(
        runVerifyPublishedPackage([...baseArgs, "--wait-seconds", "120"], {
          sleep: async () => {
            fatalSleepCount += 1;
          },
          npmView: () => validMetadata,
          fetchBytes: async () => registryBytes,
          fetchJson: async () =>
            makeAttestationResponse({
              sha512: regSha512Hex,
              gitCommit: "0000000000000000000000000000000000000000",
            }),
        }),
      ).rejects.toThrow("SLSA provenance 検証失敗");
      expect(fatalSleepCount).toBe(0);

      // 5. 未公開版（E404）+ --allow-missing → exit 3、--allow-missing かつ --wait-seconds なしは reject
      const missLogs: string[] = [];
      const missCode = await runVerifyPublishedPackage([...baseArgs, "--allow-missing"], {
        npmView: () => {
          const e = new Error("npm error code E404") as Error & { stderr?: string };
          e.stderr = "404 Not Found";
          throw e;
        },
        stdout: (l) => missLogs.push(l),
      });
      expect(missCode).toBe(EXIT_CODE_MISSING);
      expect(missLogs[0]).toContain("MISSING");

      await expect(
        runVerifyPublishedPackage(baseArgs, {
          npmView: () => {
            const e = new Error("npm error code E404") as Error & { stderr?: string };
            e.stderr = "404 Not Found";
            throw e;
          },
        }),
      ).rejects.toThrow("npm view に失敗しました");

      await expect(
        runVerifyPublishedPackage(baseArgs, {
          npmView: () => {
            throw new Error("E500 Internal Server Error");
          },
        }),
      ).rejects.toThrow("npm view に失敗しました");

      // 6. メタデータ欠落・integrity 不一致・通信エラー・展開内容不一致を拒否
      await expect(
        runVerifyPublishedPackage(baseArgs, {
          npmView: () => JSON.stringify({ dist: { tarball: "https://example.invalid/a.tgz" } }),
        }),
      ).rejects.toThrow("dist 情報が不足");

      await expect(
        runVerifyPublishedPackage(baseArgs, {
          npmView: () =>
            JSON.stringify({
              dist: {
                tarball: "https://example.invalid/a.tgz",
                integrity: "sha512-WRONG",
                attestations: { url: "https://example.invalid/att" },
              },
            }),
          fetchBytes: async () => registryBytes,
        }),
      ).rejects.toThrow("integrity が一致しません");

      await expect(
        runVerifyPublishedPackage(baseArgs, {
          npmView: () => validMetadata,
          fetchBytes: async () => {
            throw new Error("HTTP 503");
          },
        }),
      ).rejects.toThrow("HTTP 503");

      // 展開ファイル内容が異なる tarball を拒否
      const diffSrcDir = join(tmpDir, "diff-src", "package");
      mkdirSync(join(diffSrcDir, "dist"), { recursive: true });
      writeFileSync(join(diffSrcDir, "dist", "cli.mjs"), "console.log('MODIFIED');\n", "utf8");
      writeFileSync(join(diffSrcDir, "README.md"), "# readme\n", "utf8");
      const diffTgz = join(tmpDir, "diff.tgz");
      execFileSync("tar", ["-czf", diffTgz, "-C", join(tmpDir, "diff-src"), "package"]);
      const diffBytes = readFileSync(diffTgz);
      const diffSha512Base64 = createHash("sha512").update(diffBytes).digest("base64");
      const diffSha512Hex = createHash("sha512").update(diffBytes).digest("hex");
      await expect(
        runVerifyPublishedPackage(baseArgs, {
          npmView: () =>
            JSON.stringify({
              dist: {
                tarball: "https://example.invalid/diff.tgz",
                integrity: `sha512-${diffSha512Base64}`,
                attestations: { url: "https://example.invalid/att" },
              },
            }),
          fetchBytes: async () => diffBytes,
          fetchJson: async () =>
            makeAttestationResponse({ sha512: diffSha512Hex, gitCommit: commitSha }),
        }),
      ).rejects.toThrow("内容検証に失敗");

      // 7. 引数エラー
      await expect(runVerifyPublishedPackage(["--unknown"])).rejects.toThrow("未知の引数");
      await expect(runVerifyPublishedPackage([])).rejects.toThrow("すべて必須");
      await expect(
        runVerifyPublishedPackage([...baseArgs, "--allow-missing", "--wait-seconds", "60"]),
      ).rejects.toThrow("同時に指定できません");
      await expect(
        runVerifyPublishedPackage([...baseArgs, "--wait-seconds", "-1"]),
      ).rejects.toThrow("0 以上の数値");
      await expect(
        runVerifyPublishedPackage([...baseArgs, "--poll-interval-seconds", "0"]),
      ).rejects.toThrow("0 より大きい数値");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
