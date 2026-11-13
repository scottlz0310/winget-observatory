import { describe, expect, it } from "bun:test";
import {
  formatFrontDeltaText,
  logBenchmark,
  logRivals,
  reportSkippedObservation,
} from "../../src/domain/progress-format";
import type { ProgressRivalPr, ProgressSnapshot } from "../../src/models/progress";

describe("progress-format", () => {
  it("formatFrontDeltaText: 前回前線番号からの差分テキストを適切に生成する", () => {
    expect(formatFrontDeltaText(100, 95)).toBe(" [前回 #95 から +5 件前進]");
    expect(formatFrontDeltaText(100, 100)).toBe(" [前回から変動なし]");
    expect(formatFrontDeltaText(100, 105)).toBe(" [前回 #105]");
    expect(formatFrontDeltaText(100, undefined)).toBe("");
  });

  it("logRivals: ライバル PR が存在する場合にリストを出力する", () => {
    const logs: string[] = [];
    const rivals: ProgressRivalPr[] = [
      {
        number: 1234,
        title: "Test PR",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        url: "https://github.com/test/1234",
      },
    ];

    logRivals(rivals, (msg) => logs.push(msg));
    expect(logs.some((l) => l.includes("#1234"))).toBeTrue();
    expect(logs.some((l) => l.includes("Test PR"))).toBeTrue();
  });

  it("logBenchmark: サンプルが 0 件のときは比較不能メッセージを出力する", () => {
    const logs: string[] = [];
    const mockSnapshot = {
      SampleCount: 0,
      SkippedCount: 5,
      Guidance: null,
      Comparison: null,
    } as unknown as ProgressSnapshot;

    logBenchmark(
      mockSnapshot,
      { lookbackDays: 30, targetPr: 100 },
      { totalLifetimeDays: 5, turnLatencyDays: 2, waitDays: 1 },
      (msg) => logs.push(msg),
    );

    expect(logs.some((l) => l.includes("比較可能なサンプルがありませんでした。"))).toBeTrue();
  });

  it("reportSkippedObservation: Actions 環境で snapshot が null の場合に警告を出力する", () => {
    const logs: string[] = [];
    reportSkippedObservation(null, { GITHUB_ACTIONS: "true" }, (msg) => logs.push(msg));
    expect(logs.some((l) => l.includes("::warning::"))).toBeTrue();

    logs.length = 0;
    reportSkippedObservation({} as ProgressSnapshot, { GITHUB_ACTIONS: "true" }, (msg) =>
      logs.push(msg),
    );
    expect(logs.length).toBe(0);
  });
});
