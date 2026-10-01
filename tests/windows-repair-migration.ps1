$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$setupPath = Join-Path $PSScriptRoot "../agent/setup_windows.ps1"
$source = Get-Content -LiteralPath $setupPath -Raw
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($setupPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$start = $source.IndexOf('$NewIdentity =')
$end = $source.IndexOf('# Build a unique final release directory', $start)
if ($start -lt 0 -or $end -le $start) { throw "Migration preflight not found" }
$initial = [scriptblock]::Create($source.Substring($start, $end - $start))
$finalNodes = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text.StartsWith('if ($LegacyMigrationRequired -and $LegacyStateMatchesNode)')
}, $true))
if ($finalNodes.Count -ne 1) { throw "One-time final migration gate not found" }
$final = [scriptblock]::Create($finalNodes[0].Extent.Text)
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("citadel-repair-" + [Guid]::NewGuid().ToString("N"))
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try {
  foreach ($mode in @("first-cutover", "existing-install", "marker-only")) {
    $InstallRoot = Join-Path $root ($mode + "/install")
    $StateRoot = Join-Path $root ($mode + "/state")
    $LegacyStateRoot = Join-Path $root ($mode + "/legacy")
    foreach ($dir in @($InstallRoot, $StateRoot, $LegacyStateRoot)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    foreach ($name in @("pending-results.json", "network-recovery.json", "lmstudio-state.json")) {
      [System.IO.File]::WriteAllText((Join-Path $LegacyStateRoot $name), "stale-profile", $Utf8NoBom)
      [System.IO.File]::WriteAllText((Join-Path $StateRoot $name), "live-state", $Utf8NoBom)
    }
    [System.IO.File]::WriteAllText((Join-Path $LegacyStateRoot "PAUSED"), "stale-pause", $Utf8NoBom)
    if ($mode -eq "existing-install") { [System.IO.File]::WriteAllText((Join-Path $InstallRoot "install-state.json"), "{}", $Utf8NoBom) }
    if ($mode -eq "marker-only") { [System.IO.File]::WriteAllText((Join-Path $StateRoot "LEGACY_MIGRATION_COMPLETE"), "node-test", $Utf8NoBom) }
    . $initial
    $LegacyStateMatchesNode = $true
    $PausedPath = Join-Path $StateRoot "PAUSED"
    . $final
    $expected = if ($mode -eq "first-cutover") { "stale-profile" } else { "live-state" }
    foreach ($name in @("pending-results.json", "network-recovery.json", "lmstudio-state.json")) {
      if ((Get-Content -LiteralPath (Join-Path $StateRoot $name) -Raw) -ne $expected) { throw "Unexpected state copy for $mode/$name" }
    }
    if ($mode -ne "first-cutover" -and (Test-Path -LiteralPath $PausedPath)) { throw "Repair restored stale PAUSED marker: $mode" }
  }
  Write-Host "Windows repair migration: first cutover, existing install and marker-only repair PASS"
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
