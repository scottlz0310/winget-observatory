import { describe, expect, test } from "bun:test";
import {
  buildAuthorMergedCountQuery,
  buildPullRequestAuthorMetadataQuery,
  CURRENT_FIRST_TIMER_VERSION,
  countCandidateAuthors,
  extractSingleHitCandidateLogins,
  hasValidatedReadyVersion,
  isCandidateEligibleForFirstTimerDetail,
  isPrivilegedAuthorAssociation,
  isPrivilegedOrBotAuthor,
  MIN_VALID_READY_VERSION,
  MIN_WAIVED_READY_VERSION,
  parseAuthorMergedCounts,
  parsePullRequestAuthorMetadata,
  resolveAuthorMergedCounts,
  resolvePullRequestAuthorMetadata,
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

  test("v4 以前の旧版は候補期間内に別 PR がある常連（authorCountInCandidates > 1）でも ReadyAt 再計測のため再評価対象", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        commitCount: 3,
        authorCountInCandidates: 2,
      }),
    ).toBe(true);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerVersion: 4,
        commitCount: 3,
        authorCountInCandidates: 2,
      }),
    ).toBe(true);
  });

  test("すでに新版バージョン（firstTimerVersion >= 5）で判定済みの場合は再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: true,
        firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        commitCount: 1,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });

  test("v7（MIN_VALID_READY_VERSION）未満（v6 / v5 / v4 / 未設定）はラベル定義更新に伴う ReadyAt 再検証のため再評価対象", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: true,
        firstTimerVersion: 6,
        commitCount: 1,
        authorCountInCandidates: 1,
        author: "v6-user",
      }),
    ).toBe(true);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "lifetime-merged",
        firstTimerVersion: 5,
        commitCount: 1,
        authorCountInCandidates: 1,
      }),
    ).toBe(true);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: true,
        firstTimerVersion: 4,
        commitCount: 1,
        authorCountInCandidates: 1,
        author: "tamakichi23",
      }),
    ).toBe(true);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: MIN_WAIVED_READY_VERSION,
        commitCount: 3,
        authorCountInCandidates: 1,
        author: "tamakichi23",
      }),
    ).toBe(true);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "lifetime-merged",
        firstTimerVersion: 4,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(true);
  });

  test("MIN_VALID_READY_VERSION 未満や CURRENT_FIRST_TIMER_VERSION 以降のレコードは shouldReevaluateAuthorFirstTimer が false を返す", () => {
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: 6,
        author: "v6-user",
      }),
    ).toBe(false);
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: 4,
        author: "v4-user",
      }),
    ).toBe(false);
    expect(
      shouldReevaluateAuthorFirstTimer({
        firstTimerReason: "timeline-blocking",
        firstTimerVersion: MIN_WAIVED_READY_VERSION,
        author: "v3-user",
      }),
    ).toBe(false);
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
        firstTimerVersion: MIN_VALID_READY_VERSION,
        author: "repeat-user",
      }),
    ).toBe(false);
  });

  test("MIN_VALID_READY_VERSION 以上で累計マージ数理由（lifetime-merged）または IsFirstTimer=true が確定している場合は再評価不要", () => {
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "lifetime-merged",
        firstTimerVersion: MIN_VALID_READY_VERSION,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerVersion: MIN_VALID_READY_VERSION,
        commitCount: 1,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: true,
        firstTimerVersion: MIN_VALID_READY_VERSION,
        commitCount: 3,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
    expect(
      shouldReevaluateCachedSample({
        isFirstTimer: false,
        firstTimerReason: "privileged-or-bot",
        firstTimerVersion: CURRENT_FIRST_TIMER_VERSION,
        commitCount: 1,
        authorCountInCandidates: 1,
      }),
    ).toBe(false);
  });
});

