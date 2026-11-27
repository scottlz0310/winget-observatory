import { describe, expect, test } from "bun:test";
import {
  buildInstallerBlobBatchQuery,
  buildPullRequestFeedbackBatchQuery,
  fetchInstallerManifestBlobs,
  fetchPullRequestFeedbackDetails,
} from "../../src/api/feedback-queries";

const VALID_OID = "74eefe96691ffdc4542ca541be5c25c1fce43e6a";

describe("feedback-queries (GraphQL)", () => {
  test("buildPullRequestFeedbackBatchQuery は複数 PR の alias クエリを構築し不正番号を拒否する", () => {
    const query = buildPullRequestFeedbackBatchQuery([445661, 445659]);
    expect(query).toContain("pr0: pullRequest(number: 445661)");
    expect(query).toContain("pr1: pullRequest(number: 445659)");
    expect(query).toContain("authorAssociation");
    expect(query).toContain("timelineItems(first: 50, itemTypes: [LABELED_EVENT])");
    expect(buildPullRequestFeedbackBatchQuery([])).toBe("");
    expect(() => buildPullRequestFeedbackBatchQuery([0])).toThrow("PR 番号が不正");
    expect(() => buildPullRequestFeedbackBatchQuery([-5])).toThrow("PR 番号が不正");
  });

  test("buildInstallerBlobBatchQuery は SHA/パスを検証し安全にクエリを構築する", () => {
    const query = buildInstallerBlobBatchQuery([
      {
        key: "445661:manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.installer.yaml",
        oid: VALID_OID,
        path: "manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.installer.yaml",
      },
    ]);
    expect(query).toContain(
      `b0: object(expression: "${VALID_OID}:manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.installer.yaml")`,
    );
    expect(buildInstallerBlobBatchQuery([])).toBe("");
    expect(() =>
      buildInstallerBlobBatchQuery([{ key: "k", oid: "not-a-sha", path: "a.yaml" }]),
    ).toThrow("コミット OID");
    expect(() =>
      buildInstallerBlobBatchQuery([{ key: "k", oid: VALID_OID, path: "bad\npath.yaml" }]),
    ).toThrow("ファイルパス");
  });

  test("fetchPullRequestFeedbackDetails はバッチ取得と reviews / review.comments / comments / timeline / files の追加ページングを結合する", async () => {
    const calledQueries: string[] = [];
    const mockGraphql = async <T = unknown>(
      query: string,
      variables?: Record<string, unknown>,
    ): Promise<T> => {
      calledQueries.push(query);

      if (query.includes("GetPullRequestFeedbackBatch")) {
        return {
          repository: {
            pr0: {
              number: 445661,
              title: "New package: okzea.WindowRescue version 0.1.3",
              url: "https://github.com/microsoft/winget-pkgs/pull/445661",
              state: "MERGED",
              createdAt: "2026-10-02T12:31:18Z",
              updatedAt: "2026-11-26T23:42:59Z",
              mergedAt: "2026-11-26T21:50:19Z",
              closedAt: "2026-11-26T21:50:19Z",
              mergeCommit: { oid: VALID_OID },
              headRefOid: "6692c508e8b99b6cb329181433800b447f0aadc2",
              author: { __typename: "User", login: "okzea" },
              authorAssociation: "CONTRIBUTOR",
              commits: { totalCount: 3 },
              labels: { nodes: [{ name: "New-Package" }] },
              files: {
                pageInfo: { hasNextPage: true, endCursor: "f-cur-1" },
                nodes: [{ path: "manifests/o/okzea/WindowRescue/0.1.3/a.yaml" }],
              },
              reviews: {
                pageInfo: { hasNextPage: true, endCursor: "r-cur-1" },
                nodes: [
                  {
                    id: "PRR_1",
                    author: { __typename: "User", login: "mod1" },
                    authorAssociation: "COLLABORATOR",
                    state: "CHANGES_REQUESTED",
                    body: "First review",
                    submittedAt: "2026-11-20T00:00:00Z",
                    comments: {
                      pageInfo: { hasNextPage: true, endCursor: "rc-cur-1" },
                      nodes: [
                        {
                          author: { __typename: "User", login: "mod1" },
                          authorAssociation: "COLLABORATOR",
                          path: "a.yaml",
                          body: "inline 1",
                          createdAt: "2026-11-20T00:00:01Z",
                        },
                      ],
                    },
                  },
                ],
              },
              comments: {
                pageInfo: { hasNextPage: true, endCursor: "c-cur-1" },
                nodes: [
                  {
                    author: { __typename: "User", login: "taras-janea" },
                    authorAssociation: "NONE",
                    body: "comment 1",
                    createdAt: "2026-11-24T00:00:00Z",
                  },
                ],
              },
              timelineItems: {
                pageInfo: { hasNextPage: true, endCursor: "t-cur-1" },
                nodes: [
                  {
                    __typename: "LabeledEvent",
                    createdAt: "2026-10-02T12:36:32Z",
                    label: { name: "New-Package" },
                  },
                ],
              },
            },
          },
        } as T;
      }

      if (query.includes("GetFeedbackReviewsPage")) {
        expect(variables?.after).toBe("r-cur-1");
        return {
          repository: {
            pullRequest: {
              reviews: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "PRR_2",
                    author: { __typename: "User", login: "mod2" },
                    authorAssociation: "MEMBER",
                    state: "COMMENTED",
                    body: "Second review",
                    submittedAt: "2026-11-21T00:00:00Z",
                    comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                  },
                ],
              },
            },
          },
        } as T;
      }

      if (query.includes("GetFeedbackReviewCommentsPage")) {
        expect(variables?.reviewId).toBe("PRR_1");
        expect(variables?.after).toBe("rc-cur-1");
        return {
          node: {
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  author: { __typename: "User", login: "mod1" },
                  authorAssociation: "COLLABORATOR",
                  path: "b.yaml",
                  body: "inline 2",
                  createdAt: "2026-11-20T00:00:02Z",
                },
              ],
            },
          },
        } as T;
      }

      if (query.includes("GetFeedbackCommentsPage")) {
        expect(variables?.after).toBe("c-cur-1");
        return {
          repository: {
            pullRequest: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    author: { __typename: "User", login: "okzea" },
                    authorAssociation: "CONTRIBUTOR",
                    body: "comment 2",
                    createdAt: "2026-11-25T00:00:00Z",
                  },
                ],
              },
            },
          },
        } as T;
      }

      if (query.includes("GetFeedbackLabeledEventsPage")) {
        expect(variables?.after).toBe("t-cur-1");
        return {
          repository: {
            pullRequest: {
              timelineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    __typename: "LabeledEvent",
                    createdAt: "2026-11-24T23:09:58Z",
                    label: { name: "Needs-Author-Feedback" },
                  },
                ],
              },
            },
          },
        } as T;
      }

      if (query.includes("GetFeedbackFilesPage")) {
        expect(variables?.after).toBe("f-cur-1");
        return {
          repository: {
            pullRequest: {
              files: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    path: "manifests/o/okzea/WindowRescue/0.1.3/okzea.WindowRescue.installer.yaml",
                  },
                ],
              },
            },
          },
        } as T;
      }

      throw new Error(`Unexpected query: ${query}`);
    };

    const details = await fetchPullRequestFeedbackDetails({
      graphqlFn: mockGraphql,
      owner: "microsoft",
      name: "winget-pkgs",
      repository: "microsoft/winget-pkgs",
      prNumbers: [445661],
    });

    expect(details).toHaveLength(1);
    expect(details[0].manifestOid).toBe(VALID_OID);
    expect(details[0].input.reviews).toHaveLength(2);
    expect(details[0].input.reviews[0].comments).toHaveLength(2);
    expect(details[0].input.comments).toHaveLength(2);
    expect(details[0].input.labeledEvents.map((e) => e.label)).toEqual([
      "New-Package",
      "Needs-Author-Feedback",
    ]);
    expect(details[0].input.filePaths).toHaveLength(2);
    expect(calledQueries).toHaveLength(6);
  });

  test("fetchPullRequestFeedbackDetails は endCursor 欠落やカーソル停滞時に例外を投げる", async () => {
    await expect(
      fetchPullRequestFeedbackDetails({
        graphqlFn: async <T = unknown>() =>
          ({
            repository: {
              pr0: {
                number: 1,
                title: "New package: a",
                url: "https://example.com/1",
                state: "MERGED",
                comments: {
                  pageInfo: { hasNextPage: true, endCursor: null },
                  nodes: [],
                },
              },
            },
          }) as T,
        owner: "microsoft",
        name: "winget-pkgs",
        repository: "microsoft/winget-pkgs",
        prNumbers: [1],
      }),
    ).rejects.toThrow("endCursor が欠落");
  });

  test("fetchInstallerManifestBlobs は有効 Blob のみをマップへ格納し null を安全にスキップする", async () => {
    const blobs = await fetchInstallerManifestBlobs({
      graphqlFn: async <T = unknown>() =>
        ({
          repository: {
            b0: { text: "InstallerType: portable\n" },
            b1: null,
          },
        }) as T,
      owner: "microsoft",
      name: "winget-pkgs",
      targets: [
        { key: "1:a.installer.yaml", oid: VALID_OID, path: "a.installer.yaml" },
        { key: "2:b.installer.yaml", oid: VALID_OID, path: "b.installer.yaml" },
      ],
    });

    expect(blobs.get("1:a.installer.yaml")).toBe("InstallerType: portable\n");
    expect(blobs.has("2:b.installer.yaml")).toBe(false);
  });
});
