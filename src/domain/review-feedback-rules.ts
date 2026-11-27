/**
 * 差し戻し指摘コーパス向けのコメントノイズ除外・深刻度判定・カテゴリ自動分類ルール群。
 * 外部 I/O を行わず、src/models と同一ドメイン内モジュールのみに依存する。
 */

import type {
  FeedbackCategoryMatch,
  FeedbackCommentSeverity,
  ReviewFeedbackAuthorReply,
  ReviewFeedbackCategoryId,
  ReviewFeedbackComment,
} from "../models/review-feedback";
import { isCiRerunCommandComment } from "./intervention";

/** カテゴリ定義（表示ラベルとキーワードルール） */
export interface FeedbackCategoryRule {
  id: Exclude<ReviewFeedbackCategoryId, "uncategorized">;
  label: string;
  patterns: ReadonlyArray<{ keyword: string; regex: RegExp }>;
}

export const FEEDBACK_CATEGORY_RULES: readonly FeedbackCategoryRule[] = [
  {
    id: "privacy-policy",
    label: "プライバシーポリシー・データ開示",
    patterns: [
      { keyword: "PrivacyUrl", regex: /\bPrivacyUrl\b/i },
      { keyword: "privacy policy", regex: /\bprivacy\s+polic(?:y|ies)\b/i },
      { keyword: "sends data", regex: /\bsends?\s+data\b/i },
      { keyword: "telemetry", regex: /\btelemetry\b/i },
      {
        keyword: "product-disclosure",
        regex: /\b(?:product-disclosure|privacy\s+behavior|data\s+collection)\b/i,
      },
    ],
  },
  {
    id: "dll-runtime",
    label: "DLL / ランタイム欠損",
    patterns: [
      { keyword: "VCRUNTIME140", regex: /\bvcruntime\d*/i },
      { keyword: "MSVCP140", regex: /\bmsvcp\d*/i },
      { keyword: "ucrtbase", regex: /\bucrtbase\b/i },
      {
        keyword: "VCRedist",
        regex: /\b(?:vcredist|vc\+\+|visual\s+c\+\+|c\+\+\s+redistributable)\b/i,
      },
      {
        keyword: "STATUS_DLL_NOT_FOUND",
        regex: /\b(?:STATUS_DLL_NOT_FOUND|0xC0000135|C0000135)\b|-1073741515\b/i,
      },
      {
        keyword: ".NET Runtime",
        regex: /(?:\.net\s+(?:desktop\s+)?runtime|dotnet\s+runtime)\b/i,
      },
      { keyword: ".dll", regex: /(?:\.dll\b|\bdll\b)/i },
      { keyword: "missing", regex: /\bmissing\b/i },
      { keyword: "not found", regex: /\bnot\s+found\b/i },
      {
        keyword: "runtime",
        regex: /\b(?:c\s+runtime|runtime\s+(?:missing|required|dependency|dll))\b/i,
      },
    ],
  },
  {
    id: "launch-command",
    label: "起動・コマンド・VM 動作不良",
    patterns: [
      { keyword: "fails to start", regex: /\bfails?\s+to\s+(?:start|launch|run)\b/i },
      { keyword: "launch", regex: /\blaunch(?:es|ing|ed)?\b/i },
      { keyword: "exit code", regex: /\bexit\s+code\b/i },
      { keyword: "crash", regex: /\bcrash(?:es|ed|ing)?\b/i },
      { keyword: "OpenGL", regex: /\b(?:opengl|basic\s+display\s+adapter)\b/i },
      {
        keyword: "without arguments",
        regex: /\b(?:without\s+arguments|no\s+arguments|Validation-Executable-Error)\b/i,
      },
      { keyword: "timeout", regex: /\b(?:within\s+the\s+timeout|timed?\s+out)\b/i },
      { keyword: "spawned off", regex: /\b(?:spawned\s+off|doesn't\s+show\s+ui)\b/i },
      { keyword: "PortableCommandAlias", regex: /\bPortableCommandAlias\b/i },
      { keyword: "Commands", regex: /\bCommands\b/ },
    ],
  },
  {
    id: "metadata-url",
    label: "メタデータ・URL・ライセンス不備",
    patterns: [
      { keyword: "ReleaseNotesUrl", regex: /\bReleaseNotesUrl\b/i },
      { keyword: "PublisherSupportUrl", regex: /\bPublisherSupportUrl\b/i },
      { keyword: "PublisherUrl", regex: /\bPublisherUrl\b/i },
      { keyword: "LicenseUrl", regex: /\bLicenseUrl\b/i },
      { keyword: "PackageUrl", regex: /\bPackageUrl\b/i },
      { keyword: "License/Copyright", regex: /\b(?:License|Copyright|CopyrightUrl)\s*:/ },
      { keyword: "provenance", regex: /\b(?:provenance|version-specific|immutable)\b/i },
      { keyword: "404", regex: /\b404\b/ },
      { keyword: "unavailable", regex: /\b(?:unavailable|unreachable)\b/i },
      { keyword: "redirect", regex: /\bredirect(?:s|ed|ing)?\b/i },
      { keyword: "broken link", regex: /\b(?:dead|broken)\s+(?:link|url)\b/i },
    ],
  },
  {
    id: "manifest-installer",
    label: "マニフェスト構造・インストーラー・ARP 整合",
    patterns: [
      { keyword: "NestedInstallerType", regex: /\bNestedInstallerType\b/i },
      { keyword: "InstallerType", regex: /\bInstallerType\b/i },
      { keyword: "Architecture", regex: /\bArchitecture\b/i },
      { keyword: "UpgradeBehavior", regex: /\bUpgradeBehavior\b/i },
      { keyword: "Scope", regex: /\bScope\b/ },
      { keyword: "InstallerSwitches", regex: /\bInstallerSwitches\b/i },
      { keyword: "InstallerSha256", regex: /\bInstallerSha256\b/i },
      { keyword: "ManifestVersion", regex: /\b(?:ManifestVersion|1\.28\.0)\b/i },
      { keyword: "AppsAndFeaturesEntries", regex: /\bAppsAndFeaturesEntries\b/i },
      {
        keyword: "ARP/Registry",
        regex: /\b(?:ARP|DisplayName|DisplayVersion|ProductCode|registry)\b/i,
      },
      { keyword: "silent/unattended", regex: /\b(?:silent|unattended|Interactive-Only)\b/i },
    ],
  },
  {
    id: "locale-language",
    label: "UI 言語・Locale 不一致",
    patterns: [
      { keyword: "PackageLocale", regex: /\bPackageLocale\b/i },
      { keyword: "DefaultLocale", regex: /\bDefaultLocale\b/i },
      {
        keyword: "UI language",
        regex:
          /\b(?:interface\s+is\s+in|application\s+looks\s+to\s+be\s+in|shortcut\s+and\s+registry\s+data\s+are\s+in)\b/i,
      },
      {
        keyword: "locale mismatch",
        regex: /\b(?:zh-CN|zh-TW|ja-JP|ko-KR|tr-TR|non-english)\b/i,
      },
    ],
  },
  {
    id: "security-signing",
    label: "セキュリティ / 署名 / ポリシー制約",
    patterns: [
      { keyword: "SmartScreen", regex: /\bsmartscreen\b/i },
      { keyword: "VirusTotal", regex: /\bvirustotal\b/i },
      { keyword: "defender", regex: /\bdefender\b/i },
      { keyword: "malware", regex: /\b(?:malware|trojan|virus)\b/i },
      { keyword: "signature", regex: /\b(?:signature|unsigned|code\s*sign(?:ing|ed)?)\b/i },
      {
        keyword: "Scripted-Application",
        regex: /\b(?:Scripted-Application|scripted\s+applications?)\b/i,
      },
      { keyword: "Policy-Test", regex: /\bPolicy(?:-Test-|\s+\d+\.\d+)\b/i },
    ],
  },
] as const;

export const CATEGORY_LABELS: Record<ReviewFeedbackCategoryId, string> = {
  "privacy-policy": "プライバシーポリシー・データ開示",
  "dll-runtime": "DLL / ランタイム欠損",
  "launch-command": "起動・コマンド・VM 動作不良",
  "metadata-url": "メタデータ・URL・ライセンス不備",
  "manifest-installer": "マニフェスト構造・インストーラー・ARP 整合",
  "locale-language": "UI 言語・Locale 不一致",
  "security-signing": "セキュリティ / 署名 / ポリシー制約",
  uncategorized: "未分類（その他・新種候補）",
};

/**
 * `[Policy] Needs-Author-Feedback` 等の Policy Bot 向け単体コマンドコメントか判定する。
 * 説明文が併記されている場合は false を返す。
 */
export function isPolicyCommandOnlyComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!normalized) {
    return true;
  }
  return /^\[Policy\]\s+[^\r\n]+$/i.test(normalized);
}

