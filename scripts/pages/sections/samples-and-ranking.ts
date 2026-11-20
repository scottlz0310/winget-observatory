// 初回提出者 最速マージランキングおよび比較に使ったマージ済みサンプル一覧（通過ペース集計含む）の描画モジュール

import {
  formatDateTimeWithDay,
  formatMonthDay,
  toJstEpochDay,
} from "../../../src/domain/formatters";
import { getPercentile } from "../../../src/domain/progress";
import {
  FIRST_TIMER_FASTEST_RANKING_LIMIT,
  FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS,
  FIRST_TIMER_FASTEST_RANKING_MIN_VERSION,
  FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS,
} from "../../../src/domain/sample-cache";
import type { ProgressSnapshotSample } from "../../../src/models/progress";
import type { FirstTimerFastestRanking } from "../../../src/models/sample-cache";
import { escapeHtml, formatSamplePackageName } from "../formatters";
import type { LatestProgress } from "../types";

export { formatSamplePackageName };

/** 初回提出者限定の最速マージランキング（直近90日起票 TOP 10） */
export function renderFirstTimerFastestRankingSection(
  ranking: FirstTimerFastestRanking | undefined,
  repo: string,
): string {
  const totalCount = ranking?.totalCount ?? 0;
  const items = ranking?.items ?? [];
  const windowDays = ranking?.windowDays ?? FIRST_TIMER_FASTEST_RANKING_WINDOW_DAYS;
  const windowLabel = windowDays > 0 ? `直近 ${windowDays} 日起票` : "蓄積全件";
  const scopeNote =
    windowDays > 0
      ? `直近 ${windowDays} 日以内に起票された初回提出者`
      : "蓄積サンプル内の初回提出者";

  if (items.length === 0) {
    return `
    <h2 class="section-title">🏆 初回提出者 最速マージランキング（${escapeHtml(windowLabel)} TOP ${FIRST_TIMER_FASTEST_RANKING_LIMIT}）</h2>
    <p class="section-note">${escapeHtml(scopeNote)}（成立後 ${FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS} 日以上・v${FIRST_TIMER_FASTEST_RANKING_MIN_VERSION} 以上・特権ロール/Bot 除外）: 0 件</p>
    <p style="color: var(--text-muted); font-size: 0.875rem; margin-bottom: 2rem;">対象の初回提出者サンプルがまだありません</p>`;
  }

  const rows = items
    .map(
      (item, index) => `
        <tr>
          <td>${index + 1}</td>
          <td><a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(item.Number)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(item.Number)}</a></td>
          <td>${escapeHtml(item.CommitCount)}</td>
          <td>${item.TotalDays.toFixed(1)} 日</td>
          <td>${item.TurnDays.toFixed(1)} 日</td>
          <td>${item.ReadyDays.toFixed(1)} 日</td>
          <td>${escapeHtml(formatDateTimeWithDay(item.CreatedAt))}</td>
          <td>${escapeHtml(formatDateTimeWithDay(item.MergedAt))}</td>
          <td>${escapeHtml(item.Title)}</td>
        </tr>`,
    )
    .join("");

  return `
    <h2 class="section-title">🏆 初回提出者 最速マージランキング（${escapeHtml(windowLabel)} TOP ${FIRST_TIMER_FASTEST_RANKING_LIMIT}）</h2>
    <p class="section-note">
      ${escapeHtml(scopeNote)}（成立後 ${FIRST_TIMER_FASTEST_RANKING_MIN_READY_DAYS} 日以上・v${FIRST_TIMER_FASTEST_RANKING_MIN_VERSION} 以上・特権ロール/Bot 除外・全 ${totalCount} 件）から、通算日数（起票→マージ）が短い上位 ${items.length} 件を表示しています。
    </p>
    <div style="overflow-x: auto;">
      <table>
        <thead>
          <tr>
            <th>順位</th>
            <th>PR 番号</th>
            <th>コミット数</th>
            <th>通算日数</th>
            <th>最終コミット後</th>
            <th>成立後</th>
            <th>起票日時 (JST)</th>
            <th>マージ日時 (JST)</th>
            <th>タイトル</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </div>`;
}

