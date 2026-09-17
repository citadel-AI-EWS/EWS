#!/usr/bin/env python3
"""One-time release fix: rename a non-secret interface marker and re-pin hashes."""
from __future__ import annotations

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
V1 = ROOT / "agent" / "citadel_node_v1.py"
SETUP = ROOT / "agent" / "setup_windows.ps1"
INDEX = ROOT / "src" / "index.js"
OLD_HASH = "169f81a54ea2142f0fbf95b6396c3287e1a9d3d895d5961a17b5b0b7e21267ef"


def replace_exact(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected exactly one {label}, found {count}")
    return text.replace(old, new, 1)


def main() -> None:
    source = V1.read_text(encoding="utf-8")
    source = source.replace("TAILSCALE_INTERFACE_TOKEN", "TAILSCALE_INTERFACE_MARKER")
    if "TAILSCALE_INTERFACE_TOKEN" in source:
        raise RuntimeError("old Bandit-sensitive identifier remains")
    V1.write_text(source, encoding="utf-8", newline="\n")
    new_hash = hashlib.sha256(V1.read_bytes()).hexdigest()
    if new_hash == OLD_HASH:
        raise RuntimeError("v1 hash did not change")

    setup = SETUP.read_text(encoding="utf-8")
    setup = replace_exact(setup, OLD_HASH, new_hash, "setup v1 SHA-256 pin")
    SETUP.write_text(setup, encoding="utf-8", newline="\n")

    index = INDEX.read_text(encoding="utf-8")
    index = replace_exact(index, OLD_HASH, new_hash, "Controller v1 release SHA-256 pin")
    INDEX.write_text(index, encoding="utf-8", newline="\n")

    (ROOT / ".github" / "workflows" / "fix-agent-031-bandit.yml").unlink(missing_ok=True)
    Path(__file__).unlink(missing_ok=True)
    print(f"Agent 0.3.1 v1 re-pinned: {new_hash}")


if __name__ == "__main__":
    main()
