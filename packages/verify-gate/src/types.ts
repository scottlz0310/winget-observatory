export type GateCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface GateFinding {
  id: string;
  status: GateCheckStatus;
  title: string;
  detail: string;
  remediation?: string;
  file?: string;
  guideRef?: string;
}

export interface GateSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface GateReport {
  passed: boolean;
  target: string;
  checkedAt: string;
  summary: GateSummary;
  findings: GateFinding[];
  nextSteps: string[];
}

export type ManifestFileKind =
  | "version"
  | "installer"
  | "defaultLocale"
  | "locale"
  | "singleton"
  | "unknown";

export interface ParsedManifestFile {
  filePath: string;
  fileName: string;
  kind: ManifestFileKind;
  schemaUrl: string | null;
  schemaVersion: string | null;
  data: Record<string, unknown>;
}

export interface ManifestBundle {
  manifestDir: string;
  files: ParsedManifestFile[];
  versionFile: ParsedManifestFile | null;
  installerFile: ParsedManifestFile | null;
  defaultLocaleFile: ParsedManifestFile | null;
  localeFiles: ParsedManifestFile[];
  singletonFile: ParsedManifestFile | null;
}

export type PeArchitecture = "x64" | "x86" | "arm64" | "unknown";

export interface PeInspectionResult {
  valid: boolean;
  filePath: string;
  format: "PE32" | "PE32+" | "invalid";
  architecture: PeArchitecture;
  importedDlls: string[];
  nonStandardRuntimeDlls: string[];
  hasAuthenticodeSignature: boolean;
  error?: string;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ArpRegistryHive = "HKLM" | "HKCU";
export type ArpRegistryView = "64bit" | "32bit";

export interface ArpRegistryEntry {
  registryKeyPath: string;
  hive: ArpRegistryHive;
  view: ArpRegistryView;
  keyName: string;
  displayName?: string;
  publisher?: string;
  displayVersion?: string;
  uninstallString?: string;
  quietUninstallString?: string;
  productCode?: string;
  upgradeCode?: string;
}

export interface CliProbeResult {
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  required?: boolean;
  stdoutSnippet?: string;
  stderrSnippet?: string;
  error?: string;
}

export interface SandboxCommandOutcome {
  command: string;
  exitCode: number;
  logSnippet?: string;
}

export interface SandboxRunResult {
  schemaVersion: 1;
  packageIdentifier?: string;
  packageVersion?: string;
  installedArchitecture?: Exclude<PeArchitecture, "unknown">;
  executedAt: string;
  localManifestFilesEnabled: boolean;
  install: SandboxCommandOutcome;
  uninstall?: SandboxCommandOutcome;
  arpBefore: ArpRegistryEntry[];
  arpAfterInstall: ArpRegistryEntry[];
  arpAfterUninstall?: ArpRegistryEntry[];
  cliProbes?: CliProbeResult[];
}

export interface SandboxPrepareResult {
  packageIdentifier: string | null;
  packageVersion: string | null;
  manifestDir: string;
  outputDir: string;
  wsbPath: string;
  sandboxScriptPath: string;
  hostLauncherPath: string;
  resultJsonPath: string;
  probeCommands: string[];
  verifyCommands: string[];
  recommendedOfficialCommand: string;
  nextSteps: string[];
}
