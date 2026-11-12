import { describe, expect, test } from "bun:test";
import {
  buildGuidance,
  buildReferenceGuidance,
  compareWithSamples,
  describeGuidance,
  describeOvertake,
  SNAPSHOT_SAMPLE_LIMIT,
  toSnapshotSamples,
} from "../../src/domain/benchmark";
import type { MergedCandidateSample, ProgressStatsSummary } from "../../src/models/progress";

function sample(
  number: number,
  createdAt: string,
  readyAt: string,
  overrides: Partial<MergedCandidateSample> = {},
): MergedCandidateSample {
  return {
    number,
    title: `PR ${number}`,
    createdAt,
    latestCommittedDate: createdAt,
    commitCount: 1,
    readyAt,
    mergedAt: "2026-11-05T00:00:00Z",
    totalDays: 4,
    turnDays: 4,
    days: 3,
    ...overrides,
  };
}

const target = {
  number: 500,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  readyAt: new Date("2026-11-01T02:00:00Z"),
};

describe("Domain: compareWithSamples（追い越しの判定）", () => {
  test.each([
    {
      name: "すべて基準 PR より前に作成されていれば all-older",
      samples: [
        sample(400, "2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z"),
        sample(450, "2026-10-25T00:00:00Z", "2026-10-25T01:00:00Z"),
      ],
      expected: {
        LaterReady: 0,
        LaterCreated: 0,
        EarlierCreated: 2,
        NewerNumber: 0,
        OlderNumber: 2,
        Verdict: "all-older",
        FirstTimerLaterCreated: 0,
        RepeatOrExpressLaterCreated: 0,
        UnknownLaterCreated: 0,
      },
    },
    {
      name: "基準 PR より後に作成されたものが 2 件以下なら mostly-older",
      samples: [
        sample(400, "2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z"),
        sample(600, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z"),
      ],
      expected: {
        LaterReady: 1,
        LaterCreated: 1,
        EarlierCreated: 1,
        NewerNumber: 1,
        OlderNumber: 1,
        Verdict: "mostly-older",
        FirstTimerLaterCreated: 0,
        RepeatOrExpressLaterCreated: 0,
        UnknownLaterCreated: 1,
      },
    },
    {
      name: "後から作成されたものが 3 件以上なら overtaken",
      samples: [
        sample(600, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z"),
        sample(601, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z"),
        sample(602, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z"),
      ],
      expected: {
        LaterReady: 3,
        LaterCreated: 3,
        EarlierCreated: 0,
        NewerNumber: 3,
        OlderNumber: 0,
        Verdict: "overtaken",
        FirstTimerLaterCreated: 0,
        RepeatOrExpressLaterCreated: 0,
        UnknownLaterCreated: 3,
      },
    },
    {
      name: "初回提出者と常連・特急レーンの追い越しを分離集計する",
      samples: [
        sample(600, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z", { isFirstTimer: true }),
        sample(601, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z", { isFirstTimer: false }),
        sample(602, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z"),
      ],
      expected: {
        LaterReady: 3,
        LaterCreated: 3,
        EarlierCreated: 0,
        NewerNumber: 3,
        OlderNumber: 0,
        Verdict: "overtaken",
        FirstTimerLaterCreated: 1,
        RepeatOrExpressLaterCreated: 1,
        UnknownLaterCreated: 1,
      },
    },
    {
      name: "作成時刻が同一なら後に作成された扱いにしない（以前に数える）",
      samples: [sample(499, "2026-11-01T00:00:00Z", "2026-11-01T02:00:00Z")],
      expected: {
        LaterReady: 0,
        LaterCreated: 0,
        EarlierCreated: 1,
        NewerNumber: 0,
        OlderNumber: 1,
        Verdict: "all-older",
        FirstTimerLaterCreated: 0,
        RepeatOrExpressLaterCreated: 0,
        UnknownLaterCreated: 0,
      },
    },
  ])("$name", ({ samples, expected }) => {
    expect(compareWithSamples([...samples], target)).toEqual(expected);
  });
});

describe("Domain: buildReferenceGuidance（実績との位置づけ）", () => {
  const metrics = { median: 5, p75: 8 };
  const values = [2, 4, 5, 6, 8, 10];

  test.each([
    {
      name: "中央値以内",
      current: 3,
      expected: { Level: "within-median", ToMedianDays: 2, ToP75Days: 5, ShorterSharePct: 17 },
    },
    {
      name: "中央値ちょうどは中央値を超えた扱い",
      current: 5,
      expected: { Level: "within-p75", ToMedianDays: null, ToP75Days: 3, ShorterSharePct: 33 },
    },
    {
      name: "75%点超",
      current: 9,
      expected: { Level: "over-p75", ToMedianDays: null, ToP75Days: null, ShorterSharePct: 83 },
    },
  ])("$name", ({ current, expected }) => {
    expect(buildReferenceGuidance(current, metrics, values)).toEqual(expected);
  });

  test("サンプルが空なら割合は 0 とする", () => {
    expect(buildReferenceGuidance(1, metrics, []).ShorterSharePct).toBe(0);
  });

  test("3 指標それぞれの現在値で位置づけを求める", () => {
    const samples = [sample(400, "2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z")];
    const stats: ProgressStatsSummary = {
      sampleCount: 1,
      skippedCount: 0,
      total: { median: 4, p75: 4, max: 4 },
      turn: { median: 4, p75: 4, max: 4 },
      ready: { median: 3, p75: 3, max: 3 },
    };
    const g = buildGuidance(stats, samples, { totalDays: 1, turnDays: 5, readyDays: 3.5 });
    expect(g.Total.Level).toBe("within-median");
    expect(g.Turn.Level).toBe("over-p75");
    expect(g.Ready.Level).toBe("over-p75");
  });
});

describe("Domain: describe 系の説明文", () => {
  const fmt = (d: number) => `${d}日`;

  test.each([
    {
      g: { Level: "within-median", ToMedianDays: 2, ToP75Days: 5, ShorterSharePct: 0 },
      text: "中央値以内です（中央値まであと約 2日）。",
    },
    {
      g: { Level: "within-p75", ToMedianDays: null, ToP75Days: 3, ShorterSharePct: 0 },
      text: "中央値を超えています（75%点まであと約 3日）。",
    },
    {
      g: { Level: "over-p75", ToMedianDays: null, ToP75Days: null, ShorterSharePct: 0 },
      text: "75%点を超えており、長めの滞留となっています。",
    },
  ] as const)("位置づけ $g.Level", ({ g, text }) => {
    expect(describeGuidance(g, fmt)).toBe(text);
  });

  test.each([
    {
      c: {
        LaterReady: 0,
        LaterCreated: 0,
        EarlierCreated: 4,
        NewerNumber: 0,
        OlderNumber: 4,
        Verdict: "all-older" as const,
      },
      includes: "追い越されてはいません",
    },
    {
      c: {
        LaterReady: 1,
        LaterCreated: 1,
        EarlierCreated: 3,
        NewerNumber: 1,
        OlderNumber: 3,
        Verdict: "mostly-older" as const,
      },
      includes: "大きく追い越されているわけではありません",
    },
    {
      c: {
        LaterReady: 4,
        LaterCreated: 4,
        EarlierCreated: 0,
        NewerNumber: 4,
        OlderNumber: 0,
        Verdict: "overtaken" as const,
        FirstTimerLaterCreated: 0,
        RepeatOrExpressLaterCreated: 4,
        UnknownLaterCreated: 0,
      },
      includes: "初回提出者による追い越しはありません",
    },
    {
      c: {
        LaterReady: 4,
        LaterCreated: 4,
        EarlierCreated: 0,
        NewerNumber: 4,
        OlderNumber: 0,
        Verdict: "overtaken" as const,
        FirstTimerLaterCreated: 0,
        RepeatOrExpressLaterCreated: 3,
        UnknownLaterCreated: 1,
      },
      includes: "確定した初回提出者による追い越しはありません",
    },
    {
      c: {
        LaterReady: 4,
        LaterCreated: 4,
        EarlierCreated: 0,
        NewerNumber: 4,
        OlderNumber: 0,
        Verdict: "overtaken" as const,
        FirstTimerLaterCreated: 1,
        RepeatOrExpressLaterCreated: 3,
        UnknownLaterCreated: 0,
      },
      includes: "うち初回提出者 1 件、常連・特急レーン 3 件",
    },
  ])("追い越し判定 $c.Verdict ($includes)", ({ c, includes }) => {
    expect(describeOvertake(c)).toContain(includes);
  });
});

describe("Domain: toSnapshotSamples", () => {
  test("基準 PR 番号との大小で作成順の関係を付与する", () => {
    const out = toSnapshotSamples(
      [
        sample(400, "2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z"),
        sample(600, "2026-11-02T00:00:00Z", "2026-11-02T01:00:00Z"),
      ],
      500,
    );
    expect(out.map((s) => s.Relation)).toEqual(["older", "newer"]);
    expect(out[0]).toMatchObject({ Number: 400, ReadyDays: 3, TotalDays: 4 });
  });

  test("一覧には、マージが新しい順に上限件数だけ載せる（入力の並びに依らない）", () => {
    const merged = (n: number) => ({
      ...sample(n, "2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z"),
      mergedAt: `2026-11-${String(n - 1000 + 1).padStart(2, "0")}T00:00:00Z`,
    });
    // 古い順・新しい順を混ぜて渡す
    const input = [merged(1002), merged(1000), merged(1004), merged(1001), merged(1003)];

    expect(toSnapshotSamples(input, 500, 3).map((s) => s.Number)).toEqual([1004, 1003, 1002]);
    expect(toSnapshotSamples(input, 500).map((s) => s.Number)).toEqual([
      1004, 1003, 1002, 1001, 1000,
    ]);
  });

  test("既定の上限は SNAPSHOT_SAMPLE_LIMIT 件", () => {
    const many = Array.from({ length: SNAPSHOT_SAMPLE_LIMIT + 10 }, (_, i) =>
      sample(1000 + i, "2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z"),
    );
    expect(SNAPSHOT_SAMPLE_LIMIT).toBe(30);
    expect(toSnapshotSamples(many, 500)).toHaveLength(SNAPSHOT_SAMPLE_LIMIT);
  });
});
