/**
 * PR ラベル定数定義・健全性判定・GitHub Search クエリ条件構築に関する純粋ドメインロジック。
 * 外部 I/O を行わない純粋関数群。
 */

/**
 * 比較条件で必須とされるラベル一覧。
 */
export const REQUIRED_LABELS: readonly string[] = ["New-Package", "Validation-Completed"] as const;

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
  // 停止・手動対応待ち（author 返信後またはモデレーター・手動マージ必要時）
  "Needs-Attention",
  "Needs-Manual-Merge",
  "Needs-Manual-Review",
  // 非推奨・構成不整合・バージョン制約
  "Manifest-Version-Deprecated",
  "Manifest-Singleton-Deprecated",
  "Manifest-Metadata-Consistency",
  "Highest-Version-Removal",
  "Last-Version-Removal",
  "Version-Parameter-Mismatch",
  // ハードブロッカー・特殊インストール・リポジトリ制約
  "DriverInstall",
  "Scripted-Application",
  "Interactive-Only-Installer",
  "License-Blocks-Install",
  "EULA-Install",
  "Hardware",
  "Project-File",
  "portable-archive",
  "portable-jar",
  "zip-binary",
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
  "Validation-Indirect-URL",
  "Validation-Missing-Dependency",
  "Validation-No-Executables",
  "Validation-Open-Url-Failed",
  "Validation-Shell-Execute",
  "Validation-Unattended-Failed",
  "Validation-Unapproved-URL",
  "Validation-SmartScreen",
  "Validation-Guide",
] as const;

/**
 * 名前パターン（Error-*, *-Error, Internal-Error-*, Policy-Test-*, Validation-Submission-*）に該当する
 * 実在の阻害ラベル一覧（モデレーター免除の Waived-* ラベルは含まない）。
 * GitHub Search クエリの `-label:"..."` でサーバー側除外するために明示列挙する。
 */
export const PATTERN_BLOCKED_LABELS: readonly string[] = [
  "Binary-Validation-Error",
  "Error-Analysis-Timeout",
  "Error-Hash-Mismatch",
  "Error-Installer-Availability",
  "Installation-Validation-Error",
  "Installation-Verification-Error",
  "Installer-Error",
  "Internal-Error",
  "Internal-Error-Domain",
  "Internal-Error-Dynamic-Scan",
  "Internal-Error-Keyword-Policy",
  "Internal-Error-Manifest",
  "Internal-Error-NoArchitectures",
  "Internal-Error-NoSupportedArchitectures",
  "Internal-Error-PR",
  "Internal-Error-Static-Scan",
  "Internal-Error-URL",
  "Manifest-AppsAndFeaturesVersion-Error",
  "Manifest-Dependencies-Error",
  "Manifest-Installer-Validation-Error",
  "Manifest-Path-Error",
  "Manifest-Validation-Error",
  "Manifest-Version-Error",
  "Policy-Test-1.1.A",
  "Policy-Test-1.1.B",
  "Policy-Test-1.2",
  "Policy-Test-1.5",
  "Policy-Test-1.8",
  "Policy-Test-2.10",
  "Policy-Test-2.2.A",
  "Policy-Test-2.2.B",
  "Policy-Test-2.3",
  "Policy-Test-2.4",
  "Policy-Test-2.5",
  "Policy-Test-2.6",
  "Policy-Test-2.7",
  "Policy-Test-2.8",
  "Policy-Test-2.9",
  "URL-Validation-Error",
  "Validation-404-Error",
  "Validation-Defender-Error",
  "Validation-Error",
  "Validation-Executable-Error",
  "Validation-Forbidden-URL-Error",
  "Validation-HTTP-Error",
  "Validation-Installation-Error",
  "Validation-Line-Endings-Error",
  "Validation-SmartScreen-Error",
  "Validation-Submission-Expired",
  "Validation-Submission-Failed",
  "Validation-Submission-Mismatch",
  "Validation-Submission-Missing",
  "Validation-Submission-Unsupported",
  "Validation-Uninstall-Error",
  "Validation-Virus-Scan-Error",
] as const;

