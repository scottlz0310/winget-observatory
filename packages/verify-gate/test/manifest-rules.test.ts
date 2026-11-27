import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatGateReportText, runManifestGate } from "../src/gate-runner";
import { loadManifestBundle } from "../src/manifest-loader";
import { evaluateManifestRules } from "../src/manifest-rules";
import { buildSyntheticPe } from "./pe-inspector.test";

const VALID_SHA = "A".repeat(64);

function writeManifestFixture(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
}

function makeCleanPortableZipFixture(
  overrides: {
    manifestVersion?: string;
    schemaVersion?: string;
    installerYamlExtra?: string;
    installerUrl?: string;
    installerSha?: string;
    localeYamlExtra?: string;
    description?: string;
  } = {},
): Record<string, string> {
  const mv = overrides.manifestVersion ?? "1.12.0";
  const sv = overrides.schemaVersion ?? mv;
  return {
    "Example.MyCli.yaml": [
      `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${sv}.schema.json`,
      "PackageIdentifier: Example.MyCli",
      "PackageVersion: 1.0.0",
      "DefaultLocale: en-US",
      "ManifestType: version",
      `ManifestVersion: ${mv}`,
      "",
    ].join("\n"),
    "Example.MyCli.installer.yaml": [
      `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${sv}.schema.json`,
      "PackageIdentifier: Example.MyCli",
      "PackageVersion: 1.0.0",
      "Installers:",
      "  - Architecture: x64",
      "    InstallerType: zip",
      "    NestedInstallerType: portable",
      "    NestedInstallerFiles:",
      "      - RelativeFilePath: mycli.exe",
      "        PortableCommandAlias: mycli",
      `    InstallerUrl: ${overrides.installerUrl ?? "https://github.com/example/mycli/releases/download/v1.0.0/mycli-x64.zip"}`,
      `    InstallerSha256: ${overrides.installerSha ?? VALID_SHA}`,
      overrides.installerYamlExtra ?? "",
      "ManifestType: installer",
      `ManifestVersion: ${mv}`,
      "",
    ].join("\n"),
    "Example.MyCli.locale.en-US.yaml": [
      `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${sv}.schema.json`,
      "PackageIdentifier: Example.MyCli",
      "PackageVersion: 1.0.0",
      "PackageLocale: en-US",
      "Publisher: Example Dev",
      "PublisherUrl: https://github.com/example",
      "PackageName: MyCli",
      "PackageUrl: https://github.com/example/mycli",
      "License: MIT",
      "LicenseUrl: https://github.com/example/mycli/blob/main/LICENSE",
      `ShortDescription: ${overrides.description ?? "Local command line utility"}`,
      overrides.localeYamlExtra ?? "",
      "ManifestType: defaultLocale",
      `ManifestVersion: ${mv}`,
      "",
    ].join("\n"),
  };
}

