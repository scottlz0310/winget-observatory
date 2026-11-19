// 初回提出者サマリー・予想比較パネル・KPI グリッド・トリアージフロー図の描画セクション

import { DAY_MS, formatJstDate, formatMonthDay, round1 } from "../../../src/domain/formatters";
import type { DashboardCalculatedMetrics } from "../../../src/models/dashboard";
import type { FirstReviewForecast, FirstReviewForecastStatus } from "../../../src/models/forecast";
import type { ForecastComparison, HypothesisId } from "../../../src/models/forecast-comparison";
import { escapeHtml, formatEtaDays, formatNumber, renderBadgeHtml } from "../formatters";
import type { DeltaBadge, LatestDepths, LatestProgress } from "../types";

const HYPOTHESIS_STYLE: Record<HypothesisId, { mark: string; color: string }> = {
  "rank-velocity": { mark: "①", color: "var(--primary)" },
  "creation-order": { mark: "②", color: "var(--success)" },
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
 * ページ最上部に置く初回提出者サマリー
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
          🎯 初回提出者サマリー
        </div>
        <span class="badge" style="background: #dcfce7; color: #15803d; font-weight: 600;">過去 ${firstTimerDays} 日間の初回提出者コホート 準拠</span>
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
        ※ 常連コントリビューター（大量まとめマージ）や特急レーンを除外した、生涯マージ1件の初回提出者（手直し・ラベル履歴を含む）の観測値に基づきます。通算所要日数および最終コミット後の所要日数（Turn Latency）を測定しています。
      </div>
    </section>`;
}

/** 2 つの仮説によるマージ時期の予想を比較するパネル（ページの最上部に置く） */
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
      <div class="card-title">予想マージ日（2 つの仮説の比較）</div>
      <div class="card-value">${headline} <span style="font-size: 1rem; font-weight: normal; color: var(--text-muted);">${headlineDays}</span></div>
      <div class="card-subtext">範囲は主な予想の最小〜最大です。2 つの仮説は前提が異なり、どちらが実態に近いかはまだ検証できていません。</div>
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

const FIRST_REVIEW_BADGE_MAP: Record<FirstReviewForecastStatus, { label: string; style: string }> =
  {
    "target-intervened": {
      label: "基準PR介入済み",
      style: "background: #dcfce7; color: #15803d;",
    },
    reached: { label: "到達済み", style: "background: #dcfce7; color: #15803d;" },
    steady: { label: "現在位置・定常目安", style: "background: #e0f2fe; color: #0369a1;" },
    "no-samples": {
      label: "データ不足",
      style: "background: var(--code-bg); color: var(--text-muted);",
    },
    "no-target": {
      label: "基準PR未指定",
      style: "background: var(--code-bg); color: var(--text-muted);",
    },
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

function renderFirstReviewHeadline(forecast: FirstReviewForecast): {
  headlineHtml: string;
  detailText: string;
} {
  switch (forecast.status) {
    case "target-intervened": {
      const badgeLabel = formatTargetInterventionLabel(forecast);
      return {
        headlineHtml: `<span style="color: var(--success);">到達済み</span> <span style="font-size: 1rem; font-weight: normal; color: var(--text-muted);">（${escapeHtml(badgeLabel)}）</span>`,
        detailText:
          "基準 PR にはすでに人間レビュー・手動コメント・第三者 Assignees のいずれかが記録されているため、初回レビュー・介入は到達済みと判定しています。",
      };
    }
    case "reached":
      return {
        headlineHtml: `<span style="color: var(--success);">到達済み</span> <span style="font-size: 1rem; font-weight: normal; color: var(--text-muted);">（基準 PR の起票日ラインに到達済み）</span>`,
        detailText:
          "主戦場ライン（直近7日初回人間介入コホートの起票日時中央値）が基準 PR の起票日以降に到達しています（基準 PR の起票日ラインに到達済み・残り 0 日）。",
      };
    case "steady": {
      const dateStr = forecast.steadyDateMs !== null ? formatJstDate(forecast.steadyDateMs) : "-";
      const etaStr = forecast.steadyEtaDays !== null ? formatEtaDays(forecast.steadyEtaDays) : "-";
      return {
        headlineHtml: `${escapeHtml(dateStr)} <span style="font-size: 1rem; font-weight: normal; color: var(--text-muted);">${escapeHtml(etaStr)}</span>`,
        detailText:
          "現在の主戦場ライン（7日初回介入コホート起票日時中央値）と基準 PR との起票日差に基づく定常ペース（1.0 日/日）換算の現在地目安です。",
      };
    }
    case "no-target":
      return {
        headlineHtml: `<span style="color: var(--text-muted);">基準 PR 起票日時が不明</span>`,
        detailText:
          "基準 PR の起票日時が記録されていないため、起票日差および定常換算を算出できません（主戦場ラインの現在位置のみ表示）。",
      };
    case "no-samples":
      return {
        headlineHtml: `<span style="color: var(--text-muted);">データ不足</span>`,
        detailText:
          "直近 7 日間に初回人間介入が入った初回提出 PR コホートの観測データが不足しているため算出できません。",
      };
  }
}

/**
 * 基準 PR への初回レビュー現在地パネルを描画する（主戦場ラインスナップショット＋定常換算）
 */
export function renderFirstReviewForecastPanel(forecast: FirstReviewForecast): string {
  const badge = FIRST_REVIEW_BADGE_MAP[forecast.status];
  const { headlineHtml, detailText } = renderFirstReviewHeadline(forecast);
  const { frontier } = forecast;

  const frontierValueHtml = frontier
    ? `${escapeHtml(formatJstDate(frontier.createdMs))}`
    : `<span style="color: var(--text-muted);">データ不足</span>`;
  const frontierSubHtml = frontier
    ? `直近7日初回介入 ${frontier.cohortCount}件の中央値（経過 ${forecast.lagDays ?? "-"} 日 / Open ${frontier.openCount}・Merged ${frontier.mergedCount}）`
    : "対象コホート 0 件または未観測";

  const hasTargetIntervention = Boolean(forecast.targetIntervention?.Intervened);
  const gapValueHtml = hasTargetIntervention
    ? `介入済み`
    : forecast.gapDays !== null
      ? `差 ${forecast.gapDays} 日`
      : `<span style="color: var(--text-muted);">-</span>`;
  const gapSubHtml = hasTargetIntervention
    ? escapeHtml(formatTargetInterventionLabel(forecast))
    : forecast.gapDays !== null
      ? forecast.gapDays <= 0
        ? "基準 PR の起票日ラインに到達済み"
        : "基準 PR の起票日 − 主戦場ライン中央値"
      : "基準 PR の起票日時が不明";

  const steadyValueHtml =
    forecast.steadyDateMs !== null
      ? `${escapeHtml(formatJstDate(forecast.steadyDateMs))}`
      : `<span style="color: var(--text-muted);">-</span>`;
  const steadySubHtml =
    forecast.steadyEtaDays !== null
      ? forecast.steadyEtaDays === 0
        ? "到達・介入済み（残り 0 日）"
        : `定常 1.0 日/日換算（${formatEtaDays(forecast.steadyEtaDays)}）`
      : "データ不足";

  return `
    <section class="card forecast-panel" style="border-left: 4px solid #0ea5e9; margin-top: 1rem; margin-bottom: 0.5rem;" aria-label="初回レビュー到達予想">
      <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.4rem;">
        <div class="card-title" style="margin-bottom: 0; font-weight: 600; color: var(--text-color);">
          👀 主戦場ライン現在位置（7日初回介入コホート中央値）
        </div>
        <span class="badge" style="${badge.style}">${escapeHtml(badge.label)}</span>
      </div>
      <div class="card-value" style="font-size: 1.45rem;">${headlineHtml}</div>
      <div class="card-subtext" style="margin-bottom: 0.75rem;">${escapeHtml(detailText)}</div>
      <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; margin-bottom: 0.5rem;">
        <div style="background: var(--code-bg); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 0.65rem 0.9rem;">
          <div style="font-size: 0.75rem; color: var(--text-muted);">主戦場ラインの現在位置</div>
          <div style="font-size: 1.1rem; font-weight: 700;">${frontierValueHtml}</div>
          <div class="card-subtext">${escapeHtml(frontierSubHtml)}</div>
        </div>
        <div style="background: var(--code-bg); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 0.65rem 0.9rem;">
          <div style="font-size: 0.75rem; color: var(--text-muted);">基準 PR との起票日差 / 状態</div>
          <div style="font-size: 1.1rem; font-weight: 700;">${gapValueHtml}</div>
          <div class="card-subtext">${gapSubHtml}</div>
        </div>
        <div style="background: var(--code-bg); border: 1px solid var(--border-color); border-radius: 0.5rem; padding: 0.65rem 0.9rem;">
          <div style="font-size: 0.75rem; color: var(--text-muted);">定常ペース（1.0 日/日）換算</div>
          <div style="font-size: 1.1rem; font-weight: 700;">${steadyValueHtml}</div>
          <div class="card-subtext">${escapeHtml(steadySubHtml)}</div>
        </div>
      </div>
      <div class="card-subtext">
        ※ 純粋ボット・作成者本人・自動検証ログ（Deterministic automation）を除き、直近 7 日間に初めて人間介入（人間レビュー・手動コメント・第三者 Assignees）が入った初回提出者（New-Package）PR 群（オープン中＋直近マージ済み）の起票日時中央値を主戦場ラインとしています。短期実測速度による割り算外挿は行いません。
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
