// キュー境界探索テーブル・待機列の底の比較・仮説②根拠・予想答え合わせ・離脱内訳・直近10回履歴テーブルの描画セクション

import { formatDeltaBadge } from "../../../src/domain/dashboard";
import { DEFAULT_EXIT_WINDOW_HOURS } from "../../../src/domain/exit-breakdown";
import { DAY_MS, formatJstDate, formatJstDateTime, round1 } from "../../../src/domain/formatters";
import type { HistoryRowWithDelta } from "../../../src/models/dashboard";
import type { DepthsRow } from "../../../src/models/depths";
import type {
  ExitBreakdownResult,
  ExitBreakdownUnavailableReason,
} from "../../../src/models/exit-breakdown";
import type { StaleFrontierSample } from "../../../src/models/forecast";
import type { ForecastHistoryLine, ForecastScore } from "../../../src/models/forecast-history";
import { escapeHtml, formatErrorDays, formatNumber, renderBadgeHtml } from "../formatters";
import type { LatestDepths } from "../types";

interface BottomTableRenderOptions {
  showAuthor?: boolean;
  showCommitCount?: boolean;
  highlightRepeaters?: boolean;
  elapsedBasis?: "updated" | "created";
}

/** 底の行一覧のテーブル HTML を生成する */
function renderBottomRowTable(
  items: DepthsRow[],
  timestampIso: string,
  options: BottomTableRenderOptions = {},
): string {
  const {
    showAuthor = false,
    showCommitCount = false,
    highlightRepeaters = false,
    elapsedBasis = "updated",
  } = options;
  const observedMs = Date.parse(timestampIso);
  const rows = items
    .map((item, index) => {
      const baseIso = elapsedBasis === "created" ? item.CreatedAt : item.UpdatedAt;
      const baseMs = Date.parse(baseIso);
      const lag =
        Number.isNaN(observedMs) || Number.isNaN(baseMs)
          ? "-"
          : `${round1((observedMs - baseMs) / DAY_MS)} 日`;
      const isRepeater =
        (Boolean(item.AuthorAssociation) && item.AuthorAssociation !== "NONE") ||
        (item.AuthorMergedCount ?? 0) > 0;
      const repeaterBadge =
        highlightRepeaters && isRepeater
          ? `<span class="badge" style="background: #fee2e2; color: #b91c1c; font-size: 0.7rem; margin-left: 0.35rem;" title="初回提出者ではないため、初回提出者の底では除外">常連除外</span>`
          : "";
      const authorCell = showAuthor ? `<td>${escapeHtml(item.Author ?? "-")}</td>` : "";
      const commitCountText = item.CommitCount !== undefined ? `${item.CommitCount}` : "-";
      const commitCountCell = showCommitCount ? `<td>${commitCountText}</td>` : "";
      return `
        <tr>
          <td>${index + 1}</td>
          <td><a href="${escapeHtml(item.Url)}" target="_blank" rel="noopener noreferrer">#${escapeHtml(item.Number)}</a>${repeaterBadge}</td>
          ${authorCell}
          ${commitCountCell}
          <td>${escapeHtml(item.作成日時 || item.CreatedAt)}</td>
          <td>${escapeHtml(item.更新日時 || item.UpdatedAt)}</td>
          <td>${lag}</td>
          <td>${escapeHtml(item.タイトル || item.Title)}</td>
        </tr>`;
    })
    .join("");
  const authorHeader = showAuthor ? "<th>作者</th>" : "";
  const commitCountHeader = showCommitCount ? "<th>コミット数</th>" : "";
  const elapsedHeader =
    elapsedBasis === "created" ? "<th>起票からの経過</th>" : "<th>更新からの経過</th>";
  return `
    <table>
      <thead>
        <tr>
          <th>順位</th>
          <th>PR 番号</th>
          ${authorHeader}
          ${commitCountHeader}
          <th>起票日時 (JST)</th>
          <th>最終更新 (JST)</th>
          ${elapsedHeader}
          <th>タイトル</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`;
}

/** 優等生の底（1コミット限定・更新が古い順の健康な PR）の表。先頭からの遅れ = 観測時刻 − 最終更新 */
function renderStaleBottomTable(depths: LatestDepths | null): string {
  const items = depths?.StaleBottom ?? [];
  if (items.length === 0) {
    return `<p style="color: var(--text-muted); font-size: 0.875rem;">優等生の底のデータはまだありません。</p>`;
  }
  return renderBottomRowTable(items, depths?.Timestamp ?? "", {
    showAuthor: false,
    showCommitCount: false,
    highlightRepeaters: true,
    elapsedBasis: "updated",
  });
}

/** 初回提出者の底（手直し込みの初回提出者全体・起票日時順の PR）の表。経過 = 観測時刻 − 起票日時 */
function renderFirstTimerBottomTable(depths: LatestDepths | null): string {
  const items = depths?.FirstTimerBottom ?? [];
  if (items.length === 0) {
    return `<p style="color: var(--text-muted); font-size: 0.875rem;">初回提出者の底のデータはまだありません（次回の定期観測から記録されます）。</p>`;
  }
  return renderBottomRowTable(items, depths?.Timestamp ?? "", {
    showAuthor: true,
    showCommitCount: true,
    highlightRepeaters: false,
    elapsedBasis: "created",
  });
}

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

