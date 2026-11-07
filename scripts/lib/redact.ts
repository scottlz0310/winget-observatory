// 記録（ログ、エラーメッセージ、証跡）から資格情報と機密文字列を取り除く。

export const REDACTED = "<記録しない>";

/** 完全一致で取り除く値の最小の長さ。短い値は無関係な文字列を巻き込むため除外。 */
const MIN_SECRET_LENGTH = 4;

/** パターンで判別できる機密情報（パターン, 置き換え） */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(sig=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
  [/(client_secret=)[^&\s"'<>]+/gi, `$1${REDACTED}`],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
];

/**
 * 文字列から既知の機密値（secrets）とパターン一致する機密文字列を取り除く。
 * 長い値から先に置き換え、短い値による部分一致誤爆を防ぐ。
 */
export function redactText(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  const known = [
    ...new Set(
      secrets.filter(
        (secret): secret is string => secret !== undefined && secret.length >= MIN_SECRET_LENGTH,
      ),
    ),
  ].sort((a, b) => b.length - a.length);

  let result = text;
  for (const secret of known) {
    result = result.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
