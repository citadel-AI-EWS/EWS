[CmdletBinding()]
param(
  [string]$ControllerUrl = "https://citadel-ai.init1.workers.dev",
  [string]$InstallRoot = "$env:LOCALAPPDATA\CitadelEWS\agent"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not $ControllerUrl.StartsWith("https://")) {
  throw "ControllerUrl must use HTTPS."
}
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = Get-Command python -ErrorAction SilentlyContinue
if ($null -eq $Python) { $Python = Get-Command py -ErrorAction SilentlyContinue }
if ($null -eq $Python) {
  throw "Python 3.11+ is required. Install Python from python.org or Windows Package Manager and run setup again."
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Copy-Item (Join-Path $SourceRoot "citadel_node_v1.py") (Join-Path $InstallRoot "citadel_node_v1.py") -Force
Copy-Item (Join-Path $SourceRoot "citadel_node_v2.py") (Join-Path $InstallRoot "citadel_node_v2.py") -Force
Copy-Item (Join-Path $SourceRoot "requirements.txt") (Join-Path $InstallRoot "requirements.txt") -Force

$Venv = Join-Path $InstallRoot ".venv"
& $Python.Source -m venv $Venv
if ($LASTEXITCODE -ne 0) { throw "Unable to create Python virtual environment." }
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$VenvPythonw = Join-Path $Venv "Scripts\pythonw.exe"
& $VenvPython -m pip install --disable-pip-version-check --requirement (Join-Path $InstallRoot "requirements.txt")
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
