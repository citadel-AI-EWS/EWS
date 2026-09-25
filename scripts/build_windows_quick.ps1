[CmdletBinding()]
param([string]$Version = "")

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

$WorkRoot = Join-Path $RepoRoot "build\windows-quick"
$Stage = Join-Path $WorkRoot ("CITADEL_QUICK_AGENT_{0}_x64" -f $Version)
$Runtime = Join-Path $Stage "runtime"
$Dist = Join-Path $RepoRoot "dist"
$Zip = Join-Path $Dist ((Split-Path -Leaf $Stage) + ".zip")

Remove-Item -LiteralPath $WorkRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage, $Runtime, $Dist | Out-Null

Write-Host "[CITADEL] Preparing bundled private Python runtime..."
$PythonBase = (& python -c "import sys; print(sys.base_prefix)").Trim()
if ([string]::IsNullOrWhiteSpace($PythonBase) -or -not (Test-Path -LiteralPath (Join-Path $PythonBase "python.exe"))) {
  throw "The CI Python runtime could not be located."
}
Copy-Item -Path (Join-Path $PythonBase "*") -Destination $Runtime -Recurse -Force
$RuntimeSitePackages = Join-Path $Runtime "Lib\site-packages"
Remove-Item -LiteralPath $RuntimeSitePackages -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $RuntimeSitePackages | Out-Null

Write-Host "[CITADEL] Freezing Python dependencies into the private runtime..."
$PipArgs = @("-m","pip","install","--disable-pip-version-check","--only-binary=:all:","--requirement",(Join-Path $RepoRoot "agent\requirements.txt"),"--target",$RuntimeSitePackages)
& python @PipArgs
if ($LASTEXITCODE -ne 0) { throw "Unable to freeze Quick Agent dependencies." }

foreach ($Name in @("citadel_node_v1.py","citadel_node_v2.py","windows_enterprise_probe.ps1")) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "agent\$Name") -Destination (Join-Path $Stage $Name) -Force
}
foreach ($Name in @("quick_install.py","quick_runner.py","START_HERE.cmd","UNINSTALL.cmd","README_RU.txt")) {
  Copy-Item -LiteralPath (Join-Path $RepoRoot "agent\quick\$Name") -Destination (Join-Path $Stage $Name) -Force
}
$LmDir = Join-Path $Stage "lmstudio"
New-Item -ItemType Directory -Force -Path $LmDir | Out-Null
Copy-Item -LiteralPath (Join-Path $RepoRoot "agent\lmstudio\install_llmstudio_headless.py") -Destination (Join-Path $LmDir "install_llmstudio_headless.py") -Force

$RuntimePython = Join-Path $Runtime "python.exe"
$OldPythonHome = $env:PYTHONHOME
try {
  $env:PYTHONHOME = $Runtime
  & $RuntimePython (Join-Path $Stage "citadel_node_v2.py") self-test
  if ($LASTEXITCODE -ne 0) { throw "Bundled Quick Agent self-test failed." }
  $CompileTargets = @(
    (Join-Path $Stage "citadel_node_v1.py"),
    (Join-Path $Stage "citadel_node_v2.py"),
    (Join-Path $Stage "quick_install.py"),
    (Join-Path $Stage "quick_runner.py"),
    (Join-Path $LmDir "install_llmstudio_headless.py")
  )
  & $RuntimePython -m py_compile @CompileTargets
  if ($LASTEXITCODE -ne 0) { throw "Quick Agent Python compile check failed." }
} finally {
  $env:PYTHONHOME = $OldPythonHome
}

Write-Host "[CITADEL] Building recursive SHA-256 manifest..."
$Manifest = Join-Path $Stage "SHA256SUMS.txt"
$Lines = @()
Get-ChildItem -LiteralPath $Stage -Recurse -File |
  Where-Object { $_.FullName -ne $Manifest } |
  Sort-Object FullName |
  ForEach-Object {
    $Relative = $_.FullName.Substring($Stage.Length + 1).Replace("\","/")
    $Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $Lines += ($Hash + "  " + $Relative)
  }
Set-Content -LiteralPath $Manifest -Value $Lines -Encoding ASCII

Remove-Item -LiteralPath $Zip -Force -ErrorAction SilentlyContinue
Compress-Archive -LiteralPath $Stage -DestinationPath $Zip -CompressionLevel Optimal
$ZipHash = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($Zip + ".sha256") -Value ($ZipHash + "  " + (Split-Path -Leaf $Zip)) -Encoding ASCII

Write-Host "[CITADEL] Quick Agent package ready:"
Write-Host "  $Zip"
Write-Host "  SHA256 $ZipHash"
