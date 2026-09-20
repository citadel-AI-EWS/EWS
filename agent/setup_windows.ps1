[CmdletBinding()]
param(
  [string]$ControllerUrl = "https://citadel-ai.init1.workers.dev",
  [string]$InstallRoot = "$env:ProgramData\CitadelEWS\agent",
  [string]$StateRoot = "$env:ProgramData\CitadelEWS\state",
  [switch]$Uninstall,
  [switch]$PreserveState,
  [string]$LegacyUserSid = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ServiceName = "CitadelEWSNode"
$ServiceDisplayName = "CITADEL EWS Node"
$PythonWingetId = "Python.Python.3.14"
$ReleaseVersion = "0.3.12"
$ExpectedV1Sha256 = "c1d65650f5e90200e7d4135ee14bcbc3ef31d912970784d38db6a4d88432f637"
$ExpectedV2Sha256 = "15083cb3c7de44a614794605aba1f95a372232479f17782661e22a73386eee7e"
$ExpectedServiceHostSha256 = "f34cbdd554274b57af367f80bbe43c7b782b06cbc06f554fe394567a8e5d4d32"
$ExpectedServiceHelperSha256 = "fe0789edac428b035d0eae29461a868279ca55094a020327f9fb7e7d89fd4f1c"

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-IsAdministrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
  return $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ([string]::IsNullOrWhiteSpace($LegacyUserSid)) {
  $LegacyUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}
if ($LegacyUserSid -notmatch '^S-\d-\d+(-\d+)+$') {
  throw "Invalid legacy user SID."
}
foreach ($PathArg in @($InstallRoot, $StateRoot)) {
  if ([string]::IsNullOrWhiteSpace($PathArg) -or $PathArg.Contains('"')) {
    throw "Unsafe CITADEL installation path."
  }
}

if (-not (Test-IsAdministrator)) {
  Write-Host "[CITADEL] Administrator approval is required to install the Windows Core Service."
  $ElevatedArgs = @(
    "-NoLogo", "-NoProfile", "-File", ('"' + $PSCommandPath + '"'),
    "-ControllerUrl", ('"' + $ControllerUrl + '"'),
    "-InstallRoot", ('"' + $InstallRoot + '"'),
    "-StateRoot", ('"' + $StateRoot + '"'),
    "-LegacyUserSid", ('"' + $LegacyUserSid + '"')
  )
  if ($Uninstall) { $ElevatedArgs += "-Uninstall" }
  if ($PreserveState) { $ElevatedArgs += "-PreserveState" }
  $Elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $ElevatedArgs -Wait -PassThru
  exit $Elevated.ExitCode
}

$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceHelperSource = Join-Path $SourceRoot "windows_service.ps1"
if (-not (Test-Path -LiteralPath $ServiceHelperSource)) {
  throw "Required package file is missing: windows_service.ps1"
}
if ((Get-Sha256 $ServiceHelperSource) -ne $ExpectedServiceHelperSha256) {
  throw "Package integrity check failed for windows_service.ps1."
}
. $ServiceHelperSource

$ProgramDataRoot = [System.IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\') + '\'
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot)
foreach ($MachinePath in @($InstallRoot, $StateRoot)) {
  if (-not ($MachinePath + '\').StartsWith($ProgramDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Windows Core Service files must remain under ProgramData."
  }
}

$LegacyProfile = Get-CimInstance Win32_UserProfile -Filter ("SID='" + $LegacyUserSid + "'") -ErrorAction Stop |
  Select-Object -First 1
if ($null -eq $LegacyProfile -or [string]::IsNullOrWhiteSpace([string]$LegacyProfile.LocalPath)) {
  throw "Could not resolve the original user's legacy profile."
}
$LegacyProfileRoot = [System.IO.Path]::GetFullPath([string]$LegacyProfile.LocalPath)
$LegacyStateRoot = Join-Path $LegacyProfileRoot "AppData\Local\CitadelEWS\state"
$LegacyAgentRoot = Join-Path $LegacyProfileRoot "AppData\Local\CitadelEWS\agent"
$LegacyStartupDir = Join-Path $LegacyProfileRoot "AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
$LegacyShortcutPath = Join-Path $LegacyStartupDir "CITADEL EWS Agent.lnk"

$ControllerUri = [System.Uri]$ControllerUrl
$IsHttps = $ControllerUri.Scheme -eq "https"
$IsLoopbackTest = $ControllerUri.Scheme -eq "http" -and @("127.0.0.1", "localhost", "::1") -contains $ControllerUri.DnsSafeHost
if (-not ($IsHttps -or $IsLoopbackTest)) {
  throw "ControllerUrl must use HTTPS; loopback HTTP is test-only."
}

function Set-CitadelDirectoryAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  New-Item -ItemType Directory -Force -Path $Path | Out-Null

  $Acl = New-Object System.Security.AccessControl.DirectorySecurity
  $Acl.SetAccessRuleProtection($true, $false)
  $Inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $Propagation = [System.Security.AccessControl.PropagationFlags]::None
  $Allow = [System.Security.AccessControl.AccessControlType]::Allow
  $Rules = @(
    @("S-1-5-18", [System.Security.AccessControl.FileSystemRights]::FullControl),
    @("S-1-5-32-544", [System.Security.AccessControl.FileSystemRights]::FullControl),
    @("S-1-5-19", [System.Security.AccessControl.FileSystemRights]::Modify)
  )
  foreach ($Rule in $Rules) {
    $Sid = New-Object System.Security.Principal.SecurityIdentifier($Rule[0])
    $Ace = New-Object System.Security.AccessControl.FileSystemAccessRule($Sid, $Rule[1], $Inheritance, $Propagation, $Allow)
    [void]$Acl.AddAccessRule($Ace)
  }
  $Acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")))
  Set-Acl -LiteralPath $Path -AclObject $Acl

  $AllowedSids = @("S-1-5-18", "S-1-5-32-544", "S-1-5-19")
  $VerifiedAcl = Get-Acl -LiteralPath $Path
  foreach ($Entry in $VerifiedAcl.Access) {
    $SidValue = $Entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    if ($AllowedSids -notcontains $SidValue) {
      throw "Unexpected explicit ACL principal remained on $Path : $SidValue"
    }
  }
}

function Copy-VerifiedReleaseFile {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$ExpectedHash,
    [Parameter(Mandatory = $true)][string]$DestinationRoot
  )
  $Source = Join-Path $SourceRoot $Name
  $Destination = Join-Path $DestinationRoot $Name
  if (-not (Test-Path -LiteralPath $Source)) { throw "Required package file is missing: $Name" }
  if ((Get-Sha256 $Source) -ne $ExpectedHash) { throw "Package integrity check failed for $Name." }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
  if ((Get-Sha256 $Destination) -ne $ExpectedHash) { throw "Installed file verification failed: $Name" }
}

