#!/usr/bin/env python3
"""Build the self-contained Windows CITADEL agent package."""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
VERSION = "0.3.16"
PACKAGE_NAME = "CITADEL_FIXED_AGENT_0.3.16_2026-09-23"
STAGE = DIST / PACKAGE_NAME
ZIP_PATH = DIST / f"{PACKAGE_NAME}.zip"

RUNTIMES = {
    "amd64": {
        "url": "https://www.python.org/ftp/python/3.14.7/python-3.14.7-embeddable-amd64.zip",
        "sha256": "76c3c0384ab3f822486f32450f3a4d20f5d65ad0ec32ee34290971aa0eb817e6",
        "platform": "win_amd64",
        "requirements": "requirements.txt",
    },
    "win32": {
        "url": "https://www.python.org/ftp/python/3.14.7/python-3.14.7-embeddable-win32.zip",
        "sha256": "c784a4596d706d647d430286e2db1d1e3dcc1acb8bc6993fabf147fc00606e18",
        "platform": "win32",
        "requirements": "requirements-win32.txt",
    },
    "arm64": {
        "url": "https://www.python.org/ftp/python/3.14.7/python-3.14.7-embeddable-arm64.zip",
        "sha256": "b777fa08b68a177e350f8730c3e97a2b216d81e3eb5d183b039c65d43a6a2b3e",
        "platform": "win_arm64",
        "requirements": "requirements.txt",
    },
}

PACKAGE_FILES = (
    "citadel_node_v1.py",
    "citadel_node_v2.py",
    "setup_windows_local.py",
    "setup_windows.ps1",
    "Install Windows Node.cmd",
    "Install Windows Service.cmd",
    "CitadelNodeService.cs",
    "windows_service.ps1",
    "windows_enterprise_probe.ps1",
    "requirements.txt",
    "requirements-win32.txt",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def download(url: str, expected_sha256: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "CITADEL-EWS-PackageBuilder/0.3.16"})
    with urllib.request.urlopen(request, timeout=180) as response:  # nosec B310
        final = response.geturl()
        if not final.startswith("https://www.python.org/"):
            raise RuntimeError(f"unexpected Python runtime redirect: {final}")
        with destination.open("wb") as stream:
            shutil.copyfileobj(response, stream)
    actual = sha256(destination)
    if actual != expected_sha256:
        raise RuntimeError(f"Python runtime hash mismatch: {destination.name}: {actual}")


def pip_install_windows_dependencies(runtime: Path, platform_tag: str, requirements: Path) -> None:
    target = runtime / "Lib" / "site-packages"
    target.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--only-binary=:all:",
        "--platform",
        platform_tag,
        "--python-version",
        "3.14",
        "--implementation",
        "cp",
        "--abi",
        "cp314",
        "--abi",
        "abi3",
        "--abi",
        "none",
        "--target",
        str(target),
        "--no-compile",
        "--requirement",
        str(requirements),
    ]
    subprocess.run(command, check=True)


def configure_embedded_runtime(runtime: Path) -> None:
    pth_files = list(runtime.glob("python*._pth"))
    if len(pth_files) != 1:
        raise RuntimeError(f"expected one embedded Python ._pth file in {runtime}")
    pth_files[0].write_text(
        "python314.zip\n"
        ".\n"
        "Lib\\site-packages\n"
        "import site\n",
        encoding="utf-8",
        newline="\n",
    )


def runtime_manifest(runtime: Path) -> None:
    manifest = runtime / "SHA256SUMS.txt"
    entries = []
    for path in sorted(p for p in runtime.rglob("*") if p.is_file() and p != manifest):
        entries.append(f"{sha256(path)}  {path.relative_to(runtime).as_posix()}\n")
    manifest.write_text("".join(entries), encoding="utf-8", newline="\n")


def prepare_runtime(name: str, spec: dict[str, str]) -> None:
    runtime = STAGE / f"python-runtime-{name}"
    runtime.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"citadel-python-{name}-") as temp:
        archive = Path(temp) / "python.zip"
        download(spec["url"], spec["sha256"], archive)
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(runtime)
    configure_embedded_runtime(runtime)
    pip_install_windows_dependencies(runtime, spec["platform"], ROOT / "agent" / spec["requirements"])
    runtime_manifest(runtime)


