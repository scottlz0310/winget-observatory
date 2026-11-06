# progress-winget.ps1
# PowerShell 7 / GitHub CLI (gh)

[CmdletBinding()]
param(
    [int]$PrNumber = $(if ($env:WINGET_TARGET_PR) { [int]$env:WINGET_TARGET_PR } else { 464302 }),
    [string]$Repository = $(if ($env:WINGET_REPOSITORY) { $env:WINGET_REPOSITORY } else { "microsoft/winget-pkgs" }),

    [ValidateRange(1, 365)]
    [int]$LookbackDays = 30,

    [ValidateRange(1, 100)]
    [int]$SampleSize = 30,

    [ValidateRange(1, 1000)]
    [int]$FetchLimit = 1000,

    [ValidateRange(50, 1000)]
    [int]$QueueLimit = 500,

    [string]$LogPath = "",
    [string]$SnapshotPath = "",

    [switch]$NoLog
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([Console]::OutputEncoding.CodePage -ne 65001) {
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    }
    catch {
        # コンソール環境によってはエンコーディング変更が制限される場合があるため安全に継続
    }
}
$OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- 比較条件 ----------

$RequiredLabels = @(
    "New-Package"
    "Azure-Pipeline-Passed"
    "Validation-Completed"
)

# 明確な阻害要因
$BlockedLabels = @(
    "Needs-CLA"
    "Needs-Author-Feedback"
    "Changes-Requested"
    "Blocking-Issue"
    "Blocked-InstallerType"
    "Author-Not-Authorized"
    "Author-Not-Verified"
    "Manifest-Content-Incomplete"
    "Package-Metadata-Invalid"
    "PullRequest-Error"
    "Unexpected-File"
    "Network-Blocker"
    "Possible-Duplicate"
    "Resolution-Duplicate"
    "Validation-Merge-Conflict"
    "Validation-Retry"
    "Timeout-Retry"
    "Testing"
)

# 通常のレビュー待ちとは事情が異なるもの
$InvestigationLabels = @(
    "Package-Flagged"
    "PUA-Detection"
    "Needs-SmartScreen-Investigation"
    "Validate-Domain-Installer"
    "Validation-Agreement-Domain"
    "Validation-Certificate-Root"
    "Validation-Domain"
    "Validation-Domains-Mismatch"
    "Validation-Framework-Package"
    "Validation-Hash-Flagged"
    "Validation-Hash-Verification-Failed"
    "Validation-Unapproved-URL"
    "Validation-SmartScreen"
)

# 名前で判定する追加条件
# Validation-* 全体は除外しない（Completedなどもあるため）
$BlockedPatterns = @(
    "^Error-"
    "-Error$"
    "^Policy-Test-"
    "^Validation-Submission-(Expired|Failed|Mismatch|Missing|Unsupported)$"
)

# ---------- 共通処理 ----------

function Invoke-GhJson {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $origEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

        $output = & gh @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub CLIの実行に失敗: gh $($Arguments -join ' ')"
        }

        $text = $output -join "`n"
        if ([string]::IsNullOrWhiteSpace($text)) {
            throw "GitHub CLIからJSONが返りませんでした。"
        }

        # 不正な制御文字（\x00 〜 \x1f。ただし \t, \n, \r は除く）をサニタイズして JSON パース失敗を防止
        $cleanText = [System.Text.RegularExpressions.Regex]::Replace($text, "[\x00-\x08\x0B\x0C\x0E-\x1F]", "")
        ConvertFrom-Json -InputObject $cleanText -Depth 100
    }
    finally {
        [Console]::OutputEncoding = $origEncoding
    }
}

function Format-HumanDays {
    param([double]$Days)
    $ts = [TimeSpan]::FromDays($Days)
    if ($ts.Days -gt 0) {
        return "{0:0.0}日 ({1}日 {2}時間)" -f $Days, $ts.Days, $ts.Hours
    }
    return "{0:0.0}日 ({1}時間)" -f $Days, [int]$ts.TotalHours
}

function Format-Delta {
    param(
        [Parameter(Mandatory)][int]$Current,
        [Parameter(Mandatory)][int]$Previous,
        [string]$Unit = "件"
    )
    $diff = $Current - $Previous
    if ($diff -gt 0) {
        return "[前回比 +$diff $Unit]"
    }
    elseif ($diff -lt 0) {
        return "[前回比 $diff $Unit]"
    }
    else {
        return "[前回比 ±0 $Unit]"
    }
}

function Format-DateTimeWithDay {
    param([DateTimeOffset]$Dto)
    return $Dto.ToLocalTime().ToString("yyyy-MM-dd(ddd) HH:mm")
}

function Test-BlockedLabel {
    param([string]$Name)

    if ($Name -in $BlockedLabels -or
        $Name -in $InvestigationLabels) {
        return $true
    }

    foreach ($pattern in $BlockedPatterns) {
        if ($Name -match $pattern) {
            return $true
        }
    }

    return $false
}

function Test-EligibleLabels {
    param([System.Collections.Generic.HashSet[string]]$Labels)

    foreach ($name in $RequiredLabels) {
        if (-not $Labels.Contains($name)) {
            return $false
        }
    }

    foreach ($name in $Labels) {
        if (Test-BlockedLabel $name) {
            return $false
        }
    }

    return $true
}

