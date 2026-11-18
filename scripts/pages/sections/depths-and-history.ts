// キュー境界探索テーブル・待機列の底の比較・未レビュー介入分離・予想答え合わせ・離脱内訳・直近10回履歴テーブルの描画セクション

import { formatDeltaBadge } from "../../../src/domain/dashboard";
import { DEFAULT_EXIT_WINDOW_HOURS } from "../../../src/domain/exit-breakdown";
import { DAY_MS, formatJstDate, formatJstDateTime, round1 } from "../../../src/domain/formatters";
import {
  FIRST_REVIEW_COHORT_ITEM_LIMIT,
  summarizeInterventionFrontier,
} from "../../../src/domain/intervention";
import type { HistoryRowWithDelta } from "../../../src/models/dashboard";
import type {
  DepthsRow,
  FirstReviewCohortItem,
  FirstReviewFrontier,
  InterventionKind,
} from "../../../src/models/depths";
import type {
  ExitBreakdownResult,
  ExitBreakdownUnavailableReason,
} from "../../../src/models/exit-breakdown";
import type { ForecastHistoryLine, ForecastScore } from "../../../src/models/forecast-history";
import {
  escapeHtml,
  formatErrorDays,
  formatNumber,
  formatSamplePackageName,
  renderBadgeHtml,
} from "../formatters";
import type { LatestDepths } from "../types";

interface BottomTableRenderOptions {
  showAuthor?: boolean;
  showCommitCount?: boolean;
  highlightRepeaters?: boolean;
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
    highlightRepeaters = false,
    highlightThirdPartyAssignees = true,
    elapsedBasis = "updated",
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
      const isRepeater =
        (Boolean(item.AuthorAssociation) && item.AuthorAssociation !== "NONE") ||
        (item.AuthorMergedCount ?? 0) > 0;
      const repeaterBadge =
        highlightRepeaters && isRepeater
          ? `<span class="badge" style="background: #fee2e2; color: #b91c1c; font-size: 0.7rem; margin-left: 0.35rem;" title="初回提出者ではないため、初回提出者の底では除外">常連除外</span>`
          : "";
      const interventionBadge = highlightThirdPartyAssignees ? renderInterventionBadge(item) : "";
      const authorCell = showAuthor ? `<td>${escapeHtml(item.Author ?? "-")}</td>` : "";
      const commitCountText = item.CommitCount !== undefined ? `${item.CommitCount}` : "-";
      const commitCountCell = showCommitCount ? `<td>${commitCountText}</td>` : "";
      return `
        <tr>
          <td>${index + 1}</td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(item.Number)}</a>${repeaterBadge}${interventionBadge}</td>
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
    </table>`;
}

/** 優等生の底（1コミット限定・更新が古い順の健康な PR）の表。先頭からの遅れ = 観測時刻 − 最終更新 */
function renderStaleBottomTable(depths: LatestDepths | null): string {
  const items = depths?.StaleBottom ?? [];
  if (items.length === 0) {
    return `<p style="color: var(--text-muted); font-size: 0.875rem;">優等生の底のデータはまだありません。</p>`;
  }
  return renderBottomRowTable(items, depths?.Timestamp ?? "", {
    showAuthor: false,
    showCommitCount: false,
    highlightRepeaters: true,
    elapsedBasis: "updated",
  });
}

/** 初回提出者の底（手直し込みの初回提出者全体・起票日時順の PR）の表。経過 = 観測時刻 − 起票日時 */
function renderFirstTimerBottomTable(depths: LatestDepths | null): string {
  const items = depths?.FirstTimerBottom ?? [];
  if (items.length === 0) {
    return `<p style="color: var(--text-muted); font-size: 0.875rem;">初回提出者の底のデータはまだありません（次回の定期観測から記録されます）。</p>`;
  }
  return renderBottomRowTable(items, depths?.Timestamp ?? "", {
    showAuthor: true,
    showCommitCount: true,
    highlightRepeaters: false,
    elapsedBasis: "created",
  });
}

