import { describe, expect, test } from "bun:test";
import {
  calculateFirstReviewMainstreamFrontier,
  classifyPrIntervention,
  DELETED_ACTOR_LABEL,
  FIRST_REVIEW_MAINSTREAM_MODE,
  type FirstReviewCohortCandidate,
  hasDeterministicAutomationManualEdit,
  isBotActor,
  isDeterministicAutomationComment,
  isSameActorLogin,
  summarizeInterventionFrontier,
} from "../../src/domain/intervention";
import type {
  DepthsRow,
  PrInterventionActor,
  PrInterventionCommentInput,
} from "../../src/models/depths";

describe("Domain: intervention helpers", () => {
  test.each<{
    name: string;
    actor: PrInterventionActor | null | undefined;
    expected: boolean;
  }>([
    {
      name: "GraphQL Bot 型（[bot] なし login: copilot-pull-request-reviewer）",
      actor: { __typename: "Bot", login: "copilot-pull-request-reviewer" },
      expected: true,
    },
    {
      name: "GraphQL Bot 型（microsoft-github-policy-service）",
      actor: { __typename: "Bot", login: "microsoft-github-policy-service" },
      expected: true,
    },
    {
      name: "login 末尾が [bot]（__typename 省略時）",
      actor: { login: "github-actions[bot]" },
      expected: true,
    },
    {
      name: "User 型だが純粋ボット名（wingetbot）",
      actor: { __typename: "User", login: "wingetbot" },
      expected: true,
    },
    {
      name: "User 型の純粋ボット名（大文字混在）",
      actor: { __typename: "User", login: "WingetBot" },
      expected: true,
    },
    {
      name: "通常の人間ユーザー（stephengillie）",
      actor: { __typename: "User", login: "stephengillie" },
      expected: false,
    },
    {
      name: "削除済みアカウント（author === null）はボット扱いしない",
      actor: null,
      expected: false,
    },
    {
      name: "undefined はボット扱いしない",
      actor: undefined,
      expected: false,
    },
  ])("isBotActor: $name -> $expected", ({ actor, expected }) => {
    expect(isBotActor(actor)).toBe(expected);
  });

  test.each<{
    name: string;
    body: string | null | undefined;
    expected: boolean;
  }>([
    {
      name: "Deterministic automation ログを含む",
      body: "This manifest version has been depreciated. (Deterministic automation - build 1830.)",
      expected: true,
    },
    {
      name: "Manual Validation + Deterministic automation を含む",
      body: "Manual Validation ended with:\n> error\n(Deterministic automation - build 1831.)",
      expected: true,
    },
    {
      name: "人間の通常質問コメント",
      body: "Hi @user, Does this app have a privacy policy?",
      expected: false,
    },
    {
      name: "Waiver コマンドコメント",
      body: "@wingetbot waivers Add Policy-Test-1.2",
      expected: false,
    },
    {
      name: "null / undefined",
      body: null,
      expected: false,
    },
  ])("isDeterministicAutomationComment: $name -> $expected", ({ body, expected }) => {
    expect(isDeterministicAutomationComment(body)).toBe(expected);
  });

  test.each<{
    name: string;
    comment: PrInterventionCommentInput;
    prAuthor?: string | null;
    expected: boolean;
  }>([
    {
      name: "末尾に Edit: 追記＋lastEditedAt＋人間 editor がある（#439241 実例相当）",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: "2026-10-30T20:23:59Z",
        editor: { __typename: "User", login: "stephengillie" },
        body: "Manual Validation ended with:\n> error\n\n(Deterministic automation - build 1831.)\n\nEdit: My approval VMs have been having difficulty connecting to this host recently.",
      },
      prAuthor: "kachakaran6",
      expected: true,
    },
    {
      name: "末尾に *Edit: ...*（斜体）があり lastEditedAt 省略時も手動追記として検知",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        body: "Manual Validation ended with:\n(Deterministic automation - build 1831.)\n\n*Edit: My approval VMs have been having difficulty connecting to this host recently.*",
      },
      prAuthor: "kachakaran6",
      expected: true,
    },
    {
      name: "先頭（マーカー前）の非引用行に *Edit: が追記されている場合も検知",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        body: "*Edit: Please check installer URL.*\n\n(Deterministic automation - build 1831.)",
      },
      prAuthor: "kachakaran6",
      expected: true,
    },
    {
      name: "lastEditedAt が投稿後に更新され、editor が第三者人間なら本文途中編集でも検知",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: "2026-10-30T20:25:00Z",
        editor: { __typename: "User", login: "stephengillie" },
        body: "Manual note inserted above.\n(Deterministic automation - build 1831.)",
      },
      prAuthor: "kachakaran6",
      expected: true,
    },
    {
      name: "純粋な自動検証ログ（未編集・末尾改行と HTML コメントのみ）は除外",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: null,
        editor: null,
        body: "Automatic Validation ended with:\n(Deterministic automation - build 1831.)\n<!-- auto -->\n",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
    {
      name: "引用ログ内に Edit: が含まれるだけの未編集コメントは誤検知しない",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: null,
        editor: null,
        body: "Automatic Validation ended with:\n> Edit: something in installer output\n(Deterministic automation - build 1831.)",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
    {
      name: "lastEditedAt が createdAt と同一時刻かつ追記なしは未編集として除外",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: "2026-10-30T20:23:43Z",
        editor: { __typename: "User", login: "stephengillie" },
        body: "Automatic Validation ended with: (Deterministic automation - build 1831.)",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
    {
      name: "ボット（__typename: Bot）による自動編集は人間介入と誤検知しない",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: "2026-10-30T20:24:00Z",
        editor: { __typename: "Bot", login: "winget-automation" },
        body: "Automatic Validation ended with:\n(Deterministic automation - build 1831.)\nEdit: Automated retry note",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
    {
      name: "純粋ボット名（wingetbot / [bot]）による自動編集も人間介入と誤検知しない",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: "2026-10-30T20:24:00Z",
        editor: { __typename: "User", login: "wingetbot" },
        body: "(Deterministic automation - build 1831.)\nUpdated by bot",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
    {
      name: "PR 作成者本人による編集は第三者介入とみなさない",
      comment: {
        author: { __typename: "User", login: "stephengillie" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: "2026-10-30T20:24:00Z",
        editor: { __typename: "User", login: "Kachakaran6" },
        body: "(Deterministic automation - build 1831.)\nEdit: Fixed by author",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
    {
      name: "元投稿者がボット（wingetbot）でも第三者人間 editor が投稿後に編集した場合は検知",
      comment: {
        author: { __typename: "User", login: "wingetbot" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: "2026-10-30T20:24:10Z",
        editor: { __typename: "User", login: "stephengillie" },
        body: "(Deterministic automation - build 1831.)\n\nEdit: Needs manual host check.",
      },
      prAuthor: "kachakaran6",
      expected: true,
    },
    {
      name: "元投稿者がボットで未編集のまま末尾テキストを含む場合は誤検知しない",
      comment: {
        author: { __typename: "User", login: "wingetbot" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: null,
        editor: null,
        body: "(Deterministic automation - build 1831.)\n\nGenerated automatically.",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
    {
      name: "元投稿者が PR 作成者本人で未編集の引用追記を含む場合は誤検知しない",
      comment: {
        author: { __typename: "User", login: "kachakaran6" },
        createdAt: "2026-10-30T20:23:43Z",
        lastEditedAt: null,
        editor: null,
        body: "> (Deterministic automation - build 1831.)\n\nI fixed the URL.",
      },
      prAuthor: "kachakaran6",
      expected: false,
    },
  ])(
    "hasDeterministicAutomationManualEdit: $name -> $expected",
    ({ comment, prAuthor, expected }) => {
      expect(hasDeterministicAutomationManualEdit(comment, prAuthor)).toBe(expected);
    },
  );

  test("isSameActorLogin は大小文字無視で比較し、作成者不明時は false を返す", () => {
    expect(isSameActorLogin("Alice", "alice")).toBe(true);
    expect(isSameActorLogin("bob", "alice")).toBe(false);
    expect(isSameActorLogin("alice", null)).toBe(false);
    expect(isSameActorLogin(null, "alice")).toBe(false);
  });
});

describe("Domain: classifyPrIntervention", () => {
  test("ボットレビュー・本人コメント・自動検証ログ・セルフアサインのみの場合は完全未着手（Intervened=false）", () => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "submitter" },
      assignees: { nodes: [{ __typename: "User", login: "SubMitter" }] },
      reviews: {
        nodes: [
          {
            author: { __typename: "Bot", login: "copilot-pull-request-reviewer" },
            state: "COMMENTED",
          },
          { author: { __typename: "User", login: "submitter" }, state: "COMMENTED" },
        ],
      },
      comments: {
        nodes: [
          {
            author: { __typename: "Bot", login: "microsoft-github-policy-service" },
            body: "CLA check",
          },
          { author: { __typename: "User", login: "wingetbot" }, body: "@wingetbot run" },
          {
            author: { __typename: "User", login: "submitter" },
            body: "@microsoft-github-policy-service agree",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            body: "Automatic Validation ended with: (Deterministic automation - build 1830.)",
          },
        ],
      },
    });

    expect(summary).toEqual({
      Intervened: false,
      ThirdPartyAssignees: [],
      HumanReviewCount: 0,
      ManualCommentCount: 0,
    });
  });

  test("stephengillie の自動ログと人間コメントが混在する場合は、人間コメントのみをカウントして介入済みとする", () => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "fylorn" },
      assignees: { nodes: [] },
      reviews: { nodes: [] },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            body: "This manifest version has been depreciated. (Deterministic automation - build 1830.)",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            body: "Hi @fylorn, Does it have a privacy policy?",
          },
        ],
      },
    });

    expect(summary).toEqual({
      Intervened: true,
      ThirdPartyAssignees: [],
      HumanReviewCount: 0,
      ManualCommentCount: 1,
      PrimaryBadge: {
        Kind: "comment",
        Actor: "stephengillie",
        Label: "コメント済: stephengillie",
      },
    });
  });

  test("自動検証ログにメンテナの手動追記（Edit:＋lastEditedAt）がある場合は人間介入と判定し、編集日時を FirstHumanInterventionAt とする", () => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "kachakaran6" },
      assignees: { nodes: [] },
      reviews: { nodes: [] },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            createdAt: "2026-10-30T05:01:16Z",
            lastEditedAt: null,
            editor: null,
            body: "This manifest version has been depreciated. (Deterministic automation - build 1830.)",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            createdAt: "2026-10-30T20:23:43Z",
            lastEditedAt: "2026-10-31T01:00:00Z",
            editor: { __typename: "User", login: "stephengillie" },
            body: "Manual Validation ended with:\n> error\n\n(Deterministic automation - build 1831.)\n\n*Edit: My approval VMs have been having difficulty connecting to this host recently.*",
          },
        ],
      },
    });

    expect(summary).toEqual({
      Intervened: true,
      ThirdPartyAssignees: [],
      HumanReviewCount: 0,
      ManualCommentCount: 1,
      PrimaryBadge: {
        Kind: "comment",
        Actor: "stephengillie",
        Label: "コメント済: stephengillie",
      },
      FirstHumanInterventionAt: "2026-10-31T01:00:00.000Z",
      FirstInterventionKind: "comment",
      FirstInterventionActor: "stephengillie",
    });
  });

  test("自動検証ログがボットアカウントにより自動編集された場合は人間介入として誤検知しない", () => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "kachakaran6" },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            createdAt: "2026-10-30T20:23:43Z",
            lastEditedAt: "2026-10-30T20:24:10Z",
            editor: { __typename: "Bot", login: "github-actions[bot]" },
            body: "Manual Validation ended with:\n(Deterministic automation - build 1831.)\nEdit: Automated sync",
          },
        ],
      },
    });

    expect(summary).toEqual({
      Intervened: false,
      ThirdPartyAssignees: [],
      HumanReviewCount: 0,
      ManualCommentCount: 0,
    });
  });

  test("元投稿者がボット（wingetbot）または PR 作成者本人の自動検証ログでも、第三者人間 editor による投稿後編集は人間介入として検知する", () => {
    const summaryFromBot = classifyPrIntervention({
      author: { __typename: "User", login: "kachakaran6" },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "wingetbot" },
            createdAt: "2026-10-30T20:23:43Z",
            lastEditedAt: "2026-10-30T20:25:00Z",
            editor: { __typename: "User", login: "maintainer" },
            body: "Validation output:\n(Deterministic automation - build 1831.)\n\nEdit: Retrying after host maintenance.",
          },
        ],
      },
    });

    expect(summaryFromBot).toEqual({
      Intervened: true,
      ThirdPartyAssignees: [],
      HumanReviewCount: 0,
      ManualCommentCount: 1,
      PrimaryBadge: {
        Kind: "comment",
        Actor: "maintainer",
        Label: "コメント済: maintainer",
      },
      FirstHumanInterventionAt: "2026-10-30T20:25:00.000Z",
      FirstInterventionKind: "comment",
      FirstInterventionActor: "maintainer",
    });

    const summaryFromAuthor = classifyPrIntervention({
      author: { __typename: "User", login: "kachakaran6" },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "kachakaran6" },
            createdAt: "2026-10-30T20:23:43Z",
            lastEditedAt: "2026-10-30T21:00:00Z",
            editor: { __typename: "User", login: "stephengillie" },
            body: "> (Deterministic automation - build 1831.)\n\nEdit: Confirmed by maintainer.",
          },
        ],
      },
    });

    expect(summaryFromAuthor.Intervened).toBe(true);
    expect(summaryFromAuthor.ManualCommentCount).toBe(1);
    expect(summaryFromAuthor.PrimaryBadge?.Actor).toBe("stephengillie");
    expect(summaryFromAuthor.FirstHumanInterventionAt).toBe("2026-10-30T21:00:00.000Z");
  });

  test.each<{
    name: string;
    state: string;
  }>([
    { name: "APPROVED", state: "APPROVED" },
    { name: "CHANGES_REQUESTED", state: "CHANGES_REQUESTED" },
    { name: "COMMENTED", state: "COMMENTED" },
    { name: "DISMISSED", state: "DISMISSED" },
  ])("人間レビュー（state=$state）は介入済みと判定する", ({ state }) => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "submitter" },
      reviews: {
        nodes: [{ author: { __typename: "User", login: "stephengillie" }, state }],
      },
    });

    expect(summary.Intervened).toBe(true);
    expect(summary.HumanReviewCount).toBe(1);
    expect(summary.PrimaryBadge).toEqual({
      Kind: "review",
      Actor: "stephengillie",
      Label: `レビュー済: stephengillie (${state})`,
      ReviewState: state,
    });
  });

  test("代表バッジの優先順は レビュー > コメント > アサイン で、レビュー複数時は最新を優先する", () => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "submitter" },
      assignees: { nodes: [{ login: "trenly" }] },
      reviews: {
        nodes: [
          { author: { __typename: "User", login: "reviewerA" }, state: "COMMENTED" },
          { author: { __typename: "User", login: "reviewerB" }, state: "APPROVED" },
        ],
      },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            body: "@wingetbot waivers Add Policy-Test-1.2",
          },
        ],
      },
    });

    expect(summary.Intervened).toBe(true);
    expect(summary.HumanReviewCount).toBe(2);
    expect(summary.ManualCommentCount).toBe(1);
    expect(summary.ThirdPartyAssignees).toEqual(["trenly"]);
    expect(summary.PrimaryBadge).toEqual({
      Kind: "review",
      Actor: "reviewerB",
      Label: "レビュー済: reviewerB (APPROVED)",
      ReviewState: "APPROVED",
    });
  });

  test("削除済みアカウント（author === null）によるコメント・レビューは保守的に介入済みとする", () => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "submitter" },
      comments: {
        nodes: [{ author: null, body: "Legacy review comment" }],
      },
    });

    expect(summary.Intervened).toBe(true);
    expect(summary.ManualCommentCount).toBe(1);
    expect(summary.PrimaryBadge).toEqual({
      Kind: "comment",
      Actor: DELETED_ACTOR_LABEL,
      Label: `コメント済: ${DELETED_ACTOR_LABEL}`,
    });
  });
});

