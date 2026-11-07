// Dropbox（App folder 型アプリ）と通信する軽量クライアント。
// 依存ライブラリなし（標準 fetch と Base64 / URLSearchParams のみ）で動作。

import { redactText } from "./redact";

const TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";
const DOWNLOAD_URL = "https://content.dropboxapi.com/2/files/download";

/** 読み書きを許可する、アプリフォルダー内のプレフィックス */
export const DROPBOX_ROOT = "/data/";

/** プレフィックス配下の英数字・_・.・-・/ だけの安全なパス（連続する / や . / .. を拒否） */
const SAFE_PATH = /^\/data\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DropboxApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "DropboxApiError";
  }
}

export interface DropboxClientOptions {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  fetch?: FetchLike;
  trace?: (line: string) => void;
}

export interface UploadResult {
  path: string;
  size: number;
}

/**
 * 秘密の値そのものは出さず、形状（長さ、文字種、空白有無）だけを説明する文字列を生成。
 */
export function describeSecretShape(name: string, value: string): string {
  const yesNo = (flag: boolean) => (flag ? "あり" : "なし");
  return `${name}: 長さ ${value.length}、空白・改行 ${yesNo(/\s/.test(value))}、引用符 ${yesNo(/["'`]/.test(value))}、英数字と _ - 以外の文字 ${yesNo(/[^A-Za-z0-9_-]/.test(value))}、先頭が sl. ${yesNo(value.startsWith("sl."))}`;
}

/** パスが許容された安全な形式か検証 */
export function assertSafePath(path: string): void {
  const segments = path.split("/");
  const dotSegment = segments.some((s) => s === "." || s === "..");
  if (!SAFE_PATH.test(path) || dotSegment) {
    throw new Error(
      `Dropbox の読み書き先は ${DROPBOX_ROOT} 配下の英数字と . _ - / だけのパスにしてください: ${path}`,
    );
  }
}

export class DropboxClient {
  private readonly fetchFn: FetchLike;
  private readonly trace: (line: string) => void;
  private token: string | undefined;

  constructor(private readonly options: DropboxClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.trace = options.trace ?? (() => {});
  }

  private scrub(text: string): string {
    return redactText(text, [
      this.token,
      this.options.appKey,
      this.options.appSecret,
      this.options.refreshToken,
    ]);
  }

  /** OAuth2 refresh token から短命 access token を取得（キャッシュ対応） */
  async accessToken(): Promise<string> {
    if (this.token) {
      return this.token;
    }
    const { appKey, appSecret, refreshToken } = this.options;
    const authHeader = `Basic ${Buffer.from(`${appKey}:${appSecret}`).toString("base64")}`;
    const response = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });

    this.trace(`POST Dropbox トークン エンドポイント → HTTP ${response.status}`);

    if (!response.ok) {
      const text = this.scrub((await response.text()).slice(0, 500));
      throw new DropboxApiError(
        `Dropbox のアクセス トークンを取得できませんでした（HTTP ${response.status}）${text}。登録された値の形状: ${[
          describeSecretShape("DROPBOX_APP_KEY", appKey),
          describeSecretShape("DROPBOX_APP_SECRET", appSecret),
          describeSecretShape("DROPBOX_REFRESH_TOKEN", refreshToken),
        ].join(" / ")}`,
        response.status,
      );
    }

    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new Error("Dropbox のトークン応答に access_token が含まれていません");
    }

    this.token = body.access_token;
    return this.token;
  }

  /**
   * アプリフォルダー内の path（/winget-observatory/...）へテキストをアップロード（上書き）
   */
  async upload(path: string, content: string | Uint8Array): Promise<UploadResult> {
    assertSafePath(path);
    const token = await this.accessToken();
    const body = typeof content === "string" ? content : Buffer.from(content);

    const response = await this.fetchFn(UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({
          path,
          mode: "overwrite",
          autorename: false,
          mute: true,
        }),
        "Content-Type": "application/octet-stream",
      },
      body,
    });

    this.trace(`POST Dropbox files/upload ${path} → HTTP ${response.status}`);

    if (!response.ok) {
      const errText = this.scrub((await response.text()).slice(0, 1000));
      throw new DropboxApiError(
        `Dropbox への書き込みに失敗しました: ${path}（HTTP ${response.status}）${errText}`,
        response.status,
      );
    }

    const saved = (await response.json()) as {
      path_display?: string;
      size?: number;
    };

    const calculatedSize =
      typeof content === "string" ? new TextEncoder().encode(content).length : content.byteLength;

    return {
      path: saved.path_display ?? path,
      size: saved.size ?? calculatedSize,
    };
  }

  /**
   * アプリフォルダー内の path（/winget-observatory/...）からテキストをダウンロード。
   * ファイルが存在しない場合は undefined を返す。
   */
  async download(path: string): Promise<string | undefined> {
    assertSafePath(path);
    const token = await this.accessToken();
    const response = await this.fetchFn(DOWNLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path }),
      },
    });

    this.trace(`POST Dropbox files/download ${path} → HTTP ${response.status}`);

    if (response.ok) {
      return response.text();
    }

    const body = this.scrub((await response.text()).slice(0, 1000));
    // ファイルが存在しない場合は HTTP 409 + path/not_found
    if (response.status === 409 && body.includes('"path/not_found/')) {
      return undefined;
    }

    throw new DropboxApiError(
      `Dropbox からの読み取りに失敗しました: ${path}（HTTP ${response.status}）${body}`,
      response.status,
    );
  }
}
