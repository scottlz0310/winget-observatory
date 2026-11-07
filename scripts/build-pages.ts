#!/usr/bin/env bun
// data/ 配下のメトリクスから GitHub Pages 向けの静的ダッシュボード HTML をビルドするスクリプト

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_REPOSITORY, DEFAULT_TARGET_PR } from "../src/cli/args";
import {
  calculateDashboardMetrics,
  formatDeltaBadge,
  parseTimestampToMs,
} from "../src/domain/dashboard";
import { parseCsvRows } from "../src/domain/progress";
import type { HistoryRecord } from "../src/models/dashboard";
import type { DepthsSnapshot } from "../src/models/depths";
import type { ProgressHistoryRow, ProgressSnapshot } from "../src/models/progress";

interface BuildOptions {
  dataDir: string;
  outputDir: string;
}

/** スナップショットは部分的なファイルも許容して描画する（欠けた値は「-」表示） */
type LatestProgress = Partial<ProgressSnapshot>;
type LatestDepths = Partial<DepthsSnapshot>;

function buildError(label: string, path: string, cause: unknown): Error {
  // 破損データのまま空のダッシュボードを公開しないよう、読み込み失敗は中断する
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${label} (${path}) の読み込み・パースに失敗しました: ${msg}`, { cause });
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(2);
  let dataDir = resolve(process.cwd(), "data");
  let outputDir = resolve(process.cwd(), "site");

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--data-dir" && i + 1 < args.length) {
      dataDir = resolve(process.cwd(), args[++i]);
    } else if (arg === "--output-dir" && i + 1 < args.length) {
      outputDir = resolve(process.cwd(), args[++i]);
    }
  }

  return { dataDir, outputDir };
}

function csvRowsToHistoryRecords(csvRows: ProgressHistoryRow[]): HistoryRecord[] {
  return csvRows
    .map((row) => {
      const timestamp = row.Timestamp;
      const timestampMs = parseTimestampToMs(timestamp);
      const targetPr = Number(row.TargetPr) || 0;
      const frontNumber = Number(row.FrontNumber) || 0;
      const frontCreatedAt = row.FrontCreatedAt || undefined;
      const activeAhead = Number(row.ActiveAhead) || 0;
      const totalAhead = Number(row.TotalAhead) || 0;
      const behind = Number(row.Behind) || 0;
      const waitDays = Number(row.WaitDays) || 0;

      return {
        timestamp,
        timestampMs,
        targetPr,
        frontNumber,
        frontCreatedAt,
        activeAhead,
        totalAhead,
        behind,
        waitDays,
      };
    })
    .filter((r) => !Number.isNaN(r.timestampMs));
}

function escapeHtml(str: string | number | undefined | null): string {
  if (str === undefined || str === null || str === "") return "-";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatNumber(num: number | string | undefined | null): string {
  if (num === undefined || num === null || num === "" || Number.isNaN(Number(num))) return "-";
  return Number(num).toLocaleString();
}

function renderBadgeHtml(badge: { text: string; className: string; label: string }): string {
  return `<span class="delta-badge ${badge.className}" title="${escapeHtml(badge.label)}">${escapeHtml(badge.text)}</span>`;
}

function formatDaysStat(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val)) {
    return `<span style="color: var(--text-muted);">-</span>`;
  }
  return `<strong>${val}</strong> <span style="font-size: 0.875rem; font-weight: normal;">日</span>`;
}

function generateHtml(
  progress: LatestProgress | null,
  depths: LatestDepths | null,
  csvRows: ProgressHistoryRow[],
): string {
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

  const historyRecords = csvRowsToHistoryRecords(csvRows);
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

  const healthyBottomFirst = depths?.HealthyBottom?.[0];

  // 直近 10 件の推移（差分付き、新しい順）
  const recentHistoryWithDeltas = metrics.historyWithDeltas.slice(-10).reverse();

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Winget Observatory Dashboard</title>
  <style>
    :root {
      --bg-color: #f8fafc;
      --card-bg: #ffffff;
      --text-color: #0f172a;
      --text-muted: #64748b;
      --border-color: #e2e8f0;
      --primary: #2563eb;
      --primary-light: #eff6ff;
      --success: #16a34a;
      --warning: #d97706;
      --danger: #dc2626;
      --code-bg: #f1f5f9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg-color: #0f172a;
        --card-bg: #1e293b;
        --text-color: #f8fafc;
        --text-muted: #94a3b8;
        --border-color: #334155;
        --primary: #3b82f6;
        --primary-light: #1e3a8a;
        --success: #22c55e;
        --warning: #f59e0b;
        --danger: #ef4444;
        --code-bg: #0f172a;
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background-color: var(--bg-color);
      color: var(--text-color);
      line-height: 1.6;
      padding: 1.5rem;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    header {
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 1.5rem;
    }
    h1 { font-size: 1.875rem; font-weight: 700; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
    .meta-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      font-size: 0.875rem;
      color: var(--text-muted);
      align-items: center;
    }
    .badge {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background-color: var(--primary-light);
      color: var(--primary);
      text-decoration: none;
    }
    .delta-badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.2;
    }
    .delta-progress {
      background-color: #dcfce7;
      color: #15803d;
    }
    .delta-rewind {
      background-color: #fee2e2;
      color: #b91c1c;
    }
    .delta-neutral {
      background-color: var(--code-bg);
      color: var(--text-muted);
    }
    @media (prefers-color-scheme: dark) {
      .delta-progress {
        background-color: #14532d;
        color: #86efac;
      }
      .delta-rewind {
        background-color: #7f1d1d;
        color: #fca5a5;
      }
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.75rem;
      padding: 1.25rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .card-title {
      font-size: 0.875rem;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: 0.5rem;
    }
    .card-value {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text-color);
    }
    .card-subtext {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 0.35rem;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    .stat-card {
      padding: 1rem 1.25rem;
    }
    .flow-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      background-color: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 2rem;
      overflow-x: auto;
    }
    .flow-node {
      background-color: var(--code-bg);
      border: 1px solid var(--border-color);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      text-align: center;
      min-width: 140px;
      flex-shrink: 0;
    }
    .flow-node.target {
      border: 2px solid var(--primary);
      background-color: var(--primary-light);
    }
    .flow-arrow {
      color: var(--text-muted);
      font-weight: bold;
      font-size: 1.1rem;
      text-align: center;
      white-space: nowrap;
    }
    .section-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 2rem 0 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
      background-color: var(--card-bg);
      border-radius: 0.75rem;
      overflow: hidden;
      border: 1px solid var(--border-color);
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
    }
    th {
      background-color: var(--code-bg);
      font-weight: 600;
      color: var(--text-muted);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background-color: rgba(148, 163, 184, 0.05); }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    footer {
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border-color);
      text-align: center;
      font-size: 0.875rem;
      color: var(--text-muted);
    }
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

    <div class="grid">
      <div class="card">
        <div class="card-title">実質待ち件数 (前線〜自PR)</div>
        <div class="card-value">${formatNumber(progress?.ActiveAhead)} <span style="font-size: 1rem; font-weight: normal;">件</span></div>
        <div class="card-subtext">
          <span>前回比: ${renderBadgeHtml(activeDeltaBadge)}</span>
          <span>/ 全期間累積: ${formatNumber(progress?.TotalAhead)} 件</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">到着予測 (ETA) &amp; 消化速度</div>
        <div class="card-value">${
          metrics.velocity.etaDays !== null
            ? `約 ${metrics.velocity.etaDays} <span style="font-size: 1rem; font-weight: normal;">日後</span>`
            : `<span style="font-size: 1.25rem; color: var(--text-muted);">-</span>`
        }</div>
        <div class="card-subtext">${
          metrics.velocity.etaDateJst
            ? `<span>予測到達日: <strong>${escapeHtml(metrics.velocity.etaDateJst)}</strong></span> <span>(速度: ${escapeHtml(metrics.velocity.velocityPerDay)} 件/日)</span>`
            : metrics.velocity.velocityPerDay !== null && metrics.velocity.velocityPerDay <= 0
              ? `<span>速度: ${escapeHtml(metrics.velocity.velocityPerDay)} 件/日 (キュー停滞または後退中)</span>`
              : `<span>観測データ蓄積待ち (30分以上の推移が必要)</span>`
        }</div>
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
        <div class="card-title">待機日数 (Wait / Turn)</div>
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
    </div>

    <h2 class="section-title">⏱️ マージ実績の所要日数統計 (直近 30 日間)</h2>
    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 2rem;">
      <div class="card stat-card">
        <div class="card-title">手番所要日数 (Turn Latency)</div>
        <div class="card-value" style="font-size: 1.4rem;">
          P50: ${formatDaysStat(progress?.TurnMedianDays)}
          <span style="font-size: 1rem; color: var(--text-muted); margin: 0 0.5rem;">/</span>
          P75: ${formatDaysStat(progress?.TurnP75Days)}
        </div>
        <div class="card-subtext">最新コミットからマージされるまでの日数（修正後の再レビュー待ち）</div>
      </div>

      <div class="card stat-card">
        <div class="card-title">Ready 成立後所要日数 (Ready Latency)</div>
        <div class="card-value" style="font-size: 1.4rem;">
          P50: ${formatDaysStat(progress?.ReadyMedianDays)}
          <span style="font-size: 1rem; color: var(--text-muted); margin: 0 0.5rem;">/</span>
          P75: ${formatDaysStat(progress?.ReadyP75Days)}
        </div>
        <div class="card-subtext">CI 通過および必須ラベル成立からマージされるまでの日数</div>
      </div>

      <div class="card stat-card">
        <div class="card-title">通算所要日数 (Total Lifetime)</div>
        <div class="card-value" style="font-size: 1.4rem;">
          P50: ${formatDaysStat(progress?.TotalMedianDays)}
          <span style="font-size: 1rem; color: var(--text-muted); margin: 0 0.5rem;">/</span>
          P75: ${formatDaysStat(progress?.TotalP75Days)}
        </div>
        <div class="card-subtext">PR 起票からマージ完了までの全期間の所要日数</div>
      </div>
    </div>

    <h2 class="section-title">📊 トリアージキュー構造</h2>
    <div class="flow-container">
      <div class="flow-node">
        <div style="font-size: 0.75rem; color: var(--text-muted);">健康的大底</div>
        <strong>${healthyBottomFirst?.Number ? `<a href="${escapeHtml(healthyBottomFirst.Url)}" target="_blank">#${healthyBottomFirst.Number}</a>` : "-"}</strong>
        <div style="font-size: 0.7rem; color: var(--text-muted);">${escapeHtml(healthyBottomFirst?.作成日時)}</div>
      </div>
      <div class="flow-arrow">→</div>
      <div class="flow-node">
        <div style="font-size: 0.75rem; color: var(--text-muted);">消化前線</div>
        <strong>${progress?.FrontNumber ? `<a href="https://github.com/${escapeHtml(repo)}/pull/${progress.FrontNumber}" target="_blank">#${progress.FrontNumber}</a>` : "-"}</strong>
        <div style="font-size: 0.7rem; color: var(--text-muted);">${escapeHtml(progress?.FrontCreatedAt)}</div>
      </div>
      <div class="flow-arrow">… ${formatNumber(progress?.ActiveAhead)} 件 ${metrics.calendarGap.gapDays !== null ? `(差 ${metrics.calendarGap.gapDays} 日)` : ""} … →</div>
      <div class="flow-node target">
        <div style="font-size: 0.75rem; color: var(--primary);">基準 PR</div>
        <strong><a href="${escapeHtml(targetUrl)}" target="_blank">#${escapeHtml(targetPrNum)}</a></strong>
        <div style="font-size: 0.7rem; color: var(--primary);">待機 ${escapeHtml(progress?.WaitDays)} 日</div>
      </div>
      <div class="flow-arrow">→ … ${formatNumber(progress?.Behind)} 件 … →</div>
      <div class="flow-node">
        <div style="font-size: 0.75rem; color: var(--text-muted);">最新起票</div>
        <strong>後続キュー</strong>
        <div style="font-size: 0.7rem; color: var(--text-muted);">CI 通過待ち含む</div>
      </div>
    </div>

    <h2 class="section-title">🧭 キュー境界探索（特急・大底・遭難）</h2>
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
        ${(depths?.HealthyBottom ?? [])
          .slice(0, 3)
          .map(
            (item) => `
        <tr>
          <td><span class="badge" style="background:#e0f2fe;color:#0369a1;">健康的大底</span></td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank">#${escapeHtml(item.Number)}</a></td>
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>
        `,
          )
          .join("")}
        ${(depths?.ExpressLane ?? [])
          .slice(0, 3)
          .map(
            (item) => `
        <tr>
          <td><span class="badge" style="background:#fef3c7;color:#b45309;">⚡ 特急レーン</span></td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank">#${escapeHtml(item.Number)}</a></td>
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>
        `,
          )
          .join("")}
        ${(depths?.StaleBottom ?? [])
          .slice(0, 3)
          .map(
            (item) => `
        <tr>
          <td><span class="badge" style="background:#fee2e2;color:#b91c1c;">⚠️ 遭難・放置の底</span></td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank">#${escapeHtml(item.Number)}</a></td>
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>
        `,
          )
          .join("")}
      </tbody>
    </table>

    <h2 class="section-title">📈 直近の観測推移ログ (最新 10 件)</h2>
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
        : `<p style="color: var(--text-muted); font-size: 0.875rem;">推移データはまだ蓄積されていません。</p>`
    }

    <footer>
      <p>Winget Observatory - Automated with GitHub Actions &amp; GitHub Pages</p>
      <p style="margin-top: 0.5rem; font-size: 0.75rem;">
        RAW Data: <a href="data/progress-history.csv">progress-history.csv</a> | <a href="data/latest-progress.json">latest-progress.json</a> | <a href="data/latest-depths.json">latest-depths.json</a> | <a href="data/depths-history.jsonl">depths-history.jsonl</a>
      </p>
    </footer>
  </div>
