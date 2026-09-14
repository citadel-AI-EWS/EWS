[CmdletBinding()]
param(
  [string]$ControllerUrl = "https://citadel-ai.init1.workers.dev",
  [string]$InstallRoot = "$env:LOCALAPPDATA\CitadelEWS\agent"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PythonWingetId = "Python.Python.3.14"

if (-not $ControllerUrl.StartsWith("https://")) {
  throw "ControllerUrl must use HTTPS."
}
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

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
    if (Test-Path $Candidate) { return $Candidate }
  }
  return $null
}

$Winget = Get-Command winget -ErrorAction SilentlyContinue
$PythonPath = Find-Python314
if ($null -eq $Winget -and $null -eq $PythonPath) {
  throw "Windows Package Manager (winget) is required to install Python automatically."
}
if ($null -ne $Winget) {
  if ($null -eq $PythonPath) {
    & $Winget.Source install --exact --id $PythonWingetId --source winget --scope user --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "Automatic Python installation failed." }
  } else {
    & $Winget.Source upgrade --exact --id $PythonWingetId --source winget --scope user --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
      Write-Host "[CITADEL] Python is already installed; continuing with the available 3.14 release."
    }
  }
  $PythonPath = Find-Python314
}
if ($null -eq $PythonPath) {
  throw "Python 3.14 installation completed but python.exe could not be located."
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Copy-Item (Join-Path $SourceRoot "citadel_node_v1.py") (Join-Path $InstallRoot "citadel_node_v1.py") -Force
Copy-Item (Join-Path $SourceRoot "citadel_node_v2.py") (Join-Path $InstallRoot "citadel_node_v2.py") -Force
Copy-Item (Join-Path $SourceRoot "requirements.txt") (Join-Path $InstallRoot "requirements.txt") -Force

$Venv = Join-Path $InstallRoot ".venv"
& $PythonPath -m venv $Venv
if ($LASTEXITCODE -ne 0) { throw "Unable to create Python virtual environment." }
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$VenvPythonw = Join-Path $Venv "Scripts\pythonw.exe"
& $VenvPython -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip update failed." }
& $VenvPython -m pip install --disable-pip-version-check --upgrade --requirement (Join-Path $InstallRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

$ConfigPath = Join-Path $InstallRoot "config.json"
@{
  controller_url = $ControllerUrl.TrimEnd('/')
  data_dir = (Join-Path $env:LOCALAPPDATA "CitadelEWS\state")
  poll_seconds = 30
  heartbeat_seconds = 30
  request_timeout_seconds = 30
  max_cpu_percent = 90
  max_memory_percent = 90
  controller_public_x = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
} | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8

& $VenvPython (Join-Path $InstallRoot "citadel_node_v2.py") doctor --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Agent diagnostics failed." }
& $VenvPython (Join-Path $InstallRoot "citadel_node_v2.py") self-test
if ($LASTEXITCODE -ne 0) { throw "Agent self-test failed." }
& $VenvPython (Join-Path $InstallRoot "citadel_node_v2.py") enroll --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Automatic enrollment failed." }

$AgentScript = Join-Path $InstallRoot "citadel_node_v2.py"
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

Start-Process -FilePath $VenvPythonw -ArgumentList @(
  $AgentScript,
  "run",
  "--config",
  $ConfigPath
) -WorkingDirectory $InstallRoot -WindowStyle Hidden

Write-Host "[CITADEL] Setup complete. This computer registered automatically."
Write-Host "[CITADEL] Agent is running without a console window."
Write-Host "[CITADEL] Automatic Windows sleep is blocked while the agent is running."
Write-Host "[CITADEL] Agent will start automatically after Windows sign-in."
