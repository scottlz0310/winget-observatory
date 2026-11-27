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

export interface ExpectedArpSpec {
  displayName: string | null;
  publisher: string | null;
  displayVersion: string | null;
  productCode: string | null;
  upgradeCode: string | null;
  explicitEntries: Array<{
    displayName: string | null;
    publisher: string | null;
    displayVersion: string | null;
    productCode: string | null;
    upgradeCode: string | null;
  }>;
  hasInstallerBasedEntry: boolean;
}

const INSTALLER_BASED_TYPES = new Set(["inno", "nullsoft", "wix", "msi", "exe", "burn", "msix"]);

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
 */
export function extractExpectedArpSpec(bundle: ManifestBundle): ExpectedArpSpec {
  const installerHost = getInstallerHostFile(bundle);
  const localeHost = getLocaleHostFile(bundle);
  const versionHost = bundle.versionFile ?? installerHost ?? localeHost;

  const displayName = localeHost ? asNonEmptyString(localeHost.data.PackageName) : null;
  const publisher = localeHost ? asNonEmptyString(localeHost.data.Publisher) : null;
  const displayVersion = versionHost ? asNonEmptyString(versionHost.data.PackageVersion) : null;

  let productCode = installerHost ? asNonEmptyString(installerHost.data.ProductCode) : null;
  let upgradeCode: string | null = null;
  let hasInstallerBasedEntry = false;
  const explicitEntries: ExpectedArpSpec["explicitEntries"] = [];

  const collectAppsAndFeatures = (container: Record<string, unknown>): void => {
    if (!Array.isArray(container.AppsAndFeaturesEntries)) return;
    for (const raw of container.AppsAndFeaturesEntries) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const entryProductCode = asNonEmptyString(rec.ProductCode);
      const entryUpgradeCode = asNonEmptyString(rec.UpgradeCode);
      if (!productCode && entryProductCode) productCode = entryProductCode;
      if (!upgradeCode && entryUpgradeCode) upgradeCode = entryUpgradeCode;
      explicitEntries.push({
        displayName: asNonEmptyString(rec.DisplayName),
        publisher: asNonEmptyString(rec.Publisher),
        displayVersion: asNonEmptyString(rec.DisplayVersion),
        productCode: entryProductCode,
        upgradeCode: entryUpgradeCode,
      });
    }
  };

  if (installerHost) {
    collectAppsAndFeatures(installerHost.data);
    for (const entry of getInstallerEntries(bundle)) {
      const { effectiveType } = resolveEffectiveInstallerType(installerHost.data, entry);
      if (effectiveType && INSTALLER_BASED_TYPES.has(effectiveType)) {
        hasInstallerBasedEntry = true;
      }
      if (!productCode) {
        productCode = asNonEmptyString(entry.ProductCode);
      }
      collectAppsAndFeatures(entry);
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
  };
}

