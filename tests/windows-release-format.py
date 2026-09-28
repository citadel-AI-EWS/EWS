#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import tempfile
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "agent" / "windows" / "release_format.py"
SPEC = importlib.util.spec_from_file_location("citadel_release_format", MODULE_PATH)
assert SPEC and SPEC.loader
rf = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = rf
SPEC.loader.exec_module(rf)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def write_canonical(path: Path, value: object) -> bytes:
    raw = rf.canonical_json_bytes(value)
    path.write_bytes(raw)
    return raw


def build_release(base: Path):
    key = Ed25519PrivateKey.generate()
    public_x = b64url(
        key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
    )
    files = {
        "runtime/python.exe": b"python-runtime",
        "citadel_node_v2.py": b"print('node')\n",
        "windows_enterprise_probe.ps1": b"Write-Output 'ok'\n",
    }
    records = [
        {
            "path": name,
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
        }
        for name, data in files.items()
    ]
    manifest = rf.manifest_sha256(records)
    version = "0.3.22"
    release_id = rf.deterministic_release_id(version, manifest)
    root = base / release_id
    root.mkdir(parents=True)

    for name, data in files.items():
        path = root / Path(*name.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    descriptor = {
        "schema": 1,
        "product": "citadel-ews-node",
        "version": version,
        "release_id": release_id,
        "manifest_sha256": manifest,
        "min_launcher_version": "1.0.0",
        "min_state_schema": 1,
        "max_state_schema": 1,
        "writes_state_schema": 1,
        "files": records,
        "created_at": "2026-09-28T12:00:00Z",
        "signing_key_id": "controller-command-ed25519-v1",
    }
    raw = write_canonical(root / "RELEASE.json", descriptor)
    (root / "RELEASE.json.sig").write_text(
        b64url(key.sign(raw)) + "\n",
        encoding="ascii",
    )
    write_canonical(
        root / "RELEASE.OK",
        {
            "release_id": release_id,
            "descriptor_sha256": hashlib.sha256(raw).hexdigest(),
            "verified_at": "2026-09-28T12:00:01Z",
        },
    )
    return key, public_x, release_id, root, descriptor


def expect_error(label: str, fn, needle: str):
    try:
        fn()
    except rf.ReleaseFormatError as error:
        assert needle in str(error), (label, str(error), needle)
    else:
        raise AssertionError(f"{label}: expected ReleaseFormatError")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="citadel-release-format-") as temp:
        releases = Path(temp) / "releases"
        releases.mkdir()
        key, public_x, release_id, root, descriptor = build_release(releases)

        verified = rf.verify_release_tree(releases, release_id, public_x=public_x)
        assert verified.release_id == release_id
        assert verified.version == "0.3.22"
        assert verified.file_count == 3

        # Staging verification may run before RELEASE.OK exists.
        ok = root / "RELEASE.OK"
        ok_bytes = ok.read_bytes()
        ok.unlink()
        rf.verify_release_tree(
            releases,
            release_id,
            public_x=public_x,
            require_release_ok=False,
        )
        expect_error(
            "missing release marker",
            lambda: rf.verify_release_tree(releases, release_id, public_x=public_x),
            "cannot_stat",
        )
        ok.write_bytes(ok_bytes)

        # Payload integrity.
        agent = root / "citadel_node_v2.py"
        original_agent = agent.read_bytes()
        agent.write_bytes(original_agent + b"tamper")
        expect_error(
            "payload tamper",
            lambda: rf.verify_release_tree(releases, release_id, public_x=public_x),
            "size_mismatch",
        )
        agent.write_bytes(original_agent)

        # Detached signature.
        signature = root / "RELEASE.json.sig"
        original_sig = signature.read_text(encoding="ascii")
        signature.write_text(b64url(b"x" * 64), encoding="ascii")
        expect_error(
            "signature tamper",
            lambda: rf.verify_release_tree(releases, release_id, public_x=public_x),
            "release_signature_invalid",
        )
        signature.write_text(original_sig, encoding="ascii")

        # RELEASE.OK binds exact descriptor bytes.
        marker = json.loads(ok.read_text(encoding="utf-8"))
        marker["descriptor_sha256"] = "0" * 64
        write_canonical(ok, marker)
        expect_error(
            "marker descriptor mismatch",
            lambda: rf.verify_release_tree(releases, release_id, public_x=public_x),
            "release_ok_descriptor_mismatch",
        )
        write_canonical(
            ok,
            {
                "release_id": release_id,
                "descriptor_sha256": hashlib.sha256((root / "RELEASE.json").read_bytes()).hexdigest(),
                "verified_at": "2026-09-28T12:00:01Z",
            },
        )

        # Non-canonical descriptor is rejected even if semantically equivalent.
        descriptor_path = root / "RELEASE.json"
        canonical_descriptor = descriptor_path.read_bytes()
        descriptor_path.write_text(json.dumps(descriptor, indent=2), encoding="utf-8")
        expect_error(
            "noncanonical descriptor",
            lambda: rf.verify_release_tree(releases, release_id, public_x=public_x),
            "noncanonical_json",
        )
        descriptor_path.write_bytes(canonical_descriptor)

        # Manifest path rules.
        bad = dict(descriptor)
        bad["files"] = list(descriptor["files"]) + [
            {"path": "../evil.exe", "sha256": "0" * 64, "size": 1}
        ]
        bad["manifest_sha256"] = "0" * 64
        write_canonical(descriptor_path, bad)
        expect_error(
            "manifest traversal",
            lambda: rf.verify_release_tree(releases, release_id, public_x=public_x),
            "unsafe_manifest_path",
        )
        descriptor_path.write_bytes(canonical_descriptor)

        # Extra executable not covered by the manifest is rejected.
        extra = root / "surprise.exe"
        extra.write_bytes(b"x")
        expect_error(
            "extra executable",
            lambda: rf.verify_release_tree(releases, release_id, public_x=public_x),
            "unmanifested_executable",
        )
        extra.unlink()

        # Hardlinks are rejected where the platform exposes link counts.
        hardlink = root / "runtime" / "python-hardlink.exe"
        try:
            os.link(root / "runtime" / "python.exe", hardlink)
        except OSError:
            pass
        else:
            descriptor2 = dict(descriptor)
            data = hardlink.read_bytes()
            descriptor2["files"] = list(descriptor["files"]) + [
                {
                    "path": "runtime/python-hardlink.exe",
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "size": len(data),
                }
            ]
            descriptor2["manifest_sha256"] = rf.manifest_sha256(descriptor2["files"])
            descriptor2["release_id"] = rf.deterministic_release_id(
                descriptor2["version"],
                descriptor2["manifest_sha256"],
            )
            # The directory id no longer matches by design; exercise the helper directly.
            expect_error(
                "hardlink payload",
                lambda: rf._verify_regular_payload_file(
                    root,
                    "runtime/python-hardlink.exe",
                    len(data),
                    hashlib.sha256(data).hexdigest(),
                ),
                "payload_hardlink_rejected",
            )
            hardlink.unlink()

        # Reparse/symlink payload is rejected.
        symlink = root / "runtime" / "python-link.exe"
        try:
            symlink.symlink_to(root / "runtime" / "python.exe")
        except OSError:
            pass
        else:
            expect_error(
                "symlink payload",
                lambda: rf._verify_regular_payload_file(
                    root,
                    "runtime/python-link.exe",
                    len(b"python-runtime"),
                    hashlib.sha256(b"python-runtime").hexdigest(),
                ),
                "reparse_point",
            )
            symlink.unlink()

        # Pure path and release-id helpers reject Windows-dangerous names.
        for unsafe in ["../x", "C:/x", "x\\y", "file.txt:ads", "CON/file.txt", "x./y"]:
            expect_error(
                f"unsafe path {unsafe}",
                lambda unsafe=unsafe: rf.validate_manifest_path(unsafe),
                "",
            )
        for unsafe_id in [".", "..", "-bad", "bad-", "a..b", "a/b"]:
            expect_error(
                f"unsafe release id {unsafe_id}",
                lambda unsafe_id=unsafe_id: rf._validate_release_id(unsafe_id),
                "invalid_release_id",
            )

        # Deterministic ID and manifest hash are stable regardless of record order.
        reversed_records = list(reversed(descriptor["files"]))
        assert rf.manifest_sha256(reversed_records) == descriptor["manifest_sha256"]
        assert rf.deterministic_release_id("0.3.22", descriptor["manifest_sha256"]) == release_id

    print("windows release descriptor verification: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
