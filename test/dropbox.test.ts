import { describe, expect, test } from "bun:test";
import { assertSafePath, DropboxClient, describeSecretShape } from "../scripts/lib/dropbox";

describe("assertSafePath", () => {
  test("正しいプレフィックス（/data/ および移行互換 /winget-observatory/）配下の安全なパスを受け入れる", () => {
    expect(() => assertSafePath("/data/progress-history.csv")).not.toThrow();
    expect(() => assertSafePath("/data/sub/data.json")).not.toThrow();
    expect(() => assertSafePath("/winget-observatory/progress-history.csv")).not.toThrow();
  });

  test("プレフィックス外やドットセグメントを含むパスを拒否する", () => {
    expect(() => assertSafePath("/other/path.csv")).toThrow();
    expect(() => assertSafePath("/unknown/test.csv")).toThrow();
    expect(() => assertSafePath("/data/../hack.csv")).toThrow();
    expect(() => assertSafePath("/data/./hack.csv")).toThrow();
    expect(() => assertSafePath("/winget-observatory/../hack.csv")).toThrow();
  });
});

describe("describeSecretShape", () => {
  test("機密文字列の形状情報を返す（値そのものは含まない）", () => {
    const shape = describeSecretShape("APP_KEY", "dummy-app-key-12345");
    expect(shape).toContain("APP_KEY");
    expect(shape).toContain("長さ 19");
    expect(shape).not.toContain("dummy-app-key-12345");
  });
});

describe("DropboxClient with mock fetch", () => {
  const dummyOptions = {
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    refreshToken: "test-refresh-token",
  };

  test("トークン取得とアップロードが正常に動作する", async () => {
    let tokenFetched = false;
    let fileUploaded = false;

    const mockFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      if (url.includes("/oauth2/token")) {
        tokenFetched = true;
        return new Response(JSON.stringify({ access_token: "mock-access-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/files/upload")) {
        fileUploaded = true;
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        expect(auth).toBe("Bearer mock-access-token");
        return new Response(
          JSON.stringify({
            path_display: "/data/test.txt",
            size: 12,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new DropboxClient({
      ...dummyOptions,
      fetch: mockFetch,
    });

    const result = await client.upload("/data/test.txt", "Hello World!");
    expect(tokenFetched).toBe(true);
    expect(fileUploaded).toBe(true);
    expect(result.path).toBe("/data/test.txt");
    expect(result.size).toBe(12);
  });

  test("存在しないファイルのダウンロードで undefined を返す", async () => {
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes("/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "mock-access-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/files/download")) {
        return new Response(
          JSON.stringify({
            error_summary: "path/not_found/",
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const client = new DropboxClient({
      ...dummyOptions,
      fetch: mockFetch,
    });

    const content = await client.download("/data/not-found.txt");
    expect(content).toBeUndefined();
  });
});
