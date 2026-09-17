#!/usr/bin/env python3
"""One-time migration: promote the CI-verified 0.3.1 agent into repository source."""
from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import build_fixed_agent_package as legacy


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"promotion pattern missing: {label}")
    return text.replace(old, new, 1)


def main() -> None:
    # Build the same reviewed 0.3.1 package that CI has already verified.
    legacy.build()
    stage = legacy.STAGE

    expected = {
        "citadel_node_v1.py": "169f81a54ea2142f0fbf95b6396c3287e1a9d3d895d5961a17b5b0b7e21267ef",
        "citadel_node_v2.py": "187862e91d7378c74282e111b6e55b5e78abd81ea6e235f8ef6116dd11ec81e3",
        "setup_windows.ps1": "0210dabf2cae0d52d29394ad4aff1b4d9425ceab45df41931c64294bd1584f64",
    }
    for name, digest in expected.items():
        source = stage / name
        actual = sha256(source)
        if actual != digest:
            raise RuntimeError(f"verified stage drift for {name}: {actual}")
        shutil.copy2(source, ROOT / "agent" / name)

    # Promote the exact Python hashes into the signed Controller release metadata.
    index_path = ROOT / "src" / "index.js"
    index = index_path.read_text(encoding="utf-8")
    index = replace_once(index, 'version: "0.3.0"', 'version: "0.3.1"', "release version")
    index = replace_once(
        index,
        'sha256: "b7731e1149d5a3354fe5d45745df01ad6129b40a13e27d94d693fcdff38ee30e"',
        'sha256: "169f81a54ea2142f0fbf95b6396c3287e1a9d3d895d5961a17b5b0b7e21267ef"',
        "v1 release hash",
    )
    index = replace_once(
        index,
        'sha256: "765dfbe5963c6da5822ee8fb233e25c2de647ba77867d43cc8c771231f610f6a"',
        'sha256: "187862e91d7378c74282e111b6e55b5e78abd81ea6e235f8ef6116dd11ec81e3"',
        "v2 release hash",
    )
    index_path.write_text(index, encoding="utf-8", newline="\n")

    # From now on the builder packages repository source directly; it must not
    # synthesize 0.3.1 from 0.3.0 during CI.
    builder_path = ROOT / "scripts" / "build_fixed_agent_package.py"
    builder = builder_path.read_text(encoding="utf-8")
    builder = replace_once(
        builder,
        "The builder stages a reviewed reliability patch over the checked-in agent release,\nvalidates the staged Python agent, and emits one ZIP containing every install file.",
        "The builder packages the checked-in reviewed agent release without mutating source,\nvalidates release pins, and emits one ZIP containing every install file.",
        "builder description",
    )
    old_block = '''    patch_v1(STAGE / "citadel_node_v1.py")\n    patch_v2(STAGE / "citadel_node_v2.py")\n    v1_hash = sha256(STAGE / "citadel_node_v1.py")\n    v2_hash = sha256(STAGE / "citadel_node_v2.py")\n    patch_setup(STAGE / "setup_windows.ps1", v1_hash, v2_hash)\n'''
    new_block = '''    v1_path = STAGE / "citadel_node_v1.py"\n    v2_path = STAGE / "citadel_node_v2.py"\n    setup_path = STAGE / "setup_windows.ps1"\n    v1_hash = sha256(v1_path)\n    v2_hash = sha256(v2_path)\n    if 'VERSION = "0.3.1"' not in v1_path.read_text(encoding="utf-8"):\n        raise RuntimeError("repository v1 source is not release 0.3.1")\n    if 'VERSION = "0.3.1"' not in v2_path.read_text(encoding="utf-8"):\n        raise RuntimeError("repository v2 source is not release 0.3.1")\n    setup_text = setup_path.read_text(encoding="utf-8")\n    if f'$ExpectedV1Sha256 = "{v1_hash}"' not in setup_text:\n        raise RuntimeError("setup_windows.ps1 v1 hash pin does not match repository source")\n    if f'$ExpectedV2Sha256 = "{v2_hash}"' not in setup_text:\n        raise RuntimeError("setup_windows.ps1 v2 hash pin does not match repository source")\n    if 'agent_version = "0.3.1"' not in setup_text:\n        raise RuntimeError("setup_windows.ps1 release version is not 0.3.1")\n'''
    builder = replace_once(builder, old_block, new_block, "builder direct-source block")
    builder_path.write_text(builder, encoding="utf-8", newline="\n")

    # The migration machinery must not remain in the product branch.
    (ROOT / ".github" / "workflows" / "promote-agent-031.yml").unlink(missing_ok=True)
    Path(__file__).unlink(missing_ok=True)

    print("CITADEL agent 0.3.1 source promotion complete")


if __name__ == "__main__":
    main()
