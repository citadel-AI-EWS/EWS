#!/usr/bin/env python3
"""Pure release-descriptor verification for crash-safe Windows versioned releases.

This module is intentionally side-effect free: it never writes release-state,
moves release trees, changes ACLs, or touches Service/Task lifecycle. Writers
are introduced by later Issue #160 PRs.

A committed release is accepted only when:
- RELEASE.json is canonical UTF-8 JSON and schema 1;
- its detached Ed25519 signature verifies against the pinned release key;
- release_id is deterministic from version + whole-manifest SHA-256;
- every manifest path is Windows-safe, unique case-insensitively, non-reparse,
  regular, size-matched, and SHA-256 matched;
- critical runtime files are present;
- RELEASE.OK (when required) binds release_id to the exact descriptor bytes.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


SCHEMA = 1
PRODUCT = "citadel-ews-node"
DEFAULT_RELEASE_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
DEFAULT_SIGNING_KEY_ID = "controller-command-ed25519-v1"
REPARSE_POINT_ATTRIBUTE = 0x400

RELEASE_ID_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9])?$")
VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9._-]+)?$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
SIGNING_KEY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
WINDOWS_RESERVED_BASENAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
REQUIRED_PAYLOAD_PATHS = {
    "runtime/python.exe",
    "citadel_node_v2.py",
}
DESCRIPTOR_REQUIRED_FIELDS = {
    "schema",
    "product",
    "version",
    "release_id",
    "manifest_sha256",
    "min_launcher_version",
    "min_state_schema",
    "max_state_schema",
    "writes_state_schema",
    "files",
    "created_at",
    "signing_key_id",
}
DESCRIPTOR_OPTIONAL_FIELDS = {"build_id"}
FILE_RECORD_FIELDS = {"path", "sha256", "size"}
RELEASE_OK_FIELDS = {"release_id", "descriptor_sha256", "verified_at"}


class ReleaseFormatError(ValueError):
    """Release descriptor/tree is malformed or fails integrity verification."""


@dataclass(frozen=True)
class VerifiedRelease:
    release_id: str
    version: str
    manifest_sha256: str
    descriptor_sha256: str
    min_launcher_version: str
    min_state_schema: int
    max_state_schema: int
    writes_state_schema: int
    file_count: int


def _b64url_decode(value: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise ReleaseFormatError("signature_or_key_missing")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ReleaseFormatError("invalid_base64url")
    padding = "=" * (-len(value) % 4)
    try:
        return base64.urlsafe_b64decode(value + padding)
    except Exception as exc:
        raise ReleaseFormatError("invalid_base64url") from exc


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _load_canonical_json(path: Path, *, allowed_fields: set[str] | None = None) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ReleaseFormatError(f"cannot_read:{path.name}") from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReleaseFormatError(f"invalid_utf8:{path.name}") from exc
    def reject_duplicate_pairs(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ReleaseFormatError(f"duplicate_json_key:{path.name}:{key}")
            result[key] = item
        return result

    def reject_constant(value):
        raise ReleaseFormatError(f"invalid_json_constant:{path.name}:{value}")

    try:
        value = json.loads(
            text,
            object_pairs_hook=reject_duplicate_pairs,
            parse_constant=reject_constant,
        )
    except ReleaseFormatError:
        raise
    except (json.JSONDecodeError, ValueError) as exc:
        raise ReleaseFormatError(f"invalid_json:{path.name}") from exc
    if not isinstance(value, dict):
        raise ReleaseFormatError(f"json_object_required:{path.name}")
    if allowed_fields is not None:
        unknown = set(value) - allowed_fields
        if unknown:
            raise ReleaseFormatError(f"unknown_fields:{path.name}:{','.join(sorted(unknown))}")
    if canonical_json_bytes(value) != raw:
        raise ReleaseFormatError(f"noncanonical_json:{path.name}")
    return value, raw


def _validate_release_id(value: Any) -> str:
    if not isinstance(value, str) or not RELEASE_ID_RE.fullmatch(value):
        raise ReleaseFormatError("invalid_release_id")
    if value in {".", ".."} or ".." in value:
        raise ReleaseFormatError("invalid_release_id")
    return value


def _validate_version(value: Any) -> str:
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        raise ReleaseFormatError("invalid_version")
    return value


def _validate_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise ReleaseFormatError(f"invalid_sha256:{field}")
    return value


def _validate_schema_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 2_147_483_647:
        raise ReleaseFormatError(f"invalid_integer:{field}")
    return value


def _validate_utc_timestamp(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ReleaseFormatError(f"invalid_timestamp:{field}")
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise ReleaseFormatError(f"invalid_timestamp:{field}") from exc
    return value


def validate_manifest_path(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 240:
        raise ReleaseFormatError("invalid_manifest_path")
    if "\\" in value or ":" in value or value.startswith("/") or "\x00" in value:
        raise ReleaseFormatError(f"unsafe_manifest_path:{value!r}")
    if any(ord(ch) < 32 for ch in value):
        raise ReleaseFormatError(f"unsafe_manifest_path:{value!r}")

    raw_parts = value.split("/")
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise ReleaseFormatError(f"unsafe_manifest_path:{value!r}")

    path = PurePosixPath(value)
    if path.is_absolute():
        raise ReleaseFormatError(f"unsafe_manifest_path:{value!r}")

    for part in raw_parts:
        if part.endswith((" ", ".")):
            raise ReleaseFormatError(f"unsafe_manifest_path:{value!r}")
        basename = part.split(".", 1)[0].upper()
        if basename in WINDOWS_RESERVED_BASENAMES:
            raise ReleaseFormatError(f"windows_reserved_path:{value!r}")
    return value


def _manifest_lines(files: Iterable[dict[str, Any]]) -> list[str]:
    records: list[tuple[str, int, str]] = []
    seen_casefold: set[str] = set()
    for record in files:
        if not isinstance(record, dict) or set(record) != FILE_RECORD_FIELDS:
            raise ReleaseFormatError("invalid_file_record")
        path = validate_manifest_path(record["path"])
        folded = path.casefold()
        if folded in seen_casefold:
            raise ReleaseFormatError(f"duplicate_manifest_path:{path}")
        seen_casefold.add(folded)
        digest = _validate_sha256(record["sha256"], f"files[{path}].sha256")
        size = _validate_schema_int(record["size"], f"files[{path}].size")
        records.append((path, size, digest))
    records.sort(key=lambda item: item[0].casefold())
    return [f"{path}\0{size}\0{digest}\n" for path, size, digest in records]


def manifest_sha256(files: Iterable[dict[str, Any]]) -> str:
    joined = "".join(_manifest_lines(files)).encode("utf-8")
    return hashlib.sha256(joined).hexdigest()


def deterministic_release_id(version: str, manifest_digest: str) -> str:
    version = _validate_version(version)
    manifest_digest = _validate_sha256(manifest_digest, "manifest_sha256")
    release_id = f"{version}-{manifest_digest[:16]}"
    return _validate_release_id(release_id)


def descriptor_sha256(descriptor_bytes: bytes) -> str:
    return hashlib.sha256(descriptor_bytes).hexdigest()


def _is_reparse(path: Path) -> bool:
    try:
        st = path.lstat()
    except OSError as exc:
        raise ReleaseFormatError(f"cannot_stat:{path}") from exc
    attrs = getattr(st, "st_file_attributes", 0)
    return stat.S_ISLNK(st.st_mode) or bool(attrs & REPARSE_POINT_ATTRIBUTE)


def _ensure_no_reparse_ancestry(root: Path, relative_path: str) -> Path:
    if _is_reparse(root):
        raise ReleaseFormatError(f"reparse_point:{root.name}")
    current = root
    for part in PurePosixPath(relative_path).parts:
        current = current / part
        if _is_reparse(current):
            raise ReleaseFormatError(f"reparse_point:{relative_path}")
    return current


def _verify_regular_payload_file(root: Path, relative_path: str, expected_size: int, expected_sha256: str) -> None:
    path = _ensure_no_reparse_ancestry(root, relative_path)
    try:
        st = path.stat()
    except OSError as exc:
        raise ReleaseFormatError(f"missing_payload:{relative_path}") from exc
    if not stat.S_ISREG(st.st_mode):
        raise ReleaseFormatError(f"payload_not_regular:{relative_path}")
    if getattr(st, "st_nlink", 1) > 1:
        raise ReleaseFormatError(f"payload_hardlink_rejected:{relative_path}")
    if st.st_size != expected_size:
        raise ReleaseFormatError(f"size_mismatch:{relative_path}")
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ReleaseFormatError(f"cannot_read_payload:{relative_path}") from exc
    if digest.hexdigest() != expected_sha256:
        raise ReleaseFormatError(f"hash_mismatch:{relative_path}")


def _verify_no_extra_critical_executables(root: Path, manifest_paths: set[str]) -> None:
    allowed_meta = {"RELEASE.json", "RELEASE.json.sig", "RELEASE.OK"}
    for path in root.rglob("*"):
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError as exc:
            raise ReleaseFormatError("tree_escape") from exc
        if _is_reparse(path):
            raise ReleaseFormatError(f"reparse_point:{relative}")
        if not path.is_file():
            continue
        if relative in allowed_meta or relative.casefold() in {p.casefold() for p in manifest_paths}:
            continue
        raise ReleaseFormatError(f"unmanifested_payload:{relative}")


def parse_and_verify_descriptor(
    descriptor_path: Path,
    signature_path: Path,
    *,
    public_x: str = DEFAULT_RELEASE_PUBLIC_X,
    expected_signing_key_id: str = DEFAULT_SIGNING_KEY_ID,
) -> tuple[dict[str, Any], bytes, str]:
    descriptor, raw = _load_canonical_json(
        descriptor_path,
        allowed_fields=DESCRIPTOR_REQUIRED_FIELDS | DESCRIPTOR_OPTIONAL_FIELDS,
    )
    missing = DESCRIPTOR_REQUIRED_FIELDS - set(descriptor)
    if missing:
        raise ReleaseFormatError(f"missing_descriptor_fields:{','.join(sorted(missing))}")

    if _validate_schema_int(descriptor["schema"], "schema") != SCHEMA:
        raise ReleaseFormatError("unsupported_release_schema")
    if descriptor["product"] != PRODUCT:
        raise ReleaseFormatError("wrong_product")

    version = _validate_version(descriptor["version"])
    release_id = _validate_release_id(descriptor["release_id"])
    manifest_digest = _validate_sha256(descriptor["manifest_sha256"], "manifest_sha256")

    signing_key_id = descriptor["signing_key_id"]
    if not isinstance(signing_key_id, str) or not SIGNING_KEY_ID_RE.fullmatch(signing_key_id):
        raise ReleaseFormatError("invalid_signing_key_id")
    if signing_key_id != expected_signing_key_id:
        raise ReleaseFormatError("unexpected_signing_key_id")

    _validate_version(descriptor["min_launcher_version"])
    min_state = _validate_schema_int(descriptor["min_state_schema"], "min_state_schema")
    max_state = _validate_schema_int(descriptor["max_state_schema"], "max_state_schema")
    writes_state = _validate_schema_int(descriptor["writes_state_schema"], "writes_state_schema")
    if min_state > max_state or not (min_state <= writes_state <= max_state):
        raise ReleaseFormatError("invalid_state_schema_bounds")
    _validate_utc_timestamp(descriptor["created_at"], "created_at")

    files = descriptor["files"]
    if not isinstance(files, list) or not files:
        raise ReleaseFormatError("files_must_be_nonempty")
    calculated_manifest = manifest_sha256(files)
    if calculated_manifest != manifest_digest:
        raise ReleaseFormatError("manifest_sha256_mismatch")
    if deterministic_release_id(version, manifest_digest) != release_id:
        raise ReleaseFormatError("release_id_not_deterministic")

    try:
        signature_text = signature_path.read_text(encoding="ascii").strip()
    except OSError as exc:
        raise ReleaseFormatError("release_signature_missing") from exc
    signature = _b64url_decode(signature_text)
    if len(signature) != 64:
        raise ReleaseFormatError("invalid_release_signature_length")
    public_key = _b64url_decode(public_x)
    if len(public_key) != 32:
        raise ReleaseFormatError("invalid_release_public_key")

    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, raw)
    except Exception as exc:
        raise ReleaseFormatError("release_signature_invalid") from exc

    return descriptor, raw, descriptor_sha256(raw)


def verify_release_tree(
    releases_root: Path,
    release_id: str,
    *,
    public_x: str = DEFAULT_RELEASE_PUBLIC_X,
    expected_signing_key_id: str = DEFAULT_SIGNING_KEY_ID,
    require_release_ok: bool = True,
) -> VerifiedRelease:
    release_id = _validate_release_id(release_id)
    releases_root = Path(releases_root)
    if not releases_root.is_dir():
        raise ReleaseFormatError("releases_root_missing")
    if _is_reparse(releases_root):
        raise ReleaseFormatError("releases_root_reparse")

    root = releases_root / release_id
    if not root.is_dir():
        raise ReleaseFormatError("release_root_missing")
    if _is_reparse(root):
        raise ReleaseFormatError("release_root_reparse")

    descriptor_path = _ensure_no_reparse_ancestry(root, "RELEASE.json")
    signature_path = _ensure_no_reparse_ancestry(root, "RELEASE.json.sig")
    descriptor, raw, descriptor_digest = parse_and_verify_descriptor(
        descriptor_path,
        signature_path,
        public_x=public_x,
        expected_signing_key_id=expected_signing_key_id,
    )
    if descriptor["release_id"] != release_id:
        raise ReleaseFormatError("release_directory_id_mismatch")

    manifest_paths: set[str] = set()
    for record in descriptor["files"]:
        relative = validate_manifest_path(record["path"])
        manifest_paths.add(relative)
        _verify_regular_payload_file(root, relative, record["size"], record["sha256"])

    missing_required = {path for path in REQUIRED_PAYLOAD_PATHS if path not in manifest_paths}
    if missing_required:
        raise ReleaseFormatError(f"missing_required_payload:{','.join(sorted(missing_required))}")

    if require_release_ok:
        ok_path = _ensure_no_reparse_ancestry(root, "RELEASE.OK")
        ok, _ = _load_canonical_json(ok_path, allowed_fields=RELEASE_OK_FIELDS)
        if set(ok) != RELEASE_OK_FIELDS:
            raise ReleaseFormatError("invalid_release_ok_fields")
        if ok.get("release_id") != release_id:
            raise ReleaseFormatError("release_ok_id_mismatch")
        if ok.get("descriptor_sha256") != descriptor_digest:
            raise ReleaseFormatError("release_ok_descriptor_mismatch")
        _validate_utc_timestamp(ok.get("verified_at"), "verified_at")

    _verify_no_extra_critical_executables(root, manifest_paths)

    return VerifiedRelease(
        release_id=release_id,
        version=descriptor["version"],
        manifest_sha256=descriptor["manifest_sha256"],
        descriptor_sha256=descriptor_digest,
        min_launcher_version=descriptor["min_launcher_version"],
        min_state_schema=descriptor["min_state_schema"],
        max_state_schema=descriptor["max_state_schema"],
        writes_state_schema=descriptor["writes_state_schema"],
        file_count=len(descriptor["files"]),
    )
