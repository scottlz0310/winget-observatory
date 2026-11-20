// 待機ライン 2×2 マトリクス（フェーズ × レンジ）セクションの描画モジュール

import { isFirstTimerDepthsRow } from "../../../src/domain/depths";
import { isPrivilegedOrBotAuthor } from "../../../src/domain/first-timer";
import {
  calculateNumericMedian,
  DAY_MS,
  formatJstDate,
  formatJstDateTime,
  round1,
} from "../../../src/domain/formatters";
import {
  FIRST_REVIEW_COHORT_ITEM_LIMIT,
  summarizeInterventionFrontier,
} from "../../../src/domain/intervention";
import type {
  DepthsRow,
  FirstReviewCohortItem,
  FirstReviewFrontier,
  InterventionKind,
} from "../../../src/models/depths";
import type { ProgressSnapshotSample } from "../../../src/models/progress";
import { escapeHtml, formatSamplePackageName } from "../formatters";
import type { LatestDepths, LatestProgress } from "../types";

interface BottomTableRenderOptions {
  showAuthor?: boolean;
  showCommitCount?: boolean;
  highlightFirstTimer?: boolean;
  highlightThirdPartyAssignees?: boolean;
  elapsedBasis?: "updated" | "created";
}

const INTERVENTION_BADGE_COLORS: Record<InterventionKind, string> = {
  review: "background: #ede9fe; color: #5b21b6;",
  comment: "background: #e0f2fe; color: #0369a1;",
  assignee: "background: #fef3c7; color: #b45309;",
};

function renderInterventionBadge(item: DepthsRow): string {
  const badge = item.Intervention?.PrimaryBadge;
  if (badge) {
    const colorStyle = INTERVENTION_BADGE_COLORS[badge.Kind];
    return `<span class="badge" style="${colorStyle} font-size: 0.7rem; margin-left: 0.35rem;" title="人間の介入（レビュー・手動コメント・第三者 Assignees）を検知">${escapeHtml(badge.Label)}</span>`;
  }
  const thirdPartyAssignees = item.ThirdPartyAssignees ?? [];
  if (thirdPartyAssignees.length > 0) {
    return `<span class="badge" style="${INTERVENTION_BADGE_COLORS.assignee} font-size: 0.7rem; margin-left: 0.35rem;" title="作成者以外の第三者 Assignees（${escapeHtml(thirdPartyAssignees.join(", "))}）が付与済み">アサイン済: ${escapeHtml(thirdPartyAssignees.join(", "))}</span>`;
  }
  return "";
}

/** 底の行一覧のテーブル HTML を生成する */
function renderBottomRowTable(
  items: DepthsRow[],
  timestampIso: string,
  options: BottomTableRenderOptions = {},
): string {
  const {
    showAuthor = false,
    showCommitCount = false,
    highlightFirstTimer = false,
    highlightThirdPartyAssignees = true,
    elapsedBasis = "created",
  } = options;
  const observedMs = Date.parse(timestampIso);
  const rows = items
    .map((item, index) => {
      const baseIso = elapsedBasis === "created" ? item.CreatedAt : item.UpdatedAt;
      const baseMs = Date.parse(baseIso);
      const lag =
        Number.isNaN(observedMs) || Number.isNaN(baseMs)
          ? "-"
          : `${round1((observedMs - baseMs) / DAY_MS)} 日`;
      const firstTimerBadge =
        highlightFirstTimer && isFirstTimerDepthsRow(item)
          ? `<span class="badge" style="background: #dcfce7; color: #15803d; font-size: 0.7rem; margin-left: 0.35rem;" title="初回提出者（authorAssociation = NONE・生涯マージ 0 回）">🌱 初回提出者</span>`
          : "";
      const interventionBadge = highlightThirdPartyAssignees ? renderInterventionBadge(item) : "";
      const authorCell = showAuthor ? `<td>${escapeHtml(item.Author ?? "-")}</td>` : "";
      const commitCountText = item.CommitCount !== undefined ? `${item.CommitCount}` : "-";
      const commitCountCell = showCommitCount ? `<td>${commitCountText}</td>` : "";
      return `
        <tr>
          <td>${index + 1}</td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(item.Number)}</a>${firstTimerBadge}${interventionBadge}</td>
          ${authorCell}
          ${commitCountCell}
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${lag}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>`;
    })
    .join("");
  const authorHeader = showAuthor ? "<th>作者</th>" : "";
  const commitCountHeader = showCommitCount ? "<th>コミット数</th>" : "";
  const elapsedHeader =
    elapsedBasis === "created" ? "<th>起票からの経過</th>" : "<th>更新からの経過</th>";
  return `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>順位</th>
            <th>PR 番号</th>
            ${authorHeader}
            ${commitCountHeader}
            <th>起票日時 (JST)</th>
            <th>最終更新 (JST)</th>
            ${elapsedHeader}
            <th>タイトル</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </div>`;
}

