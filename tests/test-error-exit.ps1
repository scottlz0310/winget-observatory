[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$exploreScript = Join-Path $repoRoot "scripts\explore-winget-depths.ps1"

Write-Host "=== Test: explore-winget-depths.ps1 error exit on invalid output path ==="

# 1. 既存ディレクトリを OutputPath に指定した場合、書き込み失敗で終了コード非ゼロになることを検証
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("winget-test-dir-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    # 既存ディレクトリへのファイル書き込み試行
    $process = Start-Process -FilePath "pwsh" `
        -ArgumentList @("-NoProfile", "-File", $exploreScript, "-NoHistory", "-OutputPath", $tempDir) `
        -NoNewWindow -Wait -PassThru

    if ($process.ExitCode -eq 0) {
        throw "テスト失敗: ディレクトリパスへの保存失敗時にもかかわらず、終了コードが 0 でした。"
    }
    Write-Host "OK: 保存失敗時に非ゼロ終了コード ($($process.ExitCode)) が返されました。"
}
finally {
    if (Test-Path $tempDir) {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
