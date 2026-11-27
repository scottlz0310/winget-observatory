import { resolve } from "node:path";
import { loadManifestBundle } from "./manifest-loader";
import {
  evaluateManifestRules,
  getInstallerEntries,
  resolveEffectivePackageDependencySetsForArchitecture,
} from "./manifest-rules";
import { runNetworkChecks } from "./network-checks";
import { inspectPeFile } from "./pe-inspector";
import { evaluateSandboxResult, loadSandboxRunResultFile } from "./sandbox-evaluator";
import { prepareSandboxWorkspace, type SandboxPrepareOptions } from "./sandbox-plan";
import type {
  FetchLike,
  GateFinding,
  GateReport,
  GateSummary,
  PeArchitecture,
  PeInspectionResult,
  SandboxPrepareResult,
} from "./types";

export interface ManifestGateOptions {
  manifestDir: string;
  binaryPath?: string;
  sandboxResultPath?: string;
  offline?: boolean;
  verifySha256?: boolean;
  minManifestVersion?: string;
  timeoutMs?: number;
}

export interface SandboxEvalOptions {
  manifestDir: string;
  resultPath: string;
}

export interface BinaryGateOptions {
  binaryPath: string;
  expectedArchitecture?: PeArchitecture;
  declaredDependencies?: readonly string[];
}

export interface GateRunnerDeps {
  fetchImpl?: FetchLike;
  inspectPe?: (filePath: string) => PeInspectionResult;
  now?: () => Date;
}

function summarizeFindings(findings: readonly GateFinding[]): GateSummary {
  const summary: GateSummary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const f of findings) {
    summary[f.status]++;
  }
  return summary;
}

function hasMatchingVcRedistDependency(
  arch: PeArchitecture,
  declaredDependencies: readonly string[],
): boolean {
  const expectedId =
    arch === "x86"
      ? "microsoft.vcredist.2015+.x86"
      : arch === "arm64"
        ? "microsoft.vcredist.2015+.arm64"
        : "microsoft.vcredist.2015+.x64";
  return declaredDependencies.some((dep) => dep.toLowerCase() === expectedId);
}

