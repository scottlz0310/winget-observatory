/**
 * マージ済みサンプルの初回提出者（First-Timer）判定に関する純粋関数群。
 * 外部 I/O を行わず、src/models の型定義のみに依存する。
 */

import { BLOCKED_PATTERNS } from "./progress";

/**
 * サンプルが初回提出者（1コミット・阻害ラベルなし）の前提条件を満たすか判定する。
 */
export function isFirstTimerSampleCandidate(sample: {
  commitCount: number;
  labels?: string[];
}): boolean {
  if (sample.commitCount !== 1) {
    return false;
  }
  const labels = sample.labels ?? [];
  const hasBlocked = labels.some((name) => BLOCKED_PATTERNS.some((pattern) => pattern.test(name)));
  return !hasBlocked;
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