/** 直近サンプル配列（最新 30 件等）から算出する通過ペースのリアルタイム指標 */
export interface RecentSamplesPaceSummary {
  totalCount: number;
  firstTimerCount: number;
  firstTimerMedianDays: number | null;
  sameConditionCount: number;
  sameConditionMedianDays: number | null;
  singleCommitCount: number;
  singleCommitRatePct: number | null;
  singleCommitMedianDays: number | null;
  multiCommitCount: number;
  multiCommitMedianDays: number | null;
}

function calcTotalDaysMedian(samples: readonly ProgressSnapshotSample[]): number | null {
  const values = samples.map((s) => s.TotalDays).filter((v) => Number.isFinite(v));
  return values.length > 0 ? getPercentile(values, 0.5) : null;
}

/** 直近表示サンプルから「初回のみ P50」「同条件（初回×1コミット）P50」「手直し有無比較」を集計する */
export function summarizeRecentSamplesPace(
  samples: readonly ProgressSnapshotSample[],
): RecentSamplesPaceSummary {
  const totalCount = samples.length;
  const firstTimerSamples = samples.filter((s) => s.IsFirstTimer === true);
  const sameConditionSamples = firstTimerSamples.filter((s) => s.CommitCount === 1);
  const singleCommitSamples = samples.filter((s) => s.CommitCount === 1);
  const multiCommitSamples = samples.filter((s) => s.CommitCount > 1);

  return {
    totalCount,
    firstTimerCount: firstTimerSamples.length,
    firstTimerMedianDays: calcTotalDaysMedian(firstTimerSamples),
    sameConditionCount: sameConditionSamples.length,
    sameConditionMedianDays: calcTotalDaysMedian(sameConditionSamples),
    singleCommitCount: singleCommitSamples.length,
    singleCommitRatePct:
      totalCount > 0 ? Math.round((singleCommitSamples.length / totalCount) * 100) : null,
    singleCommitMedianDays: calcTotalDaysMedian(singleCommitSamples),
    multiCommitCount: multiCommitSamples.length,
    multiCommitMedianDays: calcTotalDaysMedian(multiCommitSamples),
  };
}

/** `MM/DD → MM/DD` 形式の起票・マージ範囲と、基準 PR 起票日との JST 暦日差表記を算出する */
export function formatCreatedToMergedRange(
  createdAt: string | undefined,
  mergedAt: string,
  targetCreatedAtMs: number | null,
): {
  rangeText: string;
  diffText: string;
  isOvertakenByCreated: boolean | null;
} {
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const mergedMs = Date.parse(mergedAt);
  const createdMd = Number.isFinite(createdMs) ? formatMonthDay(createdMs) : "-";
  const mergedMd = Number.isFinite(mergedMs) ? formatMonthDay(mergedMs) : "-";
  const rangeText = `${createdMd} → ${mergedMd}`;

  if (
    targetCreatedAtMs === null ||
    !Number.isFinite(targetCreatedAtMs) ||
    !Number.isFinite(createdMs)
  ) {
    return { rangeText, diffText: "", isOvertakenByCreated: null };
  }

  const diffDays = toJstEpochDay(createdMs) - toJstEpochDay(targetCreatedAtMs);
  const diffText =
    diffDays === 0
      ? "基準と同日"
      : diffDays > 0
        ? `基準より +${diffDays}日`
        : `基準より ${diffDays}日`;

  return {
    rangeText,
    diffText,
    isOvertakenByCreated: createdMs > targetCreatedAtMs,
  };
}

const SAMPLE_FILTER_INLINE_SCRIPT = `<script>
(() => {
  for (const section of document.querySelectorAll("[data-samples-section]")) {
    const buttons = section.querySelectorAll("[data-sample-filter]");
    const rows = section.querySelectorAll("tbody tr[data-first-timer]");
    const emptyEl = section.querySelector("[data-samples-empty]");
    const tableEl = section.querySelector("table");
    for (const btn of buttons) {
      btn.addEventListener("click", () => {
        const filter = btn.getAttribute("data-sample-filter") || "all";
        for (const b of buttons) {
          const active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", active ? "true" : "false");
        }
        let visible = 0;
        for (const row of rows) {
          const isFt = row.getAttribute("data-first-timer") === "true";
          const commits = Number(row.getAttribute("data-commit-count"));
          const show =
            filter === "all" ||
            (filter === "first-timer" && isFt) ||
            (filter === "first-timer-single" && isFt && commits === 1);
          row.style.display = show ? "" : "none";
          if (show) visible++;
        }
        if (tableEl) tableEl.style.display = visible === 0 ? "none" : "";
        if (emptyEl) emptyEl.style.display = visible === 0 ? "block" : "none";
      });
    }
  }
})();
</script>`;

