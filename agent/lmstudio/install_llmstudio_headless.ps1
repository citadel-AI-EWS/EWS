[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$OfficialInstaller = "https://lmstudio.ai/install.ps1"
$TempFile = Join-Path $env:TEMP ("citadel-lmstudio-" + [guid]::NewGuid().ToString("N") + ".ps1")

try {
  Write-Host "[CITADEL] Downloading official LM Studio llmster installer..."
  Invoke-WebRequest -Uri $OfficialInstaller -OutFile $TempFile -UseBasicParsing
  if (-not (Test-Path -LiteralPath $TempFile)) { throw "LM Studio installer download failed." }
  $Length = (Get-Item -LiteralPath $TempFile).Length
  if ($Length -lt 200 -or $Length -gt 2097152) { throw "Unexpected LM Studio installer size." }

  Write-Host "[CITADEL] Running official llmster installer..."
  & $TempFile
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
    throw "LM Studio installer exited with code $LASTEXITCODE."
  }

  $Candidates = @(
    (Join-Path $HOME ".lmstudio\bin\lms.exe"),
    (Join-Path $HOME ".lmstudio\bin\lms")
  )
  $Lms = $null
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) { $Lms = $Candidate; break }
  }
  if ($null -eq $Lms) {
    $Command = Get-Command lms -ErrorAction SilentlyContinue
    if ($null -ne $Command) { $Lms = $Command.Source }
  }
  if ($null -eq $Lms) { throw "lms CLI was not found after installation." }
  Write-Host "[CITADEL] LM Studio / llmster is installed; CITADEL agent will start daemon/server."
} finally {
  Remove-Item -LiteralPath $TempFile -Force -ErrorAction SilentlyContinue
}
