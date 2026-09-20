#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import shutil
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "agent"
DIST = ROOT / "dist"
RELEASE = "0.3.11_COMPAT1"
ARCH_PACKAGES = {
    "x86_64": f"CITADEL_LINUX_X86_64_AGENT_{RELEASE}",
    "arm64": f"CITADEL_LINUX_ARM64_AGENT_{RELEASE}",
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_start_here(stage: Path) -> None:
    start = stage / "START_HERE.sh"
    start.write_text(
        '#!/usr/bin/env bash\n'
        'set -euo pipefail\n'
        'ROOT="$(cd -- "$(dirname -- "$0")" && pwd)"\n'
        'exec bash "$ROOT/Install Linux Node.sh" "$@"\n',
        encoding="utf-8",
        newline="\n",
    )
    start.chmod(0o755)


def build_package(target_arch: str, package_name: str) -> Path:
    stage = DIST / package_name
    archive = DIST / f"{package_name}.tar.gz"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    names = [
        "citadel_node_v1.py",
        "citadel_node_v2.py",
        "requirements.txt",
        "setup_linux.sh",
        "Install Linux Node.sh",
        "README_LINUX.md",
    ]
    for name in names:
        src = AGENT / name
        if not src.is_file():
            raise RuntimeError(f"missing Linux package source: {name}")
        shutil.copy2(src, stage / name)

    for name in ("setup_linux.sh", "Install Linux Node.sh"):
        (stage / name).chmod(0o755)

    (stage / "TARGET_ARCH").write_text(target_arch + "\n", encoding="utf-8", newline="\n")

    v1 = stage / "citadel_node_v1.py"
    v2 = stage / "citadel_node_v2.py"
    setup = (stage / "setup_linux.sh").read_text(encoding="utf-8")
    if 'VERSION = "0.3.11"' not in v1.read_text(encoding="utf-8"):
        raise RuntimeError("repository v1 source is not release 0.3.11")
    if 'VERSION = "0.3.11"' not in v2.read_text(encoding="utf-8"):
        raise RuntimeError("repository v2 source is not release 0.3.11")
    if sha256(v1) not in setup or sha256(v2) not in setup:
        raise RuntimeError("setup_linux.sh SHA pins do not match repository agent files")
    for marker in (
        'INSTALLER_RELEASE="0.3.11-linuxcompat.1"',
        '--only-binary=:all:',
        'x86_64|amd64',
        'aarch64|arm64',
        'python3.10',
    ):
        if marker not in setup:
            raise RuntimeError(f"Linux compatibility marker missing: {marker}")

    write_start_here(stage)

    manifest_names = sorted(
        p.name for p in stage.iterdir()
        if p.is_file() and p.name != "SHA256SUMS.txt"
    )
    manifest = "".join(f"{sha256(stage / name)}  {name}\n" for name in manifest_names)
    (stage / "SHA256SUMS.txt").write_text(manifest, encoding="utf-8", newline="\n")

    if archive.exists():
        archive.unlink()
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(stage, arcname=package_name)

    print(archive)
    print("target_arch", target_arch)
    print("v1_sha256", sha256(v1))
    print("v2_sha256", sha256(v2))
    return archive


def build() -> list[Path]:
    DIST.mkdir(exist_ok=True)
    return [
        build_package(target_arch, package_name)
        for target_arch, package_name in ARCH_PACKAGES.items()
    ]


if __name__ == "__main__":
    try:
        build()
    except Exception as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        raise
