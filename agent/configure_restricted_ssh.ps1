[CmdletBinding()]
param(
  [string]$InstallRoot = "$env:ProgramData\CitadelEWS\agent",
  [string]$StateRoot = "$env:ProgramData\CitadelEWS\state",
  [string]$SshUser = "",
  [string]$CloudflareCaPublicKey = "",
  [switch]$ForceLoopback,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-IsAdministrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
  return $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
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

function Require-SafeUsername([string]$Value) {
  $Name = $Value.Trim()
  if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$') {
    throw "SSH username must be 1-32 characters: letters, digits, dot, underscore or hyphen."
  }
  $Reserved = @("administrator", "guest", "defaultaccount", "wdagutilityaccount", "system", "localservice", "networkservice")
  if ($Reserved -contains $Name.ToLowerInvariant()) {
    throw "Built-in or privileged Windows accounts are not allowed for CITADEL SSH."
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

function Ensure-NonPrivilegedUser([string]$Name) {
  $Existing = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
  $Created = $false
  if ($null -eq $Existing) {
    $Bytes = New-Object byte[] 48
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $Rng.GetBytes($Bytes) } finally { $Rng.Dispose() }
    $RandomPassword = [Convert]::ToBase64String($Bytes) + "!aA1"
    $SecurePassword = ConvertTo-SecureString $RandomPassword -AsPlainText -Force
    New-LocalUser -Name $Name -Password $SecurePassword -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description "CITADEL restricted SSH account" | Out-Null
    $Existing = Get-LocalUser -Name $Name -ErrorAction Stop
    $Created = $true
  }
  if (-not $Existing.Enabled) { Enable-LocalUser -Name $Name }

  $AdminGroup = Get-AdministratorsGroupName
  $AdminMembers = @(Get-LocalGroupMember -Group $AdminGroup -ErrorAction Stop)
  foreach ($Member in $AdminMembers) {
    if ($null -ne $Member.SID -and $Member.SID.Value -eq $Existing.SID.Value) {
      throw "CITADEL SSH user must not be a member of the local Administrators group."
    }
  }
  return @{ User = $Existing; Created = $Created }
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
    "-NoLogo", "-NoProfile", "-File", ('"' + $PSCommandPath + '"'),
    "-InstallRoot", ('"' + $InstallRoot + '"'),
    "-StateRoot", ('"' + $StateRoot + '"')
  )
  if ($ForceLoopback) { $Args += "-ForceLoopback" }
  if ($Uninstall) { $Args += "-Uninstall" }
  $Elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $Args -Wait -PassThru
  exit $Elevated.ExitCode
}

