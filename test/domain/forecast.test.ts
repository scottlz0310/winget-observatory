import { describe, expect, test } from "bun:test";
import {
  calculateLifetimeForecast,
  calculateStaleFrontierForecast,
  extractFirstTimerFrontierSamples,
  extractStaleFrontierSamples,
  parseDepthsHistory,
} from "../../src/domain/forecast";
import type { DepthsRow, DepthsSnapshot } from "../../src/models/depths";
import type { StaleFrontierSample } from "../../src/models/forecast";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-01T00:00:00Z");

const sample = (
  hoursFromT0: number,
  frontierDaysBeforeT0: number,
  pr = 1,
): StaleFrontierSample => ({
  timestampMs: T0 + hoursFromT0 * HOUR,
  pr,
  updatedMs: T0 - frontierDaysBeforeT0 * DAY,
});

const row = (number: number, updatedAt: string): DepthsRow => ({
  PR: `#${number}`,
  Number: number,
  作成日時: "",
  更新日時: "",
  CreatedAt: updatedAt,
  UpdatedAt: updatedAt,
  タイトル: "",
  Title: "",
  Url: "",
});

const snapshot = (timestamp: string, stale: DepthsRow[]): DepthsSnapshot => ({
  Timestamp: timestamp,
  TimestampJst: "",
  Repository: "test/repo",
  TargetPr: null,
  HealthyBottom: [],
  AbsoluteBottom: [],
  StaleBottom: stale,
  ExpressLane: [],
});

describe("Domain: parseDepthsHistory", () => {
  test("BOM 付き・空行を含む JSONL をパースする", () => {
    const text = `﻿${JSON.stringify(snapshot("2026-11-01T00:00:00Z", []))}\n\n${JSON.stringify(snapshot("2026-11-01T04:00:00Z", []))}\n`;
    expect(parseDepthsHistory(text).map((s) => s.Timestamp)).toEqual([
      "2026-11-01T00:00:00Z",
      "2026-11-01T04:00:00Z",
    ]);
  });

  test("壊れた行は握りつぶさず行番号付きで例外にする", () => {
    const text = `${JSON.stringify(snapshot("2026-11-01T00:00:00Z", []))}\n{ broken\n`;
    expect(() => parseDepthsHistory(text)).toThrow("2 行目のパースに失敗しました");
  });
});

describe("Domain: extractStaleFrontierSamples", () => {
  test("遭難の底の先頭を時刻昇順で取り出し、空・不正な観測は除く", () => {
    const samples = extractStaleFrontierSamples([
      snapshot("2026-11-01T08:00:00Z", [row(20, "2026-10-10T00:00:00Z")]),
      snapshot("2026-11-01T00:00:00Z", [row(10, "2026-10-09T00:00:00Z")]),
      snapshot("2026-11-01T04:00:00Z", []),
      snapshot("invalid", [row(30, "2026-10-11T00:00:00Z")]),
      snapshot("2026-11-01T06:00:00Z", [row(40, "not-a-date")]),
    ]);
    expect(samples.map((s) => s.pr)).toEqual([10, 20]);
  });
});

describe("Domain: extractFirstTimerFrontierSamples", () => {
  test("初回提出者の底の先頭を時刻昇順で取り出し、空・不正な観測は除く", () => {
    const s1 = snapshot("2026-11-01T08:00:00Z", []);
    s1.FirstTimerBottom = [row(200, "2026-10-10T00:00:00Z")];
    const s2 = snapshot("2026-11-01T00:00:00Z", []);
    s2.FirstTimerBottom = [row(100, "2026-10-09T00:00:00Z")];
    const s3 = snapshot("2026-11-01T04:00:00Z", []);
    s3.FirstTimerBottom = [];
    const s4 = snapshot("invalid", []);
    s4.FirstTimerBottom = [row(300, "2026-10-11T00:00:00Z")];
    const s5 = snapshot("2026-11-01T06:00:00Z", []);
    s5.FirstTimerBottom = [row(400, "not-a-date")];
    const s6 = snapshot("2026-11-01T07:00:00Z", []);
    // FirstTimerBottom 未定義

    const samples = extractFirstTimerFrontierSamples([s1, s2, s3, s4, s5, s6]);
    expect(samples.map((s) => s.pr)).toEqual([100, 200]);
  });
});