describe("Domain: isPrivilegedOrBotAuthor", () => {
  test.each([
    ["MEMBER", true],
    ["OWNER", true],
    ["COLLABORATOR", true],
    ["collaborator", true],
    ["CONTRIBUTOR", false],
    ["NONE", false],
    [null, false],
    [undefined, false],
  ])("isPrivilegedAuthorAssociation(%p) -> %p", (assoc, expected) => {
    expect(isPrivilegedAuthorAssociation(assoc)).toBe(expected);
  });

  test.each([
    ["MEMBER は除外", { author: "asklar", authorType: "User", authorAssociation: "MEMBER" }, true],
    [
      "OWNER は除外",
      { author: "owner-user", authorType: "User", authorAssociation: "OWNER" },
      true,
    ],
    [
      "COLLABORATOR は除外",
      { author: "collab", authorType: "User", authorAssociation: "COLLABORATOR" },
      true,
    ],
    ["小文字 member も正規化して除外", { author: "ms-dev", authorAssociation: "member" }, true],
    [
      "authorType=Bot は除外",
      { author: "wingetbot", authorType: "Bot", authorAssociation: "NONE" },
      true,
    ],
    ["login が [bot] 末尾は除外", { author: "renovate[bot]", authorType: "User" }, true],
    [
      "マージ後の一般コントリビューター (CONTRIBUTOR) は許容",
      { author: "newbie", authorType: "User", authorAssociation: "CONTRIBUTOR" },
      false,
    ],
    [
      "FIRST_TIME_CONTRIBUTOR / NONE は許容",
      { author: "first-user", authorType: "User", authorAssociation: "FIRST_TIME_CONTRIBUTOR" },
      false,
    ],
    ["属性未設定は許容", { author: "legacy-user" }, false],
  ])("%s", (_label, input, expected) => {
    expect(isPrivilegedOrBotAuthor(input)).toBe(expected);
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

describe("Domain: hasValidatedReadyVersion & 汎用作者メタデータバッチ", () => {
  test.each([
    ["MEMBER", true],
    ["OWNER", true],
    ["COLLABORATOR", true],
    ["collaborator", true],
    ["CONTRIBUTOR", false],
    ["NONE", false],
    [null, false],
    [undefined, false],
  ])("isPrivilegedAuthorAssociation(%p) -> %p", (assoc, expected) => {
    expect(isPrivilegedAuthorAssociation(assoc)).toBe(expected);
  });

  test.each([
    [undefined, false],
    [4, false],
    [5, false],
    [6, false],
    [7, true],
  ])("hasValidatedReadyVersion(%p) => %p", (version, expected) => {
    expect(hasValidatedReadyVersion(version)).toBe(expected);
  });

  test("buildPullRequestAuthorMetadataQuery は repository をサニタイズし alias クエリを構築する", () => {
    expect(buildPullRequestAuthorMetadataQuery("", [1])).toBe("");
    expect(buildPullRequestAuthorMetadataQuery("microsoft/winget-pkgs", [])).toBe("");
    const query = buildPullRequestAuthorMetadataQuery("microsoft/winget-pkgs", [101, 102]);
    expect(query).toContain('repository(owner: "microsoft", name: "winget-pkgs")');
    expect(query).toContain("p_0: pullRequest(number: 101)");
    expect(query).toContain("p_1: pullRequest(number: 102)");
    expect(query).toContain("authorAssociation");
    expect(() => buildPullRequestAuthorMetadataQuery("microsoft/winget-pkgs", [0])).toThrow(
      RangeError,
    );
  });

  test("parsePullRequestAuthorMetadata は null ノードをスキップしつつ User / Bot / ghost を復元する", () => {
    const parsed = parsePullRequestAuthorMetadata([101, 102, 103, 104], {
      repository: {
        p_0: { author: { __typename: "User", login: "asklar" }, authorAssociation: "MEMBER" },
        p_1: { author: { __typename: "Bot", login: "wingetbot" }, authorAssociation: "NONE" },
        p_2: null,
        p_3: { author: null, authorAssociation: "CONTRIBUTOR" },
      },
    });
    expect(parsed.get(101)).toEqual({
      author: "asklar",
      authorType: "User",
      authorAssociation: "MEMBER",
    });
    expect(parsed.get(102)).toEqual({
      author: "wingetbot",
      authorType: "Bot",
      authorAssociation: "NONE",
    });
    expect(parsed.has(103)).toBe(false);
    expect(parsed.get(104)).toEqual({ authorAssociation: "CONTRIBUTOR" });
  });

  test("resolvePullRequestAuthorMetadata は重複排除・チャンク分割して取得し、不正 batchSize を拒否する", async () => {
    const executed: string[] = [];
    const result = await resolvePullRequestAuthorMetadata(
      "microsoft/winget-pkgs",
      [10, 20, 10, 30],
      async (query) => {
        executed.push(query);
        if (query.includes("number: 10")) {
          return {
            repository: {
              p_0: {
                author: { __typename: "User", login: "u10" },
                authorAssociation: "CONTRIBUTOR",
              },
              p_1: { author: { __typename: "User", login: "u20" }, authorAssociation: "MEMBER" },
            },
          };
        }
        return {
          repository: {
            p_0: { author: { __typename: "Bot", login: "b30" }, authorAssociation: "NONE" },
          },
        };
      },
      { batchSize: 2 },
    );
    expect(executed).toHaveLength(2);
    expect(result.get(10)?.authorAssociation).toBe("CONTRIBUTOR");
    expect(result.get(20)?.authorAssociation).toBe("MEMBER");
    expect(result.get(30)?.authorType).toBe("Bot");

    await expect(
      resolvePullRequestAuthorMetadata("microsoft/winget-pkgs", [1], async () => undefined, {
        batchSize: 0,
      }),
    ).rejects.toThrow(RangeError);
  });
});
