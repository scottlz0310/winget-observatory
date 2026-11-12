#!/usr/bin/env bun
// data/ 配下のメトリクスから GitHub Pages 向けの静的ダッシュボード HTML をビルドするスクリプト

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_REPOSITORY, DEFAULT_TARGET_PR } from "../src/cli/args";
import { describeGuidance, describeOvertake } from "../src/domain/benchmark";
import { renderLineChartSvg, renderTimelineSvg } from "../src/domain/chart";
import {
  calculateDashboardMetrics,
  formatDeltaBadge,
  formatJstDate,
  selectComparableHistory,
} from "../src/domain/dashboard";
import { calculateExitBreakdown } from "../src/domain/exit-breakdown";
import { extractStaleFrontierSamples, parseDepthsHistory } from "../src/domain/forecast";
import {
  buildForecastSource,
  calculateForecastComparison,
} from "../src/domain/forecast-comparison";
import { parseForecastHistory, scoreForecasts } from "../src/domain/forecast-history";
import { formatDateTimeWithDay, formatHumanDays, parseCsvRows } from "../src/domain/progress";
import type { DepthsRow, DepthsSnapshot } from "../src/models/depths";
import type {
  ExitBreakdownResult,
  ExitBreakdownUnavailableReason,
} from "../src/models/exit-breakdown";
import type { StaleFrontierSample } from "../src/models/forecast";
import type { ForecastComparison, HypothesisId } from "../src/models/forecast-comparison";
import type { ForecastHistoryLine, ForecastScore } from "../src/models/forecast-history";
import type {
  ProgressHistoryRow,
  ProgressSnapshot,
  ReferenceGuidance,
} from "../src/models/progress";

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