describe("manifest-rules and gate-runner", () => {
  test("クリーンなポータブル ZIP マニフェスト＋静的リンク PE は全 pass になる", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-manifest-ok-"));
    try {
      const payload = Buffer.from("zip-release-payload");
      const sha = createHash("sha256").update(payload).digest("hex").toUpperCase();
      writeManifestFixture(tmpDir, makeCleanPortableZipFixture({ installerSha: sha }));

      const exePath = join(tmpDir, "mycli.exe");
      writeFileSync(
        exePath,
        buildSyntheticPe({
          machine: 0x8664,
          pe32Plus: true,
          importedDlls: ["KERNEL32.dll"],
          hasSignature: true,
        }),
      );

      const mockFetch = async () => new Response(payload, { status: 200 });
      const report = await runManifestGate(
        { manifestDir: tmpDir, binaryPath: exePath, verifySha256: true },
        { fetchImpl: mockFetch },
      );

      expect(report.passed).toBe(true);
      expect(report.summary.fail).toBe(0);
      expect(report.summary.warn).toBe(0);
      expect(report.findings.find((f) => f.id === "CMN-03-SHA256")?.status).toBe("pass");
      expect(formatGateReportText(report)).toContain("[verify-gate] PASS");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("旧版 ManifestVersion・$schema 不一致・可変 URL・AI 説明文の PrivacyUrl 欠落・Policy-Test 語句を検出する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-manifest-bad-"));
    try {
      writeManifestFixture(
        tmpDir,
        makeCleanPortableZipFixture({
          manifestVersion: "1.6.0",
          schemaVersion: "1.12.0",
          installerUrl: "https://github.com/example/mycli/releases/latest/download/mycli.zip",
          description: "Adobe PDF AI assistant with OpenAI API key support",
        }),
      );
      const bundle = loadManifestBundle(tmpDir);
      const findings = evaluateManifestRules(bundle);

      expect(findings.some((f) => f.id === "CMN-02" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "CMN-03" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "CMN-06" && f.status === "warn")).toBe(true);
      expect(findings.some((f) => f.id === "APP-NET-01" && f.status === "warn")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: "単体 portable EXE に PortableCommandAlias を誤設定すると fail",
      installerYaml: [
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json",
        "PackageIdentifier: Example.Tool",
        "PackageVersion: 1.0.0",
        "Installers:",
        "  - Architecture: x64",
        "    InstallerType: portable",
        "    PortableCommandAlias: mytool",
        "    InstallerUrl: https://github.com/example/tool/releases/download/v1.0.0/tool.exe",
        `    InstallerSha256: ${VALID_SHA}`,
        "ManifestType: installer",
        "ManifestVersion: 1.12.0",
      ].join("\n"),
      expectedId: "APP-CLI-03",
      expectedStatus: "fail" as const,
    },
    {
      name: "ZIP 内包 inno インストーラーに PortableCommandAlias を設定すると fail、UpgradeBehavior 未設定は warn",
      installerYaml: [
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json",
        "PackageIdentifier: Example.Tool",
        "PackageVersion: 1.0.0",
        "Installers:",
        "  - Architecture: x64",
        "    InstallerType: zip",
        "    NestedInstallerType: inno",
        "    NestedInstallerFiles:",
        "      - RelativeFilePath: setup.exe",
        "        PortableCommandAlias: wrong",
        "    InstallerUrl: https://github.com/example/tool/releases/download/v1.0.0/setup.zip",
        `    InstallerSha256: ${VALID_SHA}`,
        "ManifestType: installer",
        "ManifestVersion: 1.12.0",
      ].join("\n"),
      expectedId: "PKG-PORT-02",
      expectedStatus: "fail" as const,
    },
    {
      name: "カスタム exe で InstallerSwitches.Silent 欠落は fail",
      installerYaml: [
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json",
        "PackageIdentifier: Example.Tool",
        "PackageVersion: 1.0.0",
        "Installers:",
        "  - Architecture: x64",
        "    InstallerType: exe",
        "    UpgradeBehavior: uninstallPrevious",
        "    InstallerUrl: https://github.com/example/tool/releases/download/v1.0.0/setup.exe",
        `    InstallerSha256: ${VALID_SHA}`,
        "ManifestType: installer",
        "ManifestVersion: 1.12.0",
      ].join("\n"),
      expectedId: "PKG-INST-04",
      expectedStatus: "fail" as const,
    },
    {
      name: "スクリプト拡張子 (.ps1) の直接参照は NG-01 で fail",
      installerYaml: [
        "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json",
        "PackageIdentifier: Example.Tool",
        "PackageVersion: 1.0.0",
        "Installers:",
        "  - Architecture: x64",
        "    InstallerType: zip",
        "    NestedInstallerType: portable",
        "    NestedInstallerFiles:",
        "      - RelativeFilePath: run.ps1",
        "        PortableCommandAlias: runtool",
        "    InstallerUrl: https://github.com/example/tool/releases/download/v1.0.0/tool.zip",
        `    InstallerSha256: ${VALID_SHA}`,
        "ManifestType: installer",
        "ManifestVersion: 1.12.0",
      ].join("\n"),
      expectedId: "NG-01",
      expectedStatus: "fail" as const,
    },
  ])("$name", ({ installerYaml, expectedId, expectedStatus }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-branch-"));
    try {
      const base = makeCleanPortableZipFixture();
      writeManifestFixture(tmpDir, {
        "Example.Tool.yaml": base["Example.MyCli.yaml"].replaceAll("Example.MyCli", "Example.Tool"),
        "Example.Tool.installer.yaml": installerYaml,
        "Example.Tool.locale.en-US.yaml": base["Example.MyCli.locale.en-US.yaml"].replaceAll(
          "Example.MyCli",
          "Example.Tool",
        ),
      });
      const findings = evaluateManifestRules(loadManifestBundle(tmpDir));
      expect(findings.some((f) => f.id === expectedId && f.status === expectedStatus)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SHA-256 不一致および HTTP 404 をネットワーク検証で fail 検知し、offline では skip する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-net-"));
    try {
      writeManifestFixture(tmpDir, makeCleanPortableZipFixture());

      const offlineReport = await runManifestGate({ manifestDir: tmpDir, offline: true });
      expect(offlineReport.findings.find((f) => f.id === "CMN-03-NET")?.status).toBe("skip");

      const mismatchReport = await runManifestGate(
        { manifestDir: tmpDir, verifySha256: true },
        {
          fetchImpl: async (url) => {
            if (String(url).endsWith(".zip")) {
              return new Response("different-bytes", { status: 200 });
            }
            return new Response(null, { status: 404 });
          },
        },
      );
      expect(mismatchReport.passed).toBe(false);
      expect(
        mismatchReport.findings.some((f) => f.id === "CMN-03-SHA256" && f.status === "fail"),
      ).toBe(true);
      expect(
        mismatchReport.findings.some((f) => f.id === "CMN-04-NET" && f.status === "fail"),
      ).toBe(true);

      // HEAD が 405 Method Not Allowed の場合は GET へフォールバックして到達確認できること
      let headCalls = 0;
      let getCalls = 0;
      const fallbackReport = await runManifestGate(
        { manifestDir: tmpDir, verifySha256: false },
        {
          fetchImpl: async (_url, init) => {
            if (init?.method === "HEAD") {
              headCalls++;
              return new Response(null, { status: 405 });
            }
            getCalls++;
            return new Response("ok", { status: 200 });
          },
        },
      );
      expect(headCalls).toBeGreaterThan(0);
      expect(getCalls).toBeGreaterThan(0);
      expect(fallbackReport.passed).toBe(true);

      // ネットワーク例外は fail として捕捉されること
      const errorReport = await runManifestGate(
        { manifestDir: tmpDir, verifySha256: false },
        {
          fetchImpl: async () => {
            throw new Error("ECONNREFUSED");
          },
        },
      );
      expect(errorReport.passed).toBe(false);
      expect(errorReport.findings.some((f) => f.id === "CMN-03-NET" && f.status === "fail")).toBe(
        true,
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("必須ファイル不足・ファイル間識別子不一致・HTTP URL・不正 SHA・欠落メタデータを網羅検出する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-edge-"));
    try {
      writeManifestFixture(tmpDir, {
        "Broken.installer.yaml": [
          "PackageIdentifier: Example.A",
          "PackageVersion: 1.0.0",
          "Installers:",
          "  - Architecture: x64",
          "    InstallerType: zip",
          "    InstallerUrl: http://example.com/app.ps1",
          "    InstallerSha256: short",
          "ManifestType: installer",
        ].join("\n"),
        "Broken.locale.en-US.yaml": [
          "PackageIdentifier: Example.B",
          "PackageVersion: 2.0.0",
          "PackageLocale: en-US",
          "PublisherUrl: http://example.com",
          "License: MIT",
          "ManifestType: defaultLocale",
          "ManifestVersion: 1.12.0",
        ].join("\n"),
      });
      const findings = evaluateManifestRules(loadManifestBundle(tmpDir));
      expect(findings.some((f) => f.id === "CMN-02-STRUCTURE" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "CMN-02" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "CMN-03" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "NG-01" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "PKG-PORT-02" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "CMN-04" && f.status === "warn")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
