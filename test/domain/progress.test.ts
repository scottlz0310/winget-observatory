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
  migrateCsvRecord,
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

  test("必須ラベルが1つでも欠けていれば eligible でない", () => {
    expect(isEligibleLabels(["New-Package", "Azure-Pipeline-Passed"])).toBeFalse();
    expect(isEligibleLabels(["Azure-Pipeline-Passed", "Validation-Completed"])).toBeFalse();
  });

  test("阻害ラベルが含まれていれば eligible でない", () => {
    for (const blocked of BLOCKED_LABELS) {
      expect(isBlockedLabel(blocked)).toBeTrue();
      expect(
        isEligibleLabels(["New-Package", "Azure-Pipeline-Passed", "Validation-Completed", blocked]),
      ).toBeFalse();
    }
  });

  test("調査中ラベルが含まれていれば eligible でない", () => {
    for (const inv of INVESTIGATION_LABELS) {
      expect(isBlockedLabel(inv)).toBeTrue();
      expect(
        isEligibleLabels(["New-Package", "Azure-Pipeline-Passed", "Validation-Completed", inv]),
      ).toBeFalse();
    }
  });

  test("パターン除外ラベル（Error-*, *-Error, Policy-Test-*, Validation-Submission-*）を正しく除外する", () => {
    const testCases = [
      "Error-Build",
      "Installer-Error",
      "Policy-Test-Sandbox",
      "Validation-Submission-Expired",
      "Validation-Submission-Failed",
      "Validation-Submission-Mismatch",
    ];
    for (const name of testCases) {
      expect(isBlockedLabel(name)).toBeTrue();
    }

    // Validation-Completed などの正常ラベルは除外されない
    expect(isBlockedLabel("Validation-Completed")).toBeFalse();
    expect(isBlockedLabel("New-Package")).toBeFalse();
  });
});

describe("Domain: getPercentile", () => {
  test("空配列は例外を投げる", () => {
    expect(() => getPercentile([], 0.5)).toThrow("集計対象がありません。");
  });

  test("範囲外のパーセンタイルは RangeError を投げる", () => {
    expect(() => getPercentile([1, 2], -0.1)).toThrow(RangeError);
    expect(() => getPercentile([1, 2], 1.1)).toThrow(RangeError);
  });

  test("1要素の場合はその要素を返す", () => {
    expect(getPercentile([42], 0.5)).toBe(42);
    expect(getPercentile([42], 0)).toBe(42);
    expect(getPercentile([42], 1)).toBe(42);
  });

  test("複数要素のパーセンタイルを線形補間で算出する", () => {
    const values = [10, 20, 30, 40, 50];
    expect(getPercentile(values, 0)).toBe(10);
    expect(getPercentile(values, 0.5)).toBe(30);
    expect(getPercentile(values, 0.75)).toBe(40);
    expect(getPercentile(values, 1)).toBe(50);
  });
});

describe("Domain: formatting utilities", () => {
  test("formatHumanDays は丸めと日・時間表記を正しく出力する", () => {
    expect(formatHumanDays(1.5)).toBe("1.5日 (1日 12時間)");
    expect(formatHumanDays(0.5)).toBe("0.5日 (12時間)");
    expect(formatHumanDays(3.0)).toBe("3.0日 (3日 0時間)");
  });

  test("formatDelta はプラス・マイナス・ゼロを正しく出力する", () => {
    expect(formatDelta(10, 8)).toBe("[前回比 +2 件]");
    expect(formatDelta(5, 7)).toBe("[前回比 -2 件]");
    expect(formatDelta(5, 5)).toBe("[前回比 ±0 件]");
    expect(formatDelta(5, 3, "日")).toBe("[前回比 +2 日]");
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

    const readyAt = simulateReadySince(
      events,
      ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
      false,
      new Date("2026-11-02T00:00:00Z"),
    );

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

    const readyAt = simulateReadySince(
      events,
      ["New-Package", "Azure-Pipeline-Passed", "Validation-Completed"],
      false,
      new Date("2026-11-04T00:00:00Z"),
    );

    expect(readyAt).not.toBeNull();
    expect(readyAt?.toISOString()).toBe("2026-11-03T10:00:00.000Z");
  });

  test("isFinalValidation = true の場合に現在状態と履歴が不一致なら例外を投げる", () => {
    const events: ProgressTimelineEvent[] = [
      { event: "labeled", created_at: "2026-11-01T10:00:00Z", label: { name: "New-Package" } },
    ];

    expect(() =>
      simulateReadySince(
        events,
        ["New-Package", "Validation-Completed"],
        false,
        new Date("2026-11-02T00:00:00Z"),
        true,
      ),
    ).toThrow("ラベル履歴と現在状態が一致しません。");
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

    const migrated = migrateCsvRecord(oldRow);
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
    });

    expect(snapshot.TargetPr).toBe(464302);
    expect(snapshot.TotalLifetimeDays).toBe(2.35);
    expect(snapshot.TurnLatencyDays).toBe(1.23);
    expect(snapshot.TotalMedianDays).toBe(3.5);
    expect(snapshot.TimestampJst).toContain("2026-11-07");
  });
});
