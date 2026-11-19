// 所要日数統計・初回提出者コホート実績・追い越し比較・ライバル PR・マージ済みサンプル一覧の描画セクション

import { describeGuidance, describeOvertake } from "../../../src/domain/benchmark";
import {
  DAY_MS,
  formatDateTimeWithDay,
  formatMonthDay,
  round1,
  toJstEpochDay,
} from "../../../src/domain/formatters";
import { getPercentile } from "../../../src/domain/progress";
import type { ProgressSnapshotSample, ReferenceGuidance } from "../../../src/models/progress";
import type { FirstTimerFastestRanking } from "../../../src/models/sample-cache";
import { escapeHtml, formatDaysStat, formatSamplePackageName } from "../formatters";
import type { LatestProgress } from "../types";

export { formatSamplePackageName };

/** 実績サンプルが少なく、数値が揺れやすいとみなす件数 */
const FEW_SAMPLES = 10;

/** 日数統計カード（中央値・75%点・最大）と、基準 PR の現在値の位置づけ */
export function renderStatCard(
  title: string,
  stats: { median?: number | null; p75?: number | null; max?: number | null },
  currentDays: number | string | undefined,
  guidance: ReferenceGuidance | undefined,
  description: string,
  formatHumanDays: (days: number) => string,
): string {
  const position = guidance
    ? `<div class="card-subtext">${escapeHtml(describeGuidance(guidance, formatHumanDays))} サンプルの ${guidance.ShorterSharePct}% はこれより短い期間でマージ済み</div>`
    : "";
  return `
      <div class="card stat-card">
        <div class="card-title">${title}</div>
        <div class="card-value" style="font-size: 1.15rem; display: flex; flex-wrap: wrap; column-gap: 0.75rem;">
          <span style="white-space: nowrap;">P50: ${formatDaysStat(stats.median)}</span>
          <span style="white-space: nowrap;">P75: ${formatDaysStat(stats.p75)}</span>
          <span style="white-space: nowrap;">最大: ${formatDaysStat(stats.max)}</span>
        </div>
        <div class="card-subtext">${description}</div>
        <div class="card-subtext">基準 PR の現在: <strong>${escapeHtml(currentDays)}</strong> 日</div>
        ${position}
      </div>`;
}

/** 初回提出者コホート実績ブロック（常連・特急レーンを除外した真の初回提出者） */
export function renderFirstTimerCohortBlock(progress: LatestProgress | null): string {
  if (
    !progress ||
    progress.FirstTimerMedianDays === undefined ||
    progress.FirstTimerMedianDays === null
  ) {
    return "";
  }
  const count = progress.FirstTimerSampleCount ?? 0;
  const firstTimerDays = progress.FirstTimerLookbackDays ?? progress.LookbackDays ?? 90;
  return `
    <div class="card" style="border-left: 5px solid var(--success); margin-bottom: 1.5rem; background: var(--card-bg);">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem;">
        <div class="card-title" style="font-size: 1rem; font-weight: 700; color: var(--success); margin-bottom: 0;">🌱 初回提出者コホート実績（生涯マージ1件）</div>
        <span class="badge" style="background: #dcfce7; color: #15803d; font-weight: 600;">過去 ${firstTimerDays} 日間・採用 ${count} 件</span>
      </div>
      <p class="section-note" style="margin-bottom: 0.75rem;">
        常連の大量まとめマージや特急レーンを除外した「生涯マージ1件の初回提出者（手直し・ラベル履歴を含む）」の実績です。初回提出者全体の「通算所要日数（起票→マージ）」と「最終コミット後所要日数（Turn Latency）」の両方を集計しています。
      </p>
      <div style="display: flex; flex-wrap: wrap; gap: 1.5rem; align-items: baseline;">
        <div>
          <span style="font-size: 0.8rem; color: var(--text-muted); display: block;">通算 P50 (中央値)</span>
          <span style="font-size: 1.5rem; font-weight: 700;">${formatDaysStat(progress.FirstTimerMedianDays)}</span>
        </div>
        <div>
          <span style="font-size: 0.8rem; color: var(--text-muted); display: block;">通算 P75 (75%点)</span>
          <span style="font-size: 1.5rem; font-weight: 700;">${formatDaysStat(progress.FirstTimerP75Days)}</span>
        </div>
        <div>
          <span style="font-size: 0.8rem; color: var(--text-muted); display: block;">最終コミット後 P50</span>
          <span style="font-size: 1.5rem; font-weight: 700;">${formatDaysStat(progress.FirstTimerTurnMedianDays)}</span>
        </div>
        <div>
          <span style="font-size: 0.8rem; color: var(--text-muted); display: block;">最終コミット後 P75</span>
          <span style="font-size: 1.5rem; font-weight: 700;">${formatDaysStat(progress.FirstTimerTurnP75Days)}</span>
        </div>
        <div style="margin-left: auto; align-self: center;">
          <div class="card-subtext">基準 PR 通算: <strong>${escapeHtml(progress.TotalLifetimeDays)}</strong> 日</div>
          <div class="card-subtext">基準 PR Turn: <strong>${escapeHtml(progress.TurnLatencyDays)}</strong> 日</div>
        </div>
      </div>
    </div>`;
}