function Get-Percentile {
    param(
        [double[]]$Values,
        [ValidateRange(0, 1)][double]$Percentile
    )

    $sorted = @($Values | Sort-Object)
    if ($sorted.Count -eq 0) {
        throw "集計対象がありません。"
    }

    $position = ($sorted.Count - 1) * $Percentile
    $lower = [int][math]::Floor($position)
    $upper = [int][math]::Ceiling($position)
    $fraction = $position - $lower

    $sorted[$lower] +
        ($sorted[$upper] - $sorted[$lower]) * $fraction
}

function Get-AheadOpenPrs {
    param(
        [int]$TargetNumber,
        [DateTimeOffset]$TargetCreatedAt,
        [DateTimeOffset]$FrontCreatedAt = [DateTimeOffset]::MinValue
    )

    $createdIso = $TargetCreatedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")

    $baseParts = @(
        "repo:$Repository"
        "is:pr"
        "is:open"
        "draft:false"
    )
    foreach ($name in $RequiredLabels) {
        $baseParts += 'label:"{0}"' -f $name
    }
    foreach ($b in $BlockedLabels) {
        $baseParts += '-label:"{0}"' -f $b
    }
    foreach ($inv in $InvestigationLabels) {
        $baseParts += '-label:"{0}"' -f $inv
    }

    # 全期間の累積待ちPR検索
    $aheadQueryParts = $baseParts + "created:<$createdIso"
    $encodedAhead = [System.Uri]::EscapeDataString($aheadQueryParts -join " ")
    $searchRes = Invoke-GhJson -Arguments @(
        "api"
        "search/issues?q=$encodedAhead&sort=created&order=desc&per_page=15"
    )
    $aheadTotal = $searchRes.total_count

    # 直前ライバルPR抽出
    $rivals = [System.Collections.Generic.List[object]]::new()
    if ($null -ne $searchRes.items) {
        foreach ($item in $searchRes.items) {
            if ($item.number -ge $TargetNumber) {
                continue
            }

            $hasBlockedPattern = $false
            if ($null -ne $item.labels) {
                foreach ($l in $item.labels) {
                    if (Test-BlockedLabel $l.name) {
                        $hasBlockedPattern = $true
                        break
                    }
                }
            }
            if ($hasBlockedPattern) {
                continue
            }

            $rivals.Add([pscustomobject]@{
                Number    = $item.number
                Title     = $item.title
                CreatedAt = [DateTimeOffset]::Parse($item.created_at)
                Url       = $item.html_url
            })

            if ($rivals.Count -ge 5) {
                break
            }
        }
    }

    # 前線からの実質的な待ち件数（前線PRのCreatedAt 〜 自分のCreatedAt）
    $activeAheadCount = $null
    if ($FrontCreatedAt -gt [DateTimeOffset]::MinValue -and $FrontCreatedAt -lt $TargetCreatedAt) {
        $frontIso = $FrontCreatedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
        $rangeQueryParts = $baseParts + "created:$frontIso..$createdIso"
        $encodedRange = [System.Uri]::EscapeDataString($rangeQueryParts -join " ")
        $rangeRes = Invoke-GhJson -Arguments @(
            "api"
            "search/issues?q=$encodedRange&per_page=1"
        )
        $activeAheadCount = $rangeRes.total_count
    }

    # 全体のオープン準備完了PR総数
    $encodedTotal = [System.Uri]::EscapeDataString($baseParts -join " ")
    $totalRes = Invoke-GhJson -Arguments @(
        "api"
        "search/issues?q=$encodedTotal&per_page=1"
    )
    $allTotal = $totalRes.total_count

    return [pscustomobject]@{
        ActiveAheadCount = $activeAheadCount
        AheadCount       = $aheadTotal
        TotalCount       = $allTotal
        BehindCount      = [Math]::Max(0, $allTotal - $aheadTotal - 1)
        Rivals           = $rivals
    }
}

function Format-Days {
    param([double]$Days)
    $Days.ToString("0.0")
}

