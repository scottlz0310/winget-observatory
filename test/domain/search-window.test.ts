import { describe, expect, it } from "bun:test";
import { buildDateWindowSlices } from "../../src/domain/search-window";

describe("buildDateWindowSlices", () => {
  it("90日間の期間を14日幅で隙間なく降順スライスに分割する", () => {
    const until = new Date("2026-11-13T12:00:00.000Z");
    const since = new Date(until.getTime() - 90 * 24 * 60 * 60 * 1000);

    const slices = buildDateWindowSlices(since, until, 14);

    // 90日 / 14日 = 6スライス (14日×6 = 84日) + 1スライス (6日) = 計7スライス
    expect(slices).toHaveLength(7);

    // 最初のスライス（最新）の until が指定した until と一致
    expect(slices[0].until.toISOString()).toBe(until.toISOString());

    // 最後のスライス（最古）の since が指定した since と一致
    expect(slices[slices.length - 1].since.toISOString()).toBe(since.toISOString());

    // スライス間の連続性（隙間・重複なし）と降順性を検証
    for (let i = 0; i < slices.length - 1; i++) {
      const current = slices[i];
      const next = slices[i + 1];

      // 現在スライスの since と次スライスの until が完全に一致すること
      expect(current.since.toISOString()).toBe(next.until.toISOString());

      // 各スライス内で since < until であること
      expect(current.since.getTime()).toBeLessThan(current.until.getTime());

      // クエリ文字列の形式が正しいこと
      expect(current.queryFilter).toBe(
        `merged:${current.since.toISOString()}..${current.until.toISOString()}`,
      );
    }
  });

  it("since >= until の場合は空配列を返す", () => {
    const date = new Date("2026-11-13T12:00:00.000Z");
    expect(buildDateWindowSlices(date, date)).toEqual([]);

    const future = new Date("2026-11-14T12:00:00.000Z");
    expect(buildDateWindowSlices(future, date)).toEqual([]);
  });

  it("期間がスライス幅以下の場合は単一スライスを返す", () => {
    const since = new Date("2026-11-01T00:00:00.000Z");
    const until = new Date("2026-11-08T00:00:00.000Z"); // 7日間

    const slices = buildDateWindowSlices(since, until, 14);
    expect(slices).toHaveLength(1);
    expect(slices[0].since.toISOString()).toBe(since.toISOString());
    expect(slices[0].until.toISOString()).toBe(until.toISOString());
    expect(slices[0].queryFilter).toBe("merged:2026-11-01T00:00:00.000Z..2026-11-08T00:00:00.000Z");
  });

  it("不正な sliceDays (0 または負数) の場合はデフォルト 14 日にフォールバックする", () => {
    const until = new Date("2026-11-13T12:00:00.000Z");
    const since = new Date(until.getTime() - 28 * 24 * 60 * 60 * 1000);

    const slicesWithZero = buildDateWindowSlices(since, until, 0);
    expect(slicesWithZero).toHaveLength(2);

    const slicesWithNegative = buildDateWindowSlices(since, until, -5);
    expect(slicesWithNegative).toHaveLength(2);
  });
});
