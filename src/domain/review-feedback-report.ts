/**
 * レビュー差し戻し指摘の集計サマリー算出および Markdown レポート生成を行う純粋ドメイン関数群。
 */

import type {
  CategorySummaryRow,
  FeedbackTriggerKind,
  InstallerTypeSummaryRow,
  ReviewFeedbackCategoryId,
  ReviewFeedbackPrState,
  ReviewFeedbackRecord,
  ReviewFeedbackSummary,
} from "../models/review-feedback";
import { formatJstDate, formatJstDateTime, round1 } from "./formatters";
import {
  CATEGORY_LABELS,
  classifyFeedbackCommentSeverity,
  hasBlockingFeedbackItems,
} from "./review-feedback";

const ALL_CATEGORY_IDS: readonly ReviewFeedbackCategoryId[] = [
  "privacy-policy",
  "dll-runtime",
  "launch-command",
  "metadata-url",
  "manifest-installer",
  "locale-language",
  "security-signing",
  "uncategorized",
] as const;

const TRIGGER_LABELS: Record<FeedbackTriggerKind, string> = {
  "needs-author-feedback-label": "Needs-Author-Feedback ラベル履歴",
  "changes-requested-label": "Changes-Requested ラベル履歴",
  "changes-requested-review": "CHANGES_REQUESTED レビュー",
  "closed-rejection-label": "CLOSED 却下系ラベル（Blocking / Policy / Scripted 等）",
  "closed-maintainer-feedback": "CLOSED メンテナ指摘コメント",
};

/**
 * 収集済みフィードバックレコード群からカテゴリ別トレンド・インストーラー種別内訳を集計する。
 */
