import { describe, expect, test } from "bun:test";
import {
  buildAbsoluteBaseQuery,
  buildExpressQuery,
  buildHealthyBaseQuery,
  createDepthsSnapshot,
  formatDepthsRow,
  formatJstDateTime,
  formatTargetPrInfo,
  truncateTitle,
} from "../../src/domain/depths";
import type { GitHubPrView, GitHubSearchItem } from "../../src/models/depths";

describe("Domain: depths logic", () => {
  test("formatJstDateTime は UTC 日時を正確に JST (UTC+9) の文字列に変換する", () => {
    // 2026-11-07T05:54:31.000Z -> JST は +9時間で 2026-11-07 14:54:31
    const iso = "2026-11-07T05:54:31.000Z";
    expect(formatJstDateTime(iso, false)).toBe("2026-11-07 14:54");
    expect(formatJstDateTime(iso, true)).toBe("2026-11-07 14:54:31");

    // 日付をまたぐケース: 2026-10-28T21:47:38Z -> 2026-10-29 06:47
    const crossDayIso = "2026-10-28T21:47:38Z";
    expect(formatJstDateTime(crossDayIso, false)).toBe("2026-10-29 06:47");
  });

  test("truncateTitle は 45 文字を超えるタイトルを末尾 ... で切り詰める", () => {
    const shortTitle = "Short title";
    expect(truncateTitle(shortTitle)).toBe("Short title");

    const exact45 = "123456789012345678901234567890123456789012345";
    expect(truncateTitle(exact45)).toBe(exact45);

    const over45 = "New package: LiamCottle.ReticulumMeshChat version v2.4.0";
    expect(over45.length).toBeGreaterThan(45);
    const truncated = truncateTitle(over45);
    expect(truncated.length).toBe(45);
    expect(truncated).toBe("New package: LiamCottle.ReticulumMeshChat ...");
  });

  test("formatDepthsRow は Search アイテムを正しく DepthsRow にマッピングする", () => {
    const item: GitHubSearchItem = {
      number: 430799,
      title: "New package: LiamCottle.ReticulumMeshChat version v2.4.0",
      html_url: "https://github.com/microsoft/winget-pkgs/pull/430799",
      created_at: "2026-09-07T07:53:38Z",
      updated_at: "2026-11-04T02:04:16Z",
    };

    const row = formatDepthsRow(item);
    expect(row.PR).toBe("#430799");
    expect(row.Number).toBe(430799);
    expect(row.作成日時).toBe("2026-09-07 16:53");
    expect(row.更新日時).toBe("2026-11-04 11:04");
    expect(row.CreatedAt).toBe("2026-09-07T07:53:38Z");
    expect(row.UpdatedAt).toBe("2026-11-04T02:04:16Z");
    expect(row.タイトル).toBe("New package: LiamCottle.ReticulumMeshChat ...");
    expect(row.Title).toBe(item.title);
    expect(row.Url).toBe(item.html_url);
  });

  test("formatTargetPrInfo は PR 情報を正しく TargetPrInfo にマッピングする", () => {
    const view: GitHubPrView = {
      number: 464302,
      title: "New package: scottlz0310.clp2cfg version 0.1.0",
      url: "https://github.com/microsoft/winget-pkgs/pull/464302",
      createdAt: "2026-10-28T21:47:38Z",
      updatedAt: "2026-11-02T03:00:00Z",
    };

    const targetInfo = formatTargetPrInfo(view);
    expect(targetInfo.Number).toBe(464302);
    expect(targetInfo.Title).toBe(view.title);
    expect(targetInfo.Url).toBe(view.url);
    expect(targetInfo.CreatedAt).toBe(view.createdAt);
    expect(targetInfo.CreatedAtJst).toBe("2026-10-29 06:47");
    expect(targetInfo.UpdatedAt).toBe("2026-11-02T03:00:00Z");
  });

  test("クエリ生成関数が正しい GitHub Search クエリを構築する", () => {
    const repo = "microsoft/winget-pkgs";
    const healthyQuery = buildHealthyBaseQuery(repo);
    expect(healthyQuery).toContain("repo:microsoft/winget-pkgs");
    expect(healthyQuery).toContain("is:pr is:open draft:false");
    expect(healthyQuery).toContain('label:"New-Package"');
    expect(healthyQuery).toContain('label:"Azure-Pipeline-Passed"');
    expect(healthyQuery).toContain('label:"Validation-Completed"');
    expect(healthyQuery).toContain('-label:"Needs-CLA"');
    expect(healthyQuery).toContain('-label:"Changes-Requested"');

    const absoluteQuery = buildAbsoluteBaseQuery(repo);
    expect(absoluteQuery).toBe(
      "repo:microsoft/winget-pkgs is:pr is:open draft:false label:New-Package",
    );

    const expressQuery = buildExpressQuery(repo, "2026-10-28T21:47:38Z");
    expect(expressQuery).toBe(
      "repo:microsoft/winget-pkgs is:pr is:merged label:New-Package created:>2026-10-28T21:47:38Z",
    );
  });

  test("createDepthsSnapshot は整合性のあるスナップショットを生成する", () => {
    const now = new Date("2026-11-07T05:54:31.000Z");
    const snapshot = createDepthsSnapshot({
      now,
      repository: "microsoft/winget-pkgs",
      targetPr: null,
      healthyBottom: [],
      absoluteBottom: [],
      staleBottom: [],
      expressLane: [],
    });

    expect(snapshot.Timestamp).toBe("2026-11-07T05:54:31.000Z");
    expect(snapshot.TimestampJst).toBe("2026-11-07 14:54:31");
    expect(snapshot.Repository).toBe("microsoft/winget-pkgs");
    expect(snapshot.TargetPr).toBeNull();
    expect(snapshot.HealthyBottom).toEqual([]);
  });
});
