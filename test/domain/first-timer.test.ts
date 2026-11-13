import { describe, expect, test } from "bun:test";
import {
  buildAuthorMergedCountQuery,
  CURRENT_FIRST_TIMER_VERSION,
  countCandidateAuthors,
  extractSingleHitCandidateLogins,
  hasBlockingOrDraftHistory,
  isCandidateEligibleForFirstTimerDetail,
  isFirstTimerSampleCandidate,
  parseAuthorMergedCounts,
  shouldReevaluateCachedSample,
  shouldReevaluateSkippedCandidate,
} from "../../src/domain/first-timer";

describe("Domain: countCandidateAuthors & isCandidateEligibleForFirstTimerDetail", () => {
  test("countCandidateAuthors は候補配列から作者ごとの出現数を集計する", () => {
    const candidates = [
      { author: "alice" },
      { author: "bob" },
      { author: "alice" },
      { author: undefined },
      { author: "charlie" },
    ];
    const counts = countCandidateAuthors(candidates);
    expect(counts.get("alice")).toBe(2);
    expect(counts.get("bob")).toBe(1);
    expect(counts.get("charlie")).toBe(1);
    expect(counts.get("unknown")).toBeUndefined();
  });

  test("1コミット・非Draft・阻害ラベルなし・単発authorなら eligible", () => {
    const authorCounts = new Map([["alice", 1]]);
    const candidate = {
      commitCount: 1,
      isDraft: false,
      labels: [{ name: "Area-Package" }, { name: "Validation-Passed" }],
      author: "alice",
    };
    expect(isCandidateEligibleForFirstTimerDetail(candidate, authorCounts)).toBe(true);
  });

  test("コミット数が 2 以上（手直しあり）でも非Draft・阻害ラベルなし・単発authorなら eligible", () => {
    const authorCounts = new Map([["alice", 1]]);
    expect(
      isCandidateEligibleForFirstTimerDetail(
        { commitCount: 2, isDraft: false, author: "alice" },
        authorCounts,
      ),
    ).toBe(true);
  });

  test("Draft の場合は ineligible", () => {
    const authorCounts = new Map([["alice", 1]]);
    expect(
      isCandidateEligibleForFirstTimerDetail(
        { commitCount: 1, isDraft: true, author: "alice" },
        authorCounts,
      ),
    ).toBe(false);
  });

  test("阻害ラベルが付与されている場合は ineligible", () => {
    const authorCounts = new Map([["alice", 1]]);
    expect(
      isCandidateEligibleForFirstTimerDetail(
        {
          commitCount: 1,
          isDraft: false,
          author: "alice",
          labels: [{ name: "Needs-Author-Feedback" }],
        },
        authorCounts,
      ),
    ).toBe(false);
  });

  test("同一期間内に複数回出現している author（常連）は ineligible", () => {
    const authorCounts = new Map([["frequent-contributor", 5]]);
    expect(
      isCandidateEligibleForFirstTimerDetail(
        { commitCount: 1, isDraft: false, author: "frequent-contributor" },
        authorCounts,
      ),
    ).toBe(false);
  });

  test("commitCount が未定義（不明）の場合は除外せず後続の判定に委ねる", () => {
    const authorCounts = new Map([["alice", 1]]);
    expect(
      isCandidateEligibleForFirstTimerDetail(
        { commitCount: undefined, isDraft: false, author: "alice" },
        authorCounts,
      ),
    ).toBe(true);
  });
});

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

  test("コミット数が 2 以上（手直しあり）でもタイムライン阻害なしなら true", () => {
    expect(
      isFirstTimerSampleCandidate({
        commitCount: 2,
        timeline: [{ event: "labeled", label: { name: "New-Package" } }],
      }),
    ).toBe(true);
    expect(
      isFirstTimerSampleCandidate({
        commitCount: 5,
        timeline: [{ event: "labeled", label: { name: "New-Package" } }],
      }),
    ).toBe(true);
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

  test("commitCount が 2 以上の author も単発であれば抽出対象に含まれる", () => {
    const samples = [
      { author: "userA", commitCount: 2 },
      { author: "userB", commitCount: 1 },
    ];
    expect(extractSingleHitCandidateLogins(samples)).toEqual(["userA", "userB"]);
  });

  test("既に isFirstTimer が確定している author は除外される", () => {
    const samples = [
      { author: "userA", commitCount: 1, isFirstTimer: true },
      { author: "userB", commitCount: 2, isFirstTimer: false },
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

describe("Domain: shouldReevaluateCachedSample", () => {
  test("旧版キャッシュで IsFirstTimer: false かつ複数コミット・単発authorなら再評価対象", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(true);
  });

  test("候補期間内に別 PR がある常連（authorCountInCandidates > 1）は再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        commitCount: 3,
        authorCountInCandidates: 2,
      }),
    ).toBe(false);
  });

  test("すでに新版バージョン（firstTimerVersion >= 2）で判定済みの場合は再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });

  test("すでにタイムライン阻害履歴理由（timeline-blocking）が確定している場合は再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "timeline-blocking",
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });

  test("すでに累計マージ数理由（lifetime-merged）が確定している場合は再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "lifetime-merged",
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });

  test("旧版でコミット数が 1 だった PR はコミット数制限による除外ではないため再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        commitCount: 1,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });

  test("IsFirstTimer が true のサンプルは再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: true,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });
});

describe("Domain: shouldReevaluateSkippedCandidate", () => {
  test("全体集計窓内（isWithinOverallWindow = true）であれば再評価", () => {
    expect(
      shouldReevaluateSkippedCandidate({
        isWithinOverallWindow: true,
        isEligibleForDetail: false,
      }),
    ).toBe(true);
  });

  test("全体窓外でもコミット数制限撤廃により初回詳細適格（isEligibleForDetail = true）であれば再評価", () => {
    expect(
      shouldReevaluateSkippedCandidate({
        isWithinOverallWindow: false,
        isEligibleForDetail: true,
      }),
    ).toBe(true);
  });

  test("全体窓外で依然として不適格（isEligibleForDetail = false）なら再評価しない（スキップ維持）", () => {
    expect(
      shouldReevaluateSkippedCandidate({
        isWithinOverallWindow: false,
        isEligibleForDetail: false,
      }),
    ).toBe(false);
  });
});