function Get-ReadySince {
    param(
        [int]$Number,
        [string[]]$CurrentLabels,
        [bool]$CurrentIsDraft,
        [DateTimeOffset]$EndAt
    )

    # --paginate --slurp により、全ページを配列として取得
    $pages = @(Invoke-GhJson -Arguments @(
        "api"
        "repos/$Repository/issues/$Number/timeline?per_page=100"
        "--paginate"
        "--slurp"
    ))

    $events = @(
        foreach ($page in $pages) {
            foreach ($item in @($page)) {
                if ($null -eq $item) {
                    continue
                }

                # StrictModeでも、存在しないプロパティを安全に確認
                $dateProperty = $item.PSObject.Properties["created_at"]
                $eventProperty = $item.PSObject.Properties["event"]

                if ($null -eq $dateProperty -or
                    $null -eq $eventProperty) {
                    continue
                }

                if ([string]::IsNullOrWhiteSpace([string]$dateProperty.Value)) {
                    continue
                }

                # 今回の計算に必要なイベントだけを採用
                if ($eventProperty.Value -notin @(
                    "labeled"
                    "unlabeled"
                    "converted_to_draft"
                    "ready_for_review"
                )) {
                    continue
                }

                $item
            }
        }
    )

    $events = @(
        $events | Sort-Object {
            [DateTimeOffset]::Parse($_.created_at)
        }
    )

    # 最初のDraft切り替えイベントから初期状態を復元。
    # 切り替え履歴がなければ現在状態を使用。
    $isDraft = $CurrentIsDraft
    foreach ($event in $events) {
        if ($event.event -eq "ready_for_review") {
            $isDraft = $true
            break
        }
        if ($event.event -eq "converted_to_draft") {
            $isDraft = $false
            break
        }
    }

    $labels = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    $readySince = $null

    foreach ($event in $events) {
        $at = [DateTimeOffset]::Parse($event.created_at)

        # マージ後のラベル変更は待機時間の計算に含めない
        if ($at -gt $EndAt) {
            break
        }

        switch ($event.event) {
            "labeled" {
                [void]$labels.Add([string]$event.label.name)
            }
            "unlabeled" {
                [void]$labels.Remove([string]$event.label.name)
            }
            "converted_to_draft" {
                $isDraft = $true
            }
            "ready_for_review" {
                $isDraft = $false
            }
            default {
                continue
            }
        }

        $eligible = (-not $isDraft) -and
            (Test-EligibleLabels -Labels $labels)

        if ($eligible) {
            if ($null -eq $readySince) {
                $readySince = $at
            }
        }
        else {
            $readySince = $null
        }
    }

    # OPEN PRの場合は履歴と現在状態の整合性も確認
    if ($EndAt -eq $script:Now) {
        $current = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        foreach ($name in $CurrentLabels) {
            [void]$current.Add($name)
        }

        if (-not $labels.SetEquals($current)) {
            throw "PR #${Number}: ラベル履歴と現在状態が一致しません。"
        }

        if ($isDraft -ne $CurrentIsDraft) {
            throw "PR #${Number}: Draft履歴と現在状態が一致しません。"
        }
    }

    return $readySince
}

# ---------- メイン ----------

