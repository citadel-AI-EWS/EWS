[CmdletBinding()]
param(
  [string]$ControllerUrl = "https://citadel-ai.init1.workers.dev",
  [string]$InstallRoot = "$env:LOCALAPPDATA\CitadelEWS\agent"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$InstallerRelease = "0.3.11-wincompat.1"
$PythonWingetId = "Python.Python.3.13"
$FallbackPythonVersion = "3.13.15"
$FallbackPythonX86Url = "https://www.python.org/ftp/python/3.13.15/python-3.13.15.exe"
$FallbackPythonX86Sha256 = "741c07276eb2d57e7ee012d643f021c58cb38d11c5389be46c15d41d1a10b447"
$FallbackPythonX64Url = "https://www.python.org/ftp/python/3.13.15/python-3.13.15-amd64.exe"
$FallbackPythonX64Sha256 = "edec09c4853aeae9ac36efb8c9f95b6b8e2fee65eee56d9767a8b7c69c574403"
$FallbackPythonArm64Url = "https://www.python.org/ftp/python/3.13.15/python-3.13.15-arm64.exe"
$FallbackPythonArm64Sha256 = "c252c676087c49e6b94e95a273536b78921c28a5fc9f86d15d25392328247249"
$ExpectedV1Sha256 = "d3c310ab378666cdd477a51a881169970910900428cb4d2027ff58c1545c48df"
$ExpectedV2Sha256 = "ab81b7cb431dc1e3e9ee7bf19cbdc875db52f33045da809430435276c5a958f5"

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

function Resolve-CompatiblePython([string]$Candidate) {
  if ([string]::IsNullOrWhiteSpace($Candidate) -or -not (Test-Path -LiteralPath $Candidate)) {
    return $null
  }
  & $Candidate -c "import sys; raise SystemExit(0 if (3, 12) <= sys.version_info[:2] < (4, 0) else 1)" *> $null
  if ($LASTEXITCODE -ne 0) { return $null }
  $Resolved = & $Candidate -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($Resolved)) {
    return $Resolved.Trim()
  }
  return $null
}

function Find-CompatiblePython {
  $Launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($null -ne $Launcher) {
    foreach ($Spec in @("-3.14", "-3.13", "-3.12")) {
      $Resolved = & $Launcher.Source $Spec -c "import sys; print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($Resolved)) {
        $Compatible = Resolve-CompatiblePython $Resolved.Trim()
        if ($null -ne $Compatible) { return $Compatible }
      }
    }
  }

  $PythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if ($null -ne $PythonCommand) {
    $Compatible = Resolve-CompatiblePython $PythonCommand.Source
    if ($null -ne $Compatible) { return $Compatible }
  }

  $Candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python314\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python313-32\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312-32\python.exe")
  )
  if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
    $Candidates += (Join-Path $env:ProgramFiles "Python314\python.exe")
    $Candidates += (Join-Path $env:ProgramFiles "Python313\python.exe")
    $Candidates += (Join-Path $env:ProgramFiles "Python312\python.exe")
  }
  $ProgramFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  if (-not [string]::IsNullOrWhiteSpace($ProgramFilesX86)) {
    $Candidates += (Join-Path $ProgramFilesX86 "Python313-32\python.exe")
    $Candidates += (Join-Path $ProgramFilesX86 "Python312-32\python.exe")
  }
  foreach ($Candidate in $Candidates) {
    $Compatible = Resolve-CompatiblePython $Candidate
    if ($null -ne $Compatible) { return $Compatible }
  }
  return $null
}

function Get-WindowsArchitecture {
  $ArchText = (($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE) -join " ").ToUpperInvariant()
  if ($ArchText.Contains("ARM64")) { return "arm64" }
  if ([Environment]::Is64BitOperatingSystem) { return "x64" }
  return "x86"
}

