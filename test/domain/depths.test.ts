import { describe, expect, test } from "bun:test";
import {
  buildAbsoluteBaseQuery,
  buildExpressQuery,
  buildHealthyBaseQuery,
  createDepthsSnapshot,
  filterFirstTimerCandidates,
  formatDepthsRow,
  formatGraphQLDepthsRow,
  formatJstDateTime,
  formatTargetPrInfo,
  truncateTitle,
} from "../../src/domain/depths";
import type { GitHubPrView, GitHubSearchItem, GraphQLPrNode } from "../../src/models/depths";

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
      firstTimerBottom: [
        {
          PR: "#123",
          Number: 123,
          作成日時: "2026-10-09 10:00",
          更新日時: "2026-10-09 10:05",
          CreatedAt: "2026-10-09T01:00:00Z",
          UpdatedAt: "2026-10-09T01:05:00Z",
          タイトル: "Sample",
          Title: "Sample",
          Url: "https://github.com/microsoft/winget-pkgs/pull/123",
          Author: "first-timer-user",
          AuthorAssociation: "NONE",
        },
      ],
      expressLane: [],
    });

    expect(snapshot.Timestamp).toBe("2026-11-07T05:54:31.000Z");
    expect(snapshot.TimestampJst).toBe("2026-11-07 14:54:31");
    expect(snapshot.Repository).toBe("microsoft/winget-pkgs");
    expect(snapshot.TargetPr).toBeNull();
    expect(snapshot.HealthyBottom).toEqual([]);
    expect(snapshot.FirstTimerBottom?.length).toBe(1);
    expect(snapshot.FirstTimerBottom?.[0].Author).toBe("first-timer-user");
  });

  describe("GraphQL ノード変換と初回提出者フィルタリング", () => {
    const sampleNodes: GraphQLPrNode[] = [
      {
        number: 450001,
        title: "Valid First Timer PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/450001",
        createdAt: "2026-10-09T02:00:00Z",
        updatedAt: "2026-10-09T02:30:00Z",
        author: { login: "alice" },
        authorAssociation: "NONE",
        commits: { totalCount: 1 },
        labels: { nodes: [{ name: "New-Package" }, { name: "Validation-Completed" }] },
      },
      {
        number: 450002,
        title: "Contributor PR (Should be excluded)",
        url: "https://github.com/microsoft/winget-pkgs/pull/450002",
        createdAt: "2026-10-09T03:00:00Z",
        updatedAt: "2026-10-09T03:30:00Z",
        author: { login: "bob-contributor" },
        authorAssociation: "CONTRIBUTOR",
        commits: { totalCount: 1 },
        labels: { nodes: [{ name: "New-Package" }] },
      },
      {
        number: 450003,
        title: "Multi-commit PR (Should be excluded)",
        url: "https://github.com/microsoft/winget-pkgs/pull/450003",
        createdAt: "2026-10-09T04:00:00Z",
        updatedAt: "2026-10-09T04:30:00Z",
        author: { login: "charlie" },
        authorAssociation: "NONE",
        commits: { totalCount: 2 },
        labels: { nodes: [{ name: "New-Package" }] },
      },
      {
        number: 450004,
        title: "Blocked Label PR (Should be excluded)",
        url: "https://github.com/microsoft/winget-pkgs/pull/450004",
        createdAt: "2026-10-09T05:00:00Z",
        updatedAt: "2026-10-09T05:30:00Z",
        author: { login: "dave" },
        authorAssociation: "NONE",
        commits: { totalCount: 1 },
        labels: { nodes: [{ name: "Validation-Submission-Failed" }] },
      },
      {
        number: 450005,
        title: "No Author PR (Should be excluded)",
        url: "https://github.com/microsoft/winget-pkgs/pull/450005",
        createdAt: "2026-10-09T06:00:00Z",
        updatedAt: "2026-10-09T06:30:00Z",
        author: null,
        authorAssociation: "NONE",
        commits: { totalCount: 1 },
      },
      {
        number: 450006,
        title: "Second Valid First Timer PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/450006",
        createdAt: "2026-10-09T07:00:00Z",
        updatedAt: "2026-10-09T07:30:00Z",
        author: { login: "eve" },
        authorAssociation: "NONE",
        commits: { totalCount: 1 },
      },
    ];

    test("filterFirstTimerCandidates は NONE かつ 1 コミットの健全な PR のみを抽出する", () => {
      const result = filterFirstTimerCandidates(sampleNodes);
      expect(result.length).toBe(2);
      expect(result[0].Number).toBe(450001);
      expect(result[0].Author).toBe("alice");
      expect(result[0].AuthorAssociation).toBe("NONE");
      expect(result[1].Number).toBe(450006);
      expect(result[1].Author).toBe("eve");
    });

    test("filterFirstTimerCandidates は limit 件数で切り詰める", () => {
      const result = filterFirstTimerCandidates(sampleNodes, 1);
      expect(result.length).toBe(1);
      expect(result[0].Number).toBe(450001);
    });

    test("formatGraphQLDepthsRow は正しく DepthsRow を組み立てる", () => {
      const row = formatGraphQLDepthsRow(sampleNodes[0]);
      expect(row.PR).toBe("#450001");
      expect(row.Number).toBe(450001);
      expect(row.Title).toBe("Valid First Timer PR");
      expect(row.Author).toBe("alice");
      expect(row.AuthorAssociation).toBe("NONE");
      expect(row.作成日時).toBe("2026-10-09 11:00");
      expect(row.更新日時).toBe("2026-10-09 11:30");
    });
  });
});