/** キュー境界探索（健康的大底・真の大底・特急レーン）テーブルセクションを描画する */
export function renderBoundaryTableSection(depths: LatestDepths | null): string {
  return `<h2 class="section-title">🧭 キュー境界探索（健康的大底・真の大底・特急レーン）</h2>
    <p class="section-note">
      健康的大底＝CI・検証通過済みの最古 3 件 / 真の大底＝CI 待ち・阻害ラベルを含む未マージ全体の最古 3 件 / ⚡ 特急レーン＝基準 PR 起票後に作成されマージ済みの最新更新 5 件
    </p>
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
        ${renderBoundaryCategoryRows(depths?.HealthyBottom, 3, "background:#e0f2fe;color:#0369a1;", "健康的大底")}
        ${renderBoundaryCategoryRows(depths?.AbsoluteBottom, 3, "background:#fce7f3;color:#9d174d;", "真の大底")}
        ${renderBoundaryCategoryRows(depths?.ExpressLane, 5, "background:#fef3c7;color:#b45309;", "⚡ 特急レーン")}
      </tbody>
    </table>`;
}

/** 下部比較グリッド（優等生の底 vs 初回提出者の底）セクションを描画する */
export function renderBottomComparisonSection(depths: LatestDepths | null): string {
  return `<h2 class="section-title">🧗 待機列の底の比較（優等生 vs 初回提出者）</h2>
    <p class="section-note">
      左は「1コミット完全放置」の待機前線（常連含む）、右はコミット数制限を外した「初回提出者全体（手直し込み）」の待機前線です。
    </p>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 1.5rem; margin-bottom: 2rem;">
      <div class="card" style="padding: 1.25rem; overflow-x: auto;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <h3 style="font-size: 1.05rem; font-weight: 600;">🧗 優等生の底（順番待ちの先頭）</h3>
          <span class="badge" style="background: var(--code-bg); color: var(--text-muted);">全1コミット健康体</span>
        </div>
        <p class="section-note" style="margin-bottom: 0.75rem;">
          指摘なし・健康な1コミットPR（常連含む）。最終更新が古い順です。
        </p>
        ${renderStaleBottomTable(depths)}
      </div>

      <div class="card" style="padding: 1.25rem; overflow-x: auto; border-top: 4px solid var(--success);">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
          <h3 style="font-size: 1.05rem; font-weight: 600; color: var(--success);">🌱 初回提出者の底（真の FIFO 前線）</h3>
          <span class="badge" style="background: #dcfce7; color: #15803d; font-weight: 600;">手直し込み初回全体</span>
        </div>
        <p class="section-note" style="margin-bottom: 0.75rem;">
          初回提出者（authorAssociation = NONE・生涯マージ 0 回）の健康なPR全体（手直しコミット込み）。起票日時の古い順です。
        </p>
        ${renderFirstTimerBottomTable(depths)}
      </div>
    </div>`;
}

const FORECAST_RECENT_TABLE_LIMIT = 5;

/** 仮説② の根拠: 優等生の底の先頭の遅れの推移と直近の観測 */
export function renderForecastSection(samples: StaleFrontierSample[]): string {
  const recent = samples.slice(-FORECAST_RECENT_TABLE_LIMIT).reverse();
  const rows = recent
    .map((sample) => {
      const lag = round1((sample.timestampMs - sample.updatedMs) / DAY_MS);
      return `
        <tr>
          <td>${escapeHtml(formatJstDateTime(sample.timestampMs))}</td>
          <td>#${escapeHtml(sample.pr)}</td>
          <td>${escapeHtml(formatJstDate(sample.updatedMs))}</td>
          <td>${lag} 日</td>
        </tr>`;
    })
    .join("");

  return `
    <h2 class="section-title">🔮 仮説② の根拠（優等生の底の推移・最新 ${FORECAST_RECENT_TABLE_LIMIT} 件）</h2>
    <p class="section-note">
      仮説②「更新の古い順に処理される」の根拠です。優等生の底の先頭の更新時刻が、基準 PR の更新時刻に届いた時点を予想します（予想日は最上部の比較、推移は上部の統合時系列チャートを参照）。
    </p>
    <p class="section-note">
      先頭の遅れが横ばいなら先頭は進んでいません。実時間と同じ速度（1 日/日）で先頭が進むと、遅れは一定のままです。右下がりなら先頭が実時間より速く進んでいます。
    </p>
    ${
      recent.length >= 2
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
        : `<div class="card-subtext">観測が 2 件以上たまると推移を表示します</div>`
    }`;
}

const SCORE_KEY_LABELS: Record<string, string> = {
  "rank-velocity": "① 順位消化",
  "update-order:steady": "② 更新順（定常待ち時間）",
  "update-order:observed": "② 更新順（実測の進み）",
  "creation-order:median": "③ 作成順（中央値）",
  "creation-order:p75": "③ 作成順（75%点）",
};

/** 予想の答え合わせ: 基準 PR のマージ後に、仮説・モデルごとの予想誤差を示す */
export function renderForecastScoreSection(
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

/** 直近 10 回の観測推移ログテーブルセクションを描画する */
export function renderRecentHistorySection(
  recentHistoryWithDeltas: HistoryRowWithDelta[],
  repo: string,
): string {
  return `<h2 class="section-title">📈 直近の観測推移ログ (最新 10 件)</h2>
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
    }`;
}