function Find-MachinePython314 {
  $Candidate = Join-Path $env:ProgramFiles "Python314\python.exe"
  if (Test-Path -LiteralPath $Candidate) { return $Candidate }
  $Launcher = Get-Command py -ErrorAction SilentlyContinue
  if ($null -ne $Launcher) {
    $Resolved = & $Launcher.Source -3.14 -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($Resolved)) {
      $Resolved = $Resolved.Trim()
      if ($Resolved.StartsWith($env:ProgramFiles, [System.StringComparison]::OrdinalIgnoreCase)) { return $Resolved }
    }
  }
  return $null
}

function Find-FrameworkCompiler {
  foreach ($Candidate in @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  )) {
    if (Test-Path -LiteralPath $Candidate) { return $Candidate }
  }
  return $null
}

function Get-RunningLegacyCitadelAgents {
  $Needles = @($LegacyAgentRoot, $LegacyStateRoot)
  try {
    return @(
      Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object {
          if (-not $_.CommandLine -or -not $_.CommandLine.Contains("citadel_node_v2.py")) { return $false }
          foreach ($Needle in $Needles) {
            if ($_.CommandLine.IndexOf($Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
          }
          return $false
        }
    )
  } catch {
    throw "[CITADEL] Could not inspect the original user's legacy agent safely."
  }
}

function Stop-CitadelServiceIfPresent {
  $Existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -eq $Existing -or $Existing.Status -eq "Stopped") { return }
  Stop-Service -Name $ServiceName -Force
  $Existing.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(75))
}

function Quote-CitadelServiceArg {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains('"')) { throw "Unsafe Windows service argument path." }
  return '"' + $Value + '"'
}