function renderMatrixRowListView(params: {
  viewKey: "all" | "first-timer";
  items: DepthsRow[];
  timestamp: string;
  truncated: boolean;
  hasRecorded: boolean;
  emptyConfirmedText: string;
  emptyLegacyText: string;
  highlightInterventions: boolean;
  highlightFirstTimer: boolean;
  showAuthor: boolean;
  showCommitCount: boolean;
  badgeStyle: string;
  fallbackNote?: string;
}): string {
  const summary = summarizeInterventionFrontier(params.items, params.timestamp);
  const badgeText = params.truncated
    ? params.items.length === 0
      ? "探索上限到達・未確定"
      : `上位 ${summary.count} 件（上限到達・一部未完）`
    : `上位 ${summary.count} 件`;

  const body =
    params.items.length > 0
      ? `${renderBottomRowTable(params.items, params.timestamp, {
          showAuthor: params.showAuthor,
          showCommitCount: params.showCommitCount,
          highlightFirstTimer: params.highlightFirstTimer,
          highlightThirdPartyAssignees: params.highlightInterventions,
          elapsedBasis: "created",
        })}${
          params.truncated
            ? `<p class="card-subtext" style="margin-top: 0.5rem;">※ 走査上限に到達したため途中で打ち切りました（未走査の PR が残っています）。</p>`
            : ""
        }`
      : `<p style="color: var(--text-muted); font-size: 0.875rem;">${escapeHtml(
          params.truncated
            ? "走査上限に到達したため探索を打ち切りました（未走査の PR が残っており、対象 PR の有無は未確定です）。"
            : params.hasRecorded
              ? params.emptyConfirmedText
              : params.emptyLegacyText,
        )}</p>`;

  const meta = summary.head
    ? `先頭: #${escapeHtml(summary.head.Number)}（起票 ${escapeHtml(summary.head.作成日時 || summary.head.CreatedAt)}・経過 ${summary.headElapsedDays ?? "-"} 日）`
    : "";

  const hiddenStyle = params.viewKey === "first-timer" ? ' style="display: none;"' : "";
  return `<div data-matrix-view="${params.viewKey}"${hiddenStyle}>
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem;">
          <span class="badge" style="${params.badgeStyle}">${escapeHtml(badgeText)}</span>
          ${meta ? `<span class="card-subtext" style="margin-top: 0;">${escapeHtml(meta)}</span>` : ""}
        </div>
        ${params.fallbackNote ? `<p class="card-subtext" style="margin-bottom: 0.5rem;">${escapeHtml(params.fallbackNote)}</p>` : ""}
        ${body}
      </div>`;
}

const COHORT_INTERVENTION_LABELS: Record<InterventionKind, string> = {
  review: "レビュー",
  comment: "コメント",
  assignee: "アサイン",
};

