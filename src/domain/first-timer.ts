/**
 * マージ済みサンプルの初回提出者（First-Timer）判定に関する純粋関数群。
 * 外部 I/O を行わず、src/models の型定義のみに依存する。
 */

import { isBlockedLabel } from "./progress";

export interface TimelineEventLike {
  event: string;
  created_at?: string;
  label?: { name: string };
}

/**
 * タイムライン履歴および Draft 状態を検査し、阻害要因（阻害ラベル付与・Draft化・Draft公開復帰）が
 * 過去に一度でも発生した履歴があるか判定する。
 * 一度でも阻害や Draft 状態（最初から Draft、途中で Draft 化）が発生した PR は、
 * 途中で解除・公開されたとしても「初期健康体」とはみなさない。
 */
export function hasBlockingOrDraftHistory(
  timeline: TimelineEventLike[],
  isDraft?: boolean,
): boolean {
  if (isDraft) return true;
  for (const ev of timeline) {
    if (
      ev.event === "converted_to_draft" ||
      ev.event === "convert_to_draft" ||
      ev.event === "ready_for_review"
    ) {
      return true;
    }
    if (ev.event === "labeled" && ev.label?.name) {
      if (isBlockedLabel(ev.label.name)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * サンプルが初回提出者（1コミット・初期健康体）の前提条件を満たすか判定する。
 */
export function isFirstTimerSampleCandidate(sample: {
  commitCount: number;
  timeline?: TimelineEventLike[];
  isDraft?: boolean;
}): boolean {
  if (sample.commitCount !== 1) {
    return false;
  }
  if (sample.isDraft) {
    return false;
  }
  if (sample.timeline && hasBlockingOrDraftHistory(sample.timeline, sample.isDraft)) {
    return false;
  }
  return true;
}

/**
 * サンプル一覧から「作者が判明しており、同一サンプル内で1件しか登場しない（単発）」
 * かつ 1 コミットの候補作者 login の一意なリストを抽出する。
 */
export function extractSingleHitCandidateLogins(
  samples: Array<{ author?: string; commitCount: number; isFirstTimer?: boolean }>,
): string[] {
  const authorCounts = new Map<string, number>();
  for (const s of samples) {
    if (s.author) {
      authorCounts.set(s.author, (authorCounts.get(s.author) ?? 0) + 1);
    }
  }

  const singleHitLogins = new Set<string>();
  for (const s of samples) {
    if (s.author && authorCounts.get(s.author) === 1 && s.commitCount === 1) {
      // 既に isFirstTimer が確定していない候補
      if (s.isFirstTimer === undefined) {
        singleHitLogins.add(s.author);
      }
    }
  }

  return Array.from(singleHitLogins);
}

/**
 * 複数の作者に対する GitHub GraphQL エイリアスクエリを構築する。
 * 各作者の winget-pkgs 全期間におけるマージ済み PR 累計件数を一括照会する。
 */
export function buildAuthorMergedCountQuery(repository: string, authors: string[]): string {
  if (authors.length === 0) {
    return "";
  }

  const aliasLines = authors.map((author, index) => {
    // author login に引用符などが混入しないよう英数字/ハイフンにサニタイズ（安全対策）
    const sanitizedAuthor = author.replace(/[^a-zA-Z0-9\-_]/g, "");
    return `  u_${index}: search(query: "repo:${repository} is:pr is:merged author:${sanitizedAuthor}", type: ISSUE, first: 1) { issueCount }`;
  });

  return `query {\n${aliasLines.join("\n")}\n}`;
}

/**
 * GraphQL エイリアス検索結果から、作者ごとの累計マージ件数マップを復元する。
 */
export function parseAuthorMergedCounts(
  authors: string[],
  data: Record<string, { issueCount?: number } | undefined>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < authors.length; i++) {
    const author = authors[i];
    const key = `u_${i}`;
    const issueCount = data[key]?.issueCount ?? 0;
    counts.set(author, issueCount);
  }
  return counts;
}
