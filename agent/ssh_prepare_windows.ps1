[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SshUser,
  [Parameter(Mandatory = $true)][string]$ReleaseRoot,
  [Parameter(Mandatory = $true)][string]$StateRoot,
  [switch]$InstallOpenSsh,
  [switch]$Uninstall,
  [string]$PythonPath = "",
  [string]$AgentConfigPath = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot).TrimEnd('\')
$StateRoot = [System.IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
$Bootstrap = Join-Path $ReleaseRoot "ssh_prepare_windows.py"
if (-not (Test-Path -LiteralPath $Bootstrap)) {
  throw "Required CITADEL SSH bootstrap is missing: $Bootstrap"
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
  $PythonPath = Join-Path $ReleaseRoot ".venv\Scripts\python.exe"
  if (-not (Test-Path -LiteralPath $PythonPath)) {
    $PythonPath = Join-Path $ReleaseRoot "runtime\python.exe"
  }
}
if (-not (Test-Path -LiteralPath $PythonPath)) {
  throw "CITADEL Python runtime is missing for SSH bootstrap."
}

$Args = @(
  $Bootstrap,
  "--release-root", $ReleaseRoot,
  "--state-root", $StateRoot,
  "--ssh-user", $SshUser,
  "--python-path", $PythonPath
)
if (-not [string]::IsNullOrWhiteSpace($AgentConfigPath)) {
  $Args += @("--agent-config", $AgentConfigPath)
}
if ($InstallOpenSsh) { $Args += "--install-openssh" }
if ($Uninstall) { $Args += "--remove" }

& $PythonPath @Args
if ($LASTEXITCODE -ne 0) {
  throw "CITADEL restricted SSH bootstrap failed with exit code $LASTEXITCODE."
}