describe("Domain: summarizeInterventionFrontier", () => {
  test("種別内訳・アクター内訳・経過日数を正しく集計する", () => {
    const makeRow = (
      num: number,
      createdAt: string,
      badge?: DepthsRow["Intervention"],
    ): DepthsRow => ({
      PR: `#${num}`,
      Number: num,
      作成日時: createdAt,
      更新日時: createdAt,
      CreatedAt: createdAt,
      UpdatedAt: createdAt,
      タイトル: `PR ${num}`,
      Title: `PR ${num}`,
      Url: `https://example.com/${num}`,
      Intervention: badge,
    });

    const rows: DepthsRow[] = [
      makeRow(101, "2026-10-01T00:00:00Z", {
        Intervened: true,
        ThirdPartyAssignees: [],
        HumanReviewCount: 1,
        ManualCommentCount: 0,
        PrimaryBadge: {
          Kind: "review",
          Actor: "matteozanettii",
          Label: "レビュー済: matteozanettii (APPROVED)",
          ReviewState: "APPROVED",
        },
      }),
      makeRow(102, "2026-10-02T00:00:00Z", {
        Intervened: true,
        ThirdPartyAssignees: [],
        HumanReviewCount: 0,
        ManualCommentCount: 2,
        PrimaryBadge: {
          Kind: "comment",
          Actor: "stephengillie",
          Label: "コメント済: stephengillie",
        },
      }),
      makeRow(103, "2026-10-03T00:00:00Z", {
        Intervened: true,
        ThirdPartyAssignees: ["stephengillie"],
        HumanReviewCount: 0,
        ManualCommentCount: 0,
        PrimaryBadge: {
          Kind: "assignee",
          Actor: "stephengillie",
          Label: "アサイン済: stephengillie",
        },
      }),
    ];

    const summary = summarizeInterventionFrontier(rows, "2026-10-11T00:00:00Z");
    expect(summary.count).toBe(3);
    expect(summary.head?.Number).toBe(101);
    expect(summary.headElapsedDays).toBe(10);
    expect(summary.kindCounts).toEqual({ review: 1, comment: 1, assignee: 1 });
    expect(summary.actorCounts).toEqual([
      { login: "stephengillie", count: 2 },
      { login: "matteozanettii", count: 1 },
    ]);
  });
});

