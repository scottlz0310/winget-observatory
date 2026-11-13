import { describe, expect, test } from "bun:test";
import {
  BLOCKED_LABELS,
  calculateProgressStats,
  createProgressSnapshot,
  formatDateTimeWithDay,
  formatDelta,
  formatHumanDays,
  getPercentile,
  INVESTIGATION_LABELS,
  isBlockedLabel,
  isEligibleLabels,
  parseCsvRows,
  serializeCsvRows,
  simulateReadySince,
} from "../../src/domain/progress";
import type { MergedCandidateSample, ProgressTimelineEvent } from "../../src/models/progress";

describe("Domain: progress label evaluation", () => {
  test("必須3ラベルが揃っており除外ラベルがなければ eligible と判定される", () => {
    const labels = ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"];
    expect(isEligibleLabels(labels)).toBeTrue();
  });

  test.each([
    [["New-Package", "Azure-Pipeline-Passed"]],
    [["Azure-Pipeline-Passed", "Validation-Completed"]],
  ])("必須ラベルが欠けていれば eligible でない: %j", (labels) => {
    expect(isEligibleLabels(labels)).toBeFalse();
  });

  test.each(BLOCKED_LABELS)("阻害ラベル %s が含まれていれば eligible でない", (blocked) => {
    expect(isBlockedLabel(blocked)).toBeTrue();
    expect(
      isEligibleLabels(["New-Package", "Azure-Pipeline-Passed", "Validation-Completed", blocked]),
    ).toBeFalse();
  });

  test.each(INVESTIGATION_LABELS)("調査中ラベル %s が含まれていれば eligible でない", (inv) => {
    expect(isBlockedLabel(inv)).toBeTrue();
    expect(
      isEligibleLabels(["New-Package", "Azure-Pipeline-Passed", "Validation-Completed", inv]),
    ).toBeFalse();
  });

  // パターン除外ラベル: Error-*, *-Error, Policy-Test-*, Validation-Submission-*
  test.each([
    "Error-Build",
    "Installer-Error",
    "Policy-Test-Sandbox",
    "Validation-Submission-Expired",
    "Validation-Submission-Failed",
    "Validation-Submission-Mismatch",
  ])("パターン除外ラベル %s を除外する", (name) => {
    expect(isBlockedLabel(name)).toBeTrue();
  });

  test.each(["Validation-Completed", "New-Package"])("正常ラベル %s は除外されない", (name) => {
    expect(isBlockedLabel(name)).toBeFalse();
  });
});

describe("Domain: getPercentile", () => {
  test("空配列は例外を投げる", () => {
    expect(() => getPercentile([], 0.5)).toThrow("集計対象がありません。");
  });

  test.each([-0.1, 1.1])("範囲外のパーセンタイル %p は RangeError を投げる", (p) => {
    expect(() => getPercentile([1, 2], p)).toThrow(RangeError);
  });

  test.each([0, 0.5, 1])("1要素の場合 (p=%p) はその要素を返す", (p) => {
    expect(getPercentile([42], p)).toBe(42);
  });

  test.each([
    [0, 10],
    [0.5, 30],
    [0.75, 40],
    [1, 50],
  ])("複数要素のパーセンタイル p=%p を線形補間で %p と算出する", (p, expected) => {
    expect(getPercentile([10, 20, 30, 40, 50], p)).toBe(expected);
  });
});