/**
 * `@wingetbot waivers Add ...` / `@wingetbot run ...` / `@wingetbot installationmetadata ...` のような
 * ボット操作用の単一行コマンドコメントか判定する（説明文が併記された複数行コメントは false）。
 */
export function isWingetbotCommandOnlyComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!normalized) {
    return false;
  }
  return /^@wingetbot\s+(?:waivers|run|installationmetadata)\b[^\r\n]*$/i.test(normalized);
}

const VERIFY_MEMO_ONLY_LINE_PATTERNS: readonly RegExp[] = [
  /^(?:Edit\s*[:;]\s*)?Privacy\s+Po(?:li|il)cy\s*:\s*\S+\s*$/i,
  /^(?:Edit\s*[:;]\s*)?Privacy\s+Policy\s+(?:baked\s+into\s+application\.?|in\s+(?:PackageUrl|InstallerUrl)\s*:?)\s*$/i,
  /^(?:Edit\s*[:;]\s*)?Internet\s+Translation\s*:?\s*$/i,
  /^(?:Edit\s*[:;]\s*)?In-App\s+Purchase\s*:[^\r\n]*$/i,
  /^(?:Edit\s*[:;]\s*)?Registry\s*:?\s*$/i,
  /^Edit\s*[:;]?\s*$/i,
];

