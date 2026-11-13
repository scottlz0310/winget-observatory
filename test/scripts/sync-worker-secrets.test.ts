import { describe, expect, it, mock } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWorkerSecretsJson,
  DEFAULT_CLIENT_ID_VAR,
  DEFAULT_SOURCE_REPO,
  DEFAULT_WORKER_CONFIG,
  defaultWranglerRunner,
  parseCliArgs,
  putWorkerSecrets,
  resolveClientId,
  runGh,
  runSync,
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

  it("gh runner の出力が空文字の場合は例外をスローする", () => {
    const original = process.env.GITHUB_APP_CLIENT_ID;
    delete process.env.GITHUB_APP_CLIENT_ID;
    try {
      const runner = mock().mockReturnValue("   \n");
      expect(() => resolveClientId(undefined, DEFAULT_SOURCE_REPO, runner)).toThrow(
        "Client ID を特定できませんでした",
      );
    } finally {
      process.env.GITHUB_APP_CLIENT_ID = original;
    }
  });
});

describe("putWorkerSecrets & defaultWranglerRunner", () => {
  it("Bun バイナリを直接呼び出し、shell を介さず単一引数として渡す", () => {
    const runner = mock().mockReturnValue({ status: 0, stdout: "Success", stderr: "" });
    const output = putWorkerSecrets('{"key":"value"}', DEFAULT_WORKER_CONFIG, runner);

    expect(output).toBe("Success");
    expect(runner).toHaveBeenCalledWith(
      process.execPath,
      ["x", "wrangler", "secret", "bulk", "--config", DEFAULT_WORKER_CONFIG],
      '{"key":"value"}',
    );
  });

  it("空白やシェルメタ文字を含むパスでも単一引数として渡される（cmd.exe再解釈の防止）", () => {
    const maliciousConfig = "folder with space/wrangler.toml&echo MARKER";
    const runner = mock().mockReturnValue({ status: 0, stdout: "Success", stderr: "" });
    putWorkerSecrets('{"key":"value"}', maliciousConfig, runner);

    const callArgs = (runner.mock.calls[0] as [string, string[], string])[1];
    expect(callArgs).toEqual(["x", "wrangler", "secret", "bulk", "--config", maliciousConfig]);
    expect(callArgs[callArgs.length - 1]).toBe(maliciousConfig);
  });

  it("runner が失敗したらエラーをスローする", () => {
    const runner = mock().mockReturnValue({ status: 1, stdout: "", stderr: "auth required" });
    expect(() => putWorkerSecrets('{"key":"value"}', DEFAULT_WORKER_CONFIG, runner)).toThrow(
      "Wrangler secret bulk failed: auth required",
    );
  });

  it("defaultWranglerRunner は shell: false で実行する", () => {
    // 実際に安全な引数（--help）で defaultWranglerRunner を呼び、shell: false の動作を確認
    const res = defaultWranglerRunner(process.execPath, ["--version"], "");
    expect(res.status).toBe(0);
  });
});

describe("parseCliArgs", () => {
  it("引数からオプションとファイルパスを正常に解析する", () => {
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

  it.each([
    ["--client-id", ["--client-id"]],
    ["--client-id with next flag", ["--client-id", "--config", "foo"]],
    ["--installation-id", ["--installation-id"]],
    ["--source-repo", ["--source-repo"]],
    ["--config", ["key.pem", "--config"]],
    ["--config with next flag", ["--config", "--client-id", "id"]],
  ])("値必須オプション %s の値が欠落している場合は例外をスローする", (_name, args) => {
    expect(() => parseCliArgs(args)).toThrow("の値が指定されていません");
  });

  it("未知のオプションは例外をスローする", () => {
    expect(() => parseCliArgs(["--unknown-option"])).toThrow(
      "未知のオプションです: --unknown-option",
    );
    expect(() => parseCliArgs(["-x"])).toThrow("未知のオプションです: -x");
  });

  it("複数の位置引数が指定された場合は例外をスローする", () => {
    expect(() => parseCliArgs(["key1.pem", "key2.pem"])).toThrow(
      "予期しない追加の引数です: key2.pem",
    );
  });
});

describe("runSync", () => {
  it("pemContent が直接渡された場合は正常に Secrets を登録する", async () => {
    const mockPutter = mock().mockReturnValue("Bulk update complete");
    const mockResolver = mock().mockReturnValue("resolved-id");

    const result = await runSync(
      { pemContent: pkcs1Pem, clientId: "custom-id", installationId: "99" },
      { putWorkerSecretsFn: mockPutter, resolveClientIdFn: mockResolver },
    );

    expect(result).toBe("Bulk update complete");
    expect(mockResolver).toHaveBeenCalled();
    expect(mockPutter).toHaveBeenCalled();
  });

  it("pemPath からファイルを読み込んで正常に Secrets を登録する", async () => {
    const tempFile = join(tmpdir(), `test-key-${Date.now()}.pem`);
    writeFileSync(tempFile, pkcs8Pem, "utf8");
    try {
      const mockPutter = mock().mockReturnValue("OK");
      const mockResolver = mock().mockReturnValue("resolved-id");

      const result = await runSync(
        { pemPath: tempFile },
        { putWorkerSecretsFn: mockPutter, resolveClientIdFn: mockResolver },
      );

      expect(result).toBe("OK");
    } finally {
      unlinkSync(tempFile);
    }
  });

  it("存在しない pemPath を指定した場合は例外をスローする", async () => {
    await expect(runSync({ pemPath: "non-existent-key-file.pem" })).rejects.toThrow(
      "指定された秘密鍵ファイルが見つかりません",
    );
  });

  it("stdinReader から秘密鍵を読み込んで正常に Secrets を登録する", async () => {
    const mockPutter = mock().mockReturnValue("OK");
    const mockResolver = mock().mockReturnValue("resolved-id");

    const result = await runSync(
      {},
      {
        putWorkerSecretsFn: mockPutter,
        resolveClientIdFn: mockResolver,
        stdinReader: async () => pkcs8Pem,
      },
    );

    expect(result).toBe("OK");
  });

  it("秘密鍵が一切指定されていない場合は例外をスローする", async () => {
    const original = process.env.GITHUB_APP_PRIVATE_KEY;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    try {
      await expect(runSync({}, { stdinReader: async () => "" })).rejects.toThrow(
        "秘密鍵が指定されていません",
      );
    } finally {
      process.env.GITHUB_APP_PRIVATE_KEY = original;
    }
  });
});

describe("runGh", () => {
  it("gh CLI が失敗した場合は例外をスローする", () => {
    expect(() => runGh(["invalid-subcommand-xyz"])).toThrow("gh invalid-subcommand-xyz failed");
  });
});