</body>
</html>
`;
}

export function buildDashboard(options: BuildOptions): { htmlPath: string } {
  const { dataDir, outputDir } = options;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const progressPath = join(dataDir, "latest-progress.json");
  const depthsPath = join(dataDir, "latest-depths.json");
  const csvPath = join(dataDir, "progress-history.csv");

  let progress: LatestProgress | null = null;
  if (existsSync(progressPath)) {
    try {
      progress = JSON.parse(readFileSync(progressPath, "utf-8")) as LatestProgress;
    } catch (e) {
      throw buildError("進捗スナップショット", progressPath, e);
    }
  }

  let depths: LatestDepths | null = null;
  if (existsSync(depthsPath)) {
    try {
      depths = JSON.parse(readFileSync(depthsPath, "utf-8")) as LatestDepths;
    } catch (e) {
      throw buildError("キュー境界スナップショット", depthsPath, e);
    }
  }

  let csvRows: ProgressHistoryRow[] = [];
  if (existsSync(csvPath)) {
    try {
      csvRows = parseCsvRows(readFileSync(csvPath, "utf-8"));
    } catch (e) {
      throw buildError("履歴 CSV", csvPath, e);
    }
  }

  const html = generateHtml(progress, depths, csvRows);
  const htmlPath = join(outputDir, "index.html");
  writeFileSync(htmlPath, html, "utf-8");
  console.log(`[Build Pages] HTML 生成完了: ${htmlPath}`);

  // RAW データファイルを site/data にコピー
  const siteDataDir = join(outputDir, "data");
  if (!existsSync(siteDataDir)) {
    mkdirSync(siteDataDir, { recursive: true });
  }

  const copyTargets = [
    "progress-history.csv",
    "latest-progress.json",
    "latest-depths.json",
    "depths-history.jsonl",
  ];

  for (const file of copyTargets) {
    const src = join(dataDir, file);
    const dest = join(siteDataDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dest);
    }
  }
  console.log(`[Build Pages] データファイルを ${siteDataDir} へコピー完了`);

  return { htmlPath };
}

if (import.meta.main) {
  try {
    buildDashboard(parseArgs());
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Build Pages] エラー: ${message}`);
    process.exit(1);
  }
}
