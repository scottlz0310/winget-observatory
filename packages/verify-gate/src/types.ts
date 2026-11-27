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
