/**
 * PR ラベル定数定義・健全性判定・GitHub Search クエリ条件構築に関する純粋ドメインロジック。
 * 外部 I/O を行わない純粋関数群。
 */

/**
 * 比較条件で必須とされるラベル一覧。
 */
export const REQUIRED_LABELS: readonly string[] = [
  "New-Package",
  "Azure-Pipeline-Passed",
  "Validation-Completed",
] as const;

/**
 * 明確な阻害要因となるラベル一覧。
 */
export const BLOCKED_LABELS: readonly string[] = [
  "Needs-CLA",
  "Needs-Author-Feedback",
  "Changes-Requested",
  "Blocking-Issue",
  "Blocked-InstallerType",
  "Author-Not-Authorized",
  "Author-Not-Verified",
  "Manifest-Content-Incomplete",
  "Package-Metadata-Invalid",
  "PullRequest-Error",
  "Unexpected-File",
  "Network-Blocker",
  "Possible-Duplicate",
  "Resolution-Duplicate",
  "Validation-Merge-Conflict",
  "Validation-Retry",
  "Timeout-Retry",
  "Testing",
] as const;

/**
 * 調査中・特殊な対応が必要なラベル一覧。
 */
export const INVESTIGATION_LABELS: readonly string[] = [
  "Package-Flagged",
  "PUA-Detection",
  "Needs-SmartScreen-Investigation",
  "Validate-Domain-Installer",
  "Validation-Agreement-Domain",
  "Validation-Certificate-Root",
  "Validation-Domain",
  "Validation-Domains-Mismatch",
  "Validation-Framework-Package",
  "Validation-Hash-Flagged",
  "Validation-Hash-Verification-Failed",
  "Validation-Unapproved-URL",
  "Validation-SmartScreen",
] as const;

/**
 * 名前パターンで判定する除外ラベル正規表現。
 */
export const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^Error-/,
  /-Error$/,
  /^Policy-Test-/,
  /^Validation-Submission-(Expired|Failed|Mismatch|Missing|Unsupported)$/,
] as const;

/**
 * 「健康な未マージ PR」（比較条件を満たす PR）を検索する GitHub Search クエリの条件部分。
 * progress（前線・待ち件数）と explore-depths（各底）で同じ定義を使い、判定のずれを防ぐ。
 * 名前パターンで判定する阻害ラベル（BLOCKED_PATTERNS）は検索クエリで表現できないため含まない。
 */
export function buildHealthyQueryParts(repository: string): string[] {
  return [
    `repo:${repository}`,
    "is:pr",
    "is:open",
    "draft:false",
    ...REQUIRED_LABELS.map((l) => `label:"${l}"`),
    ...BLOCKED_LABELS.map((b) => `-label:"${b}"`),
    ...INVESTIGATION_LABELS.map((inv) => `-label:"${inv}"`),
  ];
}

const BLOCKED_LABEL_SET = new Set<string>(BLOCKED_LABELS);
const INVESTIGATION_LABEL_SET = new Set<string>(INVESTIGATION_LABELS);

/**
 * 指定されたラベル名が阻害要因・除外対象に該当するか判定する。
 */
export function isBlockedLabel(name: string): boolean {
  if (BLOCKED_LABEL_SET.has(name) || INVESTIGATION_LABEL_SET.has(name)) {
    return true;
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * ラベル一覧が比較条件（必須ラベルすべて存在、除外ラベルなし）を満たすか判定する。
 */
export function isEligibleLabels(labels: Iterable<string>): boolean {
  const labelSet = new Set(labels);
  for (const required of REQUIRED_LABELS) {
    if (!labelSet.has(required)) {
      return false;
    }
  }
  for (const name of labelSet) {
    if (isBlockedLabel(name)) {
      return false;
    }
  }
  return true;
}
