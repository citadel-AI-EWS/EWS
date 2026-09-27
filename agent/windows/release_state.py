#!/usr/bin/env python3
"""Crash-conscious release-state primitives for the Windows versioned layout.

This module deliberately contains no networking, Service/Task mutation, model
management, download logic, GC, or rollback policy. It is the single format and
path-policy foundation that later installer and remote-update code can share.
"""
from __future__ import annotations

import ctypes
import dataclasses
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

RELEASE_STATE_SCHEMA = 1
RELEASE_LAYOUT = "versioned-v1"
_RELEASE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ReleaseStateError(RuntimeError):
    pass


@dataclasses.dataclass(frozen=True)
class ReleaseState:
    generation: int
    current: str
    previous: str | None
    previous_rollbackable: bool
    state_schema: int
    committed_at: str
    min_allowed_generation: int = 1
    schema: int = RELEASE_STATE_SCHEMA
    layout: str = RELEASE_LAYOUT

    def to_dict(self) -> dict[str, Any]:
        validate_release_state(self)
        return {
            "schema": self.schema,
            "layout": self.layout,
            "generation": self.generation,
            "min_allowed_generation": self.min_allowed_generation,
            "current": self.current,
            "previous": self.previous,
            "previous_rollbackable": self.previous_rollbackable,
            "state_schema": self.state_schema,
            "committed_at": self.committed_at,
        }


def validate_release_id(value: str) -> str:
    candidate = str(value or "").strip()
    if not _RELEASE_ID_RE.fullmatch(candidate):
        raise ReleaseStateError("invalid_release_id")
    if candidate in {".", ".."}:
        raise ReleaseStateError("invalid_release_id")
    return candidate


def release_root(releases_root: Path, release_id: str) -> Path:
    """Resolve a release ID strictly beneath the fixed releases root."""
    safe_id = validate_release_id(release_id)
    root = releases_root.resolve()
    candidate = root / safe_id
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ReleaseStateError("release_path_escape") from exc
    if candidate.exists() and candidate.is_symlink():
        raise ReleaseStateError("release_path_reparse")
    return candidate


def validate_release_state(state: ReleaseState) -> ReleaseState:
    if state.schema != RELEASE_STATE_SCHEMA:
        raise ReleaseStateError("unsupported_release_state_schema")
    if state.layout != RELEASE_LAYOUT:
        raise ReleaseStateError("unsupported_release_layout")
    if not isinstance(state.generation, int) or isinstance(state.generation, bool) or state.generation < 1:
        raise ReleaseStateError("invalid_release_generation")
    if (
        not isinstance(state.min_allowed_generation, int)
        or isinstance(state.min_allowed_generation, bool)
        or state.min_allowed_generation < 1
        or state.min_allowed_generation > state.generation
    ):
        raise ReleaseStateError("invalid_min_allowed_generation")
    validate_release_id(state.current)
    if state.previous is not None:
        validate_release_id(state.previous)
        if state.previous == state.current:
            raise ReleaseStateError("duplicate_current_previous_release")
    elif state.previous_rollbackable:
        raise ReleaseStateError("rollbackable_previous_missing")
    if not isinstance(state.previous_rollbackable, bool):
        raise ReleaseStateError("invalid_previous_rollbackable")
    if not isinstance(state.state_schema, int) or isinstance(state.state_schema, bool) or state.state_schema < 1:
        raise ReleaseStateError("invalid_machine_state_schema")
    if not isinstance(state.committed_at, str) or not state.committed_at.strip():
        raise ReleaseStateError("invalid_committed_at")
    return state


def release_state_from_dict(value: dict[str, Any]) -> ReleaseState:
    if not isinstance(value, dict):
        raise ReleaseStateError("invalid_release_state")
    try:
        state = ReleaseState(
            schema=value.get("schema"),
            layout=value.get("layout"),
            generation=value.get("generation"),
            min_allowed_generation=value.get("min_allowed_generation", 1),
            current=value.get("current"),
            previous=value.get("previous"),
            previous_rollbackable=value.get("previous_rollbackable", False),
            state_schema=value.get("state_schema"),
            committed_at=value.get("committed_at"),
        )
    except TypeError as exc:
        raise ReleaseStateError("invalid_release_state") from exc
    return validate_release_state(state)


def load_release_state(path: Path) -> ReleaseState:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ReleaseStateError("release_state_unreadable") from exc
    if not raw.strip():
        raise ReleaseStateError("release_state_empty")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ReleaseStateError("release_state_corrupt") from exc
    return release_state_from_dict(value)


def serialize_release_state(state: ReleaseState) -> bytes:
    value = state.to_dict()
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def _windows_move_replace_write_through(source: Path, destination: Path) -> None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    move_file_ex = kernel32.MoveFileExW
    move_file_ex.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
    move_file_ex.restype = ctypes.c_bool

    movefile_replace_existing = 0x00000001
    movefile_write_through = 0x00000008
    ok = move_file_ex(
        str(source),
        str(destination),
        movefile_replace_existing | movefile_write_through,
    )
    if not ok:
        error = ctypes.get_last_error()
        raise OSError(error, f"MoveFileExW failed for {destination}")


def _posix_replace_and_sync(source: Path, destination: Path) -> None:
    os.replace(source, destination)
    directory_fd = os.open(str(destination.parent), os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def atomic_commit_release_state(path: Path, state: ReleaseState) -> None:
    """Durably replace the committed state with one self-consistent blob.

    The temp file is written on the same volume, flushed, then name-replaced.
    Windows uses MOVEFILE_WRITE_THROUGH. Readers therefore observe either the
    previous complete JSON blob or the new complete JSON blob, never two
    independently updated current/previous pointer files.
    """
    validate_release_state(state)
    path.parent.mkdir(parents=True, exist_ok=True)

    if path.exists():
        previous = load_release_state(path)
        if state.generation <= previous.generation:
            raise ReleaseStateError("release_generation_not_monotonic")
        if state.min_allowed_generation < previous.min_allowed_generation:
            raise ReleaseStateError("min_allowed_generation_regressed")

    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(serialize_release_state(state))
            stream.flush()
            os.fsync(stream.fileno())

        if os.name == "nt":
            _windows_move_replace_write_through(temp_path, path)
        else:
            _posix_replace_and_sync(temp_path, path)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass

    committed = load_release_state(path)
    if committed != state:
        raise ReleaseStateError("release_state_commit_verification_failed")
