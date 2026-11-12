import { describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import {
  buildWorkerSecretsJson,
  DEFAULT_CLIENT_ID_VAR,
  DEFAULT_SOURCE_REPO,
  DEFAULT_WORKER_CONFIG,
  parseCliArgs,
  putWorkerSecrets,
  resolveClientId,
  toPkcs8Pem,
} from "../../scripts/sync-worker-secrets.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1Pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("toPkcs8Pem", () => {
  it("PKCS#1 形式の鍵を PKCS#8 形式へ変換する", () => {
    expect(pkcs1Pem).toContain("BEGIN RSA PRIVATE KEY");
    const converted = toPkcs8Pem(pkcs1Pem);
    expect(converted).toContain("BEGIN PRIVATE KEY");
    expect(converted).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("すでに PKCS#8 形式の鍵はそのまま PKCS#8 形式で出力する", () => {
    const converted = toPkcs8Pem(pkcs8Pem);
    expect(converted).toContain("BEGIN PRIVATE KEY");
    expect(converted).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("壊れた PEM 文字列は例外をスローする", () => {
    expect(() => toPkcs8Pem("invalid key content")).toThrow("PKCS#8 変換に失敗しました");
  });
});

describe("buildWorkerSecretsJson", () => {
  it("Client ID と秘密鍵から Secrets JSON を生成する", () => {
    const jsonStr = buildWorkerSecretsJson("test-client-id", pkcs1Pem);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.GITHUB_APP_CLIENT_ID).toBe("test-client-id");
    expect(parsed.GITHUB_APP_PRIVATE_KEY).toContain("BEGIN PRIVATE KEY");
    expect(parsed.GITHUB_INSTALLATION_ID).toBeUndefined();
  });

  it("Installation ID が指定されている場合は JSON に含める", () => {
    const jsonStr = buildWorkerSecretsJson("test-client-id", pkcs8Pem, "12345");
    const parsed = JSON.parse(jsonStr);
    expect(parsed.GITHUB_APP_CLIENT_ID).toBe("test-client-id");
    expect(parsed.GITHUB_APP_PRIVATE_KEY).toContain("BEGIN PRIVATE KEY");
    expect(parsed.GITHUB_INSTALLATION_ID).toBe("12345");
  });

  it("Client ID が空の場合は例外をスローする", () => {
    expect(() => buildWorkerSecretsJson("", pkcs8Pem)).toThrow("Client ID が空です");
    expect(() => buildWorkerSecretsJson("   ", pkcs8Pem)).toThrow("Client ID が空です");
  });
});

describe("resolveClientId", () => {
  it("明示的な Client ID が指定されていればそれを返す", () => {
    const id = resolveClientId("explicit-id");
    expect(id).toBe("explicit-id");
  });

  it("明示指定がなく環境変数が設定されていればそれを返す", () => {
    const original = process.env.GITHUB_APP_CLIENT_ID;
    try {
      process.env.GITHUB_APP_CLIENT_ID = "env-client-id";
      const id = resolveClientId();
      expect(id).toBe("env-client-id");
    } finally {
      process.env.GITHUB_APP_CLIENT_ID = original;
    }
  });

  it("指定がない場合は gh runner を呼び出してリポジトリの Variable から取得する", () => {
    const original = process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_ID;
    try {
      const runner = mock().mockReturnValue("var-client-id\n");
      const id = resolveClientId(undefined, "test-owner/test-repo", runner);
      expect(id).toBe("var-client-id");
      expect(runner).toHaveBeenCalledWith([
        "variable",
        "get",
        DEFAULT_CLIENT_ID_VAR,
        "-R",
        "test-owner/test-repo",
      ]);
    } finally {
      process.env.GITHUB_APP_CLIENT_ID = original;
    }
  });

  it("gh runner が失敗した場合は例外をスローする", () => {
    const original = process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_ID;
    try {
      const runner = mock().mockImplementation(() => {
        throw new Error("command failed");
      });
      expect(() => resolveClientId(undefined, DEFAULT_SOURCE_REPO, runner)).toThrow(
        "Client ID を取得できませんでした",
      );
    } finally {
      process.env.GITHUB_APP_CLIENT_ID = original;
    }
  });
});

describe("putWorkerSecrets", () => {
  it("Wrangler secret bulk を正しい引数と入力で呼び出す", () => {
    const runner = mock().mockReturnValue({ status: 0, stdout: "Success", stderr: "" });
    const output = putWorkerSecrets('{"key":"value"}', DEFAULT_WORKER_CONFIG, runner);

    expect(output).toBe("Success");
    expect(runner).toHaveBeenCalledWith(
      "bunx",
      ["wrangler", "secret", "bulk", "--config", DEFAULT_WORKER_CONFIG],
      '{"key":"value"}',
    );
  });

  it("runner が失敗したらエラーをスローする", () => {
    const runner = mock().mockReturnValue({ status: 1, stdout: "", stderr: "auth required" });
    expect(() => putWorkerSecrets('{"key":"value"}', DEFAULT_WORKER_CONFIG, runner)).toThrow(
      "Wrangler secret bulk failed: auth required",
    );
  });
});

describe("parseCliArgs", () => {
  it("引数からオプションとファイルパスを解析する", () => {
    const options = parseCliArgs([
      "--client-id",
      "my-client",
      "--installation-id",
      "789",
      "--source-repo",
      "my-owner/my-repo",
      "--config",
      "custom/wrangler.toml",
      "path/to/key.pem",
    ]);

    expect(options).toEqual({
      clientId: "my-client",
      installationId: "789",
      sourceRepo: "my-owner/my-repo",
      configPath: "custom/wrangler.toml",
      pemPath: "path/to/key.pem",
    });
  });
});