if ($Uninstall) {
  Stop-CitadelServiceIfPresent
  Remove-CitadelServiceDefinition -Name $ServiceName
  foreach ($Process in (Get-RunningLegacyCitadelAgents)) {
    Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $LegacyShortcutPath) {
    Remove-Item -LiteralPath $LegacyShortcutPath -Force
  }
  if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
  }
  if (-not $PreserveState) {
    foreach ($RootToRemove in @($StateRoot, $LegacyStateRoot)) {
      if (Test-Path -LiteralPath $RootToRemove) {
        Remove-Item -LiteralPath $RootToRemove -Recurse -Force
      }
    }
  }
  Write-Host "[CITADEL] Windows Core Service uninstalled."
  if ($PreserveState) { Write-Host "[CITADEL] Node state was preserved by explicit request." }
  exit 0
}

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
if ($null -eq $PythonPath) { throw "Machine-wide Python 3.14 is unavailable after installation." }

# Harden the machine destinations before any identity, queue, or executable is
# copied into them. The DACL is rebuilt from scratch; unexpected explicit ACEs
# are not retained.
Set-CitadelDirectoryAcl -Path $InstallRoot
Set-CitadelDirectoryAcl -Path $StateRoot
Write-Host "[CITADEL] Machine install/state ACLs rebuilt before migration."

$NewIdentity = Join-Path $StateRoot "identity.json"
$LegacyIdentity = Join-Path $LegacyStateRoot "identity.json"
if (-not (Test-Path -LiteralPath $NewIdentity) -and (Test-Path -LiteralPath $LegacyIdentity)) {
  Copy-Item -LiteralPath $LegacyIdentity -Destination $NewIdentity -Force
  Write-Host "[CITADEL] Migrated existing node identity from the original user profile."
}
foreach ($StateName in @("pending-results.json", "network-recovery.json", "lmstudio-state.json", "PAUSED")) {
  $LegacyFile = Join-Path $LegacyStateRoot $StateName
  $NewFile = Join-Path $StateRoot $StateName
  if (-not (Test-Path -LiteralPath $NewFile) -and (Test-Path -LiteralPath $LegacyFile)) {
    Copy-Item -LiteralPath $LegacyFile -Destination $NewFile -Force
  }
}

# Build a unique final release directory while the current service/legacy agent
# is still running. A failed package install, dependency download, enrollment,
# or compilation therefore does not take the existing node offline.
$ReleaseId = $ReleaseVersion + "-" + [Guid]::NewGuid().ToString("N")
$ReleaseBase = Join-Path $InstallRoot "releases"
$ReleaseRoot = Join-Path $ReleaseBase $ReleaseId
Set-CitadelDirectoryAcl -Path $ReleaseBase
Set-CitadelDirectoryAcl -Path $ReleaseRoot

Copy-VerifiedReleaseFile "citadel_node_v1.py" $ExpectedV1Sha256 $ReleaseRoot
Copy-VerifiedReleaseFile "citadel_node_v2.py" $ExpectedV2Sha256 $ReleaseRoot
Copy-VerifiedReleaseFile "CitadelNodeService.cs" $ExpectedServiceHostSha256 $ReleaseRoot
Copy-VerifiedReleaseFile "windows_service.ps1" $ExpectedServiceHelperSha256 $ReleaseRoot

$RequirementsSource = Join-Path $SourceRoot "requirements.txt"
$RequirementsPath = Join-Path $ReleaseRoot "requirements.txt"
if (-not (Test-Path -LiteralPath $RequirementsSource)) { throw "Required package file is missing: requirements.txt" }
$RequirementsHash = Get-Sha256 $RequirementsSource
Copy-Item -LiteralPath $RequirementsSource -Destination $RequirementsPath -Force
if ((Get-Sha256 $RequirementsPath) -ne $RequirementsHash) { throw "requirements.txt verification failed." }

$Venv = Join-Path $ReleaseRoot ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"
& $PythonPath -m venv $Venv
if ($LASTEXITCODE -ne 0) { throw "Unable to create Python virtual environment." }
& $VenvPython -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip update failed." }
& $VenvPython -m pip install --disable-pip-version-check --requirement $RequirementsPath
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
& $VenvPython -c "import cryptography, psutil" *> $null
if ($LASTEXITCODE -ne 0) { throw "Installed agent dependencies are not importable." }

$ConfigPath = Join-Path $ReleaseRoot "config.json"
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
[System.IO.File]::WriteAllText($ConfigPath, $ConfigJson + [Environment]::NewLine, $Utf8NoBom)

