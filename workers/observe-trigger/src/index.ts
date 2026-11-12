export interface Env {
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_ID: string;
  GITHUB_REF: string;
  GITHUB_INSTALLATION_ID?: string;
}

const API = "https://api.github.com";

function base64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END)[A-Z ]*-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der.buffer;
}

export async function createAppJwt(
  clientId: string,
  privateKeyPem: string,
  nowSec: number,
): Promise<string> {
  // GitHub App が発行する秘密鍵は PKCS#1 だが、WebCrypto は PKCS#8 しか読めない。
  if (privateKeyPem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY が PKCS#1 形式です。`openssl pkcs8 -topk8 -nocrypt` で PKCS#8 に変換してください",
    );
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // 時計のずれを許容するため iat を 60 秒戻す。有効期間は GitHub の上限 10 分以内。
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iss: clientId, iat: nowSec - 60, exp: nowSec + 540 }));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

async function github<T>(
  fetcher: typeof fetch,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const response = await fetcher(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "winget-observatory-observe-trigger",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error(
      `GitHub API request failed: ${method} ${path} returned ${response.status} ${detail}`,
    );
    throw new Error(`${method} ${path} が失敗しました: ${response.status} ${detail}`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export async function dispatchObserveWorkflow(
  env: Env,
  fetcher: typeof fetch = fetch,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_OWNER および GITHUB_REPO を設定してください: owner=${owner}, repo=${repo}`,
    );
  }
  const workflowId = env.GITHUB_WORKFLOW_ID;
  const ref = env.GITHUB_REF;
  if (!workflowId || !ref) {
    throw new Error(
      `GITHUB_WORKFLOW_ID および GITHUB_REF を設定してください: workflowId=${workflowId}, ref=${ref}`,
    );
  }

  const jwt = await createAppJwt(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_PRIVATE_KEY, nowSec);

  let installationId = env.GITHUB_INSTALLATION_ID
    ? Number.parseInt(env.GITHUB_INSTALLATION_ID, 10)
    : undefined;

  if (!installationId || Number.isNaN(installationId)) {
    const installation = await github<{ id: number }>(
      fetcher,
      "GET",
      `/repos/${owner}/${repo}/installation`,
      jwt,
    );
    installationId = installation.id;
  }

  const { token } = await github<{ token: string }>(
    fetcher,
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    { repositories: [repo], permissions: { actions: "write" } },
  );

  await github<undefined>(
    fetcher,
    "POST",
    `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
    token,
    { ref },
  );
}

export default {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    await dispatchObserveWorkflow(env);
  },
  async fetch(_request: Request): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};
