[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "=== Test: JST explicit offset conversion (timezone invariance) ==="

$jstOffset = [TimeSpan]::FromHours(9)

# 1. UTC 時刻が常に JST (+09:00) へ正しく変換されることの検証
$utcSample = [DateTimeOffset]::Parse("2026-11-06T14:30:00Z")
$jstConverted = $utcSample.ToOffset($jstOffset)

$expectedJstStr = "2026-11-06 23:30"
$actualJstStr = $jstConverted.ToString("yyyy-MM-dd HH:mm")

if ($actualJstStr -ne $expectedJstStr) {
    throw "テスト失敗: UTC $utcSample から JST への変換結果が期待値と異なります。期待: $expectedJstStr, 実際: $actualJstStr"
}
Write-Host "OK: UTC $utcSample -> JST $actualJstStr (ホスト設定非依存)"

# 2. 曜日表記の検証
$dayOfWeekJa = @("日", "月", "火", "水", "木", "金", "土")[[int]$jstConverted.DayOfWeek]
$expectedDay = "金"
if ($dayOfWeekJa -ne $expectedDay) {
    throw "テスト失敗: JST 曜日が期待値と異なります。期待: $expectedDay, 実際: $dayOfWeekJa"
}
Write-Host "OK: JST 曜日計算 $dayOfWeekJa"

# 3. 日付またぎの検証（UTC 2026-11-06 20:00 -> JST 2026-11-07 05:00）
$utcAcrossMidnight = [DateTimeOffset]::Parse("2026-11-06T20:00:00Z")
$jstAcrossMidnight = $utcAcrossMidnight.ToOffset($jstOffset)
$expectedAcross = "2026-11-07 05:00"
$actualAcross = $jstAcrossMidnight.ToString("yyyy-MM-dd HH:mm")
if ($actualAcross -ne $expectedAcross) {
    throw "テスト失敗: 日付またぎの JST 変換が不正です。期待: $expectedAcross, 実際: $actualAcross"
}
Write-Host "OK: 日付またぎ UTC $utcAcrossMidnight -> JST $actualAcross"