function renderMainstreamCohortView(params: {
  viewKey: "all" | "first-timer";
  frontier: FirstReviewFrontier | undefined;
  fallbackNote?: string;
}): string {
  const { viewKey, frontier, fallbackNote } = params;
  const items = frontier?.Items ?? [];
  const badgeText = frontier
    ? `計 ${frontier.CohortCount} 件 (Open ${frontier.OpenCount} / Merged ${frontier.MergedCount})`
    : "未観測";
  const countBadgesHtml = frontier
    ? `<div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
            <span class="badge" style="background: #e0f2fe; color: #0369a1; font-weight: 600;">${escapeHtml(badgeText)}</span>
            <span style="font-size: 0.75rem; color: var(--text-muted);">直近介入順 ${FIRST_REVIEW_COHORT_ITEM_LIMIT} 件表示</span>
          </div>`
    : `<span class="badge" style="background: #e0f2fe; color: #0369a1; font-weight: 600;">未観測</span>`;
  const oldestDateText =
    frontier?.OldestCreatedAt && Number.isFinite(Date.parse(frontier.OldestCreatedAt))
      ? formatJstDate(Date.parse(frontier.OldestCreatedAt))
      : "-";
  const newestDateText =
    frontier?.NewestCreatedAt && Number.isFinite(Date.parse(frontier.NewestCreatedAt))
      ? formatJstDate(Date.parse(frontier.NewestCreatedAt))
      : "-";
  const medianMeta =
    frontier && frontier.CohortCount > 0 && frontier.MedianCreatedAt
      ? `中央値起票: ${formatJstDateTime(frontier.MedianCreatedAt, false)}（経過 ${frontier.LagDays ?? "-"} 日） / 起票範囲: ${oldestDateText} 〜 ${newestDateText}`
      : "";

  const renderRow = (item: FirstReviewCohortItem): string => {
    const stateBadge =
      item.State === "MERGED"
        ? `<span class="badge sample-nowrap" style="background: #dcfce7; color: #15803d; font-size: 0.7rem;">MERGED</span>`
        : `<span class="badge sample-nowrap" style="background: #e0f2fe; color: #0369a1; font-size: 0.7rem;">OPEN</span>`;
    const isFt =
      viewKey === "all" &&
      (item.IsFirstTimer !== undefined
        ? item.IsFirstTimer
        : !isPrivilegedOrBotAuthor({
            author: item.Author,
            authorAssociation: item.AuthorAssociation,
          }) &&
          ((item.State === "OPEN" &&
            item.AuthorAssociation === "NONE" &&
            item.AuthorMergedCount === 0) ||
            (item.State === "MERGED" && item.AuthorMergedCount === 1)));
    const ftBadge = isFt
      ? `<span class="badge sample-nowrap" style="background: #dcfce7; color: #15803d; font-size: 0.7rem;">🌱 初回</span>`
      : "";
    const kindLabel = item.InterventionKind
      ? COHORT_INTERVENTION_LABELS[item.InterventionKind]
      : "介入";
    const interventionBadge = item.InterventionKind
      ? `<span class="badge" style="${INTERVENTION_BADGE_COLORS[item.InterventionKind]} font-size: 0.7rem; margin-left: 0.25rem;">${escapeHtml(kindLabel)}${item.InterventionActor ? `: ${escapeHtml(item.InterventionActor)}` : ""}</span>`
      : "";
    const { displayName, fullTitle } = formatSamplePackageName(item.Title);
    const pkgHtml = displayName
      ? `<div title="${escapeHtml(fullTitle)}" style="font-size: 0.8rem; color: var(--text-color); margin-top: 0.15rem; word-break: break-word;">${escapeHtml(displayName)}</div>`
      : "";
    return `
      <tr>
        <td style="min-width: 170px;">
          <div style="display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;">
            <a href="${escapeHtml(item.Url)}" target="_blank" rel="noopener noreferrer" style="font-weight: 600; white-space: nowrap;">#${escapeHtml(item.Number)}</a>
            ${stateBadge}${ftBadge}
          </div>
          ${pkgHtml}
        </td>
        <td>${escapeHtml(item.Author ?? "-")}</td>
        <td class="sample-nowrap">${item.CommitCount !== undefined ? escapeHtml(item.CommitCount) : "-"}</td>
        <td class="sample-nowrap">${escapeHtml(formatJstDateTime(item.CreatedAt, false))}</td>
        <td><span class="sample-nowrap">${escapeHtml(formatJstDateTime(item.FirstHumanInterventionAt, false))}</span>${interventionBadge}</td>
      </tr>`;
  };

  const body =
    items.length > 0
      ? `<div class="table-scroll">
          <table class="sample-table">
            <thead>
              <tr>
                <th>PR / パッケージ</th>
                <th>作者</th>
                <th class="sample-nowrap">コミット数</th>
                <th class="sample-nowrap">起票日時 (JST)</th>
                <th class="sample-nowrap">初回人間介入 (JST)</th>
              </tr>
            </thead>
            <tbody>${items.map(renderRow).join("")}
            </tbody>
          </table>
        </div>`
      : `<p style="color: var(--text-muted); font-size: 0.875rem;">${escapeHtml(
          frontier
            ? "データ不足: 直近 7 日間に初回人間介入が入った対象 PR コホートは 0 件です。"
            : "主戦場ラインのデータはまだありません（次回の定期観測から記録されます）。",
        )}</p>`;

  const hiddenStyle = viewKey === "first-timer" ? ' style="display: none;"' : "";
  return `<div data-matrix-view="${viewKey}"${hiddenStyle}>
        <div style="margin-bottom: 0.5rem;">${countBadgesHtml}</div>
        ${fallbackNote ? `<p class="card-subtext" style="margin-bottom: 0.5rem;">${escapeHtml(fallbackNote)}</p>` : ""}
        ${medianMeta ? `<p class="card-subtext" style="margin-bottom: 0.75rem;">${escapeHtml(medianMeta)}</p>` : ""}
        ${body}
      </div>`;
}

