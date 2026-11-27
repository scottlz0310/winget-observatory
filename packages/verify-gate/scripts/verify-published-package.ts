import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export const EXIT_CODE_VERIFIED = 0;
export const EXIT_CODE_MISSING = 3;
export const EXIT_CODE_PROPAGATION_TIMEOUT = 4;

export interface SlsaProvenanceCheckInput {
  attestationsResponse: unknown;
  expectedPackageName: string;
  expectedVersion: string;
  expectedRepository: string;
  expectedWorkflowPath: string;
  expectedCommitSha: string;
  expectedTarballSha512Hex: string;
}

export interface VerifyPublishedPackageDeps {
  npmView?: (spec: string) => string;
  fetchJson?: (url: string) => Promise<unknown>;
  fetchBytes?: (url: string) => Promise<Buffer>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface AttestationEntry {
  predicateType?: unknown;
  bundle?: {
    dsseEnvelope?: {
      payload?: unknown;
    };
  };
}

class PendingRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingRegistryError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function encodePackageNameForPurl(packageName: string): string {
  return packageName.startsWith("@") ? `%40${packageName.slice(1)}` : packageName;
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof PendingRegistryError) {
    return true;
  }
  const err = error as {
    status?: unknown;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    message?: string;
  };
  if (err?.status === 404) {
    return true;
  }
  const combined = `${String(err?.stderr ?? "")}\n${String(err?.stdout ?? "")}\n${err?.message ?? ""}`;
  return /E404|404 Not Found|No match found|\bHTTP 404\b/i.test(combined);
}

function parseNonNegativeNumber(raw: string | undefined, flagName: string): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${flagName} には 0 以上の数値を指定してください: ${String(raw)}`);
  }
  return value;
}

function parsePositiveNumber(raw: string | undefined, flagName: string): number {
  const value = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} には 0 より大きい数値を指定してください: ${String(raw)}`);
  }
  return value;
}

/**
 * npm レジストリの attestations 応答から SLSA v1 provenance を検証し、
 * パッケージ・版・tarball SHA-512・リポジトリ・ワークフローパス・固定コミット SHA の完全一致を確認する。
 */
