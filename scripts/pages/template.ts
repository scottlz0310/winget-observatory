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
  selectComparableHistory,
} from "../../src/domain/dashboard";
import { calculateExitBreakdown } from "../../src/domain/exit-breakdown";
import {
  buildForecastSource,
  calculateForecastComparison,
} from "../../src/domain/forecast-comparison";
import { scoreForecasts } from "../../src/domain/forecast-history";
import { DAY_MS, formatHumanDays } from "../../src/domain/formatters";
import { escapeHtml } from "./formatters";
import {
  renderBottomComparisonSection,
  renderBoundaryTableSection,
  renderExitBreakdownSection,
  renderForecastScoreSection,
  renderForecastSection,
  renderRecentHistorySection,
} from "./sections/depths-and-history";
import {
  buildForecastTimelineMarkers,
  renderFirstTimerHeroSummary,
  renderForecastPanel,
  renderKpiGridSection,
  renderTriageFlowSection,
} from "./sections/hero-and-kpi";
import {
  renderDurationStatsSection,
  renderOvertakeSection,
  renderRivalsSection,
  renderSamplesSection,
} from "./sections/stats-and-samples";
import { DASHBOARD_CSS } from "./styles";
import type { DashboardRenderInput } from "./types";

/** チャートに載せる観測の最大数（直近のものを使う） */
const CHART_MAX_POINTS = 120;

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
    frontierSamples = [],
    forecastHistory = [],
    firstTimerFrontierSamples = [],
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
  const dualSeries: DualAxisSeries[] = [
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
    {
      label: "優等生の底 更新からの遅れ",
      axis: "right",
      color: "var(--warning)",
      strokeWidth: 2,
      points: frontierSamples
        .slice(-CHART_MAX_POINTS)
        .map((s) => ({ x: s.timestampMs, y: (s.timestampMs - s.updatedMs) / DAY_MS })),
    },
  ];

  if (firstTimerFrontierSamples.length > 0) {
    dualSeries.push({
      label: "🌱 初回提出者の底 起票からの経過",
      axis: "right",
      color: "var(--success)",
      strokeWidth: 3,
      points: firstTimerFrontierSamples
        .slice(-CHART_MAX_POINTS)
        .map((s) => ({ x: s.timestampMs, y: (s.timestampMs - s.createdMs) / DAY_MS })),
    });
  }

  const queueChart = renderDualAxisLineChartSvg({
    title: "待ち件数と底の遅れの推移（統合時系列チャート）",
    leftAxisLabel: "待ち件数",
    rightAxisLabel: "先頭の経過・遅れ（日）",
    series: dualSeries,
    rightDecimals: 1,
  });

  const comparison = calculateForecastComparison(
    buildForecastSource({ progress, depths, history: historyRecords, frontierSamples }),
  );
  const timelineSvg = renderTimelineSvg({
    title: "3 つの仮説による予想マージ日",
    nowMs: comparison.nowMs,
    markers: buildForecastTimelineMarkers(comparison),
    band: comparison.range
      ? { startMs: comparison.range.startMs, endMs: comparison.range.endMs }
      : undefined,
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

    ${renderFirstTimerHeroSummary(progress, depths)}

    ${renderForecastPanel(comparison, timelineSvg)}

    ${renderKpiGridSection({
      progress,
      repo,
      metrics,
      activeDeltaBadge,
      frontDeltaBadge,
      behindDeltaBadge,
    })}

    <h2 class="section-title">📉 待ち件数の推移（キュー推移と底の進行の統合時系列）</h2>
    <p class="section-note">
      左軸は基準 PR より前の待ち件数（実質待ち・累積待ち）、右軸は待機列の先頭経過日数（優等生の底＝更新からの遅れ、🌱 初回提出者の底＝起票からの経過）です（直近最大 ${CHART_MAX_POINTS} 観測点を表示）。
    </p>
    ${renderChartCard(queueChart)}

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

    ${renderBoundaryTableSection(depths)}

    ${renderBottomComparisonSection(depths)}

    ${renderForecastSection(frontierSamples)}

    ${renderForecastScoreSection(forecastHistory, forecastScores)}

    ${renderRecentHistorySection(recentHistoryWithDeltas, repo)}

    ${renderSamplesSection(progress, repo)}

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
