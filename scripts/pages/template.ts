// チャート SVG 生成と各セクションを統合してダッシュボード HTML 全文を生成する純粋関数モジュール

import { DEFAULT_REPOSITORY, DEFAULT_TARGET_PR } from "../../src/cli/args";
import {
  type DualAxisSeries,
  renderDualAxisLineChartSvg,
  renderTimelineSvg,
} from "../../src/domain/chart";
import {
  calculateDashboardMetrics,
  formatDeltaBadge,
  parseTimestampToMs,
  selectComparableHistory,
} from "../../src/domain/dashboard";
import { calculateExitBreakdown } from "../../src/domain/exit-breakdown";
import { buildForecastBandSource, calculateForecastBand } from "../../src/domain/forecast-band";
import { scoreForecasts } from "../../src/domain/forecast-history";
import { DAY_MS, formatHumanDays } from "../../src/domain/formatters";
import { escapeHtml } from "./formatters";
import {
  renderBoundaryTableSection,
  renderExitBreakdownSection,
  renderForecastScoreSection,
  renderRecentHistorySection,
  renderWaitlineMatrixSection,
} from "./sections/depths-and-history";
import {
  buildBandTimelineMarkers,
  renderIntegratedForecastHero,
  renderKpiGridSection,
  renderTriageFlowSection,
} from "./sections/hero-and-kpi";
import {
  renderDurationStatsSection,
  renderFirstTimerFastestRankingSection,
  renderOvertakeSection,
  renderRivalsSection,
  renderSamplesSection,
} from "./sections/stats-and-samples";
import { DASHBOARD_CSS } from "./styles";
import type { DashboardRenderInput } from "./types";

/** チャートに載せる観測の最大数（直近のものを使う） */
const CHART_MAX_POINTS = 120;

const CHART_FILTER_INLINE_SCRIPT = `<script>
(() => {
  for (const section of document.querySelectorAll("[data-chart-section]")) {
    const buttons = section.querySelectorAll("[data-chart-filter]");
    const views = section.querySelectorAll("[data-chart-view]");
    for (const btn of buttons) {
      btn.addEventListener("click", () => {
        const mode = btn.getAttribute("data-chart-filter") || "all";
        for (const b of buttons) {
          const active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", active ? "true" : "false");
        }
        for (const v of views) {
          v.style.display = v.getAttribute("data-chart-view") === mode ? "" : "none";
        }
      });
    }
  }
})();
</script>`;

/** チャートを載せるカード。描画できるだけの観測が無いときは理由を示す */
function renderChartCard(svg: string | null): string {
  return `<div class="card chart-card" style="margin-bottom: 1.5rem;">${
    svg ?? `<div class="card-subtext">観測が 2 件以上たまると推移を表示します</div>`
  }</div>`;
}

