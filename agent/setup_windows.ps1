[CmdletBinding()]
param(
  [string]$ControllerUrl = "https://citadel-ai.init1.workers.dev",
  [string]$InstallRoot = "$env:LOCALAPPDATA\CitadelEWS\agent"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PythonWingetId = "Python.Python.3.14"
$ExpectedV1Sha256 = "712a1f9d9d15152bdcfd2bb9227e36813d6e90ec408f6dd94f6730eef61522a1"
$ExpectedV2Sha256 = "07b063110936068d6f48cf6aa8a0b39ca9e2fe43b0a2e5862e7a83dbabf34709"

$ControllerUri = [System.Uri]$ControllerUrl
$IsHttps = $ControllerUri.Scheme -eq "https"
$IsLoopbackTest = $ControllerUri.Scheme -eq "http" -and @("127.0.0.1", "localhost", "::1") -contains $ControllerUri.DnsSafeHost
if (-not ($IsHttps -or $IsLoopbackTest)) {
  throw "ControllerUrl must use HTTPS; loopback HTTP is test-only."
}

$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA "CitadelEWS\state"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-VerifiedAgentFile([string]$Name, [string]$ExpectedHash) {
  $Source = Join-Path $SourceRoot $Name
  $Destination = Join-Path $InstallRoot $Name
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required package file is missing: $Name"
  }
  $SourceHash = Get-Sha256 $Source
  if ($SourceHash -ne $ExpectedHash) {
    throw "Package integrity check failed for $Name. Refusing to install an unknown agent file."
  }
  if (Test-Path -LiteralPath $Destination) {
    $InstalledHash = Get-Sha256 $Destination
    if ($InstalledHash -eq $ExpectedHash) {
      Write-Host "[CITADEL] $Name already matches the current release; keeping it."
      return $false
    }
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  if ((Get-Sha256 $Destination) -ne $ExpectedHash) {
    throw "Installed file verification failed: $Name"
  }
  Write-Host "[CITADEL] Installed verified $Name."
  return $true
}

function Find-Python314 {
  $Launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($null -ne $Launcher) {
    $Resolved = & $Launcher.Source -3.14 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($Resolved)) {
      return $Resolved.Trim()
    }
  }
  $Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python314\python.exe"),
    (Join-Path $env:ProgramFiles "Python314\python.exe")
  )
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) { return $Candidate }
  }
  return $null
}

function Get-RunningCitadelAgents([string]$AgentScriptPath, [string]$ConfigPathValue) {
  $AgentNeedle = [System.IO.Path]::GetFileName($AgentScriptPath)
  $ConfigNeedle = [System.IO.Path]::GetFileName($ConfigPathValue)
  try {
    return @(
      Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object {
          $_.CommandLine -and
          $_.CommandLine.Contains($AgentNeedle) -and
          $_.CommandLine.Contains($ConfigNeedle)
        }
    )
  } catch {
    throw "[CITADEL] Could not inspect running CITADEL processes safely; refusing to start another copy."
  }
}

