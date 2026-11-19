import { describe, expect, test } from "bun:test";
import {
  BLOCKED_LABELS,
  buildExcludedLabelQueryParts,
  buildHealthyQueryParts,
  buildMergedCandidateQueryParts,
  INVESTIGATION_LABELS,
  isBlockedLabel,
  isEligibleLabels,
  PATTERN_BLOCKED_LABELS,
  REQUIRED_LABELS,
  SPECIAL_LANE_LABELS,
  WAIVED_LABEL_PREFIX,
} from "../../src/domain/labels";
import { SPECIAL_LANE_LABELS as REEXPORTED_SPECIAL_LANE_LABELS } from "../../src/domain/progress";
import { simulateReadySince } from "../../src/domain/timeline";
import type { ProgressTimelineEvent } from "../../src/models/progress";

const NEWLY_ADDED_EXCLUDED_LABELS = [
  // Internal-Error-* 全 9 種
  "Internal-Error-Domain",
  "Internal-Error-Dynamic-Scan",
  "Internal-Error-Keyword-Policy",
  "Internal-Error-Manifest",
  "Internal-Error-NoArchitectures",
  "Internal-Error-NoSupportedArchitectures",
  "Internal-Error-PR",
  "Internal-Error-Static-Scan",
  "Internal-Error-URL",
  // 非 -Error 末尾の検証失敗 6 種
  "Validation-Indirect-URL",
  "Validation-Missing-Dependency",
  "Validation-No-Executables",
  "Validation-Open-Url-Failed",
  "Validation-Shell-Execute",
  "Validation-Unattended-Failed",
  // 停止・手動対応待ち / 非推奨 / 特殊ブロッカー 19 種
  "Needs-Attention",
  "Needs-Manual-Merge",
  "Needs-Manual-Review",
  "Manifest-Version-Deprecated",
  "Manifest-Singleton-Deprecated",
  "Manifest-Metadata-Consistency",
  "Highest-Version-Removal",
  "Last-Version-Removal",
  "Version-Parameter-Mismatch",
  "DriverInstall",
  "Scripted-Application",
  "Interactive-Only-Installer",
  "License-Blocks-Install",
  "EULA-Install",
  "Hardware",
  "Project-File",
  "portable-archive",
  "portable-jar",
  "zip-binary",
  // 公式高速自動マージ・特殊レーン 2 種
  "Publisher-Verified",
  "Validation-Metadata",
] as const;

describe("Domain: labels exclusion and special lanes (#123)", () => {
  test("全除外ラベル定数間に重複がなく Waived-* や必須ラベルと衝突しない", () => {
    const allExcluded = [
      ...BLOCKED_LABELS,
      ...INVESTIGATION_LABELS,
      ...PATTERN_BLOCKED_LABELS,
      ...SPECIAL_LANE_LABELS,
    ];
    const unique = new Set(allExcluded);
    expect(unique.size).toBe(allExcluded.length);

    for (const label of allExcluded) {
      expect(label.startsWith(WAIVED_LABEL_PREFIX)).toBeFalse();
      expect(REQUIRED_LABELS).not.toContain(label);
    }

    const queryParts = buildExcludedLabelQueryParts();
    expect(queryParts.length).toBe(allExcluded.length);
    expect(new Set(queryParts).size).toBe(queryParts.length);
  });

  test("SPECIAL_LANE_LABELS が progress.ts から re-export され Publisher-Verified を含む", () => {
    expect(REEXPORTED_SPECIAL_LANE_LABELS).toBe(SPECIAL_LANE_LABELS);
    expect(SPECIAL_LANE_LABELS).toContain("Publisher-Verified");
    expect(SPECIAL_LANE_LABELS).toContain("Validation-Metadata");
  });

  test.each(NEWLY_ADDED_EXCLUDED_LABELS)(
    "新規補強ラベル %s は isBlockedLabel・isEligibleLabels・Search クエリすべてで除外される",
    (label) => {
      expect(isBlockedLabel(label)).toBeTrue();
      expect(isEligibleLabels([...REQUIRED_LABELS, label])).toBeFalse();

      const healthyParts = buildHealthyQueryParts("microsoft/winget-pkgs");
      expect(healthyParts).toContain(`-label:"${label}"`);

      const mergedParts = buildMergedCandidateQueryParts(
        "microsoft/winget-pkgs",
        "2026-10-01T00:00:00Z",
        "2026-11-19T00:00:00Z",
      );
      expect(mergedParts).toContain(`-label:"${label}"`);
    },
  );

  test.each([
    "Internal-Error-FutureSubType",
    "Validation-FutureCheck-Failed",
    "Validation-No-Executables",
    "Publisher-Verified",
  ])("未知サブタイプおよび高速枠ラベル %s はパターンまたはセットで除外される", (label) => {
    expect(isBlockedLabel(label)).toBeTrue();
    expect(isEligibleLabels([...REQUIRED_LABELS, label])).toBeFalse();
  });

  test.each([
    "Waived-Internal-Error-Dynamic-Scan",
    "Waived-Validation-Unattended-Failed",
    "Waived-Validation-No-Executables",
  ])("Waived-* 免除ラベル %s は除外対象にならない", (label) => {
    expect(isBlockedLabel(label)).toBeFalse();
    expect(isEligibleLabels([...REQUIRED_LABELS, label])).toBeTrue();
  });

  test.each([
    "Internal-Error-Dynamic-Scan",
    "Validation-No-Executables",
    "Needs-Attention",
    "Manifest-Version-Deprecated",
    "DriverInstall",
    "Publisher-Verified",
  ])(
    "simulateReadySince は %s 付与中の区間を非 Ready と判定し、解除後に再成立する",
    (blockedLabel) => {
      const now = new Date("2026-11-19T00:00:00Z");
      const events: ProgressTimelineEvent[] = [
        { event: "labeled", created_at: "2026-11-01T00:00:00Z", label: { name: "New-Package" } },
        {
          event: "labeled",
          created_at: "2026-11-01T00:01:00Z",
          label: { name: "Azure-Pipeline-Passed" },
        },
        { event: "labeled", created_at: "2026-11-01T00:02:00Z", label: { name: blockedLabel } },
        {
          event: "labeled",
          created_at: "2026-11-01T00:03:00Z",
          label: { name: "Validation-Completed" },
        },
      ];

      expect(simulateReadySince(events, false, new Date("2026-11-04T00:00:00Z"))).toBeNull();

      const resolvedEvents: ProgressTimelineEvent[] = [
        ...events,
        { event: "unlabeled", created_at: "2026-11-05T00:00:00Z", label: { name: blockedLabel } },
      ];
      const readyAt = simulateReadySince(resolvedEvents, false, now);
      expect(readyAt?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    },
  );
});
