import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { runManifestGate, runSandboxEval, runSandboxPrepare } from "../src/gate-runner";
import { loadManifestBundle } from "../src/manifest-loader";
import { handleJsonRpcMessage } from "../src/mcp-server";
import {
  diffArpSnapshots,
  evaluateSandboxResult,
  parseSandboxRunResult,
} from "../src/sandbox-evaluator";
import {
  buildInsideSandboxScript,
  buildWsbConfigurationXml,
  escapePowerShellSingleQuoted,
  escapeXml,
  inferProbeCommandsFromBundle,
} from "../src/sandbox-plan";
import type { ArpRegistryEntry, SandboxRunResult } from "../src/types";

const VALID_SHA = "A".repeat(64);

function writeInstallerManifest(
  dir: string,
  options: {
    installerType?: string;
    nestedInstallerType?: string;
    commands?: string[];
    appsAndFeaturesYaml?: string[];
    productCode?: string;
    upgradeBehavior?: string;
  } = {},
): void {
  const installerType = options.installerType ?? "inno";
  const lines = [
    "# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json",
    "PackageIdentifier: Example.MyApp",
    "PackageVersion: 1.2.3",
    "Installers:",
    "  - Architecture: x64",
    `    InstallerType: ${installerType}`,
    ...(options.nestedInstallerType
      ? [
          `    NestedInstallerType: ${options.nestedInstallerType}`,
          "    NestedInstallerFiles:",
          "      - RelativeFilePath: myapp.exe",
          "        PortableCommandAlias: myapp",
        ]
      : []),
    ...(options.commands && options.commands.length > 0
      ? ["    Commands:", ...options.commands.map((c) => `      - ${c}`)]
      : []),
    ...(options.upgradeBehavior ? [`    UpgradeBehavior: ${options.upgradeBehavior}`] : []),
    ...(options.productCode ? [`    ProductCode: "${options.productCode}"`] : []),
    ...(options.appsAndFeaturesYaml ?? []),
    "    InstallerUrl: https://github.com/example/myapp/releases/download/v1.2.3/myapp-setup.exe",
    `    InstallerSha256: ${VALID_SHA}`,
    "ManifestType: installer",
    "ManifestVersion: 1.12.0",
    "",
  ];
  writeFileSync(
    join(dir, "Example.MyApp.yaml"),
    [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.12.0.schema.json",
      "PackageIdentifier: Example.MyApp",
      "PackageVersion: 1.2.3",
      "DefaultLocale: en-US",
      "ManifestType: version",
      "ManifestVersion: 1.12.0",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(dir, "Example.MyApp.installer.yaml"), lines.join("\n"), "utf8");
  writeFileSync(
    join(dir, "Example.MyApp.locale.en-US.yaml"),
    [
      "# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.12.0.schema.json",
      "PackageIdentifier: Example.MyApp",
      "PackageVersion: 1.2.3",
      "PackageLocale: en-US",
      "Publisher: Example Corp",
      "PublisherUrl: https://github.com/example",
      "PackageName: MyApp",
      "PackageUrl: https://github.com/example/myapp",
      "License: MIT",
      "LicenseUrl: https://github.com/example/myapp/blob/main/LICENSE",
      "ShortDescription: Example desktop application",
      "ManifestType: defaultLocale",
      "ManifestVersion: 1.12.0",
      "",
    ].join("\n"),
    "utf8",
  );
}

function makeBaseSandboxResult(overrides: Partial<SandboxRunResult> = {}): SandboxRunResult {
  const existingArp: ArpRegistryEntry = {
    registryKeyPath: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ExistingApp",
    hive: "HKLM",
    view: "64bit",
    keyName: "ExistingApp",
    displayName: "Existing App",
    publisher: "OS Vendor",
    displayVersion: "1.0.0",
  };
  const installedArp: ArpRegistryEntry = {
    registryKeyPath: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MyApp_is1",
    hive: "HKLM",
    view: "64bit",
    keyName: "MyApp_is1",
    displayName: "MyApp",
    publisher: "Example Corp",
    displayVersion: "1.2.3",
    productCode: "{11111111-2222-3333-4444-555555555555}",
    upgradeCode: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}",
  };
  return {
    schemaVersion: 1,
    packageIdentifier: "Example.MyApp",
    packageVersion: "1.2.3",
    executedAt: "2026-11-27T14:00:00.000Z",
    localManifestFilesEnabled: true,
    install: {
      command: "winget install --manifest C:\\Users\\WDAGUtilityAccount\\Desktop\\manifest",
      exitCode: 0,
    },
    uninstall: {
      command: "winget uninstall --id Example.MyApp --silent --disable-interactivity",
      exitCode: 0,
    },
    arpBefore: [existingArp],
    arpAfterInstall: [existingArp, installedArp],
    arpAfterUninstall: [existingArp],
    cliProbes: [
      { command: "myapp", args: [], exitCode: 0, timedOut: false, stdoutSnippet: "ok" },
      {
        command: "myapp",
        args: ["--version"],
        exitCode: 0,
        timedOut: false,
        stdoutSnippet: "1.2.3",
      },
      { command: "myapp", args: ["--help"], exitCode: 0, timedOut: false, stdoutSnippet: "Usage" },
    ],
    ...overrides,
  };
}