$AgentScript = Join-Path $ReleaseRoot "citadel_node_v2.py"
& $VenvPython $AgentScript doctor --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Agent diagnostics failed." }
& $VenvPython $AgentScript self-test
if ($LASTEXITCODE -ne 0) { throw "Agent self-test failed." }

$EnrollOutput = & $VenvPython $AgentScript enroll --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Automatic enrollment failed." }
$NodeId = (($EnrollOutput | Select-Object -Last 1) -as [string]).Trim()
if (-not $NodeId.StartsWith("node_")) { throw "Controller did not return a valid node id." }
& $VenvPython $AgentScript once --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Live Controller cycle failed after enrollment." }
Write-Host "[CITADEL] Staged release passed Controller enrollment/live-cycle checks: $NodeId"

$ServiceSource = Join-Path $ReleaseRoot "CitadelNodeService.cs"
$ServiceExe = Join-Path $ReleaseRoot "CitadelNodeService.exe"
$Compiler = Find-FrameworkCompiler
if ($null -eq $Compiler) { throw ".NET Framework C# compiler is required for the CITADEL service host." }
& $Compiler /nologo /optimize+ /target:winexe "/out:$ServiceExe" /reference:System.ServiceProcess.dll $ServiceSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ServiceExe)) { throw "CITADEL Windows Service Host compilation failed." }
& $ServiceExe --self-test
if ($LASTEXITCODE -ne 0) { throw "CITADEL Windows Service Host self-test failed." }

$StopPath = Join-Path $StateRoot "STOP"
$LifecycleStopPath = Join-Path $StateRoot "SERVICE_STOP"
$PausedPath = Join-Path $StateRoot "PAUSED"
$PausedExistedBeforeCutover = Test-Path -LiteralPath $PausedPath
$TemporaryCutoverPause = -not $PausedExistedBeforeCutover
$PersistentStopExisted = Test-Path -LiteralPath $StopPath
$PersistentStopContent = if ($PersistentStopExisted) { [System.IO.File]::ReadAllText($StopPath) } else { $null }

$ExistingService = Get-CitadelServiceCim -Name $ServiceName
$ExistingSnapshot = if ($null -ne $ExistingService) { Get-CitadelServiceSnapshot -Name $ServiceName } else { $null }
$ExistingWasRunning = $false
if ($null -ne $ExistingService) {
  $ExistingPsService = Get-Service -Name $ServiceName -ErrorAction Stop
  $ExistingWasRunning = $ExistingPsService.Status -eq "Running"
}
$LegacyProcessesBeforeCutover = @(Get-RunningLegacyCitadelAgents)
$LegacyWasRunning = $LegacyProcessesBeforeCutover.Count -gt 0
$LegacyShortcutExisted = Test-Path -LiteralPath $LegacyShortcutPath
$CreatedService = $null -eq $ExistingService

$BinPath = (Quote-CitadelServiceArg $ServiceExe) +
  " --python " + (Quote-CitadelServiceArg $VenvPython) +
  " --agent " + (Quote-CitadelServiceArg $AgentScript) +
  " --config " + (Quote-CitadelServiceArg $ConfigPath) +
  " --stop-file " + (Quote-CitadelServiceArg $StopPath) +
  " --lifecycle-stop-file " + (Quote-CitadelServiceArg $LifecycleStopPath)