/** 底の行一覧のテーブル HTML を生成する */
function renderBottomRowTable(
  items: DepthsRow[],
  timestampIso: string,
  showAuthor = false,
): string {
  const observedMs = Date.parse(timestampIso);
  const rows = items
    .map((item, index) => {
      const updatedMs = Date.parse(item.UpdatedAt);
      const lag =
        Number.isNaN(observedMs) || Number.isNaN(updatedMs)
          ? "-"
          : `${Math.round(((observedMs - updatedMs) / 86_400_000) * 10) / 10} 日`;
      const authorCell = showAuthor ? `<td>${escapeHtml(item.Author ?? "-")}</td>` : "";
      return `
        <tr>
          <td>${index + 1}</td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(item.Number)}</a></td>
          ${authorCell}
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${lag}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>`;
    })
    .join("");
  const authorHeader = showAuthor ? "<th>作者</th>" : "";
  return `
    <table>
      <thead>
        <tr>
          <th>順位</th>
          <th>PR 番号</th>
          ${authorHeader}
          <th>起票日時 (JST)</th>
          <th>最終更新 (JST)</th>
          <th>更新からの経過</th>
          <th>タイトル</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;
}

/** 優等生の底（更新が古い順の健康な PR）の表。先頭からの遅れ = 観測時刻 − 最終更新 */
function renderStaleBottomTable(depths: LatestDepths | null): string {
  const items = depths?.StaleBottom ?? [];
  if (items.length === 0) {
    return `<p style="color: var(--text-muted); font-size: 0.875rem;">優等生の底のデータはまだありません。</p>`;
  }
  return renderBottomRowTable(items, depths?.Timestamp ?? "");
}

/** 初回提出者の底（常連を除外した純粋な初回提出者・1コミットの PR）の表 */
function renderFirstTimerBottomTable(depths: LatestDepths | null): string {
  const items = depths?.FirstTimerBottom ?? [];
  if (items.length === 0) {
    return `<p style="color: var(--text-muted); font-size: 0.875rem;">初回提出者の底のデータはまだありません（次回の定期観測から記録されます）。</p>`;
  }
  return renderBottomRowTable(items, depths?.Timestamp ?? "", true);
}

const DAY_MS = 86_400_000;

/** チャートに載せる観測の最大数（直近のものを使う） */
const CHART_MAX_POINTS = 120;

/** 実績サンプルが少なく、数値が揺れやすいとみなす件数 */
const FEW_SAMPLES = 10;

/** 日数統計カード（中央値・75%点・最大）と、基準 PR の現在値の位置づけ */
function renderStatCard(
  title: string,
  stats: { median?: number | null; p75?: number | null; max?: number | null },
  currentDays: number | string | undefined,
  guidance: ReferenceGuidance | undefined,
  description: string,
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

/** 初回提出者コホート実績カード（常連・特急レーンを除外した真の初回提出者） */
function renderFirstTimerStatCard(progress: LatestProgress): string {
  const count = progress.FirstTimerSampleCount ?? 0;
  return `
      <div class="card stat-card" style="border-left: 4px solid var(--primary);">
        <div class="card-title">🌱 初回提出者コホート実績</div>
        <div class="card-value" style="font-size: 1.15rem; display: flex; flex-wrap: wrap; column-gap: 0.75rem;">
          <span style="white-space: nowrap;">P50: ${formatDaysStat(progress.FirstTimerMedianDays)}</span>
          <span style="white-space: nowrap;">P75: ${formatDaysStat(progress.FirstTimerP75Days)}</span>
        </div>
        <div class="card-subtext">常連・特急レーンを除外した真の初回提出者（1コミット・累計マージ1件）の通算所要日数（${count} 件）</div>
        <div class="card-subtext">基準 PR の現在: <strong>${escapeHtml(progress.TotalLifetimeDays)}</strong> 日</div>
      </div>`;
}

/** 追い越しの比較（採用サンプル内で、基準 PR より後に作成・成立してマージされた件数） */
function renderOvertakeSection(progress: LatestProgress | null): string {
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
function renderRivalsSection(progress: LatestProgress | null): string {
  const rivals = progress?.Rivals ?? [];
  if (rivals.length === 0) return "";
  const observedMs = Date.parse(progress?.Timestamp ?? "");
  const rows = rivals
    .map((r) => {
      const updatedMs = Date.parse(r.UpdatedAt);
      const idle =
        Number.isNaN(observedMs) || Number.isNaN(updatedMs)
          ? "-"
          : `${Math.round(((observedMs - updatedMs) / DAY_MS) * 10) / 10} 日`;
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
function renderSamplesSection(progress: LatestProgress | null, repo: string): string {
  const samples = progress?.Samples ?? [];
  if (samples.length === 0) return "";
  // 一覧は新しい順の一部（スナップショットの上限）。統計に使った総数は SampleCount
  const total = Math.max(progress?.SampleCount ?? 0, samples.length);
  const rows = samples
    .map(
      (sample) => `
        <tr>
          <td><a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(sample.Number)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(sample.Number)}</a></td>
          <td>${sample.Relation === "older" ? "古い" : "新しい"}</td>
          <td>${escapeHtml(sample.CommitCount)}</td>
          <td>${sample.TurnDays.toFixed(1)} 日</td>
          <td>${sample.TotalDays.toFixed(1)} 日</td>
          <td>${sample.ReadyDays.toFixed(1)} 日</td>
          <td>${sample.IsFirstTimer === true ? '<span style="color: var(--success); font-weight: 600;">初回</span>' : sample.IsFirstTimer === false ? '<span style="color: var(--text-muted);">常連</span>' : "-"}</td>
          <td>${escapeHtml(formatDateTimeWithDay(sample.LatestCommittedDate))}</td>
          <td>${escapeHtml(formatDateTimeWithDay(sample.MergedAt))}</td>
        </tr>`,
    )
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

/** チャートを載せるカード。描画できるだけの観測が無いときは理由を示す */
function renderChartCard(svg: string | null): string {
  return `<div class="card chart-card" style="margin-bottom: 1.5rem;">${
    svg ?? `<div class="card-subtext">観測が 2 件以上たまると推移を表示します</div>`
  }</div>`;
}

const HYPOTHESIS_STYLE: Record<HypothesisId, { mark: string; color: string }> = {
  "rank-velocity": { mark: "①", color: "var(--primary)" },
  "update-order": { mark: "②", color: "var(--warning)" },
  "creation-order": { mark: "③", color: "var(--success)" },
};

/** "2026-12-03" → "12/03" */
function toMonthDay(timeMs: number): string {
  return formatJstDate(timeMs).slice(5).replace("-", "/");
}

function formatEtaDays(days: number): string {
  return days === 0 ? "到達済み" : `約 ${days} 日後`;
}

/** 3 つの仮説によるマージ時期の予想を比較するパネル（ページの最上部に置く） */
function renderForecastPanel(comparison: ForecastComparison): string {
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

  const markers = comparison.hypotheses.flatMap((h) =>
    h.estimates
      .filter((e) => e.primary)
      .map((e) => ({
        label: `${HYPOTHESIS_STYLE[h.id].mark} ${toMonthDay(e.dateMs)}`,
        dateMs: e.dateMs,
        color: HYPOTHESIS_STYLE[h.id].color,
      })),
  );
  const timeline = renderTimelineSvg({
    title: "3 つの仮説による予想マージ日",
    nowMs: comparison.nowMs,
    markers,
    band: range ? { startMs: range.startMs, endMs: range.endMs } : undefined,
  });

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
      ${timeline ? `<div style="margin: 0.75rem 0;">${timeline}</div>` : ""}
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

/** 仮説② の根拠: 優等生の底の先頭の遅れの推移と直近の観測 */
function renderForecastSection(samples: StaleFrontierSample[]): string {
  const recent = samples.slice(-5).reverse();
  const lagChart = renderLineChartSvg({
    title: "優等生の底の先頭の遅れの推移（日）",
    series: [
      {
        label: "先頭の遅れ（日）",
        color: "var(--warning)",
        points: samples
          .slice(-CHART_MAX_POINTS)
          .map((s) => ({ x: s.timestampMs, y: (s.timestampMs - s.updatedMs) / DAY_MS })),
      },
    ],
    decimals: 1,
  });
  const rows = recent
    .map((sample) => {
      const lag = Math.round(((sample.timestampMs - sample.updatedMs) / DAY_MS) * 10) / 10;
      return `
        <tr>
          <td>${escapeHtml(formatJstDate(sample.timestampMs))} ${escapeHtml(new Date(sample.timestampMs + 9 * 3_600_000).toISOString().slice(11, 16))}</td>
          <td>#${escapeHtml(sample.pr)}</td>
          <td>${escapeHtml(formatJstDate(sample.updatedMs))}</td>
          <td>${lag} 日</td>
        </tr>`;
    })
    .join("");

  return `
    <h2 class="section-title">🔮 仮説② の根拠（優等生の底の推移）</h2>
    <p class="section-note">
      仮説②「更新の古い順に処理される」の根拠です。優等生の底の先頭の更新時刻が、基準 PR の更新時刻に届いた時点を予想します（予想日は最上部の比較を参照）。
    </p>
    <p class="section-note">
      先頭の遅れが横ばいなら先頭は進んでいません。実時間と同じ速度（1 日/日）で先頭が進むと、遅れは一定のままです。右下がりなら先頭が実時間より速く進んでいます。
    </p>
    ${renderChartCard(lagChart)}
    ${
      recent.length > 0
        ? `<table>
      <thead>
        <tr>
          <th>観測日時 (JST)</th>
          <th>優等生の底の先頭</th>
          <th>先頭の最終更新</th>
          <th>先頭の遅れ</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`
        : ""
    }`;
}

const SCORE_KEY_LABELS: Record<string, string> = {
  "rank-velocity": "① 順位消化",
  "update-order:steady": "② 更新順（定常待ち時間）",
  "update-order:observed": "② 更新順（実測の進み）",
  "creation-order:median": "③ 作成順（中央値）",
  "creation-order:p75": "③ 作成順（75%点）",
};

/** 誤差（日）を符号つきで表示する。+ は予想が実際より遅かった */
function formatErrorDays(days: number): string {
  if (days === 0) return "±0 日";
  return `${days > 0 ? "+" : ""}${days} 日`;
}

/** 予想の答え合わせ: 基準 PR のマージ後に、仮説・モデルごとの予想誤差を示す */
function renderForecastScoreSection(
  history: ForecastHistoryLine[],
  scores: ForecastScore[],
): string {
  const recorded = history.filter((line) => line.Type === "forecast").length;
  const note = `
    <p class="section-note">
      観測のたびに 3 つの仮説の予想日を記録し、基準 PR がマージされたら実際のマージ日との誤差を採点します。誤差は「予想日 − 実際のマージ日」で、+ は予想が遅すぎ、− は早すぎです。
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