/**
 * 一般コミュニティ提出者の待機列・統計・最速ランキングから除外する公式高速枠・特殊レーンラベル一覧。
 * 例: `Publisher-Verified` は `Validation-Completed` と同時にモデレーター承認なしで即自動承認・マージされる。
 */
export const SPECIAL_LANE_LABELS: readonly string[] = [
  "Publisher-Verified",
  "Validation-Metadata",
] as const;

/**
 * モデレーターが自動検証エラーを免除（Waive）した際に付与するラベルの接頭辞。
 * Waived-Validation-*-Error 等も健康体として扱い、阻害対象から除外する。
 */
export const WAIVED_LABEL_PREFIX = "Waived-";

/**
 * 名前パターンで判定する除外ラベル正規表現（タイムライン履歴や未知の新規ラベル検証用）。
 */
export const BLOCKED_PATTERNS: readonly RegExp[] = [
  /^Error-/,
  /-Error$/,
  /^Internal-Error-/,
  /^Policy-Test-/,
  /^Validation-Submission-(Expired|Failed|Mismatch|Missing|Unsupported)$/,
  /^Validation-.*-Failed$/,
] as const;

/**
 * すべての除外対象ラベル（BLOCKED_LABELS, INVESTIGATION_LABELS, PATTERN_BLOCKED_LABELS, SPECIAL_LANE_LABELS）を
 * GitHub Search の `-label:"..."` トークン配列に変換する。
 */
export function buildExcludedLabelQueryParts(): string[] {
  return [
    ...BLOCKED_LABELS.map((b) => `-label:"${b}"`),
    ...INVESTIGATION_LABELS.map((inv) => `-label:"${inv}"`),
    ...PATTERN_BLOCKED_LABELS.map((pat) => `-label:"${pat}"`),
    ...SPECIAL_LANE_LABELS.map((lane) => `-label:"${lane}"`),
  ];
}

/**
 * 「健康な未マージ PR」（比較条件を満たす PR）を検索する GitHub Search クエリの条件部分。
 * progress（前線・待ち件数・ライバル）と explore-depths（各底）で同じ定義を使い、
 * サーバー側で全阻害ラベルを除外して判定のずれを防ぐ。
 */
export function buildHealthyQueryParts(repository: string): string[] {
  return [
    `repo:${repository}`,
    "is:pr",
    "is:open",
    "draft:false",
    ...REQUIRED_LABELS.map((l) => `label:"${l}"`),
    ...buildExcludedLabelQueryParts(),
  ];
}

/**
 * 指定期間内にマージされた健康な候補 PR を検索する GitHub Search クエリの条件部分。
 * サーバー側で `draft:false`・必須ラベル・全除外ラベルを絞り込む。
 */
export function buildMergedCandidateQueryParts(
  repository: string,
  sinceIso: string,
  untilIso: string,
  requiredLabels: readonly string[] = REQUIRED_LABELS,
): string[] {
  return [
    `repo:${repository}`,
    "is:pr",
    "is:merged",
    "draft:false",
    `merged:${sinceIso}..${untilIso}`,
    ...requiredLabels.map((l) => `label:"${l}"`),
    ...buildExcludedLabelQueryParts(),
  ];
}

const BLOCKED_LABEL_SET = new Set<string>(BLOCKED_LABELS);
const INVESTIGATION_LABEL_SET = new Set<string>(INVESTIGATION_LABELS);
const PATTERN_BLOCKED_LABEL_SET = new Set<string>(PATTERN_BLOCKED_LABELS);
const SPECIAL_LANE_LABEL_SET = new Set<string>(SPECIAL_LANE_LABELS);

/**
 * 指定されたラベル名が阻害要因・除外対象に該当するか判定する。
 * `Waived-` で始まるモデレーター免除ラベルは阻害対象としない。
 */
export function isBlockedLabel(name: string): boolean {
  if (name.startsWith(WAIVED_LABEL_PREFIX)) {
    return false;
  }
  if (
    BLOCKED_LABEL_SET.has(name) ||
    INVESTIGATION_LABEL_SET.has(name) ||
    PATTERN_BLOCKED_LABEL_SET.has(name) ||
    SPECIAL_LANE_LABEL_SET.has(name)
  ) {
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
