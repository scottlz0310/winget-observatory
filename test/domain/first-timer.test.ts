import { describe, expect, test } from "bun:test";
import {
  buildAuthorMergedCountQuery,
  CURRENT_FIRST_TIMER_VERSION,
  countCandidateAuthors,
  extractSingleHitCandidateLogins,
  isCandidateEligibleForFirstTimerDetail,
  MIN_WAIVED_READY_VERSION,
  parseAuthorMergedCounts,
  resolveAuthorMergedCounts,
  shouldReevaluateAuthorFirstTimer,
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

  test("単発 author なら eligible", () => {
    const authorCounts = new Map([["alice", 1]]);
    expect(isCandidateEligibleForFirstTimerDetail({ author: "alice" }, authorCounts)).toBe(true);
  });

  test("同一期間内に複数回出現している author（常連）は ineligible", () => {
    const authorCounts = new Map([["frequent-contributor", 5]]);
    expect(
      isCandidateEligibleForFirstTimerDetail({ author: "frequent-contributor" }, authorCounts),
    ).toBe(false);
  });

  test("author が未定義（不明）の場合は除外せず後続の判定に委ねる", () => {
    const authorCounts = new Map([["alice", 1]]);
    expect(isCandidateEligibleForFirstTimerDetail({ author: undefined }, authorCounts)).toBe(true);
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

  test("すでに新版バージョン（firstTimerVersion >= 4）で判定済みの場合は再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });

  test("v3 の timeline-blocking でも Author が保存済みならタイムライン再取得は不要（Author 判定のみ対象）", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: MIN_WAIVED_READY_VERSION,
        commitCount: 3,
        authorCountInCandidates: 1,
        author: "tamakichi23",
      }),
    ).toBe(false);
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: MIN_WAIVED_READY_VERSION,
        author: "tamakichi23",
      }),
    ).toBe(true);
  });

  test("Author が未保存の timeline-blocking、または v3 未満の timeline-blocking はタイムライン再取得対象", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: MIN_WAIVED_READY_VERSION,
        commitCount: 1,
        authorCountInCandidates: 1,
      }),
    ).toBe(true);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: 2,
        commitCount: 1,
        authorCountInCandidates: 2,
        author: "old-user",
      }),
    ).toBe(true);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "timeline-blocking",
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(true);
  });

  test("v3 未満（v2 / 未設定）や v4 以降のレコードは shouldReevaluateAuthorFirstTimer が false を返す", () => {
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: 2,
        author: "old-user",
      }),
    ).toBe(false);
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "timeline-blocking",
        author: "old-user",
      }),
    ).toBe(false);
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        author: "tamakichi23",
      }),
    ).toBe(false);
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "lifetime-merged",
        firstTimerVersion: MIN_WAIVED_READY_VERSION,
        author: "repeat-user",
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

  test("Reason が no-ready の場合、旧版（firstTimerVersion < 3 または未設定）なら Waived-* 免除ラベル再評価のため true、v3 以降なら false", () => {
    expect(
      shouldReevaluateSkippedCandidate({
        reason: "no-ready",
        isWithinOverallWindow: false,
        isEligibleForDetail: false,
      }),
    ).toBe(true);
    expect(
      shouldReevaluateSkippedCandidate({
        reason: "no-ready",
        firstTimerVersion: 2,
        isWithinOverallWindow: false,
        isEligibleForDetail: false,
      }),
    ).toBe(true);
    expect(
      shouldReevaluateSkippedCandidate({
        reason: "no-ready",
        firstTimerVersion: MIN_WAIVED_READY_VERSION,
        isWithinOverallWindow: true,
        isEligibleForDetail: true,
      }),
    ).toBe(false);
    expect(
      shouldReevaluateSkippedCandidate({
        reason: "no-ready",
        firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        isWithinOverallWindow: true,
        isEligibleForDetail: true,
      }),
    ).toBe(false);
  });

  test("Reason が negative-ready の場合は再評価しない", () => {
    expect(
      shouldReevaluateSkippedCandidate({
        reason: "negative-ready",
        isWithinOverallWindow: true,
        isEligibleForDetail: true,
      }),
    ).toBe(false);
  });
});

describe("Domain: resolveAuthorMergedCounts", () => {
  test("重複 login・空文字を除外し、batchSize ごとに分割して GraphQL 解決する", async () => {
    const executedQueries: string[] = [];
    const result = await resolveAuthorMergedCounts(
      "microsoft/winget-pkgs",
      ["alice", "bob", "alice", "", "charlie"],
      async (query) => {
        executedQueries.push(query);
        if (query.includes("author:alice")) {
          return { u_0: { issueCount: 1 }, u_1: { issueCount: 4 } };
        }
        return { u_0: { issueCount: 0 } };
      },
      { batchSize: 2 },
    );

    expect(executedQueries).toHaveLength(2);
    expect(executedQueries[0]).toContain("author:alice");
    expect(executedQueries[0]).toContain("author:bob");
    expect(executedQueries[1]).toContain("author:charlie");
    expect(result.get("alice")).toBe(1);
    expect(result.get("bob")).toBe(4);
    expect(result.get("charlie")).toBe(0);
    expect(result.size).toBe(3);
  });

  test("cache 指定時は未解決の login のみ照会し、結果を cache へも追記する", async () => {
    const cache = new Map<string, number>([["alice", 3]]);
    const executedQueries: string[] = [];

    const result = await resolveAuthorMergedCounts(
      "microsoft/winget-pkgs",
      ["alice", "bob"],
      async (query) => {
        executedQueries.push(query);
        return { u_0: { issueCount: 0 } };
      },
      { cache },
    );

    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0]).not.toContain("author:alice");
    expect(executedQueries[0]).toContain("author:bob");
    expect(result.get("alice")).toBe(3);
    expect(result.get("bob")).toBe(0);
    expect(cache.get("bob")).toBe(0);
  });

  test("repository が空、または logins が空なら GraphQL を呼ばず空 Map を返す", async () => {
    let called = false;
    const executor = async () => {
      called = true;
      return {};
    };

    expect((await resolveAuthorMergedCounts("", ["alice"], executor)).size).toBe(0);
    expect((await resolveAuthorMergedCounts("microsoft/winget-pkgs", [], executor)).size).toBe(0);
    expect(called).toBe(false);
  });

  test("batchSize が正の整数でない場合は RangeError を投げる", async () => {
    await expect(
      resolveAuthorMergedCounts("microsoft/winget-pkgs", ["alice"], async () => ({}), {
        batchSize: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
});
