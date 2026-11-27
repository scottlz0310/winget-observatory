import { describe, expect, test } from "bun:test";
import {
  buildFeedbackSearchQueryParts,
  buildReviewFeedbackEntry,
  CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
  canReuseCachedFeedbackEntry,
  categorizeFeedback,
  detectFeedbackTriggers,
  extractAuthorReplies,
  extractReviewFeedbackItems,
  filterReviewFeedbackRecords,
  hasEmbeddedImage,
  indexReviewFeedbackCorpus,
  isAuthorNoiseComment,
  isNewPackageTitle,
  isPolicyCommandOnlyComment,
  parseInstallerManifestMetadata,
  parseReviewFeedbackCorpus,
  type RawPrFeedbackInput,
  selectInstallerManifestPaths,
  serializeReviewFeedbackCorpus,
} from "../../src/domain/review-feedback";
import {
  formatReviewFeedbackMarkdown,
  summarizeReviewFeedback,
} from "../../src/domain/review-feedback-report";
import type {
  ReviewFeedbackCorpusEntry,
  ReviewFeedbackRecord,
} from "../../src/models/review-feedback";

function makeBasePr(overrides: Partial<RawPrFeedbackInput> = {}): RawPrFeedbackInput {
  return {
    repository: "microsoft/winget-pkgs",
    number: 445661,
    title: "New package: okzea.WindowRescue version 0.1.3",
    url: "https://github.com/microsoft/winget-pkgs/pull/445661",
    state: "MERGED",
    createdAt: "2026-10-02T12:31:18Z",
    updatedAt: "2026-11-26T23:42:59Z",
    mergedAt: "2026-11-26T21:50:19Z",
    closedAt: "2026-11-26T21:50:19Z",
    author: { __typename: "User", login: "okzea" },
    authorAssociation: "CONTRIBUTOR",
    commitCount: 3,
    currentLabels: ["New-Package", "Validation-Completed", "Moderator-Approved"],
    labeledEvents: [
      { label: "New-Package", createdAt: "2026-10-02T12:36:32Z" },
      { label: "Needs-Author-Feedback", createdAt: "2026-11-24T23:09:58Z" },
    ],
    reviews: [],
    comments: [
      {
        author: { __typename: "Bot", login: "microsoft-github-policy-service" },
        authorAssociation: "CONTRIBUTOR",
        body: "Hello @okzea, please sign CLA.",
        createdAt: "2026-10-02T12:32:12Z",
      },
      {
        author: { __typename: "User", login: "okzea" },
        authorAssociation: "CONTRIBUTOR",
        body: '@microsoft-github-policy-service agree company="Okzea Co., Ltd."',
        createdAt: "2026-10-02T12:43:48Z",
      },
      {
        author: { __typename: "User", login: "stephengillie" },
        authorAssociation: "COLLABORATOR",
        body: "This manifest version has been depreciated.\n\n(Deterministic automation - build 1830.)",
        createdAt: "2026-10-30T08:39:13Z",
      },
      {
        author: { __typename: "User", login: "taras-janea" },
        authorAssociation: "NONE",
        body: 'Required: On a clean Windows machine, the app fails to start:\n<img src="https://github.com/user-attachments/assets/abc" />\nOne optional note: the executable is unsigned.',
        createdAt: "2026-11-24T23:09:25Z",
      },
      {
        author: { __typename: "User", login: "taras-janea" },
        authorAssociation: "NONE",
        body: "[Policy] Needs-Author-Feedback",
        createdAt: "2026-11-24T23:09:40Z",
      },
      {
        author: { __typename: "User", login: "okzea" },
        authorAssociation: "CONTRIBUTOR",
        body: "Thanks! Fixed in 0.1.3: the exe now links the C runtime statically, so it no longer needs VCRUNTIME140.dll.",
        createdAt: "2026-11-25T01:58:59Z",
      },
      {
        author: { __typename: "User", login: "wingetbot" },
        authorAssociation: "COLLABORATOR",
        body: "[Publish pipeline succeeded]",
        createdAt: "2026-11-26T23:42:44Z",
      },
    ],
    filePaths: [
      "manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.installer.yaml",
      "manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.locale.en-US.yaml",
    ],
    ...overrides,
  };
}