/** JST の "YYYY-MM-DD HH:mm" */
function formatJstDateTime(timeMs: number): string {
  return `${formatJstDate(timeMs)} ${new Date(timeMs + 9 * 3_600_000).toISOString().slice(11, 16)}`;
}

/** 待ち行列からの離脱の内訳: 実質待ちの減少が、実際のマージによるものか、それ以外かを分解して示す */
function renderExitBreakdownSection(result: ExitBreakdownResult): string {
  const head = `
    <h2 class="section-title">🧮 待ち行列からの離脱の内訳</h2>
    <p class="section-note">
      実質待ち（更新順の順位）の減少が、実際のマージによるものか、それ以外かを分解します。仮説①（順位消化）の予想が、実際のマージをどれだけ反映しているかの目安です。
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

  return `${head}
    <p class="section-note">${escapeHtml(formatJstDateTime(result.baseMs))} 〜 ${escapeHtml(formatJstDateTime(result.latestMs))}（${result.hours} 時間）の変化。${summary}</p>
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

function generateHtml(
  progress: LatestProgress | null,
  depths: LatestDepths | null,
  csvRows: ProgressHistoryRow[],
  frontierSamples: StaleFrontierSample[] = [],
  forecastHistory: ForecastHistoryLine[] = [],
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
  const queueChart = renderLineChartSvg({
    title: "待ち件数の推移",
    series: [
      {
        label: "実質待ち（更新順）",
        color: "var(--primary)",
        points: chartRecords.map((r) => ({ x: r.timestampMs, y: r.activeAhead })),
      },
      {
        label: "累積待ち（作成順）",
        color: "var(--text-muted)",
        points: chartRecords.map((r) => ({ x: r.timestampMs, y: r.totalAhead })),
      },
    ],
  });

  const comparison = calculateForecastComparison(
    buildForecastSource({ progress, depths, history: historyRecords, frontierSamples }),
  );
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
      min-width: 120px;
      flex-shrink: 0;
    }
    .flow-node.target {
      border: 2px solid var(--primary);
      background-color: var(--primary-light);
    }
    .flow-arrow {
      color: var(--text-muted);
      font-weight: bold;
      font-size: 1rem;
      text-align: center;
      white-space: nowrap;
    }
    .flow-arrow-note {
      font-size: 0.75rem;
      font-weight: normal;
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
    .progress-bar { height: 6px; background-color: var(--code-bg); border-radius: 3px; margin-top: 0.4rem; overflow: hidden; }
    .progress-bar > div { height: 100%; background-color: var(--success); border-radius: 3px; }
    .forecast-panel { margin-bottom: 0.5rem; }
    .section-note { font-size: 0.875rem; color: var(--text-muted); margin: -0.5rem 0 1rem; }
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

    ${renderForecastPanel(comparison)}

    <div class="grid" style="margin-top: 1.5rem;">
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

    <h2 class="section-title">📉 待ち件数の推移</h2>
    <p class="section-note">
      現在の定義で記録された観測だけを表示します。実質待ち（更新順）は、前にいた PR が更新されて順位が入れ替わった分も含んで増減するため、作成順の累積待ちと並べて見てください。
    </p>
    ${renderChartCard(queueChart)}

    ${renderExitBreakdownSection(exitBreakdown)}

    <h2 class="section-title">⏱️ マージ実績の所要日数統計 (直近 ${escapeHtml(progress?.LookbackDays ?? 30)} 日間${progress?.SampleCount === undefined ? "" : ` / 採用 ${progress.SampleCount} 件・除外 ${progress.SkippedCount ?? 0} 件`})</h2>
    ${
      progress?.SampleCount !== undefined && progress.SampleCount < FEW_SAMPLES
        ? `<p class="section-note">※ サンプルが少ないため、数値は変動しやすくなっています。</p>`
        : ""
    }
    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 2rem;">${renderStatCard(
      "手番所要日数 (Turn Latency)",
      { median: progress?.TurnMedianDays, p75: progress?.TurnP75Days, max: progress?.TurnMaxDays },
      progress?.TurnLatencyDays,
      progress?.Guidance?.Turn,
      "最新コミットからマージされるまでの日数（修正後の再レビュー待ち）",
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
    )}${
      progress?.FirstTimerMedianDays !== undefined && progress?.FirstTimerMedianDays !== null
        ? renderFirstTimerStatCard(progress)
        : ""
    }
    </div>

    ${renderOvertakeSection(progress)}

    <h2 class="section-title">📊 トリアージキュー構造</h2>
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
        <strong>後続キュー</strong>
        <div style="font-size: 0.7rem; color: var(--text-muted);">CI 通過待ち含む</div>
      </div>
    </div>

    ${renderRivalsSection(progress)}

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
        ${(depths?.AbsoluteBottom ?? [])
          .slice(0, 3)
          .map(
            (item) => `
        <tr>
          <td><span class="badge" style="background:#fce7f3;color:#9d174d;">真の大底</span></td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank">#${escapeHtml(item.Number)}</a></td>
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>
        `,
          )
          .join("")}
        ${(depths?.ExpressLane ?? [])
          .slice(0, 5)
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
      </tbody>
    </table>

    <h2 class="section-title">🧗 優等生の底（順番待ちの先頭）</h2>
    <p class="section-note">
      指摘が一度も付かずにすぐ健康になり、そのまま順番を待つだけの PR（基準 PR と同種）のうち、最終更新が古い順です（旧称: 遭難の底）。
      更新の古い順に処理されるなら、この先頭の進みが待ち行列の実質的な進みを表します。
    </p>
    ${renderStaleBottomTable(depths)}

    <h3 class="subsection-title" style="margin-top: 1.5rem; font-size: 1.125rem; font-weight: 600;">🌱 初回提出者の底（真の FIFO 前線）</h3>
    <p class="section-note">
      優等生の底から常連コントリビューターを除外した、純粋な初回提出者（authorAssociation = NONE × 1コミット）の順番待ち先頭です。
      常連まとめマージのノイズがない完全な FIFO 列を示します。
    </p>
    ${renderFirstTimerBottomTable(depths)}

    ${renderForecastSection(frontierSamples)}

    ${renderForecastScoreSection(forecastHistory, forecastScores)}

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
        : `<p style="color: var(--text-muted); font-size: 0.875rem;">現在の指標定義（更新順の待ち順位）の推移データはまだ蓄積されていません。旧定義の履歴は比較できないため表示しません。</p>`
    }

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

