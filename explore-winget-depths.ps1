# explore-winget-depths.ps1
# PowerShell 7 / GitHub CLI (gh)

[CmdletBinding()]
param(
    [int]$TargetPr = $(if ($env:WINGET_TARGET_PR) { [int]$env:WINGET_TARGET_PR } else { 464302 }),
    [string]$Repository = $(if ($env:WINGET_REPOSITORY) { $env:WINGET_REPOSITORY } else { "microsoft/winget-pkgs" }),
    [string]$OutputPath = "",
    [switch]$NoTargetPr,
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
    [pscustomobject]@{
        PR        = "#$($Item.number)"
        Number    = $Item.number
        作成日時  = [DateTimeOffset]::Parse($Item.created_at).ToLocalTime().ToString("yyyy-MM-dd HH:mm")
        更新日時  = [DateTimeOffset]::Parse($Item.updated_at).ToLocalTime().ToString("yyyy-MM-dd HH:mm")
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
            Number    = $TargetPr
            Title     = $targetJson.title
            Url       = $targetJson.url
            CreatedAt = $targetJson.createdAt
            CreatedAtJst = $targetCreated.ToLocalTime().ToString("yyyy-MM-dd HH:mm")
        }

        if (-not $AsJson) {
            Write-Host "=== winget-pkgs キュー境界探索 ==="
            Write-Host "基準PR : #$TargetPr ($($targetJson.title))"
            Write-Host "作成日 : $($targetCreated.ToLocalTime().ToString('yyyy-MM-dd HH:mm'))"
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

$resultData = [pscustomobject]@{
    Timestamp      = [DateTimeOffset]::UtcNow.ToString("o")
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

if ($OutputPath) {
    $parentDir = Split-Path -Parent $OutputPath
    if ($parentDir -and (-not (Test-Path $parentDir))) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    $resultData | ConvertTo-Json -Depth 5 | Set-Content -Path $OutputPath -Encoding utf8
}
