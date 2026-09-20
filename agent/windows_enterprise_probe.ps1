$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Safe-CimFirst {
  param([Parameter(Mandatory = $true)][string]$ClassName, [string]$Filter = "")
  try {
    if ([string]::IsNullOrWhiteSpace($Filter)) {
      return Get-CimInstance -ClassName $ClassName -ErrorAction Stop | Select-Object -First 1
    }
    return Get-CimInstance -ClassName $ClassName -Filter $Filter -ErrorAction Stop | Select-Object -First 1
  } catch {
    return $null
  }
}

function Safe-Service {
  param([Parameter(Mandatory = $true)][string]$Name)
  try { return Get-Service -Name $Name -ErrorAction Stop } catch { return $null }
}

function Registry-Exists {
  param([Parameter(Mandatory = $true)][string]$Path)
  try { return Test-Path -LiteralPath $Path -ErrorAction Stop } catch { return $false }
}

function Recent-EventSummary {
  param([Parameter(Mandatory = $true)][string]$LogName)
  $result = [ordered]@{ log = $LogName; critical_or_error_last_hour = 0; query_ok = $false }
  try {
    $start = (Get-Date).AddHours(-1)
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = $LogName; Level = 1,2; StartTime = $start } -MaxEvents 100 -ErrorAction Stop)
    $result.critical_or_error_last_hour = $events.Count
    $result.query_ok = $true
  } catch {
    $result.query_ok = $false
  }
  return $result
}

$os = Safe-CimFirst "Win32_OperatingSystem"
$computer = Safe-CimFirst "Win32_ComputerSystem"
$service = Safe-CimFirst "Win32_Service" "Name='CitadelEWSNode'"
$cpuPerf = Safe-CimFirst "Win32_PerfFormattedData_PerfOS_Processor" "Name='_Total'"
$memoryPerf = Safe-CimFirst "Win32_PerfFormattedData_PerfOS_Memory"
$hyperVFeature = Safe-CimFirst "Win32_OptionalFeature" "Name='Microsoft-Hyper-V-All'"
$wuService = Safe-Service "wuauserv"
$gpsvc = Safe-Service "gpsvc"
$intuneService = Safe-Service "IntuneManagementExtension"

$latestHotfix = $null
try {
  $latestHotfix = Get-CimInstance -ClassName Win32_QuickFixEngineering -ErrorAction Stop |
    Sort-Object -Property InstalledOn -Descending |
    Select-Object -First 1
} catch {}

$vmCount = $null
$runningVmCount = $null
$hyperVQueryOk = $false
try {
  if (Get-Command Get-VM -ErrorAction SilentlyContinue) {
    $vms = @(Get-VM -ErrorAction Stop)
    $vmCount = $vms.Count
    $runningVmCount = @($vms | Where-Object { $_.State -eq "Running" }).Count
    $hyperVQueryOk = $true
  }
} catch {
  $hyperVQueryOk = $false
}

$mdmEnrollmentCount = 0
try {
  $enrollmentRoot = "HKLM:\SOFTWARE\Microsoft\Enrollments"
  if (Test-Path -LiteralPath $enrollmentRoot) {
    $mdmEnrollmentCount = @(Get-ChildItem -LiteralPath $enrollmentRoot -ErrorAction Stop).Count
  }
} catch {
  $mdmEnrollmentCount = 0
}

$pendingReboot = (
  (Registry-Exists "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or
  (Registry-Exists "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")
)

$serviceAccount = if ($null -ne $service) { [string]$service.StartName } else { "" }
$managedServiceAccountCandidate = (-not [string]::IsNullOrWhiteSpace($serviceAccount)) -and $serviceAccount.EndsWith("$")
$domainJoined = $false
$domainName = $null
if ($null -ne $computer) {
  $domainJoined = [bool]$computer.PartOfDomain
  if ($domainJoined) { $domainName = [string]$computer.Domain }
}

$gmsaDmsa = [ordered]@{
  configured = $managedServiceAccountCandidate
  service_account = if ($serviceAccount) { $serviceAccount } else { $null }
  domain_joined = $domainJoined
  domain = $domainName
  ad_module_available = [bool](Get-Module -ListAvailable -Name ActiveDirectory | Select-Object -First 1)
  note = if ($managedServiceAccountCandidate) {
    "Managed service account candidate detected from Windows Service identity; account subtype is not guessed without authoritative directory data."
  } else {
    "CITADEL currently uses its configured local service identity. gMSA/dMSA can only be activated on an eligible domain-managed host."
  }
}

$hotpatch = [ordered]@{
  state = "external-management-required"
  pending_reboot = $pendingReboot
  note = "The local probe reports Windows Update/reboot state but does not claim Hotpatch eligibility without an authoritative Microsoft management signal."
}

$result = [ordered]@{
  schema = "citadel.windows.enterprise.v1"
  captured_at = (Get-Date).ToUniversalTime().ToString("o")
  readonly = $true
  cim = [ordered]@{
    os_caption = if ($null -ne $os) { [string]$os.Caption } else { $null }
    os_version = if ($null -ne $os) { [string]$os.Version } else { $null }
    os_build = if ($null -ne $os) { [string]$os.BuildNumber } else { $null }
    manufacturer = if ($null -ne $computer) { [string]$computer.Manufacturer } else { $null }
    model = if ($null -ne $computer) { [string]$computer.Model } else { $null }
    domain_joined = $domainJoined
    domain = $domainName
    citadel_service_state = if ($null -ne $service) { [string]$service.State } else { $null }
    citadel_service_start_mode = if ($null -ne $service) { [string]$service.StartMode } else { $null }
  }
  performance = [ordered]@{
    cpu_percent = if ($null -ne $cpuPerf) { [double]$cpuPerf.PercentProcessorTime } else { $null }
    memory_available_mb = if ($null -ne $memoryPerf) { [double]$memoryPerf.AvailableMBytes } else { $null }
    source = "CIM formatted performance classes"
  }
  event_log = [ordered]@{
    system = Recent-EventSummary "System"
    application = Recent-EventSummary "Application"
  }
  service_identity = $gmsaDmsa
  windows_update = [ordered]@{
    service_status = if ($null -ne $wuService) { [string]$wuService.Status } else { $null }
    service_start_type = if ($null -ne $wuService) { [string]$wuService.StartType } else { $null }
    pending_reboot = $pendingReboot
    latest_hotfix_id = if ($null -ne $latestHotfix) { [string]$latestHotfix.HotFixID } else { $null }
    latest_hotfix_installed_on = if ($null -ne $latestHotfix -and $null -ne $latestHotfix.InstalledOn) { [string]$latestHotfix.InstalledOn } else { $null }
    hotpatch = $hotpatch
  }
  hyper_v = [ordered]@{
    optional_feature_state = if ($null -ne $hyperVFeature) { [int]$hyperVFeature.InstallState } else { $null }
    query_ok = $hyperVQueryOk
    vm_count = $vmCount
    running_vm_count = $runningVmCount
    readonly = $true
  }
  management = [ordered]@{
    group_policy_service = if ($null -ne $gpsvc) { [string]$gpsvc.Status } else { $null }
    mdm_enrollment_count = $mdmEnrollmentCount
    intune_management_extension = if ($null -ne $intuneService) { [string]$intuneService.Status } else { $null }
    domain_joined = $domainJoined
    domain = $domainName
  }
}

$result | ConvertTo-Json -Depth 8 -Compress
