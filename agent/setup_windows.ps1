[CmdletBinding()]
param(
  [string]$ControllerUrl = "https://citadel-ai.init1.workers.dev",
  [string]$InstallRoot = "$env:ProgramData\CitadelEWS\agent",
  [string]$StateRoot = "$env:ProgramData\CitadelEWS\state",
  [switch]$Uninstall,
  [switch]$PreserveState
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ServiceName = "CitadelEWSNode"
$ServiceDisplayName = "CITADEL EWS Node"
$PythonWingetId = "Python.Python.3.14"
$ExpectedV1Sha256 = "4319f5f9b9c68fa7e2098b93f0289f457094fccc6d077a812cdb6a119f29f4f5"
$ExpectedV2Sha256 = "15083cb3c7de44a614794605aba1f95a372232479f17782661e22a73386eee7e"
$ExpectedServiceHostSha256 = "4a9a166f0c51c87a26157103ddf6c47928a2717646b5cb7408a796bda4ef016e"

function Test-IsAdministrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
  return $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  Write-Host "[CITADEL] Administrator approval is required to install the Windows Core Service."
  $ElevatedArgs = @(
    "-NoLogo", "-NoProfile", "-File", ('"' + $PSCommandPath + '"'),
    "-ControllerUrl", ('"' + $ControllerUrl + '"'),
    "-InstallRoot", ('"' + $InstallRoot + '"'),
    "-StateRoot", ('"' + $StateRoot + '"')
  )
  if ($Uninstall) { $ElevatedArgs += "-Uninstall" }
  if ($PreserveState) { $ElevatedArgs += "-PreserveState" }
  $Elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $ElevatedArgs -Wait -PassThru
  exit $Elevated.ExitCode
}

$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$LegacyStateRoot = Join-Path $env:LOCALAPPDATA "CitadelEWS\state"
$StartupDir = [Environment]::GetFolderPath("Startup")
$LegacyShortcutPath = Join-Path $StartupDir "CITADEL EWS Agent.lnk"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RunningCitadelAgents {
  try {
    return @(
      Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object {
          $_.CommandLine -and
          $_.CommandLine.Contains("citadel_node_v2.py") -and
          ($_.CommandLine.Contains(" run ") -or $_.CommandLine.EndsWith(" run"))
        }
    )
  } catch {
    throw "[CITADEL] Could not inspect running CITADEL processes safely."
  }
}

function Stop-CitadelServiceIfPresent {
  $Existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -eq $Existing) { return }
  if ($Existing.Status -ne "Stopped") {
    Write-Host "[CITADEL] Stopping existing Windows Core Service..."
    Stop-Service -Name $ServiceName -Force
    $Existing.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(45))
  }
}

function Remove-LegacyStartup {
  if (Test-Path -LiteralPath $LegacyShortcutPath) {
    Remove-Item -LiteralPath $LegacyShortcutPath -Force
    Write-Host "[CITADEL] Removed legacy Startup shortcut."
  }
  foreach ($Process in (Get-RunningCitadelAgents)) {
    Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if ($Uninstall) {
  Stop-CitadelServiceIfPresent
  $Sc = Join-Path $env:WINDIR "System32\sc.exe"
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    & $Sc delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to remove CITADEL Windows service." }
  }
  Remove-LegacyStartup
  if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  }
  if (-not $PreserveState -and (Test-Path -LiteralPath $StateRoot)) {
    Remove-Item -LiteralPath $StateRoot -Recurse -Force
  }
  Write-Host "[CITADEL] Windows Core Service uninstalled."
  if ($PreserveState) {
    Write-Host "[CITADEL] Node state was preserved by explicit request: $StateRoot"
  }
  exit 0
}

$ControllerUri = [System.Uri]$ControllerUrl
$IsHttps = $ControllerUri.Scheme -eq "https"
$IsLoopbackTest = $ControllerUri.Scheme -eq "http" -and @("127.0.0.1", "localhost", "::1") -contains $ControllerUri.DnsSafeHost
if (-not ($IsHttps -or $IsLoopbackTest)) {
  throw "ControllerUrl must use HTTPS; loopback HTTP is test-only."
}

