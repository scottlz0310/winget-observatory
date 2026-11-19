// 統合処理バンドヒーローカード・KPI グリッド・トリアージフロー図の描画セクション

import { formatJstDate, formatMonthDay } from "../../../src/domain/formatters";
import type { DashboardCalculatedMetrics } from "../../../src/models/dashboard";
import type { FirstReviewForecast } from "../../../src/models/forecast";
import type { ForecastBandSnapshot } from "../../../src/models/forecast-band";
import type { ForecastComparison, HypothesisId } from "../../../src/models/forecast-comparison";
import { escapeHtml, formatEtaDays, formatNumber, renderBadgeHtml } from "../formatters";
import type { DeltaBadge, LatestProgress } from "../types";

const HYPOTHESIS_STYLE: Record<HypothesisId, { mark: string; color: string }> = {
  "rank-velocity": { mark: "①", color: "var(--primary)" },
  "creation-order": { mark: "②", color: "var(--success)" },
};

function formatTargetInterventionLabel(forecast: FirstReviewForecast): string {
  if (forecast.targetIntervention?.PrimaryBadge?.Label) {
    return forecast.targetIntervention.PrimaryBadge.Label;
  }
  if (forecast.targetAssignees.length > 0) {
    return `アサイン済: ${forecast.targetAssignees.join(", ")}`;
  }
  return "介入あり";
}

function formatDateRange(startMs: number, endMs: number): string {
  return startMs === endMs
    ? escapeHtml(formatJstDate(startMs))
    : `${escapeHtml(formatJstDate(startMs))} 〜 ${escapeHtml(formatJstDate(endMs))}`;
}

function formatEtaRange(minDays: number, maxDays: number): string {
  return minDays === maxDays ? formatEtaDays(minDays) : `残り約 ${minDays} 〜 ${maxDays} 日`;
}

/** 統合処理バンドタイムライン SVG 用のマーカーデータを抽出する */
export function buildBandTimelineMarkers(
  band: ForecastBandSnapshot,
): Array<{ label: string; dateMs: number; color: string }> {
  const markers: Array<{ label: string; dateMs: number; color: string }> = [];
  if (band.front) {
    markers.push({
      label: `▼前線 ${formatMonthDay(band.front.dateMs)}`,
      dateMs: band.front.dateMs,
      color: "var(--success)",
    });
  }
  if (band.mainstream) {
    markers.push({
      label: `★本命 ${formatMonthDay(band.mainstream.medianDateMs)}`,
      dateMs: band.mainstream.medianDateMs,
      color: "var(--primary)",
    });
  }
  if (band.bottom) {
    markers.push({
      label: `▼大底 ${formatMonthDay(band.bottom.dateMs)}`,
      dateMs: band.bottom.dateMs,
      color: "var(--warning)",
    });
  }
  return markers;
}

function renderTwoHypothesesTable(comparison: ForecastComparison): string {
  const rows = comparison.hypotheses
    .map((h) => {
      const bar =
        h.progressRatio === null
          ? ""
          : `<div class="progress-bar" role="img" aria-label="進捗 ${Math.round(h.progressRatio * 100)}%"><div style="width: ${Math.round(h.progressRatio * 100)}%;"></div></div>`;
      const estimates =
        h.estimates.length === 0
          ? `<span style="color: var(--text-muted);">予想できません</span>`
          : h.estimates
              .map(
                (e) =>
                  `<div style="margin-bottom: 0.4rem;"><span style="white-space: nowrap;"><strong>${escapeHtml(formatJstDate(e.dateMs))}</strong> <span style="color: var(--text-muted);">（${formatEtaDays(e.etaDays)}）</span></span><div class="card-subtext" style="margin-top: 0;">${escapeHtml(e.label)}</div></div>`,
              )
              .join("");
      return `
        <tr>
          <td><strong style="color: ${HYPOTHESIS_STYLE[h.id].color};">${escapeHtml(h.title)}</strong><div class="card-subtext">${escapeHtml(h.premise)}</div></td>
          <td>${escapeHtml(h.progressText)}${bar}${h.note ? `<div class="card-subtext">${escapeHtml(h.note)}</div>` : ""}</td>
          <td>${estimates}</td>
        </tr>`;
    })
    .join("");

  return `
    <div style="overflow-x: auto; margin-top: 0.75rem;">
      <table style="margin-bottom: 0;">
        <thead>
          <tr><th style="width: 30%;">仮説と前提</th><th>現在の進捗</th><th style="width: 30%;">予想日</th></tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </div>`;
}

