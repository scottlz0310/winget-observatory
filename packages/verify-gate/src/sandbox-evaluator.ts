import { readFileSync } from "node:fs";
import { extractExpectedArpSpec } from "./sandbox-plan";
import type {
  ArpRegistryEntry,
  CliProbeResult,
  GateFinding,
  ManifestBundle,
  SandboxCommandOutcome,
  SandboxRunResult,
} from "./types";

const STATUS_DLL_NOT_FOUND_SIGNED = -1073741515; // 0xC0000135
const STATUS_DLL_NOT_FOUND_UNSIGNED = 3221225781; // 0xC0000135

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeGuidOrText(value: string): string {
  return value.trim().toLowerCase();
}

function arpIdentityKey(entry: ArpRegistryEntry): string {
  return `${entry.hive}|${entry.view}|${entry.keyName.toLowerCase()}`;
}

function parseArpEntry(raw: unknown, label: string): ArpRegistryEntry {
  const rec = asRecord(raw);
  if (!rec) {
    throw new Error(`${label} はオブジェクトである必要があります`);
  }
  const hive = rec.hive;
  const view = rec.view;
  if (hive !== "HKLM" && hive !== "HKCU") {
    throw new Error(`${label}.hive は HKLM または HKCU である必要があります`);
  }
  if (view !== "64bit" && view !== "32bit") {
    throw new Error(`${label}.view は 64bit または 32bit である必要があります`);
  }
  const keyName = asOptionalString(rec.keyName);
  const registryKeyPath =
    asOptionalString(rec.registryKeyPath) ?? `${hive}\\${view}\\${keyName ?? ""}`;
  if (!keyName) {
    throw new Error(`${label}.keyName は非空文字列である必要があります`);
  }
  return {
    registryKeyPath,
    hive,
    view,
    keyName,
    displayName: asOptionalString(rec.displayName),
    publisher: asOptionalString(rec.publisher),
    displayVersion: asOptionalString(rec.displayVersion),
    uninstallString: asOptionalString(rec.uninstallString),
    quietUninstallString: asOptionalString(rec.quietUninstallString),
    productCode: asOptionalString(rec.productCode),
    upgradeCode: asOptionalString(rec.upgradeCode),
  };
}

function parseCommandOutcome(raw: unknown, label: string): SandboxCommandOutcome {
  const rec = asRecord(raw);
  if (!rec) {
    throw new Error(`${label} はオブジェクトである必要があります`);
  }
  const command = asOptionalString(rec.command);
  if (!command) {
    throw new Error(`${label}.command は非空文字列である必要があります`);
  }
  if (typeof rec.exitCode !== "number" || !Number.isInteger(rec.exitCode)) {
    throw new Error(`${label}.exitCode は整数である必要があります`);
  }
  return {
    command,
    exitCode: rec.exitCode,
    logSnippet: typeof rec.logSnippet === "string" ? rec.logSnippet : undefined,
  };
}

function parseCliProbe(raw: unknown, label: string): CliProbeResult {
  const rec = asRecord(raw);
  if (!rec) {
    throw new Error(`${label} はオブジェクトである必要があります`);
  }
  const command = asOptionalString(rec.command);
  if (!command) {
    throw new Error(`${label}.command は非空文字列である必要があります`);
  }
  if (!Array.isArray(rec.args) || !rec.args.every((a) => typeof a === "string")) {
    throw new Error(`${label}.args は文字列配列である必要があります`);
  }
  if (
    rec.exitCode !== null &&
    (typeof rec.exitCode !== "number" || !Number.isInteger(rec.exitCode))
  ) {
    throw new Error(`${label}.exitCode は整数または null である必要があります`);
  }
  if (typeof rec.timedOut !== "boolean") {
    throw new Error(`${label}.timedOut は boolean である必要があります`);
  }
  if (rec.required !== undefined && typeof rec.required !== "boolean") {
    throw new Error(`${label}.required は boolean である必要があります`);
  }
  return {
    command,
    args: rec.args as string[],
    exitCode: rec.exitCode as number | null,
    timedOut: rec.timedOut,
    required: rec.required as boolean | undefined,
    stdoutSnippet: typeof rec.stdoutSnippet === "string" ? rec.stdoutSnippet : undefined,
    stderrSnippet: typeof rec.stderrSnippet === "string" ? rec.stderrSnippet : undefined,
    error: asOptionalString(rec.error),
  };
}

