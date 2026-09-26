[CmdletBinding()]
param(
  [string]$Repository = "citadel-AI-EWS/EWS",
  [string]$ReviewerRoot = "$env:LOCALAPPDATA\CitadelEWS\copilot-reviewer\EWS",
  [switch]$NoStartup
)

$ErrorActionPreference = "Stop"

function Ensure-Command {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$WingetId
  )
  if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
  $Winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $Winget) {
    throw "$Name is missing and WinGet is unavailable. Install $Name, then rerun this setup."
  }
  Write-Host "[CITADEL] Installing $Name via WinGet..."
  & $Winget.Source install --id $WingetId --exact --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Failed to install $Name." }
  $env:PATH = [Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [Environment]::GetEnvironmentVariable("PATH", "User")
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was installed but is not yet visible in PATH. Open a new PowerShell window and rerun setup."
  }
}

Ensure-Command -Name "git" -WingetId "Git.Git"
Ensure-Command -Name "gh" -WingetId "GitHub.cli"
Ensure-Command -Name "copilot" -WingetId "GitHub.Copilot"

$PythonCandidates = @(
  "$env:ProgramData\CitadelEWS\agent\runtime\python.exe",
  "$env:LOCALAPPDATA\CitadelEWS\agent\runtime\python.exe"
)
$Python = $null
foreach ($Candidate in $PythonCandidates) {
  if (Test-Path -LiteralPath $Candidate) { $Python = $Candidate; break }
}
if (-not $Python) {
  $Py = Get-Command py -ErrorAction SilentlyContinue
  if ($Py) { $Python = $Py.Source }
}
if (-not $Python) {
  $Py = Get-Command python -ErrorAction SilentlyContinue
  if ($Py) { $Python = $Py.Source }
}
if (-not $Python) {
  throw "Python was not found. Install the CITADEL Agent package or Python 3.10+ and rerun setup."
}

Write-Host "[CITADEL] Checking GitHub CLI authentication..."
& gh auth status
if ($LASTEXITCODE -ne 0) {
  Write-Host "[CITADEL] One-time GitHub authorization is required."
  & gh auth login --hostname github.com --web
  if ($LASTEXITCODE -ne 0) { throw "GitHub CLI authorization failed." }
}

$Parent = Split-Path -Parent $ReviewerRoot
New-Item -ItemType Directory -Force -Path $Parent | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $ReviewerRoot ".git"))) {
  Write-Host "[CITADEL] Creating dedicated read-only review checkout..."
  & git clone ("https://github.com/" + $Repository + ".git") $ReviewerRoot
  if ($LASTEXITCODE -ne 0) { throw "Could not clone reviewer repository." }
} else {
  & git -C $ReviewerRoot remote set-url origin ("https://github.com/" + $Repository + ".git")
  if ($LASTEXITCODE -ne 0) { throw "Could not configure reviewer repository remote." }
  & git -C $ReviewerRoot fetch --prune origin
  if ($LASTEXITCODE -ne 0) { throw "Could not update reviewer repository." }
}

$Bridge = Join-Path $ReviewerRoot "tools\copilot_review_bridge.py"
if (-not (Test-Path -LiteralPath $Bridge)) {
  throw "Bridge file is not present in the checkout. Merge/update the bridge branch first."
}

Write-Host "[CITADEL] Checking Copilot CLI..."
& copilot --version
if ($LASTEXITCODE -ne 0) { throw "Copilot CLI is not available." }

Write-Host "[CITADEL] Testing Copilot authentication. If GitHub asks you to authorize Copilot, complete that one-time sign-in."
$Probe = & copilot -p "Reply exactly CITADEL_COPILOT_READY" -s --no-ask-user --available-tools=view 2>&1
if ($LASTEXITCODE -ne 0 -or (($Probe | Out-String) -notmatch "CITADEL_COPILOT_READY")) {
  Write-Host "[CITADEL] Copilot CLI still needs authorization."
  Write-Host "[CITADEL] Run: copilot login"
  throw "Complete the one-time Copilot login, then rerun setup."
}

& $Python $Bridge --repository $Repository --repo-root $ReviewerRoot --once
if ($LASTEXITCODE -ne 0) { throw "Bridge self-check failed." }

if (-not $NoStartup) {
  $Startup = [Environment]::GetFolderPath("Startup")
  $Launcher = Join-Path $Startup "CITADEL Copilot Reviewer.cmd"
  $LogRoot = Join-Path $env:LOCALAPPDATA "CitadelEWS\copilot-reviewer"
  New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
  $Log = Join-Path $LogRoot "bridge.log"
  $Line = '@echo off' + [Environment]::NewLine +
          'cd /d "' + $ReviewerRoot + '"' + [Environment]::NewLine +
          'start "CITADEL Copilot Reviewer" /min "' + $Python + '" "' + $Bridge + '" --repository "' + $Repository + '" --repo-root "' + $ReviewerRoot + '" >> "' + $Log + '" 2>&1'
  Set-Content -LiteralPath $Launcher -Value $Line -Encoding Ascii
  Write-Host "[CITADEL] Startup launcher installed: $Launcher"
}

Write-Host "[CITADEL] Copilot reviewer bridge is ready."
Write-Host "[CITADEL] From now on, labelled review issues can be processed without copy/paste."
