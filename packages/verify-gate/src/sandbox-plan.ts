import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  getInstallerEntries,
  getInstallerHostFile,
  getLocaleHostFile,
  resolveEffectiveInstallerType,
} from "./manifest-rules";
import type { ManifestBundle, SandboxPrepareResult } from "./types";

const SANDBOX_MANIFEST_DIR = "C:\\Users\\WDAGUtilityAccount\\Desktop\\manifest";
const SANDBOX_OUTPUT_DIR = "C:\\Users\\WDAGUtilityAccount\\Desktop\\verify-gate-out";
const UTF8_BOM = "\uFEFF";

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertSafePath(label: string, value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`${label} に制御文字または改行を含めることはできません`);
  }
  return value;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function toPsSingleQuotedLiteral(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

export interface ExplicitArpEntrySpec {
  displayName: string | null;
  publisher: string | null;
  displayVersion: string | null;
  productCode: string | null;
  upgradeCode: string | null;
}

export interface ExpectedArpSpec {
  displayName: string | null;
  publisher: string | null;
  displayVersion: string | null;
  productCode: string | null;
  upgradeCode: string | null;
  explicitEntries: ExplicitArpEntrySpec[];
  hasInstallerBasedEntry: boolean;
  availableArchitectures: string[];
  resolvedInstallerArchitecture: string | null;
  hasArchitectureSpecificArpVariants: boolean;
  selectionStatus: "resolved" | "ambiguous" | "incompatible" | "unmatched_selected_installer";
  selectionReason?: string;
}

export interface InstallerSelectionContext {
  installedArchitecture?: string;
  osVersion?: string;
  selectedInstallerUrl?: string;
  selectedInstallerSha256?: string;
}

const INSTALLER_BASED_TYPES = new Set(["inno", "nullsoft", "wix", "msi", "exe", "burn", "msix"]);

const WINGET_ARCH_PREFERENCE: Record<string, readonly string[]> = {
  x64: ["x64", "x86", "neutral"],
  arm64: ["arm64", "x64", "x86", "neutral"],
  x86: ["x86", "neutral"],
  neutral: ["neutral"],
};

function compareDottedVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const URL_PARTS_REGEX = /^(https?):\/\/([^/?#]*)(.*)$/i;

/**
 * RFC 3986 §6.2.2.1 に従い URL を比較する。
 * scheme と host は大文字・小文字を区別せず、userinfo・path・query・fragment は厳密に区別する。
 */
export function urlsMatchRfc3986(a: string, b: string): boolean {
  if (a === b) return true;
  const ma = URL_PARTS_REGEX.exec(a);
  const mb = URL_PARTS_REGEX.exec(b);
  if (!ma || !mb) return false;
  if (ma[1].toLowerCase() !== mb[1].toLowerCase()) return false;
  if (ma[3] !== mb[3]) return false;
  const authA = ma[2];
  const authB = mb[2];
  const atA = authA.lastIndexOf("@");
  const atB = authB.lastIndexOf("@");
  const userA = atA >= 0 ? authA.slice(0, atA) : "";
  const userB = atB >= 0 ? authB.slice(0, atB) : "";
  const hostA = atA >= 0 ? authA.slice(atA + 1) : authA;
  const hostB = atB >= 0 ? authB.slice(atB + 1) : authB;
  return userA === userB && hostA.toLowerCase() === hostB.toLowerCase();
}

/**
 * WinGet のアーキテクチャ適用優先順（GetApplicableArchitectures 相当、WOW64 含む）に従い、
 * 指定 OS アーキテクチャで選択される最優先のインストーラーアーキテクチャを返す。
 */
export function resolveSelectedInstallerArchitecture(
  availableArchitectures: readonly string[],
  osArchitecture: string,
): string | null {
  const normalizedAvailable = new Set(availableArchitectures.map((a) => a.toLowerCase()));
  const preference = WINGET_ARCH_PREFERENCE[osArchitecture.toLowerCase()];
  if (!preference) return null;
  for (const candidate of preference) {
    if (normalizedAvailable.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function parseAppsAndFeaturesEntries(container: Record<string, unknown>): ExplicitArpEntrySpec[] {
  if (!Array.isArray(container.AppsAndFeaturesEntries)) return [];
  const entries: ExplicitArpEntrySpec[] = [];
  for (const raw of container.AppsAndFeaturesEntries) {
    const rec = asRecord(raw);
    if (!rec) continue;
    entries.push({
      displayName: asNonEmptyString(rec.DisplayName),
      publisher: asNonEmptyString(rec.Publisher),
      displayVersion: asNonEmptyString(rec.DisplayVersion),
      productCode: asNonEmptyString(rec.ProductCode),
      upgradeCode: asNonEmptyString(rec.UpgradeCode),
    });
  }
  return entries;
}

function serializeArpVariantKey(
  productCode: string | null,
  explicitEntries: readonly ExplicitArpEntrySpec[],
): string {
  return JSON.stringify({
    productCode: productCode?.toLowerCase() ?? null,
    explicitEntries: explicitEntries.map((e) => ({
      displayName: e.displayName,
      publisher: e.publisher,
      displayVersion: e.displayVersion,
      productCode: e.productCode?.toLowerCase() ?? null,
      upgradeCode: e.upgradeCode?.toLowerCase() ?? null,
    })),
  });
}

/**
 * マニフェストバンドルから Sandbox 検証時に使う CLI 検証コマンド候補を抽出する。
 * portable 単体の Commands と、zip(portable) の NestedInstallerFiles[].PortableCommandAlias を収集する。
 */
export function inferProbeCommandsFromBundle(bundle: ManifestBundle): string[] {
  const host = getInstallerHostFile(bundle);
  if (!host) return [];
  const commands = new Set<string>();

  for (const cmd of asStringArray(host.data.Commands)) {
    commands.add(cmd);
  }

  for (const entry of getInstallerEntries(bundle)) {
    for (const cmd of asStringArray(entry.Commands)) {
      commands.add(cmd);
    }
    const { installerType, nestedInstallerType } = resolveEffectiveInstallerType(host.data, entry);
    if (installerType === "zip" && nestedInstallerType === "portable") {
      const nestedRaw = Array.isArray(entry.NestedInstallerFiles)
        ? entry.NestedInstallerFiles
        : Array.isArray(host.data.NestedInstallerFiles)
          ? host.data.NestedInstallerFiles
          : [];
      for (const rawItem of nestedRaw) {
        const rec = asRecord(rawItem);
        const alias = rec ? asNonEmptyString(rec.PortableCommandAlias) : null;
        if (alias) commands.add(alias);
      }
    }
  }

  return [...commands];
}

/**
 * マニフェストバンドルから ARP（Add/Remove Programs）突き合わせ用の期待値を抽出する。
 * 実行時に記録された selectedInstallerUrl / selectedInstallerSha256 を最優先で照合し、
 * 未記録時は UnsupportedOSArchitectures / MinimumOSVersion による候補除外と WinGet 優先順で解決する。
 * 適用条件の判定材料不足や複数異なる ARP 仕様の競合で一意特定できない場合は selectionStatus="ambiguous" を返す。
 */
export function extractExpectedArpSpec(
  bundle: ManifestBundle,
  selectionInput?: string | InstallerSelectionContext,
): ExpectedArpSpec {
  const context: InstallerSelectionContext =
    typeof selectionInput === "string"
      ? { installedArchitecture: selectionInput }
      : (selectionInput ?? {});
  const installerHost = getInstallerHostFile(bundle);
  const localeHost = getLocaleHostFile(bundle);
  const versionHost = bundle.versionFile ?? installerHost ?? localeHost;

  const displayName = localeHost ? asNonEmptyString(localeHost.data.PackageName) : null;
  const publisher = localeHost ? asNonEmptyString(localeHost.data.Publisher) : null;
  const displayVersion = versionHost ? asNonEmptyString(versionHost.data.PackageVersion) : null;

  const rootProductCode = installerHost ? asNonEmptyString(installerHost.data.ProductCode) : null;
  const rootExplicitEntries = installerHost ? parseAppsAndFeaturesEntries(installerHost.data) : [];
  const rootMinOs = installerHost ? asNonEmptyString(installerHost.data.MinimumOSVersion) : null;
  const rootUnsupportedArchs = installerHost
    ? asStringArray(installerHost.data.UnsupportedOSArchitectures).map((a) => a.toLowerCase())
    : [];
  const allEntries = getInstallerEntries(bundle);

  const availableArchitectures = [
    ...new Set(
      allEntries
        .map((e) => asNonEmptyString(e.Architecture)?.toLowerCase())
        .filter((a): a is string => a !== undefined && a !== null),
    ),
  ];

  const computeVariantKey = (entry: Record<string, unknown>): string => {
    const entryExplicit = parseAppsAndFeaturesEntries(entry);
    const effectiveExplicit = entryExplicit.length > 0 ? entryExplicit : rootExplicitEntries;
    const effectiveProductCode =
      asNonEmptyString(entry.ProductCode) ??
      effectiveExplicit.find((e) => e.productCode)?.productCode ??
      rootProductCode;
    return serializeArpVariantKey(effectiveProductCode, effectiveExplicit);
  };

  const distinctEntryVariants = new Set(allEntries.map(computeVariantKey));
  const hasArchitectureSpecificArpVariants = distinctEntryVariants.size > 1;

  let selectionStatus: ExpectedArpSpec["selectionStatus"] = "resolved";
  let selectionReason: string | undefined;
  let resolvedInstallerArchitecture: string | null =
    availableArchitectures.length === 1 ? availableArchitectures[0] : null;
  let targetEntries: Record<string, unknown>[] = allEntries;

  const selectedSha = context.selectedInstallerSha256?.trim().toLowerCase();
  const selectedUrl = context.selectedInstallerUrl?.trim();
  const normalizedOsArch = context.installedArchitecture?.trim().toLowerCase();
  const osVersion = context.osVersion?.trim();

  // 1. 実行時記録（InstallerSha256 / InstallerUrl）が提供されていれば直接一致で一意特定
  if (selectedSha || selectedUrl) {
    const matchEntry = (entry: Record<string, unknown>, strictUrl: boolean): boolean => {
      const entrySha = asNonEmptyString(entry.InstallerSha256)?.toLowerCase();
      const entryUrl = asNonEmptyString(entry.InstallerUrl);
      const urlMatched =
        selectedUrl !== undefined &&
        entryUrl !== null &&
        (strictUrl ? entryUrl === selectedUrl : urlsMatchRfc3986(entryUrl, selectedUrl));
      if (selectedSha && selectedUrl) {
        return entrySha === selectedSha && urlMatched;
      }
      if (selectedSha) return entrySha === selectedSha;
      return urlMatched;
    };
    const exactMatched = allEntries.filter((entry) => matchEntry(entry, true));
    const matched =
      exactMatched.length > 0
        ? exactMatched
        : allEntries.filter((entry) => matchEntry(entry, false));
    if (matched.length === 0) {
      selectionStatus = "unmatched_selected_installer";
      selectionReason = `記録されたインストーラー（url=${selectedUrl ?? "(none)"}, sha256=${selectedSha ?? "(none)"}）がマニフェストに一致しません。`;
      targetEntries = [];
      resolvedInstallerArchitecture = null;
    } else if (new Set(matched.map(computeVariantKey)).size > 1) {
      selectionStatus = "ambiguous";
      selectionReason =
        "一致した複数エントリ間で異なる ARP 宣言（ProductCode / AppsAndFeaturesEntries）が存在するため一意特定できません。";
      targetEntries = matched;
    } else {
      targetEntries = matched;
      resolvedInstallerArchitecture =
        asNonEmptyString(matched[0].Architecture)?.toLowerCase() ?? null;
    }
  } else if (normalizedOsArch && allEntries.length > 0) {
    // 2. OS アーキテクチャ＋適用除外条件（UnsupportedOSArchitectures / MinimumOSVersion）で候補絞り込み
    let unverifiedMinOsCandidateExists = false;
    const eligibleEntries = allEntries.filter((entry) => {
      const entryUnsupported = asStringArray(entry.UnsupportedOSArchitectures).map((a) =>
        a.toLowerCase(),
      );
      const effectiveUnsupported =
        entryUnsupported.length > 0 ? entryUnsupported : rootUnsupportedArchs;
      if (effectiveUnsupported.includes(normalizedOsArch)) {
        return false;
      }
      const entryMinOs = asNonEmptyString(entry.MinimumOSVersion) ?? rootMinOs;
      if (entryMinOs) {
        if (osVersion) {
          if (compareDottedVersion(osVersion, entryMinOs) < 0) {
            return false;
          }
        } else {
          unverifiedMinOsCandidateExists = true;
        }
      }
      return true;
    });

    const eligibleArchs = [
      ...new Set(
        eligibleEntries
          .map((e) => asNonEmptyString(e.Architecture)?.toLowerCase())
          .filter((a): a is string => a !== undefined && a !== null),
      ),
    ];
    const preferredArch = resolveSelectedInstallerArchitecture(eligibleArchs, normalizedOsArch);
    if (!preferredArch) {
      selectionStatus = "incompatible";
      selectionReason = `installedArchitecture="${normalizedOsArch}" で適用可能なインストーラー候補がありません。`;
      targetEntries = [];
      resolvedInstallerArchitecture = null;
    } else {
      const preferredEntries = eligibleEntries.filter(
        (entry) => asNonEmptyString(entry.Architecture)?.toLowerCase() === preferredArch,
      );
      const preferredVariants = new Set(preferredEntries.map(computeVariantKey));
      // 優先候補に MinimumOSVersion が宣言されているのに osVersion も selectedInstallerUrl も未記録、
      // かつ他候補と異なる ARP 仕様を持つ場合は互換版へ切り替わった可能性を否定できないため ambiguous とする
      const preferredHasMinOs = preferredEntries.some(
        (entry) => (asNonEmptyString(entry.MinimumOSVersion) ?? rootMinOs) !== null,
      );
      if (
        (unverifiedMinOsCandidateExists &&
          preferredHasMinOs &&
          hasArchitectureSpecificArpVariants) ||
        preferredVariants.size > 1
      ) {
        selectionStatus = "ambiguous";
        selectionReason =
          "MinimumOSVersion または同一アーキテクチャ内の複数 ARP 宣言により、OS アーキテクチャだけでは実選択インストーラーを一意特定できません。selectedInstallerUrl / selectedInstallerSha256 または osVersion を記録してください。";
        targetEntries = preferredEntries;
        resolvedInstallerArchitecture = preferredArch;
      } else {
        targetEntries = preferredEntries;
        resolvedInstallerArchitecture = preferredArch;
      }
    }
  } else if (hasArchitectureSpecificArpVariants) {
    selectionStatus = "ambiguous";
    selectionReason = `複数インストーラーで異なる ARP 宣言（ProductCode / AppsAndFeaturesEntries）があるため、selectedInstallerUrl / selectedInstallerSha256 または installedArchitecture の記録が必須です。`;
  }

  let productCode = rootProductCode;
  let upgradeCode: string | null = null;
  let hasInstallerBasedEntry = false;
  const explicitEntries: ExplicitArpEntrySpec[] = [];
  const seenExplicitKeys = new Set<string>();

  const pushUniqueExplicit = (items: readonly ExplicitArpEntrySpec[]): void => {
    for (const item of items) {
      const key = JSON.stringify(item);
      if (seenExplicitKeys.has(key)) continue;
      seenExplicitKeys.add(key);
      if (!productCode && item.productCode) productCode = item.productCode;
      if (!upgradeCode && item.upgradeCode) upgradeCode = item.upgradeCode;
      explicitEntries.push(item);
    }
  };

  if (installerHost) {
    let anyTargetUsedEntryExplicit = false;
    for (const entry of targetEntries) {
      const { effectiveType } = resolveEffectiveInstallerType(installerHost.data, entry);
      if (effectiveType && INSTALLER_BASED_TYPES.has(effectiveType)) {
        hasInstallerBasedEntry = true;
      }
      const entryProductCode = asNonEmptyString(entry.ProductCode);
      if (entryProductCode) {
        productCode = entryProductCode;
      }
      const entryExplicit = parseAppsAndFeaturesEntries(entry);
      if (entryExplicit.length > 0) {
        anyTargetUsedEntryExplicit = true;
        pushUniqueExplicit(entryExplicit);
      } else if (rootExplicitEntries.length > 0) {
        pushUniqueExplicit(rootExplicitEntries);
      }
    }
    if (targetEntries.length === 0 && !anyTargetUsedEntryExplicit) {
      pushUniqueExplicit(rootExplicitEntries);
    }
  }

  return {
    displayName,
    publisher,
    displayVersion,
    productCode,
    upgradeCode,
    explicitEntries,
    hasInstallerBasedEntry,
    availableArchitectures,
    resolvedInstallerArchitecture,
    hasArchitectureSpecificArpVariants,
    selectionStatus,
    selectionReason,
  };
}

export interface SandboxPrepareOptions {
  manifestDir: string;
  outDir: string;
  wingetPkgsRoot?: string;
  probeCommands?: string[];
  verifyCommands?: string[];
  skipUninstall?: boolean;
  enableVgpu?: boolean;
}

export function buildWsbConfigurationXml(options: {
  manifestHostDir: string;
  outputHostDir: string;
  enableVgpu?: boolean;
}): string {
  const manifestHostDir = assertSafePath("manifestDir", options.manifestHostDir);
  const outputHostDir = assertSafePath("outDir", options.outputHostDir);
  const vgpuValue = options.enableVgpu ? "Enable" : "Disable";
  const logonCommand = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${SANDBOX_OUTPUT_DIR}\\verify-inside-sandbox.ps1"`;

  return [
    "<Configuration>",
    `  <VGpu>${vgpuValue}</VGpu>`,
    "  <Networking>Enable</Networking>",
    "  <MappedFolders>",
    "    <MappedFolder>",
    `      <HostFolder>${escapeXml(manifestHostDir)}</HostFolder>`,
    `      <SandboxFolder>${escapeXml(SANDBOX_MANIFEST_DIR)}</SandboxFolder>`,
    "      <ReadOnly>true</ReadOnly>",
    "    </MappedFolder>",
    "    <MappedFolder>",
    `      <HostFolder>${escapeXml(outputHostDir)}</HostFolder>`,
    `      <SandboxFolder>${escapeXml(SANDBOX_OUTPUT_DIR)}</SandboxFolder>`,
    "      <ReadOnly>false</ReadOnly>",
    "    </MappedFolder>",
    "  </MappedFolders>",
    "  <LogonCommand>",
    `    <Command>${escapeXml(logonCommand)}</Command>`,
    "  </LogonCommand>",
    "</Configuration>",
    "",
  ].join("\n");
}

function parseVerifyCommandLine(raw: string): { command: string; args: string[] } | null {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return { command: tokens[0], args: tokens.slice(1) };
}

export function buildInsideSandboxScript(options: {
  packageIdentifier: string | null;
  packageVersion: string | null;
  manifestInstallerUrls?: readonly string[];
  probeCommands: readonly string[];
  verifyCommands?: readonly string[];
  skipUninstall?: boolean;
}): string {
  const pkgIdLiteral = toPsSingleQuotedLiteral(options.packageIdentifier ?? "");
  const pkgVerLiteral = toPsSingleQuotedLiteral(options.packageVersion ?? "");
  const manifestUrlItems = [
    ...new Set((options.manifestInstallerUrls ?? []).map((u) => u.trim()).filter(Boolean)),
  ]
    .map((url) => toPsSingleQuotedLiteral(url))
    .join(", ");
  const probeArrayItems = options.probeCommands
    .map((cmd) => toPsSingleQuotedLiteral(cmd))
    .join(", ");
  const verifySpecs = (options.verifyCommands ?? [])
    .map(parseVerifyCommandLine)
    .filter((item): item is { command: string; args: string[] } => item !== null);
  const verifySpecItems = verifySpecs
    .map(
      (spec) =>
        `@{ Command = ${toPsSingleQuotedLiteral(spec.command)}; Args = @(${spec.args.map((a) => toPsSingleQuotedLiteral(a)).join(", ")}) }`,
    )
    .join(", ");
  const skipUninstallLiteral = options.skipUninstall ? "$true" : "$false";

  return [
    "# Auto-generated by winget verify-gate (PR 2/2 Windows Sandbox runner)",
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$ManifestDir = ${toPsSingleQuotedLiteral(SANDBOX_MANIFEST_DIR)}`,
    `$OutputDir = ${toPsSingleQuotedLiteral(SANDBOX_OUTPUT_DIR)}`,
    "$ResultPath = Join-Path $OutputDir 'sandbox-result.json'",
    "$LogPath = Join-Path $OutputDir 'sandbox-run.log'",
    `$PackageIdentifier = ${pkgIdLiteral}`,
    `$PackageVersion = ${pkgVerLiteral}`,
    `$ManifestInstallerUrls = @(${manifestUrlItems})`,
    `$ProbeCommands = @(${probeArrayItems})`,
    `$VerifyCommands = @(${verifySpecItems})`,
    `$SkipUninstall = ${skipUninstallLiteral}`,
    "",
    "Start-Transcript -Path $LogPath -Force | Out-Null",
    "",
    "function Get-NormalizedOsArchitecture {",
    "  try {",
    "    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()",
    "    if ($arch -in @('x64', 'x86', 'arm64')) { return $arch }",
    "  } catch {}",
    "  switch ($env:PROCESSOR_ARCHITECTURE) {",
    "    'AMD64' { return 'x64' }",
    "    'ARM64' { return 'arm64' }",
    "    'x86'   { return 'x86' }",
    "    default { return 'x64' }",
    "  }",
    "}",
    "",
    "function Refresh-ProcessPath {",
    "  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "  $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links'",
    "  $windowsApps = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps'",
    "  $parts = @($machinePath, $userPath)",
    "  if (Test-Path $windowsApps) { $parts += $windowsApps }",
    "  if (Test-Path $wingetLinks) { $parts += $wingetLinks }",
    "  $env:Path = ($parts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ';'",
    "}",
    "",
    "function Ensure-WinGetInstalled {",
    "  Refresh-ProcessPath",
    "  $existing = Get-Command winget -ErrorAction SilentlyContinue",
    "  if ($existing) { return $existing }",
    "  # Bootstrap WinGet in clean Windows Sandbox per Microsoft Learn guidance",
    "  try {",
    "    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    "    Install-PackageProvider -Name NuGet -Force | Out-Null",
    "    Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery -AllowClobber | Out-Null",
    "    Import-Module Microsoft.WinGet.Client -Force",
    "    Repair-WinGetPackageManager -AllUsers | Out-Null",
    "  } catch {",
    "    Write-Warning ('Microsoft.WinGet.Client bootstrap failed: ' + $_.Exception.Message)",
    "  }",
    "  Refresh-ProcessPath",
    "  $afterModule = Get-Command winget -ErrorAction SilentlyContinue",
    "  if ($afterModule) { return $afterModule }",
    "  try {",
    "    $bundlePath = Join-Path $env:TEMP 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe.msixbundle'",
    "    Invoke-WebRequest -Uri 'https://aka.ms/getwinget' -OutFile $bundlePath -UseBasicParsing",
    "    Add-AppxPackage -Path $bundlePath",
    "  } catch {",
    "    Write-Warning ('Direct msixbundle WinGet install failed: ' + $_.Exception.Message)",
    "  }",
    "  Refresh-ProcessPath",
    "  return (Get-Command winget -ErrorAction SilentlyContinue)",
    "}",
    "",
    "function Get-ArpSnapshot {",
    "  $targets = @(",
    "    @{ Hive = 'HKLM'; View = '64bit'; Path = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },",
    "    @{ Hive = 'HKLM'; View = '32bit'; Path = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },",
    "    @{ Hive = 'HKCU'; View = '64bit'; Path = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' },",
    "    @{ Hive = 'HKCU'; View = '32bit'; Path = 'HKCU:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }",
    "  )",
    "  $entries = @()",
    "  foreach ($t in $targets) {",
    "    if (-not (Test-Path ($t.Path -replace '\\\\\\*$', ''))) { continue }",
    "    Get-ItemProperty -Path $t.Path -ErrorAction SilentlyContinue | ForEach-Object {",
    "      $dn = [string]$_.DisplayName",
    "      $pub = [string]$_.Publisher",
    "      $ver = [string]$_.DisplayVersion",
    "      if ([string]::IsNullOrWhiteSpace($dn) -and [string]::IsNullOrWhiteSpace($ver)) { return }",
    "      $keyName = $_.PSChildName",
    "      $productCode = if ($_.ProductCode) { [string]$_.ProductCode } elseif ($keyName -match '^\\{[0-9A-Fa-f-]{36}\\}$') { $keyName } else { $null }",
    "      $upgradeCode = if ($_.UpgradeCode) { [string]$_.UpgradeCode } else { $null }",
    "      $entries += [ordered]@{",
    "        registryKeyPath = [string]$_.PSPath",
    "        hive = $t.Hive",
    "        view = $t.View",
    "        keyName = [string]$keyName",
    "        displayName = if ($dn) { $dn } else { $null }",
    "        publisher = if ($pub) { $pub } else { $null }",
    "        displayVersion = if ($ver) { $ver } else { $null }",
    "        uninstallString = if ($_.UninstallString) { [string]$_.UninstallString } else { $null }",
    "        quietUninstallString = if ($_.QuietUninstallString) { [string]$_.QuietUninstallString } else { $null }",
    "        productCode = $productCode",
    "        upgradeCode = $upgradeCode",
    "      }",
    "    }",
    "  }",
    "  return @($entries)",
    "}",
    "",
    "function Invoke-CliProbe([string]$Cmd, [string[]]$CmdArgs, [bool]$Required = $false, [int]$TimeoutSeconds = 15) {",
    "  $resolved = Get-Command $Cmd -ErrorAction SilentlyContinue",
    "  if (-not $resolved) {",
    "    return [ordered]@{",
    "      command = $Cmd",
    "      args = @($CmdArgs)",
    "      exitCode = $null",
    "      timedOut = $false",
    "      required = $Required",
    "      error = ('Command not found in PATH: ' + $Cmd)",
    "    }",
    "  }",
    "  $psi = New-Object System.Diagnostics.ProcessStartInfo",
    "  $psi.FileName = $resolved.Source",
    "  $psi.Arguments = ($CmdArgs | ForEach-Object { '\"' + ($_ -replace '\"', '\\\"') + '\"' }) -join ' '",
    "  $psi.UseShellExecute = $false",
    "  $psi.RedirectStandardOutput = $true",
    "  $psi.RedirectStandardError = $true",
    "  $psi.CreateNoWindow = $true",
    "  $proc = New-Object System.Diagnostics.Process",
    "  $proc.StartInfo = $psi",
    "  try {",
    "    [void]$proc.Start()",
    "    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()",
    "    $stderrTask = $proc.StandardError.ReadToEndAsync()",
    "    $exited = $proc.WaitForExit($TimeoutSeconds * 1000)",
    "    if (-not $exited) {",
    "      try { $proc.Kill() } catch {}",
    "      return [ordered]@{",
    "        command = $Cmd",
    "        args = @($CmdArgs)",
    "        exitCode = $null",
    "        timedOut = $true",
    "        required = $Required",
    "        error = ('Timed out after ' + $TimeoutSeconds + 's')",
    "      }",
    "    }",
    "    $stdoutText = $stdoutTask.GetAwaiter().GetResult()",
    "    $stderrText = $stderrTask.GetAwaiter().GetResult()",
    "    return [ordered]@{",
    "      command = $Cmd",
    "      args = @($CmdArgs)",
    "      exitCode = [int]$proc.ExitCode",
    "      timedOut = $false",
    "      required = $Required",
    "      stdoutSnippet = if ($stdoutText) { $stdoutText.Substring(0, [Math]::Min(400, $stdoutText.Length)) } else { '' }",
    "      stderrSnippet = if ($stderrText) { $stderrText.Substring(0, [Math]::Min(400, $stderrText.Length)) } else { '' }",
    "    }",
    "  } catch {",
    "    return [ordered]@{",
    "      command = $Cmd",
    "      args = @($CmdArgs)",
    "      exitCode = $null",
    "      timedOut = $false",
    "      required = $Required",
    "      error = [string]$_.Exception.Message",
    "    }",
    "  } finally {",
    "    $proc.Dispose()",
    "  }",
    "}",
    "",
    "function Select-ManifestInstallerUrl([string]$InstallOutput, [string[]]$KnownManifestUrls) {",
    "  if ([string]::IsNullOrWhiteSpace($InstallOutput) -or $KnownManifestUrls.Count -eq 0) { return $null }",
    "  $urlPartsPattern = '^((?i:https?))://([^/?#]*)(.*)$'",
    "  $dlMatches = [regex]::Matches($InstallOutput, 'Downloading\\s+((?i:https?)://\\S+)')",
    "  $selected = $null",
    "  foreach ($m in $dlMatches) {",
    "    $candidate = $m.Groups[1].Value.Trim()",
    "    $exact = $null",
    "    foreach ($known in $KnownManifestUrls) {",
    "      if ([string]::Equals($candidate, $known, [System.StringComparison]::Ordinal)) {",
    "        $exact = $known",
    "        break",
    "      }",
    "    }",
    "    if ($null -ne $exact) {",
    "      $selected = $exact",
    "      continue",
    "    }",
    "    $cm = [regex]::Match($candidate, $urlPartsPattern)",
    "    if (-not $cm.Success) { continue }",
    "    $cScheme = $cm.Groups[1].Value",
    "    $cAuth = $cm.Groups[2].Value",
    "    $cRest = $cm.Groups[3].Value",
    "    $cAt = $cAuth.LastIndexOf('@')",
    "    $cUser = if ($cAt -ge 0) { $cAuth.Substring(0, $cAt) } else { '' }",
    "    $cHost = if ($cAt -ge 0) { $cAuth.Substring($cAt + 1) } else { $cAuth }",
    "    foreach ($known in $KnownManifestUrls) {",
    "      $km = [regex]::Match($known, $urlPartsPattern)",
    "      if (-not $km.Success) { continue }",
    "      if (-not [string]::Equals($cScheme, $km.Groups[1].Value, [System.StringComparison]::OrdinalIgnoreCase)) { continue }",
    "      if (-not [string]::Equals($cRest, $km.Groups[3].Value, [System.StringComparison]::Ordinal)) { continue }",
    "      $kAuth = $km.Groups[2].Value",
    "      $kAt = $kAuth.LastIndexOf('@')",
    "      $kUser = if ($kAt -ge 0) { $kAuth.Substring(0, $kAt) } else { '' }",
    "      $kHost = if ($kAt -ge 0) { $kAuth.Substring($kAt + 1) } else { $kAuth }",
    "      if ([string]::Equals($cUser, $kUser, [System.StringComparison]::Ordinal) -and [string]::Equals($cHost, $kHost, [System.StringComparison]::OrdinalIgnoreCase)) {",
    "        $selected = $known",
    "        break",
    "      }",
    "    }",
    "  }",
    "  return $selected",
    "}",
    "",
    "$installedArchitecture = Get-NormalizedOsArchitecture",
    "$osVersion = [System.Environment]::OSVersion.Version.ToString()",
    "$localManifestFilesEnabled = $false",
    "$wingetCmd = Ensure-WinGetInstalled",
    "if ($wingetCmd) {",
    "  & winget settings --enable LocalManifestFiles | Out-Null",
    "  if ($LASTEXITCODE -eq 0) { $localManifestFilesEnabled = $true }",
    "}",
    "",
    "$arpBefore = @(Get-ArpSnapshot)",
    '$installCommand = "winget install --manifest $ManifestDir --accept-package-agreements --accept-source-agreements --disable-interactivity"',
    "$installExitCode = -1",
    "$installLog = ''",
    "$selectedInstallerUrl = $null",
    "if ($wingetCmd) {",
    "  $installOut = & winget install --manifest $ManifestDir --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-String",
    "  $installExitCode = [int]$LASTEXITCODE",
    "  $installLog = $installOut.Substring(0, [Math]::Min(1200, $installOut.Length))",
    "  $selectedInstallerUrl = Select-ManifestInstallerUrl -InstallOutput $installOut -KnownManifestUrls $ManifestInstallerUrls",
    "} else {",
    "  $installLog = 'WinGet bootstrap failed in Windows Sandbox (see sandbox-run.log for details).'",
    "}",
    "",
    "Refresh-ProcessPath",
    "$arpAfterInstall = @(Get-ArpSnapshot)",
    "",
    "$cliProbes = @()",
    "if ($installExitCode -eq 0) {",
    "  foreach ($cmdName in $ProbeCommands) {",
    "    $cliProbes += Invoke-CliProbe -Cmd $cmdName -CmdArgs @() -Required $false",
    "    $cliProbes += Invoke-CliProbe -Cmd $cmdName -CmdArgs @('--version') -Required $false",
    "    $cliProbes += Invoke-CliProbe -Cmd $cmdName -CmdArgs @('--help') -Required $false",
    "  }",
    "  foreach ($vc in $VerifyCommands) {",
    "    $cliProbes += Invoke-CliProbe -Cmd $vc.Command -CmdArgs $vc.Args -Required $true",
    "  }",
    "}",
    "",
    "$uninstallOutcome = $null",
    "$arpAfterUninstall = $null",
    "if (-not $SkipUninstall -and $installExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($PackageIdentifier)) {",
    "  $uninstallOut = & winget uninstall --id $PackageIdentifier --silent --disable-interactivity 2>&1 | Out-String",
    "  $uninstallExitCode = [int]$LASTEXITCODE",
    "  $uninstallOutcome = [ordered]@{",
    '    command = "winget uninstall --id $PackageIdentifier --silent --disable-interactivity"',
    "    exitCode = $uninstallExitCode",
    "    logSnippet = $uninstallOut.Substring(0, [Math]::Min(1200, $uninstallOut.Length))",
    "  }",
    "  $arpAfterUninstall = @(Get-ArpSnapshot)",
    "}",
    "",
    "$payload = [ordered]@{",
    "  schemaVersion = 1",
    "  packageIdentifier = if ($PackageIdentifier) { $PackageIdentifier } else { $null }",
    "  packageVersion = if ($PackageVersion) { $PackageVersion } else { $null }",
    "  installedArchitecture = $installedArchitecture",
    "  osVersion = $osVersion",
    "  selectedInstallerUrl = $selectedInstallerUrl",
    "  executedAt = [DateTime]::UtcNow.ToString('o')",
    "  localManifestFilesEnabled = $localManifestFilesEnabled",
    "  install = [ordered]@{",
    "    command = $installCommand",
    "    exitCode = $installExitCode",
    "    logSnippet = $installLog",
    "  }",
    "  arpBefore = @($arpBefore)",
    "  arpAfterInstall = @($arpAfterInstall)",
    "  cliProbes = @($cliProbes)",
    "}",
    "if ($null -ne $uninstallOutcome) { $payload.uninstall = $uninstallOutcome }",
    "if ($null -ne $arpAfterUninstall) { $payload.arpAfterUninstall = @($arpAfterUninstall) }",
    "",
    "$json = $payload | ConvertTo-Json -Depth 6",
    "[System.IO.File]::WriteAllText($ResultPath, $json, [System.Text.UTF8Encoding]::new($false))",
    "Stop-Transcript | Out-Null",
    "",
  ].join("\n");
}

export function buildHostLauncherScript(options: {
  manifestDir: string;
  wsbPath: string;
  resultJsonPath: string;
  wingetPkgsRoot?: string;
}): string {
  const manifestLiteral = toPsSingleQuotedLiteral(options.manifestDir);
  const wsbLiteral = toPsSingleQuotedLiteral(options.wsbPath);
  const resultLiteral = toPsSingleQuotedLiteral(options.resultJsonPath);
  const wingetPkgsRootLiteral = toPsSingleQuotedLiteral(options.wingetPkgsRoot ?? "");

  return [
    "# Auto-generated host launcher by winget verify-gate",
    "param(",
    "  [switch]$ManualOfficialSandboxTest",
    ")",
    "$ErrorActionPreference = 'Stop'",
    `$ManifestDir = ${manifestLiteral}`,
    `$WsbPath = ${wsbLiteral}`,
    `$ResultPath = ${resultLiteral}`,
    `$WingetPkgsRoot = ${wingetPkgsRootLiteral}`,
    "",
    "if ($ManualOfficialSandboxTest) {",
    "  if ([string]::IsNullOrWhiteSpace($WingetPkgsRoot)) {",
    "    throw 'Pass --winget-pkgs-root when preparing to launch official Tools/SandboxTest.ps1.'",
    "  }",
    "  $officialScript = Join-Path $WingetPkgsRoot 'Tools\\SandboxTest.ps1'",
    "  if (-not (Test-Path $officialScript)) {",
    "    throw ('Official SandboxTest.ps1 not found: ' + $officialScript)",
    "  }",
    "  Write-Host 'Launching official Tools/SandboxTest.ps1 for interactive/manual check (does not emit sandbox-result.json).'",
    "  & $officialScript $ManifestDir",
    "  exit $LASTEXITCODE",
    "}",
    "",
    "$sandboxExe = Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue",
    "$sandboxPath = if ($sandboxExe) { $sandboxExe.Source } else { $null }",
    "if (-not $sandboxPath) {",
    "  foreach ($candidate in @(",
    "    (Join-Path $env:WINDIR 'System32\\WindowsSandbox.exe'),",
    "    (Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\WindowsSandbox.exe')",
    "  )) {",
    "    if ($candidate -and (Test-Path $candidate)) { $sandboxPath = $candidate; break }",
    "  }",
    "}",
    "if ($sandboxPath) {",
    "  Start-Process -FilePath $sandboxPath -ArgumentList $WsbPath",
    "} else {",
    "  $wsbCli = Get-Command wsb.exe -ErrorAction SilentlyContinue",
    "  if ($wsbCli) {",
    "    Start-Process -FilePath $WsbPath",
    "  } else {",
    "    throw 'Windows Sandbox was not found (neither WindowsSandbox.exe nor wsb.exe). Enable it in an elevated PowerShell on Windows Pro/Enterprise: Enable-WindowsOptionalFeature -FeatureName Containers-DisposableClientVM -All -Online (reboot required).'",
    "  }",
    "}",
    "Write-Host ('Launched Windows Sandbox (auto WinGet bootstrap + ARP/CLI capture): ' + $WsbPath)",
    "Write-Host 'After Sandbox finishes and emits sandbox-result.json, evaluate with:'",
    "Write-Host ('  winget-verify-gate sandbox eval \"' + $ManifestDir + '\" --result \"' + $ResultPath + '\"')",
    "",
  ].join("\n");
}

export function prepareSandboxWorkspace(
  bundle: ManifestBundle,
  options: SandboxPrepareOptions,
): SandboxPrepareResult {
  const manifestDir = resolve(assertSafePath("manifestDir", options.manifestDir));
  const outputDir = resolve(assertSafePath("outDir", options.outDir));
  const wingetPkgsRoot = options.wingetPkgsRoot
    ? resolve(assertSafePath("wingetPkgsRoot", options.wingetPkgsRoot))
    : undefined;

  const versionHost = bundle.versionFile ?? bundle.installerFile ?? bundle.singletonFile;
  const packageIdentifier = versionHost
    ? asNonEmptyString(versionHost.data.PackageIdentifier)
    : null;
  const packageVersion = versionHost ? asNonEmptyString(versionHost.data.PackageVersion) : null;
  const manifestInstallerUrls = getInstallerEntries(bundle)
    .map((entry) => asNonEmptyString(entry.InstallerUrl))
    .filter((url): url is string => url !== null);

  const inferredProbes = inferProbeCommandsFromBundle(bundle);
  const explicitProbes = (options.probeCommands ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const probeCommands = [...new Set([...inferredProbes, ...explicitProbes])];
  const verifyCommands = [
    ...new Set((options.verifyCommands ?? []).map((c) => c.trim()).filter((c) => c.length > 0)),
  ];

  mkdirSync(outputDir, { recursive: true });

  const wsbPath = join(outputDir, "verify-gate.wsb");
  const sandboxScriptPath = join(outputDir, "verify-inside-sandbox.ps1");
  const hostLauncherPath = join(outputDir, "run-sandbox-test.ps1");
  const resultJsonPath = join(outputDir, "sandbox-result.json");

  const wsbXml = buildWsbConfigurationXml({
    manifestHostDir: manifestDir,
    outputHostDir: outputDir,
    enableVgpu: options.enableVgpu,
  });
  const insideScript = buildInsideSandboxScript({
    packageIdentifier,
    packageVersion,
    manifestInstallerUrls,
    probeCommands,
    verifyCommands,
    skipUninstall: options.skipUninstall,
  });
  const launcherScript = buildHostLauncherScript({
    manifestDir,
    wsbPath,
    resultJsonPath,
    wingetPkgsRoot,
  });

  writeFileSync(wsbPath, wsbXml, "utf8");
  writeFileSync(sandboxScriptPath, `${UTF8_BOM}${insideScript}`, "utf8");
  writeFileSync(hostLauncherPath, `${UTF8_BOM}${launcherScript}`, "utf8");

  const recommendedOfficialCommand = wingetPkgsRoot
    ? `& "${join(wingetPkgsRoot, "Tools", "SandboxTest.ps1")}" "${manifestDir}"`
    : `.\\Tools\\SandboxTest.ps1 "${manifestDir}"`;

  return {
    packageIdentifier,
    packageVersion,
    manifestDir,
    outputDir,
    wsbPath,
    sandboxScriptPath,
    hostLauncherPath,
    resultJsonPath,
    probeCommands,
    verifyCommands,
    recommendedOfficialCommand,
    nextSteps: [
      `自動検証用 .wsb（WinGet 自動導入＋ARP/CLI 自動計測）を起動: pwsh -File "${hostLauncherPath}"`,
      `完了後に sandbox-result.json をマニフェストと突き合わせ: verify-gate sandbox eval "${manifestDir}" --result "${resultJsonPath}"`,
      `（補助・手動対話確認のみ）公式 SandboxTest.ps1 を使う場合: ${recommendedOfficialCommand}`,
    ],
  };
}
