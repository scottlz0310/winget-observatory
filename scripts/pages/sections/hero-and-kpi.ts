// 初回提出者サマリー・予想比較パネル・KPI グリッド・トリアージフロー図の描画セクション

import { DAY_MS, formatJstDate, formatMonthDay, round1 } from "../../../src/domain/formatters";
import type { DashboardCalculatedMetrics } from "../../../src/models/dashboard";
import type { ForecastComparison, HypothesisId } from "../../../src/models/forecast-comparison";
import { escapeHtml, formatEtaDays, formatNumber, renderBadgeHtml } from "../formatters";
import type { DeltaBadge, LatestDepths, LatestProgress } from "../types";

const HYPOTHESIS_STYLE: Record<HypothesisId, { mark: string; color: string }> = {
  "rank-velocity": { mark: "①", color: "var(--primary)" },
  "update-order": { mark: "②", color: "var(--warning)" },
  "creation-order": { mark: "③", color: "var(--success)" },
};

function formatCohortForecastTarget(
  days: number | null | undefined,
  currentLifetime: number,
  createdMs: number,
): { dateStr: string; etaStr: string } {
  if (days === undefined || days === null) {
    return { dateStr: "-", etaStr: "" };
  }
  const eta = Math.max(0, round1(days - currentLifetime));
  const etaStr = eta === 0 ? "（到達済み）" : `（残り約 ${eta} 日）`;
  const dateStr = !Number.isNaN(createdMs)
    ? formatJstDate(createdMs + days * DAY_MS)
    : `起票から ${days} 日目`;
  return { dateStr, etaStr };
}

/**
 * ページ最上部に置く初回提出者（純粋FIFO）サマリー
 * スクロールなしで P50/P75 予想マージ日、残り目安日数、追い越し実態の内訳を把握できる
 */