function renderBoundaryCategoryRows(
  items: DepthsRow[] | undefined,
  limit: number,
  badgeStyle: string,
  badgeLabel: string,
): string {
  return (items ?? [])
    .slice(0, limit)
    .map(
      (item) => `
        <tr>
          <td><span class="badge" style="${badgeStyle}">${badgeLabel}</span></td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank">#${escapeHtml(item.Number)}</a></td>
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>
        `,
    )
    .join("");
}

/** キュー境界探索（健康的大底・真の大底・特急レーン）テーブルセクションを描画する */
export function renderBoundaryTableSection(depths: LatestDepths | null): string {
  return `<h2 class="section-title">🧭 キュー境界探索（健康的大底・真の大底・特急レーン）</h2>
    <p class="section-note">
      健康的大底＝CI・検証通過済みの最古 3 件 / 真の大底＝CI 待ち・阻害ラベルを含む未マージ全体の最古 3 件 / ⚡ 特急レーン＝基準 PR 起票後に作成されマージ済みの最新更新 5 件
    </p>
    <table>
      <thead>
        <tr>
          <th>カテゴリ</th>
          <th>PR 番号</th>
          <th>起票日時 (JST)</th>
          <th>更新日時 (JST)</th>
          <th>タイトル</th>
        </tr>
      </thead>
      <tbody>
        ${renderBoundaryCategoryRows(depths?.HealthyBottom, 3, "background:#e0f2fe;color:#0369a1;", "健康的大底")}
        ${renderBoundaryCategoryRows(depths?.AbsoluteBottom, 3, "background:#fce7f3;color:#9d174d;", "真の大底")}
        ${renderBoundaryCategoryRows(depths?.ExpressLane, 5, "background:#fef3c7;color:#b45309;", "⚡ 特急レーン")}
      </tbody>
    </table>`;
}

/** 下部比較グリッド（優等生の底 vs 初回提出者の底）セクションを描画する */
export function renderBottomComparisonSection(depths: LatestDepths | null): string {
  return `<h2 class="section-title">🧗 待機列の底の比較（優等生 vs 初回提出者）</h2>
    <p class="section-note">
      左は「1コミット完全放置」の待機前線（常連含む）、右はコミット数制限を外した「初回提出者全体（手直し込み）」の待機前線です。第三者 Assignees が付いている PR は「アサイン済」バッジで識別できます。
    </p>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 1.5rem; margin-bottom: 2rem;">
      <div class="card" style="padding: 1.25rem; overflow-x: auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <h3 style="font-size: 1.05rem; font-weight: 600;">🧗 優等生の底（順番待ちの先頭）</h3>
          <span class="badge" style="background: var(--code-bg); color: var(--text-muted);">全1コミット健康体</span>
        </div>
        <p class="section-note" style="margin-bottom: 0.75rem;">
          指摘なし・健康な1コミットPR（常連含む）。最終更新が古い順です。
        </p>
        ${renderStaleBottomTable(depths)}
      </div>

      <div class="card" style="padding: 1.25rem; overflow-x: auto; border-top: 4px solid var(--success);">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <h3 style="font-size: 1.05rem; font-weight: 600; color: var(--success);">🌱 初回提出者の底（真の FIFO 前線）</h3>
          <span class="badge" style="background: #dcfce7; color: #15803d; font-weight: 600;">手直し込み初回全体</span>
        </div>
        <p class="section-note" style="margin-bottom: 0.75rem;">
          初回提出者（authorAssociation = NONE・生涯マージ 0 回）の健康なPR全体（手直しコミット込み）。起票日時の古い順です。
        </p>
        ${renderFirstTimerBottomTable(depths)}
      </div>
    </div>`;
}

