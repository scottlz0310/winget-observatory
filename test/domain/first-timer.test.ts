import { describe, expect, test } from "bun:test";
import {
  buildAuthorMergedCountQuery,
  extractSingleHitCandidateLogins,
  hasBlockingOrDraftHistory,
  isFirstTimerSampleCandidate,
  parseAuthorMergedCounts,
} from "../../src/domain/first-timer";

describe("Domain: hasBlockingOrDraftHistory", () => {
  test("クリーンなタイムライン（阻害ラベルやDraft化なし）は false", () => {
    const timeline = [
      { event: "labeled", label: { name: "New-Package" } },
      { event: "labeled", label: { name: "Azure-Pipeline-Passed" } },
    ];
    expect(hasBlockingOrDraftHistory(timeline, false)).toBe(false);
  });

  test("最初から Draft の場合は true", () => {
    expect(hasBlockingOrDraftHistory([], true)).toBe(true);
  });

  test("途中で converted_to_draft (または convert_to_draft) された場合は true", () => {
    expect(hasBlockingOrDraftHistory([{ event: "converted_to_draft" }], false)).toBe(true);
    expect(hasBlockingOrDraftHistory([{ event: "convert_to_draft" }], false)).toBe(true);
  });

  test("最初から Draft で後に ready_for_review された場合は true", () => {
    const timeline = [
      { event: "labeled", label: { name: "New-Package" } },
      { event: "ready_for_review" },
    ];
    expect(hasBlockingOrDraftHistory(timeline, false)).toBe(true);
  });

  test("途中で阻害ラベル（BLOCKED_LABELS, INVESTIGATION_LABELS, BLOCKED_PATTERNS）が付与された場合は true", () => {
    const timelineWithBlocked = [
      { event: "labeled", label: { name: "New-Package" } },
      { event: "labeled", label: { name: "Needs-Author-Feedback" } },
      { event: "unlabeled", label: { name: "Needs-Author-Feedback" } },
    ];
    expect(hasBlockingOrDraftHistory(timelineWithBlocked, false)).toBe(true);

    const timelineWithPattern = [{ event: "labeled", label: { name: "Error-TestFailure" } }];
    expect(hasBlockingOrDraftHistory(timelineWithPattern, false)).toBe(true);
  });
});

describe("Domain: isFirstTimerSampleCandidate", () => {
  test("1 コミットかつタイムライン阻害なしなら true", () => {
    expect(
      isFirstTimerSampleCandidate({
        commitCount: 1,
        timeline: [{ event: "labeled", label: { name: "New-Package" } }],
      }),
    ).toBe(true);
  });

  test("commitCount が 1 以外なら false", () => {
    expect(isFirstTimerSampleCandidate({ commitCount: 2 })).toBe(false);
    expect(isFirstTimerSampleCandidate({ commitCount: 0 })).toBe(false);
  });

  test("タイムラインに阻害ラベル履歴があれば解除されていても false", () => {
    expect(
      isFirstTimerSampleCandidate({
        commitCount: 1,
        timeline: [
          { event: "labeled", label: { name: "Error-TestFailure" } },
          { event: "unlabeled", label: { name: "Error-TestFailure" } },
        ],
      }),
    ).toBe(false);
  });

  test("converted_to_draft や ready_for_review の履歴があれば false", () => {
    expect(
      isFirstTimerSampleCandidate({
        commitCount: 1,
        timeline: [{ event: "converted_to_draft" }],
      }),
    ).toBe(false);
    expect(
      isFirstTimerSampleCandidate({
        commitCount: 1,
        timeline: [{ event: "ready_for_review" }],
      }),
    ).toBe(false);
  });

  test("Draft だった履歴があれば false", () => {
    expect(
      isFirstTimerSampleCandidate({
        commitCount: 1,
        isDraft: true,
      }),
    ).toBe(false);
  });
});

describe("Domain: extractSingleHitCandidateLogins", () => {
  test("同一サンプル内で複数回登場する author は常連として除外される", () => {
    const samples = [
      { author: "userA", commitCount: 1 },
      { author: "userA", commitCount: 1 },
      { author: "userB", commitCount: 1 },
    ];
    expect(extractSingleHitCandidateLogins(samples)).toEqual(["userB"]);
  });

  test("commitCount が 2 以上の author は除外される", () => {
    const samples = [
      { author: "userA", commitCount: 2 },
      { author: "userB", commitCount: 1 },
    ];
    expect(extractSingleHitCandidateLogins(samples)).toEqual(["userB"]);
  });

  test("既に isFirstTimer が確定している author は除外される", () => {
    const samples = [
      { author: "userA", commitCount: 1, isFirstTimer: true },
      { author: "userB", commitCount: 1, isFirstTimer: false },
      { author: "userC", commitCount: 1 },
    ];
    expect(extractSingleHitCandidateLogins(samples)).toEqual(["userC"]);
  });

  test("author が未定義の場合は除外される", () => {
    const samples = [{ commitCount: 1 }, { author: "userB", commitCount: 1 }];
    expect(extractSingleHitCandidateLogins(samples)).toEqual(["userB"]);
  });
});

describe("Domain: buildAuthorMergedCountQuery", () => {
  test("空配列の場合は空文字列を返す", () => {
    expect(buildAuthorMergedCountQuery("microsoft/winget-pkgs", [])).toBe("");
  });

  test("複数の author に対する GraphQL エイリアスクエリを構築する", () => {
    const query = buildAuthorMergedCountQuery("microsoft/winget-pkgs", ["user1", "user2"]);
    expect(query).toContain("query {");
    expect(query).toContain(
      'u_0: search(query: "repo:microsoft/winget-pkgs is:pr is:merged author:user1", type: ISSUE, first: 1) { issueCount }',
    );
    expect(query).toContain(
      'u_1: search(query: "repo:microsoft/winget-pkgs is:pr is:merged author:user2", type: ISSUE, first: 1) { issueCount }',
    );
  });

  test("不正な記号を含む author login を安全にサニタイズする", () => {
    const query = buildAuthorMergedCountQuery("microsoft/winget-pkgs", ['bad"user!']);
    expect(query).toContain("author:baduser");
    expect(query).not.toContain('"user!');
  });
});

describe("Domain: parseAuthorMergedCounts", () => {
  test("GraphQL エイリアス結果から author ごとの件数を復元する", () => {
    const authors = ["userA", "userB", "userC"];
    const data = {
      u_0: { issueCount: 1 },
      u_1: { issueCount: 12 },
      u_2: { issueCount: 0 },
    };
    const result = parseAuthorMergedCounts(authors, data);
    expect(result.get("userA")).toBe(1);
    expect(result.get("userB")).toBe(12);
    expect(result.get("userC")).toBe(0);
  });

  test("エイリアス結果が欠落している場合は 0 件とする", () => {
    const authors = ["userA"];
    const data = {};
    const result = parseAuthorMergedCounts(authors, data);
    expect(result.get("userA")).toBe(0);
  });
});
