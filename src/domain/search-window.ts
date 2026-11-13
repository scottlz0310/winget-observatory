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

interface WindowSlice {
  since: Date;
  until: Date;
}

/**
 * 探索期間内のマージ済み PR を GitHub Search API により全量走査する。
 *
 * Search API の 1,000 件上限（100件/page × 10ページ）を回避するため、
 * 1 走査窓で 1,000 件を超過する過密期間については、未走査範囲を捨てずに
 * 時間範囲を二分（bisect）して再帰的に漏れなく走査する「動的二分窓走査方式」を採用する。
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

  if (since.getTime() >= until.getTime() || fetchLimit <= 0) {
    return [];
  }

  const candidates: GitHubDetailedSearchItem[] = [];
  const seenPrNumbers = new Set<number>();

  // LIFO スタック: 新しい期間から先に処理するため、二分時は古い方を先に push し新しい方を後に push する
  const stack: WindowSlice[] = [{ since, until }];

  while (stack.length > 0 && candidates.length < fetchLimit) {
    const currentSlice = stack.pop();
    if (!currentSlice) break;

    const sliceSince = currentSlice.since;
    const sliceUntil = currentSlice.until;
    if (sliceSince.getTime() >= sliceUntil.getTime()) {
      continue;
    }

    const query = [
      `repo:${repository}`,
      "is:pr",
      "is:merged",
      `merged:${sliceSince.toISOString()}..${sliceUntil.toISOString()}`,
      ...requiredLabels.map((l) => `label:"${l}"`),
    ].join(" ");

    // 窓の 1 ページ目をまず取得
    const firstPage = await client.searchIssuesDetailed(
      query,
      "updated",
      "desc",
      pageSize,
      1,
      null,
    );

    // 候補が 0 件ならこの窓は完了
    if (firstPage.totalCount === 0) {
      continue;
    }

    // 1 窓の収容上限（既定 1,000 件）を超過している場合は、この窓を二分する
    const windowCapacity = maxPagesPerWindow * pageSize;
    if (firstPage.totalCount > windowCapacity) {
      const durationMs = sliceUntil.getTime() - sliceSince.getTime();
      if (durationMs <= 1000) {
        throw new Error(
          `期間 (${sliceSince.toISOString()} .. ${sliceUntil.toISOString()}) のマージ済み PR 件数が Search API の上限 1,000 件を超過しており、これ以上分割できないため安全に全件走査できません。`,
        );
      }
      const midMs = Math.floor((sliceSince.getTime() + sliceUntil.getTime()) / 2);
      const mid = new Date(midMs);
      // 古い方を先に push、新しい方を後に push（新しい方から pop される）
      stack.push({ since: sliceSince, until: mid });
      stack.push({ since: mid, until: sliceUntil });
      continue;
    }

    if (!firstPage.items || firstPage.items.length === 0) {
      continue;
    }

    // 1,000 件以内に収まっている窓: 1 ページ目のアイテムを追加し、残りをページネーション取得
    const addItems = (items: GitHubDetailedSearchItem[]): boolean => {
      for (const item of items) {
        if (candidates.length >= fetchLimit) return false;
        if (item.number !== targetPr && item.pull_request?.merged_at) {
          const mergedDate = new Date(item.pull_request.merged_at);
          if (mergedDate.getTime() >= since.getTime()) {
            if (!seenPrNumbers.has(item.number)) {
              seenPrNumbers.add(item.number);
              candidates.push(item);
              if (candidates.length >= fetchLimit) return false;
            }
          }
        }
      }
      return true;
    };

    if (!addItems(firstPage.items)) {
      break;
    }

    let hasNextPage = Boolean(
      firstPage.pageInfo ? firstPage.pageInfo.hasNextPage : firstPage.items.length >= pageSize,
    );
    let cursor = firstPage.pageInfo?.endCursor ?? null;
    let page = 2;

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
        break;
      }

      if (!addItems(res.items)) {
        break;
      }

      hasNextPage = Boolean(res.pageInfo ? res.pageInfo.hasNextPage : res.items.length >= pageSize);
      cursor = res.pageInfo?.endCursor ?? null;
      page++;
    }

    // 万が一 totalCount の過小報告等で maxPagesPerWindow に達してなお未取得データが残っている場合
    if (hasNextPage && page > maxPagesPerWindow) {
      const durationMs = sliceUntil.getTime() - sliceSince.getTime();
      if (durationMs <= 1000) {
        throw new Error(
          `期間 (${sliceSince.toISOString()} .. ${sliceUntil.toISOString()}) のマージ済み PR 件数が Search API の上限 1,000 件を超過しており、これ以上分割できないため安全に全件走査できません。`,
        );
      }
      const midMs = Math.floor((sliceSince.getTime() + sliceUntil.getTime()) / 2);
      const mid = new Date(midMs);
      stack.push({ since: sliceSince, until: mid });
      stack.push({ since: mid, until: sliceUntil });
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