export function parseSandboxRunResult(rawText: string): SandboxRunResult {
  const cleaned = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Sandbox 結果 JSON の解析に失敗しました: ${message}`);
  }
  const rec = asRecord(parsed);
  if (!rec) {
    throw new Error("Sandbox 結果 JSON のトップレベルはオブジェクトである必要があります");
  }
  if (rec.schemaVersion !== 1) {
    throw new Error(`未対応の Sandbox 結果 schemaVersion です: ${String(rec.schemaVersion)}`);
  }
  if (typeof rec.localManifestFilesEnabled !== "boolean") {
    throw new Error("localManifestFilesEnabled は boolean である必要があります");
  }
  const executedAt = asOptionalString(rec.executedAt);
  if (!executedAt) {
    throw new Error("executedAt は非空文字列である必要があります");
  }
  let installedArchitecture: SandboxRunResult["installedArchitecture"];
  if (rec.installedArchitecture !== undefined && rec.installedArchitecture !== null) {
    const archRaw = asOptionalString(rec.installedArchitecture)?.toLowerCase();
    if (archRaw !== "x64" && archRaw !== "x86" && archRaw !== "arm64") {
      throw new Error(
        `installedArchitecture は x64 / x86 / arm64 のいずれかである必要があります: ${String(rec.installedArchitecture)}`,
      );
    }
    installedArchitecture = archRaw;
  }
  if (!Array.isArray(rec.arpBefore)) {
    throw new Error("arpBefore は配列である必要があります");
  }
  if (!Array.isArray(rec.arpAfterInstall)) {
    throw new Error("arpAfterInstall は配列である必要があります");
  }

  const install = parseCommandOutcome(rec.install, "install");
  const uninstall =
    rec.uninstall !== undefined && rec.uninstall !== null
      ? parseCommandOutcome(rec.uninstall, "uninstall")
      : undefined;
  const arpBefore = rec.arpBefore.map((item, i) => parseArpEntry(item, `arpBefore[${i}]`));
  const arpAfterInstall = rec.arpAfterInstall.map((item, i) =>
    parseArpEntry(item, `arpAfterInstall[${i}]`),
  );

  let arpAfterUninstall: ArpRegistryEntry[] | undefined;
  if (rec.arpAfterUninstall !== undefined && rec.arpAfterUninstall !== null) {
    if (!Array.isArray(rec.arpAfterUninstall)) {
      throw new Error("arpAfterUninstall は配列である必要があります");
    }
    arpAfterUninstall = rec.arpAfterUninstall.map((item, i) =>
      parseArpEntry(item, `arpAfterUninstall[${i}]`),
    );
  }

  let cliProbes: CliProbeResult[] | undefined;
  if (rec.cliProbes !== undefined && rec.cliProbes !== null) {
    if (!Array.isArray(rec.cliProbes)) {
      throw new Error("cliProbes は配列である必要があります");
    }
    cliProbes = rec.cliProbes.map((item, i) => parseCliProbe(item, `cliProbes[${i}]`));
  }

  return {
    schemaVersion: 1,
    packageIdentifier: asOptionalString(rec.packageIdentifier),
    packageVersion: asOptionalString(rec.packageVersion),
    installedArchitecture,
    executedAt,
    localManifestFilesEnabled: rec.localManifestFilesEnabled,
    install,
    uninstall,
    arpBefore,
    arpAfterInstall,
    arpAfterUninstall,
    cliProbes,
  };
}

export function loadSandboxRunResultFile(filePath: string): SandboxRunResult {
  const raw = readFileSync(filePath, "utf8");
  return parseSandboxRunResult(raw);
}

export interface ArpDiffResult {
  added: ArpRegistryEntry[];
  updated: ArpRegistryEntry[];
}

export function diffArpSnapshots(
  before: readonly ArpRegistryEntry[],
  after: readonly ArpRegistryEntry[],
): ArpDiffResult {
  const beforeMap = new Map<string, ArpRegistryEntry>();
  for (const entry of before) {
    beforeMap.set(arpIdentityKey(entry), entry);
  }
  const added: ArpRegistryEntry[] = [];
  const updated: ArpRegistryEntry[] = [];
  for (const entry of after) {
    const key = arpIdentityKey(entry);
    const prev = beforeMap.get(key);
    if (!prev) {
      added.push(entry);
    } else if (
      prev.displayName !== entry.displayName ||
      prev.displayVersion !== entry.displayVersion ||
      prev.publisher !== entry.publisher ||
      prev.productCode !== entry.productCode ||
      prev.upgradeCode !== entry.upgradeCode
    ) {
      updated.push(entry);
    }
  }
  return { added, updated };
}

function isStatusDllNotFound(exitCode: number | null): boolean {
  return exitCode === STATUS_DLL_NOT_FOUND_SIGNED || exitCode === STATUS_DLL_NOT_FOUND_UNSIGNED;
}

function scoreArpCandidate(
  entry: ArpRegistryEntry,
  expected: {
    displayName: string | null;
    publisher: string | null;
    productCode: string | null;
    upgradeCode?: string | null;
  },
): number {
  let score = 0;
  if (
    expected.productCode &&
    entry.productCode &&
    normalizeGuidOrText(entry.productCode) === normalizeGuidOrText(expected.productCode)
  ) {
    score += 100;
  }
  if (
    expected.upgradeCode &&
    entry.upgradeCode &&
    normalizeGuidOrText(entry.upgradeCode) === normalizeGuidOrText(expected.upgradeCode)
  ) {
    score += 80;
  }
  if (expected.displayName && entry.displayName) {
    const expLower = expected.displayName.toLowerCase();
    const actLower = entry.displayName.toLowerCase();
    if (actLower === expLower) score += 50;
    else if (actLower.includes(expLower) || expLower.includes(actLower)) score += 20;
  }
  if (expected.publisher && entry.publisher) {
    const expPub = expected.publisher.toLowerCase();
    const actPub = entry.publisher.toLowerCase();
    if (actPub === expPub) score += 30;
    else if (actPub.includes(expPub) || expPub.includes(actPub)) score += 10;
  }
  return score;
}

function selectPrimaryArpEntry(
  entries: readonly ArpRegistryEntry[],
  expected: {
    displayName: string | null;
    publisher: string | null;
    productCode: string | null;
    upgradeCode?: string | null;
  },
): ArpRegistryEntry {
  let best = entries[0];
  let bestScore = scoreArpCandidate(best, expected);
  for (let i = 1; i < entries.length; i++) {
    const score = scoreArpCandidate(entries[i], expected);
    if (score > bestScore) {
      best = entries[i];
      bestScore = score;
    }
  }
  return best;
}

/**
 * Windows Sandbox 実測結果（対象識別子/バージョン・LocalManifestFiles・インストール/アンインストール・
 * 選択アーキテクチャの ARP 差分・CLI 実測）をマニフェスト期待値と突き合わせ、GateFinding 一覧へ変換する。
 */
export function evaluateSandboxResult(
  bundle: ManifestBundle,
  result: SandboxRunResult,
  sourceFile?: string,
): GateFinding[] {
  const findings: GateFinding[] = [];
  const versionHost = bundle.versionFile ?? bundle.installerFile ?? bundle.singletonFile;
  const manifestPkgId =
    versionHost && typeof versionHost.data.PackageIdentifier === "string"
      ? versionHost.data.PackageIdentifier.trim()
      : null;
  const manifestPkgVer =
    versionHost && typeof versionHost.data.PackageVersion === "string"
      ? versionHost.data.PackageVersion.trim()
      : null;

  // 0. 対象 PackageIdentifier / PackageVersion の厳密照合 (CMN-SBX-02)
  let identityIssues = 0;
  if (manifestPkgId) {
    if (!result.packageIdentifier) {
      identityIssues++;
      findings.push({
        id: "CMN-SBX-02",
        status: "fail",
        title: "Sandbox 結果に PackageIdentifier が記録されていない",
        detail: `manifest="${manifestPkgId}" に対し sandbox-result.packageIdentifier が未設定のため対象パッケージを照合できません。`,
        remediation:
          "verify-gate sandbox prepare で生成したスクリプトを用いて対象マニフェストを再計測してください。",
        file: sourceFile,
        guideRef: "7.1",
      });
    } else if (result.packageIdentifier.toLowerCase() !== manifestPkgId.toLowerCase()) {
      identityIssues++;
      findings.push({
        id: "CMN-SBX-02",
        status: "fail",
        title: "Sandbox 結果の PackageIdentifier が対象マニフェストと不一致",
        detail: `sandbox-result="${result.packageIdentifier}" vs manifest="${manifestPkgId}"`,
        remediation:
          "対象マニフェストに対応する sandbox-result.json を指定して再実行してください。",
        file: sourceFile,
        guideRef: "7.1",
      });
    }
  }

  if (manifestPkgVer) {
    if (!result.packageVersion) {
      identityIssues++;
      findings.push({
        id: "CMN-SBX-02",
        status: "fail",
        title: "Sandbox 結果に PackageVersion が記録されていない",
        detail: `manifest="${manifestPkgVer}" に対し sandbox-result.packageVersion が未設定のため旧版結果との取り違えを防げません。`,
        remediation:
          "packageVersion を記録した最新マニフェストの sandbox-result.json を取得して再評価してください。",
        file: sourceFile,
        guideRef: "7.1",
      });
    } else if (result.packageVersion !== manifestPkgVer) {
      identityIssues++;
      findings.push({
        id: "CMN-SBX-02",
        status: "fail",
        title: "Sandbox 結果の PackageVersion が対象マニフェストと不一致",
        detail: `sandbox-result="${result.packageVersion}" vs manifest="${manifestPkgVer}"（旧版または別版の実測結果です）`,
        remediation: `対象バージョン ${manifestPkgVer} のマニフェストで Sandbox 検証を再実行してください。`,
        file: sourceFile,
        guideRef: "7.1",
      });
    }
  }

  // アーキテクチャ別の ARP 期待値解決（選択アーキテクチャのみ対象）
  const unfilteredSpec = extractExpectedArpSpec(bundle);
  const needsArchDisambiguation =
    unfilteredSpec.hasArchitectureSpecificArpVariants && !result.installedArchitecture;
  if (needsArchDisambiguation) {
    identityIssues++;
    findings.push({
      id: "CMN-SBX-02",
      status: "fail",
      title: "複数アーキテクチャで異なる ARP 宣言があるが installedArchitecture が未記録",
      detail: `マニフェストに複数アーキテクチャ [${unfilteredSpec.availableArchitectures.join(", ")}] の異なる ProductCode / AppsAndFeaturesEntries 宣言があるため、実測対象アーキテクチャの記録が必須です。`,
      remediation:
        "sandbox-result.json に installedArchitecture（x64 / x86 / arm64）を記録する最新 verify-inside-sandbox.ps1 で再計測してください。",
      file: sourceFile,
      guideRef: "PKG-INST-01",
    });
  }

  if (
    result.installedArchitecture &&
    unfilteredSpec.availableArchitectures.length > 0 &&
    !unfilteredSpec.availableArchitectures.includes(result.installedArchitecture) &&
    !unfilteredSpec.availableArchitectures.includes("neutral")
  ) {
    identityIssues++;
    findings.push({
      id: "CMN-SBX-02",
      status: "fail",
      title: "Sandbox 結果の installedArchitecture がマニフェスト定義に存在しない",
      detail: `installedArchitecture="${result.installedArchitecture}" はマニフェスト定義 [${unfilteredSpec.availableArchitectures.join(", ")}] に含まれていません。`,
      remediation: "マニフェストが対象とするアーキテクチャの Sandbox 環境で検証してください。",
      file: sourceFile,
      guideRef: "PKG-INST-01",
    });
  }

  if (identityIssues === 0 && (manifestPkgId || manifestPkgVer)) {
    findings.push({
      id: "CMN-SBX-02",
      status: "pass",
      title: "Sandbox 結果のパッケージ識別子・バージョンが対象マニフェストと一致",
      detail: `${manifestPkgId ?? "(unknown)"}@${manifestPkgVer ?? "(unknown)"}${result.installedArchitecture ? ` (${result.installedArchitecture})` : ""}`,
      file: sourceFile,
      guideRef: "7.1",
    });
  }

  const expected = extractExpectedArpSpec(bundle, result.installedArchitecture);

  // 1. LocalManifestFiles 有効化確認
  if (!result.localManifestFilesEnabled) {
    findings.push({
      id: "CMN-SBX-01",
      status: "fail",
      title: "Sandbox で LocalManifestFiles が有効化されていない",
      detail:
        "winget settings --enable LocalManifestFiles が失敗または未実行のため、ローカルマニフェスト検証が完了していません。",
      remediation:
        "管理者権限 PowerShell で winget settings --enable LocalManifestFiles を実行するか、verify-gate sandbox prepare で生成した .wsb を実行してください。",
      file: sourceFile,
      guideRef: "7.1",
    });
  } else {
    findings.push({
      id: "CMN-SBX-01",
      status: "pass",
      title: "Sandbox で LocalManifestFiles 有効化を確認",
      detail: `LocalManifestFiles=enabled (executedAt=${result.executedAt})`,
      file: sourceFile,
      guideRef: "7.1",
    });
  }

  // 2. winget install -m 実行結果 (NG-03 / PKG-INST-04)
  if (result.install.exitCode !== 0) {
    findings.push({
      id: "NG-03",
      status: "fail",
      title: "クリーン Sandbox での winget install -m が失敗",
      detail: `exitCode=${result.install.exitCode} (${result.install.command})${result.install.logSnippet ? ` / ${result.install.logSnippet.slice(0, 200)}` : ""}`,
      remediation:
        "サイレント引数（InstallerSwitches.Silent）・ハードウェア依存・インストーラー前提条件を確認し、クリーン環境で exitCode=0 になるまで修正してください。",
      file: sourceFile,
      guideRef: "NG-03",
    });
  } else {
    findings.push({
      id: "NG-03",
      status: "pass",
      title: "クリーン Sandbox での winget install -m が成功",
      detail: `exitCode=0 (${result.install.command})`,
      file: sourceFile,
      guideRef: "NG-03",
    });
  }

  // 3. ARP レジストリ差分とマニフェスト突き合わせ (PKG-INST-01)
  const arpDiff = diffArpSnapshots(result.arpBefore, result.arpAfterInstall);
  const changedEntries = [...arpDiff.added, ...arpDiff.updated];
  const matchedAppArpEntries: ArpRegistryEntry[] = [];
  const matchedAppArpKeys = new Set<string>();
  const recordMatchedAppArp = (entry: ArpRegistryEntry): void => {
    const k = arpIdentityKey(entry);
    if (!matchedAppArpKeys.has(k)) {
      matchedAppArpKeys.add(k);
      matchedAppArpEntries.push(entry);
    }
  };

  if (result.install.exitCode === 0 && !needsArchDisambiguation) {
    if (changedEntries.length === 0) {
      if (expected.hasInstallerBasedEntry) {
        findings.push({
          id: "PKG-INST-01",
          status: "warn",
          title: "インストーラー系パッケージだが新規 ARP レジストリエントリが検出されない",
          detail:
            "HKLM/HKCU の Uninstall キー（64bit/32bit）にインストール前後の差分がありませんでした。",
          remediation:
            "インストーラーが ARP 登録を行うか確認し、MSIX/ポータブル等の場合は InstallerType と AppsAndFeaturesEntries の定義を見直してください。",
          file: sourceFile,
          guideRef: "PKG-INST-01",
        });
      } else {
        findings.push({
          id: "PKG-INST-01",
          status: "pass",
          title: "ポータブル形式のため ARP 差分なし（正常）",
          detail: "InstallerType: portable のため ARP 突き合わせは不要です。",
          file: sourceFile,
          guideRef: "PKG-INST-01",
        });
      }
    } else {
      let arpMismatchCount = 0;

      // 明示 AppsAndFeaturesEntries が宣言されている場合は選択アーキテクチャの宣言のみを検証
      if (expected.explicitEntries.length > 0) {
        for (const [idx, exp] of expected.explicitEntries.entries()) {
          const target = selectPrimaryArpEntry(changedEntries, {
            displayName: exp.displayName ?? expected.displayName,
            publisher: exp.publisher ?? expected.publisher,
            productCode: exp.productCode ?? expected.productCode,
            upgradeCode: exp.upgradeCode,
          });
          recordMatchedAppArp(target);
          const mismatches: string[] = [];

          if (exp.displayName && target.displayName !== exp.displayName) {
            mismatches.push(
              `DisplayName(manifest="${exp.displayName}" vs arp="${target.displayName ?? ""}")`,
            );
          }
          if (exp.publisher && target.publisher !== exp.publisher) {
            mismatches.push(
              `Publisher(manifest="${exp.publisher}" vs arp="${target.publisher ?? ""}")`,
            );
          }
          if (exp.displayVersion && target.displayVersion !== exp.displayVersion) {
            mismatches.push(
              `DisplayVersion(manifest="${exp.displayVersion}" vs arp="${target.displayVersion ?? ""}")`,
            );
          }
          if (
            exp.productCode &&
            (!target.productCode ||
              normalizeGuidOrText(target.productCode) !== normalizeGuidOrText(exp.productCode))
          ) {
            mismatches.push(
              `ProductCode(manifest="${exp.productCode}" vs arp="${target.productCode ?? ""}")`,
            );
          }
          if (
            exp.upgradeCode &&
            (!target.upgradeCode ||
              normalizeGuidOrText(target.upgradeCode) !== normalizeGuidOrText(exp.upgradeCode))
          ) {
            mismatches.push(
              `UpgradeCode(manifest="${exp.upgradeCode}" vs arp="${target.upgradeCode ?? ""}")`,
            );
          }

          if (mismatches.length > 0) {
            arpMismatchCount++;
            findings.push({
              id: "PKG-INST-01",
              status: "fail",
              title: `AppsAndFeaturesEntries[${idx}] と実測 ARP 値が不一致`,
              detail: `実測キー=${target.hive}\\${target.view}\\${target.keyName}: ${mismatches.join(", ")}`,
              remediation:
                ".installer.yaml の AppsAndFeaturesEntries を Sandbox 実測 ARP 値へ一致させ、PR 本文テンプレートへ実測値を転記してください。",
              file: sourceFile,
              guideRef: "PKG-INST-01",
            });
          }
        }
      } else {
        // AppsAndFeaturesEntries 未宣言時は最も関連度の高い代表 ARP エントリを選択して突き合わせ
        // （依存パッケージ VCRedist 等が同時インストールされても誤爆しないようにする）
        const primary = selectPrimaryArpEntry(changedEntries, expected);
        recordMatchedAppArp(primary);
        if (
          expected.displayVersion &&
          primary.displayVersion &&
          primary.displayVersion !== expected.displayVersion
        ) {
          arpMismatchCount++;
          findings.push({
            id: "PKG-INST-01",
            status: "fail",
            title: "ARP の DisplayVersion が PackageVersion と不一致",
            detail: `manifest PackageVersion="${expected.displayVersion}" vs ARP DisplayVersion="${primary.displayVersion}" (${primary.hive}\\${primary.view}\\${primary.keyName})`,
            remediation:
              ".installer.yaml に AppsAndFeaturesEntries[].DisplayVersion を実測値で明示するか、インストーラー側のバージョン表記を PackageVersion と一致させてください。",
            file: sourceFile,
            guideRef: "PKG-INST-01",
          });
        }
        if (
          expected.productCode &&
          (!primary.productCode ||
            normalizeGuidOrText(primary.productCode) !== normalizeGuidOrText(expected.productCode))
        ) {
          arpMismatchCount++;
          findings.push({
            id: "PKG-INST-01",
            status: "fail",
            title: "ARP の ProductCode がマニフェスト宣言と不一致",
            detail: `manifest ProductCode="${expected.productCode}" vs ARP ProductCode="${primary.productCode ?? ""}"`,
            remediation: ".installer.yaml の ProductCode を実測 ARP 値へ修正してください。",
            file: sourceFile,
            guideRef: "PKG-INST-01",
          });
        }
        const softDiffs: string[] = [];
        if (
          expected.displayName &&
          primary.displayName &&
          primary.displayName !== expected.displayName
        ) {
          softDiffs.push(`DisplayName("${expected.displayName}" vs "${primary.displayName}")`);
        }
        if (expected.publisher && primary.publisher && primary.publisher !== expected.publisher) {
          softDiffs.push(`Publisher("${expected.publisher}" vs "${primary.publisher}")`);
        }
        if (softDiffs.length > 0) {
          findings.push({
            id: "PKG-INST-01",
            status: "warn",
            title: "ARP の DisplayName / Publisher がマニフェスト表記と異なる",
            detail: `${softDiffs.join(", ")}。AppsAndFeaturesEntries 未宣言のため winget list 照合に失敗する可能性があります。`,
            remediation:
              ".installer.yaml に AppsAndFeaturesEntries（DisplayName / Publisher / DisplayVersion）を明示してください。",
            file: sourceFile,
            guideRef: "PKG-INST-01",
          });
        }
      }

      if (arpMismatchCount === 0) {
        const summaryText = matchedAppArpEntries
          .map(
            (e) =>
              `${e.displayName ?? e.keyName} (${e.displayVersion ?? "no-ver"}, ${e.publisher ?? "no-pub"})`,
          )
          .join("; ");
        findings.push({
          id: "PKG-INST-01",
          status: "pass",
          title: "実測 ARP レジストリ値とマニフェストが整合",
          detail: `照合対象 ARP (${matchedAppArpEntries.length} 件 / 全差分 ${changedEntries.length} 件): ${summaryText}`,
          file: sourceFile,
          guideRef: "PKG-INST-01",
        });
      }
    }
  }

  // 4. アンインストール・ARP 残骸確認 (PKG-INST-03)
  // 同時導入された依存パッケージ（VCRedist 等）を残骸と誤認しないよう、対象アプリに紐付いた新規追加 ARP のみを検査する
  if (result.uninstall) {
    if (result.uninstall.exitCode !== 0) {
      findings.push({
        id: "PKG-INST-03",
        status: "fail",
        title: "Sandbox での winget uninstall が失敗",
        detail: `exitCode=${result.uninstall.exitCode} (${result.uninstall.command})`,
        remediation:
          "アンインストーラーのサイレント引数（QuietUninstallString）および ProductCode / AppsAndFeaturesEntries の紐付けを確認してください。",
        file: sourceFile,
        guideRef: "PKG-INST-03",
      });
    } else if (result.arpAfterUninstall) {
      const addedKeys = new Set(arpDiff.added.map(arpIdentityKey));
      const appAddedEntries =
        matchedAppArpEntries.length > 0
          ? matchedAppArpEntries.filter((entry) => addedKeys.has(arpIdentityKey(entry)))
          : arpDiff.added.filter((entry) => scoreArpCandidate(entry, expected) > 0);
      const afterUninstallKeys = new Set(result.arpAfterUninstall.map(arpIdentityKey));
      const leftover = appAddedEntries.filter((entry) =>
        afterUninstallKeys.has(arpIdentityKey(entry)),
      );
      const dependencyRemainedCount = arpDiff.added.filter(
        (entry) =>
          !appAddedEntries.some((a) => arpIdentityKey(a) === arpIdentityKey(entry)) &&
          afterUninstallKeys.has(arpIdentityKey(entry)),
      ).length;

      if (leftover.length > 0) {
        findings.push({
          id: "PKG-INST-03",
          status: "fail",
          title: "winget uninstall 後も対象アプリの ARP レジストリに残骸が残存",
          detail: `残存エントリ (${leftover.length} 件): ${leftover.map((e) => `${e.hive}\\${e.view}\\${e.keyName}`).join(", ")}`,
          remediation:
            "アンインストール時に Uninstall キーが確実に削除されるようインストーラーまたは UpgradeBehavior / QuietUninstallString を修正してください。",
          file: sourceFile,
          guideRef: "PKG-INST-03",
        });
      } else {
        const depNote =
          dependencyRemainedCount > 0
            ? `（同時導入された依存パッケージ ARP ${dependencyRemainedCount} 件は対象外として除外）`
            : "";
        findings.push({
          id: "PKG-INST-03",
          status: "pass",
          title: "winget uninstall が成功し対象アプリの ARP 残骸なし",
          detail: `exitCode=0 (${result.uninstall.command})、対象アプリ ARP ${appAddedEntries.length} 件すべて除去済み${depNote}。`,
          file: sourceFile,
          guideRef: "PKG-INST-03",
        });
      }
    } else {
      findings.push({
        id: "PKG-INST-03",
        status: "pass",
        title: "winget uninstall が成功",
        detail: `exitCode=0 (${result.uninstall.command})`,
        file: sourceFile,
        guideRef: "PKG-INST-03",
      });
    }
  }

  // 5. CLI 引数なし終了コード & 推奨検証コマンド実測 (APP-CLI-01, APP-CLI-02, PKG-PORT-01)
  if (result.cliProbes && result.cliProbes.length > 0) {
    let noArgChecked = 0;
    const requiredArgProbes: CliProbeResult[] = [];
    const optionalArgProbesByCommand = new Map<string, CliProbeResult[]>();

    for (const probe of result.cliProbes) {
      const invocation =
        probe.args.length > 0 ? `${probe.command} ${probe.args.join(" ")}` : probe.command;

      if (isStatusDllNotFound(probe.exitCode)) {
        findings.push({
          id: "PKG-PORT-01",
          status: "fail",
          title: `CLI 実測で STATUS_DLL_NOT_FOUND (0xC0000135) が発生: ${invocation}`,
          detail: `exitCode=${probe.exitCode}。クリーン VM でランタイム DLL（VCRUNTIME140.dll 等）が欠損しています。`,
          remediation:
            "CRT を静的リンク（+crt-static / /MT）するか、.installer.yaml の Dependencies.PackageDependencies に適切な Microsoft.VCRedist を追加してください。",
          file: sourceFile,
          guideRef: "PKG-PORT-01",
        });
        continue;
      }

      if (probe.args.length === 0 && !probe.required) {
        noArgChecked++;
        if (probe.error && !probe.timedOut) {
          findings.push({
            id: "APP-CLI-01",
            status: "fail",
            title: `CLI コマンドを起動できない: ${probe.command}`,
            detail: probe.error,
            remediation:
              "Commands / PortableCommandAlias の指定と PATH 登録（portable シム生成）を確認してください。",
            file: sourceFile,
            guideRef: "APP-CLI-01",
          });
        } else if (probe.timedOut) {
          findings.push({
            id: "APP-CLI-01",
            status: "warn",
            title: `引数なし CLI 起動がタイムアウト（対話待機/ハングの可能性）: ${probe.command}`,
            detail: "メンテナが引数なしで動作確認した際に応答停止と誤認されやすい挙動です。",
            remediation:
              "先回り PR 本文テンプレートの Verification Command に `--version` / `--help` 等の非対話検証コマンドを明記してください。",
            file: sourceFile,
            guideRef: "APP-CLI-01",
          });
        } else if (probe.exitCode === 0) {
          findings.push({
            id: "APP-CLI-01",
            status: "pass",
            title: `引数なし CLI 起動が終了コード 0 で完了: ${probe.command}`,
            detail: "exitCode=0",
            file: sourceFile,
            guideRef: "APP-CLI-01",
          });
        } else {
          findings.push({
            id: "APP-CLI-01",
            status: "warn",
            title: `引数なし CLI 起動が非 0 終了コード (${probe.exitCode}) を返却: ${probe.command}`,
            detail: `exitCode=${probe.exitCode}（clap/cobra 等で頻出の挙動）。メンテナ検証でエラー扱いされ差し戻される要因になります。`,
            remediation: `先回り PR 本文テンプレートの CLI Behavior 欄に「引数なし実行の exit code ${probe.exitCode} は正常仕様である旨」と推奨検証コマンド（--version / --help）を明記してください。`,
            file: sourceFile,
            guideRef: "APP-CLI-01",
          });
        }
      } else if (probe.required) {
        requiredArgProbes.push(probe);
      } else {
        const list = optionalArgProbesByCommand.get(probe.command) ?? [];
        list.push(probe);
        optionalArgProbesByCommand.set(probe.command, list);
      }
    }

    let verifiedPassCount = 0;
    let verifiedFailCount = 0;
    const passedInvocations: string[] = [];

    // 利用者が明示指定した検証コマンド（required: true）は全件成功を必須とする
    for (const probe of requiredArgProbes) {
      const invocation =
        probe.args.length > 0 ? `${probe.command} ${probe.args.join(" ")}` : probe.command;
      if (probe.timedOut || probe.exitCode !== 0) {
        verifiedFailCount++;
        findings.push({
          id: "APP-CLI-02",
          status: "fail",
          title: `指定された CLI 検証コマンドが失敗: ${invocation}`,
          detail: probe.timedOut
            ? "実行がタイムアウトしました。"
            : `exitCode=${probe.exitCode ?? "null"}${probe.error ? ` (${probe.error})` : ""}`,
          remediation:
            "指定した検証コマンドがクリーン Sandbox 上で exitCode=0 を返すことを確認し、必要に応じてマニフェストまたはバイナリを修正してください。",
          file: sourceFile,
          guideRef: "APP-CLI-02",
        });
      } else {
        verifiedPassCount++;
        passedInvocations.push(invocation);
      }
    }

    // 自動探索プローブ（--version / --help 等）は、コマンドごとに 1 件以上成功すれば合格
    // （--version のみ対応 / --help のみ対応の CLI を誤って fail にしない）
    for (const [cmd, probes] of optionalArgProbesByCommand.entries()) {
      const succeeded = probes.filter((p) => !p.timedOut && p.exitCode === 0);
      if (succeeded.length > 0) {
        verifiedPassCount += succeeded.length;
        for (const s of succeeded) {
          passedInvocations.push(`${s.command} ${s.args.join(" ")}`);
        }
      } else {
        verifiedFailCount++;
        const summary = probes
          .map(
            (p) =>
              `${p.command} ${p.args.join(" ")}=${p.timedOut ? "timeout" : String(p.exitCode ?? "null")}`,
          )
          .join(", ");
        findings.push({
          id: "APP-CLI-02",
          status: "fail",
          title: `CLI 検証コマンドがいずれも失敗: ${cmd}`,
          detail: `試行した非対話コマンドすべてが非 0 またはタイムアウトでした: ${summary}`,
          remediation:
            "クリーン Sandbox 上で exitCode=0 を返す非対話検証コマンドを確認し、独自コマンドを使う場合は --verify-command（verifyCommands）で明示してください。",
          file: sourceFile,
          guideRef: "APP-CLI-02",
        });
      }
    }

    if (verifiedPassCount > 0 && verifiedFailCount === 0) {
      findings.push({
        id: "APP-CLI-02",
        status: "pass",
        title: "CLI 検証コマンドが exitCode=0 で成功",
        detail: `成功: [${passedInvocations.join(", ")}]（引数なし計測 ${noArgChecked} 件）。`,
        file: sourceFile,
        guideRef: "APP-CLI-02",
      });
    }
  }

  return findings;
}