export function summarizeReviewFeedback(params: {
  repository: string;
  records: readonly ReviewFeedbackRecord[];
  generatedAt: string;
  samplePrLimitPerCategory?: number;
}): ReviewFeedbackSummary {
  const { repository, records, generatedAt, samplePrLimitPerCategory = 10 } = params;
  const totalFeedbackPrs = records.length;

  const stateCounts: Record<ReviewFeedbackPrState, number> = {
    MERGED: 0,
    OPEN: 0,
    CLOSED: 0,
  };
  const triggerCounts: Record<FeedbackTriggerKind, number> = {
    "needs-author-feedback-label": 0,
    "changes-requested-label": 0,
    "changes-requested-review": 0,
    "closed-rejection-label": 0,
    "closed-maintainer-feedback": 0,
  };

  const categoryPrs = new Map<ReviewFeedbackCategoryId, ReviewFeedbackRecord[]>();
  const categoryKeywordCounts = new Map<ReviewFeedbackCategoryId, Map<string, number>>();
  for (const id of ALL_CATEGORY_IDS) {
    categoryPrs.set(id, []);
    categoryKeywordCounts.set(id, new Map());
  }

  const installerTypeMap = new Map<string, number>();
  const nestedTypeMap = new Map<string, number>();

  let blockingPrCount = 0;
  let nonBlockingOnlyPrCount = 0;
  let totalFeedbackComments = 0;
  let totalAuthorReplies = 0;
  let portablePrCount = 0;
  let firstTimeAuthorPrCount = 0;

  const sortedRecords = [...records].sort((a, b) => b.number - a.number);

  for (const rec of sortedRecords) {
    stateCounts[rec.state]++;
    const hasBlocking =
      rec.hasBlockingFeedback !== undefined
        ? rec.hasBlockingFeedback
        : hasBlockingFeedbackItems(rec.feedbackItems);
    if (hasBlocking) {
      blockingPrCount++;
    } else {
      nonBlockingOnlyPrCount++;
    }
    totalFeedbackComments += rec.feedbackItems.length;
    totalAuthorReplies += rec.authorReplies.length;
    if (rec.installer.isPortable) {
      portablePrCount++;
    }
    if (rec.isFirstTimeAuthor === true) {
      firstTimeAuthorPrCount++;
    }

    for (const trigger of rec.triggers) {
      triggerCounts[trigger]++;
    }

    const recCategories = rec.categories.length > 0 ? rec.categories : (["uncategorized"] as const);
    for (const cat of recCategories) {
      categoryPrs.get(cat)?.push(rec);
    }

    for (const match of rec.categoryMatches) {
      const kwMap = categoryKeywordCounts.get(match.category);
      if (!kwMap) continue;
      for (const kw of match.matchedKeywords) {
        kwMap.set(kw, (kwMap.get(kw) ?? 0) + 1);
      }
    }

    const instTypes =
      rec.installer.installerTypes.length > 0 ? rec.installer.installerTypes : ["(unknown)"];
    for (const t of instTypes) {
      installerTypeMap.set(t, (installerTypeMap.get(t) ?? 0) + 1);
    }

    for (const nt of rec.installer.nestedInstallerTypes) {
      nestedTypeMap.set(nt, (nestedTypeMap.get(nt) ?? 0) + 1);
    }
  }

  const calcRatio = (count: number): number =>
    totalFeedbackPrs > 0 ? round1((count / totalFeedbackPrs) * 100) : 0;

  const categoryRanking: CategorySummaryRow[] = ALL_CATEGORY_IDS.map((category) => {
    const matched = categoryPrs.get(category) ?? [];
    const kwMap = categoryKeywordCounts.get(category) ?? new Map<string, number>();
    const topKeywords = [...kwMap.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6)
      .map(([keyword, count]) => ({ keyword, count }));

    return {
      category,
      label: CATEGORY_LABELS[category],
      count: matched.length,
      ratioPercent: calcRatio(matched.length),
      topKeywords,
      samplePrNumbers: matched.slice(0, samplePrLimitPerCategory).map((r) => r.number),
    };
  }).sort((a, b) => {
    // uncategorized は件数に関わらず末尾に配置し、上位ランキングを見やすくする
    if (a.category === "uncategorized" && b.category !== "uncategorized") return 1;
    if (b.category === "uncategorized" && a.category !== "uncategorized") return -1;
    return b.count - a.count || a.category.localeCompare(b.category);
  });

  const toBreakdown = (map: Map<string, number>): InstallerTypeSummaryRow[] =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({
        key,
        count,
        ratioPercent: calcRatio(count),
      }));

  return {
    repository,
    generatedAt,
    totalFeedbackPrs,
    blockingPrCount,
    nonBlockingOnlyPrCount,
    totalFeedbackComments,
    totalAuthorReplies,
    portablePrCount,
    firstTimeAuthorPrCount,
    stateCounts,
    triggerCounts,
    categoryRanking,
    installerTypeBreakdown: toBreakdown(installerTypeMap),
    nestedInstallerTypeBreakdown: toBreakdown(nestedTypeMap),
  };
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatExcerpt(body: string, maxLength = 280): string {
  const singleLine = body.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength)}…`;
}

/**
 * 集計結果と詳細レコード群から、LLM 読込・人間確認兼用の Markdown レポートを生成する。
 */
export function formatReviewFeedbackMarkdown(params: {
  summary: ReviewFeedbackSummary;
  records: readonly ReviewFeedbackRecord[];
  maxSamplesPerCategory?: number;
}): string {
  const { summary, records, maxSamplesPerCategory = 10 } = params;
  const recordByNumber = new Map<number, ReviewFeedbackRecord>(records.map((r) => [r.number, r]));

  const lines: string[] = [];
  lines.push(`# ${summary.repository} 初回提出 PR メンテナ差し戻し指摘レポート`);
  lines.push("");
  lines.push(`- 生成日時: ${formatJstDateTime(summary.generatedAt)} (${summary.generatedAt})`);
  lines.push(
    `- 抽出 PR 件数: **${summary.totalFeedbackPrs} 件**（MERGED: ${summary.stateCounts.MERGED} / OPEN: ${summary.stateCounts.OPEN} / CLOSED: ${summary.stateCounts.CLOSED}）`,
  );
  lines.push(
    `- 深刻度内訳: ブロッキング差し戻しあり **${summary.blockingPrCount} 件** / 非ブロッキング助言のみ **${summary.nonBlockingOnlyPrCount} 件**`,
  );
  lines.push(
    `- 指摘コメント総数: ${summary.totalFeedbackComments} 件 / 作成者返信総数: ${summary.totalAuthorReplies} 件`,
  );
  lines.push(`- ポータブル配布形式（portable / zip+portable）: ${summary.portablePrCount} 件`);
  lines.push(`- 初回提出者（生涯マージ 1 以下）判定済み: ${summary.firstTimeAuthorPrCount} 件`);
  lines.push("");

  lines.push("## 差し戻しトリガー内訳");
  lines.push("");
  lines.push("| トリガー | 件数 |");
  lines.push("| :--- | ---: |");
  for (const [kind, count] of Object.entries(summary.triggerCounts) as Array<
    [FeedbackTriggerKind, number]
  >) {
    lines.push(`| ${TRIGGER_LABELS[kind]} | ${count} |`);
  }
  lines.push("");

  lines.push("## 頻出地雷カテゴリランキング");
  lines.push("");
  lines.push("| カテゴリ | ID | PR 件数 | 割合 | 主なマッチ語 |");
  lines.push("| :--- | :--- | ---: | ---: | :--- |");
  for (const row of summary.categoryRanking) {
    const kwText =
      row.topKeywords.length > 0
        ? row.topKeywords.map((k) => `\`${k.keyword}\`(${k.count})`).join(", ")
        : "—";
    lines.push(
      `| ${escapeMarkdownCell(row.label)} | \`${row.category}\` | ${row.count} | ${row.ratioPercent.toFixed(1)}% | ${kwText} |`,
    );
  }
  lines.push("");

  lines.push("## インストーラー種別内訳");
  lines.push("");
  if (summary.installerTypeBreakdown.length === 0) {
    lines.push("該当データなし。");
  } else {
    lines.push("| InstallerType | PR 件数 | 割合 |");
    lines.push("| :--- | ---: | ---: |");
    for (const row of summary.installerTypeBreakdown) {
      lines.push(
        `| \`${escapeMarkdownCell(row.key)}\` | ${row.count} | ${row.ratioPercent.toFixed(1)}% |`,
      );
    }
  }
  if (summary.nestedInstallerTypeBreakdown.length > 0) {
    lines.push("");
    lines.push("| NestedInstallerType | PR 件数 | 割合 |");
    lines.push("| :--- | ---: | ---: |");
    for (const row of summary.nestedInstallerTypeBreakdown) {
      lines.push(
        `| \`${escapeMarkdownCell(row.key)}\` | ${row.count} | ${row.ratioPercent.toFixed(1)}% |`,
      );
    }
  }
  lines.push("");

  lines.push("## カテゴリ別 具体的な差し戻し事例抜粋");
  lines.push("");

  for (const row of summary.categoryRanking) {
    lines.push(`### ${row.label} (\`${row.category}\`: ${row.count} 件)`);
    lines.push("");
    if (row.samplePrNumbers.length === 0) {
      lines.push("該当なし。");
      lines.push("");
      continue;
    }

    const targets = row.samplePrNumbers.slice(0, maxSamplesPerCategory);
    for (const prNum of targets) {
      const rec = recordByNumber.get(prNum);
      if (!rec) continue;

      const installerTag = [
        ...rec.installer.installerTypes,
        ...rec.installer.nestedInstallerTypes.map((n) => `nested:${n}`),
      ].join(", ");
      const dateStr = formatJstDate(Date.parse(rec.mergedAt ?? rec.closedAt ?? rec.updatedAt));
      const firstTimerBadge = rec.isFirstTimeAuthor === true ? " / 初回作者" : "";
      lines.push(
        `- **[#${rec.number}](${rec.url})** ${escapeMarkdownCell(rec.title)} (${rec.state}, ${dateStr}${installerTag ? `, \`${installerTag}\`` : ""}${firstTimerBadge})`,
      );

      for (const item of rec.feedbackItems.slice(0, 3)) {
        const pathNote = item.path ? ` \`${item.path}\`` : "";
        const imgNote = item.hasImage ? " [画像添付あり]" : "";
        const severity = item.severity ?? classifyFeedbackCommentSeverity(item.body);
        const sevNote = severity === "non-blocking" ? " [非ブロッキング助言]" : "";
        lines.push(
          `  - 指摘 (${item.source}, @${item.author} [${item.authorAssociation}]${pathNote}${imgNote}${sevNote}): ${formatExcerpt(item.body)}`,
        );
      }

      if (rec.authorReplies.length > 0) {
        const firstReply = rec.authorReplies[0];
        lines.push(
          `  - 作成者返信 (@${firstReply.author}): ${formatExcerpt(firstReply.body, 200)}`,
        );
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
