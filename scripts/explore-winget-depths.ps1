# explore-winget-depths.ps1
# PowerShell 7 / GitHub CLI (gh)

[CmdletBinding()]
param(
    [int]$TargetPr = $(if ($env:WINGET_TARGET_PR) { [int]$env:WINGET_TARGET_PR } else { 464302 }),
    [string]$Repository = $(if ($env:WINGET_REPOSITORY) { $env:WINGET_REPOSITORY } else { "microsoft/winget-pkgs" }),
    [string]$OutputPath = "",
    [string]$HistoryPath = "",
    [switch]$NoTargetPr,
    [switch]$NoHistory,
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:JstOffset = [TimeSpan]::FromHours(9)

function Format-JstDateTime {
    param(
        [Parameter(Mandatory)][DateTimeOffset]$Dto,
        [string]$Format = "yyyy-MM-dd HH:mm"
    )
    return $Dto.ToOffset($script:JstOffset).ToString($Format)
}

function Invoke-GhSearch {
    param(
        [Parameter(Mandatory)][string]$Query,
        [string]$Sort = "created",
        [string]$Order = "asc",
        [int]$PerPage = 3
    )

    $encoded = [System.Uri]::EscapeDataString($Query)
    $json = & gh api "search/issues?q=$encoded&sort=$Sort&order=$Order&per_page=$PerPage" | ConvertFrom-Json
    return $json.items
}

function Format-Row {
    param($Item)
    $createdDto = [DateTimeOffset]::Parse($Item.created_at)
    $updatedDto = [DateTimeOffset]::Parse($Item.updated_at)
    [pscustomobject]@{
        PR        = "#$($Item.number)"
        Number    = $Item.number
        作成日時  = Format-JstDateTime $createdDto
        更新日時  = Format-JstDateTime $updatedDto
        CreatedAt = $Item.created_at
        UpdatedAt = $Item.updated_at
        タイトル  = if ($Item.title.Length -gt 45) { $Item.title.Substring(0, 42) + "..." } else { $Item.title }
        Title     = $Item.title
        Url       = $Item.html_url
    }
}

$hasTarget = ($TargetPr -gt 0) -and (-not $NoTargetPr)
$targetInfo = $null
$targetCreatedIso = $null

if ($hasTarget) {
    try {
        $targetJson = & gh pr view $TargetPr --repo $Repository --json createdAt,title,url | ConvertFrom-Json
        $targetCreated = [DateTimeOffset]::Parse($targetJson.createdAt)
        $targetCreatedIso = $targetCreated.ToString("yyyy-MM-ddTHH:mm:ssZ")
        $targetInfo = [pscustomobject]@{
            Number       = $TargetPr
            Title        = $targetJson.title
            Url          = $targetJson.url
            CreatedAt    = $targetJson.createdAt
            CreatedAtJst = Format-JstDateTime $targetCreated
        }

        if (-not $AsJson) {
            Write-Host "=== winget-pkgs キュー境界探索 ==="
            Write-Host "基準PR : #$TargetPr ($($targetJson.title))"
            Write-Host "作成日 : $(Format-JstDateTime $targetCreated)"
            Write-Host ""
        }
    }
    catch {
        Write-Warning "基準PR #$TargetPr の取得に失敗しました。キュー境界探索のみ続行します: $($_.Exception.Message)"
        $hasTarget = $false
    }
}
else {
    if (-not $AsJson) {
        Write-Host "=== winget-pkgs キュー境界探索 (全体観測モード) ==="
        Write-Host "対象リポジトリ: $Repository"
        Write-Host ""
    }
}

# 共通フィルタ
$healthyBase = @(
    "repo:$Repository",
    "is:pr",
    "is:open",
    "draft:false",
    "label:New-Package",
    "label:Azure-Pipeline-Passed",
    "label:Validation-Completed",
    "-label:Needs-CLA",
    "-label:Needs-Author-Feedback",
    "-label:Changes-Requested",
    "-label:Blocking-Issue",
    "-label:Blocked-InstallerType",
    "-label:Author-Not-Authorized",
    "-label:Author-Not-Verified",
    "-label:Validation-Merge-Conflict",
    "-label:Validation-SmartScreen",
    "-label:Package-Flagged",
    "-label:PUA-Detection"
) -join " "

# 1. 健康的な大底（Healthy Bottom）
$healthyBottom = @(Invoke-GhSearch -Query $healthyBase -Sort "created" -Order "asc" -PerPage 3)

# 2. 真の大底（Absolute Bottom）
$absoluteBase = "repo:$Repository is:pr is:open draft:false label:New-Package"
$absoluteBottom = @(Invoke-GhSearch -Query $absoluteBase -Sort "created" -Order "asc" -PerPage 3)

# 3. 遭難・放置の底（Stale Bottom）
$staleBottom = @(Invoke-GhSearch -Query $healthyBase -Sort "updated" -Order "asc" -PerPage 3)

# 4. 特急レーン / 追い越し（Express Lane）
$expressPrs = @()
if ($hasTarget -and $targetCreatedIso) {
    $expressQuery = "repo:$Repository is:pr is:merged label:New-Package created:>$targetCreatedIso"
    $expressPrs = @(Invoke-GhSearch -Query $expressQuery -Sort "updated" -Order "desc" -PerPage 5)
}

if (-not $AsJson) {
    Write-Host "【1. 健康的な大底 (Healthy Bottom)】"
    Write-Host "説明: CI通過・エラーなしの健康体で、現在最も古いオープンPR (FIFOの正当な先頭)"
    $healthyBottom | ForEach-Object { Format-Row $_ } | Select-Object PR, 作成日時, 更新日時, タイトル | Format-Table -AutoSize | Out-Host

    Write-Host "【2. 真の大底 (Absolute Bottom)】"
    Write-Host "説明: 状態やエラーを問わず、未クローズの New-Package で最も古いPR"
    $absoluteBottom | ForEach-Object { Format-Row $_ } | Select-Object PR, 作成日時, 更新日時, タイトル | Format-Table -AutoSize | Out-Host

    Write-Host "【3. 遭難・放置の底 (Stale Bottom)】"
    Write-Host "説明: 健康体の中で更新日時(updated)が最も古く、完全に止まっているPR"
    $staleBottom | ForEach-Object { Format-Row $_ } | Select-Object PR, 作成日時, 更新日時, タイトル | Format-Table -AutoSize | Out-Host

    if ($hasTarget) {
        Write-Host "【4. 特急レーン・追い越し (Express Lane)】"
        Write-Host "説明: あなたのPR作成日($($targetInfo.CreatedAtJst))以降に作成され、すでにマージされたPR"
        if ($expressPrs.Count -gt 0) {
            $expressPrs | ForEach-Object { Format-Row $_ } | Select-Object PR, 作成日時, 更新日時, タイトル | Format-Table -AutoSize | Out-Host
        } else {
            Write-Host "該当なし（追い越しマージはありません）`n"
        }
    }
}

$nowUtc = [DateTimeOffset]::UtcNow
$resultData = [pscustomobject]@{
    Timestamp      = $nowUtc.ToString("o")
    TimestampJst   = Format-JstDateTime $nowUtc "yyyy-MM-dd HH:mm:ss"
    Repository     = $Repository
    TargetPr       = if ($hasTarget) { $targetInfo } else { $null }
    HealthyBottom  = @($healthyBottom | ForEach-Object { Format-Row $_ })
    AbsoluteBottom = @($absoluteBottom | ForEach-Object { Format-Row $_ })
    StaleBottom    = @($staleBottom | ForEach-Object { Format-Row $_ })
    ExpressLane    = @($expressPrs | ForEach-Object { Format-Row $_ })
}

if ($AsJson) {
    $resultData | ConvertTo-Json -Depth 5
}

# ディレクトリ解決
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$baseDataDir = if (Test-Path (Join-Path $scriptDir "..\data")) {
    (Resolve-Path (Join-Path $scriptDir "..\data")).Path
} elseif (Test-Path (Join-Path (Get-Location).Path "data")) {
    (Resolve-Path (Join-Path (Get-Location).Path "data")).Path
} else {
    Join-Path $scriptDir "..\data"
}

# 1. JSONL 履歴ファイルへの追記（蓄積）
if (-not $NoHistory) {
    $resolvedHistoryPath = if (-not [string]::IsNullOrWhiteSpace($HistoryPath)) {
        $HistoryPath
    } elseif ($env:WINGET_DEPTHS_HISTORY_PATH) {
        $env:WINGET_DEPTHS_HISTORY_PATH
    } else {
        Join-Path $baseDataDir "depths-history.jsonl"
    }

    try {
        $historyDir = Split-Path -Parent $resolvedHistoryPath
        if ($historyDir -and (-not (Test-Path $historyDir))) {
            New-Item -ItemType Directory -Path $historyDir -Force | Out-Null
        }
        $jsonLine = $resultData | ConvertTo-Json -Depth 5 -Compress
        [System.IO.File]::AppendAllLines($resolvedHistoryPath, [string[]]@($jsonLine), [System.Text.Encoding]::UTF8)
    }
    catch {
        throw "キュー境界履歴 (JSONL) の保存に失敗しました ($resolvedHistoryPath): $($_.Exception.Message)"
    }
}

# 2. 最新スナップショット JSON の上書き保存
$resolvedOutputPath = if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath
} elseif ($env:WINGET_DEPTHS_OUTPUT_PATH) {
    $env:WINGET_DEPTHS_OUTPUT_PATH
} else {
    Join-Path $baseDataDir "latest-depths.json"
}

if ($resolvedOutputPath) {
    try {
        $parentDir = Split-Path -Parent $resolvedOutputPath
        if ($parentDir -and (-not (Test-Path $parentDir))) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }
        $resultData | ConvertTo-Json -Depth 5 | Set-Content -Path $resolvedOutputPath -Encoding utf8
    }
    catch {
        throw "最新スナップショット (JSON) の保存に失敗しました ($resolvedOutputPath): $($_.Exception.Message)"
    }
}