export function evaluatePeInspectionFindings(
  pe: PeInspectionResult,
  options: {
    expectedArchitectures?: readonly string[];
    declaredDependencies?: readonly string[];
    effectiveDependencySets?: readonly (readonly string[])[];
  } = {},
): GateFinding[] {
  if (!pe.valid) {
    return [
      {
        id: "PKG-PORT-05",
        status: "fail",
        title: "PE バイナリの解析に失敗",
        detail: `${pe.filePath}: ${pe.error ?? "有効な Windows PE ファイルではありません"}`,
        remediation: "有効な Windows 実行ファイル（.exe / .dll）を指定してください。",
        file: pe.filePath,
        guideRef: "PKG-PORT-05",
      },
    ];
  }

  const findings: GateFinding[] = [];
  const expectedArchs = (options.expectedArchitectures ?? []).map((a) => a.toLowerCase());
  if (expectedArchs.length > 0 && !expectedArchs.includes(pe.architecture)) {
    findings.push({
      id: "PKG-PORT-05",
      status: "fail",
      title: "PE アーキテクチャとマニフェスト指定が不一致",
      detail: `バイナリ実測=${pe.architecture} (${pe.format}) / 期待=[${expectedArchs.join(", ")}]`,
      remediation: `.installer.yaml の Architecture を ${pe.architecture} へ修正するか、正しいアーキテクチャのバイナリを配置してください。`,
      file: pe.filePath,
      guideRef: "PKG-PORT-05",
    });
  } else {
    findings.push({
      id: "PKG-PORT-05",
      status: "pass",
      title: "PE アーキテクチャ検査を通過",
      detail: `形式=${pe.format}, アーキテクチャ=${pe.architecture}, インポート DLL=${pe.importedDlls.length} 件`,
      file: pe.filePath,
      guideRef: "PKG-PORT-05",
    });
  }

  // PKG-PORT-01: 非標準ランタイム DLL 依存（VCRUNTIME140.dll 等）
  // マニフェスト経由時は対象アーキテクチャの全該当インストーラー実効依存セットすべてがカバーしていること
  const dependencySets: readonly (readonly string[])[] =
    options.effectiveDependencySets && options.effectiveDependencySets.length > 0
      ? options.effectiveDependencySets
      : [options.declaredDependencies ?? []];

  if (pe.nonStandardRuntimeDlls.length > 0) {
    const isVcRedistOnly = pe.nonStandardRuntimeDlls.every((dll) =>
      /^(?:vcruntime|msvcp|concrt|mfc|vcomp)\d+/i.test(dll),
    );
    const coveredByManifest =
      isVcRedistOnly &&
      dependencySets.every((depSet) => hasMatchingVcRedistDependency(pe.architecture, depSet));

    if (coveredByManifest) {
      findings.push({
        id: "PKG-PORT-01",
        status: "pass",
        title: "非標準 CRT DLL 依存は PackageDependencies でカバー済み",
        detail: `検出 DLL=[${pe.nonStandardRuntimeDlls.join(", ")}] に対し対応 VCRedist が宣言されています。`,
        file: pe.filePath,
        guideRef: "PKG-PORT-01",
      });
    } else {
      const vcPackageId =
        pe.architecture === "x86"
          ? "Microsoft.VCRedist.2015+.x86"
          : pe.architecture === "arm64"
            ? "Microsoft.VCRedist.2015+.arm64"
            : "Microsoft.VCRedist.2015+.x64";
      findings.push({
        id: "PKG-PORT-01",
        status: "fail",
        title: "クリーン VM で欠損しやすい非標準ランタイム DLL 依存を検出",
        detail: `未同梱 DLL: ${pe.nonStandardRuntimeDlls.join(", ")}（STATUS_DLL_NOT_FOUND / 0xC0000135 の原因）`,
        remediation: `CRT を静的リンク（+crt-static / /MT）するか、.installer.yaml の Dependencies.PackageDependencies へ ${vcPackageId} を追加（または必要 DLL を同梱）してください。`,
        file: pe.filePath,
        guideRef: "PKG-PORT-01",
      });
    }
  } else {
    findings.push({
      id: "PKG-PORT-01",
      status: "pass",
      title: "未同梱の非標準ランタイム DLL 依存なし",
      detail:
        "VCRUNTIME140.dll / MSVCP140.dll / MinGW ランタイム等の未同梱依存は検出されませんでした。",
      file: pe.filePath,
      guideRef: "PKG-PORT-01",
    });
  }

  // CMN-07: Authenticode 署名有無
  if (pe.hasAuthenticodeSignature) {
    findings.push({
      id: "CMN-07",
      status: "pass",
      title: "Authenticode 署名テーブルあり",
      detail: "PE Certificate Table が存在します。",
      file: pe.filePath,
      guideRef: "CMN-07",
    });
  } else {
    findings.push({
      id: "CMN-07",
      status: "warn",
      title: "未署名バイナリ（Authenticode 署名なし）",
      detail:
        "PE Certificate Table が存在しません（個人開発では許容されますが Defender 誤検知・来歴確認の対象）。",
      remediation:
        "先回り PR 本文テンプレートの Build Provenance & Code Signing 欄に公開 CI ビルド URL と未署名・Defender スキャン結果を明記してください。",
      file: pe.filePath,
      guideRef: "CMN-07",
    });
  }

  return findings;
}

function buildNextSteps(
  findings: readonly GateFinding[],
  includeSandboxReminder: boolean,
): string[] {
  const steps: string[] = [];
  const fails = findings.filter((f) => f.status === "fail");
  const warns = findings.filter((f) => f.status === "warn");

  if (fails.length > 0) {
    steps.push(
      `まず ${fails.length} 件の fail（${[...new Set(fails.map((f) => f.id))].join(", ")}）を解消してから再実行してください。`,
    );
  }
  if (warns.length > 0) {
    steps.push(
      `${warns.length} 件の warn（${[...new Set(warns.map((f) => f.id))].join(", ")}）を確認し、意図的な仕様は先回り PR 本文テンプレートへ明記してください。`,
    );
  }
  if (includeSandboxReminder) {
    steps.push(
      "クリーン Windows Sandbox で Tools/SandboxTest.ps1（または winget settings --enable LocalManifestFiles 後に winget install -m）による起動・ARP 突き合わせ検証を実施してください。",
    );
    steps.push(
      "PR 作成直後に @microsoft-github-policy-service agree で CLA 同意を完了してください。",
    );
  }
  return steps;
}