const MATRIX_FILTER_INLINE_SCRIPT = `<script>
(() => {
  for (const section of document.querySelectorAll("[data-matrix-section]")) {
    const buttons = section.querySelectorAll("[data-matrix-filter]");
    const views = section.querySelectorAll("[data-matrix-view]");
    for (const btn of buttons) {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-matrix-filter") || "all";
        for (const b of buttons) {
          const active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", active ? "true" : "false");
        }
        for (const v of views) {
          v.style.display = v.getAttribute("data-matrix-view") === mode ? "" : "none";
        }
      });
    }
  }
})();
</script>`;

const RECENT_MERGED_FRONTIER_LIMIT = 10;

function renderRecentMergedFrontierView(params: {
  viewKey: "all" | "first-timer";
  samples: ProgressSnapshotSample[];
  repo: string;
  medianDays: number | null | undefined;
  lookbackDays: number;
  sampleCount: number | undefined;
  hasRecordedProgress: boolean;
  badgeStyle: string;
}): string {
  const {
    viewKey,
    samples,
    repo,
    medianDays,
    lookbackDays,
    sampleCount,
    hasRecordedProgress,
    badgeStyle,
  } = params;
  const items = samples.slice(0, RECENT_MERGED_FRONTIER_LIMIT);
  const hasCountWithoutList = items.length === 0 && (sampleCount ?? 0) > 0;
  const badgeText =
    items.length > 0
      ? `直近 ${items.length} 件表示（過去 ${lookbackDays} 日・採用 ${sampleCount ?? items.length} 件）`
      : hasCountWithoutList
        ? `過去 ${lookbackDays} 日・採用 ${sampleCount} 件（一覧未保存）`
        : hasRecordedProgress
          ? `該当 0 件（過去 ${lookbackDays} 日）`
          : "未観測";

  const createdMsList = samples
    .map((s) => Date.parse(s.CreatedAt))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const medianCreatedMs = calculateNumericMedian(createdMsList);
  const metaParts: string[] = [];
  if (medianDays !== undefined && medianDays !== null) {
    metaParts.push(`通算中央値: ${medianDays} 日`);
  }
  if (medianCreatedMs !== null) {
    metaParts.push(
      `直近サンプル起票中央値: ${formatJstDateTime(new Date(medianCreatedMs).toISOString(), false)}`,
    );
  }
  const metaText = metaParts.join(" / ");

  const renderRow = (sample: ProgressSnapshotSample): string => {
    const ftBadge =
      viewKey === "all" && sample.IsFirstTimer === true
        ? `<span class="badge sample-nowrap" style="background: #dcfce7; color: #15803d; font-size: 0.7rem;">🌱 初回</span>`
        : "";
    const { displayName, fullTitle } = formatSamplePackageName(sample.Title);
    const pkgHtml = displayName
      ? `<div title="${escapeHtml(fullTitle)}" style="font-size: 0.8rem; color: var(--text-color); margin-top: 0.15rem; word-break: break-word;">${escapeHtml(displayName)}</div>`
      : "";
    return `
      <tr>
        <td style="min-width: 170px;">
          <div style="display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;">
            <a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(sample.Number)}" target="_blank" rel="noopener noreferrer" style="font-weight: 600; white-space: nowrap;">#${escapeHtml(sample.Number)}</a>
            ${ftBadge}
          </div>
          ${pkgHtml}
        </td>
        <td>${escapeHtml(sample.Author ?? "-")}</td>
        <td class="sample-nowrap">${escapeHtml(sample.CommitCount)}</td>
        <td class="sample-nowrap">${escapeHtml(formatJstDateTime(sample.CreatedAt, false))}</td>
        <td class="sample-nowrap">${escapeHtml(formatJstDateTime(sample.MergedAt, false))}</td>
        <td class="sample-nowrap">${sample.TotalDays.toFixed(1)} 日</td>
      </tr>`;
  };

  const body =
    items.length > 0
      ? `<div class="table-scroll">
          <table class="sample-table">
            <thead>
              <tr>
                <th>PR / パッケージ</th>
                <th>作者</th>
                <th class="sample-nowrap">コミット数</th>
                <th class="sample-nowrap">起票日時 (JST)</th>
                <th class="sample-nowrap">マージ日時 (JST)</th>
                <th class="sample-nowrap">通算日数</th>
              </tr>
            </thead>
            <tbody>${items.map(renderRow).join("")}
            </tbody>
          </table>
        </div>`
      : `<p style="color: var(--text-muted); font-size: 0.875rem;">${escapeHtml(
          hasCountWithoutList
            ? "旧スナップショットのため対象窓の専用サンプル一覧が未保存です（次回観測から表示されます）。"
            : hasRecordedProgress
              ? viewKey === "first-timer"
                ? "直近マージ採用サンプル内に初回提出者の該当 PR はありません。"
                : "直近マージ採用サンプルはありません。"
              : "直近マージ実績のデータはまだありません。",
        )}</p>`;

  const hiddenStyle = viewKey === "first-timer" ? ' style="display: none;"' : "";
  return `<div data-matrix-view="${viewKey}"${hiddenStyle}>
        <div style="margin-bottom: 0.5rem;">
          <span class="badge" style="${badgeStyle}">${escapeHtml(badgeText)}</span>
        </div>
        ${metaText ? `<p class="card-subtext" style="margin-bottom: 0.75rem;">${escapeHtml(metaText)}</p>` : ""}
        ${body}
      </div>`;
}

