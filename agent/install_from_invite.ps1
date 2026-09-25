[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InviteToken,
  [string]$ControllerUrl = "https://citadel-ai.init1.workers.dev",
  [switch]$Install,
  [switch]$AuthorizeThisHost
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-SafeHttpsUrl {
  param([Parameter(Mandatory = $true)][string]$Url)
  $Uri = [System.Uri]$Url
  $Loopback = $Uri.Scheme -eq "http" -and @("127.0.0.1", "localhost", "::1") -contains $Uri.DnsSafeHost
  if ($Uri.Scheme -ne "https" -and -not $Loopback) {
    throw "Only HTTPS is allowed; loopback HTTP is test-only."
  }
  return $Uri
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

$ControllerUri = Assert-SafeHttpsUrl -Url $ControllerUrl
if ($InviteToken -notmatch '^citadel_deploy_[A-Za-z0-9_-]{32,}$') {
  throw "Invalid CITADEL deployment invitation token."
}

$Payload = @{
  token = $InviteToken
  hostname = [System.Net.Dns]::GetHostName()
  os_name = "Windows"
  os_version = [Environment]::OSVersion.VersionString
  architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
} | ConvertTo-Json -Compress

$RedeemUri = [System.Uri]::new($ControllerUri, "/api/v1/deployments/redeem")
$Response = Invoke-RestMethod -Method Post -Uri $RedeemUri -ContentType "application/json" -Body $Payload
if (-not $Response.ok -or $null -eq $Response.manifest -or $null -eq $Response.manifest.release) {
  throw "Controller did not return a valid deployment manifest."
}

$Release = $Response.manifest.release
if ([string]$Release.platform -ne "windows-x64" -or [string]$Release.format -ne "zip") {
  throw "This bootstrap only accepts the reviewed Windows x64 ZIP release."
}
if ([string]$Release.sha256 -notmatch '^[a-f0-9]{64}$') {
  throw "Controller returned an invalid release digest."
}

$ArtifactUri = [System.Uri][string]$Release.artifact_url
if ($ArtifactUri.Scheme -ne "https" -or
    $ArtifactUri.DnsSafeHost -ne "raw.githubusercontent.com" -or
    -not $ArtifactUri.AbsolutePath.StartsWith("/citadel-AI-EWS/EWS/", [System.StringComparison]::Ordinal)) {
  throw "Deployment artifact URL is outside the approved CITADEL repository."
}

$StageRoot = Join-Path $env:TEMP ("CitadelEWS-Deploy-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
$ZipPath = Join-Path $StageRoot "citadel-agent.zip"

$Client = New-Object System.Net.Http.HttpClient
try {
  $Bytes = $Client.GetByteArrayAsync($ArtifactUri).GetAwaiter().GetResult()
  [System.IO.File]::WriteAllBytes($ZipPath, $Bytes)
} finally {
  $Client.Dispose()
}

$ActualHash = Get-Sha256 -Path $ZipPath
if ($ActualHash -ne [string]$Release.sha256) {
  throw "Downloaded CITADEL package SHA-256 mismatch."
}

Write-Host "[CITADEL] Authorized package verified: $($Release.version)"
Write-Host "[CITADEL] SHA-256: $ActualHash"
Write-Host "[CITADEL] Staged at: $ZipPath"

if (-not $Install) {
  Write-Host "[CITADEL] Staging only. Re-run with -Install -AuthorizeThisHost to install on this computer."
  exit 0
}

if (-not $AuthorizeThisHost) {
  throw "Installation requires explicit -AuthorizeThisHost confirmation."
}

$ExtractRoot = Join-Path $StageRoot "package"
Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractRoot -Force
$Setup = Get-ChildItem -LiteralPath $ExtractRoot -Filter "setup_windows.ps1" -Recurse -File |
  Select-Object -First 1
if ($null -eq $Setup) {
  throw "Verified package does not contain setup_windows.ps1."
}

$Arguments = @(
  "-NoLogo",
  "-NoProfile",
  "-File",
  ('"' + $Setup.FullName + '"'),
  "-ControllerUrl",
  ('"' + $ControllerUri.GetLeftPart([System.UriPartial]::Authority) + '"')
)

$Identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object System.Security.Principal.WindowsPrincipal($Identity)
$IsAdmin = $Principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if ($IsAdmin) {
  $Process = Start-Process -FilePath "powershell.exe" -ArgumentList $Arguments -Wait -PassThru
} else {
  Write-Host "[CITADEL] Windows will ask for administrator approval."
  $Process = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $Arguments -Wait -PassThru
}

if ($Process.ExitCode -ne 0) {
  throw "CITADEL installer failed with exit code $($Process.ExitCode)."
}

$Service = Get-Service -Name "CitadelEWSNode" -ErrorAction Stop
Write-Host "[CITADEL] Installation complete. Service status: $($Service.Status)"