/** 比較に使ったマージ済みサンプルの一覧 */
export function renderSamplesSection(
  progress: LatestProgress | null,
  repo: string,
  targetCreatedAtMs: number | null = null,
): string {
  const samples = progress?.Samples ?? [];
  if (samples.length === 0) return "";
  // 一覧は新しい順の一部（スナップショットの上限）。統計に使った総数は SampleCount
  const total = Math.max(progress?.SampleCount ?? 0, samples.length);
  const pace = summarizeRecentSamplesPace(samples);

  const rows = samples
    .map((sample) => {
      const isFirstTimer = sample.IsFirstTimer === true;
      const isSameCondition = isFirstTimer && sample.CommitCount === 1;
      const cohortBadge = isFirstTimer
        ? '<span class="badge sample-nowrap" style="background: #dcfce7; color: #15803d; font-weight: 600;">🌱 初回</span>'
        : sample.IsFirstTimer === false
          ? '<span class="badge sample-nowrap" style="background: var(--code-bg); color: var(--text-muted); font-weight: 500;">⚡ 常連</span>'
          : '<span class="sample-nowrap" style="color: var(--text-muted); font-size: 0.75rem; border-bottom: 1px dashed var(--border-color);">⏳ 未判定</span>';

      const rowClass = isSameCondition
        ? ' class="sample-row-same-condition"'
        : isFirstTimer
          ? ' class="sample-row-first-timer"'
          : "";

      const { displayName, fullTitle } = formatSamplePackageName(sample.Title);
      const { rangeText, diffText, isOvertakenByCreated } = formatCreatedToMergedRange(
        sample.CreatedAt,
        sample.MergedAt,
        targetCreatedAtMs,
      );
      const isOvertaken =
        isOvertakenByCreated !== null ? isOvertakenByCreated : sample.Relation === "newer";
      const overtakenBadge = isOvertaken
        ? '<span class="badge sample-nowrap" style="background: #fef3c7; color: #b45309; font-size: 0.7rem; padding: 0.1rem 0.45rem;" title="基準 PR より後に起票された追い越し PR">⚡後発</span>'
        : "";
      const pkgHtml = displayName
        ? `<div title="${escapeHtml(fullTitle)}" style="font-size: 0.8rem; color: var(--text-color); margin-top: 0.15rem; word-break: break-word;">${escapeHtml(displayName)}</div>`
        : "";
      const commitLabel = `${escapeHtml(sample.CommitCount)}回`;
      const commitStyle = isSameCondition
        ? "font-size: 0.8rem; color: var(--success); font-weight: 700;"
        : "font-size: 0.8rem; color: var(--text-muted); font-weight: 500;";

      return `
        <tr${rowClass} data-first-timer="${isFirstTimer ? "true" : "false"}" data-commit-count="${escapeHtml(sample.CommitCount)}">
          <td>
            <div style="display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap;">
              <a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(sample.Number)}" target="_blank" rel="noopener noreferrer" style="font-weight: 600; white-space: nowrap;">#${escapeHtml(sample.Number)}</a>
              ${overtakenBadge}
            </div>
            ${pkgHtml}
          </td>
          <td class="sample-nowrap">
            <div style="display: inline-flex; align-items: center; gap: 0.4rem; white-space: nowrap;">
              ${cohortBadge}
              <span style="${commitStyle}">${commitLabel}</span>
            </div>
          </td>
          <td class="sample-nowrap">
            <div style="font-weight: 500; white-space: nowrap;">${escapeHtml(rangeText)}</div>
            ${diffText ? `<div style="font-size: 0.75rem; color: var(--text-muted); white-space: nowrap;">${escapeHtml(diffText)}</div>` : ""}
          </td>
          <td class="sample-nowrap">${sample.TotalDays.toFixed(1)} 日</td>
          <td class="sample-nowrap">${sample.TurnDays.toFixed(1)} 日</td>
          <td class="sample-nowrap">${sample.ReadyDays.toFixed(1)} 日</td>
        </tr>`;
    })
    .join("");

  return `
    <div data-samples-section>
      <h2 class="section-title">🧪 比較に使ったサンプル（${total} 件）</h2>
      <div class="samples-summary-grid" aria-label="直近サンプルの通過ペース">
        <div class="samples-summary-card" style="border-top: 3px solid var(--success);">
          <div class="card-title" style="margin-bottom: 0.25rem;">🌱 初回のみ（直近出口 P50）</div>
          <div style="font-size: 1.35rem; font-weight: 700;">${pace.firstTimerMedianDays !== null ? `${pace.firstTimerMedianDays.toFixed(1)} 日` : "-"}</div>
          <div class="card-subtext">直近 ${pace.totalCount} 件中の該当: <strong>${pace.firstTimerCount}</strong> 件</div>
        </div>
        <div class="samples-summary-card" style="border-top: 3px solid var(--primary);">
          <div class="card-title" style="margin-bottom: 0.25rem;">🎯 同条件（初回 × 1 コミット）P50</div>
          <div style="font-size: 1.35rem; font-weight: 700;">${pace.sameConditionMedianDays !== null ? `${pace.sameConditionMedianDays.toFixed(1)} 日` : "-"}</div>
          <div class="card-subtext">手直しなし初回提出者: <strong>${pace.sameConditionCount}</strong> 件</div>
        </div>
        <div class="samples-summary-card">
          <div class="card-title" style="margin-bottom: 0.25rem;">✏️ 手直し有無の比較（直近サンプル内）</div>
          <div style="font-size: 1.05rem; font-weight: 700;">1コミット完走率: ${pace.singleCommitRatePct !== null ? `${pace.singleCommitRatePct}%` : "-"} <span style="font-size: 0.8rem; font-weight: 500; color: var(--text-muted);">(${pace.singleCommitCount}/${pace.totalCount} 件)</span></div>
          <div class="card-subtext">1コミット P50: <strong>${pace.singleCommitMedianDays !== null ? `${pace.singleCommitMedianDays.toFixed(1)} 日` : "-"}</strong> vs 複数コミット P50: <strong>${pace.multiCommitMedianDays !== null ? `${pace.multiCommitMedianDays.toFixed(1)} 日` : "-"}</strong></div>
        </div>
      </div>
      <details open style="margin-bottom: 2rem;">
        <summary style="cursor: pointer; color: var(--text-muted); font-size: 0.875rem; margin-bottom: 0.75rem;">マージ日時の新しい順に${total > samples.length ? ` ${samples.length} 件` : ""}表示</summary>
        <div class="sample-filter-bar" role="group" aria-label="比較サンプルの絞り込み">
          <button type="button" class="sample-filter-btn is-active" data-sample-filter="all" aria-pressed="true">すべて <span class="sample-filter-count">(${pace.totalCount})</span></button>
          <button type="button" class="sample-filter-btn" data-sample-filter="first-timer" aria-pressed="false">🌱 初回のみ <span class="sample-filter-count">(${pace.firstTimerCount})</span></button>
          <button type="button" class="sample-filter-btn" data-sample-filter="first-timer-single" aria-pressed="false">🎯 同条件: 初回×1コミット <span class="sample-filter-count">(${pace.sameConditionCount})</span></button>
        </div>
        <div style="overflow-x: auto;">
          <table class="sample-table">
            <thead>
              <tr>
                <th>PR / パッケージ</th>
                <th class="sample-nowrap">コホート / コミット</th>
                <th class="sample-nowrap">起票 → マージ（起票日差）</th>
                <th class="sample-nowrap">通算日数</th>
                <th class="sample-nowrap">レビュー待ち</th>
                <th class="sample-nowrap">成立後</th>
              </tr>
            </thead>
            <tbody>${rows}
            </tbody>
          </table>
        </div>
        <p data-samples-empty style="display: none; color: var(--text-muted); font-size: 0.875rem; padding: 1rem; text-align: center; background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 0.75rem; margin-bottom: 1.5rem;">該当するサンプルはありません</p>
      </details>
      <p class="section-note">待機はラベルと Draft の履歴に基づきます。候補検索は現在の必須ラベルを使うため、マージ後にそれらが外れた PR は含まれません。</p>
      ${SAMPLE_FILTER_INLINE_SCRIPT}
    </div>`;
}