export function renderFirstTimerHeroSummary(
  progress: LatestProgress | null,
  depths: LatestDepths | null,
): string {
  const rawLifetime = progress?.TotalLifetimeDays ?? progress?.WaitDays ?? 0;
  const parsedLifetime = Number(rawLifetime);
  const currentLifetime = Number.isFinite(parsedLifetime) ? parsedLifetime : 0;
  const p50 = progress?.FirstTimerMedianDays;
  const p75 = progress?.FirstTimerP75Days;
  const sampleCount = progress?.FirstTimerSampleCount ?? 0;
  const firstTimerDays = progress?.FirstTimerLookbackDays ?? progress?.LookbackDays ?? 90;
  const overallLookbackDays = progress?.LookbackDays ?? 30;
  const overallSampleCount = progress?.SampleCount;

  // 基準 PR の起票時刻
  const createdRaw = depths?.TargetPr?.CreatedAt || depths?.TargetPr?.CreatedAtJst;
  const createdMs = createdRaw ? Date.parse(createdRaw) : Number.NaN;

  const { dateStr: p50DateStr, etaStr: p50EtaStr } = formatCohortForecastTarget(
    p50,
    currentLifetime,
    createdMs,
  );
  const { dateStr: p75DateStr, etaStr: p75EtaStr } = formatCohortForecastTarget(
    p75,
    currentLifetime,
    createdMs,
  );

  const c = progress?.Comparison;
  const hasCohortBreakdown =
    c?.FirstTimerLaterCreated !== undefined && c?.RepeatOrExpressLaterCreated !== undefined;

  let overtakeHeadline = "-";
  let overtakeBreakdownHtml = "";
  let overtakeNoteHtml = "";

  if (!c || c.LaterCreated === undefined) {
    overtakeHeadline = `<div style="font-size: 1.15rem; color: var(--text-muted);">-</div>`;
    overtakeBreakdownHtml = `<div class="card-subtext" style="color: var(--text-muted);">追い越しの観測データなし</div>`;
  } else if (!hasCohortBreakdown) {
    // 旧形式スナップショット（コホート別内訳なし）
    overtakeHeadline = `<div style="font-size: 1.15rem; font-weight: 700;">後発マージ計 ${c.LaterCreated} 件</div>`;
    overtakeBreakdownHtml = `<div class="card-subtext" style="color: var(--text-muted);">初回/常連の内訳は未分類（旧データ）</div>`;
    overtakeNoteHtml = `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">※ 次回の観測から初回提出者と常連が分離されます</div>`;
  } else {
    // コホート別内訳あり
    const firstTimerOvertake = c.FirstTimerLaterCreated ?? 0;
    const repeatOvertake = c.RepeatOrExpressLaterCreated ?? 0;
    const unknownOvertake = c.UnknownLaterCreated ?? 0;
    const totalOvertake = c.LaterCreated;

    overtakeHeadline = `<div style="font-size: 1.15rem; font-weight: 700;">後発マージ計 ${totalOvertake} 件</div>`;
    const unknownDetail =
      unknownOvertake > 0 ? ` / 未判定: <strong>${unknownOvertake}</strong> 件` : "";
    const sampleScopeText =
      overallSampleCount !== undefined
        ? `直近 ${overallLookbackDays} 日間の全体採用サンプル（${overallSampleCount} 件）内`
        : `直近 ${overallLookbackDays} 日間の全体採用サンプル内`;
    overtakeBreakdownHtml = `<div class="card-subtext" style="margin-top: 0.2rem;">常連・特急: <strong>${repeatOvertake}</strong> 件 / 初回: <strong>${firstTimerOvertake}</strong> 件${unknownDetail}</div><div class="card-subtext" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.15rem;">集計対象: ${sampleScopeText}</div>`;

    if (firstTimerOvertake === 0 && unknownOvertake === 0) {
      overtakeNoteHtml = `<div style="font-size: 0.75rem; color: var(--success); font-weight: 600; margin-top: 0.25rem;">✨ 採用サンプル内で確定した初回提出者の追い越し: 0 件</div>`;
    } else if (firstTimerOvertake === 0 && unknownOvertake > 0) {
      overtakeNoteHtml = `<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">採用サンプル内で確定した初回追い越し 0 件（未判定 ${unknownOvertake} 件）</div>`;
    } else {
      overtakeNoteHtml = `<div style="font-size: 0.75rem; color: var(--warning); margin-top: 0.25rem;">採用サンプル内で確定した初回追い越し ${firstTimerOvertake} 件</div>`;
    }
  }

  return `
    <section class="card first-timer-hero" style="border: 2px solid var(--success); margin-bottom: 1.5rem; background: linear-gradient(to bottom right, var(--card-bg), rgba(22, 163, 74, 0.04));">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem;">
        <div class="card-title" style="color: var(--success); font-weight: 700; font-size: 1.05rem; margin-bottom: 0;">
          🎯 初回提出者（純粋FIFO）サマリー
        </div>
        <span class="badge" style="background: #dcfce7; color: #15803d; font-weight: 600;">過去 ${firstTimerDays} 日間の純粋FIFO待機列 準拠</span>
      </div>
      <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1rem; margin-bottom: 0.5rem;">
        <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 0.75rem 1rem;">
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.25rem;">予想マージ日 (P50 中央値)</div>
          <div style="font-size: 1.25rem; font-weight: 700;">${escapeHtml(p50DateStr)} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">${p50EtaStr}</span></div>
          <div class="card-subtext">通算実績: <strong>${p50 ?? "-"}</strong> 日（基準 PR 現在: ${currentLifetime} 日）</div>
          ${
            progress?.FirstTimerTurnMedianDays !== undefined &&
            progress?.FirstTimerTurnMedianDays !== null
              ? `<div class="card-subtext" style="margin-top: 0.15rem; font-size: 0.75rem; color: var(--text-muted);">最終コミット後 (Turn): <strong>${progress.FirstTimerTurnMedianDays}</strong> 日</div>`
              : ""
          }
        </div>
        <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 0.75rem 1rem;">
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.25rem;">予想マージ日 (P75 75%点)</div>
          <div style="font-size: 1.25rem; font-weight: 700;">${escapeHtml(p75DateStr)} <span style="font-size: 0.85rem; font-weight: normal; color: var(--text-muted);">${p75EtaStr}</span></div>
          <div class="card-subtext">通算実績: <strong>${p75 ?? "-"}</strong> 日（過去 ${firstTimerDays} 日間 / サンプル ${sampleCount} 件）</div>
          ${
            progress?.FirstTimerTurnP75Days !== undefined &&
            progress?.FirstTimerTurnP75Days !== null
              ? `<div class="card-subtext" style="margin-top: 0.15rem; font-size: 0.75rem; color: var(--text-muted);">最終コミット後 (Turn): <strong>${progress.FirstTimerTurnP75Days}</strong> 日</div>`
              : ""
          }
        </div>
        <div style="background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 0.75rem 1rem;">
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.25rem;">追い越し実態の分離内訳</div>
          ${overtakeHeadline}
          ${overtakeBreakdownHtml}
          ${overtakeNoteHtml}
        </div>
      </div>
      <div class="card-subtext" style="margin-top: 0.5rem;">
        ※ 常連コントリビューター（大量まとめマージ）や特急レーンを除外した、初回提出者（生涯マージ1件・阻害ラベルや Draft 履歴のない初期健康体）の観測値に基づきます。手直しを含む初回全体の通算所要日数および最終コミット後の所要日数（Turn Latency）を測定しています。
      </div>
    </section>`;
}

