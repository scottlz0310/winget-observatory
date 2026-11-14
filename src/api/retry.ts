/**
 * GitHub GraphQL API 通信のリトライ制御（指数バックオフ・Retry-After 解釈）およびエラー型定義。
 */

/**
 * 一時エラーとしてリトライ対象とする HTTP ステータスコード。
 * 429: Too Many Requests（セカンダリレート制限等）
 * 502: Bad Gateway
 * 503: Service Unavailable
 * 504: Gateway Timeout
 */
export const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

export function isRetryableStatusCode(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * 指数バックオフ + ジッターの待機時間（ミリ秒）を計算する。
 * attempt: 1 始まりのリトライ試行回数（1回目リトライ = 1, 2回目 = 2, 3回目 = 3...）
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs = 2000,
  maxJitterMs = 500,
): number {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = maxJitterMs > 0 ? Math.floor(Math.random() * maxJitterMs) : 0;
  return exponential + jitter;
}

/**
 * Retry-After ヘッダー（秒数または HTTP-date）をミリ秒数としてパースする。
 * 不正値や未設定時は undefined を返す。
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds * 1000 : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(diff, 0);
  }
  return undefined;
}

export interface GraphQLRetryOptions {
  /** 最大リトライ回数（既定: 3。初回含め計 4 回試行） */
  maxRetries?: number;
  /** 初回リトライのベース待機時間（ミリ秒、既定: 2000） */
  baseDelayMs?: number;
  /** ジッターの最大幅（ミリ秒、既定: 500） */
  maxJitterMs?: number;
  /** 待機関数（既定: setTimeout による Promise） */
  sleep?: (ms: number) => Promise<void>;
  /** 警告ログ関数（既定: console.error） */
  warnLog?: (message: string) => void;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GraphQLErrorDetail {
  message?: string;
  type?: string;
  path?: Array<string | number>;
  locations?: Array<{ line: number; column: number }>;
}

export class GitHubGraphQLError extends GitHubApiError {
  constructor(
    message: string,
    status: number,
    readonly errors: GraphQLErrorDetail[] = [],
  ) {
    super(message, status);
    this.name = "GitHubGraphQLError";
  }
}

/**
 * GraphQL の errors が PullRequest の不存在（NOT_FOUND）に起因するかを厳密に判定する。
 * path で対象が pullRequest であることを確認し、FORBIDDEN や INTERNAL などの
 * 認可・サーバー障害エラーを誤って 404 に変換しないよう不存在エラーのみに限定する。
 */
export function isPrNotFoundGraphQLError(err: unknown): boolean {
  if (err instanceof GitHubGraphQLError) {
    if (err.errors.length === 0) {
      return false;
    }
    return err.errors.every((e) => {
      const isNotFound =
        e.type === "NOT_FOUND" ||
        Boolean(e.message?.includes("Could not resolve to a PullRequest"));
      const isPrPath = e.path ? e.path.includes("pullRequest") : true;
      return isNotFound && isPrPath;
    });
  }
  return false;
}