function renderInterventionFrontierCard(params: {
  title: string;
  description: string;
  items: DepthsRow[];
  timestamp: string;
  truncated: boolean;
  hasRecorded: boolean;
  emptyConfirmedText: string;
  emptyLegacyText: string;
  highlightInterventions: boolean;
  borderColor: string;
  titleColor: string;
  badgeStyle: string;
  extraMeta?: string;
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
          showAuthor: true,
          showCommitCount: true,
          highlightRepeaters: false,
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
    ? `先頭: #${escapeHtml(summary.head.Number)}（起票 ${escapeHtml(summary.head.作成日時 || summary.head.CreatedAt)}・経過 ${summary.headElapsedDays ?? "-"} 日）${params.extraMeta ?? ""}`
    : "";

  return `<div class="card" style="padding: 1.25rem; overflow-x: auto; border-top: 4px solid ${params.borderColor};">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <h3 style="font-size: 1.05rem; font-weight: 600; color: ${params.titleColor};">${params.title}</h3>
          <span class="badge" style="${params.badgeStyle}">${escapeHtml(badgeText)}</span>
        </div>
        <p class="section-note" style="margin-bottom: 0.5rem;">
          ${params.description}
        </p>
        ${meta ? `<p class="card-subtext" style="margin-bottom: 0.75rem;">${escapeHtml(meta)}</p>` : ""}
        ${body}
      </div>`;
}

const COHORT_INTERVENTION_LABELS: Record<InterventionKind, string> = {
  review: "レビュー",
  comment: "コメント",
  assignee: "アサイン",
};

function renderMainstreamCohortCard(frontier: FirstReviewFrontier | undefined): string {
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
            ${stateBadge}
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
      ? `<table class="sample-table">
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
        </table>`
      : `<p style="color: var(--text-muted); font-size: 0.875rem;">${escapeHtml(
          frontier
            ? "データ不足: 直近 7 日間に初回人間介入が入った初回提出 PR コホートは 0 件です。"
            : "主戦場ラインのデータはまだありません（次回の定期観測から記録されます）。",
        )}</p>`;

  return `<div class="card" style="padding: 1.25rem; overflow-x: auto; border-top: 4px solid #0ea5e9;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem;">
          <h3 style="font-size: 1.05rem; font-weight: 600; color: #0284c7;">🎯 主戦場ライン内訳（直近7日・初回介入コホート）</h3>
          ${countBadgesHtml}
        </div>
        <p class="section-note" style="margin-bottom: 0.5rem;">
          直近 7 日間に初めて人間介入が入った初回提出者 PR（オープン中 ＋ 直近マージ済み）の初回介入新しい順内訳です。この母集団全体の起票日時中央値を主戦場ラインとします。
        </p>
        ${medianMeta ? `<p class="card-subtext" style="margin-bottom: 0.75rem;">${escapeHtml(medianMeta)}</p>` : ""}
        ${body}
      </div>`;
}

/** 未レビュー・介入分離（主戦場ライン初回介入コホート vs 未レビュー前線）比較セクションを描画する */
export function renderInterventionFrontierComparisonSection(depths: LatestDepths | null): string {
  const timestamp = depths?.Timestamp ?? "";
  const unreviewedItems = depths?.UnreviewedBottom ?? [];
  const unreviewedTruncated = Boolean(depths?.UnreviewedTruncated);
  const hasRecordedUnreviewed = depths?.UnreviewedBottom !== undefined || unreviewedTruncated;

  return `<h2 class="section-title">👀 未レビュー・介入分離（主戦場ライン 7日初回介入コホート vs 未レビュー前線）</h2>
    <p class="section-note">
      ボット・作成者本人・自動検証ログ（Deterministic automation）を除いた人間介入の有無・初回日時をもとに、「主戦場ライン（直近 7 日に初めて人間介入が入ったオープン中＋マージ済み初回 PR コホート）」の内訳と、参考指標としての完全未着手キュー（未レビュー前線）を示します。
    </p>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 1.5rem; margin-bottom: 2rem;">
      ${renderMainstreamCohortCard(depths?.FirstReviewFrontier)}

      ${renderInterventionFrontierCard({
        title: "🟦 未レビュー前線（参考: 完全未着手キュー）",
        description:
          "人間レビュー・手動コメント・第三者 Assignees すべて無し（ボット・本人・自動ログ除く）。起票日時の古い順です。",
        items: unreviewedItems,
        timestamp,
        truncated: unreviewedTruncated,
        hasRecorded: hasRecordedUnreviewed,
        emptyConfirmedText: "現在、完全未着手の健康な待機 PR はありません。",
        emptyLegacyText:
          "未レビュー前線のデータはまだありません（次回の定期観測から記録されます）。",
        highlightInterventions: false,
        borderColor: "#64748b",
        titleColor: "#475569",
        badgeStyle: "background: var(--code-bg); color: var(--text-muted); font-weight: 600;",
      })}
    </div>`;
}

const SCORE_KEY_LABELS: Record<string, string> = {
  "rank-velocity": "① 順位消化",
  "creation-order:median": "② 作成順（中央値）",
  "creation-order:p75": "② 作成順（75%点）",
};

/** 予想の答え合わせ: 基準 PR のマージ後に、仮説・モデルごとの予想誤差を示す */
export function renderForecastScoreSection(
  history: ForecastHistoryLine[],
  scores: ForecastScore[],
): string {
  const recorded = history.filter((line) => line.Type === "forecast").length;
  const note = `
    <p class="section-note">
      観測のたびに 2 つの仮説（順位消化・作成順）の予想日を記録し、基準 PR がマージされたら実際のマージ日との誤差を採点します。誤差は「予想日 − 実際のマージ日」で、+ は予想が遅すぎ、− は早すぎです。
    </p>`;
  if (scores.length === 0) {
    return `
    <h2 class="section-title">🎯 予想の答え合わせ</h2>${note}
    <p class="section-note">基準 PR がマージされると、仮説・モデルごとの予想誤差をここに表示します（記録済みの予想 ${recorded} 件）。</p>`;
  }

  const tables = scores
    .map((score) => {
      const rows = score.keys
        .map(
          (k) => `
        <tr>
          <td>${escapeHtml(SCORE_KEY_LABELS[k.key] ?? k.key)}</td>
          <td>${k.count} 件</td>
          <td>${formatErrorDays(k.meanErrorDays)}</td>
          <td>${k.meanAbsErrorDays} 日</td>
          <td>${formatErrorDays(k.lastErrorDays)}</td>
        </tr>`,
        )
        .join("");
      return `
    <h3 class="section-note" style="margin: 1rem 0 0.5rem; font-weight: 600;">${escapeHtml(score.repository)} #${score.targetPr}（マージ: ${escapeHtml(formatJstDate(score.mergedAtMs))}、予想の記録 ${score.observationCount} 回）</h3>
    <table>
      <thead>
        <tr><th>仮説・モデル</th><th>採点数</th><th>平均誤差</th><th>平均絶対誤差</th><th>最後の予想の誤差</th></tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;
    })
    .join("");
  return `
    <h2 class="section-title">🎯 予想の答え合わせ</h2>${note}${tables}`;
}

const EXIT_UNAVAILABLE_TEXT: Record<ExitBreakdownUnavailableReason, string> = {
  "no-records":
    "内訳の記録は、この機能の導入後の観測から貯まります（記録のある観測が 2 回以上必要です）。",
  "short-window": "観測の間隔が短いため、内訳を出せません（6 時間以上の間隔が必要です）。",
  inconsistent: "累積件数が減っているなど、記録が矛盾しているため、内訳を出せません。",
};

/** 待ち行列からの離脱の内訳: 実質待ちの減少が、実際のマージによるものか、それ以外かを分解して示す */
export function renderExitBreakdownSection(result: ExitBreakdownResult): string {
  const targetDays = round1(DEFAULT_EXIT_WINDOW_HOURS / 24);
  const head = `
    <h2 class="section-title">🧮 待ち行列からの離脱の内訳</h2>
    <p class="section-note">
      実質待ち（更新順の順位）の減少が、実際のマージによるものか、それ以外かを分解します（比較対象は直近約 ${targetDays} 日間 / ${DEFAULT_EXIT_WINDOW_HOURS} 時間窓基準）。仮説①（順位消化）の予想が、実際のマージをどれだけ反映しているかの目安です。
    </p>`;
  if (!result.available) {
    return `${head}
    <p class="section-note">${escapeHtml(EXIT_UNAVAILABLE_TEXT[result.reason])}</p>`;
  }

  const { counts, perDay, mergeShare } = result;
  const share = (value: number): string =>
    counts.rank > 0 ? `${Math.round((value / counts.rank) * 100)}%` : "-";
  const row = (label: string, key: keyof typeof counts, indent = false): string => `
        <tr>
          <td${indent ? ' style="padding-left: 2rem;"' : ""}>${indent ? "うち " : ""}${escapeHtml(label)}</td>
          <td>${counts[key]} 件</td>
          <td>${perDay[key]} 件/日</td>
          <td>${indent ? share(counts[key]) : "100%"}</td>
        </tr>`;

  const summary =
    mergeShare === null
      ? "実質待ちが減っていないため、マージの割合は出せません。"
      : `実質待ちの減少のうち、実際のマージは約 <strong>${Math.round(mergeShare * 100)}%</strong> です。`;

  const windowSpan = `${result.hours.toFixed(1)} 時間 / ${(result.hours / 24).toFixed(1)} 日`;

  return `${head}
    <p class="section-note">${escapeHtml(formatJstDateTime(result.baseMs))} 〜 ${escapeHtml(formatJstDateTime(result.latestMs))}（${windowSpan}）の変化。${summary}</p>
    <table>
      <thead>
        <tr><th>内訳</th><th>件数</th><th>1 日あたり</th><th>割合</th></tr>
      </thead>
      <tbody>${row("実質待ち（更新順）の減少", "rank")}${row("マージ", "merged", true)}${row("未マージでクローズ", "closed", true)}${row("健康条件の変化など（推定）", "healthChange", true)}${row("更新による順位の入れ替わり（推定）", "reshuffle", true)}
      </tbody>
    </table>
    <p class="section-note">
      マージ・クローズは、起票が基準 PR より前で、必須ラベルが現在も付いている PR の、基準 PR の起票以降の累積件数の差です（検索の集計）。「健康条件の変化など」は、累積待ち（作成順）の減少からマージ・クローズを引いた残り、「更新による順位の入れ替わり」は、実質待ちの減少から累積待ちの減少を引いた差で、どちらも推定です。
    </p>`;
}

/** 直近 10 回の観測推移ログテーブルセクションを描画する */
export function renderRecentHistorySection(
  recentHistoryWithDeltas: HistoryRowWithDelta[],
  repo: string,
): string {
  return `<h2 class="section-title">📈 直近の観測推移ログ (最新 10 件)</h2>
    ${
      recentHistoryWithDeltas.length > 0
        ? `
    <table>
      <thead>
        <tr>
          <th>観測日時 (JST)</th>
          <th>基準 PR</th>
          <th>消化前線 PR</th>
          <th>実質待ち件数</th>
          <th>前回比 (Δ)</th>
          <th>累積待ち件数</th>
          <th>後続件数</th>
          <th>待機日数</th>
        </tr>
      </thead>
      <tbody>
        ${recentHistoryWithDeltas
          .map((row) => {
            const badge = formatDeltaBadge(row.activeAheadDelta);
            return `
        <tr>
          <td>${escapeHtml(row.timestamp)}</td>
          <td>#${escapeHtml(row.targetPr)}</td>
          <td><a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(row.frontNumber)}" target="_blank">#${escapeHtml(row.frontNumber)}</a></td>
          <td><strong>${formatNumber(row.activeAhead)}</strong></td>
          <td>${renderBadgeHtml(badge)}</td>
          <td>${formatNumber(row.totalAhead)}</td>
          <td>${formatNumber(row.behind)}</td>
          <td>${escapeHtml(row.waitDays)} 日</td>
        </tr>
        `;
          })
          .join("")}
      </tbody>
    </table>
    `
        : `<p style="color: var(--text-muted); font-size: 0.875rem;">現在の指標定義（更新順の待ち順位）の推移データはまだ蓄積されていません。旧定義の履歴は比較できないため表示しません。</p>`
    }`;
}
