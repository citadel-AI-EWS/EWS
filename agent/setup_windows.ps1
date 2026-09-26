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
$ReleaseVersion = "0.3.17"
$ExpectedV1Sha256 = "86c3cf6897dc16a26904f15be96ad41d05ab22c3fc28f4e5e91f9594fd65ba97"
$ExpectedV2Sha256 = "2ae1573d4ac13144363c7edfa1fa7b3677015c32bc3c7a369a2213666e2bba76"
$ExpectedServiceHostSha256 = "892c5f388f9b54c0bcbb2956381dd601dfa8065b0e9258ba673e9505c2f81cad"
$ExpectedServiceHelperSha256 = "e0e66f5a27018a283c65d42e6ead93e382706a163da682e6bd49f2b1fb9b0f99"
$ExpectedEnterpriseProbeSha256 = "0d056ab71e2216821cd314a97bc14e87f87c60140a0bcf787a24cfa33212c2ee"

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
if ([string]::IsNullOrWhiteSpace($ControllerUrl) -or $ControllerUrl.Contains('"') -or $ControllerUrl.IndexOf([char]10) -ge 0 -or $ControllerUrl.IndexOf([char]13) -ge 0) {
  throw "Unsafe ControllerUrl."
}
$PreElevationControllerUri = [System.Uri]$ControllerUrl
$PreElevationHttps = $PreElevationControllerUri.Scheme -eq "https"
$PreElevationLoopback = $PreElevationControllerUri.Scheme -eq "http" -and @("127.0.0.1", "localhost", "::1") -contains $PreElevationControllerUri.DnsSafeHost
if (-not ($PreElevationHttps -or $PreElevationLoopback)) {
  throw "ControllerUrl must use HTTPS; loopback HTTP is test-only."
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

$ProgramDataBase = [System.IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\')
$ProgramDataRoot = $ProgramDataBase + '\'
$InstallRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
foreach ($MachinePath in @($InstallRoot, $StateRoot)) {
  if ([string]::Equals($MachinePath, $ProgramDataBase, [System.StringComparison]::OrdinalIgnoreCase) -or
      -not ($MachinePath + '\').StartsWith($ProgramDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Windows Core Service roots must be strict descendants of ProgramData."
  }
}
$InstallPrefix = $InstallRoot + '\'
$StatePrefix = $StateRoot + '\'
if ([string]::Equals($InstallRoot, $StateRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $InstallPrefix.StartsWith($StatePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    $StatePrefix.StartsWith($InstallPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "InstallRoot and StateRoot must be separate, non-overlapping ProgramData directories."
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

$InstallStatePath = Join-Path $InstallRoot "install-state.json"
$PreviousReleaseRoot = $null
if (Test-Path -LiteralPath $InstallStatePath) {
  try {
    $PreviousInstallState = Get-Content -LiteralPath $InstallStatePath -Raw | ConvertFrom-Json
    $CandidatePreviousRelease = [string]$PreviousInstallState.release_root
    if (-not [string]::IsNullOrWhiteSpace($CandidatePreviousRelease)) {
      $CandidatePreviousRelease = [System.IO.Path]::GetFullPath($CandidatePreviousRelease).TrimEnd('\')
      $ReleaseBasePrefix = [System.IO.Path]::GetFullPath($ReleaseBase).TrimEnd('\') + '\'
      if (($CandidatePreviousRelease + '\').StartsWith($ReleaseBasePrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
          (Test-Path -LiteralPath $CandidatePreviousRelease)) {
        $PreviousReleaseRoot = $CandidatePreviousRelease
      }
    }
  } catch {
    Write-Warning "[CITADEL] Previous install-state could not be parsed; no rollback release will be retained from it."
  }
}

try {
  Set-CitadelDirectoryAcl -Path $ReleaseRoot

  Copy-VerifiedReleaseFile "citadel_node_v1.py" $ExpectedV1Sha256 $ReleaseRoot
  Copy-VerifiedReleaseFile "citadel_node_v2.py" $ExpectedV2Sha256 $ReleaseRoot
  Copy-VerifiedReleaseFile "windows_enterprise_probe.ps1" $ExpectedEnterpriseProbeSha256 $ReleaseRoot
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
  prevent_automatic_sleep = $true
  network_recovery_enabled = $true
  allowed_wifi_profiles = @()
  controller_public_x = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
} | ConvertTo-Json
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigPath, $ConfigJson + [Environment]::NewLine, $Utf8NoBom)

$AgentScript = Join-Path $ReleaseRoot "citadel_node_v2.py"
& $VenvPython $AgentScript doctor --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Agent diagnostics failed." }
& $VenvPython $AgentScript self-test
if ($LASTEXITCODE -ne 0) { throw "Agent self-test failed." }

$ProbeOutput = & $VenvPython $AgentScript probe --config $ConfigPath
if ($LASTEXITCODE -ne 0) { throw "Passive Controller probe failed." }
try {
  $ProbeState = (($ProbeOutput | Select-Object -Last 1) -as [string]) | ConvertFrom-Json
} catch {
  throw "Controller probe returned invalid JSON."
}
$NodeId = [string]$ProbeState.node_id
if (-not $NodeId.StartsWith("node_") -or $ProbeState.ok -ne $true) {
  throw "Controller probe did not return a valid node identity."
}
Write-Host "[CITADEL] Staged release passed passive enrollment/heartbeat probe: $NodeId"

$ServiceSource = Join-Path $ReleaseRoot "CitadelNodeService.cs"
$ServiceExe = Join-Path $ReleaseRoot "CitadelNodeService.exe"
$Compiler = Find-FrameworkCompiler
if ($null -eq $Compiler) { throw ".NET Framework C# compiler is required for the CITADEL service host." }
& $Compiler /nologo /optimize+ /target:winexe "/out:$ServiceExe" /reference:System.ServiceProcess.dll $ServiceSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ServiceExe)) { throw "CITADEL Windows Service Host compilation failed." }
& $ServiceExe --self-test
if ($LASTEXITCODE -ne 0) { throw "CITADEL Windows Service Host self-test failed." }
} catch {
  $StageError = $_
  if (Test-Path -LiteralPath $ReleaseRoot) {
    Remove-Item -LiteralPath $ReleaseRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  throw $StageError
}

$StopPath = Join-Path $StateRoot "STOP"
$LifecycleStopPath = Join-Path $StateRoot "SERVICE_STOP"
$HoldPath = Join-Path $StateRoot "SERVICE_HOLD"
$ReadyPath = Join-Path $StateRoot "SERVICE_READY"
$PausedPath = Join-Path $StateRoot "PAUSED"
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
$LegacyShortcutExisted = Test-Path -LiteralPath $LegacyShortcutPath
$CreatedService = $null -eq $ExistingService
$CutoverCommitted = $false

$LegacyStateMatchesNode = $false
if ((Test-Path -LiteralPath $LegacyIdentity) -and (Test-Path -LiteralPath $NewIdentity)) {
  try {
    $LegacyIdentityState = Get-Content -LiteralPath $LegacyIdentity -Raw | ConvertFrom-Json
    $NewIdentityState = Get-Content -LiteralPath $NewIdentity -Raw | ConvertFrom-Json
    $LegacyStateMatchesNode = (
      [string]$LegacyIdentityState.node_id -eq $NodeId -and
      [string]$NewIdentityState.node_id -eq $NodeId
    )
  } catch {
    throw "Unable to validate legacy identity before final state migration."
  }
}

$BinPath = (Quote-CitadelServiceArg $ServiceExe) +
  " --python " + (Quote-CitadelServiceArg $VenvPython) +
  " --agent " + (Quote-CitadelServiceArg $AgentScript) +
  " --config " + (Quote-CitadelServiceArg $ConfigPath) +
  " --stop-file " + (Quote-CitadelServiceArg $StopPath) +
  " --lifecycle-stop-file " + (Quote-CitadelServiceArg $LifecycleStopPath) +
  " --hold-file " + (Quote-CitadelServiceArg $HoldPath) +
  " --ready-file " + (Quote-CitadelServiceArg $ReadyPath)

try {
  if ($null -ne $ExistingService) {
    Stop-CitadelServiceIfPresent
  }

  if ($PersistentStopExisted) {
    Remove-Item -LiteralPath $StopPath -Force
    Write-Host "[CITADEL] Explicit administrator repair cleared the persistent STOP marker."
  }
  Remove-Item -LiteralPath $LifecycleStopPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  [System.IO.File]::WriteAllText($HoldPath, "service cutover hold" + [Environment]::NewLine, $Utf8NoBom)

  $Configured = Set-CitadelServiceDefinition -Name $ServiceName -DisplayName $ServiceDisplayName -BinaryPathName $BinPath -StartName "NT AUTHORITY\LocalService" -DelayedAutoStart $true
  Set-CitadelServiceRecovery -Name $ServiceName

  Start-Service -Name $ServiceName
  $Service = Get-Service -Name $ServiceName
  $Service.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
  Start-Sleep -Seconds 1
  $Service.Refresh()
  if ($Service.Status -ne "Running") { throw "CITADEL Windows Core Service did not remain running." }

  $ServiceCim = Get-CitadelServiceCim -Name $ServiceName
  if ($null -eq $ServiceCim -or [int]$ServiceCim.ProcessId -le 0) {
    throw "Windows SCM did not publish a running service process."
  }

  $ChildDeadline = [DateTime]::UtcNow.AddSeconds(20)
  $ManagedChild = $null
  do {
    $ManagedChild = Get-CimInstance Win32_Process -Filter ("ParentProcessId=" + [int]$ServiceCim.ProcessId) -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains("citadel_node_v2.py") } |
      Select-Object -First 1
    if ($null -eq $ManagedChild) { Start-Sleep -Milliseconds 500 }
  } while ($null -eq $ManagedChild -and [DateTime]::UtcNow -lt $ChildDeadline)
  if ($null -eq $ManagedChild) { throw "SCM service started but no managed Python Core Agent child was observed." }

  # The LocalService child is held away from commands, assignments and result
  # queues until it proves Controller connectivity with an SCM-mode heartbeat.
  $ReadyDeadline = [DateTime]::UtcNow.AddSeconds(45)
  $ReadyState = $null
  do {
    if (Test-Path -LiteralPath $ReadyPath) {
      try {
        $ReadyState = Get-Content -LiteralPath $ReadyPath -Raw | ConvertFrom-Json
      } catch {
        throw "Managed service readiness marker is invalid JSON."
      }
      if ([string]$ReadyState.node_id -ne $NodeId -or
          [string]$ReadyState.agent_version -ne $ReleaseVersion -or
          $ReadyState.windows_core_service -ne $true) {
        throw "Managed service readiness marker does not match this node/release."
      }
      break
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $ReadyDeadline)
  if ($null -eq $ReadyState) {
    throw "LocalService Core Agent did not confirm a Controller heartbeat during cutover."
  }

  # From this point the replacement service has proven network/controller
  # health. A later cleanup problem must not roll it back to an unverified or
  # partially stopped legacy lifecycle. The HOLD file stays in place until the
  # final legacy state snapshot is complete.
  $CutoverCommitted = $true

  $LegacyCleanupFailed = $false
  foreach ($Process in $LegacyProcessesBeforeCutover) {
    try {
      Stop-Process -Id $Process.ProcessId -Force -ErrorAction Stop
      Wait-Process -Id $Process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    } catch {
      Write-Warning ("[CITADEL] Could not stop legacy agent process " + $Process.ProcessId + ": " + $_.Exception.Message)
      $LegacyCleanupFailed = $true
    }
  }
  if ($LegacyCleanupFailed) {
    throw "Legacy agent cleanup is incomplete; new service remains safely held."
  }

  if ($LegacyStateMatchesNode) {
    foreach ($StateName in @("pending-results.json", "network-recovery.json", "lmstudio-state.json")) {
      $LegacyFile = Join-Path $LegacyStateRoot $StateName
      $NewFile = Join-Path $StateRoot $StateName
      if (Test-Path -LiteralPath $LegacyFile) {
        Copy-Item -LiteralPath $LegacyFile -Destination $NewFile -Force
      }
    }
    $LegacyPaused = Join-Path $LegacyStateRoot "PAUSED"
    if (Test-Path -LiteralPath $LegacyPaused) {
      Copy-Item -LiteralPath $LegacyPaused -Destination $PausedPath -Force
    } elseif (Test-Path -LiteralPath $PausedPath) {
      Remove-Item -LiteralPath $PausedPath -Force
    }
  }

  if ($LegacyShortcutExisted -and (Test-Path -LiteralPath $LegacyShortcutPath)) {
    Remove-Item -LiteralPath $LegacyShortcutPath -Force
  }

  Remove-Item -LiteralPath $HoldPath -Force
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue

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
  [System.IO.File]::WriteAllText($InstallStatePath, $InstallState + [Environment]::NewLine, $Utf8NoBom)

  $KeepReleasePaths = @($ReleaseRoot)
  if ($null -ne $PreviousReleaseRoot) { $KeepReleasePaths += $PreviousReleaseRoot }
  foreach ($ReleaseDirectory in @(Get-ChildItem -LiteralPath $ReleaseBase -Directory -ErrorAction SilentlyContinue)) {
    $ReleaseFullPath = [System.IO.Path]::GetFullPath($ReleaseDirectory.FullName).TrimEnd('\')
    $Keep = $false
    foreach ($KeepPath in $KeepReleasePaths) {
      if ([string]::Equals($ReleaseFullPath, ([System.IO.Path]::GetFullPath($KeepPath).TrimEnd('\')), [System.StringComparison]::OrdinalIgnoreCase)) {
        $Keep = $true
        break
      }
    }
    if (-not $Keep) {
      try {
        Remove-Item -LiteralPath $ReleaseFullPath -Recurse -Force -ErrorAction Stop
      } catch {
        Write-Warning ("[CITADEL] Could not prune superseded release " + $ReleaseFullPath + ": " + $_.Exception.Message)
      }
    }
  }

} catch {
  $CutoverError = $_
  if ($CutoverCommitted) {
    Write-Warning "[CITADEL] New SCM service is already committed. It will not be rolled back after a secondary cleanup/metadata error."
    throw $CutoverError
  }
  Write-Warning "[CITADEL] Service cutover failed before commit; restoring the previous lifecycle."
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
    Remove-Item -LiteralPath $HoldPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
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