export function verifySlsaProvenance(input: SlsaProvenanceCheckInput): {
  ok: boolean;
  reason?: string;
} {
  const root = asRecord(input.attestationsResponse);
  const list = Array.isArray(root?.attestations) ? (root.attestations as AttestationEntry[]) : null;
  if (!list || list.length === 0) {
    return { ok: false, reason: "attestations 配列が空です" };
  }

  const slsaEntry = list.find(
    (entry) =>
      typeof entry.predicateType === "string" &&
      entry.predicateType === "https://slsa.dev/provenance/v1",
  );
  if (!slsaEntry) {
    return { ok: false, reason: "https://slsa.dev/provenance/v1 の attestation が見つかりません" };
  }

  const payloadB64 = slsaEntry.bundle?.dsseEnvelope?.payload;
  if (typeof payloadB64 !== "string" || !payloadB64.trim()) {
    return { ok: false, reason: "DSSE payload が欠落しています" };
  }

  let statement: Record<string, unknown> | null = null;
  try {
    const decoded = Buffer.from(payloadB64, "base64").toString("utf8");
    statement = asRecord(JSON.parse(decoded));
  } catch (error) {
    return {
      ok: false,
      reason: `DSSE payload のデコードに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!statement) {
    return { ok: false, reason: "DSSE statement がオブジェクトではありません" };
  }

  const expectedPurl = `pkg:npm/${encodePackageNameForPurl(input.expectedPackageName)}@${input.expectedVersion}`;
  const expectedSha512 = input.expectedTarballSha512Hex.toLowerCase();
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  const matchedSubject = subjects.some((raw) => {
    const s = asRecord(raw);
    const digest = asRecord(s?.digest);
    return (
      s?.name === expectedPurl &&
      typeof digest?.sha512 === "string" &&
      digest.sha512.toLowerCase() === expectedSha512
    );
  });
  if (!matchedSubject) {
    return {
      ok: false,
      reason: `SLSA subject が一致しません (expected=${expectedPurl}, sha512=${expectedSha512.slice(0, 16)}...)`,
    };
  }

  const predicate = asRecord(statement.predicate);
  const buildDef = asRecord(predicate?.buildDefinition);
  const extParams = asRecord(buildDef?.externalParameters);
  const workflow = asRecord(extParams?.workflow);
  const expectedRepoUrl = `https://github.com/${input.expectedRepository}`;

  if (workflow?.repository !== expectedRepoUrl) {
    return {
      ok: false,
      reason: `SLSA workflow.repository が不一致です (expected=${expectedRepoUrl}, actual=${String(workflow?.repository)})`,
    };
  }
  if (workflow?.path !== input.expectedWorkflowPath) {
    return {
      ok: false,
      reason: `SLSA workflow.path が不一致です (expected=${input.expectedWorkflowPath}, actual=${String(workflow?.path)})`,
    };
  }

  const deps = Array.isArray(buildDef?.resolvedDependencies) ? buildDef.resolvedDependencies : [];
  const expectedCommit = input.expectedCommitSha.toLowerCase();
  const expectedGitPrefix = `git+https://github.com/${input.expectedRepository}@`;
  const matchedCommit = deps.some((raw) => {
    const d = asRecord(raw);
    const digest = asRecord(d?.digest);
    const uri = typeof d?.uri === "string" ? d.uri : "";
    return (
      uri.startsWith(expectedGitPrefix) &&
      typeof digest?.gitCommit === "string" &&
      digest.gitCommit.toLowerCase() === expectedCommit
    );
  });
  if (!matchedCommit) {
    return {
      ok: false,
      reason: `SLSA resolvedDependencies に期待コミット ${expectedCommit} が見つかりません`,
    };
  }

  return { ok: true };
}

function collectFilesRecursive(rootDir: string, currentDir = rootDir): string[] {
  const results: string[] = [];
  for (const name of readdirSync(currentDir).sort((a, b) => a.localeCompare(b))) {
    const full = join(currentDir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectFilesRecursive(rootDir, full));
    } else if (st.isFile()) {
      results.push(relative(rootDir, full).replaceAll("\\", "/"));
    }
  }
  return results;
}

/**
 * 展開済み 2 ディレクトリのファイル集合と各ファイルのバイト完全一致を検証する。
 * npm pack 再実行時の tar mtime 差を吸収しつつ、1 バイトでも内容差があれば拒否する。
 */
export function compareExtractedDirectories(
  dirA: string,
  dirB: string,
): { ok: boolean; reason?: string } {
  const filesA = collectFilesRecursive(dirA);
  const filesB = collectFilesRecursive(dirB);
  if (filesA.length !== filesB.length || filesA.some((f, i) => f !== filesB[i])) {
    return {
      ok: false,
      reason: `tarball 内ファイル一覧が一致しません (expected=[${filesA.join(",")}], registry=[${filesB.join(",")}])`,
    };
  }
  for (const rel of filesA) {
    const bufA = readFileSync(join(dirA, rel));
    const bufB = readFileSync(join(dirB, rel));
    if (!bufA.equals(bufB)) {
      return {
        ok: false,
        reason: `tarball 内ファイル内容が不一致です: ${rel}`,
      };
    }
  }
  return { ok: true };
}

function defaultNpmView(spec: string): string {
  return execFileSync("npm", ["view", spec, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) {
    throw new PendingRegistryError(`HTTP 404 (${url})`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${url})`);
  }
  return res.json();
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) {
    throw new PendingRegistryError(`HTTP 404 (${url})`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${url})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolveTimer) => setTimeout(resolveTimer, ms));
}

async function verifyOnce(params: {
  pkgName: string;
  version: string;
  repo: string;
  workflowPath: string;
  commitSha: string;
  expectedTarball: string;
  npmView: (spec: string) => string;
  fetchJson: (url: string) => Promise<unknown>;
  fetchBytes: (url: string) => Promise<Buffer>;
}): Promise<{ actualSha512Hex: string }> {
  let metadataRaw: string;
  try {
    metadataRaw = params.npmView(`${params.pkgName}@${params.version}`);
  } catch (error) {
    const err = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
    const combined = `${String(err.stderr ?? "")}\n${String(err.stdout ?? "")}\n${err.message ?? ""}`;
    if (isNotFoundError(error)) {
      throw new PendingRegistryError(
        `npm view が未反映です (404): ${params.pkgName}@${params.version}`,
      );
    }
    throw new Error(`npm view に失敗しました: ${combined.trim()}`);
  }

  const metadata = asRecord(JSON.parse(metadataRaw));
  const dist = asRecord(metadata?.dist);
  const tarballUrl = typeof dist?.tarball === "string" ? dist.tarball : "";
  const integrity = typeof dist?.integrity === "string" ? dist.integrity : "";
  const attestations = asRecord(dist?.attestations);
  const attestationsUrl = typeof attestations?.url === "string" ? attestations.url : "";

  if (!tarballUrl || !integrity || !attestationsUrl) {
    throw new Error(
      `レジストリメタデータに必要な dist 情報が不足しています (tarball=${Boolean(tarballUrl)}, integrity=${Boolean(integrity)}, attestations=${Boolean(attestationsUrl)})`,
    );
  }

  let registryBytes: Buffer;
  try {
    registryBytes = await params.fetchBytes(tarballUrl);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new PendingRegistryError(`tarball が未反映です (404): ${tarballUrl}`);
    }
    throw error;
  }

  const actualSha512Base64 = createHash("sha512").update(registryBytes).digest("base64");
  const actualSha512Hex = createHash("sha512").update(registryBytes).digest("hex");
  if (integrity !== `sha512-${actualSha512Base64}`) {
    throw new Error(
      `tarball の integrity が一致しません (expected=${integrity}, actual=sha512-${actualSha512Base64})`,
    );
  }

  let attestationsResponse: unknown;
  try {
    attestationsResponse = await params.fetchJson(attestationsUrl);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new PendingRegistryError(`attestations が未反映です (404): ${attestationsUrl}`);
    }
    throw error;
  }

  const slsaCheck = verifySlsaProvenance({
    attestationsResponse,
    expectedPackageName: params.pkgName,
    expectedVersion: params.version,
    expectedRepository: params.repo,
    expectedWorkflowPath: params.workflowPath,
    expectedCommitSha: params.commitSha,
    expectedTarballSha512Hex: actualSha512Hex,
  });
  if (!slsaCheck.ok) {
    throw new Error(`SLSA provenance 検証失敗: ${slsaCheck.reason}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), "vg-npm-verify-"));
  try {
    const regTgz = join(tmp, "registry.tgz");
    const dirExp = join(tmp, "expected");
    const dirReg = join(tmp, "registry");
    mkdirSync(dirExp, { recursive: true });
    mkdirSync(dirReg, { recursive: true });
    await Bun.write(regTgz, registryBytes);
    execFileSync("tar", ["-xzf", params.expectedTarball, "-C", dirExp]);
    execFileSync("tar", ["-xzf", regTgz, "-C", dirReg]);
    const diff = compareExtractedDirectories(dirExp, dirReg);
    if (!diff.ok) {
      throw new Error(`公開済み tarball の内容検証に失敗: ${diff.reason}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return { actualSha512Hex };
}

export async function runVerifyPublishedPackage(
  argv: readonly string[],
  deps: VerifyPublishedPackageDeps = {},
): Promise<number> {
  const npmView = deps.npmView ?? defaultNpmView;
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  let pkgName = "";
  let version = "";
  let repo = "";
  let workflowPath = ".github/workflows/release.yml";
  let commitSha = "";
  let expectedTarball = "";
  let allowMissing = false;
  let waitSeconds = 0;
  let pollIntervalSeconds = 30;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package") pkgName = argv[++i] ?? "";
    else if (arg === "--version") version = (argv[++i] ?? "").replace(/^v/, "");
    else if (arg === "--repo") repo = argv[++i] ?? "";
    else if (arg === "--workflow-path") workflowPath = argv[++i] ?? "";
    else if (arg === "--commit") commitSha = argv[++i] ?? "";
    else if (arg === "--expected-tarball") expectedTarball = resolve(argv[++i] ?? "");
    else if (arg === "--allow-missing") allowMissing = true;
    else if (arg === "--wait-seconds")
      waitSeconds = parseNonNegativeNumber(argv[++i], "--wait-seconds");
    else if (arg === "--poll-interval-seconds")
      pollIntervalSeconds = parsePositiveNumber(argv[++i], "--poll-interval-seconds");
    else throw new Error(`未知の引数です: ${arg}`);
  }

  if (!pkgName || !version || !repo || !commitSha || !expectedTarball) {
    throw new Error(
      "--package / --version / --repo / --commit / --expected-tarball はすべて必須です",
    );
  }
  if (allowMissing && waitSeconds > 0) {
    throw new Error("--allow-missing と --wait-seconds は同時に指定できません");
  }

  const startMs = now();
  const deadlineMs = startMs + waitSeconds * 1000;
  const pollIntervalMs = pollIntervalSeconds * 1000;
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const { actualSha512Hex } = await verifyOnce({
        pkgName,
        version,
        repo,
        workflowPath,
        commitSha,
        expectedTarball,
        npmView,
        fetchJson,
        fetchBytes,
      });
      stdout(
        `VERIFIED ${pkgName}@${version} commit=${commitSha} sha512=${actualSha512Hex.slice(0, 16)}... attempts=${attempt}`,
      );
      return EXIT_CODE_VERIFIED;
    } catch (error) {
      if (!(error instanceof PendingRegistryError)) {
        throw error;
      }
      if (allowMissing) {
        stdout(`MISSING ${pkgName}@${version}`);
        return EXIT_CODE_MISSING;
      }
      if (waitSeconds <= 0) {
        throw new Error(`npm view に失敗しました: ${error.message}`);
      }

      const currentMs = now();
      const remainingMs = deadlineMs - currentMs;
      if (remainingMs <= 0) {
        const waitedSeconds = Math.round((currentMs - startMs) / 1000);
        stderr(
          `PROPAGATION_TIMEOUT ${pkgName}@${version} waited=${waitedSeconds}s attempts=${attempt}: ${error.message}`,
        );
        return EXIT_CODE_PROPAGATION_TIMEOUT;
      }

      const sleepMs = Math.min(pollIntervalMs, remainingMs);
      const elapsedSeconds = Math.round((currentMs - startMs) / 1000);
      stdout(
        `WAITING ${pkgName}@${version} attempt=${attempt} elapsed=${elapsedSeconds}s/${waitSeconds}s nextRetry=${Math.ceil(sleepMs / 1000)}s (${error.message})`,
      );
      await sleep(sleepMs);
    }
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runVerifyPublishedPackage(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[verify-published-package] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
