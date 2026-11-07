/**
 * サマリー生成（summary）に関するドメインロジック。
 * 外部 I/O を行わない純粋関数群であり、src/models の型定義のみに依存する。
 */

import type { SummaryDataInputs } from "../models/summary";

export function escapeMermaidLabel(text: string): string {
  return text.replace(/"/g, "#quot;");
}

function truncateText(text: string, maxLength = 50): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.substring(0, maxLength - 3)}...`;
}

function formatNumber(num: number | string | undefined | null): string {
  if (num === undefined || num === null || num === "") {
    return "-";
  }
  const parsed = typeof num === "string" ? Number.parseInt(num, 10) : num;
  if (Number.isNaN(parsed)) {
    return "-";
  }
  return parsed.toLocaleString();
}

/**
 * 観測データ（進捗、キュー境界、推移履歴）から人間向け Markdown ダッシュボードを構築する。
 */
export function generateSummaryMarkdown(inputs: SummaryDataInputs): string {
  const { progress, depths, historyRecords } = inputs;

  const lines: string[] = [];

  lines.push("# Winget Observatory Dashboard");
  lines.push("");
  lines.push("> [!NOTE]");

  const updatedJst = progress?.TimestampJst || depths?.TimestampJst || new Date().toISOString();
  const repo = progress?.Repository || depths?.Repository || "microsoft/winget-pkgs";
  const targetPrNum = progress?.TargetPr || depths?.TargetPr?.Number || 464302;
  const targetTitle = progress?.PrTitle || depths?.TargetPr?.Title || "";
  const targetUrl =
    progress?.PrUrl || depths?.TargetPr?.Url || `https://github.com/${repo}/pull/${targetPrNum}`;

  lines.push(`> **最終更新日時 (JST)**: ${updatedJst}  `);
  lines.push(`> **基準 PR**: [#${targetPrNum} (${targetTitle})](${targetUrl})`);
  lines.push("");

  // --- 1. 主要メトリクス ---
  lines.push("## 1. 現在のキュー状況・メトリクス");
  lines.push("");
  lines.push("| 指標 | 現在値 | 説明 |");
  lines.push("|---|---|---|");

  if (progress) {
    const frontText = progress.FrontNumber
      ? `**#${progress.FrontNumber}** (${progress.FrontCreatedAt} 起票)`
      : "-";
    const activeAheadText =
      progress.ActiveAhead !== "" && progress.ActiveAhead !== undefined
        ? `${formatNumber(progress.ActiveAhead)} 件`
        : "-";
    const totalAheadText =
      progress.TotalAhead !== undefined ? `${formatNumber(progress.TotalAhead)} 件` : "-";
    const behindText = progress.Behind !== undefined ? `${formatNumber(progress.Behind)} 件` : "-";
    const totalLifeText = progress.TotalLifetimeDays ? `${progress.TotalLifetimeDays} 日` : "-";
    const turnLatencyText = progress.TurnLatencyDays ? `${progress.TurnLatencyDays} 日` : "-";
    const waitDaysText = progress.WaitDays ? `${progress.WaitDays} 日` : "-";

    lines.push(
      `| **消化前線** | ${frontText} | FIFO 列の先頭（直近に正常マージされた最も古いオープン PR） |`,
    );
    lines.push(
      `| **実質待ち件数** | **${activeAheadText}** | 前線〜自 PR 間で生存している健康なオープン PR 件数 |`,
    );
    lines.push(
      `| **全期間累積待ち** | ${totalAheadText} | 過去の未消化・保留分を含む累積 PR 番号差 |`,
    );
    lines.push(
      `| **後続の準備完了 PR** | ${behindText} | 自 PR より後ろに並んでいる健康なオープン PR 件数 |`,
    );
    lines.push(`| **通算待機日数 (Total)** | **${totalLifeText}** | 起票日時からの経過日数 |`);
    lines.push(
      `| **レビュー待ち時間 (Turn)** | **${turnLatencyText}** | 最新コミットからの経過日数（モデレーター側滞留時間） |`,
    );
    lines.push(
      `| **条件整流後待機 (Ready)** | ${waitDaysText} | 必須ラベル整流・CI 通過からの待機日数 |`,
    );
  } else {
    lines.push("| 情報 | データ未集計 | `progress` を実行してください |");
  }
  lines.push("");

  // --- 2. キュー構造の視覚化 (Mermaid) ---
  lines.push("## 2. キュー構造の視覚化");
  lines.push("");
  lines.push("```mermaid");
  lines.push("flowchart LR");
  lines.push('    subgraph Queue ["microsoft/winget-pkgs トリアージキュー"]');

  const hBottomPr =
    depths?.HealthyBottom && depths.HealthyBottom.length > 0
      ? `#${depths.HealthyBottom[0].Number}`
      : "最古PR";

  const frontPrNumVal = progress?.FrontNumber ? `#${progress.FrontNumber}` : "前線PR";
  const aheadCountVal =
    progress?.ActiveAhead !== undefined && progress?.ActiveAhead !== ""
      ? `${formatNumber(progress.ActiveAhead)} 件`
      : "待機中";
  const behindCountVal =
    progress?.Behind !== undefined ? `${formatNumber(progress.Behind)} 件` : "後続";
  const expressCountVal =
    depths?.ExpressLane && depths.ExpressLane.length > 0
      ? `${depths.ExpressLane.length} 件検出`
      : "なし";

  lines.push(
    `        HB["健康的な大底<br/>${escapeMermaidLabel(hBottomPr)}"] --> Front["消化前線<br/>${escapeMermaidLabel(frontPrNumVal)}"]`,
  );
  lines.push(
    `        Front --> Ahead["実質待ち PR 群<br/>約 ${escapeMermaidLabel(aheadCountVal)}"]`,
  );
  lines.push(
    `        Ahead --> Target["★ 基準 PR #${targetPrNum}<br/>${escapeMermaidLabel(truncateText(targetTitle, 30))}"]`,
  );
  lines.push(
    `        Target --> Behind["後続の準備完了 PR<br/>約 ${escapeMermaidLabel(behindCountVal)}"]`,
  );
  lines.push("    end");
  lines.push('    Front --> Merged["マージ完了 (Merged)"]');
  lines.push(
    `    Express["特急レーン / 追い越し<br/>${escapeMermaidLabel(expressCountVal)}"] -.->|優先処理| Merged`,
  );
  lines.push("```");
  lines.push("");

  // --- 3. 過去実績との統計比較 ---
  if (progress && (progress.TotalMedianDays || progress.TurnMedianDays)) {
    lines.push("## 3. 過去 30 日間マージ実績との統計比較");
    lines.push("");
    lines.push(
      "| メトリクス | 実績 中央値 (Median) | 実績 75%点 (P75) | あなたの待機 | 状況判定 |",
    );
    lines.push("|---|---|---|---|---|");

    const totalStatus =
      progress.TotalMedianDays && progress.TotalLifetimeDays <= progress.TotalMedianDays
        ? "中央値以内（順調）"
        : "中央値超過";

    const turnStatus =
      progress.TurnMedianDays && progress.TurnLatencyDays <= progress.TurnMedianDays
        ? "中央値以内"
        : "長めの滞留（75%点付近）";

    lines.push(
      `| **通算日数 (作成〜マージ)** | ${progress.TotalMedianDays} 日 | ${progress.TotalP75Days} 日 | **${progress.TotalLifetimeDays} 日** | ${totalStatus} |`,
    );
    lines.push(
      `| **レビュー待ち (最新コミット〜マージ)** | ${progress.TurnMedianDays} 日 | ${progress.TurnP75Days} 日 | **${progress.TurnLatencyDays} 日** | ${turnStatus} |`,
    );
    lines.push(
      `| **条件成立後 (Ready〜マージ)** | ${progress.ReadyMedianDays} 日 | ${progress.ReadyP75Days} 日 | **${progress.WaitDays} 日** | - |`,
    );
    lines.push("");
  }

  // --- 4. キュー境界スナップショット ---
  if (depths) {
    lines.push("## 4. キュー境界探索スナップショット");
    lines.push("");

    lines.push("### 4-1. 健康的な大底 (Healthy Bottom)");
    lines.push(
      "CI 通過・エラーなしの健康体で、現在最も古いオープン PR（正当な FIFO の先頭候補）：",
    );
    lines.push("");
    lines.push("| PR | 起票日時 (JST) | 最終更新 (JST) | タイトル |");
    lines.push("|---|---|---|---|");
    for (const item of depths.HealthyBottom) {
      lines.push(
        `| [${item.PR}](${item.Url}) | ${item.作成日時 || item.CreatedAt} | ${item.更新日時 || item.UpdatedAt} | ${truncateText(item.Title || item.タイトル)} |`,
      );
    }
    lines.push("");

    lines.push("### 4-2. 特急レーン・追い越し (Express Lane)");
    lines.push("基準 PR 起票日以降に作成され、すでにマージされた PR：");
    lines.push("");
    if (depths.ExpressLane && depths.ExpressLane.length > 0) {
      lines.push("| PR | 起票日時 (JST) | マージ/更新 (JST) | タイトル |");
      lines.push("|---|---|---|---|");
      for (const item of depths.ExpressLane) {
        lines.push(
          `| [${item.PR}](${item.Url}) | ${item.作成日時 || item.CreatedAt} | ${item.更新日時 || item.UpdatedAt} | ${truncateText(item.Title || item.タイトル)} |`,
        );
      }
    } else {
      lines.push("*追い越しマージは検出されませんでした（正当な FIFO 消化順序を維持）。*");
    }
    lines.push("");

    lines.push("### 4-3. 遭難・放置の底 (Stale Bottom)");
    lines.push("健康体の中で更新日時が最も古く、完全に止まっている PR：");
    lines.push("");
    lines.push("| PR | 起票日時 (JST) | 最終更新 (JST) | タイトル |");
    lines.push("|---|---|---|---|");
    for (const item of depths.StaleBottom) {
      lines.push(
        `| [${item.PR}](${item.Url}) | ${item.作成日時 || item.CreatedAt} | ${item.更新日時 || item.UpdatedAt} | ${truncateText(item.Title || item.タイトル)} |`,
      );
    }
    lines.push("");
  }

  // --- 5. 直近の消化推移履歴 ---
  if (historyRecords.length > 0) {
    lines.push("## 5. 直近の消化推移履歴");
    lines.push("");
    lines.push(
      "| 記録日時 (JST) | 消化前線 | 実質待ち | 累積待ち | 通算待機 | レビュー待ち | コミット数 |",
    );
    lines.push("|---|---|---|---|---|---|---|");

    const recent = historyRecords.slice(-10);
    // 新しい順に表示
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i];
      const fPr = r.FrontNumber ? `#${r.FrontNumber}` : "-";
      const aAhead = r.ActiveAhead !== "" ? `${formatNumber(r.ActiveAhead)} 件` : "-";
      const tAhead = r.TotalAhead !== "" ? `${formatNumber(r.TotalAhead)} 件` : "-";
      const totDays = r.TotalLifetimeDays ? `${r.TotalLifetimeDays} 日` : "-";
      const turnDays = r.TurnLatencyDays
        ? `${r.TurnLatencyDays} 日`
        : r.WaitDays
          ? `${r.WaitDays} 日 (旧)`
          : "-";
      const cCount = r.CommitCount || "-";

      lines.push(
        `| ${r.Timestamp} | ${fPr} | ${aAhead} | ${tAhead} | ${totDays} | ${turnDays} | ${cCount} |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "*このドキュメントは [winget-observatory](https://github.com/scottlz0310/winget-observatory) の自動観測ワークフローにより定期更新されます。*",
  );
  lines.push("");

  return lines.join("\n");
}