describe("Domain: calculateStaleFrontierForecast", () => {
  const target = T0 - 10 * DAY; // 基準 PR は先頭より 10 日新しい（先頭は 20 日前）

  test("観測が無ければ算出不能", () => {
    const result = calculateStaleFrontierForecast([], target);
    expect(result.observedUnavailable).toBe("no-samples");
    expect(result.steadyEtaDays).toBeNull();
  });

  test("基準 PR の更新時刻が不明なら先頭の遅れだけ返す", () => {
    const result = calculateStaleFrontierForecast([sample(0, 20)], null);
    expect(result.lagDays).toBe(20);
    expect(result.observedUnavailable).toBe("no-target");
    expect(result.steadyEtaDays).toBeNull();
  });

  test("定常待ち時間モデルは先頭と基準 PR の更新時刻の差を予想日数とする", () => {
    const result = calculateStaleFrontierForecast([sample(0, 20)], target);
    expect(result).toMatchObject({ lagDays: 20, gapDays: 10, steadyEtaDays: 10 });
    expect(result.observedUnavailable).toBe("insufficient-window");
  });

  test.each([
    // [観測列, 期待する速度, 期待する予想日数]
    ["実時間と同じ速度（1 日/日）", [sample(0, 21), sample(24, 20)], 1, 10],
    ["実時間の半分の速度", [sample(0, 20.5), sample(24, 20)], 0.5, 20],
    ["実時間の 2 倍の速度", [sample(0, 22), sample(24, 20)], 2, 5],
  ])("観測速度モデル: %s", (_name, samples, speed, eta) => {
    const result = calculateStaleFrontierForecast(samples, target);
    expect(result.observedSpeed).toBe(speed);
    expect(result.observedEtaDays).toBe(eta);
    expect(result.observedUnavailable).toBeNull();
  });

  test.each([
    ["先頭が動いていない", [sample(0, 20, 5), sample(24, 20, 5)], 10],
    ["先頭が後退した", [sample(0, 20), sample(24, 21)], 11],
  ])("観測期間内に進みが無ければ観測速度モデルは算出不能（%s）", (_name, samples, steadyEta) => {
    const result = calculateStaleFrontierForecast(samples, target);
    expect(result.observedUnavailable).toBe("no-progress");
    expect(result.observedEtaDays).toBeNull();
    // 定常待ち時間モデルは速度に依存せず算出できる
    expect(result.steadyEtaDays).toBe(steadyEta);
  });

  test("最小間隔（6 時間）未満の観測だけでは速度を測らない", () => {
    const result = calculateStaleFrontierForecast([sample(0, 20.1), sample(5, 20)], target);
    expect(result.observedUnavailable).toBe("insufficient-window");
  });

  test("速度を測る期間は windowHours 以内の最も古い観測を起点にする", () => {
    // 100 時間前の観測は期間（72 時間）外。48 時間前を起点にする
    const samples = [sample(0, 30), sample(52, 21), sample(100, 20)];
    const result = calculateStaleFrontierForecast(samples, target, 72);
    expect(result.windowHours).toBe(48);
    expect(result.observedSpeed).toBe(0.5);
  });

  test("先頭が基準 PR に到達済みなら予想日数は 0", () => {
    const result = calculateStaleFrontierForecast([sample(0, 11), sample(24, 9)], target);
    expect(result.gapDays).toBe(-1);
    expect(result.steadyEtaDays).toBe(0);
    expect(result.observedEtaDays).toBe(0);
  });
});

describe("Domain: calculateLifetimeForecast", () => {
  const created = Date.parse("2026-10-29T00:00:00Z");
  const now = Date.parse("2026-11-08T00:00:00Z"); // 起票から 10 日後

  test("起票日に中央値・75%点を足した予想日と、現在からの残り日数を返す", () => {
    const result = calculateLifetimeForecast(created, 44.5, 45, now);
    expect(result).toEqual({
      medianDays: 44.5,
      medianDateMs: created + 44.5 * DAY,
      medianEtaDays: 34.5,
      exceededMedian: false,
      p75DateMs: created + 45 * DAY,
      p75EtaDays: 35,
    });
  });

  test.each([
    ["中央値を超過している", 8, 9, 0, 0, true],
    ["中央値は超過・75%点は未到達", 8, 12, 0, 2, true],
  ])("%s: 残り日数は 0 に丸める", (_name, median, p75, medianEta, p75Eta, exceeded) => {
    const result = calculateLifetimeForecast(created, median, p75, now);
    expect(result?.medianEtaDays).toBe(medianEta);
    expect(result?.p75EtaDays).toBe(p75Eta);
    expect(result?.exceededMedian).toBe(exceeded);
  });

  test("75%点が無ければ中央値だけで算出し、75%点は null", () => {
    const result = calculateLifetimeForecast(created, 44.5, null, now);
    expect(result?.medianEtaDays).toBe(34.5);
    expect(result?.p75DateMs).toBeNull();
    expect(result?.p75EtaDays).toBeNull();
  });

  test.each([
    ["中央値が無い", created, null, now],
    ["中央値が未定義", created, undefined, now],
    ["起票時刻が不正", Number.NaN, 44.5, now],
    ["観測時刻が不正", created, 44.5, Number.NaN],
  ])("算出できない入力は null を返す: %s", (_name, createdMs, median, nowMs) => {
    expect(calculateLifetimeForecast(createdMs, median, 45, nowMs)).toBeNull();
  });
});