/** マージ実績の所要日数統計セクション全体を描画する */
export function renderDurationStatsSection(
  progress: LatestProgress | null,
  formatHumanDays: (days: number) => string,
): string {
  return `<h2 class="section-title">⏱️ マージ実績の所要日数統計 (直近 ${escapeHtml(progress?.LookbackDays ?? 30)} 日間${progress?.SampleCount === undefined ? "" : ` / 採用 ${progress.SampleCount} 件・除外 ${progress.SkippedCount ?? 0} 件`})</h2>
    ${
      progress?.SampleCount !== undefined && progress.SampleCount < FEW_SAMPLES
        ? `<p class="section-note">※ サンプルが少ないため、数値は変動しやすくなっています。</p>`
        : ""
    }
    ${renderFirstTimerCohortBlock(progress)}

    <h3 class="subsection-title" style="font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem; color: var(--text-muted);">👥 全体実績（常連・特急レーンを含む全サンプル）</h3>
    <p class="section-note">常連のまとめマージや特急レーンを含むため、ばらつきが大きくなります。除外件数は、タイムライン上で Ready 条件（必須3ラベル成立・非Draft・阻害ラベルなし）の到達日時を特定できなかった PR です。</p>
    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 2rem;">${renderStatCard(
      "手番所要日数 (Turn Latency)",
      { median: progress?.TurnMedianDays, p75: progress?.TurnP75Days, max: progress?.TurnMaxDays },
      progress?.TurnLatencyDays,
      progress?.Guidance?.Turn,
      "最新コミットからマージされるまでの日数（修正後の再レビュー待ち）",
      formatHumanDays,
    )}${renderStatCard(
      "Ready 成立後所要日数 (Ready Latency)",
      {
        median: progress?.ReadyMedianDays,
        p75: progress?.ReadyP75Days,
        max: progress?.ReadyMaxDays,
      },
      progress?.WaitDays,
      progress?.Guidance?.Ready,
      "CI 通過および必須ラベル成立からマージされるまでの日数",
      formatHumanDays,
    )}${renderStatCard(
      "通算所要日数 (Total Lifetime)",
      {
        median: progress?.TotalMedianDays,
        p75: progress?.TotalP75Days,
        max: progress?.TotalMaxDays,
      },
      progress?.TotalLifetimeDays,
      progress?.Guidance?.Total,
      "PR 起票からマージ完了までの全期間の所要日数",
      formatHumanDays,
    )}
    </div>`;
}