function renderHeroStatusGrid(params: {
  progress: LatestProgress | null;
  band: ForecastBandSnapshot;
  repo: string;
}): string {
  const { progress, band, repo } = params;
  const { firstReview } = band.snapshot;

  // 1. メンテナー作業前線（7日初回介入中央値）
  let mainstreamHeadHtml = `<span style="color: var(--text-muted);">データ不足</span>`;
  let mainstreamSubHtml = "直近 7 日間の初回介入コホート 0 件または未観測";
  if (firstReview.frontier) {
    mainstreamHeadHtml = `${escapeHtml(formatJstDate(firstReview.frontier.createdMs))} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">（経過 ${firstReview.lagDays ?? "-"} 日）</span>`;
    const cohortSummary = `7日初回介入 ${firstReview.frontier.cohortCount}件 [Open ${firstReview.frontier.openCount} / Merged ${firstReview.frontier.mergedCount}]`;
    if (firstReview.status === "target-intervened") {
      mainstreamSubHtml = `到達済み（${escapeHtml(formatTargetInterventionLabel(firstReview))}） / ${cohortSummary}`;
    } else if (firstReview.status === "reached") {
      mainstreamSubHtml = `基準 PR の起票日ラインに到達済み / ${cohortSummary}`;
    } else if (firstReview.status === "steady" && firstReview.steadyDateMs !== null) {
      mainstreamSubHtml = `自PRと差 ${firstReview.gapDays} 日（定常 1.0 日/日換算: ${escapeHtml(formatJstDate(firstReview.steadyDateMs))}） / ${cohortSummary}`;
    } else {
      mainstreamSubHtml = `基準 PR の起票日時が不明 / ${cohortSummary}`;
    }
  } else if (firstReview.status === "target-intervened") {
    mainstreamHeadHtml = `<span style="color: var(--success);">介入済み</span>`;
    mainstreamSubHtml = `${escapeHtml(formatTargetInterventionLabel(firstReview))}（主戦場ラインは未観測）`;
  }

  // 2. 1コミット優等生の底
  const staleHtml =
    band.snapshot.staleBottomCreatedMs !== null
      ? `<a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(band.snapshot.staleBottomPr)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(band.snapshot.staleBottomPr)}</a> ${escapeHtml(formatJstDate(band.snapshot.staleBottomCreatedMs))}`
      : `<span style="color: var(--text-muted);">-</span>`;
  const staleSubHtml =
    band.snapshot.staleBottomGapDays !== null
      ? `自PRと差 ${band.snapshot.staleBottomGapDays} 日（1コミット健康体最古）`
      : "優等生の底データ未観測";

  // 3. 実質待ち順位 / 健康的大底とのギャップ
  const healthyPr = band.snapshot.healthyBottomPr;
  const healthyGap = band.snapshot.healthyBottomGapDays;
  const queueSubHtml =
    healthyGap !== null
      ? `健康的大底（${healthyPr ? `#${escapeHtml(healthyPr)}` : "-"}）と差 ${healthyGap} 日`
      : "健康的大底との日差は未算出";

  // 4. 初回提出者コホート実績サマリ
  const rawLifetime = progress?.TotalLifetimeDays ?? progress?.WaitDays ?? 0;
  const parsedLifetime = Number(rawLifetime);
  const currentLifetime = Number.isFinite(parsedLifetime) ? parsedLifetime : 0;
  const firstTimerDays = progress?.FirstTimerLookbackDays ?? progress?.LookbackDays ?? 90;
  const ftSampleCount = progress?.FirstTimerSampleCount ?? 0;
  const p50 = progress?.FirstTimerMedianDays;
  const p75 = progress?.FirstTimerP75Days;
  const turnLine =
    progress?.FirstTimerTurnMedianDays !== undefined && progress?.FirstTimerTurnMedianDays !== null
      ? `<div class="card-subtext">最終コミット後 (Turn): <strong>${progress.FirstTimerTurnMedianDays}</strong> 日${progress.FirstTimerTurnP75Days !== undefined && progress.FirstTimerTurnP75Days !== null ? ` / P75: <strong>${progress.FirstTimerTurnP75Days}</strong> 日` : ""}</div>`
      : "";

  return `
    <div class="hero-status-grid" aria-label="現在の処理帯ステータス">
      <div class="hero-status-item">
        <div style="font-size: 0.75rem; color: var(--text-muted);">👀 メンテナー作業前線（7日介入中央値）</div>
        <div style="font-size: 1.05rem; font-weight: 700; margin-top: 0.15rem;">${mainstreamHeadHtml}</div>
        <div class="card-subtext">${mainstreamSubHtml}</div>
      </div>
      <div class="hero-status-item">
        <div style="font-size: 0.75rem; color: var(--text-muted);">🧗 1コミット優等生の底</div>
        <div style="font-size: 1.05rem; font-weight: 700; margin-top: 0.15rem;">${staleHtml}</div>
        <div class="card-subtext">${escapeHtml(staleSubHtml)}</div>
      </div>
      <div class="hero-status-item">
        <div style="font-size: 0.75rem; color: var(--text-muted);">⚓ 実質待ち順位 / 健康的大底差</div>
        <div style="font-size: 1.05rem; font-weight: 700; margin-top: 0.15rem;">${formatNumber(progress?.ActiveAhead)} <span style="font-size: 0.85rem; font-weight: normal;">件</span></div>
        <div class="card-subtext">${escapeHtml(queueSubHtml)}</div>
      </div>
      <div class="hero-status-item">
        <div style="font-size: 0.75rem; color: var(--text-muted);">🌱 初回提出者コホート実績（過去 ${escapeHtml(firstTimerDays)} 日・${escapeHtml(ftSampleCount)} 件）</div>
        <div style="font-size: 1.05rem; font-weight: 700; margin-top: 0.15rem;">P50: ${p50 ?? "-"} 日 / P75: ${p75 ?? "-"} 日</div>
        <div class="card-subtext">基準 PR 現在: ${escapeHtml(currentLifetime)} 日（生涯マージ1件・手直し込み）</div>
        ${turnLine}
      </div>
    </div>`;
}