export async function runManifestGate(
  options: ManifestGateOptions,
  deps: GateRunnerDeps = {},
): Promise<GateReport> {
  const now = (deps.now ?? (() => new Date()))();
  const bundle = loadManifestBundle(options.manifestDir);
  const findings: GateFinding[] = [
    ...evaluateManifestRules(bundle, { minManifestVersion: options.minManifestVersion }),
  ];

  const netFindings = await runNetworkChecks(bundle, {
    offline: options.offline,
    verifySha256: options.verifySha256,
    timeoutMs: options.timeoutMs,
    fetchImpl: deps.fetchImpl,
  });
  findings.push(...netFindings);

  if (options.binaryPath) {
    const inspect = deps.inspectPe ?? inspectPeFile;
    const pe = inspect(options.binaryPath);
    const expectedArchitectures = getInstallerEntries(bundle)
      .map((entry) => (typeof entry.Architecture === "string" ? entry.Architecture : null))
      .filter((a): a is string => a !== null);
    const effectiveDependencySets = resolveEffectivePackageDependencySetsForArchitecture(
      bundle,
      pe.architecture,
    );
    findings.push(
      ...evaluatePeInspectionFindings(pe, {
        expectedArchitectures,
        effectiveDependencySets,
      }),
    );
  }

  if (options.sandboxResultPath) {
    const resolvedResultPath = resolve(options.sandboxResultPath);
    const sandboxResult = loadSandboxRunResultFile(resolvedResultPath);
    findings.push(...evaluateSandboxResult(bundle, sandboxResult, resolvedResultPath));
  }

  const summary = summarizeFindings(findings);
  return {
    passed: summary.fail === 0,
    target: bundle.manifestDir,
    checkedAt: now.toISOString(),
    summary,
    findings,
    nextSteps: buildNextSteps(findings, !options.sandboxResultPath),
  };
}

export function runSandboxPrepare(options: SandboxPrepareOptions): SandboxPrepareResult {
  const bundle = loadManifestBundle(options.manifestDir);
  return prepareSandboxWorkspace(bundle, options);
}

export function runSandboxEval(options: SandboxEvalOptions, deps: GateRunnerDeps = {}): GateReport {
  const now = (deps.now ?? (() => new Date()))();
  const bundle = loadManifestBundle(options.manifestDir);
  const resolvedResultPath = resolve(options.resultPath);
  const sandboxResult = loadSandboxRunResultFile(resolvedResultPath);
  const findings = evaluateSandboxResult(bundle, sandboxResult, resolvedResultPath);
  const summary = summarizeFindings(findings);
  return {
    passed: summary.fail === 0,
    target: bundle.manifestDir,
    checkedAt: now.toISOString(),
    summary,
    findings,
    nextSteps: buildNextSteps(findings, false),
  };
}

export function formatSandboxPrepareText(result: SandboxPrepareResult): string {
  const lines: string[] = [
    `[verify-gate] SANDBOX PREPARED — ${result.packageIdentifier ?? result.manifestDir}`,
    `Output:   ${result.outputDir}`,
    `WSB:      ${result.wsbPath}`,
    `Sandbox:  ${result.sandboxScriptPath}`,
    `Launcher: ${result.hostLauncherPath}`,
    `Result:   ${result.resultJsonPath}`,
    `Probes:   ${result.probeCommands.length > 0 ? result.probeCommands.join(", ") : "(none inferred)"}`,
    `Verify:   ${result.verifyCommands.length > 0 ? result.verifyCommands.join(", ") : "(default --version/--help)"}`,
    "",
    "Next Steps:",
    ...result.nextSteps.map((step) => `- ${step}`),
  ];
  return lines.join("\n");
}

export function runBinaryGate(options: BinaryGateOptions, deps: GateRunnerDeps = {}): GateReport {
  const now = (deps.now ?? (() => new Date()))();
  const inspect = deps.inspectPe ?? inspectPeFile;
  const pe = inspect(options.binaryPath);
  const findings = evaluatePeInspectionFindings(pe, {
    expectedArchitectures: options.expectedArchitecture ? [options.expectedArchitecture] : [],
    declaredDependencies: options.declaredDependencies ?? [],
  });
  const summary = summarizeFindings(findings);
  return {
    passed: summary.fail === 0,
    target: resolve(options.binaryPath),
    checkedAt: now.toISOString(),
    summary,
    findings,
    nextSteps: buildNextSteps(findings, false),
  };
}

export function formatGateReportText(report: GateReport): string {
  const verdict = report.passed ? "PASS" : "FAIL";
  const lines: string[] = [
    `[verify-gate] ${verdict} — ${report.target}`,
    `Summary: pass=${report.summary.pass}, warn=${report.summary.warn}, fail=${report.summary.fail}, skip=${report.summary.skip}`,
    "",
  ];
  for (const f of report.findings) {
    const tag = f.status.toUpperCase().padEnd(4);
    const loc = f.file ? ` (${f.file})` : "";
    lines.push(`[${tag}] ${f.id}${loc}: ${f.title}`);
    lines.push(`       ${f.detail}`);
    if (f.remediation) {
      lines.push(`       Fix: ${f.remediation}`);
    }
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next Steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  return lines.join("\n");
}
