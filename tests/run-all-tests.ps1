[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

$testScripts = @(
    "test-timezone-jst.ps1",
    "test-error-exit.ps1",
    "test-release-automate-changelog.ps1"
)

foreach ($t in $testScripts) {
    $fullPath = Join-Path $scriptDir $t
    Write-Host "`n>>> Running $t ..." -ForegroundColor Cyan
    & pwsh -NoProfile -File $fullPath
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Test $t failed with exit code $LASTEXITCODE"
        exit 1
    }
}

Write-Host "`nAll tests passed successfully!" -ForegroundColor Green
