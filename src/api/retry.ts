/**
 * GitHub GraphQL API 通信のリトライ制御（指数バックオフ・Retry-After 解釈・セカンダリレート制限検知）およびエラー型定義。
 */

/**
 * 一時エラーとしてリトライ対象とする HTTP ステータスコード。
 * 429: Too Many Requests（セカンダリレート制限等）
 * 502: Bad Gateway
 * 503: Service Unavailable
 * 504: Gateway Timeout
 */
export const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);

/** Retry-After 未指定のセカンダリレート制限発生時の既定最小待機時間（ミリ秒） */
export const DEFAULT_SECONDARY_RATE_LIMIT_DELAY_MS = 60_000;

/** 1 回あたりのリトライ待機時間の上限（ミリ秒） */
export const DEFAULT_MAX_RETRY_DELAY_MS = 180_000;

/** 一時エラー検知後の適応的クールダウン待機時間（ミリ秒） */
export const DEFAULT_ADAPTIVE_COOLDOWN_MS = 300;

/** 一時エラー検知後に適応的クールダウンを継続する後続リクエスト数 */
export const DEFAULT_ADAPTIVE_COOLDOWN_REQUESTS = 20;

export function isRetryableStatusCode(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

/**
 * GitHub API のセカンダリレート制限（429、または 403 + セカンダリレート制限メッセージ / Retry-After）かを判定する。
 * 通常の権限不足 403（Bad credentials / Resource not accessible 等）は false を返し誤リトライを防ぐ。
 */
export function isSecondaryRateLimitResponse(
  status: number,
  bodyText = "",
  retryAfterHeader?: string | null,
): boolean {
  if (status === 429) {
    return true;
  }
  if (status !== 403) {
    return false;
  }
  if (bodyText.toLowerCase().includes("secondary rate limit")) {
    return true;
  }
  return parseRetryAfterMs(retryAfterHeader) !== undefined;
}

/**
 * HTTP ステータスコード・応答本文・Retry-After ヘッダーを総合してリトライ可能エラーか判定する。
 */
export function isRetryableHttpResponse(
  status: number,
  bodyText = "",
  retryAfterHeader?: string | null,
): boolean {
  return (
    isRetryableStatusCode(status) ||
    isSecondaryRateLimitResponse(status, bodyText, retryAfterHeader)
  );
}

/**
 * HTTP エラー応答に対する最小待機時間（ミリ秒）を計算する。
 * Retry-After が明示されていればそれを優先し、未指定のセカンダリレート制限時は secondaryRateLimitDelayMs を使用する。
 */
export function computeRetryMinDelayMs(params: {
  status: number;
  bodyText?: string;
  retryAfterHeader?: string | null;
  secondaryRateLimitDelayMs?: number;
}): number {
  const retryAfterMs = parseRetryAfterMs(params.retryAfterHeader);
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }
  if (isSecondaryRateLimitResponse(params.status, params.bodyText ?? "", params.retryAfterHeader)) {
    return params.secondaryRateLimitDelayMs ?? DEFAULT_SECONDARY_RATE_LIMIT_DELAY_MS;
  }
  return 0;
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
  /** Retry-After 未指定のセカンダリレート制限発生時の最小待機時間（ミリ秒、既定: 60000） */
  secondaryRateLimitDelayMs?: number;
  /** 1 回あたりのリトライ待機時間の上限（ミリ秒、既定: 180000） */
  maxRetryDelayMs?: number;
  /** 一時エラー検知後に後続リクエスト間に挟む適応的クールダウン待機時間（ミリ秒、既定: 300。0 で無効） */
  adaptiveCooldownMs?: number;
  /** 一時エラー検知後に適応的クールダウンを継続する後続リクエスト数（既定: 20） */
  adaptiveCooldownRequests?: number;
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