try {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "GitHub CLI (gh) が見つかりません。"
    }

    $script:Now = [DateTimeOffset]::UtcNow

    $pr = Invoke-GhJson -Arguments @(
        "pr", "view", "$PrNumber"
        "--repo", $Repository
        "--json", "number,title,url,createdAt,state,mergedAt,closedAt,labels,isDraft,commits"
    )

    $created = [DateTimeOffset]::Parse($pr.createdAt)
    $labelNames = @($pr.labels | ForEach-Object { $_.name })

    # コミット情報の抽出（committedDate を使用）
    $commits = @($pr.commits)
    $commitCount = $commits.Count
    $latestCommit = if ($commitCount -gt 0) { $commits[-1] } else { $null }
    $latestCommittedDate = if ($null -ne $latestCommit) {
        [DateTimeOffset]::Parse($latestCommit.committedDate)
    } else {
        $created
    }

    $totalLifetimeDays = ($Now - $created).TotalDays
    $turnLatencyDays = ($Now - $latestCommittedDate).TotalDays

    Write-Host "=== $Repository PR #$PrNumber ==="
    Write-Host $pr.title
    Write-Host $pr.url
    Write-Host "ステータス                 : $($pr.state)"
    Write-Host "通算待機日数 (Total)       : $(Format-HumanDays $totalLifetimeDays) (起票: $(Format-DateTimeWithDay $created))"

    # コミット1件時（初手から手直しなし）の微小ズレ吸収・表示
    if ($commitCount -le 1) {
        $deltaCommitCreated = [Math]::Abs(($created - $latestCommittedDate).TotalMinutes)
        $diffText = if ($deltaCommitCreated -ge 1) {
            " (起票と約 $([int][Math]::Round($deltaCommitCreated)) 分差)"
        } else {
            ""
        }
        Write-Host "レビュー待ち時間 (Turn)    : $(Format-HumanDays $turnLatencyDays) [初手から手直しなし (1コミット)$diffText]"
    }
    else {
        $commitMsg = if ($null -ne $latestCommit -and $latestCommit.messageHeadline) {
            $latestCommit.messageHeadline
        } else {
            ""
        }
        $shortOid = if ($null -ne $latestCommit -and $latestCommit.oid) {
            $latestCommit.oid.Substring(0, [Math]::Min(7, $latestCommit.oid.Length))
        } else {
            ""
        }
        $commitDetail = if ($commitMsg) { " - $commitMsg" } else { "" }
        Write-Host "レビュー待ち時間 (Turn)    : $(Format-HumanDays $turnLatencyDays) [最新コミット: $(Format-DateTimeWithDay $latestCommittedDate) ($commitCount コミット目: $shortOid$commitDetail)]"
    }

    if ($pr.state -ne "OPEN") {
        $endText = if ($pr.state -eq "MERGED") {
            $pr.mergedAt
        }
        else {
            $pr.closedAt
        }

        $endAt = [DateTimeOffset]::Parse($endText)
        $endTotalDays = ($endAt - $created).TotalDays
        $endTurnDays = ($endAt - $latestCommittedDate).TotalDays
        Write-Host "通算所要日数 (作成〜終了)   : $(Format-HumanDays $endTotalDays)"
        Write-Host "最終ターン所要日数 (最新〜) : $(Format-HumanDays $endTurnDays)"
        return
    }

    $missing = @(
        $RequiredLabels | Where-Object { $_ -notin $labelNames }
    )
    $blocking = @(
        $labelNames | Where-Object { Test-BlockedLabel $_ }
    )

    if ($pr.isDraft -or $missing.Count -gt 0 -or $blocking.Count -gt 0) {
        Write-Host ""
        Write-Host "現在は今回の比較条件を満たしていません。"

        if ($pr.isDraft) {
            Write-Host "Draft            : はい"
        }
        if ($missing.Count -gt 0) {
            Write-Host "不足ラベル       : $($missing -join ', ')"
        }
        if ($blocking.Count -gt 0) {
            Write-Host "除外ラベル       : $($blocking -join ', ')"
        }
        return
    }

    Write-Host "比較条件                   : 必須3ラベルあり・除外ラベルなし・Draftでない"

    $targetReady = Get-ReadySince `
        -Number $PrNumber `
        -CurrentLabels $labelNames `
        -CurrentIsDraft ([bool]$pr.isDraft) `
        -EndAt $Now

    if ($null -eq $targetReady) {
        throw "対象PRの条件成立日時を履歴から特定できませんでした。"
    }

    $waitDays = ($Now - $targetReady).TotalDays
    Write-Host "条件が整った日時 (ReadyAt) : $(Format-DateTimeWithDay $targetReady)"
    Write-Host "整ってからの待機 (Ready)   : $(Format-HumanDays $waitDays)"

    # 過去ログファイルの確認と前回レコードの読み込み
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $baseDataDir = if (Test-Path (Join-Path $scriptDir "..\data")) {
        (Resolve-Path (Join-Path $scriptDir "..\data")).Path
    } elseif (Test-Path (Join-Path (Get-Location).Path "data")) {
        (Resolve-Path (Join-Path (Get-Location).Path "data")).Path
    } else {
        Join-Path $scriptDir "..\data"
    }

    $historyCsvPath = if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        $LogPath
    } elseif ($env:WINGET_LOG_PATH) {
        $env:WINGET_LOG_PATH
    } elseif (Test-Path (Join-Path $baseDataDir "progress-history.csv")) {
        Join-Path $baseDataDir "progress-history.csv"
    } elseif (Test-Path (Join-Path $scriptDir "progress-history.csv")) {
        Join-Path $scriptDir "progress-history.csv"
    } else {
        Join-Path $baseDataDir "progress-history.csv"
    }
    $prevRecord = $null
    $pastHistory = [System.Collections.Generic.List[object]]::new()
    $allHistory = @()

    if (Test-Path $historyCsvPath) {
        try {
            $allHistory = @(Import-Csv -Path $historyCsvPath -Encoding utf8)
            foreach ($rec in $allHistory) {
                if ([int]$rec.TargetPr -eq $PrNumber) {
                    $pastHistory.Add($rec)
                }
            }
            if ($pastHistory.Count -gt 0) {
                $prevRecord = $pastHistory[$pastHistory.Count - 1]
            }
        }
        catch {
            Write-Warning "履歴ファイル ($historyCsvPath) の読み込みに失敗しました: $($_.Exception.Message)"
        }
    }

    # 必須ラベルを検索条件に設定。
    # 除外条件は、マージ時点の履歴で確認するためここには入れない。
    $sinceIso = $Now.AddDays(-$LookbackDays).ToString(
        "yyyy-MM-ddTHH:mm:ssZ"
    )

    $searchParts = @(
        "merged:>=$sinceIso"
        "sort:updated-desc"
    )
    foreach ($name in $RequiredLabels) {
        $searchParts += 'label:"{0}"' -f $name
    }

    # 候補PR一覧取得（GraphQL ノード制限回避のため、リスト取得時は commits を含めず基本情報のみ取得）
    $candidates = @(Invoke-GhJson -Arguments @(
        "pr", "list"
        "--repo", $Repository
        "--state", "merged"
        "--search", ($searchParts -join " ")
        "--limit", "$FetchLimit"
        "--json", "number,title,mergedAt,labels,isDraft,createdAt"
    ))

    if ($candidates.Count -ge $FetchLimit) {
        Write-Warning "取得上限 $FetchLimit 件に達しました。候補は期間内の全件ではない可能性があります。"
    }

    $candidates = @(
        $candidates |
            Where-Object { $_.number -ne $PrNumber -and $_.mergedAt } |
            Sort-Object {
                [DateTimeOffset]::Parse($_.mergedAt)
            } -Descending
    )

    $samples = [System.Collections.Generic.List[object]]::new()
    $skipped = 0
    $failed = 0
    $checked = 0

    foreach ($candidate in $candidates) {
        if ($samples.Count -ge $SampleSize) {
            break
        }

        $checked++
        Write-Progress `
            -Activity "比較PRのラベル履歴を確認中" `
            -Status "確認 $checked 件 / 採用 $($samples.Count) 件"

        try {
            $mergedAt = [DateTimeOffset]::Parse($candidate.mergedAt)
            $names = @($candidate.labels | ForEach-Object { $_.name })

            $readyAt = Get-ReadySince `
                -Number $candidate.number `
                -CurrentLabels $names `
                -CurrentIsDraft ([bool]$candidate.isDraft) `
                -EndAt $mergedAt

            if ($null -eq $readyAt) {
                $skipped++
                continue
            }

            $readyDays = ($mergedAt - $readyAt).TotalDays
            if ($readyDays -lt 0) {
                $skipped++
                continue
            }

            $createdAt = [DateTimeOffset]::Parse($candidate.createdAt)

            # サンプルとして採用決定したPRのコミット情報を取得（committedDate を使用）
            $candDetail = Invoke-GhJson -Arguments @(
                "pr", "view", "$($candidate.number)"
                "--repo", $Repository
                "--json", "commits"
            )
            $candCommits = @($candDetail.commits)
            $candCommitCount = $candCommits.Count
            $candLatestCommit = if ($candCommitCount -gt 0) { $candCommits[-1] } else { $null }
            $candLatestCommittedDate = if ($null -ne $candLatestCommit) {
                [DateTimeOffset]::Parse($candLatestCommit.committedDate)
            } else {
                $createdAt
            }

            $totalDays = ($mergedAt - $createdAt).TotalDays
            $turnDays = ($mergedAt - $candLatestCommittedDate).TotalDays

            $samples.Add([pscustomobject]@{
                Number              = $candidate.number
                Title               = $candidate.title
                CreatedAt           = $createdAt
                LatestCommittedDate = $candLatestCommittedDate
                CommitCount         = $candCommitCount
                ReadyAt             = $readyAt
                MergedAt            = $mergedAt
                TotalDays           = $totalDays
                TurnDays            = $turnDays
                Days                = $readyDays
            })
        }
        catch {
            $failed++
            Write-Warning "PR #$($candidate.number) を集計できませんでした: $($_.Exception.Message)"
        }
    }

    Write-Progress -Activity "比較PRのラベル履歴を確認中" -Completed

    # ---------- 現在の待ち行列状況（消化前線基準） ----------
    $frontPr = if ($samples.Count -gt 0) {
        $samples | Sort-Object { $_.MergedAt } -Descending | Select-Object -First 1
    } else {
        $null
    }

    $frontCreatedAt = if ($null -ne $frontPr) { $frontPr.CreatedAt } else { [DateTimeOffset]::MinValue }
    $queueInfo = Get-AheadOpenPrs -TargetNumber $PrNumber -TargetCreatedAt $created -FrontCreatedAt $frontCreatedAt

    Write-Host ""
    Write-Host "----------------------------------------"
    Write-Host "【現在のレビュー待ち行列（実質的な待ち人数）】"

    $frontDeltaText = ""
    if ($null -ne $frontPr -and $null -ne $prevRecord -and $prevRecord.FrontNumber) {
        $prevFrontNum = [int]$prevRecord.FrontNumber
        $frontDiff = $frontPr.Number - $prevFrontNum
        if ($frontDiff -gt 0) {
            $frontDeltaText = " [前回 #$prevFrontNum から +$frontDiff 件前進]"
        } elseif ($frontDiff -eq 0) {
            $frontDeltaText = " [前回から変動なし]"
        } else {
            $frontDeltaText = " [前回 #$prevFrontNum]"
        }
    }

    if ($null -ne $frontPr) {
        $frontCreatedText = $frontPr.CreatedAt.ToLocalTime().ToString("yyyy-MM-dd")
        $frontMergedText = $frontPr.MergedAt.ToLocalTime().ToString("yyyy-MM-dd HH:mm")
        Write-Host "消化前線（直近マージPR）   : #$($frontPr.Number) (作成: $frontCreatedText / マージ: $frontMergedText)$frontDeltaText"
        if ($null -ne $queueInfo.ActiveAheadCount) {
            $deltaActive = if ($null -ne $prevRecord -and $prevRecord.ActiveAhead) {
                " " + (Format-Delta -Current $queueInfo.ActiveAheadCount -Previous ([int]$prevRecord.ActiveAhead))
            } else { "" }
            Write-Host "前線からの実質的な待ちPR   : 約 $([string]::Format('{0:N0}', $queueInfo.ActiveAheadCount)) 件$deltaActive （前線〜あなたのPR作成日までに提出され健康に待機中）"
        }
    }

    $deltaAhead = if ($null -ne $prevRecord -and $prevRecord.TotalAhead) {
        " " + (Format-Delta -Current $queueInfo.AheadCount -Previous ([int]$prevRecord.TotalAhead))
    } else { "" }
    Write-Host "全期間の累積待ちPR (参考) : 約 $([string]::Format('{0:N0}', $queueInfo.AheadCount)) 件$deltaAhead （過去の未消化滞留分を含む累積）"

    $deltaBehind = if ($null -ne $prevRecord -and $prevRecord.Behind) {
        " " + (Format-Delta -Current $queueInfo.BehindCount -Previous ([int]$prevRecord.Behind))
    } else { "" }
    Write-Host "あなたの後ろに並ぶ準備完了PR: 約 $([string]::Format('{0:N0}', $queueInfo.BehindCount)) 件$deltaBehind"
    Write-Host "----------------------------------------" 

    if ($queueInfo.Rivals.Count -gt 0) {
        Write-Host ""
        Write-Host "直前のライバルPR（あなたの直前に並んでいるPR TOP $($queueInfo.Rivals.Count)）:"
        $queueInfo.Rivals |
            Select-Object `
                @{Name = "PR";             Expression = { "#$($_.Number)" } },
                @{Name = "作成日時 (JST)"; Expression = { Format-DateTimeWithDay $_.CreatedAt } },
                @{Name = "タイトル";       Expression = { $_.Title } } |
            Format-Table -AutoSize |
            Out-Host
    }

    Write-Host "----------------------------------------"
    Write-Host "比較対象         : 過去 $LookbackDays 日間のマージ済みPR"
    Write-Host "採用サンプル     : $($samples.Count) 件"
    Write-Host "条件不成立で除外 : $skipped 件"
    Write-Host "取得・解析失敗   : $failed 件"

    if ($samples.Count -eq 0) {
        Write-Host "比較可能なサンプルがありませんでした。"
        return
    }

    $totalValues = @($samples | ForEach-Object { [double]$_.TotalDays })
    $turnValues  = @($samples | ForEach-Object { [double]$_.TurnDays })
    $readyValues = @($samples | ForEach-Object { [double]$_.Days })

    $totalMedian = Get-Percentile -Values $totalValues -Percentile 0.5
    $totalP75    = Get-Percentile -Values $totalValues -Percentile 0.75
    $totalMax    = ($totalValues | Measure-Object -Maximum).Maximum

    $turnMedian  = Get-Percentile -Values $turnValues -Percentile 0.5
    $turnP75     = Get-Percentile -Values $turnValues -Percentile 0.75
    $turnMax     = ($turnValues | Measure-Object -Maximum).Maximum

    $readyMedian = Get-Percentile -Values $readyValues -Percentile 0.5
    $readyP75    = Get-Percentile -Values $readyValues -Percentile 0.75
    $readyMax    = ($readyValues | Measure-Object -Maximum).Maximum

    Write-Host ""
    Write-Host "【過去実績との統計比較】"
    Write-Host "1. 通算日数 (Total Lifetime: 作成→マージ)"
    Write-Host "   中央値: $(Format-HumanDays $totalMedian) | 75%点: $(Format-HumanDays $totalP75) | 最大: $(Format-HumanDays $totalMax)"
    Write-Host "   あなたの待機 : $(Format-HumanDays $totalLifetimeDays)"
    Write-Host ""
    Write-Host "2. レビュー待ち (Turn Latency: 最新コミット→マージ)"
    Write-Host "   中央値: $(Format-HumanDays $turnMedian) | 75%点: $(Format-HumanDays $turnP75) | 最大: $(Format-HumanDays $turnMax)"
    $turnNote = if ($commitCount -le 1) { " [初手から手直しなし]" } else { "" }
    Write-Host "   あなたの待機 : $(Format-HumanDays $turnLatencyDays)$turnNote"
    Write-Host ""
    Write-Host "3. （参考）条件成立後 (ReadyAt→マージ)"
    Write-Host "   中央値: $(Format-HumanDays $readyMedian) | 75%点: $(Format-HumanDays $readyP75) | 最大: $(Format-HumanDays $readyMax)"
    Write-Host "   あなたの待機 : $(Format-HumanDays $waitDays)"

    if ($samples.Count -lt 10) {
        Write-Host "※ サンプルが少ないため、数値は変動しやすくなっています。"
    }

    Write-Host "----------------------------------------"
    Write-Host "参考目安:"
    # レビュー待ち（Turn Latency）基準の評価
    if ($turnLatencyDays -lt $turnMedian) {
        Write-Host "  [レビュー待ち] 中央値以内です。中央値到達まであと約 $(Format-HumanDays ($turnMedian - $turnLatencyDays))。"
    }
    elseif ($turnLatencyDays -lt $turnP75) {
        Write-Host "  [レビュー待ち] 中央値を超えています。75%点到達まであと約 $(Format-HumanDays ($turnP75 - $turnLatencyDays)) です。"
    }
    else {
        Write-Host "  [レビュー待ち] 75%点を超えており、モデレーター側で長めの滞留となっています。"
    }

    # 通算日数（Total Lifetime）基準の評価
    if ($totalLifetimeDays -lt $totalMedian) {
        Write-Host "  [通算日数]     全体の中央値以内です (中央値まであと約 $(Format-HumanDays ($totalMedian - $totalLifetimeDays)))。"
    }
    elseif ($totalLifetimeDays -lt $totalP75) {
        Write-Host "  [通算日数]     全体の中央値を超えています (75%点まであと約 $(Format-HumanDays ($totalP75 - $totalLifetimeDays)))。"
    }
    else {
        Write-Host "  [通算日数]     起票からサンプルの75%点を超える長期待機となっています。"
    }

    # 全件ではなく、今回採用したサンプル内での件数
    $laterReady = @(
        $samples | Where-Object { $_.ReadyAt -gt $targetReady }
    ).Count

    # 作成日・PR番号ベースの比較
    $laterCreated = @(
        $samples | Where-Object { $_.CreatedAt -gt $created }
    ).Count
    $earlierCreated = @(
        $samples | Where-Object { $_.CreatedAt -le $created }
    ).Count
    $newerNumber = @(
        $samples | Where-Object { $_.Number -gt $PrNumber }
    ).Count
    $olderNumber = @(
        $samples | Where-Object { $_.Number -lt $PrNumber }
    ).Count

    Write-Host ""
    Write-Host "【条件成立日時の比較（ReadyAt）】"
    Write-Host "  採用サンプル内で、自分より後に条件が整いマージ済み : $laterReady 件"

    Write-Host ""
    Write-Host "【作成日・PR番号の比較（CreatedAt / PR番号）】"
    Write-Host "  自分より後に作成されマージ済み   : $laterCreated 件"
    Write-Host "  自分より前に作成されマージ済み   : $earlierCreated 件"
    Write-Host "  自分より新しいPR番号 (>$PrNumber) : $newerNumber 件"
    Write-Host "  自分より古いPR番号   (<$PrNumber) : $olderNumber 件"

    if ($laterCreated -eq 0 -and $newerNumber -eq 0) {
        Write-Host "  ※ マージされたPRはすべて自分より前に作成された（古いPR番号の）ものです。"
        Write-Host "     条件成立からの待機が短く見えるPRも、PR自体は過去に作成されており、"
        Write-Host "     古いPRのバックログ順次消化が進んでいる状況と考えられます（追い越されてはいません）。"
    } elseif ($laterCreated -le 2) {
        Write-Host "  ※ マージされたPRのほぼ全てが自分より前に作成されたものです。"
        Write-Host "     自分より後に作成されたPRに大きく追い越されているわけではありません。"
    }

    Write-Host ""
    Write-Host "参考サンプル（マージ日時順）:"
    $samples |
        Select-Object `
            @{Name = "PR";                     Expression = { "#$($_.Number)" } },
            @{Name = "作成順";                 Expression = { if ($_.Number -lt $PrNumber) { "古い" } elseif ($_.Number -gt $PrNumber) { "新しい" } else { "同一" } } },
            @{Name = "コミット";               Expression = { $_.CommitCount } },
            @{Name = "レビュー待ち(最新から)"; Expression = { Format-HumanDays $_.TurnDays } },
            @{Name = "通算日数(作成から)";     Expression = { Format-HumanDays $_.TotalDays } },
            @{Name = "待機(成立後)";           Expression = { Format-HumanDays $_.Days } },
            @{Name = "最新コミット (JST)";     Expression = { Format-DateTimeWithDay $_.LatestCommittedDate } },
            @{Name = "マージ日時 (JST)";       Expression = { Format-DateTimeWithDay $_.MergedAt } } |
        Format-Table -AutoSize |
        Out-Host

    Write-Host "※ 待機はラベルとDraftの履歴に基づきます。レビュー本文・チェック履歴は解析しません。"
    Write-Host "※ 候補検索は現在の必須ラベルを使うため、マージ後にそれらが外れたPRは含まれません。"
    Write-Host "※ 日数差は実績との比較であり、残り待ち時間の予測ではありません。"

    # ---------- 実行ログの保存と直近履歴テーブル ----------
    if (-not $NoLog -and $null -ne $queueInfo) {
        $nowJst = [DateTimeOffset]::UtcNow.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
        $frontNumVal = if ($null -ne $frontPr) { $frontPr.Number } else { "" }
        $frontCreatedVal = if ($null -ne $frontPr) { $frontPr.CreatedAt.ToString("yyyy-MM-dd HH:mm") } else { "" }
        $activeVal = if ($null -ne $queueInfo.ActiveAheadCount) { $queueInfo.ActiveAheadCount } else { "" }

        $logRow = [pscustomobject]@{
            Timestamp         = $nowJst
            TargetPr          = $PrNumber
            FrontNumber       = $frontNumVal
            FrontCreatedAt    = $frontCreatedVal
            ActiveAhead       = $activeVal
            TotalAhead        = $queueInfo.AheadCount
            Behind            = $queueInfo.BehindCount
            TotalLifetimeDays = [Math]::Round($totalLifetimeDays, 2)
            TurnLatencyDays   = [Math]::Round($turnLatencyDays, 2)
            WaitDays          = [Math]::Round($waitDays, 2)
            CommitCount       = $commitCount
        }

        try {
            $logDir = Split-Path -Parent $historyCsvPath
            if ($logDir -and (-not (Test-Path $logDir))) {
                New-Item -ItemType Directory -Path $logDir -Force | Out-Null
            }

            $csvExists = Test-Path $historyCsvPath
            if ($csvExists) {
                # 既存CSVのヘッダー検査
                $headerLine = (Get-Content -Path $historyCsvPath -First 1)
                $hasNewColumns = ($headerLine -match "TotalLifetimeDays" -and $headerLine -match "TurnLatencyDays")

                if (-not $hasNewColumns) {
                    # 既存データを新スキーマへマイグレーション
                    $migratedRecords = [System.Collections.Generic.List[object]]::new()
                    foreach ($rec in $allHistory) {
                        $migratedRecords.Add([pscustomobject]@{
                            Timestamp         = $rec.Timestamp
                            TargetPr          = $rec.TargetPr
                            FrontNumber       = $rec.FrontNumber
                            FrontCreatedAt    = $rec.FrontCreatedAt
                            ActiveAhead       = $rec.ActiveAhead
                            TotalAhead        = $rec.TotalAhead
                            Behind            = $rec.Behind
                            TotalLifetimeDays = ""
                            TurnLatencyDays   = ""
                            WaitDays          = $rec.WaitDays
                            CommitCount       = ""
                        })
                    }
                    $migratedRecords.Add($logRow)
                    $migratedRecords | Export-Csv -Path $historyCsvPath -NoTypeInformation -Encoding utf8
                }
                else {
                    $logRow | Export-Csv -Path $historyCsvPath -Append -NoTypeInformation -Encoding utf8
                }
            }
            else {
                $logRow | Export-Csv -Path $historyCsvPath -NoTypeInformation -Encoding utf8
            }

            $pastHistory.Add($logRow)
        }
        catch {
            Write-Warning "履歴ファイルへの保存に失敗しました: $($_.Exception.Message)"
        }

        # スナップショット JSON の保存（最新状態の構造化データ）
        $resolvedSnapshotPath = if (-not [string]::IsNullOrWhiteSpace($SnapshotPath)) {
            $SnapshotPath
        } elseif ($env:WINGET_SNAPSHOT_PATH) {
            $env:WINGET_SNAPSHOT_PATH
        } else {
            Join-Path $baseDataDir "latest-progress.json"
        }

        try {
            $snapshotDir = Split-Path -Parent $resolvedSnapshotPath
            if ($snapshotDir -and (-not (Test-Path $snapshotDir))) {
                New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
            }
            $snapshotData = [pscustomobject]@{
                Timestamp         = [DateTimeOffset]::UtcNow.ToString("o")
                TimestampJst      = $nowJst
                Repository        = $Repository
                TargetPr          = $PrNumber
                PrTitle           = $pr.title
                PrUrl             = $pr.url
                PrState           = $pr.state
                FrontNumber       = $frontNumVal
                FrontCreatedAt    = $frontCreatedVal
                ActiveAhead       = $activeVal
                TotalAhead        = $queueInfo.AheadCount
                Behind            = $queueInfo.BehindCount
                TotalLifetimeDays = [Math]::Round($totalLifetimeDays, 2)
                TurnLatencyDays   = [Math]::Round($turnLatencyDays, 2)
                WaitDays          = [Math]::Round($waitDays, 2)
                CommitCount       = $commitCount
                TotalMedianDays   = if (Test-Path variable:totalMedian) { [Math]::Round($totalMedian, 2) } else { $null }
                TotalP75Days      = if (Test-Path variable:totalP75) { [Math]::Round($totalP75, 2) } else { $null }
                TurnMedianDays    = if (Test-Path variable:turnMedian) { [Math]::Round($turnMedian, 2) } else { $null }
                TurnP75Days       = if (Test-Path variable:turnP75) { [Math]::Round($turnP75, 2) } else { $null }
                ReadyMedianDays   = if (Test-Path variable:readyMedian) { [Math]::Round($readyMedian, 2) } else { $null }
                ReadyP75Days      = if (Test-Path variable:readyP75) { [Math]::Round($readyP75, 2) } else { $null }
            }
            $snapshotData | ConvertTo-Json -Depth 5 | Set-Content -Path $resolvedSnapshotPath -Encoding utf8
        }
        catch {
            Write-Warning "スナップショットファイルへの保存に失敗しました: $($_.Exception.Message)"
        }

        if ($pastHistory.Count -gt 0) {
            Write-Host ""
            Write-Host "直近の推移履歴（最新 $([Math]::Min(5, $pastHistory.Count)) 件）:"
            $recent = @($pastHistory | Select-Object -Last 5)
            $recent |
                Select-Object `
                    @{Name = "記録日時 (JST)"; Expression = { $_.Timestamp } },
                    @{Name = "消化前線";       Expression = { if ($_.FrontNumber) { "#$($_.FrontNumber)" } else { "-" } } },
                    @{Name = "実質待ち";       Expression = { if ($_.ActiveAhead) { "{0:N0} 件" -f [int]$_.ActiveAhead } else { "-" } } },
                    @{Name = "累積待ち";       Expression = { "{0:N0} 件" -f [int]$_.TotalAhead } },
                    @{Name = "通算待機";       Expression = {
                        $prop = $_.PSObject.Properties["TotalLifetimeDays"]
                        if ($null -ne $prop -and $prop.Value) { "$($prop.Value)日" } else { "-" }
                    } },
                    @{Name = "レビュー待ち";   Expression = {
                        $prop = $_.PSObject.Properties["TurnLatencyDays"]
                        if ($null -ne $prop -and $prop.Value) {
                            "$($prop.Value)日"
                        } elseif ($_.WaitDays) {
                            "$($_.WaitDays)日 (旧)"
                        } else {
                            "-"
                        }
                    } },
                    @{Name = "コミット数";     Expression = {
                        $prop = $_.PSObject.Properties["CommitCount"]
                        if ($null -ne $prop -and $prop.Value) { $prop.Value } else { "-" }
                    } } |
                Format-Table -AutoSize |
                Out-Host
        }
    }
}
catch {
    Write-Progress -Activity "比較PRのラベル履歴を確認中" -Completed
    Write-Error "集計を中止しました: $($_.Exception.Message)"
}
