Set-StrictMode -Version Latest

function Assert-CitadelServiceName {
  param([Parameter(Mandatory = $true)][string]$Name)
  if ($Name -notmatch '^[A-Za-z0-9._-]{1,80}$') {
    throw "Invalid Windows service name."
  }
}

function Get-CitadelServiceCim {
  param([Parameter(Mandatory = $true)][string]$Name)
  Assert-CitadelServiceName $Name
  return Get-CimInstance -ClassName Win32_Service -Filter ("Name='" + $Name + "'") -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Get-CitadelServiceSnapshot {
  param([Parameter(Mandatory = $true)][string]$Name)
  $Service = Get-CitadelServiceCim $Name
  if ($null -eq $Service) { return $null }
  $RegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
  $Delayed = 0
  if (Test-Path -LiteralPath $RegistryPath) {
    $Item = Get-ItemProperty -LiteralPath $RegistryPath -Name DelayedAutostart -ErrorAction SilentlyContinue
    if ($null -ne $Item) { $Delayed = [int]$Item.DelayedAutostart }
  }
  return @{
    PathName = [string]$Service.PathName
    DisplayName = [string]$Service.DisplayName
    StartMode = [string]$Service.StartMode
    StartName = [string]$Service.StartName
    DelayedAutostart = $Delayed
  }
}

function Set-CitadelServiceDefinition {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$DisplayName,
    [Parameter(Mandatory = $true)][string]$BinaryPathName,
    [string]$StartName = "NT AUTHORITY\LocalService",
    [bool]$DelayedAutoStart = $true
  )
  Assert-CitadelServiceName $Name
  if ([string]::IsNullOrWhiteSpace($BinaryPathName) -or $BinaryPathName.Contains([char]0)) {
    throw "Invalid Windows service ImagePath."
  }

  $Existing = Get-CitadelServiceCim $Name
  if ($null -eq $Existing) {
    $Result = Invoke-CimMethod -ClassName Win32_Service -MethodName Create -Arguments @{
      Name = $Name
      DisplayName = $DisplayName
      PathName = $BinaryPathName
      ServiceType = [byte]16
      ErrorControl = [byte]1
      StartMode = "Automatic"
      DesktopInteract = $false
      StartName = $StartName
      StartPassword = ""
    } -ErrorAction Stop
  } else {
    $Result = Invoke-CimMethod -InputObject $Existing -MethodName Change -Arguments @{
      DisplayName = $DisplayName
      PathName = $BinaryPathName
      ServiceType = [byte]16
      ErrorControl = [byte]1
      StartMode = "Automatic"
      DesktopInteract = $false
      StartName = $StartName
      StartPassword = ""
    } -ErrorAction Stop
  }
  if ([int]$Result.ReturnValue -ne 0) {
    throw "Windows service configuration failed with Win32 error $($Result.ReturnValue)."
  }

  $RegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
  if (-not (Test-Path -LiteralPath $RegistryPath)) {
    throw "Windows service registry key is missing after configuration."
  }
  New-ItemProperty -LiteralPath $RegistryPath -Name DelayedAutostart -PropertyType DWord -Value ($(if ($DelayedAutoStart) { 1 } else { 0 })) -Force | Out-Null

  $Verified = Get-CitadelServiceCim $Name
  if ($null -eq $Verified) { throw "Windows service disappeared after configuration." }
  if ([string]$Verified.PathName -ne $BinaryPathName) {
    throw "Windows service ImagePath verification failed."
  }
  if ([string]$Verified.StartMode -ne "Auto") {
    throw "Windows service StartMode verification failed."
  }
  if ([string]$Verified.StartName -ne $StartName) {
    throw "Windows service account verification failed."
  }
  $DelayedValue = (Get-ItemProperty -LiteralPath $RegistryPath -Name DelayedAutostart -ErrorAction Stop).DelayedAutostart
  if ([int]$DelayedValue -ne $(if ($DelayedAutoStart) { 1 } else { 0 })) {
    throw "Windows service delayed-start verification failed."
  }
  return $Verified
}

function Restore-CitadelServiceDefinition {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][hashtable]$Snapshot
  )
  Assert-CitadelServiceName $Name
  $Existing = Get-CitadelServiceCim $Name
  if ($null -eq $Existing) { throw "Cannot restore a missing Windows service." }

  $RestoreStartMode = [string]$Snapshot.StartMode
  if ($RestoreStartMode -eq "Auto") { $RestoreStartMode = "Automatic" }
  $Result = Invoke-CimMethod -InputObject $Existing -MethodName Change -Arguments @{
    DisplayName = [string]$Snapshot.DisplayName
    PathName = [string]$Snapshot.PathName
    StartMode = $RestoreStartMode
    StartName = [string]$Snapshot.StartName
    StartPassword = ""
  } -ErrorAction Stop
  if ([int]$Result.ReturnValue -ne 0) {
    throw "Windows service rollback failed with Win32 error $($Result.ReturnValue)."
  }

  $RegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
  New-ItemProperty -LiteralPath $RegistryPath -Name DelayedAutostart -PropertyType DWord -Value ([int]$Snapshot.DelayedAutostart) -Force | Out-Null
}

function Remove-CitadelServiceDefinition {
  param([Parameter(Mandatory = $true)][string]$Name)
  $Existing = Get-CitadelServiceCim $Name
  if ($null -eq $Existing) { return }
  $Result = Invoke-CimMethod -InputObject $Existing -MethodName Delete -ErrorAction Stop
  if ([int]$Result.ReturnValue -ne 0) {
    throw "Unable to delete Windows service; Win32 error $($Result.ReturnValue)."
  }
}

function Set-CitadelServiceRecovery {
  param([Parameter(Mandatory = $true)][string]$Name)
  Assert-CitadelServiceName $Name
  $Sc = Join-Path $env:WINDIR "System32\sc.exe"
  & $Sc description $Name "CITADEL/EWS bounded Core Agent service" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to set CITADEL service description." }
  & $Sc failure $Name reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to configure CITADEL service recovery." }
}
