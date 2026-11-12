import { describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import worker, { createAppJwt, dispatchObserveWorkflow, type Env } from "../src/index.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const env: Env = {
  GITHUB_APP_CLIENT_ID: "Iv1.test",
  GITHUB_APP_PRIVATE_KEY: pem,
  GITHUB_OWNER: "scottlz0310",
  GITHUB_REPO: "winget-observatory",
  GITHUB_WORKFLOW_ID: "observe.yml",
  GITHUB_REF: "main",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("createAppJwt", () => {
  it("RS256 の JWT を iss / iat / exp 付きで生成する", async () => {
    const jwt = await createAppJwt("Iv1.test", pem, 1_000_000);
    const [header, payload] = jwt.split(".").slice(0, 2);
    expect(JSON.parse(atob(header))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(atob(payload))).toEqual({
      iss: "Iv1.test",
      iat: 999_940,
      exp: 1_000_540,
    });
  });

  it("PKCS#1 形式の鍵は変換を促して拒否する", async () => {
    await expect(
      createAppJwt(
        "Iv1.test",
        "-----BEGIN RSA PRIVATE KEY-----\nAA\n-----END RSA PRIVATE KEY-----",
        0,
      ),
    ).rejects.toThrow("PKCS#8");
  });
});

describe("dispatchObserveWorkflow", () => {
  it("Installation Token を発行して workflow_dispatch を実行する（Installation ID 未指定で動的解決）", async () => {
    const fetcher = mock()
      .mockResolvedValueOnce(json({ id: 42 }))
      .mockResolvedValueOnce(json({ token: "ghs_x" }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await dispatchObserveWorkflow(env, fetcher as unknown as typeof fetch, 1_000_000);

    const calls = fetcher.mock.calls.map((call) => {
      const [url, init] = call as [string, RequestInit];
      return [
        init.method,
        url,
        (init.headers as Record<string, string>).Authorization.startsWith("Bearer ghs_"),
        init.body,
      ];
    });

    expect(calls).toEqual([
      [
        "GET",
        "https://api.github.com/repos/scottlz0310/winget-observatory/installation",
        false,
        undefined,
      ],
      [
        "POST",
        "https://api.github.com/app/installations/42/access_tokens",
        false,
        JSON.stringify({
          repositories: ["winget-observatory"],
          permissions: { actions: "write" },
        }),
      ],
      [
        "POST",
        "https://api.github.com/repos/scottlz0310/winget-observatory/actions/workflows/observe.yml/dispatches",
        true,
        JSON.stringify({ ref: "main" }),
      ],
    ]);
  });

  it("GITHUB_INSTALLATION_ID が指定されている場合は動的解決をスキップする", async () => {
    const fetcher = mock()
      .mockResolvedValueOnce(json({ token: "ghs_preset" }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const envWithId: Env = {
      ...env,
      GITHUB_INSTALLATION_ID: "999",
    };

    await dispatchObserveWorkflow(envWithId, fetcher as unknown as typeof fetch, 1_000_000);

    const calls = fetcher.mock.calls.map((call) => {
      const [url, init] = call as [string, RequestInit];
      return [init.method, url];
    });

    expect(calls).toEqual([
      ["POST", "https://api.github.com/app/installations/999/access_tokens"],
      [
        "POST",
        "https://api.github.com/repos/scottlz0310/winget-observatory/actions/workflows/observe.yml/dispatches",
      ],
    ]);
  });

  it.each([
    ["Installation 取得", 0],
    ["Token 発行", 1],
    ["dispatch", 2],
  ])("%s が失敗したらエラーを伝播する", async (_name, failAt) => {
    const responses = [
      () => json({ id: 42 }),
      () => json({ token: "ghs_x" }, 201),
      () => new Response(null, { status: 204 }),
    ];
    responses[failAt] = () => new Response("denied", { status: 403 });
    const fetcher = mock();
    for (const make of responses) {
      fetcher.mockImplementationOnce(async () => make());
    }

    await expect(
      dispatchObserveWorkflow(env, fetcher as unknown as typeof fetch, 0),
    ).rejects.toThrow("403");
  });

  it("GITHUB_OWNER / GITHUB_REPO が欠落している場合はエラーにする", async () => {
    await expect(
      dispatchObserveWorkflow({ ...env, GITHUB_OWNER: "" }, mock() as unknown as typeof fetch),
    ).rejects.toThrow("GITHUB_OWNER");
  });

  it("GITHUB_WORKFLOW_ID / GITHUB_REF が欠落している場合はエラーにする", async () => {
    await expect(
      dispatchObserveWorkflow(
        { ...env, GITHUB_WORKFLOW_ID: "" },
        mock() as unknown as typeof fetch,
      ),
    ).rejects.toThrow("GITHUB_WORKFLOW_ID");
  });
});

describe("worker handlers", () => {
  it("fetch ハンドラは 404 Not Found を返す", async () => {
    const response = await worker.fetch(new Request("https://worker.local/"));
    expect(response.status).toBe(404);
  });

  it("scheduled ハンドラは dispatchObserveWorkflow を呼び出す", async () => {
    const fetcher = mock()
      .mockResolvedValueOnce(json({ id: 42 }))
      .mockResolvedValueOnce(json({ token: "ghs_x" }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetcher as unknown as typeof fetch;
    try {
      await worker.scheduled(null, env);
      expect(fetcher.mock.calls.length).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
