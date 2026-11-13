#!/usr/bin/env bun
/**
 * GitHub App の秘密鍵 (PEM) を PKCS#8 に変換し、Cloudflare Workers の Secret に安全に一括登録する。
 *
 * 既存の共有 GitHub App (scottlz0310-global-automerge) から Client ID を自動取得するか、
 * 手動で Client ID を指定して、秘密鍵を Cloudflare Workers (workers/observe-trigger) へ登録します。
 * 秘密鍵はコマンドライン引数やディスクに平文で残さず、メモリから標準入力を経由して wrangler secret bulk に渡します。
 *
 * 前提: gh CLI および wrangler (bunx wrangler login) にログイン済み。
 *
 * 使い方:
 *   bun scripts/sync-worker-secrets.ts <秘密鍵.pem>
 *   bun scripts/sync-worker-secrets.ts --client-id <id> <秘密鍵.pem>
 */
import { spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_SOURCE_REPO = "scottlz0310/renovate-config";
export const DEFAULT_CLIENT_ID_VAR = "GLOBAL_AUTOMERGE_CLIENT_ID";
export const DEFAULT_WORKER_CONFIG = "workers/observe-trigger/wrangler.toml";

export interface SyncSecretsOptions {
  pemPath?: string;
  pemContent?: string;
  clientId?: string;
  installationId?: string;
  sourceRepo?: string;
  configPath?: string;
}

export function toPkcs8Pem(pem: string | Buffer): string {
  try {
    return createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  } catch (err) {
    throw new Error(
      `秘密鍵の PKCS#8 変換に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function buildWorkerSecretsJson(
  clientId: string,
  privateKeyPem: string | Buffer,
  installationId?: string,
): string {
  if (!clientId?.trim()) {
    throw new Error("Client ID が空です");
  }
  const secrets: Record<string, string> = {
    GITHUB_APP_CLIENT_ID: clientId.trim(),
    GITHUB_APP_PRIVATE_KEY: toPkcs8Pem(privateKeyPem),
  };
  if (installationId?.trim()) {
    secrets.GITHUB_INSTALLATION_ID = installationId.trim();
  }
  return JSON.stringify(secrets);
}

export function resolveClientId(
  explicitClientId?: string,
  sourceRepo: string = DEFAULT_SOURCE_REPO,
  ghRunner: (args: string[]) => string = runGh,
): string {
  if (explicitClientId?.trim()) {
    return explicitClientId.trim();
  }
  if (process.env.GITHUB_APP_CLIENT_ID?.trim()) {
    return process.env.GITHUB_APP_CLIENT_ID.trim();
  }

  // 共有 GitHub App の Variable (GLOBAL_AUTOMERGE_CLIENT_ID) から自動取得
  try {
    const output = ghRunner(["variable", "get", DEFAULT_CLIENT_ID_VAR, "-R", sourceRepo]);
    const trimmed = output.trim();
    if (trimmed) return trimmed;
  } catch (err) {
    throw new Error(
      `GitHub Variable (${DEFAULT_CLIENT_ID_VAR} @ ${sourceRepo}) から Client ID を取得できませんでした: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error(
    "Client ID を特定できませんでした。--client-id または GITHUB_APP_CLIENT_ID を指定してください",
  );
}

export function runGh(args: string[]): string {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "").trim()}`,
    );
  }
  return result.stdout;
}

export function putWorkerSecrets(
  secretsJson: string,
  configPath: string = DEFAULT_WORKER_CONFIG,
  runner: (
    cmd: string,
    args: string[],
    input: string,
  ) => { status: number | null; stdout: string; stderr: string } = defaultWranglerRunner,
): string {
  // Windows でも cmd.exe の再解釈やシェルメタ文字の誤解釈を防ぐため、
  // shell: false で Bun 実行バイナリ (process.execPath x wrangler ...) を直接呼び出す
  const cmd = process.execPath;
  const args = ["x", "wrangler", "secret", "bulk", "--config", configPath];
  const result = runner(cmd, args, secretsJson);
  if (result.status !== 0) {
    throw new Error(`Wrangler secret bulk failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

export function defaultWranglerRunner(cmd: string, args: string[], input: string) {
  return spawnSync(cmd, args, {
    input,
    encoding: "utf8",
    shell: false,
  });
}

export function parseCliArgs(argv: string[]): SyncSecretsOptions {
  const options: SyncSecretsOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--client-id") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("オプション --client-id の値が指定されていません");
      }
      options.clientId = argv[++i];
    } else if (arg === "--installation-id") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("オプション --installation-id の値が指定されていません");
      }
      options.installationId = argv[++i];
    } else if (arg === "--source-repo") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("オプション --source-repo の値が指定されていません");
      }
      options.sourceRepo = argv[++i];
    } else if (arg === "--config") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error("オプション --config の値が指定されていません");
      }
      options.configPath = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`未知のオプションです: ${arg}`);
    } else if (!options.pemPath) {
      options.pemPath = arg;
    } else {
      throw new Error(`予期しない追加の引数です: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`
使い方:
  bun scripts/sync-worker-secrets.ts [オプション] <秘密鍵.pem>

オプション:
  --client-id <id>          GitHub App の Client ID（未指定時は ${DEFAULT_SOURCE_REPO} の Variable から自動取得）
  --installation-id <id>    GitHub App の Installation ID（省略時は Worker 実行時に動的解決）
  --source-repo <repo>      Client ID 取得元リポジトリ（既定: ${DEFAULT_SOURCE_REPO}）
  --config <path>           Wrangler 設定ファイル（既定: ${DEFAULT_WORKER_CONFIG}）
  -h, --help                このヘルプを表示
`);
}

export interface RunSyncDependencies {
  resolveClientIdFn?: typeof resolveClientId;
  putWorkerSecretsFn?: typeof putWorkerSecrets;
  stdinReader?: () => Promise<string>;
}

export async function runSync(
  options: SyncSecretsOptions,
  deps: RunSyncDependencies = {},
): Promise<string> {
  let pemContent = options.pemContent;
  if (!pemContent) {
    if (options.pemPath) {
      if (!existsSync(options.pemPath)) {
        throw new Error(`指定された秘密鍵ファイルが見つかりません: ${options.pemPath}`);
      }
      pemContent = readFileSync(options.pemPath, "utf8");
    } else if (process.env.GITHUB_APP_PRIVATE_KEY) {
      pemContent = process.env.GITHUB_APP_PRIVATE_KEY;
    } else if (deps.stdinReader) {
      pemContent = await deps.stdinReader();
    } else if (!process.stdin.isTTY) {
      pemContent = await Bun.stdin.text();
    }
  }

  if (!pemContent?.trim()) {
    throw new Error(
      "秘密鍵が指定されていません。<秘密鍵.pem> のパスを引数に指定するか、標準入力で渡してください",
    );
  }

  const resolver = deps.resolveClientIdFn ?? resolveClientId;
  const clientId = resolver(options.clientId, options.sourceRepo);
  console.log(`[Secrets Sync] Client ID を解決しました: ${clientId}`);

  const secretsJson = buildWorkerSecretsJson(
    clientId,
    pemContent,
    options.installationId || process.env.GITHUB_INSTALLATION_ID,
  );

  const configPath = options.configPath || DEFAULT_WORKER_CONFIG;
  console.log(`[Secrets Sync] Wrangler secret bulk を実行中 (${configPath})...`);
  const putter = deps.putWorkerSecretsFn ?? putWorkerSecrets;
  const output = putter(secretsJson, configPath);
  console.log(output || "[Secrets Sync] 登録完了");
  return output || "[Secrets Sync] 登録完了";
}

if (import.meta.main) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    await runSync(options);
  } catch (err) {
    console.error(`[Error] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