/**
 * `Verify: <img ...>` のような動作確認スクリーンショット単体、または定型確認メモ
 * （`Privacy Policy: <URL>` / `Internet Translation:` / `In-App Purchase:` 等）のみで構成された
 * 承認前確認コメントか判定する。質問文や障害指摘が併記されている場合は false を返す。
 */
export function isVerifyMemoOnlyComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) {
    return false;
  }

  const startsWithVerify = /^Verify\b/i.test(normalized);
  const startsWithImage = /^(?:<img\b[^>]*>|!\[[^\]]*\]\([^)]+\))/i.test(normalized);
  if (!startsWithVerify && !startsWithImage) {
    return false;
  }

  const withoutImages = normalized
    .replace(/<img\b[^>]*>/gi, "\n")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "\n");

  // `Internet Translation: Privacy Policy: https://...` のように 1 行に複数メモが並ぶケースを分割して検査
  const splitTokens = withoutImages
    .replace(/^Verify\s*:?\s*/i, "")
    .replace(
      /(?:^|\s)((?:Edit\s*[:;]\s*)?(?:Internet\s+Translation\s*:?|Privacy\s+Po(?:li|il)cy\s*:|Privacy\s+Policy\s+(?:baked\s+into|in\s+(?:PackageUrl|InstallerUrl))|In-App\s+Purchase\s*:|Registry\s*:))/gi,
      "\n$1",
    );

  const lines = splitTokens
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return startsWithVerify;
  }

  // 画像開始（Verify なし）の場合は定型メモ行（Internet Translation 等）が 1 つ以上明示されているときのみ除外
  return lines.every((line) => VERIFY_MEMO_ONLY_LINE_PATTERNS.some((re) => re.test(line)));
}

/**
 * `Close with reason: Stale;` のような非フィードバック系の定型クローズコマンド単体か判定する。
 */
export function isStaleCloseCommandOnlyComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  return /^Close\s+with\s+reason\s*:\s*Stale\s*;?$/i.test(normalized);
}

/**
 * `` `Adult Reference or Theme` - False Positive match with ... `` のような単一行の誤検知メモか判定する。
 */
export function isFalsePositiveNoteOnlyComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  return /^`[^`\r\n]+`\s*-\s*False\s+Positive\s+match\b[^\r\n]*$/i.test(normalized);
}

const AUTOMATIC_VALIDATION_REAL_FAILURE_PATTERN =
  /\b(?:exit\s+code|STATUS_DLL_NOT_FOUND|0xC0000135|C0000135|hash\s+doesn't\s+match|hash\s+verification\s+failed|within\s+the\s+timeout|Zip\s+file\s+expired)\b|-1073741515\b/i;

/**
 * `Automatic Validation ended with:` で始まるコメントのうち、
 * 実行時エラー・ハッシュ不一致等の実障害ログを含まない Policy-Test 誤検知転載・自動検証出力エラーのみか判定する。
 */
export function isAutomaticValidationNoiseComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  const normalized = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!/^Automatic\s+Validation\s+ended\s+with\s*:/i.test(normalized)) {
    return false;
  }
  if (AUTOMATIC_VALIDATION_REAL_FAILURE_PATTERN.test(normalized)) {
    return false;
  }
  const hasPolicyTestOutput =
    /Policy-Test-\d|All\s+banking\s+applications\s+require\s+review|Algo\s+Speak|Adult\s+Reference\s+or\s+Theme|Targeted\s+Brand|Possible\s+CP\/CE\s+term/i.test(
      normalized,
    );
  const isAutomationArtifactError = /My\s+automation\s+isn't\s+getting\s+a\s+valid\s+output/i.test(
    normalized,
  );
  return hasPolicyTestOutput || isAutomationArtifactError;
}

/**
 * 第三者人間のコメントが、差し戻し指摘ではなく定型運用ノイズ（ボットコマンド・確認スクショ単体・
 * Stale クローズコマンド・Policy-Test 誤検知転載等）かを統合判定する。
 */
export function isFeedbackNoiseComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return true;
  }
  const normalized = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!normalized) {
    return true;
  }
  return (
    isPolicyCommandOnlyComment(normalized) ||
    isCiRerunCommandComment(normalized) ||
    isWingetbotCommandOnlyComment(normalized) ||
    isVerifyMemoOnlyComment(normalized) ||
    isStaleCloseCommandOnlyComment(normalized) ||
    isFalsePositiveNoteOnlyComment(normalized) ||
    isAutomaticValidationNoiseComment(normalized)
  );
}

const NON_BLOCKING_FEEDBACK_PATTERN = /\bNo\s+blockers\s+have\s+been\s+found\s+for\s+this\s+PR\b/i;

/**
 * 指摘コメントがブロッキング差し戻しか、任意・非ブロッキング助言かを判定する。
 */
export function classifyFeedbackCommentSeverity(
  body: string | null | undefined,
): FeedbackCommentSeverity {
  if (typeof body === "string" && NON_BLOCKING_FEEDBACK_PATTERN.test(body)) {
    return "non-blocking";
  }
  return "blocking";
}

/**
 * PR 作成者の定型コマンドコメント（CLA 同意・引用付き CLA 同意・`bump` 単体・CI 再実行コマンド単体等）か判定する。
 */
export function isAuthorNoiseComment(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return true;
  }
  const normalized = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) {
    return true;
  }
  if (
    isCiRerunCommandComment(normalized) ||
    isPolicyCommandOnlyComment(normalized) ||
    isWingetbotCommandOnlyComment(normalized)
  ) {
    return true;
  }
  if (/^bump[.!?]*$/i.test(normalized)) {
    return true;
  }
  // Microsoft CLA 同意コマンド（単独・引用付き・定型 CLA 同意文）
  if (/^@microsoft-github-policy-service\s+agree\b/i.test(normalized)) {
    return true;
  }
  if (/^agree$/i.test(normalized)) {
    return true;
  }
  if (
    /^I\s+have\s+read\s+the\s+CLA\s+Document\s+and\s+I\s+hereby\s+sign\s+the\s+CLA\.?$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (
    /license\/cla.*Needs-CLA/i.test(normalized) &&
    /@microsoft-github-policy-service\s+agree\b/i.test(normalized)
  ) {
    return true;
  }
  // Markdown 引用行を除いた実質テキストが空、または CLA 同意コマンドのみの場合
  const nonQuoted = normalized
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
  if (
    nonQuoted.length === 0 ||
    /^@microsoft-github-policy-service\s+agree\b/i.test(nonQuoted) ||
    /^agree$/i.test(nonQuoted)
  ) {
    return true;
  }
  return false;
}

/**
 * コメント本文に画像添付（HTML `<img>` または Markdown `![]()`）が含まれるかを判定する。
 */
export function hasEmbeddedImage(body: string | null | undefined): boolean {
  if (typeof body !== "string") {
    return false;
  }
  return /<img\b[^>]*\bsrc=/i.test(body) || /!\[[^\]]*\]\([^)]+\)/.test(body);
}

/**
 * 指摘コメント群（および任意で作成者返信群）をルールベースでカテゴリ分類する（マルチタグ対応）。
 * どのルールにも該当しない場合は `uncategorized` を付与する。
 */
export function categorizeFeedback(params: {
  feedbackItems: readonly ReviewFeedbackComment[];
  authorReplies?: readonly ReviewFeedbackAuthorReply[];
}): {
  categories: ReviewFeedbackCategoryId[];
  categoryMatches: FeedbackCategoryMatch[];
} {
  const combinedTexts = [
    ...params.feedbackItems.map((item) => item.body),
    ...(params.authorReplies ?? []).map((reply) => reply.body),
  ];
  const corpus = combinedTexts.join("\n\n");

  const categoryMatches: FeedbackCategoryMatch[] = [];
  for (const rule of FEEDBACK_CATEGORY_RULES) {
    const matchedKeywords: string[] = [];
    for (const pattern of rule.patterns) {
      if (pattern.regex.test(corpus)) {
        matchedKeywords.push(pattern.keyword);
      }
    }
    if (matchedKeywords.length > 0) {
      categoryMatches.push({
        category: rule.id,
        matchedKeywords,
      });
    }
  }

  if (categoryMatches.length === 0) {
    return {
      categories: ["uncategorized"],
      categoryMatches: [{ category: "uncategorized", matchedKeywords: [] }],
    };
  }

  return {
    categories: categoryMatches.map((m) => m.category),
    categoryMatches,
  };
}