describe("Domain: FirstHumanInterventionAt & calculateFirstReviewMainstreamFrontier", () => {
  const NOW = "2026-11-17T00:00:00Z";

  test("ボット・本人コメント・自動検証ログを除外し、レビュー/手動コメント/第三者アサインの中から最古の介入日時を特定する", () => {
    const summary = classifyPrIntervention({
      author: { __typename: "User", login: "submitter" },
      assignees: {
        nodes: [
          { __typename: "User", login: "submitter" },
          { __typename: "User", login: "reviewerA" },
        ],
      },
      reviews: {
        nodes: [
          {
            author: { __typename: "Bot", login: "microsoft-github-policy-service" },
            state: "APPROVED",
            submittedAt: "2026-11-01T00:00:00Z",
          },
          {
            author: { __typename: "User", login: "reviewerB" },
            state: "APPROVED",
            submittedAt: "2026-11-14T12:00:00Z",
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "submitter" },
            body: "@microsoft-github-policy-service agree",
            createdAt: "2026-11-02T00:00:00Z",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            body: "Bad manifest (Deterministic automation - build 123.)",
            createdAt: "2026-11-05T00:00:00Z",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            body: "Hi, please fix installer URL.",
            createdAt: "2026-11-12T06:00:00Z",
          },
        ],
      },
      timelineItems: {
        nodes: [
          {
            __typename: "AssignedEvent",
            createdAt: "2026-11-11T03:00:00Z",
            actor: { __typename: "User", login: "reviewerA" },
            assignee: { __typename: "User", login: "reviewerA" },
          },
        ],
      },
    });

    expect(summary.Intervened).toBe(true);
    expect(summary.FirstHumanInterventionAt).toBe("2026-11-11T03:00:00.000Z");
    expect(summary.FirstInterventionKind).toBe("assignee");
    expect(summary.FirstInterventionActor).toBe("reviewerA");
  });

  const makeCandidate = (
    number: number,
    createdAt: string,
    firstInterventionAt: string,
    state: "OPEN" | "MERGED" = "OPEN",
  ): FirstReviewCohortCandidate => ({
    number,
    title: `New package #${number}`,
    url: `https://github.com/microsoft/winget-pkgs/pull/${number}`,
    state,
    author: `author-${number}`,
    commitCount: 1,
    createdAt,
    mergedAt: state === "MERGED" ? firstInterventionAt : null,
    intervention: {
      Intervened: true,
      ThirdPartyAssignees: [],
      HumanReviewCount: 1,
      ManualCommentCount: 0,
      FirstHumanInterventionAt: firstInterventionAt,
      FirstInterventionKind: "review",
      FirstInterventionActor: "stephengillie",
    },
  });

  test("0 件時は NaN や例外を出さず安全に null/0 を返す", () => {
    const frontier = calculateFirstReviewMainstreamFrontier([], NOW);
    expect(frontier).toEqual({
      Mode: FIRST_REVIEW_MAINSTREAM_MODE,
      WindowDays: 7,
      CohortCount: 0,
      OpenCount: 0,
      MergedCount: 0,
      MedianCreatedAt: null,
      LagDays: null,
      OldestCreatedAt: null,
      NewestCreatedAt: null,
      Items: [],
    });
  });

  test("1 件時はその起票日時を中央値とする", () => {
    const frontier = calculateFirstReviewMainstreamFrontier(
      [makeCandidate(1, "2026-10-10T00:00:00Z", "2026-11-16T00:00:00Z", "MERGED")],
      NOW,
    );
    expect(frontier.CohortCount).toBe(1);
    expect(frontier.OpenCount).toBe(0);
    expect(frontier.MergedCount).toBe(1);
    expect(frontier.MedianCreatedAt).toBe("2026-10-10T00:00:00.000Z");
    expect(frontier.LagDays).toBe(38);
  });

  test("奇数件（3件）・オープン＋マージ済み合算で起票日時中央値を算出し、7日窓外を除外する", () => {
    const frontier = calculateFirstReviewMainstreamFrontier(
      [
        // 窓外（8日前に初回介入済み）→ 除外される
        makeCandidate(10, "2026-09-01T00:00:00Z", "2026-11-09T00:00:00Z", "OPEN"),
        // 窓内の 3 件（10/01 MERGED, 10/10 OPEN, 10/20 MERGED → 中央値は 10/10）
        makeCandidate(11, "2026-10-20T00:00:00Z", "2026-11-12T00:00:00Z", "MERGED"),
        makeCandidate(12, "2026-10-01T00:00:00Z", "2026-11-15T00:00:00Z", "MERGED"),
        makeCandidate(13, "2026-10-10T00:00:00Z", "2026-11-16T00:00:00Z", "OPEN"),
      ],
      NOW,
    );
    expect(frontier.CohortCount).toBe(3);
    expect(frontier.OpenCount).toBe(1);
    expect(frontier.MergedCount).toBe(2);
    expect(frontier.MedianCreatedAt).toBe("2026-10-10T00:00:00.000Z");
    expect(frontier.LagDays).toBe(38);
    expect(frontier.Items?.map((i) => i.Number)).toEqual([13, 12, 11]);
  });

  test("偶数件（4件）は中央2件の平均起票日時を算出し、同一PRのOPEN/MERGED重複はMERGEDを優先する", () => {
    const frontier = calculateFirstReviewMainstreamFrontier(
      [
        makeCandidate(21, "2026-10-02T00:00:00Z", "2026-11-12T00:00:00Z", "OPEN"),
        makeCandidate(22, "2026-10-10T00:00:00Z", "2026-11-13T00:00:00Z", "OPEN"),
        makeCandidate(23, "2026-10-12T00:00:00Z", "2026-11-14T00:00:00Z", "OPEN"),
        makeCandidate(23, "2026-10-12T00:00:00Z", "2026-11-14T00:00:00Z", "MERGED"),
        makeCandidate(24, "2026-10-20T00:00:00Z", "2026-11-15T00:00:00Z", "MERGED"),
      ],
      NOW,
    );
    expect(frontier.CohortCount).toBe(4);
    expect(frontier.OpenCount).toBe(2);
    expect(frontier.MergedCount).toBe(2);
    // 10/10 00:00 と 10/12 00:00 の中点 → 10/11 00:00
    expect(frontier.MedianCreatedAt).toBe("2026-10-11T00:00:00.000Z");
    expect(frontier.LagDays).toBe(37);
  });

  test("第三者 AssignedEvent の後にアサイン解除され現在 Intervened=false でも、FirstHumanInterventionAt が窓内ならコホートに含める", () => {
    const intervention = classifyPrIntervention({
      author: { __typename: "User", login: "submitter" },
      assignees: { nodes: [] },
      reviews: { nodes: [] },
      comments: { nodes: [] },
      timelineItems: {
        nodes: [
          {
            __typename: "AssignedEvent",
            createdAt: "2026-11-15T00:00:00Z",
            actor: { __typename: "User", login: "stephengillie" },
            assignee: { __typename: "User", login: "stephengillie" },
          },
        ],
      },
    });
    expect(intervention.Intervened).toBe(false);
    expect(intervention.FirstHumanInterventionAt).toBe("2026-11-15T00:00:00.000Z");

    const frontier = calculateFirstReviewMainstreamFrontier(
      [
        {
          number: 31,
          title: "Unassigned after human assign event",
          url: "https://github.com/microsoft/winget-pkgs/pull/31",
          state: "OPEN",
          author: "submitter",
          commitCount: 1,
          createdAt: "2026-10-08T00:00:00Z",
          intervention,
        },
      ],
      NOW,
    );
    expect(frontier.CohortCount).toBe(1);
    expect(frontier.MedianCreatedAt).toBe("2026-10-08T00:00:00.000Z");
    expect(frontier.Items?.[0].InterventionKind).toBe("assignee");
  });

  test.each<{
    name: string;
    authorAssociation: string | null | undefined;
    author?: { __typename?: string | null; login?: string | null };
    expectedIntervened: boolean;
    expectedPrivCount?: number;
    expectedBadgeLabel?: string;
  }>([
    {
      name: "COLLABORATOR (stephengillie, #439626 相当) の Deterministic automation は反応ありとして Unreviewed から除外",
      authorAssociation: "COLLABORATOR",
      author: { __typename: "User", login: "stephengillie" },
      expectedIntervened: true,
      expectedPrivCount: 1,
      expectedBadgeLabel: "自動指摘済: stephengillie",
    },
    {
      name: "MEMBER の Deterministic automation も反応あり",
      authorAssociation: "MEMBER",
      author: { __typename: "User", login: "denelon" },
      expectedIntervened: true,
      expectedPrivCount: 1,
      expectedBadgeLabel: "自動指摘済: denelon",
    },
    {
      name: "OWNER の Deterministic automation も反応あり",
      authorAssociation: "OWNER",
      author: { __typename: "User", login: "owner-user" },
      expectedIntervened: true,
      expectedPrivCount: 1,
      expectedBadgeLabel: "自動指摘済: owner-user",
    },
    {
      name: "小文字 collaborator も正規化して反応あり",
      authorAssociation: "collaborator",
      author: { __typename: "User", login: "collab-user" },
      expectedIntervened: true,
      expectedPrivCount: 1,
      expectedBadgeLabel: "自動指摘済: collab-user",
    },
    {
      name: "一般ユーザー (CONTRIBUTOR / NONE / 未設定) の未編集 Deterministic automation は従来どおり未着手",
      authorAssociation: "CONTRIBUTOR",
      author: { __typename: "User", login: "random-user" },
      expectedIntervened: false,
    },
    {
      name: "PR 作成者本人が COLLABORATOR で Deterministic automation を投稿した場合は本人扱いで未着手",
      authorAssociation: "COLLABORATOR",
      author: { __typename: "User", login: "submitter" },
      expectedIntervened: false,
    },
    {
      name: "純粋 Bot (wingetbot / [bot]) が COLLABORATOR 相当で Deterministic automation を投稿しても除外",
      authorAssociation: "COLLABORATOR",
      author: { __typename: "User", login: "wingetbot" },
      expectedIntervened: false,
    },
  ])(
    "Deterministic automation 特権ロール判定: $name",
    ({ authorAssociation, author, expectedIntervened, expectedPrivCount, expectedBadgeLabel }) => {
      const summary = classifyPrIntervention({
        author: { __typename: "User", login: "submitter" },
        assignees: { nodes: [] },
        reviews: { nodes: [] },
        comments: {
          nodes: [
            {
              author,
              authorAssociation,
              createdAt: "2026-10-30T06:18:49Z",
              body: "This manifest version has been depreciated. Please use version `1.28.0`. (Deterministic automation - build 1830.)",
            },
          ],
        },
      });

      expect(summary.Intervened).toBe(expectedIntervened);
      expect(summary.PrivilegedAutomationCommentCount).toBe(expectedPrivCount);
      expect(summary.ManualCommentCount).toBe(0);
      expect(summary.HumanReviewCount).toBe(0);
      // 主戦場ライン（FirstHumanInterventionAt）には未編集の自動ログ日時を算入しない
      expect(summary.FirstHumanInterventionAt).toBeUndefined();
      if (expectedBadgeLabel) {
        expect(summary.PrimaryBadge).toEqual({
          Kind: "comment",
          Actor: author?.login ?? "",
          Label: expectedBadgeLabel,
        });
      } else {
        expect(summary.PrimaryBadge).toBeUndefined();
      }
    },
  );

  test("10/30 に COLLABORATOR の自動指摘があっても、11/18 にレビュー承認された PR の主戦場ライン初回人間介入日時は 11/18 のまま維持される（#440856 相当）", () => {
    const intervention = classifyPrIntervention({
      author: { __typename: "User", login: "rodolphobrock" },
      assignees: { nodes: [] },
      reviews: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            state: "APPROVED",
            submittedAt: "2026-11-18T17:50:15Z",
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            createdAt: "2026-10-30T06:42:36Z",
            body: "This manifest version has been depreciated. (Deterministic automation - build 1830.)",
          },
        ],
      },
    });

    expect(intervention.Intervened).toBe(true);
    expect(intervention.PrivilegedAutomationCommentCount).toBe(1);
    expect(intervention.FirstHumanInterventionAt).toBe("2026-11-18T17:50:15.000Z");
    expect(intervention.FirstInterventionKind).toBe("review");

    const frontier = calculateFirstReviewMainstreamFrontier(
      [
        {
          number: 440856,
          title: "New package",
          url: "https://github.com/microsoft/winget-pkgs/pull/440856",
          state: "MERGED",
          author: "rodolphobrock",
          commitCount: 2,
          createdAt: "2026-09-24T23:48:53Z",
          mergedAt: "2026-11-18T17:50:19Z",
          intervention,
        },
      ],
      "2026-11-19T05:00:00Z",
    );
    expect(frontier.CohortCount).toBe(1);
    expect(frontier.MergedCount).toBe(1);
    expect(frontier.MedianCreatedAt).toBe("2026-09-24T23:48:53.000Z");
  });
});
