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
PACKAGE_NAME = "CITADEL_LINUX_AGENT_0.3.11"
STAGE = DIST / PACKAGE_NAME
ARCHIVE = DIST / f"{PACKAGE_NAME}.tar.gz"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_start_here() -> None:
    start = STAGE / "START_HERE.sh"
    start.write_text(
        '#!/usr/bin/env bash\nset -euo pipefail\nROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\nexec bash "$ROOT/Install Linux Node.sh" "$@"\n',
        encoding="utf-8",
        newline="\n",
    )
    start.chmod(0o755)


def build() -> Path:
    if STAGE.exists():
        shutil.rmtree(STAGE)
    DIST.mkdir(exist_ok=True)
    STAGE.mkdir(parents=True)

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
        shutil.copy2(src, STAGE / name)

    for name in ("setup_linux.sh", "Install Linux Node.sh"):
        (STAGE / name).chmod(0o755)

    v1 = STAGE / "citadel_node_v1.py"
    v2 = STAGE / "citadel_node_v2.py"
    setup = (STAGE / "setup_linux.sh").read_text(encoding="utf-8")
    if 'VERSION = "0.3.11"' not in v1.read_text(encoding="utf-8"):
        raise RuntimeError("repository v1 source is not release 0.3.11")
    if 'VERSION = "0.3.11"' not in v2.read_text(encoding="utf-8"):
        raise RuntimeError("repository v2 source is not release 0.3.11")
    if sha256(v1) not in setup or sha256(v2) not in setup:
        raise RuntimeError("setup_linux.sh SHA pins do not match repository agent files")

    write_start_here()

    manifest_names = sorted(
        p.name for p in STAGE.iterdir()
        if p.is_file() and p.name != "SHA256SUMS.txt"
    )
    manifest = "".join(f"{sha256(STAGE / name)}  {name}\n" for name in manifest_names)
    (STAGE / "SHA256SUMS.txt").write_text(manifest, encoding="utf-8", newline="\n")

    if ARCHIVE.exists():
        ARCHIVE.unlink()
    with tarfile.open(ARCHIVE, "w:gz") as tar:
        tar.add(STAGE, arcname=PACKAGE_NAME)

    print(ARCHIVE)
    print("v1_sha256", sha256(v1))
    print("v2_sha256", sha256(v2))
    return ARCHIVE


if __name__ == "__main__":
    try:
        build()
    except Exception as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        raise