/** 観測データと履歴からダッシュボード HTML 全文を生成する純粋関数 */
export function generateDashboardHtml(input: DashboardRenderInput): string {
  const {
    progress,
    depths,
    csvRows,
    forecastHistory = [],
    healthyFrontierSamples = [],
    firstTimerFrontierSamples = [],
    mainstreamFrontierSamples = [],
    firstTimerFastestRanking,
  } = input;

  const updatedJst = progress?.TimestampJst || depths?.TimestampJst || "未観測";
  const repo = progress?.Repository || depths?.Repository || DEFAULT_REPOSITORY;
  const targetPrNum = progress?.TargetPr || depths?.TargetPr?.Number || DEFAULT_TARGET_PR;
  const targetTitle = progress?.PrTitle || depths?.TargetPr?.Title || "";
  const targetUrl =
    progress?.PrUrl || depths?.TargetPr?.Url || `https://github.com/${repo}/pull/${targetPrNum}`;

  const targetCreatedAt =
    depths?.TargetPr?.CreatedAtJst || depths?.TargetPr?.CreatedAt || undefined;
  const frontCreatedAt = progress?.FrontCreatedAt || undefined;
  const currentActiveAhead = Number(progress?.ActiveAhead) || 0;

  const historyRecords = selectComparableHistory(csvRows, Number(targetPrNum));
  const metrics = calculateDashboardMetrics(
    historyRecords,
    currentActiveAhead,
    frontCreatedAt,
    targetCreatedAt,
  );

  const activeDeltaBadge = formatDeltaBadge(metrics.latestDelta.activeAheadDelta);
  const frontDeltaBadge = formatDeltaBadge(metrics.latestDelta.frontNumberDelta, {
    higherIsBetter: true,
    unit: "",
  });
  const behindDeltaBadge = formatDeltaBadge(metrics.latestDelta.behindDelta);

  const chartRecords = historyRecords.slice(-CHART_MAX_POINTS);
  const baseLeftSeries: DualAxisSeries[] = [
    {
      label: "実質待ち（更新順）",
      axis: "left",
      color: "var(--primary)",
      strokeWidth: 2.5,
      points: chartRecords.map((r) => ({ x: r.timestampMs, y: r.activeAhead })),
    },
    {
      label: "累積待ち（作成順）",
      axis: "left",
      color: "var(--text-muted)",
      strokeWidth: 1.5,
      strokeDasharray: "4 2",
      points: chartRecords.map((r) => ({ x: r.timestampMs, y: r.totalAhead })),
    },
  ];

  const healthySeries: DualAxisSeries | null =
    healthyFrontierSamples.length > 0
      ? {
          label: "⚓ マージ正常底（健康的大底）起票経過",
          axis: "right",
          color: "var(--warning)",
          strokeWidth: 2.5,
          points: healthyFrontierSamples
            .slice(-CHART_MAX_POINTS)
            .map((s) => ({ x: s.timestampMs, y: (s.timestampMs - s.createdMs) / DAY_MS })),
        }
      : null;

  const firstTimerSeries: DualAxisSeries | null =
    firstTimerFrontierSamples.length > 0
      ? {
          label: "🌱 マージ正常底（初回提出者のみ）起票経過",
          axis: "right",
          color: "var(--success)",
          strokeWidth: 2.5,
          points: firstTimerFrontierSamples
            .slice(-CHART_MAX_POINTS)
            .map((s) => ({ x: s.timestampMs, y: (s.timestampMs - s.createdMs) / DAY_MS })),
        }
      : null;

  const mainstreamSeries: DualAxisSeries | null =
    mainstreamFrontierSamples.length > 0
      ? {
          label: "👀 初動正常底（主戦場ライン・7日介入中央値）",
          axis: "right",
          color: "#0ea5e9",
          strokeWidth: 2.5,
          points: mainstreamFrontierSamples
            .slice(-CHART_MAX_POINTS)
            .map((s) => ({ x: s.timestampMs, y: (s.timestampMs - s.createdMs) / DAY_MS })),
        }
      : null;

  const hasChartPopulationToggle = healthySeries !== null && firstTimerSeries !== null;
  const allChartSeries: DualAxisSeries[] = [
    ...baseLeftSeries,
    ...(healthySeries ? [healthySeries] : firstTimerSeries ? [firstTimerSeries] : []),
    ...(mainstreamSeries ? [mainstreamSeries] : []),
  ];
  const firstTimerChartSeries: DualAxisSeries[] = [
    ...baseLeftSeries,
    ...(firstTimerSeries ? [firstTimerSeries] : []),
    ...(mainstreamSeries ? [mainstreamSeries] : []),
  ];

  const queueChartAll = renderDualAxisLineChartSvg({
    title: "待ち件数と正常底の推移（統合時系列チャート）",
    leftAxisLabel: "待ち件数",
    rightAxisLabel: "正常底の起票経過（日）",
    series: allChartSeries,
    rightDecimals: 1,
  });
  const queueChartFirstTimer = hasChartPopulationToggle
    ? renderDualAxisLineChartSvg({
        title: "待ち件数と正常底の推移（統合時系列チャート・初回提出者のみ）",
        leftAxisLabel: "待ち件数",
        rightAxisLabel: "正常底の起票経過（日）",
        series: firstTimerChartSeries,
        rightDecimals: 1,
      })
    : null;

  const parsedTargetCreatedMs = depths?.TargetPr?.CreatedAt
    ? Date.parse(depths.TargetPr.CreatedAt)
    : depths?.TargetPr?.CreatedAtJst
      ? parseTimestampToMs(depths.TargetPr.CreatedAtJst)
      : Number.NaN;
  const targetCreatedMsForSamples = !Number.isNaN(parsedTargetCreatedMs)
    ? parsedTargetCreatedMs
    : progress?.Timestamp && typeof progress.TotalLifetimeDays === "number"
      ? Date.parse(progress.Timestamp) - progress.TotalLifetimeDays * DAY_MS
      : null;
  const isLatestCohortEmpty =
    depths?.FirstReviewFrontier?.Mode === "cohort-median-7d" &&
    depths.FirstReviewFrontier.CohortCount === 0;
  const bandSnapshot = calculateForecastBand(
    buildForecastBandSource({
      progress,
      depths,
      history: historyRecords,
      mainstreamFrontierSamples: isLatestCohortEmpty ? [] : mainstreamFrontierSamples,
    }),
  );
  const timelineSvg = renderTimelineSvg({
    title: "統合処理バンドによる着地予想タイムライン",
    nowMs: bandSnapshot.nowMs,
    markers: buildBandTimelineMarkers(bandSnapshot),
    band: bandSnapshot.mainstream?.range,
    overallBand: bandSnapshot.overallRange ?? undefined,
  });

  const forecastScores = scoreForecasts(forecastHistory);
  const exitBreakdown = calculateExitBreakdown(historyRecords);

  // 直近 10 件の推移（差分付き、新しい順）
  const recentHistoryWithDeltas = metrics.historyWithDeltas.slice(-10).reverse();

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Winget Observatory Dashboard</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%94%AD%3C/text%3E%3C/svg%3E">
  <style>
${DASHBOARD_CSS}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔭 Winget Observatory Dashboard</h1>
      <div class="meta-bar">
        <span>観測対象: <a href="https://github.com/${escapeHtml(repo)}" target="_blank" class="badge">${escapeHtml(repo)}</a></span>
        <span>基準PR: <a href="${escapeHtml(targetUrl)}" target="_blank" class="badge">#${escapeHtml(targetPrNum)}</a> ${escapeHtml(targetTitle)}</span>
        <span>最終観測 (JST): <strong>${escapeHtml(updatedJst)}</strong></span>
      </div>
    </header>

    ${renderIntegratedForecastHero({
      targetPrNum,
      repo,
      progress,
      band: bandSnapshot,
      timelineSvg,
    })}

    ${renderKpiGridSection({
      progress,
      repo,
      metrics,
      activeDeltaBadge,
      frontDeltaBadge,
      behindDeltaBadge,
    })}

    <section data-chart-section>
      <h2 class="section-title">📉 待ち件数の推移（キュー推移と正常底の進行の統合時系列）</h2>
      <p class="section-note">
        左軸は基準 PR より前の待ち件数（実質待ち・累積待ち）、右軸は各正常底の起票経過日数（⚓ マージ正常底・全体 ／ 🌱 マージ正常底・初回提出者のみ、👀 初動正常底・直近7日初回介入中央値）です（直近最大 ${CHART_MAX_POINTS} 観測点を表示）。
      </p>
      ${
        hasChartPopulationToggle
          ? `<div class="sample-filter-bar" role="group" aria-label="統合時系列チャートの右軸母集団フィルタ">
        <button type="button" class="sample-filter-btn is-active" data-chart-filter="all" aria-pressed="true">
          ⚓ 全体（健康的大底）
        </button>
        <button type="button" class="sample-filter-btn" data-chart-filter="first-timer" aria-pressed="false">
          🌱 初回提出者のみ
        </button>
      </div>
      <div data-chart-view="all">${renderChartCard(queueChartAll)}</div>
      <div data-chart-view="first-timer" style="display: none;">${renderChartCard(queueChartFirstTimer)}</div>
      ${CHART_FILTER_INLINE_SCRIPT}`
          : renderChartCard(queueChartAll)
      }
    </section>

    ${renderExitBreakdownSection(exitBreakdown)}

    ${renderDurationStatsSection(progress, formatHumanDays)}

    ${renderOvertakeSection(progress)}

    ${renderTriageFlowSection({
      progress,
      repo,
      targetUrl,
      targetPrNum,
      metrics,
    })}

    ${renderRivalsSection(progress)}

    ${renderWaitlineMatrixSection(depths)}

    ${renderBoundaryTableSection(depths)}

    ${renderForecastScoreSection(forecastHistory, forecastScores)}

    ${renderRecentHistorySection(recentHistoryWithDeltas, repo)}

    ${renderFirstTimerFastestRankingSection(firstTimerFastestRanking, repo)}

    ${renderSamplesSection(progress, repo, targetCreatedMsForSamples)}

    <footer>
      <p>Winget Observatory - Automated with GitHub Actions &amp; GitHub Pages</p>
      <p style="margin-top: 0.5rem; font-size: 0.75rem;">
        RAW Data: <a href="data/progress-history.csv">progress-history.csv</a> | <a href="data/latest-progress.json">latest-progress.json</a> | <a href="data/latest-depths.json">latest-depths.json</a> | <a href="data/depths-history.jsonl">depths-history.jsonl</a> | <a href="data/forecast-history.jsonl">forecast-history.jsonl</a>
      </p>
    </footer>
  </div>
</body>
</html>
`;
}