describe("Windows Sandbox integration (sandbox-plan & sandbox-evaluator)", () => {
  test("escapeXml と escapePowerShellSingleQuoted は特殊文字を安全にエスケープし制御文字パスを拒否する", () => {
    expect(escapeXml(`<a & "b" 'c'>`)).toBe("&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
    expect(escapePowerShellSingleQuoted("it's a 'test'")).toBe("it''s a ''test''");
    expect(() =>
      buildWsbConfigurationXml({
        manifestHostDir: "C:\\bad\npath",
        outputHostDir: "C:\\out",
      }),
    ).toThrow("制御文字");

    const xml = buildWsbConfigurationXml({
      manifestHostDir: "C:\\work\\a&b",
      outputHostDir: "C:\\out\\dir",
      enableVgpu: true,
    });
    expect(xml).toContain("<VGpu>Enable</VGpu>");
    expect(xml).toContain("<HostFolder>C:\\work\\a&amp;b</HostFolder>");
    expect(xml).toContain("<ReadOnly>true</ReadOnly>");
  });

  test("prepareSandboxWorkspace は .wsb・UTF-8 BOM PowerShell スクリプト・ランチャーを生成しコマンドを推論する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-sbx-prep-"));
    try {
      const manifestDir = join(tmpDir, "manifest");
      const outDir = join(tmpDir, "out");
      const wingetRoot = join(tmpDir, "winget-pkgs");
      mkdirSync(manifestDir, { recursive: true });
      writeInstallerManifest(manifestDir, {
        installerType: "zip",
        nestedInstallerType: "portable",
        commands: ["myapp-cli"],
      });

      const bundle = loadManifestBundle(manifestDir);
      expect(inferProbeCommandsFromBundle(bundle)).toEqual(["myapp-cli", "myapp"]);

      const prepared = runSandboxPrepare({
        manifestDir,
        outDir,
        wingetPkgsRoot: wingetRoot,
        probeCommands: ["extra-cmd"],
        skipUninstall: true,
      });

      expect(prepared.packageIdentifier).toBe("Example.MyApp");
      expect(prepared.probeCommands).toEqual(["myapp-cli", "myapp", "extra-cmd"]);
      expect(existsSync(prepared.wsbPath)).toBe(true);
      expect(existsSync(prepared.sandboxScriptPath)).toBe(true);
      expect(existsSync(prepared.hostLauncherPath)).toBe(true);
      expect(prepared.recommendedOfficialCommand).toContain("SandboxTest.ps1");

      const wsbText = readFileSync(prepared.wsbPath, "utf8");
      expect(wsbText).toContain("<VGpu>Disable</VGpu>");
      expect(wsbText).toContain("verify-inside-sandbox.ps1");

      const scriptBytes = readFileSync(prepared.sandboxScriptPath);
      expect(scriptBytes[0]).toBe(0xef);
      expect(scriptBytes[1]).toBe(0xbb);
      expect(scriptBytes[2]).toBe(0xbf);
      const scriptText = scriptBytes.toString("utf8");
      expect(scriptText).toContain("winget settings --enable LocalManifestFiles");
      expect(scriptText).toContain("$SkipUninstall = $true");
      expect(scriptText).toContain("'extra-cmd'");

      // シングルクォートを含む特殊引数でも安全にエスケープされる
      const quotedScript = buildInsideSandboxScript({
        packageIdentifier: "O'Reilly.Tool",
        packageVersion: "1.0.0",
        probeCommands: ["my'cmd"],
      });
      expect(quotedScript).toContain("'O''Reilly.Tool'");
      expect(quotedScript).toContain("'my''cmd'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "不正 JSON", raw: "{broken", expectedError: "解析" },
    { name: "トップレベル配列", raw: "[]", expectedError: "オブジェクト" },
    {
      name: "未対応 schemaVersion",
      raw: JSON.stringify({ schemaVersion: 2 }),
      expectedError: "schemaVersion",
    },
    {
      name: "localManifestFilesEnabled 非 boolean",
      raw: JSON.stringify({ schemaVersion: 1, localManifestFilesEnabled: "yes" }),
      expectedError: "localManifestFilesEnabled",
    },
    {
      name: "executedAt 欠落",
      raw: JSON.stringify({ schemaVersion: 1, localManifestFilesEnabled: true }),
      expectedError: "executedAt",
    },
    {
      name: "arpBefore 非配列",
      raw: JSON.stringify({
        schemaVersion: 1,
        localManifestFilesEnabled: true,
        executedAt: "2026-11-27T00:00:00Z",
        arpBefore: {},
      }),
      expectedError: "arpBefore",
    },
    {
      name: "install.exitCode 非整数",
      raw: JSON.stringify({
        schemaVersion: 1,
        localManifestFilesEnabled: true,
        executedAt: "2026-11-27T00:00:00Z",
        arpBefore: [],
        arpAfterInstall: [],
        install: { command: "winget install", exitCode: "0" },
      }),
      expectedError: "exitCode",
    },
    {
      name: "不正 hive",
      raw: JSON.stringify({
        schemaVersion: 1,
        localManifestFilesEnabled: true,
        executedAt: "2026-11-27T00:00:00Z",
        arpBefore: [{ hive: "HKCR", view: "64bit", keyName: "a" }],
        arpAfterInstall: [],
        install: { command: "winget install", exitCode: 0 },
      }),
      expectedError: "hive",
    },
    {
      name: "cliProbes の timedOut 非 boolean",
      raw: JSON.stringify({
        schemaVersion: 1,
        localManifestFilesEnabled: true,
        executedAt: "2026-11-27T00:00:00Z",
        arpBefore: [],
        arpAfterInstall: [],
        install: { command: "winget install", exitCode: 0 },
        cliProbes: [{ command: "x", args: [], exitCode: 0, timedOut: "no" }],
      }),
      expectedError: "timedOut",
    },
  ])("parseSandboxRunResult は不正入力を明示エラーで拒否する: $name", ({ raw, expectedError }) => {
    expect(() => parseSandboxRunResult(raw)).toThrow(expectedError);
  });

  test("UTF-8 BOM 付き sandbox-result.json の読み込みと ARP 差分抽出が動作する", () => {
    const base = makeBaseSandboxResult();
    const parsed = parseSandboxRunResult(`\uFEFF${JSON.stringify(base)}`);
    expect(parsed.packageIdentifier).toBe("Example.MyApp");

    const diff = diffArpSnapshots(parsed.arpBefore, parsed.arpAfterInstall);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]?.keyName).toBe("MyApp_is1");
    expect(diff.updated).toHaveLength(0);
  });

  test("クリーンな Sandbox 結果（ARP 一致・アンインストール残骸なし・CLI 成功）は全 pass になる", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-sbx-ok-"));
    try {
      writeInstallerManifest(tmpDir, {
        installerType: "inno",
        upgradeBehavior: "uninstallPrevious",
        appsAndFeaturesYaml: [
          "    AppsAndFeaturesEntries:",
          "      - DisplayName: MyApp",
          "        Publisher: Example Corp",
          "        DisplayVersion: 1.2.3",
          '        ProductCode: "{11111111-2222-3333-4444-555555555555}"',
          '        UpgradeCode: "{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}"',
        ],
      });
      const bundle = loadManifestBundle(tmpDir);
      const findings = evaluateSandboxResult(bundle, makeBaseSandboxResult());

      expect(findings.filter((f) => f.status === "fail")).toHaveLength(0);
      expect(findings.filter((f) => f.status === "warn")).toHaveLength(0);
      expect(findings.some((f) => f.id === "CMN-SBX-01" && f.status === "pass")).toBe(true);
      expect(findings.some((f) => f.id === "NG-03" && f.status === "pass")).toBe(true);
      expect(findings.some((f) => f.id === "PKG-INST-01" && f.status === "pass")).toBe(true);
      expect(findings.some((f) => f.id === "PKG-INST-03" && f.status === "pass")).toBe(true);
      expect(findings.some((f) => f.id === "APP-CLI-01" && f.status === "pass")).toBe(true);
      expect(findings.some((f) => f.id === "APP-CLI-02" && f.status === "pass")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("依存パッケージ（VCRedist）が同時に ARP 登録されてもアプリ本体の ARP を選択して正しく照合する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-sbx-multi-arp-"));
    try {
      writeInstallerManifest(tmpDir, {
        installerType: "inno",
        upgradeBehavior: "uninstallPrevious",
      });
      const bundle = loadManifestBundle(tmpDir);
      const vcRedistArp: ArpRegistryEntry = {
        registryKeyPath: "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VCRedist",
        hive: "HKLM",
        view: "64bit",
        keyName: "{00000000-0000-0000-0000-000000000001}",
        displayName: "Microsoft Visual C++ 2015-2022 Redistributable (x64)",
        publisher: "Microsoft Corporation",
        displayVersion: "14.40.33810.0",
      };
      const base = makeBaseSandboxResult();
      const result = makeBaseSandboxResult({
        arpAfterInstall: [base.arpBefore[0], vcRedistArp, base.arpAfterInstall[1]],
        arpAfterUninstall: [base.arpBefore[0], vcRedistArp],
      });
      const findings = evaluateSandboxResult(bundle, result);
      expect(findings.some((f) => f.id === "PKG-INST-01" && f.status === "pass")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("LocalManifestFiles 無効・PackageIdentifier 不一致・ARP 不一致・uninstall 残骸・CLI exit 2 / 0xC0000135 を適切に検出する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-sbx-fail-"));
    try {
      writeInstallerManifest(tmpDir, {
        installerType: "inno",
        appsAndFeaturesYaml: [
          "    AppsAndFeaturesEntries:",
          "      - DisplayName: MyApp",
          "        Publisher: Example Corp",
          "        DisplayVersion: 1.2.3",
          '        ProductCode: "{11111111-2222-3333-4444-555555555555}"',
        ],
      });
      const bundle = loadManifestBundle(tmpDir);
      const base = makeBaseSandboxResult();
      const brokenResult = makeBaseSandboxResult({
        packageIdentifier: "Other.Package",
        localManifestFilesEnabled: false,
        arpAfterInstall: [
          base.arpBefore[0],
          {
            ...base.arpAfterInstall[1],
            displayVersion: "1.2.3.0",
            productCode: "{99999999-9999-9999-9999-999999999999}",
          },
        ],
        // アンインストール後も残存している
        arpAfterUninstall: [base.arpBefore[0], base.arpAfterInstall[1]],
        cliProbes: [
          { command: "myapp", args: [], exitCode: 2, timedOut: false },
          { command: "myapp-hang", args: [], exitCode: null, timedOut: true },
          {
            command: "myapp-missing",
            args: [],
            exitCode: null,
            timedOut: false,
            error: "not found",
          },
          { command: "myapp-dll", args: ["--version"], exitCode: -1073741515, timedOut: false },
          { command: "myapp", args: ["--help"], exitCode: 1, timedOut: false },
        ],
      });

      const findings = evaluateSandboxResult(bundle, brokenResult);
      expect(findings.some((f) => f.id === "CMN-SBX-01" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "CMN-SBX-02" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "PKG-INST-01" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "PKG-INST-03" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "PKG-PORT-01" && f.status === "fail")).toBe(true);
      expect(
        findings.some((f) => f.id === "APP-CLI-01" && f.status === "warn" && f.title.includes("2")),
      ).toBe(true);
      expect(
        findings.some(
          (f) => f.id === "APP-CLI-01" && f.status === "warn" && f.title.includes("タイムアウト"),
        ),
      ).toBe(true);
      expect(findings.some((f) => f.id === "APP-CLI-01" && f.status === "fail")).toBe(true);
      expect(findings.some((f) => f.id === "APP-CLI-02" && f.status === "fail")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("install 失敗・ポータブル ARP なし・暗黙 ARP バージョン不一致・uninstall 失敗を正しく判定する", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-sbx-edge-"));
    try {
      // 1. ポータブル + ARP 差分なし + install 失敗
      writeInstallerManifest(tmpDir, { installerType: "portable" });
      const portableBundle = loadManifestBundle(tmpDir);
      const installFailFindings = evaluateSandboxResult(
        portableBundle,
        makeBaseSandboxResult({
          install: { command: "winget install -m ...", exitCode: 1603, logSnippet: "Fatal error" },
          uninstall: undefined,
          arpAfterInstall: [makeBaseSandboxResult().arpBefore[0]],
          cliProbes: [],
        }),
      );
      expect(installFailFindings.some((f) => f.id === "NG-03" && f.status === "fail")).toBe(true);

      const portablePassFindings = evaluateSandboxResult(
        portableBundle,
        makeBaseSandboxResult({
          arpAfterInstall: [makeBaseSandboxResult().arpBefore[0]],
          arpAfterUninstall: [makeBaseSandboxResult().arpBefore[0]],
          cliProbes: [],
        }),
      );
      expect(portablePassFindings.some((f) => f.id === "PKG-INST-01" && f.status === "pass")).toBe(
        true,
      );

      // 2. インストーラー系（AppsAndFeaturesEntries 未宣言）で DisplayVersion 不一致 & DisplayName 差異 & uninstall 失敗
      writeInstallerManifest(tmpDir, {
        installerType: "inno",
        productCode: "{11111111-2222-3333-4444-555555555555}",
      });
      const instBundle = loadManifestBundle(tmpDir);
      const base = makeBaseSandboxResult();
      const implicitFindings = evaluateSandboxResult(
        instBundle,
        makeBaseSandboxResult({
          arpAfterInstall: [
            base.arpBefore[0],
            {
              ...base.arpAfterInstall[1],
              displayName: "MyApp Desktop",
              displayVersion: "9.9.9",
              productCode: "{22222222-2222-3333-4444-555555555555}",
            },
          ],
          uninstall: { command: "winget uninstall", exitCode: 1 },
          cliProbes: [],
        }),
      );
      expect(implicitFindings.some((f) => f.id === "PKG-INST-01" && f.status === "fail")).toBe(
        true,
      );
      expect(implicitFindings.some((f) => f.id === "PKG-INST-01" && f.status === "warn")).toBe(
        true,
      );
      expect(implicitFindings.some((f) => f.id === "PKG-INST-03" && f.status === "fail")).toBe(
        true,
      );

      // 3. インストーラー系で ARP 差分 0 件は warn
      const noArpFindings = evaluateSandboxResult(
        instBundle,
        makeBaseSandboxResult({
          arpAfterInstall: [base.arpBefore[0]],
          uninstall: undefined,
          cliProbes: [],
        }),
      );
      expect(noArpFindings.some((f) => f.id === "PKG-INST-01" && f.status === "warn")).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("CLI (sandbox prepare / eval / check --sandbox-result) と MCP (prepare_sandbox / evaluate_sandbox / verify_manifest) が統合動作する", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-sbx-e2e-"));
    try {
      const manifestDir = join(tmpDir, "manifest");
      const outDir = join(tmpDir, "sandbox-out");
      mkdirSync(manifestDir, { recursive: true });
      writeInstallerManifest(manifestDir, {
        installerType: "inno",
        upgradeBehavior: "uninstallPrevious",
      });

      const resultPath = join(tmpDir, "sandbox-result.json");
      writeFileSync(resultPath, JSON.stringify(makeBaseSandboxResult()), "utf8");

      // gate-runner 統合
      const integrated = await runManifestGate({
        manifestDir,
        sandboxResultPath: resultPath,
        offline: true,
      });
      expect(integrated.passed).toBe(true);
      expect(integrated.findings.some((f) => f.id === "CMN-SBX-01" && f.status === "pass")).toBe(
        true,
      );
      expect(integrated.nextSteps.some((s) => s.includes("SandboxTest.ps1"))).toBe(false);

      const standaloneEval = runSandboxEval({ manifestDir, resultPath });
      expect(standaloneEval.passed).toBe(true);

      // CLI sandbox prepare / eval / check --sandbox-result
      const out: string[] = [];
      const err: string[] = [];
      const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };

      expect(
        await runCli(
          [
            "sandbox",
            "prepare",
            manifestDir,
            "--out",
            outDir,
            "--probe-command",
            "myapp",
            "--vgpu",
          ],
          { io },
        ),
      ).toBe(0);
      expect(out[0]).toContain("[verify-gate] SANDBOX PREPARED");

      expect(
        await runCli(["sandbox", "eval", manifestDir, "--result", resultPath, "--json"], { io }),
      ).toBe(0);
      expect(JSON.parse(out[1] ?? "{}").passed).toBe(true);

      expect(
        await runCli(
          ["check", manifestDir, "--sandbox-result", resultPath, "--offline", "--json"],
          { io },
        ),
      ).toBe(0);
      expect(JSON.parse(out[2] ?? "{}").passed).toBe(true);

      // CLI 引数エラー系は終了コード 2
      expect(await runCli(["sandbox", "unknown"], { io })).toBe(2);
      expect(await runCli(["sandbox", "prepare", manifestDir], { io })).toBe(2);
      expect(await runCli(["sandbox", "eval", manifestDir], { io })).toBe(2);

      // MCP prepare_sandbox / evaluate_sandbox / verify_manifest(sandboxResultPath)
      const prepRes = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "prepare_sandbox",
          arguments: { manifestDir, outDir: join(tmpDir, "mcp-out"), probeCommands: ["myapp"] },
        },
      });
      expect(((prepRes?.result ?? {}) as { isError: boolean }).isError).toBe(false);

      const evalRes = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "evaluate_sandbox",
          arguments: { manifestDir, resultPath },
        },
      });
      const evalPayload = evalRes?.result as {
        isError: boolean;
        structuredContent: { passed: boolean };
      };
      expect(evalPayload.isError).toBe(false);
      expect(evalPayload.structuredContent.passed).toBe(true);

      const manifestWithSbxRes = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "verify_manifest",
          arguments: { manifestDir, sandboxResultPath: resultPath, offline: true },
        },
      });
      expect(
        (
          (manifestWithSbxRes?.result ?? {}) as {
            structuredContent: { passed: boolean };
          }
        ).structuredContent.passed,
      ).toBe(true);

      // MCP 不正パラメータエラー (-32602)
      const badPrep = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "prepare_sandbox", arguments: { manifestDir } },
      });
      expect(badPrep?.error?.code).toBe(-32602);

      const badProbes = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "prepare_sandbox",
          arguments: { manifestDir, outDir, probeCommands: [123] },
        },
      });
      expect(badProbes?.error?.code).toBe(-32602);

      const badEval = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "evaluate_sandbox", arguments: { manifestDir } },
      });
      expect(badEval?.error?.code).toBe(-32602);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