/**
 * ページ最上部に置く「統合処理バンド」ヒーローカード
 * 本命中央値予想・全体レンジ（前線〜大底）・タイムライン SVG・現在の処理帯スナップショットを 1 枚に統合表示する
 */
export function renderIntegratedForecastHero(params: {
  targetPrNum: number | string;
  repo: string;
  progress: LatestProgress | null;
  band: ForecastBandSnapshot;
  timelineSvg: string | null;
}): string {
  const { targetPrNum, repo, progress, band, timelineSvg } = params;
  const { front, mainstream, bottom, overallRange, comparison } = band;
  const { firstReview } = band.snapshot;

  let statusBadgeLabel = "算出待ち / データ不足";
  let statusBadgeStyle = "background: var(--code-bg); color: var(--text-muted);";
  if (firstReview.status === "target-intervened") {
    statusBadgeLabel = `基準PR介入済み（${formatTargetInterventionLabel(firstReview)}）`;
    statusBadgeStyle = "background: #dcfce7; color: #15803d;";
  } else if (firstReview.status === "reached") {
    statusBadgeLabel = "主戦場ライン到達済み";
    statusBadgeStyle = "background: #dcfce7; color: #15803d;";
  } else if (mainstream) {
    statusBadgeLabel = "統合処理バンド（定常＋実績）";
    statusBadgeStyle = "background: var(--primary-light); color: var(--primary);";
  }

  const mainstreamHeadline = mainstream
    ? formatDateRange(mainstream.range.startMs, mainstream.range.endMs)
    : `<span style="color: var(--text-muted);">予想できません</span>`;
  const mainstreamEta = mainstream
    ? formatEtaRange(mainstream.range.minDays, mainstream.range.maxDays)
    : "本命バンド算出に必要な観測データが不足しています";
  const mainstreamSub = mainstream
    ? `代表中央値: <strong>${escapeHtml(formatJstDate(mainstream.medianDateMs))}</strong>（${formatEtaDays(mainstream.medianEtaDays)}） / 採用指標 ${mainstream.estimates.length} 件`
    : "通常は全体P50・初回P75・順位消化・主戦場定常換算から算出します";

  const overallHeadline = overallRange
    ? `${escapeHtml(formatMonthDay(overallRange.startMs))}（最短） 〜 ${escapeHtml(formatMonthDay(overallRange.endMs))}（最長）`
    : `<span style="color: var(--text-muted);">-</span>`;
  const overallEta = overallRange
    ? formatEtaRange(overallRange.minDays, overallRange.maxDays)
    : "観測データ不足";
  const frontSummaryText = front
    ? `前線: ${escapeHtml(formatMonthDay(front.dateMs))}（${formatEtaDays(front.etaDays)}）`
    : "前線: -";
  const bottomSummaryText = bottom
    ? `大底: ${escapeHtml(formatMonthDay(bottom.dateMs))}（${formatEtaDays(bottom.etaDays)}）`
    : "大底: -";

  const bandBreakdownRows = [
    ...(front ? [{ group: "前線（最短）", items: front.estimates }] : []),
    ...(mainstream ? [{ group: "本命（中央値）", items: mainstream.estimates }] : []),
    ...(bottom ? [{ group: "大底（最長）", items: [bottom.estimate] }] : []),
  ]
    .flatMap((g) =>
      g.items.map(
        (item) =>
          `<li><strong>${escapeHtml(g.group)}</strong> — ${escapeHtml(item.label)}: <strong>${escapeHtml(formatJstDate(item.dateMs))}</strong>（${formatEtaDays(item.etaDays)}）</li>`,
      ),
    )
    .join("");

  return `
    <section class="card hero-band-card" aria-label="基準 PR 着地予測（統合処理バンド）">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
        <div class="card-title" style="color: var(--primary); font-weight: 700; font-size: 1.05rem; margin-bottom: 0;">
          🎯 基準 PR #${escapeHtml(targetPrNum)} 着地予測（統合処理バンド）
        </div>
        <span class="badge" style="${statusBadgeStyle}">${escapeHtml(statusBadgeLabel)}</span>
      </div>

      <div class="hero-band-summary">
        <div class="hero-band-box is-mainstream">
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.25rem;">本命予想（中央値バンド）</div>
          <div style="font-size: 1.4rem; font-weight: 700;">${mainstreamHeadline}</div>
          <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.15rem;">${escapeHtml(mainstreamEta)}</div>
          <div class="card-subtext">${mainstreamSub}</div>
        </div>
        <div class="hero-band-box">
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.25rem;">全体レンジ（前線 〜 大底）</div>
          <div style="font-size: 1.25rem; font-weight: 700;">${overallHeadline}</div>
          <div style="font-size: 0.9rem; color: var(--text-muted); margin-top: 0.15rem;">${escapeHtml(overallEta)}</div>
          <div class="card-subtext">${frontSummaryText} / ${bottomSummaryText}</div>
        </div>
      </div>

      ${timelineSvg ? `<div style="margin: 0.75rem 0;">${timelineSvg}</div>` : ""}

      ${renderHeroStatusGrid({ progress, band, repo })}

      <details class="hero-details">
        <summary>🔍 統合処理バンドの内訳と 2 仮説比較（検証用詳細）</summary>
        ${
          bandBreakdownRows
            ? `<ul style="margin: 0.75rem 0 0 1.25rem; font-size: 0.8125rem; color: var(--text-color);">${bandBreakdownRows}</ul>`
            : `<p class="card-subtext" style="margin-top: 0.5rem;">処理バンドの内訳データはまだありません。</p>`
        }
        ${renderTwoHypothesesTable(comparison)}
      </details>

      <div class="card-subtext" style="margin-top: 0.75rem;">
        ※ 主戦場ラインの短期実測速度による割り算外挿を廃止し、現在の処理帯位置（定常 1.0 日/日換算）と実績コホート・168h 順位消化を統合した処理バンドで表示しています。
      </div>
    </section>`;
}