function Copy-VerifiedAgentFile([string]$Name, [string]$ExpectedHash) {
  $Source = Join-Path $SourceRoot $Name
  $Destination = Join-Path $InstallRoot $Name
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required package file is missing: $Name"
  }
  if ((Get-Sha256 $Source) -ne $ExpectedHash) {
    throw "Package integrity check failed for $Name."
  }
  if (Test-Path -LiteralPath $Destination) {
    if ((Get-Sha256 $Destination) -eq $ExpectedHash) {
      Write-Host "[CITADEL] $Name already matches the current release."
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

function Find-MachinePython314 {
  $Candidates = @()
  if ($env:ProgramFiles) {
    $Candidates += (Join-Path $env:ProgramFiles "Python314\python.exe")
  }
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) { return $Candidate }
  }

  $Launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($null -ne $Launcher) {
    $Resolved = & $Launcher.Source -3.14 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($Resolved)) {
      $Resolved = $Resolved.Trim()
      if ($env:ProgramFiles -and $Resolved.StartsWith($env:ProgramFiles, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $Resolved
      }
    }
  }
  return $null
}

function Find-FrameworkCompiler {
  $Candidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  )
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) { return $Candidate }
  }
  return $null
}

Stop-CitadelServiceIfPresent
Remove-LegacyStartup

$PythonPath = Find-MachinePython314
if ($null -eq $PythonPath) {
  $Winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($null -eq $Winget) {
    throw "Python 3.14 machine installation is missing and Windows Package Manager is unavailable."
  }
  Write-Host "[CITADEL] Installing machine-wide Python 3.14..."
  & $Winget.Source install --exact --id $PythonWingetId --source winget --scope machine --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) { throw "Automatic machine-wide Python installation failed." }
  $PythonPath = Find-MachinePython314
}
if ($null -eq $PythonPath) {
  throw "Machine-wide Python 3.14 is unavailable after installation."
}

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

$NewIdentity = Join-Path $StateRoot "identity.json"
$LegacyIdentity = Join-Path $LegacyStateRoot "identity.json"
if (-not (Test-Path -LiteralPath $NewIdentity) -and (Test-Path -LiteralPath $LegacyIdentity)) {
  Copy-Item -LiteralPath $LegacyIdentity -Destination $NewIdentity -Force
  Write-Host "[CITADEL] Migrated existing node identity into the Core Service state directory."
}
foreach ($StateName in @("pending-results.json", "network-recovery.json")) {
  $LegacyFile = Join-Path $LegacyStateRoot $StateName
  $NewFile = Join-Path $StateRoot $StateName
  if (-not (Test-Path -LiteralPath $NewFile) -and (Test-Path -LiteralPath $LegacyFile)) {
    Copy-Item -LiteralPath $LegacyFile -Destination $NewFile -Force
  }
}

$CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$Icacls = Get-Command icacls.exe -ErrorAction Stop
$UserGrant = "*" + $CurrentUserSid + ":(OI)(CI)F"
foreach ($ProtectedPath in @($InstallRoot, $StateRoot)) {
  & $Icacls.Source $ProtectedPath /inheritance:r /grant:r $UserGrant "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-19:(OI)(CI)M" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to harden CITADEL ACL: $ProtectedPath"
  }
}
Write-Host "[CITADEL] Install/state ACLs restricted; LocalService receives only required modify access."

$V1Changed = Copy-VerifiedAgentFile "citadel_node_v1.py" $ExpectedV1Sha256
$V2Changed = Copy-VerifiedAgentFile "citadel_node_v2.py" $ExpectedV2Sha256
$ServiceSourceChanged = Copy-VerifiedAgentFile "CitadelNodeService.cs" $ExpectedServiceHostSha256

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
}

$Venv = Join-Path $InstallRoot ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
$CreateVenv = -not (Test-Path -LiteralPath $VenvPython)
if (-not $CreateVenv) {
  & $VenvPython -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)" *> $null
  if ($LASTEXITCODE -ne 0) { $CreateVenv = $true }
}
if ($CreateVenv) {
  if (Test-Path -LiteralPath $Venv) { Remove-Item -LiteralPath $Venv -Recurse -Force }
  Write-Host "[CITADEL] Creating machine service Python environment..."
  & $PythonPath -m venv $Venv
  if ($LASTEXITCODE -ne 0) { throw "Unable to create Python virtual environment." }
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
}