export interface SandboxPrepareOptions {
  manifestDir: string;
  outDir: string;
  wingetPkgsRoot?: string;
  probeCommands?: string[];
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

export function buildInsideSandboxScript(options: {
  packageIdentifier: string | null;
  packageVersion: string | null;
  probeCommands: readonly string[];
  skipUninstall?: boolean;
}): string {
  const pkgIdLiteral = toPsSingleQuotedLiteral(options.packageIdentifier ?? "");
  const pkgVerLiteral = toPsSingleQuotedLiteral(options.packageVersion ?? "");
  const probeArrayItems = options.probeCommands
    .map((cmd) => toPsSingleQuotedLiteral(cmd))
    .join(", ");
  const skipUninstallLiteral = options.skipUninstall ? "$true" : "$false";

  return [
    "# Auto-generated by winget verify-gate (PR 2/2 Windows Sandbox runner)",
    "$ErrorActionPreference = 'Continue'",
    `$ManifestDir = ${toPsSingleQuotedLiteral(SANDBOX_MANIFEST_DIR)}`,
    `$OutputDir = ${toPsSingleQuotedLiteral(SANDBOX_OUTPUT_DIR)}`,
    "$ResultPath = Join-Path $OutputDir 'sandbox-result.json'",
    "$LogPath = Join-Path $OutputDir 'sandbox-run.log'",
    `$PackageIdentifier = ${pkgIdLiteral}`,
    `$PackageVersion = ${pkgVerLiteral}`,
    `$ProbeCommands = @(${probeArrayItems})`,
    `$SkipUninstall = ${skipUninstallLiteral}`,
    "",
    "Start-Transcript -Path $LogPath -Force | Out-Null",
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
    "function Refresh-ProcessPath {",
    "  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')",
    "  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "  $wingetLinks = Join-Path $env:LOCALAPPDATA 'Microsoft\\WinGet\\Links'",
    "  $parts = @($machinePath, $userPath)",
    "  if (Test-Path $wingetLinks) { $parts += $wingetLinks }",
    "  $env:Path = ($parts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ';'",
    "}",
    "",
    "function Invoke-CliProbe([string]$Cmd, [string[]]$CmdArgs, [int]$TimeoutSeconds = 15) {",
    "  $resolved = Get-Command $Cmd -ErrorAction SilentlyContinue",
    "  if (-not $resolved) {",
    "    return [ordered]@{",
    "      command = $Cmd",
    "      args = @($CmdArgs)",
    "      exitCode = $null",
    "      timedOut = $false",
    '      error = "Command not found in PATH: $Cmd"',
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
    "      stdoutSnippet = if ($stdoutText) { $stdoutText.Substring(0, [Math]::Min(400, $stdoutText.Length)) } else { '' }",
    "      stderrSnippet = if ($stderrText) { $stderrText.Substring(0, [Math]::Min(400, $stderrText.Length)) } else { '' }",
    "    }",
    "  } catch {",
    "    return [ordered]@{",
    "      command = $Cmd",
    "      args = @($CmdArgs)",
    "      exitCode = $null",
    "      timedOut = $false",
    "      error = [string]$_.Exception.Message",
    "    }",
    "  } finally {",
    "    $proc.Dispose()",
    "  }",
    "}",
    "",
    "$localManifestFilesEnabled = $false",
    "$wingetCmd = Get-Command winget -ErrorAction SilentlyContinue",
    "if ($wingetCmd) {",
    "  & winget settings --enable LocalManifestFiles | Out-Null",
    "  if ($LASTEXITCODE -eq 0) { $localManifestFilesEnabled = $true }",
    "}",
    "",
    "$arpBefore = @(Get-ArpSnapshot)",
    '$installCommand = "winget install --manifest $ManifestDir --accept-package-agreements --accept-source-agreements --disable-interactivity"',
    "$installExitCode = -1",
    "$installLog = ''",
    "if ($wingetCmd) {",
    "  $installOut = & winget install --manifest $ManifestDir --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 | Out-String",
    "  $installExitCode = [int]$LASTEXITCODE",
    "  $installLog = $installOut.Substring(0, [Math]::Min(1200, $installOut.Length))",
    "} else {",
    "  $installLog = 'winget.exe was not found in Windows Sandbox. Use microsoft/winget-pkgs Tools/SandboxTest.ps1 to bootstrap WinGet.'",
    "}",
    "",
    "Refresh-ProcessPath",
    "$arpAfterInstall = @(Get-ArpSnapshot)",
    "",
    "$cliProbes = @()",
    "if ($installExitCode -eq 0 -and $ProbeCommands.Count -gt 0) {",
    "  foreach ($cmdName in $ProbeCommands) {",
    "    $cliProbes += Invoke-CliProbe -Cmd $cmdName -CmdArgs @()",
    "    $cliProbes += Invoke-CliProbe -Cmd $cmdName -CmdArgs @('--version')",
    "    $cliProbes += Invoke-CliProbe -Cmd $cmdName -CmdArgs @('--help')",
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
    "  [switch]$UseOfficialSandboxTest",
    ")",
    "$ErrorActionPreference = 'Stop'",
    `$ManifestDir = ${manifestLiteral}`,
    `$WsbPath = ${wsbLiteral}`,
    `$ResultPath = ${resultLiteral}`,
    `$WingetPkgsRoot = ${wingetPkgsRootLiteral}`,
    "",
    "if ($UseOfficialSandboxTest) {",
    "  if ([string]::IsNullOrWhiteSpace($WingetPkgsRoot)) {",
    "    throw 'Pass --winget-pkgs-root when preparing to use Tools/SandboxTest.ps1.'",
    "  }",
    "  $officialScript = Join-Path $WingetPkgsRoot 'Tools\\SandboxTest.ps1'",
    "  if (-not (Test-Path $officialScript)) {",
    '    throw "Official SandboxTest.ps1 not found: $officialScript"',
    "  }",
    "  & $officialScript $ManifestDir",
    "  exit $LASTEXITCODE",
    "}",
    "",
    "$sandboxExe = Get-Command WindowsSandbox.exe -ErrorAction SilentlyContinue",
    "if (-not $sandboxExe) {",
    "  throw 'WindowsSandbox.exe was not found. Enable Windows Sandbox optional feature on Windows Pro/Enterprise.'",
    "}",
    "Start-Process -FilePath $sandboxExe.Source -ArgumentList $WsbPath",
    'Write-Host "Launched Windows Sandbox: $WsbPath"',
    'Write-Host "After Sandbox finishes, evaluate with:"',
    'Write-Host "  bun run verify:gate sandbox eval `"$ManifestDir`" --result `"$ResultPath`""',
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

  const inferredProbes = inferProbeCommandsFromBundle(bundle);
  const explicitProbes = (options.probeCommands ?? [])
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const probeCommands = [...new Set([...inferredProbes, ...explicitProbes])];

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
    probeCommands,
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
    recommendedOfficialCommand,
    nextSteps: [
      `公式 SandboxTest を使う場合: ${recommendedOfficialCommand}`,
      `自動ダンプ用 .wsb を起動する場合: pwsh -File "${hostLauncherPath}"`,
      `実行後に結果を突き合わせる場合: verify-gate sandbox eval "${manifestDir}" --result "${resultJsonPath}"`,
    ],
  };
}