/** 3 つの仮説によるマージ時期の予想を比較するパネル（ページの最上部に置く） */
export function renderForecastPanel(
  comparison: ForecastComparison,
  timelineSvg: string | null,
): string {
  const { range } = comparison;
  const headline = range
    ? range.startMs === range.endMs
      ? escapeHtml(formatJstDate(range.startMs))
      : `${escapeHtml(formatJstDate(range.startMs))} 〜 ${escapeHtml(formatJstDate(range.endMs))}`
    : `<span style="color: var(--text-muted);">予想できません</span>`;
  const headlineDays = range
    ? range.minDays === range.maxDays
      ? formatEtaDays(range.minDays)
      : `約 ${range.minDays}〜${range.maxDays} 日後`
    : "どの仮説も、予想に必要な観測がそろっていません";

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
    <section class="card forecast-panel" aria-label="マージ時期の予想の比較">
      <div class="card-title">予想マージ日（3 つの仮説の比較）</div>
      <div class="card-value">${headline} <span style="font-size: 1rem; font-weight: normal; color: var(--text-muted);">${headlineDays}</span></div>
      <div class="card-subtext">範囲は主な予想の最小〜最大です。3 つの仮説は前提が異なり、どれが実態に近いかはまだ検証できていません。</div>
      ${timelineSvg ? `<div style="margin: 0.75rem 0;">${timelineSvg}</div>` : ""}
      <div style="overflow-x: auto;">
        <table style="margin-bottom: 0;">
          <thead>
            <tr><th style="width: 30%;">仮説と前提</th><th>現在の進捗</th><th style="width: 30%;">予想日</th></tr>
          </thead>
          <tbody>${rows}
          </tbody>
        </table>
      </div>
    </section>`;
}

/** 予想タイムライン SVG 用のマーカーデータを抽出する */
export function buildForecastTimelineMarkers(
  comparison: ForecastComparison,
): Array<{ label: string; dateMs: number; color: string }> {
  return comparison.hypotheses.flatMap((h) =>
    h.estimates
      .filter((e) => e.primary)
      .map((e) => ({
        label: `${HYPOTHESIS_STYLE[h.id].mark} ${formatMonthDay(e.dateMs)}`,
        dateMs: e.dateMs,
        color: HYPOTHESIS_STYLE[h.id].color,
      })),
  );
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
          <span>前線: ${escapeHtml(metrics.calendarGap.frontCreatedAt)}</span>
          ${metrics.calendarGap.targetCreatedAt ? `<span>/ 自PR: ${escapeHtml(metrics.calendarGap.targetCreatedAt)}</span>` : ""}
        </div>
      </div>

      <div class="card">
        <div class="card-title">現在の消化前線</div>
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
        <div style="font-size: 0.75rem; color: var(--text-muted);">消化前線（健康的大底）</div>
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
