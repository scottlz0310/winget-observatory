/**
 * GitHub Search API の 1,000 件制限を回避するための日付窓（スライス）分割純粋関数群。
 * 外部 I/O を行わず、日付計算とクエリ文字列構築のみを担う。
 */

export interface DateWindowSlice {
  since: Date;
  until: Date;
  /** GitHub 検索クエリの日付範囲フラグメント（例: "merged:2026-10-01T00:00:00.000Z..2026-10-15T00:00:00.000Z"） */
  queryFilter: string;
}

/**
 * 開始日時（since）から終了日時（until）までの期間を、
 * 指定された日数幅（デフォルト 14 日）のスライスに分割する。
 *
 * 直近の PR ほどキャッシュや最新状態の判定で優先度が高いため、
 * 新しいスライスから過去へ向かう降順（descending）で返す。
 *
 * @param since 探索開始日時（最古）
 * @param until 探索終了日時（最新）
 * @param sliceDays 各スライスの日数幅（デフォルト 14 日）
 */
export function buildDateWindowSlices(
  since: Date,
  until: Date,
  sliceDays: number = 14,
): DateWindowSlice[] {
  if (since.getTime() >= until.getTime()) {
    return [];
  }

  const validSliceDays = sliceDays > 0 ? sliceDays : 14;
  const sliceMs = validSliceDays * 24 * 60 * 60 * 1000;
  const slices: DateWindowSlice[] = [];

  let currentUntil = until;
  while (currentUntil.getTime() > since.getTime()) {
    const rawSinceMs = currentUntil.getTime() - sliceMs;
    const currentSince = new Date(Math.max(since.getTime(), rawSinceMs));

    slices.push({
      since: currentSince,
      until: currentUntil,
      queryFilter: `merged:${currentSince.toISOString()}..${currentUntil.toISOString()}`,
    });

    currentUntil = currentSince;
  }

  return slices;
}
