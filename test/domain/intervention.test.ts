import { describe, expect, test } from "bun:test";
import {
  classifyPrIntervention,
  DELETED_ACTOR_LABEL,
  isBotActor,
  isDeterministicAutomationComment,
  isSameActorLogin,
  summarizeInterventionFrontier,
} from "../../src/domain/intervention";
import type { DepthsRow, PrInterventionActor } from "../../src/models/depths";

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