/**
 * 待機ライン 2×2 マトリクス（フェーズ: メンテナ初動 vs 最終マージ × レンジ: 前線 vs 正常底）を描画する。
 * セクション上部の共通フィルタバーで「すべて（常連込み）」と「🌱 初回提出者のみ」を 4 象限一括で切り替えられる。
 */
export function renderWaitlineMatrixSection(
  depths: LatestDepths | null,
  progress: LatestProgress | null = null,
  repo?: string,
): string {
  const timestamp = depths?.Timestamp ?? "";
  const resolvedRepo =
    repo || progress?.Repository || depths?.Repository || "microsoft/winget-pkgs";

  // ① 初動前線（主戦場ライン: 直近7日初回人間介入コホート）
  const hasAllAuthorsFrontier = depths?.AllAuthorsFirstReviewFrontier !== undefined;
  const frontierAll = depths?.AllAuthorsFirstReviewFrontier ?? depths?.FirstReviewFrontier;
  const frontierFt = depths?.FirstReviewFrontier;

  // ② 初動正常底（未レビュー最古: 完全未着手キュー）
  const unreviewedAll = depths?.UnreviewedBottom ?? [];
  const hasDedicatedUnreviewedFt =
    depths?.FirstTimerUnreviewedBottom !== undefined ||
    Boolean(depths?.FirstTimerUnreviewedTruncated);
  const unreviewedFt = hasDedicatedUnreviewedFt
    ? (depths?.FirstTimerUnreviewedBottom ?? [])
    : unreviewedAll.filter(isFirstTimerDepthsRow);
  const hasRecordedUnreviewed =
    depths?.UnreviewedBottom !== undefined || Boolean(depths?.UnreviewedTruncated);
  const unreviewedFtTruncated = hasDedicatedUnreviewedFt
    ? Boolean(depths?.FirstTimerUnreviewedTruncated)
    : Boolean(depths?.UnreviewedTruncated);

  // ③ マージ前線（直近マージ実績: 全体は progress.Samples、初回提出者は FirstTimerSamples 優先）
  const mergedSamplesAll = progress?.Samples ?? [];
  const hasRecordedProgress = progress !== null;
  const lookbackDays = progress?.LookbackDays ?? 30;
  const firstTimerLookbackDays = progress?.FirstTimerLookbackDays ?? lookbackDays;
  let mergedSamplesFt: ProgressSnapshotSample[];
  if (progress?.FirstTimerSamples !== undefined) {
    mergedSamplesFt = progress.FirstTimerSamples;
  } else {
    const observedProgressMs = progress?.Timestamp ? Date.parse(progress.Timestamp) : Number.NaN;
    if (Number.isFinite(observedProgressMs)) {
      const ftWindowStartMs = observedProgressMs - firstTimerLookbackDays * DAY_MS;
      mergedSamplesFt = mergedSamplesAll.filter((s) => {
        if (s.IsFirstTimer !== true) return false;
        const mergedMs = Date.parse(s.MergedAt);
        return (
          Number.isFinite(mergedMs) && mergedMs >= ftWindowStartMs && mergedMs <= observedProgressMs
        );
      });
    } else if (firstTimerLookbackDays < lookbackDays) {
      mergedSamplesFt = [];
    } else {
      mergedSamplesFt = mergedSamplesAll.filter((s) => s.IsFirstTimer === true);
    }
  }

  // ④ マージ正常底（健康的大底）
  const mergeBottomAll = depths?.HealthyBottom ?? [];
  const mergeBottomFt = depths?.FirstTimerBottom ?? [];
  const hasRecordedMergeBottom = depths?.HealthyBottom !== undefined;
  const hasRecordedMergeBottomFt = depths?.FirstTimerBottom !== undefined;

  return `<section data-matrix-section>
    <h2 class="section-title">🧭 待機ライン 2×2 マトリクス（フェーズ × レンジ）</h2>
    <p class="section-note">
      「前線（早ければこのくらい）」と「正常底（遅くともここまでには）」を、メンテナ初動・最終マージの 2 フェーズで並列比較します。上部トグルで 4 象限すべてを一括切替できます。
    </p>
    <div class="sample-filter-bar" role="group" aria-label="2×2 マトリクス対象母集団フィルタ">
      <button type="button" class="sample-filter-btn is-active" data-matrix-filter="all" aria-pressed="true">
        すべて（常連込み）
      </button>
      <button type="button" class="sample-filter-btn" data-matrix-filter="first-timer" aria-pressed="false">
        🌱 初回提出者のみ
      </button>
    </div>

    <h3 class="matrix-phase-header">① メンテナ初動（初回人間アクション）</h3>
    <div class="matrix-phase-grid">
      <div class="card" style="padding: 1.25rem; border-top: 4px solid #0ea5e9;">
        <h4 style="font-size: 1.05rem; font-weight: 600; color: #0284c7; margin-bottom: 0.4rem;">🎯 初動前線（主戦場ライン・早ければ）</h4>
        <p class="section-note" style="margin-bottom: 0.6rem;">
          直近 7 日間に初めて人間介入が入った PR（オープン中 ＋ 直近マージ済み）の起票日時中央値と直近介入順内訳です。
        </p>
        ${renderMainstreamCohortView({
          viewKey: "all",
          frontier: frontierAll,
          fallbackNote:
            !hasAllAuthorsFrontier && frontierAll
              ? "※ 旧スナップショットのため初回提出者コホートを表示中（次回観測から常連込み全体コホートを記録）"
              : undefined,
        })}
        ${renderMainstreamCohortView({
          viewKey: "first-timer",
          frontier: frontierFt,
        })}
      </div>

      <div class="card" style="padding: 1.25rem; border-top: 4px solid #64748b;">
        <h4 style="font-size: 1.05rem; font-weight: 600; color: #475569; margin-bottom: 0.4rem;">🟦 初動正常底（未レビュー最古・遅くとも）</h4>
        <p class="section-note" style="margin-bottom: 0.6rem;">
          人間レビュー・手動コメント・第三者 Assignees・特権ロール自動指摘がいずれも無い完全未着手キュー（複数コミット込み・起票日時古い順 TOP 10）。これより古い健康 PR には原則メンテナの手が入っています。
        </p>
        ${renderMatrixRowListView({
          viewKey: "all",
          items: unreviewedAll,
          timestamp,
          truncated: Boolean(depths?.UnreviewedTruncated),
          hasRecorded: hasRecordedUnreviewed,
          emptyConfirmedText: "現在、完全未着手の健康な待機 PR はありません。",
          emptyLegacyText:
            "未レビュー最古のデータはまだありません（次回の定期観測から記録されます）。",
          highlightInterventions: false,
          highlightFirstTimer: true,
          showAuthor: true,
          showCommitCount: true,
          badgeStyle: "background: var(--code-bg); color: var(--text-muted); font-weight: 600;",
        })}
        ${renderMatrixRowListView({
          viewKey: "first-timer",
          items: unreviewedFt,
          timestamp,
          truncated: unreviewedFtTruncated,
          hasRecorded: hasDedicatedUnreviewedFt,
          emptyConfirmedText: "現在、初回提出者の完全未着手 PR はありません。",
          emptyLegacyText:
            "初回提出者専用の未レビュー最古データはまだありません（次回の定期観測から記録されます）。",
          highlightInterventions: false,
          highlightFirstTimer: false,
          showAuthor: true,
          showCommitCount: true,
          badgeStyle: "background: #dcfce7; color: #15803d; font-weight: 600;",
          fallbackNote:
            !hasDedicatedUnreviewedFt && unreviewedFt.length > 0
              ? "※ 旧スナップショットの全体一覧から初回提出者を参考抽出しています（次回観測から専用 TOP 10 を記録）"
              : undefined,
        })}
      </div>
    </div>

    <h3 class="matrix-phase-header">② 最終マージ（FIFO 完了）</h3>
    <div class="matrix-phase-grid">
      <div class="card" style="padding: 1.25rem; border-top: 4px solid var(--primary);">
        <h4 style="font-size: 1.05rem; font-weight: 600; color: var(--primary); margin-bottom: 0.4rem;">🚀 マージ前線（直近マージ実績・早ければ）</h4>
        <p class="section-note" style="margin-bottom: 0.6rem;">
          直近にマージされた健康体 PR の採用サンプル（マージ日時新しい順 TOP 10）と通算所要日数・起票日時中央値です。
        </p>
        ${renderRecentMergedFrontierView({
          viewKey: "all",
          samples: mergedSamplesAll,
          repo: resolvedRepo,
          medianDays: progress?.TotalMedianDays,
          lookbackDays,
          sampleCount: progress?.SampleCount,
          hasRecordedProgress,
          badgeStyle: "background: var(--primary-light); color: var(--primary); font-weight: 600;",
        })}
        ${renderRecentMergedFrontierView({
          viewKey: "first-timer",
          samples: mergedSamplesFt,
          repo: resolvedRepo,
          medianDays: progress?.FirstTimerMedianDays,
          lookbackDays: firstTimerLookbackDays,
          sampleCount: progress?.FirstTimerSampleCount,
          hasRecordedProgress,
          badgeStyle: "background: #dcfce7; color: #15803d; font-weight: 600;",
        })}
      </div>

      <div class="card" style="padding: 1.25rem; border-top: 4px solid var(--success);">
        <h4 style="font-size: 1.05rem; font-weight: 600; color: var(--success); margin-bottom: 0.4rem;">⚓ マージ正常底（健康的大底・遅くとも）</h4>
        <p class="section-note" style="margin-bottom: 0.6rem;">
          手直しコミット込みで CI・検証通過済みの最古健康 PR（起票日時古い順 TOP 10）。
        </p>
        ${renderMatrixRowListView({
          viewKey: "all",
          items: mergeBottomAll,
          timestamp,
          truncated: false,
          hasRecorded: hasRecordedMergeBottom,
          emptyConfirmedText: "現在、該当する健康体 PR はありません。",
          emptyLegacyText: "マージ正常底（健康的大底）のデータはまだありません。",
          highlightInterventions: true,
          highlightFirstTimer: true,
          showAuthor: mergeBottomAll.some((r) => r.Author !== undefined),
          showCommitCount: mergeBottomAll.some((r) => r.CommitCount !== undefined),
          badgeStyle: "background: #e0f2fe; color: #0369a1; font-weight: 600;",
        })}
        ${renderMatrixRowListView({
          viewKey: "first-timer",
          items: mergeBottomFt,
          timestamp,
          truncated: Boolean(depths?.FirstTimerBottomTruncated),
          hasRecorded: hasRecordedMergeBottomFt,
          emptyConfirmedText: "現在、初回提出者の健康体 PR はありません。",
          emptyLegacyText:
            "初回提出者のマージ正常底データはまだありません（次回の定期観測から記録されます）。",
          highlightInterventions: true,
          highlightFirstTimer: false,
          showAuthor: true,
          showCommitCount: true,
          badgeStyle: "background: #dcfce7; color: #15803d; font-weight: 600;",
        })}
      </div>
    </div>
    ${MATRIX_FILTER_INLINE_SCRIPT}
  </section>`;
}
