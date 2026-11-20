// 例外境界テーブル・予想答え合わせ・離脱内訳・直近10回履歴テーブルの描画セクション（待機ライン 2×2 マトリクスも互換 re-export）

import { formatDeltaBadge } from "../../../src/domain/dashboard";
import { DEFAULT_EXIT_WINDOW_HOURS } from "../../../src/domain/exit-breakdown";
import { formatJstDate, formatJstDateTime, round1 } from "../../../src/domain/formatters";
import type { HistoryRowWithDelta } from "../../../src/models/dashboard";
import type { DepthsRow } from "../../../src/models/depths";
import type {
  ExitBreakdownResult,
  ExitBreakdownUnavailableReason,
} from "../../../src/models/exit-breakdown";
import type { ForecastHistoryLine, ForecastScore } from "../../../src/models/forecast-history";
import { escapeHtml, formatErrorDays, formatNumber, renderBadgeHtml } from "../formatters";
import type { LatestDepths } from "../types";

export { renderWaitlineMatrixSection } from "./waitline-matrix";

function renderBoundaryCategoryRows(
  items: DepthsRow[] | undefined,
  limit: number,
  badgeStyle: string,
  badgeLabel: string,
): string {
  return (items ?? [])
    .slice(0, limit)
    .map(
      (item) => `
        <tr>
          <td><span class="badge" style="${badgeStyle}">${badgeLabel}</span></td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank">#${escapeHtml(item.Number)}</a></td>
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>
        `,
    )
    .join("");
}

/** 例外・特殊境界（真の大底・特急レーン）テーブルセクションを描画する */
export function renderBoundaryTableSection(depths: LatestDepths | null): string {
  return `<h2 class="section-title">🚧 例外・特殊境界（真の大底・特急レーン）</h2>
    <p class="section-note">
      通常待機列（2×2 マトリクス）の枠外にある参照境界です。真の大底＝CI 待ち・阻害ラベルを含む未マージ全体の最古 3 件 / ⚡ 特急レーン＝基準 PR 起票後に作成されマージ済みの最新更新 5 件
    </p>
    <div class="table-scroll">
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
          ${renderBoundaryCategoryRows(depths?.AbsoluteBottom, 3, "background:#fce7f3;color:#9d174d;", "真の大底")}
          ${renderBoundaryCategoryRows(depths?.ExpressLane, 5, "background:#fef3c7;color:#b45309;", "⚡ 特急レーン")}
        </tbody>
      </table>
    </div>`;
}

const SCORE_KEY_LABELS: Record<string, string> = {
  "rank-velocity": "① 順位消化",
  "creation-order:median": "② 作成順（中央値）",
  "creation-order:p75": "② 作成順（75%点）",
};