function Install-PythonFallback([string]$Architecture) {
  switch ($Architecture) {
    "x86" {
      $Url = $FallbackPythonX86Url
      $ExpectedHash = $FallbackPythonX86Sha256
    }
    "arm64" {
      $Url = $FallbackPythonArm64Url
      $ExpectedHash = $FallbackPythonArm64Sha256
    }
    default {
      $Url = $FallbackPythonX64Url
      $ExpectedHash = $FallbackPythonX64Sha256
    }
  }

  $TempInstaller = Join-Path $env:TEMP ("citadel-python-" + $FallbackPythonVersion + "-" + $Architecture + "-" + [guid]::NewGuid().ToString("N") + ".exe")
  try {
    Write-Host "[CITADEL] winget is unavailable or could not install Python. Downloading the official Python $FallbackPythonVersion $Architecture installer..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $Client = New-Object System.Net.WebClient
    $Client.Headers["User-Agent"] = "CITADEL-EWS-Installer/$InstallerRelease"
    $Client.DownloadFile($Url, $TempInstaller)
    if ((Get-Sha256 $TempInstaller) -ne $ExpectedHash) {
      throw "Downloaded Python installer failed SHA-256 verification."
    }
    $InstallArgs = @(
      "/quiet",
      "InstallAllUsers=0",
      "PrependPath=0",
      "Include_pip=1",
      "Include_launcher=1",
      "Include_test=0"
    )
    $Process = Start-Process -FilePath $TempInstaller -ArgumentList $InstallArgs -Wait -PassThru
    if ($Process.ExitCode -ne 0) {
      throw "Official Python installer failed with exit code $($Process.ExitCode)."
    }
  } finally {
    if (Test-Path -LiteralPath $TempInstaller) {
      Remove-Item -LiteralPath $TempInstaller -Force -ErrorAction SilentlyContinue
    }
  }
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

$PythonPath = Find-CompatiblePython
if ($null -eq $PythonPath) {
  $Winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($null -ne $Winget) {
    Write-Host "[CITADEL] Trying Windows Package Manager for Python 3.13..."
    & $Winget.Source install --exact --id $PythonWingetId --source winget --scope user --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) {
      $PythonPath = Find-CompatiblePython
    } else {
      Write-Warning "[CITADEL] winget could not install Python (exit $LASTEXITCODE); using verified python.org fallback."
    }
  } else {
    Write-Host "[CITADEL] Windows Package Manager is not available; using verified python.org fallback."
  }
}
if ($null -eq $PythonPath) {
  Install-PythonFallback (Get-WindowsArchitecture)
  $PythonPath = Find-CompatiblePython
}
if ($null -eq $PythonPath) {
  throw "Compatible Python 3.12+ is unavailable after installation attempts."
}
$PythonInfo = (& $PythonPath -c "import platform,struct,sys; print(str(sys.version_info.major)+'.'+str(sys.version_info.minor)+'.'+str(sys.version_info.micro)+' / '+str(struct.calcsize('P')*8)+'-bit / '+platform.machine())").Trim()
Write-Host "[CITADEL] Using Python: $PythonInfo"

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

$CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Icacls = Get-Command icacls.exe -ErrorAction Stop
& $Icacls.Source $StateRoot /inheritance:r /grant:r "*${CurrentUserSid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Unable to harden CITADEL state directory ACL."
}
Write-Host "[CITADEL] State directory ACL restricted to the installing user, SYSTEM and Administrators."

$V1Changed = Copy-VerifiedAgentFile "citadel_node_v1.py" $ExpectedV1Sha256
$V2Changed = Copy-VerifiedAgentFile "citadel_node_v2.py" $ExpectedV2Sha256

$Requirements64Source = Join-Path $SourceRoot "requirements.txt"
$Requirements32Source = Join-Path $SourceRoot "requirements-win32.txt"
foreach ($RequiredFile in @($Requirements64Source, $Requirements32Source)) {
  if (-not (Test-Path -LiteralPath $RequiredFile)) {
    throw "Required package file is missing: $([System.IO.Path]::GetFileName($RequiredFile))"
  }
}
$Requirements64Path = Join-Path $InstallRoot "requirements.txt"
$Requirements32Path = Join-Path $InstallRoot "requirements-win32.txt"
Copy-Item -LiteralPath $Requirements64Source -Destination $Requirements64Path -Force
Copy-Item -LiteralPath $Requirements32Source -Destination $Requirements32Path -Force

$Venv = Join-Path $InstallRoot ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$VenvPythonw = Join-Path $Venv "Scripts\pythonw.exe"
$CreateVenv = -not (Test-Path -LiteralPath $VenvPython)
if (-not $CreateVenv) {
  & $VenvPython -c "import sys; raise SystemExit(0 if (3, 12) <= sys.version_info[:2] < (4, 0) else 1)" *> $null
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

$VenvBits = (& $VenvPython -c "import struct; print(struct.calcsize('P') * 8)").Trim()
if ($VenvBits -eq "32") {
  $RequirementsPath = $Requirements32Path
  Write-Host "[CITADEL] 32-bit Python detected; using the verified win32 dependency set."
} else {
  $RequirementsPath = $Requirements64Path
}
$RequirementsHash = Get-Sha256 $RequirementsPath

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
  & $VenvPython -m pip install --disable-pip-version-check --upgrade --only-binary=:all: --requirement $RequirementsPath
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
  agent_version = "0.3.11"
  installer_release = $InstallerRelease
  python = $PythonInfo
  python_bits = [int]$VenvBits
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
