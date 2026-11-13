import type { GitHubDetailedSearchItem, GitHubDetailedSearchResult } from "../models/progress";

export interface CandidateSearchClient {
  searchIssuesDetailed(
    query: string,
    sort?: string,
    order?: string,
    perPage?: number,
    page?: number,
    cursor?: string | null,
  ): Promise<GitHubDetailedSearchResult>;
}

export interface CollectMergedCandidatesParams {
  client: CandidateSearchClient;
  repository: string;
  since: Date;
  until: Date;
  targetPr: number;
  requiredLabels: readonly string[];
  fetchLimit?: number;
  pageSize?: number;
  maxPagesPerWindow?: number;
}

/**
 * 探索期間内のマージ済み PR を GitHub Search API により全量走査する。
 *
 * Search API の 1,000 件上限（100件/page × 10ページ）を回避するため、
 * 1 走査窓で 1,000 件に到達し未取得 PR が残っている場合は、
 * その窓で取得できた最古の merged_at を次窓の until に設定して過去へ前進する
 * 「カーソルスライド方式（絶対数区切り）」を採用する。
 *
 * @param params 探索パラメータ
 * @returns 収集されたマージ済み PR アイテム一覧（降順）
 */
export async function collectMergedCandidates(
  params: CollectMergedCandidatesParams,
): Promise<GitHubDetailedSearchItem[]> {
  const {
    client,
    repository,
    since,
    until,
    targetPr,
    requiredLabels,
    fetchLimit = 5000,
    pageSize = 100,
    maxPagesPerWindow = 10,
  } = params;

  if (since.getTime() >= until.getTime()) {
    return [];
  }

  const candidates: GitHubDetailedSearchItem[] = [];
  const seenPrNumbers = new Set<number>();
  let currentUntil = until;

  while (currentUntil.getTime() > since.getTime() && candidates.length < fetchLimit) {
    const query = [
      `repo:${repository}`,
      "is:pr",
      "is:merged",
      `merged:${since.toISOString()}..${currentUntil.toISOString()}`,
      ...requiredLabels.map((l) => `label:"${l}"`),
    ].join(" ");

    let cursor: string | null = null;
    let page = 1;
    let windowOldestMergedAt: Date | null = null;
    let windowCount = 0;
    let hasNextPage = true;

    while (hasNextPage && page <= maxPagesPerWindow && candidates.length < fetchLimit) {
      const res = await client.searchIssuesDetailed(
        query,
        "updated",
        "desc",
        pageSize,
        page,
        cursor,
      );

      if (!res.items || res.items.length === 0) {
        hasNextPage = false;
        break;
      }

      for (const item of res.items) {
        if (item.number !== targetPr && item.pull_request?.merged_at) {
          const mergedDate = new Date(item.pull_request.merged_at);
          if (mergedDate.getTime() >= since.getTime()) {
            if (!seenPrNumbers.has(item.number)) {
              seenPrNumbers.add(item.number);
              candidates.push(item);
            }
            if (!windowOldestMergedAt || mergedDate.getTime() < windowOldestMergedAt.getTime()) {
              windowOldestMergedAt = mergedDate;
            }
          }
        }
      }

      windowCount += res.items.length;
      hasNextPage = res.pageInfo
        ? Boolean(res.pageInfo.hasNextPage && res.pageInfo.endCursor)
        : res.items.length >= pageSize;
      cursor = res.pageInfo?.endCursor ?? null;
      page++;
    }

    // 候補が 1 件も得られなかった場合はこれ以上過去へ遡れないため終了
    if (windowCount === 0) {
      break;
    }

    // 1走査窓の上限（maxPagesPerWindow）に到達し、さらに未走査 PR が残っている場合
    if (hasNextPage || windowCount >= maxPagesPerWindow * pageSize) {
      if (!windowOldestMergedAt || windowOldestMergedAt.getTime() >= currentUntil.getTime()) {
        // 同一タイムスタンプ付近で 1,000 件を超過しており前進不能な場合は安全に中断
        throw new Error(
          `同一マージ時刻 (${currentUntil.toISOString()}) 付近のマージ済み PR 件数が Search API の上限 1,000 件を超過しており、これ以上カーソルを前進できないため安全に全件走査できません。`,
        );
      }
      // 最古の merged_at を次の until にして過去へスライド！
      currentUntil = windowOldestMergedAt;
    } else {
      // 期間内の全アイテムを走査完了
      break;
    }
  }

  // 降順ソートを保証
  candidates.sort(
    (a, b) =>
      new Date(b.pull_request?.merged_at ?? b.updated_at).getTime() -
      new Date(a.pull_request?.merged_at ?? a.updated_at).getTime(),
  );

  return candidates;
}
