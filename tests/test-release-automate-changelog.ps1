[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$changelogPath = Join-Path $repoRoot "CHANGELOG.md"

Write-Host "=== Test: release-automate CHANGELOG.md contract validation ==="

if (-not (Test-Path $changelogPath)) {
    throw "CHANGELOG.md が見つかりません: $changelogPath"
}

$rawText = [System.IO.File]::ReadAllText($changelogPath, [System.Text.Encoding]::UTF8)

# 1. '## [Unreleased]' 見出しがちょうど 1 件存在すること
$unreleasedHeaderMatches = [regex]::Matches($rawText, '(?m)^## \[Unreleased\]\s*$')
if ($unreleasedHeaderMatches.Count -ne 1) {
    throw "テスト失敗: '## [Unreleased]' 見出しはちょうど 1 件必要ですが、$($unreleasedHeaderMatches.Count) 件見つかりました。"
}
Write-Host "OK: '## [Unreleased]' 見出しが 1 件存在します。"

# 2. '^[Unreleased]:[^\n]*$' の比較リンク定義がちょうど 1 件存在すること (reusable-prepare-release.yml の契約)
$unreleasedLinkMatches = [regex]::Matches($rawText, '(?m)^\[Unreleased\]:[^\r\n]*$')
if ($unreleasedLinkMatches.Count -ne 1) {
    throw "テスト失敗: '^[Unreleased]:...' 比較リンク定義はちょうど 1 件必要ですが、$($unreleasedLinkMatches.Count) 件見つかりました。"
}
Write-Host "OK: '^[Unreleased]:...' 比較リンク定義が 1 件存在します ($($unreleasedLinkMatches[0].Value))。"

# 3. release-automate の版確定処理シミュレーション (バージョン 0.1.0)
$testVersion = "0.1.0"
$repoUrl = "https://github.com/scottlz0310/winget-observatory"
$tag = "v$testVersion"
$today = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(9)).ToString("yyyy-MM-dd")

# 既存の対象版が存在しないことの検証
$hasVersionAlready = [regex]::IsMatch($rawText, '(?m)^## \[' + [regex]::Escape($testVersion) + '\]')
if ($hasVersionAlready) {
    throw "テスト失敗: 対象版 $testVersion が既に CHANGELOG.md 内に存在します。"
}

# 見出し置換
$simulatedText = [regex]::Replace(
    $rawText,
    '(?m)^## \[Unreleased\][ \t]*$',
    "## [Unreleased]`n`n## [$testVersion] - $today"
)

# 比較リンク置換
$comparison = "$repoUrl/releases/tag/$tag"
$newLinks = "[Unreleased]: $repoUrl/compare/$tag...HEAD`n[$testVersion]: $comparison"

$replacedCount = 0
$simulatedText = [regex]::Replace(
    $simulatedText,
    '(?m)^\[Unreleased\]:[^\r\n]*$',
    {
        $script:replacedCount++
        return $newLinks
    }
)

if ($script:replacedCount -ne 1) {
    throw "テスト失敗: 比較リンクの置換件数が 1 件ではありません ($script:replacedCount 件)。"
}

# 置換後の検証
if (-not ($simulatedText -match [regex]::Escape("## [$testVersion] - $today"))) {
    throw "テスト失敗: 置換後の見出しが確認できません。"
}
if (-not ($simulatedText -match [regex]::Escape("[$testVersion]: $comparison"))) {
    throw "テスト失敗: 置換後のリリースリンクが確認できません。"
}

Write-Host "OK: release-automate による版確定・リンク置換シミュレーションに成功しました。"