try {
  if ($null -ne $ExistingService) {
    Stop-CitadelServiceIfPresent
  }

  if ($PersistentStopExisted) {
    Remove-Item -LiteralPath $StopPath -Force
    Write-Host "[CITADEL] Explicit administrator repair cleared the persistent STOP marker."
  }
  Remove-Item -LiteralPath $LifecycleStopPath -Force -ErrorAction SilentlyContinue
  if ($TemporaryCutoverPause) {
    [System.IO.File]::WriteAllText($PausedPath, "temporary service cutover pause" + [Environment]::NewLine, $Utf8NoBom)
  }

  $Configured = Set-CitadelServiceDefinition -Name $ServiceName -DisplayName $ServiceDisplayName -BinaryPathName $BinPath -StartName "NT AUTHORITY\LocalService" -DelayedAutoStart $true
  Set-CitadelServiceRecovery -Name $ServiceName

  Start-Service -Name $ServiceName
  $Service = Get-Service -Name $ServiceName
  $Service.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
  Start-Sleep -Seconds 2
  $Service.Refresh()
  if ($Service.Status -ne "Running") { throw "CITADEL Windows Core Service did not remain running." }

  $ServiceCim = Get-CitadelServiceCim -Name $ServiceName
  if ($null -eq $ServiceCim -or [int]$ServiceCim.ProcessId -le 0) {
    throw "Windows SCM did not publish a running service process."
  }
  $ChildDeadline = [DateTime]::UtcNow.AddSeconds(15)
  $ManagedChild = $null
  do {
    $ManagedChild = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + [int]$ServiceCim.ProcessId) -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains("citadel_node_v2.py") } |
      Select-Object -First 1
    if ($null -eq $ManagedChild) { Start-Sleep -Milliseconds 500 }
  } while ($null -eq $ManagedChild -and [DateTime]::UtcNow -lt $ChildDeadline)
  if ($null -eq $ManagedChild) { throw "SCM service started but no managed Python Core Agent child was observed." }

  # Only after the new SCM service is demonstrably alive do we retire the
  # original user's Startup lifecycle. Until this point a staging failure
  # leaves the old agent untouched.
  foreach ($Process in $LegacyProcessesBeforeCutover) {
    Stop-Process -Id $Process.ProcessId -Force -ErrorAction Stop
  }
  if ($LegacyShortcutExisted -and (Test-Path -LiteralPath $LegacyShortcutPath)) {
    Remove-Item -LiteralPath $LegacyShortcutPath -Force
  }
  if ($TemporaryCutoverPause -and (Test-Path -LiteralPath $PausedPath)) {
    Remove-Item -LiteralPath $PausedPath -Force
  }

  $InstallState = @{
    node_id = $NodeId
    controller_url = $ControllerUrl.TrimEnd('/')
    install_root = $InstallRoot
    release_root = $ReleaseRoot
    state_root = $StateRoot
    agent_version = $ReleaseVersion
    service_name = $ServiceName
    service_account = [string]$Configured.StartName
    service_start = "Automatic (Delayed Start)"
    image_path = [string]$Configured.PathName
    windows_core_service = $true
    v1_sha256 = $ExpectedV1Sha256
    v2_sha256 = $ExpectedV2Sha256
    service_source_sha256 = $ExpectedServiceHostSha256
    service_helper_sha256 = $ExpectedServiceHelperSha256
    updated_at = [DateTime]::UtcNow.ToString("o")
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText((Join-Path $InstallRoot "install-state.json"), $InstallState + [Environment]::NewLine, $Utf8NoBom)

} catch {
  $CutoverError = $_
  Write-Warning "[CITADEL] Service cutover failed; restoring the previous lifecycle."
  try {
    Stop-CitadelServiceIfPresent
    if ($CreatedService) {
      Remove-CitadelServiceDefinition -Name $ServiceName
    } elseif ($null -ne $ExistingSnapshot) {
      Restore-CitadelServiceDefinition -Name $ServiceName -Snapshot $ExistingSnapshot
      if ($ExistingWasRunning) {
        Start-Service -Name $ServiceName
        (Get-Service -Name $ServiceName).WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
      }
    }
    if ($PersistentStopExisted -and -not (Test-Path -LiteralPath $StopPath)) {
      [System.IO.File]::WriteAllText($StopPath, $PersistentStopContent, $Utf8NoBom)
    }
    if ($TemporaryCutoverPause -and (Test-Path -LiteralPath $PausedPath)) {
      Remove-Item -LiteralPath $PausedPath -Force
    }
    if (Test-Path -LiteralPath $ReleaseRoot) {
      Remove-Item -LiteralPath $ReleaseRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  } catch {
    Write-Warning ("[CITADEL] Rollback also encountered an error: " + $_.Exception.Message)
  }
  throw $CutoverError
}

Write-Host ""
Write-Host "[CITADEL] Setup/repair complete."
Write-Host "[CITADEL] Node: $NodeId"
Write-Host "[CITADEL] Controller: $($ControllerUrl.TrimEnd('/'))"
Write-Host "[CITADEL] Release: $ReleaseRoot"
Write-Host "[CITADEL] Windows service: $ServiceName / LocalService / Automatic (Delayed Start)"
Write-Host "[CITADEL] SCM process and managed Python child were verified after cutover."
Write-Host "[CITADEL] Re-running this installer stages and verifies a new release before touching the running lifecycle."
