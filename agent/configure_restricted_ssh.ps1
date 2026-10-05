[CmdletBinding()]
param(
  [string]$InstallRoot = "$env:ProgramData\CitadelEWS\agent",
  [string]$StateRoot = "$env:ProgramData\CitadelEWS\state",
  [string]$SshUser = "",
  [string]$CloudflareCaPublicKey = "",
  [switch]$ForceLoopback,
  [switch]$SkipCloudflared,
  [switch]$ManagedAdmin,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-IsAdministrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
  return $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OptionalProperty($Object, [string]$Name, $DefaultValue = $null) {
  if ($null -eq $Object) { return $DefaultValue }
  $Property = $Object.PSObject.Properties[$Name]
  if ($null -eq $Property) { return $DefaultValue }
  return $Property.Value
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

function Test-TrustedWinGetExecutable([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  try {
    $FullPath = [System.IO.Path]::GetFullPath($Path)
    $WindowsAppsRoot = [System.IO.Path]::GetFullPath((Join-Path $env:ProgramFiles "WindowsApps")).TrimEnd('\') + '\'
    if (-not (($FullPath + '\').StartsWith($WindowsAppsRoot, [System.StringComparison]::OrdinalIgnoreCase))) {
      return $false
    }
    $Signature = Get-AuthenticodeSignature -FilePath $FullPath
    if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $Signature.SignerCertificate) {
      return $false
    }
    $Subject = [string]$Signature.SignerCertificate.Subject
    if ($Subject -notmatch '(?i)(^|[,= ])Microsoft Corporation([, =]|$)') {
      return $false
    }
    & $FullPath --version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Find-WinGet {
  $Packages = @(
    Get-AppxPackage -AllUsers -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue |
      Sort-Object Version -Descending
  )
  foreach ($Package in $Packages) {
    $InstallLocation = [string]$Package.InstallLocation
    if ([string]::IsNullOrWhiteSpace($InstallLocation)) { continue }
    $Candidate = Join-Path $InstallLocation "winget.exe"
    if (Test-TrustedWinGetExecutable -Path $Candidate) { return $Candidate }
  }
  return $null
}

function Test-WinGetExecutable([string]$Path) {
  return Test-TrustedWinGetExecutable -Path $Path
}

function Ensure-WinGet {
  $Existing = Find-WinGet
  if ($null -ne $Existing -and (Test-WinGetExecutable -Path $Existing)) { return $Existing }

  Write-Host "[CITADEL] WinGet is unavailable; checking Microsoft App Installer registration..."
  try {
    $AppInstaller = Get-AppxPackage -Name Microsoft.DesktopAppInstaller -ErrorAction SilentlyContinue |
      Sort-Object Version -Descending |
      Select-Object -First 1
    if ($null -ne $AppInstaller) {
      Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop
      Start-Sleep -Seconds 2
      $Existing = Find-WinGet
      if ($null -ne $Existing -and (Test-WinGetExecutable -Path $Existing)) { return $Existing }
    }
  } catch {
    Write-Verbose ("App Installer re-registration did not restore WinGet: " + $_.Exception.Message)
  }

  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $Gallery = Get-PSRepository -Name PSGallery -ErrorAction Stop
  if (-not ([string]$Gallery.SourceLocation).StartsWith("https://www.powershellgallery.com/", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "PSGallery points to an unexpected source."
  }
  Install-PackageProvider -Name NuGet -Force | Out-Null
  Install-Module -Name Microsoft.WinGet.Client -Force -Repository PSGallery -Scope AllUsers -AllowClobber | Out-Null
  Import-Module Microsoft.WinGet.Client -Force
  Repair-WinGetPackageManager -Force -Latest | Out-Null
  Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $Existing = Find-WinGet
  if ($null -eq $Existing -or -not (Test-WinGetExecutable -Path $Existing)) {
    throw "Windows Package Manager recovery failed."
  }
  return $Existing
}

function Test-TrustedCloudflaredExecutable([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }
  $FullPath = [System.IO.Path]::GetFullPath($Path)
  $Roots = @(
    [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  $UnderProtectedRoot = $false
  foreach ($Root in $Roots) {
    $RootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (($FullPath + '\').StartsWith($RootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
      $UnderProtectedRoot = $true
      break
    }
  }
  if (-not $UnderProtectedRoot) { return $false }

  $Signature = Get-AuthenticodeSignature -FilePath $FullPath
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $Signature.SignerCertificate) {
    return $false
  }
  $Subject = [string]$Signature.SignerCertificate.Subject
  return $Subject -match '(?i)(^|[,= ])Cloudflare([, =]|$)'
}

function Find-Cloudflared {
  $Candidates = @()
  $ProgramFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  if (-not [string]::IsNullOrWhiteSpace($ProgramFiles)) {
    $Candidates += (Join-Path $ProgramFiles "cloudflared\cloudflared.exe")
  }
  $ProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
  if (-not [string]::IsNullOrWhiteSpace($ProgramFilesX86)) {
    $Candidates += (Join-Path $ProgramFilesX86 "cloudflared\cloudflared.exe")
  }
  foreach ($Candidate in $Candidates) {
    if (Test-TrustedCloudflaredExecutable -Path $Candidate) { return $Candidate }
  }
  return $null
}

function Ensure-Cloudflared {
  $Existing = Find-Cloudflared
  if ($null -ne $Existing) { return $Existing }
  $Winget = Ensure-WinGet
  Write-Host "[CITADEL] Installing Cloudflare cloudflared through WinGet..."
  & $Winget install --id Cloudflare.cloudflared --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "cloudflared WinGet installation failed." }
  $Installed = Find-Cloudflared
  if ($null -eq $Installed) {
    throw "cloudflared was installed but no Authenticode-valid Cloudflare executable was found under protected Program Files paths."
  }
  return $Installed
}

function Read-SecretPlainText([string]$Prompt) {
  $Secure = Read-Host $Prompt -AsSecureString
  if ($null -eq $Secure -or $Secure.Length -lt 20) { throw "Tunnel token is missing or unexpectedly short." }
  $Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
    $Secure.Dispose()
  }
}

function Require-SafeUsername([string]$Value) {
  $Name = $Value.Trim()
  if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$') {
    throw "SSH username must be 1-20 characters: letters, digits, dot, underscore or hyphen."
  }
  $Reserved = @("administrator", "guest", "defaultaccount", "wdagutilityaccount", "system", "localservice", "networkservice")
  if ($Reserved -contains $Name.ToLowerInvariant()) {
    throw "Built-in Windows accounts are not allowed for CITADEL SSH."
  }
  return $Name
}

function Require-CloudflareCaKey([string]$Value) {
  $Key = $Value.Trim()
  if ($Key.Length -lt 40 -or $Key.Length -gt 8192 -or $Key.Contains([char]10) -or $Key.Contains([char]13)) {
    throw "Cloudflare SSH CA public key must be one non-empty line."
  }
  if ($Key -notmatch '^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa)\s+[A-Za-z0-9+/=]+(?:\s+.*)?$') {
    throw "Cloudflare SSH CA public key format is not recognized."
  }
  return $Key
}

function Resolve-AgentLayout([string]$Root, [string]$StateRootValue) {
  $Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  $StateRootValue = [System.IO.Path]::GetFullPath($StateRootValue).TrimEnd('\')
  $ProgramData = [System.IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\')
  foreach ($PathValue in @($Root, $StateRootValue)) {
    if ([string]::Equals($PathValue, $ProgramData, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ($PathValue + '\').StartsWith($ProgramData + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "CITADEL SSH paths must be strict descendants of ProgramData."
    }
  }
  $RootPrefix = $Root + '\'
  $StatePrefix = $StateRootValue + '\'
  if ([string]::Equals($Root, $StateRootValue, [System.StringComparison]::OrdinalIgnoreCase) -or
      $RootPrefix.StartsWith($StatePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      $StatePrefix.StartsWith($RootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallRoot and StateRoot must be separate, non-overlapping ProgramData directories."
  }

  $InstallStatePath = Join-Path $Root "install-state.json"
  if (Test-Path -LiteralPath $InstallStatePath) {
    $State = Get-Content -LiteralPath $InstallStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ReleaseRoot = [System.IO.Path]::GetFullPath([string]$State.release_root).TrimEnd('\')
    $ReleasesRoot = [System.IO.Path]::GetFullPath((Join-Path $Root "releases")).TrimEnd('\') + '\'
    if (-not ($ReleaseRoot + '\').StartsWith($ReleasesRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Active CITADEL release path is outside the managed releases directory."
    }
    if (-not (Test-Path -LiteralPath $ReleaseRoot)) { throw "Active CITADEL release directory is missing." }
    $ConfigPath = Join-Path $ReleaseRoot "config.json"
    $Layout = "managed_release"
  } else {
    foreach ($Required in @("citadel_node_v2.py", "CitadelSshConsole.cs", "configure_restricted_ssh.ps1")) {
      if (-not (Test-Path -LiteralPath (Join-Path $Root $Required))) {
        throw "CITADEL flat one-click layout is incomplete: $Required is missing."
      }
    }
    $ReleaseRoot = $Root
    $ConfigPath = Join-Path $StateRootValue "config.json"
    $Layout = "flat_oneclick"
  }
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Active CITADEL config.json is missing." }
  return @{
    InstallRoot = $Root
    StateRoot = $StateRootValue
    ReleaseRoot = $ReleaseRoot
    ConfigPath = $ConfigPath
    Layout = $Layout
  }
}

function Get-AdministratorsGroupName {
  $Sid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
  $Account = $Sid.Translate([System.Security.Principal.NTAccount]).Value
  return ($Account -split '\\')[-1]
}

function Test-UserInLocalGroup([Microsoft.PowerShell.Commands.LocalUser]$User, [string]$GroupName) {
  foreach ($Member in @(Get-LocalGroupMember -Group $GroupName -ErrorAction Stop)) {
    if ($null -ne $Member.SID -and $Member.SID.Value -eq $User.SID.Value) { return $true }
  }
  return $false
}

function Ensure-CitadelSshUser([string]$Name, [bool]$ManagedAdmin, $PriorState) {
  $Existing = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
  $Created = $false
  if ($null -eq $Existing) {
    $Bytes = New-Object byte[] 48
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
    $RandomPassword = [Convert]::ToBase64String($Bytes) + "!aA1"
    $SecurePassword = ConvertTo-SecureString $RandomPassword -AsPlainText -Force
    $Description = if ($ManagedAdmin) { "CITADEL managed SSH administrator" } else { "CITADEL restricted SSH account" }
    New-LocalUser -Name $Name -Password $SecurePassword -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description $Description | Out-Null
    $Existing = Get-LocalUser -Name $Name -ErrorAction Stop
    $Created = $true
  }
  if (-not $Existing.Enabled) { Enable-LocalUser -Name $Name }

  $AdminGroup = Get-AdministratorsGroupName
  $IsAdmin = Test-UserInLocalGroup -User $Existing -GroupName $AdminGroup
  if ($ManagedAdmin) {
    if (-not $Created) {
      $PriorUser = [string](Get-OptionalProperty -Object $PriorState -Name "ssh_user" -DefaultValue "")
      $PriorCreated = [bool](Get-OptionalProperty -Object $PriorState -Name "created_user" -DefaultValue $false)
      if (-not $PriorCreated -or $PriorUser -ne $Name) {
        throw "CITADEL refuses to elevate a pre-existing unmanaged local account."
      }
    }
    if (-not $IsAdmin) {
      Add-LocalGroupMember -Group $AdminGroup -Member $Existing.Name -ErrorAction Stop
      $IsAdmin = Test-UserInLocalGroup -User $Existing -GroupName $AdminGroup
    }
    if (-not $IsAdmin) { throw "CITADEL managed SSH user could not be added to the local Administrators group." }
  } elseif ($IsAdmin) {
    throw "CITADEL restricted SSH user must not be a member of the local Administrators group."
  }
  return @{ User = $Existing; Created = $Created; IsAdmin = $IsAdmin }
}

function Set-CitadelRelayKeyAcl([string]$Path, [string]$UserSid, [bool]$IncludeUser) {
  $Acl = New-Object System.Security.AccessControl.FileSecurity
  $Acl.SetAccessRuleProtection($true, $false)
  $Allow = [System.Security.AccessControl.AccessControlType]::Allow
  $Rules = @(
    @("S-1-5-18", [System.Security.AccessControl.FileSystemRights]::FullControl),
    @("S-1-5-32-544", [System.Security.AccessControl.FileSystemRights]::FullControl),
    @("S-1-5-19", [System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
  )
  if ($IncludeUser) {
    $Rules += ,@($UserSid, [System.Security.AccessControl.FileSystemRights]::Read)
  }
  foreach ($Rule in $Rules) {
    $Sid = New-Object System.Security.Principal.SecurityIdentifier($Rule[0])
    $Ace = New-Object System.Security.AccessControl.FileSystemAccessRule($Sid, $Rule[1], $Allow)
    [void]$Acl.AddAccessRule($Ace)
  }
  $Acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")))
  Set-Acl -LiteralPath $Path -AclObject $Acl
}

function Ensure-ManagedRelayKey([string]$PrivateKeyPath, [string]$PublicKeyPath, [string]$AuthorizedKeysPath, [string]$UserSid) {
  $SshKeygen = Join-Path $env:WINDIR "System32\OpenSSH\ssh-keygen.exe"
  if (-not (Test-Path -LiteralPath $SshKeygen)) { throw "Windows OpenSSH ssh-keygen.exe is missing." }
  if (-not (Test-Path -LiteralPath $PrivateKeyPath)) {
    & $SshKeygen -q -t ed25519 -N "" -f $PrivateKeyPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $PrivateKeyPath)) {
      throw "CITADEL managed SSH relay key generation failed."
    }
  }
  if (-not (Test-Path -LiteralPath $PublicKeyPath)) {
    $PublicKey = (& $SshKeygen -y -f $PrivateKeyPath | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$PublicKey)) {
      throw "CITADEL managed SSH public key recovery failed."
    }
    [System.IO.File]::WriteAllText($PublicKeyPath, ([string]$PublicKey).Trim() + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  }
  $AuthorizedKey = (Get-Content -LiteralPath $PublicKeyPath -Encoding UTF8 | Select-Object -First 1).Trim()
  if ($AuthorizedKey -notmatch '^ssh-ed25519\s+[A-Za-z0-9+/=]+(?:\s+.*)?$') {
    throw "CITADEL managed SSH relay public key is invalid."
  }
  [System.IO.File]::WriteAllText($AuthorizedKeysPath, $AuthorizedKey + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Set-CitadelRelayKeyAcl -Path $PrivateKeyPath -UserSid $UserSid -IncludeUser $false
  Set-CitadelRelayKeyAcl -Path $PublicKeyPath -UserSid $UserSid -IncludeUser $true
  Set-CitadelRelayKeyAcl -Path $AuthorizedKeysPath -UserSid $UserSid -IncludeUser $true
}

function Compile-RestrictedConsole([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { throw "CitadelSshConsole.cs is missing from the active package." }
  $Compiler = Find-FrameworkCompiler
  if ($null -eq $Compiler) { throw ".NET Framework C# compiler is required for the CITADEL SSH console." }
  $Temp = $Destination + ".new"
  Remove-Item -LiteralPath $Temp -Force -ErrorAction SilentlyContinue
  & $Compiler /nologo /optimize+ /target:exe "/out:$Temp" /reference:System.Management.dll /reference:System.ServiceProcess.dll $Source
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Temp)) {
    throw "CITADEL restricted SSH console compilation failed."
  }
  Move-Item -LiteralPath $Temp -Destination $Destination -Force
}

function Set-CitadelSshServiceState([string]$StartMode, [bool]$WasRunning) {
  $Service = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
  if ($null -eq $Service) { return }
  Stop-Service -Name "sshd" -Force -ErrorAction SilentlyContinue
  switch ($StartMode) {
    "Auto" { Set-Service -Name "sshd" -StartupType Automatic }
    "Automatic" { Set-Service -Name "sshd" -StartupType Automatic }
    "Disabled" { Set-Service -Name "sshd" -StartupType Disabled }
    default { Set-Service -Name "sshd" -StartupType Manual }
  }
  if ($WasRunning -and $StartMode -notin @("Disabled")) {
    Start-Service -Name "sshd"
  }
}

function Set-CitadelSshFirewallState([bool]$WasEnabled) {
  $Rule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
  if ($null -eq $Rule) { return }
  if ($WasEnabled) {
    Enable-NetFirewallRule -Name "OpenSSH-Server-In-TCP" | Out-Null
  } else {
    Disable-NetFirewallRule -Name "OpenSSH-Server-In-TCP" | Out-Null
  }
}

function Strip-CitadelBlocks([string]$Text) {
  $Result = [regex]::Replace(
    $Text,
    '(?ms)^# BEGIN CITADEL SSH GLOBAL\r?\n.*?^# END CITADEL SSH GLOBAL\r?\n?',
    ''
  )
  $Result = [regex]::Replace(
    $Result,
    '(?ms)^# BEGIN CITADEL SSH USER\r?\n.*?^# END CITADEL SSH USER\r?\n?',
    ''
  )
  return $Result.Trim()
}

if (-not (Test-IsAdministrator)) {
  if (-not [string]::IsNullOrWhiteSpace($SshUser) -or -not [string]::IsNullOrWhiteSpace($CloudflareCaPublicKey)) {
    throw "Run this script from an Administrator PowerShell when passing SSH parameters."
  }
  $Args = @(
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", ('"' + $PSCommandPath + '"'),
    "-InstallRoot", ('"' + $InstallRoot + '"'),
    "-StateRoot", ('"' + $StateRoot + '"')
  )
  if ($ForceLoopback) { $Args += "-ForceLoopback" }
  if ($SkipCloudflared) { $Args += "-SkipCloudflared" }
  if ($ManagedAdmin) { $Args += "-ManagedAdmin" }
  if ($Uninstall) { $Args += "-Uninstall" }
  $Elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $Args -Wait -PassThru
  exit $Elevated.ExitCode
}

$SshStateRoot = Join-Path $env:ProgramData "CitadelEWS\ssh"
$StatePath = Join-Path $SshStateRoot "bootstrap-state.json"
$ConsoleExe = Join-Path $SshStateRoot "CitadelSshConsole.exe"
$CaPath = Join-Path $env:ProgramData "ssh\citadel_cloudflare_ca.pub"
$RelayPrivateKeyPath = Join-Path $SshStateRoot "relay_ed25519"
$RelayPublicKeyPath = Join-Path $SshStateRoot "relay_ed25519.pub"
$RelayAuthorizedKeysPath = Join-Path $SshStateRoot "relay_authorized_keys"
$SshdConfig = Join-Path $env:ProgramData "ssh\sshd_config"
$SshdExe = Join-Path $env:WINDIR "System32\OpenSSH\sshd.exe"

if ($Uninstall) {
  if (-not (Test-Path -LiteralPath $StatePath)) {
    Write-Host "[CITADEL] Restricted SSH bootstrap state is not present. Nothing to remove."
    exit 0
  }
  $State = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
  if ($State.backup_path -and (Test-Path -LiteralPath ([string]$State.backup_path))) {
    Copy-Item -LiteralPath ([string]$State.backup_path) -Destination $SshdConfig -Force
  }
  if ($State.created_user -eq $true -and $State.ssh_user) {
    Remove-LocalUser -Name ([string]$State.ssh_user) -ErrorAction SilentlyContinue
  }
  if ((Get-OptionalProperty -Object $State -Name "cloudflared_service_created_by_citadel" -DefaultValue $false) -eq $true) {
    $Cloudflared = Find-Cloudflared
    if ($null -ne $Cloudflared) {
      & $Cloudflared service uninstall *> $null
    }
    Stop-Service -Name cloudflared -Force -ErrorAction SilentlyContinue
    & (Join-Path $env:WINDIR "System32\sc.exe") delete cloudflared *> $null
  }
  $RestoreFirewall = [bool]($State.firewall_rule_was_enabled_before -eq $true)
  Set-CitadelSshFirewallState -WasEnabled $RestoreFirewall
  $RestoreStartMode = if ($State.service_start_mode_before) { [string]$State.service_start_mode_before } else { "Manual" }
  $RestoreRunning = [bool]($State.service_was_running_before -eq $true)
  Set-CitadelSshServiceState -StartMode $RestoreStartMode -WasRunning $RestoreRunning
  foreach ($Path in @($ConsoleExe, $CaPath, $RelayPrivateKeyPath, $RelayPublicKeyPath, $RelayAuthorizedKeysPath, (Join-Path $SshStateRoot "controller-url.txt"), $StatePath)) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
  Write-Host "[CITADEL] Restricted SSH configuration removed. OpenSSH itself was left installed."
  exit 0
}

$Resolved = Resolve-AgentLayout -Root $InstallRoot -StateRootValue $StateRoot
$InstallRoot = $Resolved.InstallRoot
$StateRoot = $Resolved.StateRoot
$ReleaseRoot = $Resolved.ReleaseRoot
$ConfigPath = $Resolved.ConfigPath
$AgentLayout = $Resolved.Layout

if ($ManagedAdmin) {
  if ([string]::IsNullOrWhiteSpace($SshUser)) { $SshUser = "citadel-admin" }
  $SshUser = Require-SafeUsername $SshUser
  if (-not [string]::IsNullOrWhiteSpace($CloudflareCaPublicKey)) {
    $CloudflareCaPublicKey = Require-CloudflareCaKey $CloudflareCaPublicKey
  }
} else {
  if ([string]::IsNullOrWhiteSpace($SshUser)) {
    $SshUser = Read-Host "Cloudflare Access SSH username (normally your email prefix)"
  }
  $SshUser = Require-SafeUsername $SshUser
  if ([string]::IsNullOrWhiteSpace($CloudflareCaPublicKey)) {
    $CloudflareCaPublicKey = Read-Host "Paste the Cloudflare SSH CA PUBLIC key"
  }
  $CloudflareCaPublicKey = Require-CloudflareCaKey $CloudflareCaPublicKey
}

$Capability = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
$OpenSshWasInstalled = $Capability.State -eq "Installed"
$ExistingBootstrap = Test-Path -LiteralPath $StatePath
$PriorBootstrapState = if ($ExistingBootstrap) { Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$PriorCloudflaredCreated = [bool](Get-OptionalProperty -Object $PriorBootstrapState -Name "cloudflared_service_created_by_citadel" -DefaultValue $false)
$PriorCloudflaredPreexisted = [bool](Get-OptionalProperty -Object $PriorBootstrapState -Name "cloudflared_service_preexisted" -DefaultValue $false)

$ServiceStartModeBefore = "Manual"
$ServiceWasRunningBefore = $false
$FirewallWasEnabledBefore = $false
if ($null -ne $PriorBootstrapState) {
  if ($PriorBootstrapState.service_start_mode_before) { $ServiceStartModeBefore = [string]$PriorBootstrapState.service_start_mode_before }
  $ServiceWasRunningBefore = [bool]($PriorBootstrapState.service_was_running_before -eq $true)
  $FirewallWasEnabledBefore = [bool]($PriorBootstrapState.firewall_rule_was_enabled_before -eq $true)
} elseif ($OpenSshWasInstalled) {
  $BeforeService = Get-CimInstance Win32_Service -Filter "Name='sshd'" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $BeforeService) {
    $ServiceStartModeBefore = [string]$BeforeService.StartMode
    $ServiceWasRunningBefore = [string]$BeforeService.State -eq "Running"
  }
  $BeforeFirewall = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
  $FirewallWasEnabledBefore = $null -ne $BeforeFirewall -and [string]$BeforeFirewall.Enabled -eq "True"
}
if ($OpenSshWasInstalled -and -not $ExistingBootstrap -and -not $ForceLoopback) {
  throw "OpenSSH Server already existed before CITADEL. Re-run with -ForceLoopback only if you accept restricting it to localhost."
}
if (-not $OpenSshWasInstalled) {
  Write-Host "[CITADEL] Installing Microsoft OpenSSH Server..."
  $InstallResult = Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
  if ($InstallResult.RestartNeeded -eq $true) {
    throw "OpenSSH installation requires a reboot before CITADEL can configure it."
  }
}

if (-not (Test-Path -LiteralPath $SshdExe)) { throw "Windows OpenSSH sshd.exe is missing after installation." }
if (-not (Test-Path -LiteralPath $SshdConfig)) {
  # Windows OpenSSH creates the default sshd_config and host keys on first service start.
  Start-Service -Name sshd -ErrorAction Stop
  Start-Sleep -Milliseconds 750
}
Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $SshdConfig)) {
  throw "Windows OpenSSH did not generate sshd_config on first service start."
}

New-Item -ItemType Directory -Force -Path $SshStateRoot | Out-Null
$UserState = Ensure-CitadelSshUser -Name $SshUser -ManagedAdmin ([bool]$ManagedAdmin) -PriorState $PriorBootstrapState
$User = $UserState.User
$CreatedUser = [bool]$UserState.Created

if (-not $ManagedAdmin) {
  $ConsoleSource = Join-Path $ReleaseRoot "CitadelSshConsole.cs"
  Compile-RestrictedConsole -Source $ConsoleSource -Destination $ConsoleExe
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ControllerUrl = [string]$Config.controller_url
if ([string]::IsNullOrWhiteSpace($ControllerUrl)) { throw "Active CITADEL controller_url is missing." }
[System.IO.File]::WriteAllText((Join-Path $SshStateRoot "controller-url.txt"), $ControllerUrl.Trim() + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
if (-not [string]::IsNullOrWhiteSpace($CloudflareCaPublicKey)) {
  [System.IO.File]::WriteAllText($CaPath, $CloudflareCaPublicKey + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
} elseif ($ManagedAdmin) {
  Remove-Item -LiteralPath $CaPath -Force -ErrorAction SilentlyContinue
}

$Acl = Get-Acl -LiteralPath $SshStateRoot
$Acl.SetAccessRuleProtection($true, $false)
foreach ($ExistingRule in @($Acl.Access)) { [void]$Acl.RemoveAccessRuleAll($ExistingRule) }
$Inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$Propagation = [System.Security.AccessControl.PropagationFlags]::None
$Allow = [System.Security.AccessControl.AccessControlType]::Allow
$DirectoryRules = @(
  @("S-1-5-18", [System.Security.AccessControl.FileSystemRights]::FullControl),
  @("S-1-5-32-544", [System.Security.AccessControl.FileSystemRights]::FullControl),
  @($User.SID.Value, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
)
if ($ManagedAdmin) {
  $DirectoryRules += ,@("S-1-5-19", [System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
}
foreach ($Rule in $DirectoryRules) {
  $Sid = New-Object System.Security.Principal.SecurityIdentifier($Rule[0])
  $Ace = New-Object System.Security.AccessControl.FileSystemAccessRule($Sid, $Rule[1], $Inheritance, $Propagation, $Allow)
  [void]$Acl.AddAccessRule($Ace)
}
Set-Acl -LiteralPath $SshStateRoot -AclObject $Acl

if ($ManagedAdmin) {
  Ensure-ManagedRelayKey -PrivateKeyPath $RelayPrivateKeyPath -PublicKeyPath $RelayPublicKeyPath -AuthorizedKeysPath $RelayAuthorizedKeysPath -UserSid $User.SID.Value
}

if (-not (Test-Path -LiteralPath $SshdConfig)) { throw "OpenSSH sshd_config was not created." }
$Original = Get-Content -LiteralPath $SshdConfig -Raw -Encoding UTF8
$Clean = Strip-CitadelBlocks $Original
$ExternalAccessControl = [regex]::Matches(
  $Clean,
  '(?im)^\s*(AllowUsers|DenyUsers|AllowGroups|DenyGroups)\s+'
)
if ($ExternalAccessControl.Count -gt 0 -and -not $ExistingBootstrap) {
  throw "Existing OpenSSH user/group access-control directives detected. CITADEL refuses to rewrite them automatically; review sshd_config manually first."
}

if (-not $ExistingBootstrap) {
  $BackupPath = Join-Path $SshStateRoot ("sshd_config.before-citadel-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + ".bak")
  Copy-Item -LiteralPath $SshdConfig -Destination $BackupPath -Force
} else {
  $PriorState = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $BackupPath = [string]$PriorState.backup_path
  if ([string]::IsNullOrWhiteSpace($BackupPath) -or -not (Test-Path -LiteralPath $BackupPath)) {
    throw "Previous CITADEL SSH backup is missing; refusing to rewrite sshd_config."
  }
}

# ListenAddress can be repeated, so every pre-existing active listener is neutralized.
$Clean = [regex]::Replace(
  $Clean,
  '(?im)^(\s*ListenAddress\s+[^#\r\n]+)$',
  '# CITADEL disabled original listener: $1'
)

$TrustedCaLine = if (-not [string]::IsNullOrWhiteSpace($CloudflareCaPublicKey)) {
  "TrustedUserCAKeys C:/ProgramData/ssh/citadel_cloudflare_ca.pub"
} else { "" }
$GlobalBlock = @"
# BEGIN CITADEL SSH GLOBAL
ListenAddress 127.0.0.1
AllowUsers $SshUser
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
PermitEmptyPasswords no
AllowAgentForwarding no
AllowTcpForwarding no
GatewayPorts no
$TrustedCaLine
# END CITADEL SSH GLOBAL
"@

if ($ManagedAdmin) {
  $UserBlock = @"
# BEGIN CITADEL SSH USER
Match User $SshUser
    AuthorizedKeysFile C:/ProgramData/CitadelEWS/ssh/relay_authorized_keys
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    PermitTTY yes
    AllowTcpForwarding no
    GatewayPorts no
# END CITADEL SSH USER
"@
  # Put Match User before the stock Windows "Match Group administrators" block
  # so the dedicated per-user key file wins for this one CITADEL account.
  $NewConfig = $GlobalBlock.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $UserBlock.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $Clean.Trim() + [Environment]::NewLine
} else {
  $UserBlock = @"
# BEGIN CITADEL SSH USER
Match User $SshUser
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    ForceCommand C:/ProgramData/CitadelEWS/ssh/CitadelSshConsole.exe
    PermitTTY yes
    AllowTcpForwarding no
    GatewayPorts no
# END CITADEL SSH USER
"@
  $NewConfig = $GlobalBlock.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $Clean.Trim() + [Environment]::NewLine + [Environment]::NewLine + $UserBlock.TrimEnd() + [Environment]::NewLine
}
[System.IO.File]::WriteAllText($SshdConfig, $NewConfig, (New-Object System.Text.UTF8Encoding($false)))

& $SshdExe -t -f $SshdConfig
if ($LASTEXITCODE -ne 0) {
  Copy-Item -LiteralPath $BackupPath -Destination $SshdConfig -Force
  Set-CitadelSshFirewallState -WasEnabled $FirewallWasEnabledBefore
  Set-CitadelSshServiceState -StartMode $ServiceStartModeBefore -WasRunning $ServiceWasRunningBefore
  throw "OpenSSH rejected the CITADEL configuration; original sshd_config and service state were restored."
}

$FirewallRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if ($null -ne $FirewallRule) {
  Disable-NetFirewallRule -Name "OpenSSH-Server-In-TCP" | Out-Null
}

Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd
Start-Sleep -Seconds 1
$Listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction SilentlyContinue)
if ($Listeners.Count -eq 0) {
  throw "sshd started but no port 22 listener was detected."
}
$UnsafeListener = $Listeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") } | Select-Object -First 1
if ($null -ne $UnsafeListener) {
  Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $BackupPath -Destination $SshdConfig -Force
  Set-CitadelSshFirewallState -WasEnabled $FirewallWasEnabledBefore
  Set-CitadelSshServiceState -StartMode $ServiceStartModeBefore -WasRunning $ServiceWasRunningBefore
  throw "Unsafe non-loopback SSH listener detected; original sshd_config and service state were restored."
}

$State = [ordered]@{
  schema = "citadel.restricted-ssh-bootstrap.v1"
  ssh_user = $SshUser
  user_sid = $User.SID.Value
  created_user = $CreatedUser
  openssh_preexisted = $OpenSshWasInstalled
  agent_layout = $AgentLayout
  backup_path = $BackupPath
  service_start_mode_before = $ServiceStartModeBefore
  service_was_running_before = $ServiceWasRunningBefore
  firewall_rule_was_enabled_before = $FirewallWasEnabledBefore
  managed_admin = [bool]$ManagedAdmin
  force_command = $(if ($ManagedAdmin) { $null } else { "C:/ProgramData/CitadelEWS/ssh/CitadelSshConsole.exe" })
  relay_private_key_path = $(if ($ManagedAdmin) { $RelayPrivateKeyPath } else { $null })
  relay_authorized_keys_path = $(if ($ManagedAdmin) { $RelayAuthorizedKeysPath } else { $null })
  ca_public_key_path = $(if (Test-Path -LiteralPath $CaPath) { $CaPath } else { $null })
  cloudflared_service_created_by_citadel = $PriorCloudflaredCreated
  cloudflared_service_preexisted = $PriorCloudflaredPreexisted
  configured_at = (Get-Date).ToUniversalTime().ToString("o")
}
[System.IO.File]::WriteAllText($StatePath, (($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))

$CloudflaredReady = $false
if (-not $SkipCloudflared) {
  $CloudflaredService = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
  $PriorCreatedCloudflared = $ExistingBootstrap -and $PriorCloudflaredCreated

  if ($null -ne $CloudflaredService -and -not $PriorCreatedCloudflared) {
    throw "A pre-existing cloudflared Windows service is present. CITADEL will not overwrite an unknown tunnel service; re-run with -SkipCloudflared or review it manually."
  }

  $Cloudflared = Ensure-Cloudflared
  if ($null -eq $CloudflaredService) {
    $PlainTunnelToken = $null
    try {
      $PlainTunnelToken = Read-SecretPlainText "Paste the dedicated Cloudflare Tunnel token (input hidden)"
      Write-Host "[CITADEL] Installing the dedicated cloudflared Windows service. Tunnel token is not written to CITADEL state or logs."
      & $Cloudflared service install $PlainTunnelToken *> $null
      if ($LASTEXITCODE -ne 0) { throw "cloudflared service install failed." }
      $State.cloudflared_service_created_by_citadel = $true
      [System.IO.File]::WriteAllText($StatePath, (($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))
    } finally {
      $PlainTunnelToken = $null
    }
  } else {
    $State.cloudflared_service_created_by_citadel = $true
  }

  $CloudflaredService = Get-Service -Name cloudflared -ErrorAction Stop
  if ($CloudflaredService.Status -ne "Running") {
    Start-Service -Name cloudflared
    $CloudflaredService.WaitForStatus("Running", [TimeSpan]::FromSeconds(30))
  }
  $CloudflaredReady = (Get-Service -Name cloudflared -ErrorAction Stop).Status -eq "Running"
} else {
  $ExistingCloudflaredService = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
  $ExistingCloudflaredNow = $null -ne $ExistingCloudflaredService
  $PriorCreatedCloudflared = $ExistingBootstrap -and $PriorCloudflaredCreated
  $State.cloudflared_service_created_by_citadel = [bool]$PriorCreatedCloudflared
  $State.cloudflared_service_preexisted = [bool]($ExistingCloudflaredNow -and -not $PriorCreatedCloudflared)
  $CloudflaredReady = $ExistingCloudflaredNow -and $ExistingCloudflaredService.Status -eq "Running"
}

[System.IO.File]::WriteAllText($StatePath, (($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ("[CITADEL] " + $(if ($ManagedAdmin) { "Managed admin SSH bootstrap: READY" } else { "Restricted SSH bootstrap: READY" }))
Write-Host "[CITADEL] user=$SshUser"
Write-Host ("[CITADEL] local administrator=" + $(if ($ManagedAdmin) { "YES" } else { "NO" }))
Write-Host "[CITADEL] listener=127.0.0.1:22 only"
Write-Host "[CITADEL] password authentication for this user=disabled"
Write-Host "[CITADEL] forwarding/tunneling=disabled"
Write-Host ("[CITADEL] cloudflared=" + $(if ($CloudflaredReady) { "RUNNING" } else { "NOT CONFIGURED" }))
if ($CloudflaredReady) {
  Write-Host "[CITADEL] Local SSH origin + Cloudflare connector are ready. Save the public hostname/user in Hub and run SSH probe."
} else {
  Write-Host "[CITADEL] Cloudflare connector was skipped. Browser SSH stays NOT READY until cloudflared is configured."
}