export function buildDashboard(options: BuildOptions): { htmlPath: string } {
  const { dataDir, outputDir } = options;

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const progressPath = join(dataDir, "latest-progress.json");
  const depthsPath = join(dataDir, "latest-depths.json");
  const csvPath = join(dataDir, "progress-history.csv");
  const depthsHistoryPath = join(dataDir, "depths-history.jsonl");
  const forecastHistoryPath = join(dataDir, "forecast-history.jsonl");

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

  let frontierSamples: StaleFrontierSample[] = [];
  if (existsSync(depthsHistoryPath)) {
    try {
      frontierSamples = extractStaleFrontierSamples(
        parseDepthsHistory(readFileSync(depthsHistoryPath, "utf-8")),
      );
    } catch (e) {
      throw buildError("キュー境界履歴", depthsHistoryPath, e);
    }
  }

  let forecastHistory: ForecastHistoryLine[] = [];
  if (existsSync(forecastHistoryPath)) {
    try {
      forecastHistory = parseForecastHistory(readFileSync(forecastHistoryPath, "utf-8"));
    } catch (e) {
      throw buildError("予想履歴", forecastHistoryPath, e);
    }
  }

  const html = generateHtml(progress, depths, csvRows, frontierSamples, forecastHistory);
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
    "forecast-history.jsonl",
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
