# generate-summary.ps1
# Generate a human-readable Markdown summary dashboard from observatory data

[CmdletBinding()]
param(
    [string]$DataDir = "",
    [string]$OutputPath = "SUMMARY.md"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$resolvedDataDir = if (-not [string]::IsNullOrWhiteSpace($DataDir)) {
    $DataDir
} elseif (Test-Path (Join-Path $scriptDir "..\data")) {
    (Resolve-Path (Join-Path $scriptDir "..\data")).Path
} elseif (Test-Path (Join-Path (Get-Location).Path "data")) {
    (Resolve-Path (Join-Path (Get-Location).Path "data")).Path
} else {
    Join-Path $scriptDir "..\data"
}

$progressJsonPath = Join-Path $resolvedDataDir "latest-progress.json"
$depthsJsonPath = Join-Path $resolvedDataDir "latest-depths.json"
$csvPath = Join-Path $resolvedDataDir "progress-history.csv"

if (-not (Test-Path $progressJsonPath) -and -not (Test-Path $depthsJsonPath)) {
    Write-Warning "観測データが見つかりません ($resolvedDataDir)"
    return
}

$progress = if (Test-Path $progressJsonPath) {
    Get-Content $progressJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
} else { $null }

$depths = if (Test-Path $depthsJsonPath) {
    Get-Content $depthsJsonPath -Raw -Encoding utf8 | ConvertFrom-Json
} else { $null }

$historyRecords = @()
if (Test-Path $csvPath) {
    try {
        $historyRecords = @(Import-Csv -Path $csvPath -Encoding utf8)
    }
    catch {
        Write-Warning "CSV の読み込みに失敗しました: $($_.Exception.Message)"
    }
}

$sb = [System.Text.StringBuilder]::new()

[void]$sb.AppendLine("# Winget Observatory Dashboard")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("> [!NOTE]")

$script:JstOffset = [TimeSpan]::FromHours(9)

$updatedJst = if ($progress -and $progress.TimestampJst) {
    $progress.TimestampJst
} elseif ($depths -and $depths.TimestampJst) {
    $depths.TimestampJst
} else {
    [DateTimeOffset]::UtcNow.ToOffset($script:JstOffset).ToString("yyyy-MM-dd HH:mm:ss")
}

$targetPrNum = if ($progress -and $progress.TargetPr) {
    $progress.TargetPr
} elseif ($depths -and $depths.TargetPr) {
    $depths.TargetPr.Number
} else {
    464302
}

$targetTitle = if ($progress -and $progress.PrTitle) {
    $progress.PrTitle
} elseif ($depths -and $depths.TargetPr) {
    $depths.TargetPr.Title
} else {
    ""
}

$targetUrl = if ($progress -and $progress.PrUrl) {
    $progress.PrUrl
} elseif ($depths -and $depths.TargetPr) {
    $depths.TargetPr.Url
} else {
    "https://github.com/microsoft/winget-pkgs/pull/$targetPrNum"
}

[void]$sb.AppendLine("> **最終更新日時 (JST)**: $updatedJst  ")
[void]$sb.AppendLine("> **基準 PR**: [#$targetPrNum ($targetTitle)]($targetUrl)")
[void]$sb.AppendLine("")

# --- 1. 主要メトリクス ---
[void]$sb.AppendLine("## 1. 現在のキュー状況・メトリクス")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("| 指標 | 現在値 | 説明 |")
[void]$sb.AppendLine("|---|---|---|")

if ($null -ne $progress) {
    $frontText = if ($progress.FrontNumber) {
        "**#$($progress.FrontNumber)** ($($progress.FrontCreatedAt) 起票)"
    } else { "-" }
    $activeAheadText = if ($null -ne $progress.ActiveAhead) { "{0:N0} 件" -f [int]$progress.ActiveAhead } else { "-" }
    $totalAheadText = if ($null -ne $progress.TotalAhead) { "{0:N0} 件" -f [int]$progress.TotalAhead } else { "-" }
    $behindText = if ($null -ne $progress.Behind) { "{0:N0} 件" -f [int]$progress.Behind } else { "-" }
    $totalLifeText = if ($progress.TotalLifetimeDays) { "$($progress.TotalLifetimeDays) 日" } else { "-" }
    $turnLatencyText = if ($progress.TurnLatencyDays) { "$($progress.TurnLatencyDays) 日" } else { "-" }
    $waitDaysText = if ($progress.WaitDays) { "$($progress.WaitDays) 日" } else { "-" }

    [void]$sb.AppendLine("| **消化前線** | $frontText | FIFO 列の先頭（直近に正常マージされた最も古いオープン PR） |")
    [void]$sb.AppendLine("| **実質待ち件数** | **$activeAheadText** | 前線〜自 PR 間で生存している健康なオープン PR 件数 |")
    [void]$sb.AppendLine("| **全期間累積待ち** | $totalAheadText | 過去の未消化・保留分を含む累積 PR 番号差 |")
    [void]$sb.AppendLine("| **後続の準備完了 PR** | $behindText | 自 PR より後ろに並んでいる健康なオープン PR 件数 |")
    [void]$sb.AppendLine("| **通算待機日数 (Total)** | **$totalLifeText** | 起票日時からの経過日数 |")
    [void]$sb.AppendLine("| **レビュー待ち時間 (Turn)** | **$turnLatencyText** | 最新コミットからの経過日数（モデレーター側滞留時間） |")
    [void]$sb.AppendLine("| **条件整流後待機 (Ready)** | $waitDaysText | 必須ラベル整流・CI 通過からの待機日数 |")
} else {
    [void]$sb.AppendLine("| 情報 | データ未集計 | `progress-winget.ps1` を実行してください |")
}
[void]$sb.AppendLine("")

# --- 2. キュー構造の視覚化 (Mermaid) ---
[void]$sb.AppendLine("## 2. キュー構造の視覚化")
[void]$sb.AppendLine("")
[void]$sb.AppendLine('```mermaid')
[void]$sb.AppendLine('flowchart LR')
[void]$sb.AppendLine('    subgraph Queue ["microsoft/winget-pkgs トリアージキュー"]')

$hBottomPr = if ($depths -and $depths.HealthyBottom -and $depths.HealthyBottom.Count -gt 0) {
    "#$($depths.HealthyBottom[0].Number)"
} else { "最古PR" }

$frontPrNumVal = if ($progress -and $progress.FrontNumber) { "#$($progress.FrontNumber)" } else { "前線PR" }
$aheadCountVal = if ($progress -and $progress.ActiveAhead) { "{0:N0} 件" -f [int]$progress.ActiveAhead } else { "待機中" }
$behindCountVal = if ($progress -and $progress.Behind) { "{0:N0} 件" -f [int]$progress.Behind } else { "後続" }
$expressCountVal = if ($depths -and $depths.ExpressLane) { "$($depths.ExpressLane.Count) 件検出" } else { "なし" }

[void]$sb.AppendLine("        HB[""健康的な大底<br/>$hBottomPr""] --> Front[""消化前線<br/>$frontPrNumVal""]")
[void]$sb.AppendLine("        Front --> Ahead[""実質待ち PR 群<br/>約 $aheadCountVal""]")
[void]$sb.AppendLine("        Ahead --> Target[""★ 基準 PR #$targetPrNum<br/>scottlz0310.clp2cfg""]")
[void]$sb.AppendLine("        Target --> Behind[""後続の準備完了 PR<br/>約 $behindCountVal""]")
[void]$sb.AppendLine('    end')
[void]$sb.AppendLine('    Front --> Merged["マージ完了 (Merged)"]')
[void]$sb.AppendLine("    Express[""特急レーン / 追い越し<br/>$expressCountVal""] -.->|優先処理| Merged")
[void]$sb.AppendLine('```')
[void]$sb.AppendLine("")

# --- 3. 過去実績との統計比較 ---
if ($null -ne $progress -and ($progress.TotalMedianDays -or $progress.TurnMedianDays)) {
    [void]$sb.AppendLine("## 3. 過去 30 日間マージ実績との統計比較")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| メトリクス | 実績 中央値 (Median) | 実績 75%点 (P75) | あなたの待機 | 状況判定 |")
    [void]$sb.AppendLine("|---|---|---|---|---|")

    $totalStatus = if ($progress.TotalMedianDays -and $progress.TotalLifetimeDays -le $progress.TotalMedianDays) {
        "中央値以内（順調）"
    } else { "中央値超過" }

    $turnStatus = if ($progress.TurnMedianDays -and $progress.TurnLatencyDays -le $progress.TurnMedianDays) {
        "中央値以内"
    } else { "長めの滞留（75%点付近）" }

    [void]$sb.AppendLine("| **通算日数 (作成〜マージ)** | $($progress.TotalMedianDays) 日 | $($progress.TotalP75Days) 日 | **$($progress.TotalLifetimeDays) 日** | $totalStatus |")
    [void]$sb.AppendLine("| **レビュー待ち (最新コミット〜マージ)** | $($progress.TurnMedianDays) 日 | $($progress.TurnP75Days) 日 | **$($progress.TurnLatencyDays) 日** | $turnStatus |")
    [void]$sb.AppendLine("| **条件成立後 (Ready〜マージ)** | $($progress.ReadyMedianDays) 日 | $($progress.ReadyP75Days) 日 | **$($progress.WaitDays) 日** | - |")
    [void]$sb.AppendLine("")
}

# --- 4. キュー境界スナップショット ---
if ($null -ne $depths) {
    [void]$sb.AppendLine("## 4. キュー境界探索スナップショット")
    [void]$sb.AppendLine("")

    [void]$sb.AppendLine("### 4-1. 健康的な大底 (Healthy Bottom)")
    [void]$sb.AppendLine("CI 通過・エラーなしの健康体で、現在最も古いオープン PR（正当な FIFO の先頭候補）：")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| PR | 起票日時 (JST) | 最終更新 (JST) | タイトル |")
    [void]$sb.AppendLine("|---|---|---|---|")
    foreach ($item in $depths.HealthyBottom) {
        $pTitle = if ($item.Title.Length -gt 50) { $item.Title.Substring(0, 47) + "..." } else { $item.Title }
        [void]$sb.AppendLine("| [$($item.PR)]($($item.Url)) | $($item.作成日時) | $($item.更新日時) | $pTitle |")
    }
    [void]$sb.AppendLine("")

    [void]$sb.AppendLine("### 4-2. 特急レーン・追い越し (Express Lane)")
    [void]$sb.AppendLine("基準 PR 起票日以降に作成され、すでにマージされた PR：")
    [void]$sb.AppendLine("")
    if ($depths.ExpressLane -and $depths.ExpressLane.Count -gt 0) {
        [void]$sb.AppendLine("| PR | 起票日時 (JST) | マージ/更新 (JST) | タイトル |")
        [void]$sb.AppendLine("|---|---|---|---|")
        foreach ($item in $depths.ExpressLane) {
            $pTitle = if ($item.Title.Length -gt 50) { $item.Title.Substring(0, 47) + "..." } else { $item.Title }
            [void]$sb.AppendLine("| [$($item.PR)]($($item.Url)) | $($item.作成日時) | $($item.更新日時) | $pTitle |")
        }
    } else {
        [void]$sb.AppendLine("*追い越しマージは検出されませんでした（正当な FIFO 消化順序を維持）。*")
    }
    [void]$sb.AppendLine("")

    [void]$sb.AppendLine("### 4-3. 遭難・放置の底 (Stale Bottom)")
    [void]$sb.AppendLine("健康体の中で更新日時が最も古く、完全に止まっている PR：")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| PR | 起票日時 (JST) | 最終更新 (JST) | タイトル |")
    [void]$sb.AppendLine("|---|---|---|---|")
    foreach ($item in $depths.StaleBottom) {
        $pTitle = if ($item.Title.Length -gt 50) { $item.Title.Substring(0, 47) + "..." } else { $item.Title }
        [void]$sb.AppendLine("| [$($item.PR)]($($item.Url)) | $($item.作成日時) | $($item.更新日時) | $pTitle |")
    }
    [void]$sb.AppendLine("")
}

# --- 5. 推移履歴テーブル ---
if ($historyRecords.Count -gt 0) {
    [void]$sb.AppendLine("## 5. 直近の消化推移履歴")
    [void]$sb.AppendLine("")
    [void]$sb.AppendLine("| 記録日時 (JST) | 消化前線 | 実質待ち | 累積待ち | 通算待機 | レビュー待ち | コミット数 |")
    [void]$sb.AppendLine("|---|---|---|---|---|---|---|")

    $recent = @($historyRecords | Select-Object -Last 10)
    # 新しい順に表示
    for ($i = $recent.Count - 1; $i -ge 0; $i--) {
        $r = $recent[$i]
        $fPr = if ($r.FrontNumber) { "#$($r.FrontNumber)" } else { "-" }
        $aAhead = if ($r.ActiveAhead) { "{0:N0} 件" -f [int]$r.ActiveAhead } else { "-" }
        $tAhead = if ($r.TotalAhead) { "{0:N0} 件" -f [int]$r.TotalAhead } else { "-" }
        $totDays = if ($r.TotalLifetimeDays) { "$($r.TotalLifetimeDays) 日" } else { "-" }
        $turnDays = if ($r.TurnLatencyDays) { "$($r.TurnLatencyDays) 日" } elseif ($r.WaitDays) { "$($r.WaitDays) 日 (旧)" } else { "-" }
        $cCount = if ($r.CommitCount) { $r.CommitCount } else { "-" }

        [void]$sb.AppendLine("| $($r.Timestamp) | $fPr | $aAhead | $tAhead | $totDays | $turnDays | $cCount |")
    }
    [void]$sb.AppendLine("")
}

[void]$sb.AppendLine("---")
[void]$sb.AppendLine("*このドキュメントは [winget-observatory](https://github.com/scottlz0310/winget-observatory) の自動観測ワークフローにより定期更新されます。*")

$content = $sb.ToString()

# 出力ファイル書き込み
$resolvedOutputPath = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath
} else {
    Join-Path (Get-Location).Path $OutputPath
}

$parent = Split-Path -Parent $resolvedOutputPath
if ($parent -and (-not (Test-Path $parent))) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

try {
    [System.IO.File]::WriteAllText($resolvedOutputPath, $content, [System.Text.Encoding]::UTF8)
}
catch {
    throw "サマリードキュメントの保存に失敗しました ($resolvedOutputPath): $($_.Exception.Message)"
}
Write-Host "Summary generated successfully: $resolvedOutputPath"
