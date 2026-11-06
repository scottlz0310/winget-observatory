[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Files
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $Files -or $Files.Count -eq 0) {
    $Files = Get-ChildItem -Path . -Filter "*.ps1" -Recurse | Select-Object -ExpandProperty FullName
}

$hasError = $false
$checkedCount = 0

foreach ($file in $Files) {
    if (-not (Test-Path $file)) { continue }
    $checkedCount++
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) {
        $hasError = $true
        Write-Error "Syntax error in $file :"
        $parseErrors | ForEach-Object { Write-Error $_ }
    }
}

if ($hasError) {
    exit 1
}
Write-Host "PowerShell syntax check passed ($checkedCount files)."
