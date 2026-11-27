import { describe, expect, test } from "bun:test";
import {
  buildFeedbackSearchQueryParts,
  buildReviewFeedbackEntry,
  CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION,
  canReuseCachedFeedbackEntry,
  categorizeFeedback,
  classifyFeedbackCommentSeverity,
  detectFeedbackTriggers,
  extractAuthorReplies,
  extractReviewFeedbackItems,
  filterReviewFeedbackRecords,
  hasEmbeddedImage,
  indexReviewFeedbackCorpus,
  isAuthorNoiseComment,
  isAutomaticValidationNoiseComment,
  isFalsePositiveNoteOnlyComment,
  isFeedbackNoiseComment,
  isNewPackageTitle,
  isPolicyCommandOnlyComment,
  isStaleCloseCommandOnlyComment,
  isVerifyMemoOnlyComment,
  isWingetbotCommandOnlyComment,
  parseInstallerManifestMetadata,
  parseReviewFeedbackCorpus,
  type RawPrFeedbackInput,
  reclassifyReviewFeedbackCorpus,
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
    ["bump", true],
    ["bump!", true],
    ["I have read the CLA Document and I hereby sign the CLA.", true],
    ["> Contributor\n@microsoft-github-policy-service agree", true],
    [
      "The current `license/cla` check reports that all CLA requirements are met. Please reconcile the stale `Needs-CLA` label. @microsoft-github-policy-service agree",
      true,
    ],
    ["@wingetbot run", true],
    ["[Policy] Needs-Author-Feedback", true],
    ["Fixed VCRUNTIME140.dll by static linking", false],
    ["> Quoted feedback\nFixed by adding PrivacyUrl.", false],
    ["", true],
  ])("isAuthorNoiseComment(%j) => %s", (body, expected) => {
    expect(isAuthorNoiseComment(body)).toBe(expected);
  });

  test.each([
    ["@wingetbot waivers Add Validation-Domain", true],
    ["@wingetbot waivers add Policy-Test-1.2", true],
    ["@wingetbot run - inconsistent label state", true],
    ["@wingetbot installationmetadata exe add bws.exe --version", true],
    ["@wingetbot waivers Add Policy-Test-1.2\nPlease also fix PrivacyUrl.", false],
    ["Please add a privacy policy.", false],
  ])("isWingetbotCommandOnlyComment(%j) => %s", (body, expected) => {
    expect(isWingetbotCommandOnlyComment(body)).toBe(expected);
  });

  test.each([
    ['Verify: <img width="900" src="https://example.com/a.png" />', true],
    [
      'Verify: <img src="https://example.com/a.png" />\nPrivacy Policy: https://example.com/privacy',
      true,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nEdit: Privacy Poilcy: https://example.com/privacy',
      true,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nInternet Translation: <img src="https://example.com/b.png" />',
      true,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nIn-App Purchase: Processed by Lemon Squeezy, a Stripe company.\nPrivacy Policy: https://example.com/privacy',
      true,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nIn-App Purchase: Processed by Stripe. The checkout page never loads.',
      false,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nIn-App Purchase: Does this app require a subscription to start?',
      false,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nIn-App Purchase: Processor is Buy Me a Coffee, but link 404s:',
      false,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nPrivacy Policy baked into application.\nEdit: Registry: <img src="https://example.com/b.png" />',
      true,
    ],
    [
      '<img src="https://example.com/a.png" /> Internet Translation: <img src="https://example.com/b.png" />',
      true,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nHi @author, This package seems like it sends data off of the user\'s device. Does it have a privacy policy?',
      false,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nIt appears that the shortcut and Registry data are in Turkish.',
      false,
    ],
    [
      'Verify: <img src="https://example.com/a.png" />\nInternet Translation: <img src="https://example.com/b.png" />\nShould `Microsoft.Office` be a dependency?',
      false,
    ],
    [
      'Verify <img src="https://example.com/a.png" /> The application spawned off of the VM screen.',
      false,
    ],
  ])("isVerifyMemoOnlyComment(%j) => %s", (body, expected) => {
    expect(isVerifyMemoOnlyComment(body)).toBe(expected);
  });

  test.each([
    ["Close with reason: Stale;", true],
    ["Close with reason: Stale", true],
    ["Close with reason: Policy violation; scripted application is not allowed.", false],
  ])("isStaleCloseCommandOnlyComment(%j) => %s", (body, expected) => {
    expect(isStaleCloseCommandOnlyComment(body)).toBe(expected);
  });

  test.each([
    ["`Adult Reference or Theme` - False Positive match with explicit in Description.", true],
    ["`Adult Reference or Theme` - Please remove offensive wording.", false],
  ])("isFalsePositiveNoteOnlyComment(%j) => %s", (body, expected) => {
    expect(isFalsePositiveNoteOnlyComment(body)).toBe(expected);
  });

  test.each([
    [
      "Automatic Validation ended with:\n> [Policy-Test-2.7](https://example.com) `Algo Speak - Potential adult content` (Deterministic automation)",
      true,
    ],
    [
      "Automatic Validation ended with:\n> [Policy-Test-2.7](https://example.com) `Algo Speak - Potential adult content` (Deterministic automation)\n\nPlease fix the installer URL. It returns HTTP 404.",
      false,
    ],
    [
      "Automatic Validation ended with:\n> [Policy-Test-2.7](https://example.com) `Algo Speak - Potential adult content` (Deterministic automation)\n> Please fix the installer URL.",
      false,
    ],
    [
      "Automatic Validation ended with:\nEdit: My automation isn't getting a valid output from the pipeline artifacts.",
      true,
    ],
    [
      "Automatic Validation ended with:\nMy automation isn't getting a valid output from the pipeline artifacts. Please fix the installer URL. It returns HTTP 404.",
      false,
    ],
    [
      "Automatic Validation ended with:\n> Executable wave.exe returned exit code: -1073741515 | C0000135 | STATUS_DLL_NOT_FOUND",
      false,
    ],
    [
      "Automatic Validation ended with:\n> Specified hash doesn't match. Actual hash: 'AAA' Expected hash: 'BBB'",
      false,
    ],
    ["Automatic Validation ended with:\n> Installation didn't complete within the timeout", false],
  ])("isAutomaticValidationNoiseComment(%j) => %s", (body, expected) => {
    expect(isAutomaticValidationNoiseComment(body)).toBe(expected);
  });

  test("classifyFeedbackCommentSeverity は非ブロッキング助言とブロッキング差し戻しを区別する", () => {
    expect(
      classifyFeedbackCommentSeverity(
        "Thanks for contributing! No blockers have been found for this PR. One optional note: binary is unsigned.",
      ),
    ).toBe("non-blocking");
    expect(
      classifyFeedbackCommentSeverity(
        "Required: On a clean Windows machine, the app fails to start.",
      ),
    ).toBe("blocking");
    expect(isFeedbackNoiseComment("@wingetbot waivers Add Policy-Test-1.2")).toBe(true);
    expect(isFeedbackNoiseComment("Required: add PrivacyUrl.")).toBe(false);
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
      name: "プライバシーポリシー・データ開示",
      body: "This package sends data off of the user's device. Does it have a privacy policy / PrivacyUrl?",
      expected: ["privacy-policy"],
    },
    {
      name: "DLL / ランタイム欠損",
      body: "App fails because VCRUNTIME140.dll is missing on clean Windows (STATUS_DLL_NOT_FOUND).",
      expected: ["dll-runtime"],
    },
    {
      name: "起動・コマンド・VM 動作不良",
      body: "PortableCommandAlias crashes with non-zero exit code on launch due to OpenGL 1.1.",
      expected: ["launch-command"],
    },
    {
      name: "メタデータ・URL・ライセンス不備",
      body: "ReleaseNotesUrl returns 404 and LicenseUrl has broken link.",
      expected: ["metadata-url"],
    },
    {
      name: "マニフェスト構造・インストーラー・ARP 整合",
      body: "Please set NestedInstallerType, UpgradeBehavior, and match ARP DisplayVersion in registry.",
      expected: ["manifest-installer"],
    },
    {
      name: "UI 言語・Locale 不一致",
      body: "The app interface is in Chinese while manifest declares en-US; set PackageLocale: zh-CN.",
      expected: ["locale-language"],
    },
    {
      name: "セキュリティ / 署名 / ポリシー制約",
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
    // OPEN でも現在状態・更新日時が双方一致（未更新）なら再利用可、更新が進めば再取得
    expect(
      canReuseCachedFeedbackEntry(openEntry, {
        currentState: "OPEN",
        currentUpdatedAt: openEntry.updatedAt,
      }),
    ).toBe(true);
    expect(
      canReuseCachedFeedbackEntry(openEntry, {
        currentState: "OPEN",
        currentUpdatedAt: "2026-11-27T00:00:00Z",
      }),
    ).toBe(false);
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
    expect(md).toContain("ブロッキング差し戻しあり **1 件** / 非ブロッキング助言のみ **0 件**");
    expect(md).toContain("DLL / ランタイム欠損");
    expect(md).toContain("#445661");
    expect(md).toContain("VCRUNTIME140.dll");
    expect(md).toContain("[画像添付あり]");
  });

  test("CLOSED 直接却下トリガー・noise-only-feedback・blockingOnly・オフライン再分類が正しく動作する", () => {
    const emptyInstaller = parseInstallerManifestMetadata([]);

    // 1. CLOSED PR で Needs-Author-Feedback なしでも Scripted-Application + COLLABORATOR コメントで捕捉
    const closedRejected = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 436234,
        state: "CLOSED",
        mergedAt: null,
        closedAt: "2026-11-10T00:00:00Z",
        currentLabels: ["New-Package", "Scripted-Application"],
        labeledEvents: [{ label: "Scripted-Application", createdAt: "2026-11-09T00:00:00Z" }],
        comments: [
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            body: "Unfortunately, we're not currently accepting scripted applications.",
            createdAt: "2026-11-09T01:00:00Z",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            body: "Close with reason: Stale;",
            createdAt: "2026-11-10T00:00:00Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(closedRejected.entryType).toBe("feedback");
    if (closedRejected.entryType === "feedback") {
      expect(closedRejected.triggers).toEqual([
        "closed-rejection-label",
        "closed-maintainer-feedback",
      ]);
      expect(closedRejected.feedbackItems).toHaveLength(1);
      expect(closedRejected.categories).toEqual(["security-signing"]);
      expect(closedRejected.hasBlockingFeedback).toBe(true);
    }

    // 2. Verify スクショ単体 + waivers 単体のみの PR は noise-only-feedback として除外される
    const noiseOnly = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 448826,
        comments: [
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            body: 'Verify: <img src="https://example.com/x.png" /> Privacy Policy: https://example.com/privacy',
            createdAt: "2026-11-24T00:00:00Z",
          },
          {
            author: { __typename: "User", login: "stephengillie" },
            authorAssociation: "COLLABORATOR",
            body: "@wingetbot waivers Add Validation-Domain",
            createdAt: "2026-11-24T01:00:00Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(noiseOnly.entryType).toBe("no-feedback");
    if (noiseOnly.entryType === "no-feedback") {
      expect(noiseOnly.skipReason).toBe("noise-only-feedback");
    }

    // 3. 非ブロッキング助言のみのレコードに対する blockingOnly フィルタとサマリー集計
    const nonBlockingEntry = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 446301,
        comments: [
          {
            author: { __typename: "User", login: "taras-janea" },
            authorAssociation: "NONE",
            body: "Thanks for contributing. No blockers have been found for this PR. Optional note: binary is unsigned.",
            createdAt: "2026-11-24T00:00:00Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    }) as ReviewFeedbackRecord;
    expect(nonBlockingEntry.hasBlockingFeedback).toBe(false);
    expect(filterReviewFeedbackRecords([nonBlockingEntry], { blockingOnly: true })).toHaveLength(0);
    const nbSummary = summarizeReviewFeedback({
      repository: "microsoft/winget-pkgs",
      records: [nonBlockingEntry],
      generatedAt: "2026-11-27T06:00:00.000Z",
    });
    expect(nbSummary.blockingPrCount).toBe(0);
    expect(nbSummary.nonBlockingOnlyPrCount).toBe(1);
    expect(
      formatReviewFeedbackMarkdown({ summary: nbSummary, records: [nonBlockingEntry] }),
    ).toContain("[非ブロッキング助言]");

    // 4. オフライン再分類（reclassifyReviewFeedbackCorpus）の v1 → v2 移行安全性
    const v1NoiseFeedback: ReviewFeedbackRecord = {
      ...(nonBlockingEntry as ReviewFeedbackRecord),
      schemaVersion: 1,
      number: 900001,
      feedbackItems: [
        {
          source: "issue_comment",
          author: "stephengillie",
          authorAssociation: "COLLABORATOR",
          createdAt: "2026-11-20T00:00:00Z",
          body: 'Verify: <img src="https://example.com/a.png" />',
          hasImage: true,
        },
      ],
      authorReplies: [
        {
          author: "dev",
          createdAt: "2026-11-21T00:00:00Z",
          body: "bump",
        },
      ],
      categories: ["uncategorized"],
      categoryMatches: [{ category: "uncategorized", matchedKeywords: [] }],
    };
    const v1MixedFeedback: ReviewFeedbackRecord = {
      ...(nonBlockingEntry as ReviewFeedbackRecord),
      schemaVersion: 1,
      number: 900002,
      feedbackItems: [
        {
          source: "issue_comment",
          author: "stephengillie",
          authorAssociation: "COLLABORATOR",
          createdAt: "2026-11-20T00:00:00Z",
          body: "@wingetbot waivers Add Policy-Test-1.2",
          hasImage: false,
        },
        {
          source: "issue_comment",
          author: "denelon",
          authorAssociation: "COLLABORATOR",
          createdAt: "2026-11-21T00:00:00Z",
          body: "Please add a privacy policy / PrivacyUrl.",
          hasImage: false,
        },
      ],
      authorReplies: [
        {
          author: "dev",
          createdAt: "2026-11-21T01:00:00Z",
          body: "bump",
        },
        {
          author: "dev",
          createdAt: "2026-11-21T02:00:00Z",
          body: "Added PrivacyUrl in commit abc.",
        },
      ],
      categories: ["metadata-url"],
      categoryMatches: [{ category: "metadata-url", matchedKeywords: ["PrivacyUrl"] }],
    };
    const v1MergedSkip: ReviewFeedbackCorpusEntry = {
      schemaVersion: 1,
      entryType: "no-feedback",
      repository: "microsoft/winget-pkgs",
      number: 900003,
      title: "New package: Clean.Merged 1.0",
      state: "MERGED",
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-02T00:00:00Z",
      mergedAt: "2026-11-02T00:00:00Z",
      closedAt: "2026-11-02T00:00:00Z",
      skipReason: "no-rejection-trigger",
      collectedAt: "2026-11-27T00:00:00Z",
    };
    const v1ClosedSkip: ReviewFeedbackCorpusEntry = {
      ...v1MergedSkip,
      number: 900004,
      title: "New package: Rejected.Closed 1.0",
      state: "CLOSED",
      mergedAt: null,
    };
    const v1ClosedFeedback: ReviewFeedbackRecord = {
      ...(nonBlockingEntry as ReviewFeedbackRecord),
      schemaVersion: 1,
      number: 900005,
      state: "CLOSED",
      mergedAt: null,
      closedAt: "2026-11-24T00:00:00Z",
      triggers: ["needs-author-feedback-label"],
      currentLabels: ["New-Package", "Scripted-Application"],
      historicalFeedbackLabels: ["Needs-Author-Feedback"],
      feedbackItems: [
        {
          source: "issue_comment",
          author: "stephengillie",
          authorAssociation: "COLLABORATOR",
          createdAt: "2026-11-23T00:00:00Z",
          body: "Unfortunately, we're not currently accepting scripted applications.",
          hasImage: false,
        },
      ],
      authorReplies: [],
      categories: ["uncategorized"],
      categoryMatches: [{ category: "uncategorized", matchedKeywords: [] }],
    };

    const reclassified = reclassifyReviewFeedbackCorpus([
      v1NoiseFeedback,
      v1MixedFeedback,
      v1MergedSkip,
      v1ClosedSkip,
      v1ClosedFeedback,
    ]);

    expect(reclassified.stats).toEqual({
      totalProcessed: 5,
      reclassifiedFeedbackCount: 2,
      demotedToNoiseOnlyCount: 1,
      upgradedMergedSkippedCount: 1,
      keptLegacySkippedCount: 1,
      keptLegacyFeedbackCount: 1,
      removedFeedbackCommentsCount: 2,
      removedAuthorRepliesCount: 2,
    });

    const byNum = new Map(reclassified.entries.map((e) => [e.number, e]));
    const e1 = byNum.get(900001);
    expect(e1?.entryType).toBe("no-feedback");
    if (e1?.entryType === "no-feedback") {
      expect(e1.skipReason).toBe("noise-only-feedback");
      expect(e1.schemaVersion).toBe(CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION);
    }

    const e2 = byNum.get(900002);
    expect(e2?.entryType).toBe("feedback");
    if (e2?.entryType === "feedback") {
      expect(e2.schemaVersion).toBe(CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION);
      expect(e2.feedbackItems).toHaveLength(1);
      expect(e2.authorReplies).toHaveLength(1);
      expect(e2.categories).toEqual(["privacy-policy"]);
      expect(e2.hasBlockingFeedback).toBe(true);
    }

    // MERGED スキップは v2 へ安全昇格、CLOSED 旧スキップ・旧 feedback は履歴補完・再取得のため v1 維持
    expect(byNum.get(900003)?.schemaVersion).toBe(CURRENT_REVIEW_FEEDBACK_SCHEMA_VERSION);
    expect(byNum.get(900004)?.schemaVersion).toBe(1);
    const e5 = byNum.get(900005);
    expect(e5?.entryType).toBe("feedback");
    if (e5?.entryType === "feedback") {
      expect(e5.schemaVersion).toBe(1);
      expect(e5.triggers).toEqual([
        "needs-author-feedback-label",
        "closed-rejection-label",
        "closed-maintainer-feedback",
      ]);
      expect(e5.historicalFeedbackLabels).toEqual([
        "Needs-Author-Feedback",
        "Scripted-Application",
      ]);
      expect(
        canReuseCachedFeedbackEntry(e5, {
          currentState: "CLOSED",
          currentUpdatedAt: e5.updatedAt,
        }),
      ).toBe(false);
    }

    // 5. CLOSED で却下ラベル・変更要求なし＋挨拶または非ブロッキング助言のみのメンテナコメントは直接却下にしない
    const closedThanksOnly = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 900006,
        state: "CLOSED",
        mergedAt: null,
        closedAt: "2026-11-24T00:00:00Z",
        currentLabels: ["New-Package"],
        labeledEvents: [{ label: "New-Package", createdAt: "2026-11-01T00:00:00Z" }],
        comments: [
          {
            author: { __typename: "User", login: "denelon" },
            authorAssociation: "COLLABORATOR",
            body: "Thanks for your contribution!",
            createdAt: "2026-11-20T00:00:00Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(closedThanksOnly.entryType).toBe("no-feedback");
    if (closedThanksOnly.entryType === "no-feedback") {
      expect(closedThanksOnly.skipReason).toBe("no-rejection-trigger");
    }

    const closedAdviceOnly = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 900007,
        state: "CLOSED",
        mergedAt: null,
        closedAt: "2026-11-24T00:00:00Z",
        currentLabels: ["New-Package"],
        labeledEvents: [{ label: "New-Package", createdAt: "2026-11-01T00:00:00Z" }],
        comments: [
          {
            author: { __typename: "User", login: "denelon" },
            authorAssociation: "COLLABORATOR",
            body: "Thanks for contributing. No blockers have been found for this PR. Optional note: binary is unsigned.",
            createdAt: "2026-11-20T00:00:00Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(closedAdviceOnly.entryType).toBe("no-feedback");
    if (closedAdviceOnly.entryType === "no-feedback") {
      expect(closedAdviceOnly.skipReason).toBe("no-rejection-trigger");
    }

    const closedNoBlockingIssues = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 900008,
        state: "CLOSED",
        mergedAt: null,
        closedAt: "2026-11-24T00:00:00Z",
        currentLabels: ["New-Package"],
        labeledEvents: [{ label: "New-Package", createdAt: "2026-11-01T00:00:00Z" }],
        comments: [
          {
            author: { __typename: "User", login: "denelon" },
            authorAssociation: "COLLABORATOR",
            body: "Thanks for your contribution. No blocking issues were found.",
            createdAt: "2026-11-20T00:00:00Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    });
    expect(closedNoBlockingIssues.entryType).toBe("no-feedback");
    if (closedNoBlockingIssues.entryType === "no-feedback") {
      expect(closedNoBlockingIssues.skipReason).toBe("no-rejection-trigger");
    }

    // 否定文（No blocking issues were found.）が Needs-Author-Feedback 経由で記録された場合も --blocking-only から除外される
    const closedNoBlockingWithLabel = buildReviewFeedbackEntry({
      pr: makeBasePr({
        number: 900009,
        state: "CLOSED",
        mergedAt: null,
        closedAt: "2026-11-24T00:00:00Z",
        currentLabels: ["New-Package"],
        labeledEvents: [{ label: "Needs-Author-Feedback", createdAt: "2026-11-01T00:00:00Z" }],
        comments: [
          {
            author: { __typename: "User", login: "denelon" },
            authorAssociation: "COLLABORATOR",
            body: "Thanks for your contribution. No blocking issues were found.",
            createdAt: "2026-11-20T00:00:00Z",
          },
        ],
      }),
      installer: emptyInstaller,
      collectedAt: "2026-11-27T00:00:00.000Z",
    }) as ReviewFeedbackRecord;
    expect(closedNoBlockingWithLabel.hasBlockingFeedback).toBe(false);
    expect(
      filterReviewFeedbackRecords([closedNoBlockingWithLabel], { blockingOnly: true }),
    ).toHaveLength(0);
  });
});