$AgentScript = Join-Path $InstallRoot "citadel_node_v2.py"
$StopPath = Join-Path $StateRoot "STOP"
if (Test-Path -LiteralPath $StopPath) {
  Remove-Item -LiteralPath $StopPath -Force
  Write-Host "[CITADEL] Previous STOP marker cleared by explicit administrator repair."
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

$ServiceSource = Join-Path $InstallRoot "CitadelNodeService.cs"
$ServiceExe = Join-Path $InstallRoot "CitadelNodeService.exe"
$Compiler = Find-FrameworkCompiler
if ($null -eq $Compiler) {
  throw ".NET Framework C# compiler is required for the transparent CITADEL service host."
}
$TempServiceExe = Join-Path $InstallRoot "CitadelNodeService.new.exe"
Remove-Item -LiteralPath $TempServiceExe -Force -ErrorAction SilentlyContinue
& $Compiler /nologo /optimize+ /target:winexe "/out:$TempServiceExe" /reference:System.ServiceProcess.dll $ServiceSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $TempServiceExe)) {
  throw "CITADEL Windows Service Host compilation failed."
}
& $TempServiceExe --self-test
if ($LASTEXITCODE -ne 0) {
  throw "CITADEL Windows Service Host self-test failed."
}
Move-Item -LiteralPath $TempServiceExe -Destination $ServiceExe -Force

$Sc = Join-Path $env:WINDIR "System32\sc.exe"
$BinPath = '"' + $ServiceExe + '" --python "' + $VenvPython + '" --agent "' + $AgentScript + '" --config "' + $ConfigPath + '" --stop-file "' + $StopPath + '"'
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  & $Sc config $ServiceName binPath= $BinPath start= delayed-auto obj= "NT AUTHORITY\LocalService" DisplayName= $ServiceDisplayName | Out-Null
} else {
  & $Sc create $ServiceName binPath= $BinPath start= delayed-auto obj= "NT AUTHORITY\LocalService" DisplayName= $ServiceDisplayName | Out-Null
}
if ($LASTEXITCODE -ne 0) { throw "Unable to create/configure CITADEL Windows service." }

& $Sc description $ServiceName "CITADEL/EWS bounded Core Agent service" | Out-Null
& $Sc failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Unable to configure CITADEL service recovery." }

Start-Service -Name $ServiceName
$Service = Get-Service -Name $ServiceName
$Service.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
Start-Sleep -Seconds 2
$Service.Refresh()
if ($Service.Status -ne "Running") {
  throw "CITADEL Windows Core Service did not remain running."
}

$InstallState = @{
  node_id = $NodeId
  controller_url = $ControllerUrl.TrimEnd('/')
  install_root = $InstallRoot
  state_root = $StateRoot
  agent_version = "0.3.12"
  service_name = $ServiceName
  service_account = "NT AUTHORITY\LocalService"
  service_start = "Automatic (Delayed Start)"
  v1_sha256 = $ExpectedV1Sha256
  v2_sha256 = $ExpectedV2Sha256
  service_source_sha256 = $ExpectedServiceHostSha256
  updated_at = [DateTime]::UtcNow.ToString("o")
} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $InstallRoot "install-state.json"), $InstallState + [Environment]::NewLine, $Utf8NoBom)

Write-Host ""
Write-Host "[CITADEL] Setup/repair complete."
Write-Host "[CITADEL] Node: $NodeId"
Write-Host "[CITADEL] Controller: $($ControllerUrl.TrimEnd('/'))"
Write-Host "[CITADEL] Windows service: $ServiceName / LocalService / Automatic (Delayed Start)"
Write-Host "[CITADEL] Core Agent now starts at boot without an interactive user login."
Write-Host "[CITADEL] Re-running this installer performs an idempotent repair and preserves node identity."