/** 主要 KPI 5 カードグリッドを描画する */
export function renderKpiGridSection(params: {
  progress: LatestProgress | null;
  repo: string;
  metrics: DashboardCalculatedMetrics;
  activeDeltaBadge: DeltaBadge;
  frontDeltaBadge: DeltaBadge;
  behindDeltaBadge: DeltaBadge;
}): string {
  const { progress, repo, metrics, activeDeltaBadge, frontDeltaBadge, behindDeltaBadge } = params;
  return `<div class="grid" style="margin-top: 1.5rem;">
      <div class="card">
        <div class="card-title">実質待ち件数 (更新順の順位)</div>
        <div class="card-value">${formatNumber(progress?.ActiveAhead)} <span style="font-size: 1rem; font-weight: normal;">件</span></div>
        <div class="card-subtext">
          <span>前回比: ${renderBadgeHtml(activeDeltaBadge)}</span>
          <span>/ 作成順の累積: ${formatNumber(progress?.TotalAhead)} 件</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">カレンダー距離 (日付ギャップ)</div>
        <div class="card-value">${
          metrics.calendarGap.gapDays !== null
            ? `差 ${metrics.calendarGap.gapDays} <span style="font-size: 1rem; font-weight: normal;">日</span>`
            : `<span style="font-size: 1.25rem; color: var(--text-muted);">-</span>`
        }</div>
        <div class="card-subtext">
          <span>健康的大底: ${escapeHtml(metrics.calendarGap.frontCreatedAt)}</span>
          ${metrics.calendarGap.targetCreatedAt ? `<span>/ 自PR: ${escapeHtml(metrics.calendarGap.targetCreatedAt)}</span>` : ""}
        </div>
      </div>

      <div class="card">
        <div class="card-title">健康的大底（最古健康PR）</div>
        <div class="card-value">${progress?.FrontNumber ? `<a href="https://github.com/${escapeHtml(repo)}/pull/${progress.FrontNumber}" target="_blank">#${progress.FrontNumber}</a>` : "-"}</div>
        <div class="card-subtext">
          <span>起票: ${escapeHtml(progress?.FrontCreatedAt)}</span>
          <span>(前回比: ${renderBadgeHtml(frontDeltaBadge)})</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">準備完了後の待機 (Ready / 通算 / 手番)</div>
        <div class="card-value">${escapeHtml(progress?.WaitDays)} <span style="font-size: 1rem; font-weight: normal;">日</span></div>
        <div class="card-subtext">通算待機: ${escapeHtml(progress?.TotalLifetimeDays)} 日 / 修正手番: ${escapeHtml(progress?.TurnLatencyDays)} 日</div>
      </div>

      <div class="card">
        <div class="card-title">後続の準備完了 PR</div>
        <div class="card-value">${formatNumber(progress?.Behind)} <span style="font-size: 1rem; font-weight: normal;">件</span></div>
        <div class="card-subtext">
          <span>自 PR 以降のキュー待機数</span>
          <span>(前回比: ${renderBadgeHtml(behindDeltaBadge)})</span>
        </div>
      </div>
    </div>`;
}

/** トリアージキュー構造フロー図セクションを描画する */
export function renderTriageFlowSection(params: {
  progress: LatestProgress | null;
  repo: string;
  targetUrl: string;
  targetPrNum: number | string;
  metrics: DashboardCalculatedMetrics;
}): string {
  const { progress, repo, targetUrl, targetPrNum, metrics } = params;
  return `<h2 class="section-title">📊 トリアージキュー構造</h2>
    <div class="flow-container">
      <div class="flow-node">
        <div style="font-size: 0.75rem; color: var(--text-muted);">健康的大底（最古健康PR）</div>
        <strong>${progress?.FrontNumber ? `<a href="https://github.com/${escapeHtml(repo)}/pull/${progress.FrontNumber}" target="_blank">#${progress.FrontNumber}</a>` : "-"}</strong>
        <div style="font-size: 0.7rem; color: var(--text-muted);">${escapeHtml(progress?.FrontCreatedAt)}</div>
      </div>
      <div class="flow-arrow">… 作成順で ${formatNumber(progress?.TotalAhead)} 件 … →${metrics.calendarGap.gapDays !== null ? `<div class="flow-arrow-note">起票日の差 ${metrics.calendarGap.gapDays} 日</div>` : ""}</div>
      <div class="flow-node target">
        <div style="font-size: 0.75rem; color: var(--primary);">基準 PR</div>
        <strong><a href="${escapeHtml(targetUrl)}" target="_blank">#${escapeHtml(targetPrNum)}</a></strong>
        <div style="font-size: 0.7rem; color: var(--primary);">待機 ${escapeHtml(progress?.WaitDays)} 日</div>
        <div style="font-size: 0.7rem; color: var(--primary);">更新順の順位 ${formatNumber(progress?.ActiveAhead)}</div>
      </div>
      <div class="flow-arrow">→ … ${formatNumber(progress?.Behind)} 件 … →</div>
      <div class="flow-node">
        <div style="font-size: 0.75rem; color: var(--text-muted);">最新起票</div>
        <strong>後続の準備完了 PR</strong>
        <div style="font-size: 0.7rem; color: var(--text-muted);">CI・検証通過済みの健康体</div>
      </div>
    </div>`;
}