$PythonPath = Find-Python314
if ($null -eq $PythonPath) {
  $Winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($null -eq $Winget) {
    throw "Python 3.14 is not installed and Windows Package Manager (winget) is unavailable."
  }
  Write-Host "[CITADEL] Installing Python 3.14 once..."
  & $Winget.Source install --exact --id $PythonWingetId --source winget --scope user --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Automatic Python installation failed." }
  $PythonPath = Find-Python314
}
if ($null -eq $PythonPath) {
  throw "Python 3.14 is unavailable after installation."
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

$V1Changed = Copy-VerifiedAgentFile "citadel_node_v1.py" $ExpectedV1Sha256
$V2Changed = Copy-VerifiedAgentFile "citadel_node_v2.py" $ExpectedV2Sha256

$RequirementsSource = Join-Path $SourceRoot "requirements.txt"
$RequirementsPath = Join-Path $InstallRoot "requirements.txt"
if (-not (Test-Path -LiteralPath $RequirementsSource)) {
  throw "Required package file is missing: requirements.txt"
}
$RequirementsHash = Get-Sha256 $RequirementsSource
$RequirementsChanged = $true
if (Test-Path -LiteralPath $RequirementsPath) {
  $RequirementsChanged = (Get-Sha256 $RequirementsPath) -ne $RequirementsHash
}
if ($RequirementsChanged) {
  Copy-Item -LiteralPath $RequirementsSource -Destination $RequirementsPath -Force
} else {
  Write-Host "[CITADEL] requirements.txt is unchanged; keeping the installed copy."
}

$Venv = Join-Path $InstallRoot ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$VenvPythonw = Join-Path $Venv "Scripts\pythonw.exe"
$CreateVenv = -not (Test-Path -LiteralPath $VenvPython)
if (-not $CreateVenv) {
  & $VenvPython -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" *> $null
  if ($LASTEXITCODE -ne 0) { $CreateVenv = $true }
}
if ($CreateVenv) {
  if (Test-Path -LiteralPath $Venv) { Remove-Item -LiteralPath $Venv -Recurse -Force }
  Write-Host "[CITADEL] Creating the local Python environment..."
  & $PythonPath -m venv $Venv
  if ($LASTEXITCODE -ne 0) { throw "Unable to create Python virtual environment." }
} else {
  Write-Host "[CITADEL] Existing Python environment found; reusing it."
}

$RequirementsMarker = Join-Path $InstallRoot ".requirements.sha256"
$MarkerMatches = $false
if (Test-Path -LiteralPath $RequirementsMarker) {
  $MarkerMatches = ((Get-Content -LiteralPath $RequirementsMarker -Raw).Trim().ToLowerInvariant() -eq $RequirementsHash)
}
& $VenvPython -c "import cryptography, psutil" *> $null
$DependenciesWork = $LASTEXITCODE -eq 0
if (-not ($MarkerMatches -and $DependenciesWork)) {
  Write-Host "[CITADEL] Installing/updating agent dependencies..."
  & $VenvPython -m pip install --disable-pip-version-check --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw "pip update failed." }
  & $VenvPython -m pip install --disable-pip-version-check --upgrade --requirement $RequirementsPath
  if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
  [System.IO.File]::WriteAllText($RequirementsMarker, $RequirementsHash + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
} else {
  Write-Host "[CITADEL] Dependencies are already ready; skipping download."
}

$ConfigPath = Join-Path $InstallRoot "config.json"
$ConfigJson = @{
  controller_url = $ControllerUrl.TrimEnd('/')
  data_dir = $StateRoot
  poll_seconds = 30
  heartbeat_seconds = 30
  request_timeout_seconds = 30
  max_cpu_percent = 90
  max_memory_percent = 90
  controller_public_x = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
} | ConvertTo-Json
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ConfigText = $ConfigJson + [Environment]::NewLine
$ExistingConfigText = if (Test-Path -LiteralPath $ConfigPath) { [System.IO.File]::ReadAllText($ConfigPath) } else { "" }
$ConfigChanged = $ExistingConfigText -ne $ConfigText
if ($ConfigChanged) {
  [System.IO.File]::WriteAllText($ConfigPath, $ConfigText, $Utf8NoBom)
  Write-Host "[CITADEL] Configuration written as UTF-8 without BOM."
} else {
  Write-Host "[CITADEL] Configuration is unchanged."
}

$AgentScript = Join-Path $InstallRoot "citadel_node_v2.py"
$StopPath = Join-Path $StateRoot "STOP"
if (Test-Path -LiteralPath $StopPath) {
  Remove-Item -LiteralPath $StopPath -Force
  Write-Host "[CITADEL] Previous local STOP marker cleared by explicit reinstall."
}

& $VenvPython $AgentScript doctor --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Agent diagnostics failed." }
& $VenvPython $AgentScript self-test
if ($LASTEXITCODE -ne 0) { throw "Agent self-test failed." }

$EnrollOutput = & $VenvPython $AgentScript enroll --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Automatic enrollment failed." }
$NodeId = (($EnrollOutput | Select-Object -Last 1) -as [string]).Trim()
if (-not $NodeId.StartsWith("node_")) {
  throw "Controller did not return a valid node id."
}
Write-Host "[CITADEL] Controller enrollment confirmed: $NodeId"

& $VenvPython $AgentScript once --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Live Controller cycle failed after enrollment." }
Write-Host "[CITADEL] Live heartbeat/controller cycle confirmed."

$StartupDir = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupDir "CITADEL EWS Agent.lnk"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $VenvPythonw
$Shortcut.Arguments = ('"' + $AgentScript + '" run --config "' + $ConfigPath + '"')
$Shortcut.WorkingDirectory = $InstallRoot
$Shortcut.WindowStyle = 7
$Shortcut.Description = "CITADEL EWS background agent"
$Shortcut.Save()

$RunningAgents = Get-RunningCitadelAgents $AgentScript $ConfigPath
$RestartRequired = $V1Changed -or $V2Changed -or $ConfigChanged
if ($RunningAgents.Count -gt 0 -and $RestartRequired) {
  Write-Host "[CITADEL] Agent files/configuration changed; restarting the existing CITADEL process."
  foreach ($Process in $RunningAgents) {
    Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  $RunningAgents = @()
}

if ($RunningAgents.Count -eq 0) {
  $RunArguments = '"' + $AgentScript + '" run --config "' + $ConfigPath + '"'
  Start-Process -FilePath $VenvPythonw -ArgumentList $RunArguments -WorkingDirectory $InstallRoot -WindowStyle Hidden
  Start-Sleep -Seconds 1
  Write-Host "[CITADEL] Started one background agent process."
} else {
  Write-Host "[CITADEL] Agent is already running; a second copy was not started."
}

$InstallState = @{
  node_id = $NodeId
  controller_url = $ControllerUrl.TrimEnd('/')
  install_root = $InstallRoot
  agent_version = "0.3.9"
  v1_sha256 = $ExpectedV1Sha256
  v2_sha256 = $ExpectedV2Sha256
  updated_at = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $InstallRoot "install-state.json"), $InstallState + [Environment]::NewLine, $Utf8NoBom)

Write-Host ""
Write-Host "[CITADEL] Setup/repair complete."
Write-Host "[CITADEL] Node: $NodeId"
Write-Host "[CITADEL] Controller: $($ControllerUrl.TrimEnd('/'))"
Write-Host "[CITADEL] Re-running this installer reuses the same identity, environment and installation."
Write-Host "[CITADEL] The agent polls signed Hub commands, including verified remote updates, automatically."