/** 予想の答え合わせ: 基準 PR のマージ後に、仮説・モデルごとの予想誤差および処理バンド的中率を示す */
export function renderForecastScoreSection(
  history: ForecastHistoryLine[],
  scores: ForecastScore[],
): string {
  const recorded = history.filter((line) => line.Type === "forecast").length;
  const note = `
    <p class="section-note">
      観測のたびに予想日（2 つの仮説および統合処理バンド）を記録し、基準 PR がマージされたら実際のマージ日との誤差・バンド的中率を採点します。誤差は「予想日 − 実際のマージ日」で、+ は予想が遅すぎ、− は早すぎです。
    </p>`;
  if (scores.length === 0) {
    return `
    <h2 class="section-title">🎯 予想の答え合わせ</h2>${note}
    <p class="section-note">基準 PR がマージされると、仮説・モデルごとの予想誤差と処理バンド的中率をここに表示します（記録済みの予想 ${recorded} 件）。</p>`;
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

      const b = score.bandScore;
      const bandTable = b
        ? `
    <div class="table-scroll" style="margin-top: -0.75rem;">
      <table>
        <thead>
          <tr><th>統合処理バンド評価 (JST暦日基準)</th><th>本命バンド的中率</th><th>全体レンジ包含率</th><th>中央値平均誤差 / 絶対誤差</th><th>直前の本命予想</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>処理バンド統合</td>
            <td><strong>${b.count > 0 ? `${b.mainstreamHitRatePct}% (${b.mainstreamHitCount}/${b.count} 回)` : "-"}</strong></td>
            <td>${b.overallCount > 0 ? `${b.overallHitRatePct}% (${b.overallHitCount}/${b.overallCount} 回)` : "-"}</td>
            <td>${b.medianMeanErrorDays !== null ? `${formatErrorDays(b.medianMeanErrorDays)} / ${b.medianMeanAbsErrorDays ?? "-"} 日` : "-"}</td>
            <td>${b.lastInMainstreamBand === null ? "-" : b.lastInMainstreamBand ? "✅ バンド内" : "❌ バンド外"}${b.medianLastErrorDays !== null ? ` (${formatErrorDays(b.medianLastErrorDays)})` : ""}</td>
          </tr>
        </tbody>
      </table>
    </div>`
        : "";

      return `
    <h3 class="section-note" style="margin: 1rem 0 0.5rem; font-weight: 600;">${escapeHtml(score.repository)} #${score.targetPr}（マージ: ${escapeHtml(formatJstDate(score.mergedAtMs))}、予想の記録 ${score.observationCount} 回）</h3>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>仮説・モデル</th><th>採点数</th><th>平均誤差</th><th>平均絶対誤差</th><th>最後の予想の誤差</th></tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </div>${bandTable}`;
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

/** 待ち行列からの離脱の内訳: 実質待ちの減少が、実際のマージによるものか、それ以外かを分解して示す */
export function renderExitBreakdownSection(result: ExitBreakdownResult): string {
  const targetDays = round1(DEFAULT_EXIT_WINDOW_HOURS / 24);
  const head = `
    <h2 class="section-title">🧮 待ち行列からの離脱の内訳</h2>
    <p class="section-note">
      実質待ち（更新順の順位）の減少が、実際のマージによるものか、それ以外かを分解します（比較対象は直近約 ${targetDays} 日間 / ${DEFAULT_EXIT_WINDOW_HOURS} 時間窓基準）。仮説①（順位消化）の予想が、実際のマージをどれだけ反映しているかの目安です。
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

  const windowSpan = `${result.hours.toFixed(1)} 時間 / ${(result.hours / 24).toFixed(1)} 日`;

  return `${head}
    <p class="section-note">${escapeHtml(formatJstDateTime(result.baseMs))} 〜 ${escapeHtml(formatJstDateTime(result.latestMs))}（${windowSpan}）の変化。${summary}</p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>内訳</th><th>件数</th><th>1 日あたり</th><th>割合</th></tr>
        </thead>
        <tbody>${row("実質待ち（更新順）の減少", "rank")}${row("マージ", "merged", true)}${row("未マージでクローズ", "closed", true)}${row("健康条件の変化など（推定）", "healthChange", true)}${row("更新による順位の入れ替わり（推定）", "reshuffle", true)}
        </tbody>
      </table>
    </div>
    <p class="section-note">
      マージ・クローズは、起票が基準 PR より前で、必須ラベルが現在も付いている PR の、基準 PR の起票以降の累積件数の差です（検索の集計）。「健康条件の変化など」は、累積待ち（作成順）の減少からマージ・クローズを引いた残り、「更新による順位の入れ替わり」は、実質待ちの減少から累積待ちの減少を引いた差で、どちらも推定です。
    </p>`;
}

/** 直近 10 回の観測推移ログテーブルセクションを描画する */
export function renderRecentHistorySection(
  recentHistoryWithDeltas: HistoryRowWithDelta[],
  repo: string,
): string {
  return `<h2 class="section-title">📈 直近の観測推移ログ (最新 10 件)</h2>
    ${
      recentHistoryWithDeltas.length > 0
        ? `
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>観測日時 (JST)</th>
            <th>基準 PR</th>
            <th>健康的大底 PR</th>
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
    </div>
    `
        : `<p style="color: var(--text-muted); font-size: 0.875rem;">現在の指標定義（更新順の待ち順位）の推移データはまだ蓄積されていません。旧定義の履歴は比較できないため表示しません。</p>`
    }`;
}