describe("Domain: formatting utilities", () => {
  test.each([
    [1.5, "1.5日 (1日 12時間)"],
    [0.5, "0.5日 (12時間)"],
    [3.0, "3.0日 (3日 0時間)"],
  ])("formatHumanDays(%p) は丸めと日・時間表記で %s を出力する", (days, expected) => {
    expect(formatHumanDays(days)).toBe(expected);
  });

  test.each([
    [10, 8, undefined, "[前回比 +2 件]"],
    [5, 7, undefined, "[前回比 -2 件]"],
    [5, 5, undefined, "[前回比 ±0 件]"],
    [5, 3, "日", "[前回比 +2 日]"],
  ])("formatDelta(%p, %p, %p) は %s を出力する", (current, previous, unit, expected) => {
    expect(formatDelta(current, previous, unit)).toBe(expected);
  });

  test.each([
    ["2026-11-07T11:30:00Z", "2026-11-07(土) 20:30"],
    ["2026-12-31T15:00:00Z", "2027-01-01(金) 00:00"],
    ["2026-03-08T14:59:00Z", "2026-03-08(日) 23:59"],
  ])("formatDateTimeWithDay(%s) は JST 変換して曜日付きで %s を出力する", (input, expected) => {
    expect(formatDateTimeWithDay(input)).toBe(expected);
  });

  test("formatDateTimeWithDay は実行環境のタイムゾーンに依存しない", () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      expect(formatDateTimeWithDay("2026-03-08T07:30:00Z")).toBe("2026-03-08(日) 16:30");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe("Domain: simulateReadySince", () => {
  test("ラベル付与イベント履歴から成立日時を特定できる", () => {
    const events: ProgressTimelineEvent[] = [
      { event: "labeled", created_at: "2026-11-01T10:00:00Z", label: { name: "New-Package" } },
      {
        event: "labeled",
        created_at: "2026-11-01T11:00:00Z",
        label: { name: "Azure-Pipeline-Passed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-01T12:00:00Z",
        label: { name: "Validation-Completed" },
      },
    ];

    const readyAt = simulateReadySince(events, false, new Date("2026-11-02T00:00:00Z"));

    expect(readyAt).not.toBeNull();
    expect(readyAt?.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });

  test("阻害ラベルが付与されたら readyAt は null にリセットされ、外れたら再セットされる", () => {
    const events: ProgressTimelineEvent[] = [
      { event: "labeled", created_at: "2026-11-01T10:00:00Z", label: { name: "New-Package" } },
      {
        event: "labeled",
        created_at: "2026-11-01T11:00:00Z",
        label: { name: "Azure-Pipeline-Passed" },
      },
      {
        event: "labeled",
        created_at: "2026-11-01T12:00:00Z",
        label: { name: "Validation-Completed" },
      },
      // 阻害ラベル付与
      {
        event: "labeled",
        created_at: "2026-11-02T10:00:00Z",
        label: { name: "Changes-Requested" },
      },
      // 阻害ラベル解除
      {
        event: "unlabeled",
        created_at: "2026-11-03T10:00:00Z",
        label: { name: "Changes-Requested" },
      },
    ];

    const readyAt = simulateReadySince(events, false, new Date("2026-11-04T00:00:00Z"));

    expect(readyAt).not.toBeNull();
    expect(readyAt?.toISOString()).toBe("2026-11-03T10:00:00.000Z");
  });
});

describe("Domain: calculateProgressStats", () => {
  test("空配列の場合は null を返す", () => {
    expect(calculateProgressStats([])).toBeNull();
  });

  test("サンプルから中央値、P75、最大値を正しく集計する", () => {
    const samples: MergedCandidateSample[] = [
      {
        number: 1,
        title: "PR 1",
        createdAt: "2026-11-01T00:00:00Z",
        latestCommittedDate: "2026-11-01T00:00:00Z",
        commitCount: 1,
        readyAt: "2026-11-01T01:00:00Z",
        mergedAt: "2026-11-03T00:00:00Z",
        totalDays: 2.0,
        turnDays: 2.0,
        days: 1.96,
      },
      {
        number: 2,
        title: "PR 2",
        createdAt: "2026-11-01T00:00:00Z",
        latestCommittedDate: "2026-11-01T00:00:00Z",
        commitCount: 1,
        readyAt: "2026-11-01T01:00:00Z",
        mergedAt: "2026-11-05T00:00:00Z",
        totalDays: 4.0,
        turnDays: 4.0,
        days: 3.96,
      },
      {
        number: 3,
        title: "PR 3",
        createdAt: "2026-11-01T00:00:00Z",
        latestCommittedDate: "2026-11-01T00:00:00Z",
        commitCount: 1,
        readyAt: "2026-11-01T01:00:00Z",
        mergedAt: "2026-11-07T00:00:00Z",
        totalDays: 6.0,
        turnDays: 6.0,
        days: 5.96,
      },
    ];

    const stats = calculateProgressStats(samples);
    expect(stats).not.toBeNull();
    expect(stats?.sampleCount).toBe(3);
    expect(stats?.total.median).toBe(4.0);
    expect(stats?.total.p75).toBe(5.0);
    expect(stats?.total.max).toBe(6.0);
  });
});

describe("Domain: CSV and Snapshot helpers", () => {
  test("CSV のパースとシリアライズが往復できる", () => {
    const csvContent = `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount"
"2026-11-07 10:00:00","464302","464100","2026-11-06 12:00","10","50","5","3.5","3.5","2.8","1"`;

    const rows = parseCsvRows(csvContent);
    expect(rows.length).toBe(1);
    expect(rows[0].TargetPr).toBe("464302");
    expect(rows[0].TotalLifetimeDays).toBe("3.5");

    const serialized = serializeCsvRows(rows);
    expect(serialized).toContain('"464302"');
    expect(serialized).toContain('"TotalLifetimeDays"');
  });

  test("離脱の累積件数（MergedOlder / ClosedOlder）の列を往復でき、無い旧い行は空欄のまま温存する", () => {
    const header = `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis"`;
    const withNewColumns = `${header},"MergedOlder","ClosedOlder"`;
    const oldRow = `"2026-11-07 10:00:00","464302","464100","2026-11-06 12:00","10","50","5","3.5","3.5","2.8","1","updated"`;
    const newRow = `${oldRow},"192","27"`;

    // 列が無い旧いファイル → 空欄で読み、書き出すと新しい列が付く
    const [legacy] = parseCsvRows(`${header}\n${oldRow}\n`);
    expect(legacy.MergedOlder).toBe("");
    expect(legacy.ClosedOlder).toBe("");
    const serialized = serializeCsvRows([legacy]);
    expect(serialized.split("\n")[0]).toBe(withNewColumns);
    expect(serialized.split("\n")[1]).toEndWith(',"updated","",""');

    // 新しい列のあるファイル → 値を保つ
    const [row] = parseCsvRows(`${withNewColumns}\n${newRow}\n`);
    expect(row.MergedOlder).toBe("192");
    expect(row.ClosedOlder).toBe("27");
    expect(serializeCsvRows([row]).split("\n")[1]).toEndWith(',"updated","192","27"');
  });

  test("旧い行と新しい行が混在するファイルも、そのまま書き戻せる", () => {
    const rows = parseCsvRows(
      `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis","MergedOlder","ClosedOlder"\n"a","1","1","x","1","1","1","1","1","1","1","updated","",""\n"b","1","1","x","1","1","1","1","1","1","1","updated","5","6"\n`,
    );
    expect(rows.map((r) => [r.MergedOlder, r.ClosedOlder])).toEqual([
      ["", ""],
      ["5", "6"],
    ]);
    expect(parseCsvRows(serializeCsvRows(rows))).toEqual(rows);
  });

  test("旧 CSV レコードが正しく新スキーマへマイグレーションされる", () => {
    const oldRow = {
      Timestamp: "2026-11-05 10:00:00",
      TargetPr: "464302",
      FrontNumber: "464000",
      FrontCreatedAt: "2026-11-04 12:00",
      ActiveAhead: "12",
      TotalAhead: "60",
      Behind: "8",
      WaitDays: "3.2",
    };

    const header = Object.keys(oldRow).join(",");
    const [migrated] = parseCsvRows(`${header}
${Object.values(oldRow).join(",")}
`);
    expect(migrated.TotalLifetimeDays).toBe("");
    expect(migrated.TurnLatencyDays).toBe("");
    expect(migrated.WaitDays).toBe("3.2");
  });

  test("createProgressSnapshot がスナップショットを生成する", () => {
    const now = new Date("2026-11-07T11:30:00Z");
    const snapshot = createProgressSnapshot({
      now,
      repository: "microsoft/winget-pkgs",
      targetPr: 464302,
      prTitle: "Test PR",
      prUrl: "https://github.com/microsoft/winget-pkgs/pull/464302",
      prState: "OPEN",
      frontNumber: 464100,
      frontCreatedAt: "2026-11-06 12:00",
      activeAhead: 15,
      totalAhead: 100,
      behind: 10,
      totalLifetimeDays: 2.3456,
      turnLatencyDays: 1.2345,
      waitDays: 1.1111,
      commitCount: 2,
      stats: {
        sampleCount: 10,
        skippedCount: 1,
        total: { median: 3.5, p75: 5.0, max: 7.2 },
        turn: { median: 2.0, p75: 3.0, max: 4.5 },
        ready: { median: 1.8, p75: 2.5, max: 3.8 },
      },
      lookbackDays: 30,
      skippedCount: 1,
      rivals: [
        {
          number: 460000,
          title: "Rival",
          createdAt: "2026-11-01T00:00:00Z",
          updatedAt: "2026-11-02T00:00:00Z",
          url: "https://github.com/microsoft/winget-pkgs/pull/460000",
        },
      ],
      samples: [],
      targetCreatedAt: new Date("2026-11-05T00:00:00Z"),
      targetReadyAt: new Date("2026-11-05T01:00:00Z"),
    });

    expect(snapshot.TargetPr).toBe(464302);
    expect(snapshot.TotalLifetimeDays).toBe(2.35);
    expect(snapshot.TurnLatencyDays).toBe(1.23);
    expect(snapshot.TotalMedianDays).toBe(3.5);
    expect(snapshot.TimestampJst).toContain("2026-11-07");
    expect(snapshot.TotalMaxDays).toBe(7.2);
    expect(snapshot.ReadyMaxDays).toBe(3.8);
    expect(snapshot.LookbackDays).toBe(30);
    expect(snapshot.SampleCount).toBe(10);
    expect(snapshot.SkippedCount).toBe(1);
    expect(snapshot.Rivals).toEqual([
      {
        Number: 460000,
        Title: "Rival",
        Url: "https://github.com/microsoft/winget-pkgs/pull/460000",
        CreatedAt: "2026-11-01T00:00:00Z",
        UpdatedAt: "2026-11-02T00:00:00Z",
      },
    ]);
    expect(snapshot.Comparison?.Verdict).toBe("all-older");
    expect(snapshot.Guidance?.Turn.Level).toBe("within-median");
  });

  test("サンプルがなくても除外件数と取得期間を記録し、比較系は空にする", () => {
    const snapshot = createProgressSnapshot({
      now: new Date("2026-11-07T11:30:00Z"),
      repository: "microsoft/winget-pkgs",
      targetPr: 464302,
      prTitle: "Test PR",
      prUrl: "https://github.com/microsoft/winget-pkgs/pull/464302",
      prState: "OPEN",
      frontNumber: 1,
      frontCreatedAt: "2026-11-06 12:00",
      activeAhead: 1,
      totalAhead: 1,
      behind: 0,
      totalLifetimeDays: 1,
      turnLatencyDays: 1,
      waitDays: 1,
      commitCount: 1,
      stats: null,
      lookbackDays: 14,
      skippedCount: 4,
      rivals: [],
      samples: [],
      targetCreatedAt: new Date("2026-11-05T00:00:00Z"),
      targetReadyAt: new Date("2026-11-05T01:00:00Z"),
    });
    expect(snapshot.SampleCount).toBe(0);
    expect(snapshot.SkippedCount).toBe(4);
    expect(snapshot.LookbackDays).toBe(14);
    expect(snapshot.FirstTimerLookbackDays).toBe(14);
    expect(snapshot.Samples).toEqual([]);
    expect(snapshot.Comparison).toBeNull();
    expect(snapshot.Guidance).toBeNull();
    expect(snapshot.TotalMaxDays).toBeNull();
  });

  test("FirstTimerLookbackDays が明示指定された場合にスナップショットに記録される", () => {
    const snapshot = createProgressSnapshot({
      now: new Date("2026-11-07T11:30:00Z"),
      repository: "microsoft/winget-pkgs",
      targetPr: 464302,
      prTitle: "Test PR",
      prUrl: "https://github.com/microsoft/winget-pkgs/pull/464302",
      prState: "OPEN",
      frontNumber: 1,
      frontCreatedAt: "2026-11-06 12:00",
      activeAhead: 1,
      totalAhead: 1,
      behind: 0,
      totalLifetimeDays: 1,
      turnLatencyDays: 1,
      waitDays: 1,
      commitCount: 1,
      stats: null,
      lookbackDays: 30,
      firstTimerLookbackDays: 90,
      firstTimerStats: {
        sampleCount: 5,
        skippedCount: 0,
        total: { median: 37.0, p75: 39.0, max: 45.0 },
        turn: { median: 12.5, p75: 15.0, max: 20.0 },
        ready: { median: 10.0, p75: 14.0, max: 18.0 },
      },
      firstTimerSampleCount: 5,
      skippedCount: 0,
      rivals: [],
      samples: [],
      targetCreatedAt: new Date("2026-11-05T00:00:00Z"),
      targetReadyAt: new Date("2026-11-05T01:00:00Z"),
    });
    expect(snapshot.LookbackDays).toBe(30);
    expect(snapshot.FirstTimerLookbackDays).toBe(90);
    expect(snapshot.FirstTimerMedianDays).toBe(37.0);
    expect(snapshot.FirstTimerP75Days).toBe(39.0);
    expect(snapshot.FirstTimerTurnMedianDays).toBe(12.5);
    expect(snapshot.FirstTimerTurnP75Days).toBe(15.0);
    expect(snapshot.FirstTimerSampleCount).toBe(5);
  });
});
