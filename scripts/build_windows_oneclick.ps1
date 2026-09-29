[CmdletBinding()]
param(
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if ([string]::IsNullOrWhiteSpace($Version)) {
  $AgentSource = Get-Content -LiteralPath (Join-Path $RepoRoot "agent\citadel_node_v2.py") -Raw
  $VersionMatch = [regex]::Match($AgentSource, '(?m)^VERSION\s*=\s*"([^"]+)"')
  if (-not $VersionMatch.Success) { throw "Unable to determine CITADEL agent version." }
  $Version = $VersionMatch.Groups[1].Value
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$') {
  throw "Invalid CITADEL version: $Version"
}

$WorkRoot = Join-Path $RepoRoot "build\windows-oneclick"
$Payload = Join-Path $WorkRoot "payload"
$Runtime = Join-Path $Payload "runtime"
$Dist = Join-Path $RepoRoot "dist"

Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Payload, $Runtime, $Dist | Out-Null

Write-Host "[CITADEL] Preparing private Python runtime..."
$PythonBase = (& python -c "import sys; print(sys.base_prefix)").Trim()
if ([string]::IsNullOrWhiteSpace($PythonBase) -or -not (Test-Path -LiteralPath (Join-Path $PythonBase "python.exe"))) {
  throw "The CI Python runtime could not be located."
}

Copy-Item -Path (Join-Path $PythonBase "*") -Destination $Runtime -Recurse -Force
$RuntimeSitePackages = Join-Path $Runtime "Lib\site-packages"
Remove-Item -LiteralPath $RuntimeSitePackages -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $RuntimeSitePackages | Out-Null

Write-Host "[CITADEL] Freezing agent dependencies into the private runtime..."
$PipArgs = @(
  "-m", "pip", "install",
  "--disable-pip-version-check",
  "--only-binary=:all:",
  "--requirement", (Join-Path $RepoRoot "agent\requirements.txt"),
  "--target", $RuntimeSitePackages
)
& python @PipArgs
if ($LASTEXITCODE -ne 0) { throw "Unable to freeze Windows agent dependencies." }

foreach ($Name in @("citadel_node_v1.py", "citadel_node_v2.py", "windows_enterprise_probe.ps1")) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "agent\$Name") -Destination (Join-Path $Payload $Name) -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $Payload "lmstudio") | Out-Null
Copy-Item -LiteralPath (Join-Path $RepoRoot "agent\lmstudio\install_llmstudio_headless.ps1") -Destination (Join-Path $Payload "lmstudio\install_llmstudio_headless.ps1") -Force

$ConfigProbe = Join-Path $WorkRoot "self-test-config.json"
$ProbeState = Join-Path $WorkRoot "probe-state"
New-Item -ItemType Directory -Force -Path $ProbeState | Out-Null
@{
  controller_url = "https://example.invalid"
  data_dir = $ProbeState
  poll_seconds = 30
  heartbeat_seconds = 30
  request_timeout_seconds = 5
  max_cpu_percent = 90
  max_memory_percent = 90
  prevent_automatic_sleep = $false
  network_recovery_enabled = $false
  allowed_wifi_profiles = @()
  controller_public_x = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
} | ConvertTo-Json | Set-Content -LiteralPath $ConfigProbe -Encoding UTF8

$RuntimePython = Join-Path $Runtime "python.exe"
$OldPythonHome = $env:PYTHONHOME
try {
  $env:PYTHONHOME = $Runtime
  & $RuntimePython (Join-Path $Payload "citadel_node_v2.py") self-test
  if ($LASTEXITCODE -ne 0) { throw "Bundled agent self-test failed." }
  & $RuntimePython (Join-Path $Payload "citadel_node_v2.py") doctor --config $ConfigProbe
  if ($LASTEXITCODE -ne 0) { throw "Bundled agent doctor failed." }
} finally {
  $env:PYTHONHOME = $OldPythonHome
}

Write-Host "[CITADEL] Compiling Windows SCM service host..."
$ProgramFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
$CscCandidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$Csc = $CscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Csc) { throw ".NET Framework compiler was not found on the build runner." }

$ServiceSource = Join-Path $RepoRoot "agent\windows\CitadelPortableService.cs"
$ServiceExe = Join-Path $Payload "CitadelNodeService.exe"
& $Csc /nologo /optimize+ /target:winexe "/out:$ServiceExe" /reference:System.ServiceProcess.dll $ServiceSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ServiceExe)) {
  throw "Windows service host compilation failed."
}
& $ServiceExe --self-test
if ($LASTEXITCODE -ne 0) { throw "Windows service host self-test failed." }

$IsccCandidates = @(
  (Join-Path $ProgramFilesX86 "Inno Setup 6\ISCC.exe"),
  (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
)
$Iscc = $IsccCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $Iscc) { throw "Inno Setup 6 compiler (ISCC.exe) is unavailable." }

Write-Host "[CITADEL] Building one-click installer..."
$Iss = Join-Path $RepoRoot "agent\windows\CitadelEWS.iss"
& $Iscc "/DMyVersion=$Version" "/DSourceRoot=$Payload" "/DOutputDir=$Dist" $Iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed." }

$Installer = Join-Path $Dist ("CITADEL_EWS_Node_Setup_{0}_x64.exe" -f $Version)
if (-not (Test-Path -LiteralPath $Installer)) {
  throw "Expected installer was not produced: $Installer"
}

$Hash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($Installer + ".sha256") -Value ($Hash + "  " + (Split-Path -Leaf $Installer)) -Encoding ASCII

Write-Host "[CITADEL] Windows one-click package ready:"
Write-Host "  $Installer"
Write-Host "  SHA256 $Hash"
