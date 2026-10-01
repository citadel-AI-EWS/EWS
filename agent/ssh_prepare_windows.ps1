[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SshUser,
  [Parameter(Mandatory = $true)][string]$ReleaseRoot,
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [switch]$InstallOpenSsh,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-IsAdministrator {
  $Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
  return $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-SshBootstrapState {
  param(
    [Parameter(Mandatory = $true)][bool]$Configured,
    [Parameter(Mandatory = $true)][string]$Status,
    [string]$User = ""
  )
  $Dir = Join-Path $StateRoot "ssh-bootstrap"
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  $Payload = [ordered]@{
    schema = "citadel.ssh-bootstrap.v1"
    platform = "windows"
    configured = $Configured
    status = $Status
    user = $User
    config_path = "$env:ProgramData\ssh\sshd_config"
    updated_at = [DateTime]::UtcNow.ToString("o")
    private_keys_stored = $false
    public_port_opened = $false
  } | ConvertTo-Json
  $Temp = Join-Path $Dir "state.json.new"
  $Final = Join-Path $Dir "state.json"
  [System.IO.File]::WriteAllText($Temp, $Payload + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $Temp -Destination $Final -Force
}

if (-not (Test-IsAdministrator)) {
  throw "CITADEL SSH bootstrap requires an elevated Administrator session."
}
if ($SshUser -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
  throw "Unsafe SSH user name."
}

$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
foreach ($Path in @($ReleaseRoot, $StateRoot)) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path.Contains('"')) {
    throw "Unsafe CITADEL SSH bootstrap path."
  }
}

$Python = Join-Path $ReleaseRoot ".venv\Scripts\python.exe"
$Configurator = Join-Path $ReleaseRoot "ssh_configurator.py"
$Console = Join-Path $ReleaseRoot "ssh_restricted_console.py"
$AgentConfig = Join-Path $ReleaseRoot "config.json"
foreach ($Required in @($Python, $Configurator, $Console, $AgentConfig)) {
  if (-not (Test-Path -LiteralPath $Required)) {
    throw "Required CITADEL SSH bootstrap asset is missing: $Required"
  }
}

$OpenSshRoot = Join-Path $env:WINDIR "System32\OpenSSH"
$Sshd = Join-Path $OpenSshRoot "sshd.exe"
$SshKeygen = Join-Path $OpenSshRoot "ssh-keygen.exe"
$DefaultConfig = Join-Path $OpenSshRoot "sshd_config_default"
$SshConfigDir = Join-Path $env:ProgramData "ssh"
$SshConfig = Join-Path $SshConfigDir "sshd_config"
$BackupDir = Join-Path $StateRoot "ssh-bootstrap"
$OriginalBackup = Join-Path $BackupDir "sshd_config.original"
$WorkingConfig = Join-Path $BackupDir "sshd_config.citadel.new"
$PreChange = Join-Path $BackupDir "sshd_config.prechange"

if ($Uninstall) {
  if (Test-Path -LiteralPath $OriginalBackup) {
    if (-not (Test-Path -LiteralPath $Sshd)) {
      throw "OpenSSH sshd.exe is missing; cannot validate SSH rollback."
    }
    Copy-Item -LiteralPath $OriginalBackup -Destination $WorkingConfig -Force
    & $Sshd -t -f $WorkingConfig
    if ($LASTEXITCODE -ne 0) {
      throw "Original sshd_config backup does not validate; refusing rollback."
    }
    $Service = Get-Service -Name sshd -ErrorAction SilentlyContinue
    if ($null -ne $Service -and $Service.Status -eq "Running") {
      Stop-Service -Name sshd -Force -ErrorAction Stop
    }
    Copy-Item -LiteralPath $WorkingConfig -Destination $SshConfig -Force
    if ($null -ne $Service) {
      Start-Service -Name sshd -ErrorAction Stop
    }
  }
  Write-SshBootstrapState -Configured $false -Status "removed" -User $SshUser
  Write-Host "[CITADEL] Restricted SSH bootstrap removed."
  exit 0
}

if (-not (Test-Path -LiteralPath $Sshd)) {
  if (-not $InstallOpenSsh) {
    Write-SshBootstrapState -Configured $false -Status "openssh_server_missing" -User $SshUser
    throw "Windows OpenSSH Server is not installed. Re-run with -InstallOpenSsh to add the Windows capability."
  }
  $Capability = Get-WindowsCapability -Online -Name "OpenSSH.Server*" | Sort-Object Name | Select-Object -First 1
  if ($null -eq $Capability) {
    Write-SshBootstrapState -Configured $false -Status "openssh_capability_unavailable" -User $SshUser
    throw "Windows OpenSSH Server capability is unavailable on this system."
  }
  if ([string]$Capability.State -ne "Installed") {
    Add-WindowsCapability -Online -Name ([string]$Capability.Name) | Out-Null
  }
}
if (-not (Test-Path -LiteralPath $Sshd)) {
  Write-SshBootstrapState -Configured $false -Status "openssh_install_failed" -User $SshUser
  throw "OpenSSH Server installation did not provide sshd.exe."
}
if (-not (Test-Path -LiteralPath $SshKeygen)) {
  throw "OpenSSH ssh-keygen.exe is missing."
}

New-Item -ItemType Directory -Path $SshConfigDir -Force | Out-Null
$HostKeys = @(Get-ChildItem -LiteralPath $SshConfigDir -Filter "ssh_host_*_key" -File -ErrorAction SilentlyContinue)
if ($HostKeys.Count -eq 0) {
  & $SshKeygen -A
  if ($LASTEXITCODE -ne 0) {
    Write-SshBootstrapState -Configured $false -Status "host_key_generation_failed" -User $SshUser
    throw "OpenSSH host key generation failed."
  }
}

$LocalUser = Get-LocalUser -Name $SshUser -ErrorAction SilentlyContinue
if ($null -eq $LocalUser) {
  Write-SshBootstrapState -Configured $false -Status "ssh_user_missing" -User $SshUser
  throw "SSH user '$SshUser' does not exist as a local Windows account. CITADEL will not create password-bearing accounts automatically."
}

New-Item -ItemType Directory -Path $SshConfigDir -Force | Out-Null
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $SshConfig)) {
  if (-not (Test-Path -LiteralPath $DefaultConfig)) {
    throw "OpenSSH default sshd_config is missing."
  }
  Copy-Item -LiteralPath $DefaultConfig -Destination $SshConfig -Force
}
if (-not (Test-Path -LiteralPath $OriginalBackup)) {
  Copy-Item -LiteralPath $SshConfig -Destination $OriginalBackup -Force
}