$SshStateRoot = Join-Path $env:ProgramData "CitadelEWS\ssh"
$StatePath = Join-Path $SshStateRoot "bootstrap-state.json"
$ConsoleExe = Join-Path $SshStateRoot "CitadelSshConsole.exe"
$CaPath = Join-Path $env:ProgramData "ssh\citadel_cloudflare_ca.pub"
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
  $RestoreFirewall = [bool]($State.firewall_rule_was_enabled_before -eq $true)
  Set-CitadelSshFirewallState -WasEnabled $RestoreFirewall
  $RestoreStartMode = if ($State.service_start_mode_before) { [string]$State.service_start_mode_before } else { "Manual" }
  $RestoreRunning = [bool]($State.service_was_running_before -eq $true)
  Set-CitadelSshServiceState -StartMode $RestoreStartMode -WasRunning $RestoreRunning
  foreach ($Path in @($ConsoleExe, $CaPath, (Join-Path $SshStateRoot "controller-url.txt"), $StatePath)) {
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

if ([string]::IsNullOrWhiteSpace($SshUser)) {
  $SshUser = Read-Host "Cloudflare Access SSH username (normally your email prefix)"
}
$SshUser = Require-SafeUsername $SshUser
if ([string]::IsNullOrWhiteSpace($CloudflareCaPublicKey)) {
  $CloudflareCaPublicKey = Read-Host "Paste the Cloudflare SSH CA PUBLIC key"
}
$CloudflareCaPublicKey = Require-CloudflareCaKey $CloudflareCaPublicKey

$Capability = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
$OpenSshWasInstalled = $Capability.State -eq "Installed"
$ExistingBootstrap = Test-Path -LiteralPath $StatePath
$PriorBootstrapState = if ($ExistingBootstrap) { Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }

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
Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $SshStateRoot | Out-Null
$UserState = Ensure-NonPrivilegedUser -Name $SshUser
$User = $UserState.User
$CreatedUser = [bool]$UserState.Created

$ConsoleSource = Join-Path $ReleaseRoot "CitadelSshConsole.cs"
Compile-RestrictedConsole -Source $ConsoleSource -Destination $ConsoleExe

$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ControllerUrl = [string]$Config.controller_url
if ([string]::IsNullOrWhiteSpace($ControllerUrl)) { throw "Active CITADEL controller_url is missing." }
[System.IO.File]::WriteAllText((Join-Path $SshStateRoot "controller-url.txt"), $ControllerUrl.Trim() + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText($CaPath, $CloudflareCaPublicKey + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))

$Acl = Get-Acl -LiteralPath $SshStateRoot
$Acl.SetAccessRuleProtection($true, $false)
foreach ($ExistingRule in @($Acl.Access)) { [void]$Acl.RemoveAccessRuleAll($ExistingRule) }
$Inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$Propagation = [System.Security.AccessControl.PropagationFlags]::None
$Allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($Rule in @(
  @("S-1-5-18", [System.Security.AccessControl.FileSystemRights]::FullControl),
  @("S-1-5-32-544", [System.Security.AccessControl.FileSystemRights]::FullControl),
  @($User.SID.Value, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute)
)) {
  $Sid = New-Object System.Security.Principal.SecurityIdentifier($Rule[0])
  $Ace = New-Object System.Security.AccessControl.FileSystemAccessRule($Sid, $Rule[1], $Inheritance, $Propagation, $Allow)
  [void]$Acl.AddAccessRule($Ace)
}
Set-Acl -LiteralPath $SshStateRoot -AclObject $Acl

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

$GlobalBlock = @"
# BEGIN CITADEL SSH GLOBAL
ListenAddress 127.0.0.1
AllowUsers $SshUser
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
AllowAgentForwarding no
AllowTcpForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
TrustedUserCAKeys C:/ProgramData/ssh/citadel_cloudflare_ca.pub
# END CITADEL SSH GLOBAL
"@

$UserBlock = @"
# BEGIN CITADEL SSH USER
Match User $SshUser
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    PasswordAuthentication no
    ForceCommand C:/ProgramData/CitadelEWS/ssh/CitadelSshConsole.exe
    PermitTTY yes
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    GatewayPorts no
# END CITADEL SSH USER
"@

$NewConfig = $GlobalBlock.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + $Clean.Trim() + [Environment]::NewLine + [Environment]::NewLine + $UserBlock.TrimEnd() + [Environment]::NewLine
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
  force_command = "C:/ProgramData/CitadelEWS/ssh/CitadelSshConsole.exe"
  ca_public_key_path = $CaPath
  configured_at = (Get-Date).ToUniversalTime().ToString("o")
}
[System.IO.File]::WriteAllText($StatePath, (($State | ConvertTo-Json -Depth 4) + [Environment]::NewLine), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[CITADEL] Restricted SSH bootstrap: READY"
Write-Host "[CITADEL] user=$SshUser"
Write-Host "[CITADEL] listener=127.0.0.1:22 only"
Write-Host "[CITADEL] password authentication for this user=disabled"
Write-Host "[CITADEL] forwarding/tunneling=disabled"
Write-Host "[CITADEL] Next external step: route a Cloudflare Tunnel public hostname to SSH localhost:22 and enable Browser SSH in Access."