/** 追い越しの比較（採用サンプル内で、基準 PR より後に作成・成立してマージされた件数） */
export function renderOvertakeSection(progress: LatestProgress | null): string {
  const c = progress?.Comparison;
  if (!c) return "";
  const noteColor = c.Verdict === "overtaken" ? "var(--danger)" : "var(--text-muted)";
  const unknownDetail =
    c.UnknownLaterCreated !== undefined && c.UnknownLaterCreated > 0
      ? ` / 未判定: <strong>${c.UnknownLaterCreated}</strong> 件`
      : "";
  const overtakeDetail =
    c.FirstTimerLaterCreated !== undefined && c.RepeatOrExpressLaterCreated !== undefined
      ? `<div class="card-subtext" style="margin-top: 0.2rem;">うち初回提出者: <strong>${c.FirstTimerLaterCreated}</strong> 件 / 常連・特急レーン: <strong>${c.RepeatOrExpressLaterCreated}</strong> 件${unknownDetail}</div>`
      : "";
  return `
    <h2 class="section-title">🏃 追い越しの比較（採用サンプル内）</h2>
    <p class="section-note">
      直近にマージされた PR のうち、基準 PR と比べた件数です（全期間の件数ではありません）。
    </p>
    <table>
      <thead>
        <tr><th>比較</th><th>件数</th></tr>
      </thead>
      <tbody>
        <tr><td>自分より後に作成され、マージ済み（追い越し）</td><td><strong>${c.LaterCreated}</strong> 件${overtakeDetail}</td></tr>
        <tr><td>自分より前に作成され、マージ済み</td><td>${c.EarlierCreated} 件</td></tr>
        <tr><td>自分より後に条件が整い（ReadyAt）、マージ済み</td><td>${c.LaterReady} 件</td></tr>
      </tbody>
    </table>
    <p class="section-note" style="color: ${noteColor};">※ ${escapeHtml(describeOvertake(c))}</p>`;
}

/** 直前のライバル PR（作成順で基準 PR の直前に並ぶ健康な未マージ PR） */
export function renderRivalsSection(progress: LatestProgress | null): string {
  const rivals = progress?.Rivals ?? [];
  if (rivals.length === 0) return "";
  const observedMs = Date.parse(progress?.Timestamp ?? "");
  const rows = rivals
    .map((r) => {
      const updatedMs = Date.parse(r.UpdatedAt);
      const idle =
        Number.isNaN(observedMs) || Number.isNaN(updatedMs)
          ? "-"
          : `${round1((observedMs - updatedMs) / DAY_MS)} 日`;
      return `
        <tr>
          <td><a href="${escapeHtml(r.Url)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(r.Number)}</a></td>
          <td>${escapeHtml(formatDateTimeWithDay(r.CreatedAt))}</td>
          <td>${escapeHtml(formatDateTimeWithDay(r.UpdatedAt))}</td>
          <td>${idle}</td>
          <td>${escapeHtml(r.Title)}</td>
        </tr>`;
    })
    .join("");
  return `
    <h2 class="section-title">🥊 直前のライバル PR（TOP ${rivals.length}）</h2>
    <p class="section-note">
      作成順で基準 PR の直前に並ぶ健康な未マージ PR です。更新が止まっているほど、順番待ちに徹している PR と読めます。
    </p>
    <table>
      <thead>
        <tr>
          <th>PR 番号</th>
          <th>起票 (JST)</th>
          <th>最終更新 (JST)</th>
          <th>更新からの経過</th>
          <th>タイトル</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;
}

/** 初回提出者限定の最速マージランキング（蓄積全件 TOP 10） */
export function renderFirstTimerFastestRankingSection(
  ranking: FirstTimerFastestRanking | undefined,
  repo: string,
): string {
  const totalCount = ranking?.totalCount ?? 0;
  const items = ranking?.items ?? [];

  if (items.length === 0) {
    return `
    <h2 class="section-title">🏆 初回提出者 最速マージランキング（蓄積全件 TOP 10）</h2>
    <p class="section-note">蓄積サンプル内の初回提出者: 0 件</p>
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
    <h2 class="section-title">🏆 初回提出者 最速マージランキング（蓄積全件 TOP 10）</h2>
    <p class="section-note">
      蓄積サンプル内の初回提出者（全 ${totalCount} 件）から、通算日数（起票→マージ）が短い上位 ${items.length} 件を表示しています。
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
