// 所要日数統計・初回提出者コホート実績・追い越し比較・ライバル PR・マージ済みサンプル一覧の描画セクション

import { describeGuidance, describeOvertake } from "../../../src/domain/benchmark";
import { DAY_MS, formatDateTimeWithDay, round1 } from "../../../src/domain/formatters";
import type { ReferenceGuidance } from "../../../src/models/progress";
import { escapeHtml, formatDaysStat } from "../formatters";
import type { LatestProgress } from "../types";

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
        <div class="card-title" style="font-size: 1rem; font-weight: 700; color: var(--success); margin-bottom: 0;">🌱 初回提出者コホート実績（純粋FIFO待機列）</div>
        <span class="badge" style="background: #dcfce7; color: #15803d; font-weight: 600;">過去 ${firstTimerDays} 日間・採用 ${count} 件</span>
      </div>
      <p class="section-note" style="margin-bottom: 0.75rem;">
        常連の大量まとめマージや特急レーンを除外した「初回提出者（生涯マージ1件・阻害ラベルや Draft 履歴のない初期健康体）」の実績です。手直しコミットを含む初回提出者全体の「通算所要日数（起票→マージ）」と「最終コミット後所要日数（Turn Latency）」の両方を集計しています。
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

/** 比較に使ったマージ済みサンプルの一覧（折りたたみ） */
export function renderSamplesSection(progress: LatestProgress | null, repo: string): string {
  const samples = progress?.Samples ?? [];
  if (samples.length === 0) return "";
  // 一覧は新しい順の一部（スナップショットの上限）。統計に使った総数は SampleCount
  const total = Math.max(progress?.SampleCount ?? 0, samples.length);
  const rows = samples
    .map((sample) => {
      const cohortBadge =
        sample.IsFirstTimer === true
          ? '<span class="badge" style="background: #dcfce7; color: #15803d; font-weight: 600;">🌱 初回</span>'
          : sample.IsFirstTimer === false
            ? '<span class="badge" style="background: var(--code-bg); color: var(--text-muted); font-weight: 500;">⚡ 常連</span>'
            : '<span style="color: var(--text-muted); font-size: 0.75rem; border-bottom: 1px dashed var(--border-color);">⏳ 未判定</span>';
      const rowStyle =
        sample.IsFirstTimer === true ? ' style="background: rgba(22, 163, 74, 0.04);"' : "";
      return `
        <tr${rowStyle}>
          <td><a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(sample.Number)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(sample.Number)}</a></td>
          <td>${sample.Relation === "older" ? "古い" : "新しい"}</td>
          <td>${escapeHtml(sample.CommitCount)}</td>
          <td>${sample.TurnDays.toFixed(1)} 日</td>
          <td>${sample.TotalDays.toFixed(1)} 日</td>
          <td>${sample.ReadyDays.toFixed(1)} 日</td>
          <td>${cohortBadge}</td>
          <td>${escapeHtml(formatDateTimeWithDay(sample.LatestCommittedDate))}</td>
          <td>${escapeHtml(formatDateTimeWithDay(sample.MergedAt))}</td>
        </tr>`;
    })
    .join("");
  return `
    <h2 class="section-title">🧪 比較に使ったサンプル（${total} 件）</h2>
    <details style="margin-bottom: 2rem;">
      <summary style="cursor: pointer; color: var(--text-muted); font-size: 0.875rem; margin-bottom: 0.75rem;">マージ日時の新しい順に${total > samples.length ? ` ${samples.length} 件` : ""}表示</summary>
      <table>
        <thead>
          <tr>
            <th>PR 番号</th>
            <th>作成順</th>
            <th>コミット数</th>
            <th>レビュー待ち</th>
            <th>通算日数</th>
            <th>成立後</th>
            <th>コホート</th>
            <th>最新コミット (JST)</th>
            <th>マージ (JST)</th>
          </tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </details>
    <p class="section-note">待機はラベルと Draft の履歴に基づきます。候補検索は現在の必須ラベルを使うため、マージ後にそれらが外れた PR は含まれません。</p>`;
}