$RenderArgs = @(
  $Configurator, "render",
  "--input", $SshConfig,
  "--output", $WorkingConfig,
  "--user", $SshUser,
  "--python", $Python,
  "--console", $Console,
  "--agent-config", $AgentConfig
)
& $Python @RenderArgs
if ($LASTEXITCODE -ne 0) {
  throw "CITADEL SSH configurator failed."
}

& $Sshd -t -f $WorkingConfig
if ($LASTEXITCODE -ne 0) {
  Write-SshBootstrapState -Configured $false -Status "sshd_config_validation_failed" -User $SshUser
  throw "Rendered sshd_config failed sshd -t validation."
}

Copy-Item -LiteralPath $SshConfig -Destination $PreChange -Force
$Service = Get-Service -Name sshd -ErrorAction SilentlyContinue
if ($null -eq $Service) {
  throw "Windows sshd service is missing after OpenSSH Server installation."
}
$WasRunning = $Service.Status -eq "Running"
if ($WasRunning) {
  Stop-Service -Name sshd -Force -ErrorAction Stop
}

try {
  Copy-Item -LiteralPath $WorkingConfig -Destination $SshConfig -Force
  & $Sshd -t -f $SshConfig
  if ($LASTEXITCODE -ne 0) {
    throw "Installed sshd_config failed validation."
  }
  Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
  Start-Service -Name sshd -ErrorAction Stop
  Start-Sleep -Milliseconds 700

  $Listeners = @(Get-NetTCPConnection -State Listen -LocalPort 22 -ErrorAction Stop | Select-Object -ExpandProperty LocalAddress -Unique)
  if ($Listeners.Count -lt 1) {
    throw "sshd did not create a listener on port 22."
  }
  foreach ($Address in $Listeners) {
    if ($Address -notin @("127.0.0.1", "::1")) {
      throw "sshd exposed a non-loopback listener: $Address"
    }
  }
} catch {
  Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $PreChange -Destination $SshConfig -Force
  & $Sshd -t -f $SshConfig *> $null
  if ($LASTEXITCODE -eq 0 -and $WasRunning) {
    Start-Service -Name sshd -ErrorAction SilentlyContinue
  }
  Write-SshBootstrapState -Configured $false -Status "rollback_after_verification_failure" -User $SshUser
  throw
}

& $Python $Configurator inspect --input $SshConfig --user $SshUser | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "CITADEL SSH config inspection failed after install."
}

Write-SshBootstrapState -Configured $true -Status "ready" -User $SshUser
Write-Host "[CITADEL] Restricted SSH is ready on loopback port 22 for user '$SshUser'."
Write-Host "[CITADEL] No inbound firewall rule was created and no SSH private key/password was stored."
