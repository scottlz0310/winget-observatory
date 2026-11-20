import { describe, expect, test } from "bun:test";
import {
  buildAbsoluteBaseQuery,
  buildExpressQuery,
  buildHealthyBaseQuery,
  CURRENT_DEPTHS_VERSION,
  createDepthsSnapshot,
  extractThirdPartyAssignees,
  formatDepthsRow,
  formatGraphQLDepthsRow,
  formatJstDateTime,
  formatTargetPrInfo,
  getThirdPartyAssignees,
  isFirstTimerCandidate,
  isFirstTimerDepthsRow,
  summarizeAssigneeFrontier,
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
    expect(healthyQuery).not.toContain('label:"Azure-Pipeline-Passed"');
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

    expect(snapshot.DepthsVersion).toBe(CURRENT_DEPTHS_VERSION);
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
      },
      {
        number: 450003,
        title: "Multi-commit PR (Should be included after commit limit removal)",
        url: "https://github.com/microsoft/winget-pkgs/pull/450003",
        createdAt: "2026-10-09T04:00:00Z",
        updatedAt: "2026-10-09T04:30:00Z",
        author: { login: "charlie" },
        authorAssociation: "NONE",
        commits: { totalCount: 2 },
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

    test("isFirstTimerCandidate は適格条件を個別に判定する（複数コミットも許容）", () => {
      expect(isFirstTimerCandidate(sampleNodes[0])).toBe(true);
      expect(isFirstTimerCandidate(sampleNodes[1])).toBe(false); // CONTRIBUTOR
      expect(isFirstTimerCandidate(sampleNodes[2])).toBe(true); // 2 commits（コミット数制限撤廃により初回提出者として許容）
      expect(isFirstTimerCandidate(sampleNodes[3])).toBe(false); // author null
      expect(isFirstTimerCandidate(sampleNodes[4])).toBe(true);
    });

    test("formatGraphQLDepthsRow は正しく DepthsRow を組み立て、CommitCount も格納する", () => {
      const row = formatGraphQLDepthsRow(sampleNodes[0]);
      expect(row.PR).toBe("#450001");
      expect(row.Number).toBe(450001);
      expect(row.Title).toBe("Valid First Timer PR");
      expect(row.Author).toBe("alice");
      expect(row.AuthorAssociation).toBe("NONE");
      expect(row.CommitCount).toBe(1);
      expect(row.作成日時).toBe("2026-10-09 11:00");
      expect(row.更新日時).toBe("2026-10-09 11:30");

      const multiCommitRow = formatGraphQLDepthsRow(sampleNodes[2]);
      expect(multiCommitRow.CommitCount).toBe(2);
    });
  });

  describe("第三者 Assignees 判定と前線サマリー", () => {
    test.each<{
      label: string;
      assignees: Array<string | { login?: string | null } | null>;
      author: string | null;
      expected: string[];
    }>([
      {
        label: "未アサイン（空配列）",
        assignees: [],
        author: "alice",
        expected: [],
      },
      {
        label: "セルフアサインのみ（大小文字違い含む）",
        assignees: ["Alice"],
        author: "alice",
        expected: [],
      },
      {
        label: "第三者アサインのみ",
        assignees: ["stephengillie"],
        author: "alice",
        expected: ["stephengillie"],
      },
      {
        label: "セルフアサイン＋第三者アサイン併用",
        assignees: ["alice", "stephengillie", "trenly"],
        author: "ALICE",
        expected: ["stephengillie", "trenly"],
      },
      {
        label: "author が null の場合、assignees が空でなければ第三者ありとみなす",
        assignees: ["stephengillie"],
        author: null,
        expected: ["stephengillie"],
      },
      {
        label: "author が null で assignees も空なら空配列",
        assignees: [],
        author: null,
        expected: [],
      },
      {
        label: "重複・null・空白を含むノード配列を正規化する",
        assignees: [
          { login: "alice" },
          { login: "stephengillie" },
          { login: "StephenGillie" },
          { login: null },
          null,
        ],
        author: "alice",
        expected: ["stephengillie"],
      },
    ])("extractThirdPartyAssignees: $label", ({ assignees, author, expected }) => {
      expect(extractThirdPartyAssignees(assignees, author)).toEqual(expected);
    });

    test("getThirdPartyAssignees と formatGraphQLDepthsRow は GraphQL ノードから第三者 Assignees を記録する", () => {
      const selfAssignedNode: GraphQLPrNode = {
        number: 460001,
        title: "Self assigned PR",
        url: "https://github.com/microsoft/winget-pkgs/pull/460001",
        createdAt: "2026-10-10T00:00:00Z",
        updatedAt: "2026-10-11T00:00:00Z",
        author: { login: "alice" },
        authorAssociation: "NONE",
        commits: { totalCount: 1 },
        assignees: { nodes: [{ login: "alice" }] },
      };
      expect(getThirdPartyAssignees(selfAssignedNode)).toEqual([]);
      expect(formatGraphQLDepthsRow(selfAssignedNode).ThirdPartyAssignees).toEqual([]);

      const thirdPartyNode: GraphQLPrNode = {
        ...selfAssignedNode,
        number: 460002,
        assignees: { nodes: [{ login: "alice" }, { login: "stephengillie" }] },
      };
      expect(getThirdPartyAssignees(thirdPartyNode)).toEqual(["stephengillie"]);
      expect(formatGraphQLDepthsRow(thirdPartyNode).ThirdPartyAssignees).toEqual(["stephengillie"]);
    });

    test("summarizeAssigneeFrontier は先頭位置・経過日数・アサイン内訳を算出する", () => {
      const now = new Date("2026-11-15T00:00:00Z");
      const rows = [
        {
          PR: "#100",
          Number: 100,
          作成日時: "2026-11-05 09:00",
          更新日時: "2026-11-06 09:00",
          CreatedAt: "2026-11-05T00:00:00Z",
          UpdatedAt: "2026-11-06T00:00:00Z",
          タイトル: "First",
          Title: "First",
          Url: "https://github.com/microsoft/winget-pkgs/pull/100",
          ThirdPartyAssignees: ["stephengillie"],
        },
        {
          PR: "#101",
          Number: 101,
          作成日時: "2026-11-07 09:00",
          更新日時: "2026-11-08 09:00",
          CreatedAt: "2026-11-07T00:00:00Z",
          UpdatedAt: "2026-11-08T00:00:00Z",
          タイトル: "Second",
          Title: "Second",
          Url: "https://github.com/microsoft/winget-pkgs/pull/101",
          ThirdPartyAssignees: ["stephengillie", "trenly"],
        },
      ];

      const summary = summarizeAssigneeFrontier(rows, now);
      expect(summary.count).toBe(2);
      expect(summary.head?.Number).toBe(100);
      expect(summary.headElapsedDays).toBe(10);
      expect(summary.assigneeCounts).toEqual([
        { login: "stephengillie", count: 2 },
        { login: "trenly", count: 1 },
      ]);

      const emptySummary = summarizeAssigneeFrontier([], now);
      expect(emptySummary).toEqual({
        count: 0,
        head: null,
        headElapsedDays: null,
        assigneeCounts: [],
      });
    });
  });

  describe("初回提出者判定 SSoT（isFirstTimerDepthsRow）と v5 スナップショット", () => {
    test.each([
      {
        label: "NONE かつ AuthorMergedCount=0 は初回提出者",
        row: { Author: "alice", AuthorAssociation: "NONE", AuthorMergedCount: 0 },
        expected: true,
      },
      {
        label: "NONE でも AuthorMergedCount>0 は常連扱い",
        row: { Author: "alice", AuthorAssociation: "NONE", AuthorMergedCount: 1 },
        expected: false,
      },
      {
        label: "AuthorMergedCount 未照会は安全側で false",
        row: { Author: "alice", AuthorAssociation: "NONE" },
        expected: false,
      },
      {
        label: "CONTRIBUTOR は false",
        row: { Author: "bob", AuthorAssociation: "CONTRIBUTOR", AuthorMergedCount: 0 },
        expected: false,
      },
      {
        label: "MEMBER は false",
        row: { Author: "mod", AuthorAssociation: "MEMBER", AuthorMergedCount: 0 },
        expected: false,
      },
      {
        label: "Bot アカウントは false",
        row: { Author: "dependabot[bot]", AuthorAssociation: "NONE", AuthorMergedCount: 0 },
        expected: false,
      },
      {
        label: "Author 欠落は false",
        row: { AuthorAssociation: "NONE", AuthorMergedCount: 0 },
        expected: false,
      },
    ])("isFirstTimerDepthsRow: $label", ({ row, expected }) => {
      expect(isFirstTimerDepthsRow(row)).toBe(expected);
    });

    test("createDepthsSnapshot に現行バージョンが記録される（1コミット系は未出力）", () => {
      const dummyRow = formatDepthsRow({
        number: 1,
        title: "t",
        html_url: "https://example.com/1",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      });
      const snapshot = createDepthsSnapshot({
        now: new Date("2026-11-20T00:00:00Z"),
        repository: "microsoft/winget-pkgs",
        targetPr: null,
        healthyBottom: [dummyRow],
        absoluteBottom: [],
        firstTimerUnreviewedBottom: [dummyRow],
        firstTimerUnreviewedTruncated: true,
        expressLane: [],
      });
      expect(snapshot.DepthsVersion).toBe(CURRENT_DEPTHS_VERSION);
      expect(snapshot.SingleCommitBottom).toBeUndefined();
      expect(snapshot.StaleBottom).toBeUndefined();
      expect(snapshot.FirstTimerUnreviewedBottom).toEqual([dummyRow]);
      expect(snapshot.FirstTimerUnreviewedTruncated).toBe(true);
    });
  });
});