describe("review-feedback domain logic", () => {
  test.each([
    ["New package: Foo.Bar version 1.0.0", true],
    ["  new package : Foo.Bar 1.0", true],
    ["New version: Foo.Bar version 1.1.0", false],
    ["Add package: Foo.Bar", false],
    [null, false],
    [undefined, false],
  ])("isNewPackageTitle(%j) => %s", (title, expected) => {
    expect(isNewPackageTitle(title)).toBe(expected);
  });

  test.each([
    ["[Policy] Needs-Author-Feedback", true],
    ["<!-- note -->\n[Policy] Validation-Completed", true],
    ["", true],
    ["Please fix PrivacyUrl\n[Policy] Needs-Author-Feedback", false],
    [null, false],
  ])("isPolicyCommandOnlyComment(%j) => %s", (body, expected) => {
    expect(isPolicyCommandOnlyComment(body)).toBe(expected);
  });

  test.each([
    ['@microsoft-github-policy-service agree company="Acme"', true],
    ["agree", true],
    ["@wingetbot run", true],
    ["[Policy] Needs-Author-Feedback", true],
    ["Fixed VCRUNTIME140.dll by static linking", false],
    ["", true],
  ])("isAuthorNoiseComment(%j) => %s", (body, expected) => {
    expect(isAuthorNoiseComment(body)).toBe(expected);
  });

  test.each([
    ['<img width="420" src="https://example.com/a.png" />', true],
    ["![screenshot](https://example.com/a.png)", true],
    ["No image here", false],
    [null, false],
  ])("hasEmbeddedImage(%j) => %s", (body, expected) => {
    expect(hasEmbeddedImage(body)).toBe(expected);
  });

  test("buildFeedbackSearchQueryParts は状態とトリガー修飾子に応じたクエリを構築する", () => {
    const merged = buildFeedbackSearchQueryParts({
      repository: "microsoft/winget-pkgs",
      state: "merged",
      sinceIso: "2026-09-01T00:00:00.000Z",
      untilIso: "2026-11-27T00:00:00.000Z",
    });
    expect(merged).toContain("is:merged");
    expect(merged).toContain('label:"New-Package"');
    expect(merged).toContain('"New package:" in:title');
    expect(merged).toContain("merged:2026-09-01T00:00:00.000Z..2026-11-27T00:00:00.000Z");

    const openNaf = buildFeedbackSearchQueryParts({
      repository: "microsoft/winget-pkgs",
      state: "open",
      sinceIso: "2026-09-01T00:00:00.000Z",
      untilIso: "2026-11-27T00:00:00.000Z",
      triggerQualifier: "needs-author-feedback",
    });
    expect(openNaf).toContain("is:open");
    expect(openNaf).toContain('label:"Needs-Author-Feedback"');

    const closedCr = buildFeedbackSearchQueryParts({
      repository: "microsoft/winget-pkgs",
      state: "closed",
      sinceIso: "2026-09-01T00:00:00.000Z",
      untilIso: "2026-11-27T00:00:00.000Z",
      triggerQualifier: "changes-requested",
    });
    expect(closedCr).toContain("is:closed");
    expect(closedCr).toContain("is:unmerged");
    expect(closedCr).toContain("review:changes_requested");
  });

  test("detectFeedbackTriggers はラベル履歴・現在ラベル・人間 CHANGES_REQUESTED レビューを検知する", () => {
    const result = detectFeedbackTriggers({
      prAuthorLogin: "author1",
      currentLabels: ["Changes-Requested"],
      labeledEvents: [{ label: "Needs-Author-Feedback" }],
      reviews: [
        {
          author: { __typename: "Bot", login: "policy-bot" },
          state: "CHANGES_REQUESTED",
        },
        {
          author: { __typename: "User", login: "stephengillie" },
          state: "CHANGES_REQUESTED",
        },
      ],
    });
    expect(result.triggers).toEqual([
      "needs-author-feedback-label",
      "changes-requested-label",
      "changes-requested-review",
    ]);
    expect(result.historicalFeedbackLabels).toEqual(["Needs-Author-Feedback", "Changes-Requested"]);
  });

  test("extractReviewFeedbackItems は 3 系統（review / review_comment / issue_comment）からノイズを除いて抽出する", () => {
    const pr = makeBasePr({
      reviews: [
        {
          author: { __typename: "User", login: "stephengillie" },
          authorAssociation: "COLLABORATOR",
          state: "CHANGES_REQUESTED",
          body: "Please update PrivacyUrl.",
          submittedAt: "2026-11-20T01:00:00Z",
          comments: [
            {
              author: { __typename: "User", login: "stephengillie" },
              authorAssociation: "COLLABORATOR",
              path: "manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.locale.en-US.yaml",
              body: "```suggestion\nPrivacyUrl: https://example.com/privacy\n```",
              createdAt: "2026-11-20T01:00:01Z",
            },
          ],
        },
      ],
      comments: [
        ...makeBasePr().comments,
        {
          author: { __typename: "User", login: "stephengillie" },
          authorAssociation: "COLLABORATOR",
          body: "URL check failed.\n(Automated message)\nEdit: Actually 404 on ReleaseNotesUrl.",
          createdAt: "2026-11-21T00:00:00Z",
          lastEditedAt: "2026-11-21T01:00:00Z",
          editor: { __typename: "User", login: "stephengillie" },
        },
        {
          author: { __typename: "User", login: "someone" },
          authorAssociation: "NONE",
          body: "@wingetbot run",
          createdAt: "2026-11-22T00:00:00Z",
        },
      ],
    });

    const items = extractReviewFeedbackItems({
      prAuthorLogin: pr.author?.login,
      reviews: pr.reviews,
      comments: pr.comments,
    });

    expect(items.map((i) => i.source)).toEqual([
      "review",
      "review_comment",
      "issue_comment",
      "issue_comment",
    ]);
    expect(items[1].path).toContain("locale.en-US.yaml");
    expect(items[2].body).toContain("ReleaseNotesUrl");
    expect(items[3].author).toBe("taras-janea");
    expect(items[3].authorAssociation).toBe("NONE");
    expect(items[3].hasImage).toBe(true);
  });

  test("extractAuthorReplies は CLA 同意を除外し、作成者の修正説明コメントのみ抽出する", () => {
    const pr = makeBasePr();
    const replies = extractAuthorReplies({
      prAuthorLogin: pr.author?.login,
      comments: pr.comments,
    });
    expect(replies).toHaveLength(1);
    expect(replies[0].author).toBe("okzea");
    expect(replies[0].body).toContain("VCRUNTIME140.dll");
  });

  test("selectInstallerManifestPaths と parseInstallerManifestMetadata はポータブル・ネスト種別を抽出する", () => {
    const paths = selectInstallerManifestPaths([
      "manifests/a/App/1.0/a.App.yaml",
      "manifests/a/App/1.0/a.App.locale.en-US.yaml",
      "manifests/a/App/1.0/a.App.installer.yaml",
    ]);
    expect(paths).toEqual(["manifests/a/App/1.0/a.App.installer.yaml"]);

    const singletonPaths = selectInstallerManifestPaths([
      "manifests/a/App/1.0/a.App.yaml",
      "manifests/a/App/1.0/a.App.locale.en-US.yaml",
    ]);
    expect(singletonPaths).toEqual(["manifests/a/App/1.0/a.App.yaml"]);

    const meta = parseInstallerManifestMetadata([
      {
        path: "manifests/a/App/1.0/a.App.installer.yaml",
        text: [
          "# comment",
          "PackageIdentifier: a.App",
          "InstallerType: zip # inline comment",
          'NestedInstallerType: "portable"',
          "Installers:",
          "  - Architecture: x64",
          "    Scope: user",
          "ManifestVersion: 1.28.0",
        ].join("\n"),
      },
    ]);

    expect(meta).toEqual({
      files: ["manifests/a/App/1.0/a.App.installer.yaml"],
      installerTypes: ["zip"],
      nestedInstallerTypes: ["portable"],
      architectures: ["x64"],
      scopes: ["user"],
      manifestVersion: "1.28.0",
      isPortable: true,
    });
  });

  test.each([
    {
      name: "DLL / ランタイム欠損",
      body: "App fails because VCRUNTIME140.dll is missing on clean Windows.",
      expected: ["dll-runtime"],
    },
    {
      name: "起動・コマンド動作不良",
      body: "PortableCommandAlias crashes with non-zero exit code on launch.",
      expected: ["launch-command"],
    },
    {
      name: "メタデータ・URL 不備",
      body: "PrivacyUrl returns 404 and ReleaseNotesUrl has broken link.",
      expected: ["metadata-url"],
    },
    {
      name: "マニフェスト構造・インストーラー種別",
      body: "Please set NestedInstallerType and UpgradeBehavior for this InstallerType.",
      expected: ["manifest-installer"],
    },
    {
      name: "セキュリティ / 署名 / SmartScreen",
      body: "Flagged by SmartScreen and VirusTotal because binary is unsigned.",
      expected: ["security-signing"],
    },
    {
      name: "未分類（その他）",
      body: "Please follow the community naming convention for package description.",
      expected: ["uncategorized"],
    },
  ])("categorizeFeedback: $name", ({ body, expected }) => {
    const result = categorizeFeedback({
      feedbackItems: [
        {
          source: "issue_comment",
          author: "reviewer",
          authorAssociation: "COLLABORATOR",
          createdAt: "2026-11-24T00:00:00Z",
          body,
          hasImage: false,
        },
      ],
    });
    expect(result.categories).toEqual([...expected]);
  });

  test("buildReviewFeedbackEntry は #445661 相当データからマルチタグ分類レコードを生成する", () => {
    const pr = makeBasePr();
    const installer = parseInstallerManifestMetadata([
      {
        path: "manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.installer.yaml",
        text: "InstallerType: portable\nManifestVersion: 1.28.0\n",
      },
    ]);

    const entry = buildReviewFeedbackEntry({
      pr,
      installer,
      isFirstTimeAuthor: true,
      authorMergedCount: 1,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });

    expect(entry.entryType).toBe("feedback");
    if (entry.entryType !== "feedback") return;
    expect(entry.categories).toEqual(["dll-runtime", "launch-command", "security-signing"]);
    expect(entry.installer.isPortable).toBe(true);
    expect(entry.isFirstTimeAuthor).toBe(true);
    expect(entry.feedbackItems).toHaveLength(1);
    expect(entry.authorReplies).toHaveLength(1);
  });

  test("buildReviewFeedbackEntry は条件未達 PR を理由付き no-feedback に分類する", () => {
    const emptyInstaller = parseInstallerManifestMetadata([]);

    const nonNewPkg = buildReviewFeedbackEntry({
      pr: makeBasePr({ title: "New version: Foo.Bar 2.0" }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(nonNewPkg.entryType).toBe("no-feedback");
    if (nonNewPkg.entryType === "no-feedback") {
      expect(nonNewPkg.skipReason).toBe("not-new-package-title");
    }

    const noTrigger = buildReviewFeedbackEntry({
      pr: makeBasePr({ labeledEvents: [], currentLabels: ["New-Package"], reviews: [] }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(noTrigger.entryType).toBe("no-feedback");
    if (noTrigger.entryType === "no-feedback") {
      expect(noTrigger.skipReason).toBe("no-rejection-trigger");
    }

    const autoOnly = buildReviewFeedbackEntry({
      pr: makeBasePr({
        comments: [
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            body: "Deprecated.\n(Deterministic automation - build 1830.)",
            createdAt: "2026-10-30T08:39:13Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(autoOnly.entryType).toBe("no-feedback");
    if (autoOnly.entryType === "no-feedback") {
      expect(autoOnly.skipReason).toBe("no-human-feedback");
    }
  });

  test("filterReviewFeedbackRecords は portableOnly / installerTypes / privilegedOnly / firstTimerOnly を正しく適用する", () => {
    const entry1 = buildReviewFeedbackEntry({
      pr: makeBasePr(),
      installer: parseInstallerManifestMetadata([
        { path: "a.installer.yaml", text: "InstallerType: zip\nNestedInstallerType: portable\n" },
      ]),
      isFirstTimeAuthor: true,
      collectedAt: "2026-11-27T00:00:00.000Z",
    }) as ReviewFeedbackRecord;

    const entry2 = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 445662,
        comments: [
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            body: "PrivacyUrl returns 404",
            createdAt: "2026-11-24T10:00:00Z",
          },
        ],
      }),
      installer: parseInstallerManifestMetadata([
        { path: "b.installer.yaml", text: "InstallerType: inno\n" },
      ]),
      isFirstTimeAuthor: false,
      collectedAt: "2026-11-27T00:00:00.000Z",
    }) as ReviewFeedbackRecord;

    expect(filterReviewFeedbackRecords([entry1, entry2], { portableOnly: true })).toHaveLength(1);
    expect(
      filterReviewFeedbackRecords([entry1, entry2], {
        installerTypes: ["zip"],
        nestedInstallerTypes: ["portable"],
      }).map((r) => r.number),
    ).toEqual([445661]);
    expect(
      filterReviewFeedbackRecords([entry1, entry2], { privilegedOnly: true }).map((r) => r.number),
    ).toEqual([445662]);
    expect(
      filterReviewFeedbackRecords([entry1, entry2], { firstTimerOnly: true }).map((r) => r.number),
    ).toEqual([445661]);
  });

  test("JSONL パース・直列化・複合キー分離・キャッシュ再利用判定・異常系エラー", () => {
    const entry = buildReviewFeedbackEntry({
      pr: makeBasePr(),
      installer: parseInstallerManifestMetadata([]),
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    const openEntry: ReviewFeedbackCorpusEntry = {
      ...entry,
      number: 445699,
      state: "OPEN",
      mergedAt: null,
      closedAt: null,
    };

    const jsonl = serializeReviewFeedbackCorpus([entry, openEntry, entry]);
    const parsed = parseReviewFeedbackCorpus(jsonl);
    expect(parsed.map((e) => e.number)).toEqual([445699, 445661]);
    expect(indexReviewFeedbackCorpus(parsed).size).toBe(2);

    // 異なるリポジトリの同番号 PR (#7) は上書きせず両方保持されること
    const repoAEntry = buildReviewFeedbackEntry({
      pr: makeBasePr({ repository: "owner-a/repo-a", number: 7 }),
      installer: parseInstallerManifestMetadata([]),
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    const repoBEntry = buildReviewFeedbackEntry({
      pr: makeBasePr({ repository: "owner-b/repo-b", number: 7 }),
      installer: parseInstallerManifestMetadata([]),
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    const multiRepoParsed = parseReviewFeedbackCorpus(
      serializeReviewFeedbackCorpus([repoAEntry, repoBEntry]),
    );
    expect(multiRepoParsed).toHaveLength(2);
    expect(multiRepoParsed.map((e) => e.repository)).toEqual(["owner-a/repo-a", "owner-b/repo-b"]);
    expect(indexReviewFeedbackCorpus(multiRepoParsed).size).toBe(2);

    expect(canReuseCachedFeedbackEntry(entry)).toBe(true);
    expect(canReuseCachedFeedbackEntry(openEntry)).toBe(false);
    // 状態変化（CLOSED -> OPEN 再オープン）や updatedAt の進行があればキャッシュを再利用しない
    const closedEntry: ReviewFeedbackCorpusEntry = {
      ...entry,
      state: "CLOSED",
      mergedAt: null,
      updatedAt: "2026-11-20T00:00:00Z",
    };
    expect(
      canReuseCachedFeedbackEntry(closedEntry, {
        currentState: "CLOSED",
        currentUpdatedAt: "2026-11-20T00:00:00Z",
      }),
    ).toBe(true);
    expect(
      canReuseCachedFeedbackEntry(closedEntry, {
        currentState: "OPEN",
        currentUpdatedAt: "2026-11-20T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      canReuseCachedFeedbackEntry(closedEntry, {
        currentState: "CLOSED",
        currentUpdatedAt: "2026-11-21T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      canReuseCachedFeedbackEntry({
        ...entry,
        schemaVersion: CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION - 1,
      }),
    ).toBe(false);

    expect(() => parseReviewFeedbackCorpus("{broken json")).toThrow("不正な JSON");
    expect(() => parseReviewFeedbackCorpus('{"foo":"bar"}\n')).toThrow("必須フィールド");
    expect(() =>
      parseReviewFeedbackCorpus(
        '{"entryType":"feedback","repository":"microsoft/winget-pkgs","number":1,"schemaVersion":1}\n',
      ),
    ).toThrow("feedbackItems / installer");
  });

  test("summarizeReviewFeedback と formatReviewFeedbackMarkdown はランキングと抜粋を出力する", () => {
    const rec = buildReviewFeedbackEntry({
      pr: makeBasePr(),
      installer: parseInstallerManifestMetadata([
        { path: "a.installer.yaml", text: "InstallerType: portable\n" },
      ]),
      isFirstTimeAuthor: true,
      collectedAt: "2026-11-27T00:00:00.000Z",
    }) as ReviewFeedbackRecord;

    const summary = summarizeReviewFeedback({
      repository: "microsoft/winget-pkgs",
      records: [rec],
      generatedAt: "2026-11-27T06:00:00.000Z",
    });

    expect(summary.totalFeedbackPrs).toBe(1);
    expect(summary.portablePrCount).toBe(1);
    expect(summary.firstTimeAuthorPrCount).toBe(1);
    expect(summary.categoryRanking[summary.categoryRanking.length - 1].category).toBe(
      "uncategorized",
    );

    const md = formatReviewFeedbackMarkdown({ summary, records: [rec] });
    expect(md).toContain("# microsoft/winget-pkgs 初回提出 PR メンテナ差し戻し指摘レポート");
    expect(md).toContain("DLL / ランタイム欠損");
    expect(md).toContain("#445661");
    expect(md).toContain("VCRUNTIME140.dll");
    expect(md).toContain("[画像添付あり]");
  });
});