def write_extras() -> None:
    (STAGE / "START_HERE.cmd").write_text(
        '@echo off\r\n'
        'setlocal\r\n'
        'call "%~dp0Install Windows Node.cmd" %*\r\n',
        encoding="utf-8",
        newline="",
    )
    (STAGE / "Uninstall Local Agent.cmd").write_text(
        '@echo off\r\n'
        'setlocal\r\n'
        'set "ARCH=%PROCESSOR_ARCHITECTURE%"\r\n'
        'if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "ARCH=AMD64"\r\n'
        'if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=ARM64"\r\n'
        'if /I "%ARCH%"=="AMD64" set "PY=%~dp0python-runtime-amd64\\python.exe"\r\n'
        'if /I "%ARCH%"=="X86" set "PY=%~dp0python-runtime-win32\\python.exe"\r\n'
        'if /I "%ARCH%"=="ARM64" set "PY=%~dp0python-runtime-arm64\\python.exe"\r\n'
        'if not defined PY exit /b 1\r\n'
        '"%PY%" "%~dp0setup_windows_local.py" --uninstall %*\r\n'
        'pause\r\n',
        encoding="utf-8",
        newline="",
    )
    readme = (
        "CITADEL/EWS — self-contained Windows package 0.3.16\n\n"
        "RECOMMENDED / NO ADMIN:\n"
        "1. Extract the ZIP completely.\n"
        "2. Double-click START_HERE.cmd.\n"
        "3. Local Agent installs under %LOCALAPPDATA% and uses the Python runtime bundled in this ZIP.\n"
        "4. It does not install system Python and does not require PowerShell or Administrator rights.\n\n"
        "OPTIONAL MACHINE SERVICE:\n"
        "- Run Install Windows Service.cmd when Administrator rights are available.\n"
        "- The service installer also prefers the verified Python runtime bundled in this ZIP.\n\n"
        "LM STUDIO:\n"
        "- Windows LM Studio/llmster installation is executed by the Python agent itself.\n"
        "- The agent reads the official LM Studio installer only for allowlisted metadata, downloads the official llmster ZIP, requires its SHA-512 checksum, and runs llmster.exe bootstrap.\n"
        "- PowerShell execution policy is not part of the Windows LM Studio install path anymore.\n\n"
        "Controller: https://citadel-ai.init1.workers.dev\n"
    )
    (STAGE / "README_RU.txt").write_text(readme, encoding="utf-8", newline="\n")

    verify = r'''[CmdletBinding()]
param()
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Manifest = Join-Path $Root "SHA256SUMS.txt"
if (-not (Test-Path -LiteralPath $Manifest)) { throw "SHA256SUMS.txt not found" }
foreach ($line in Get-Content -LiteralPath $Manifest) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line -split "  ", 2
  if ($parts.Count -ne 2) { throw "Invalid manifest line: $line" }
  $expected = $parts[0].Trim().ToLowerInvariant()
  $name = $parts[1].Trim().Replace("/", [IO.Path]::DirectorySeparatorChar)
  $path = Join-Path $Root $name
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing file: $name" }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Hash mismatch: $name" }
}
Write-Host "CITADEL package integrity: OK"
'''
    (STAGE / "VERIFY_PACKAGE.ps1").write_text(verify, encoding="utf-8", newline="\n")


def outer_manifest() -> None:
    manifest = STAGE / "SHA256SUMS.txt"
    entries = []
    for path in sorted(p for p in STAGE.rglob("*") if p.is_file() and p != manifest):
        entries.append(f"{sha256(path)}  {path.relative_to(STAGE).as_posix()}\n")
    manifest.write_text("".join(entries), encoding="utf-8", newline="\n")


def build() -> Path:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    DIST.mkdir(exist_ok=True)
    STAGE.mkdir(parents=True)

    for name in PACKAGE_FILES:
        source = ROOT / "agent" / name
        if not source.is_file():
            raise RuntimeError(f"required source file missing: agent/{name}")
        shutil.copy2(source, STAGE / name)

    for path in (STAGE / "citadel_node_v1.py", STAGE / "citadel_node_v2.py"):
        if f'VERSION = "{VERSION}"' not in path.read_text(encoding="utf-8"):
            raise RuntimeError(f"{path.name} is not release {VERSION}")

    setup_text = (STAGE / "setup_windows.ps1").read_text(encoding="utf-8")
    if f'$ReleaseVersion = "{VERSION}"' not in setup_text:
        raise RuntimeError("setup_windows.ps1 release version mismatch")

    for name, spec in RUNTIMES.items():
        prepare_runtime(name, spec)

    write_extras()
    outer_manifest()

    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(p for p in STAGE.rglob("*") if p.is_file()):
            archive.write(path, f"{PACKAGE_NAME}/{path.relative_to(STAGE).as_posix()}")

    print(ZIP_PATH)
    print("package_sha256", sha256(ZIP_PATH))
    return ZIP_PATH


if __name__ == "__main__":
    try:
        build()
    except Exception as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        raise
