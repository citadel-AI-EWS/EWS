#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import psutil

STARTUP_NAMES = ("CITADEL EWS Agent.cmd", "CITADEL EWS Agent.lnk")
MUTABLE_STATE_FILES = ("pending-results.json", "network-recovery.json", "lmstudio-state.json", "PAUSED")
MARKER_NAME = "legacy-cutover.json"
HOLD_NAME = "SERVICE_HOLD"
READY_NAME = "SERVICE_READY"


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            Path(temp_name).unlink()
        except FileNotFoundError:
            pass


def atomic_copy(source: Path, destination: Path) -> None:
    atomic_write(destination, source.read_bytes())


def read_identity(path: Path) -> str | None:
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    node_id = str(value.get("node_id") or "").strip() if isinstance(value, dict) else ""
    return node_id if node_id.startswith("node_") else None


def profile_roots(profiles_root: Path | None = None) -> list[Path]:
    candidates: list[Path] = []
    local_app = os.environ.get("LOCALAPPDATA")
    if local_app:
        try:
            candidates.append(Path(local_app).resolve().parents[1])
        except (IndexError, OSError):
            pass

    root = profiles_root
    if root is None:
        system_drive = os.environ.get("SystemDrive", "C:")
        root = Path(system_drive + os.sep) / "Users"
    try:
        if root.is_dir():
            candidates.extend(path for path in root.iterdir() if path.is_dir())
    except OSError:
        pass

    unique: dict[str, Path] = {}
    for path in candidates:
        try:
            key = str(path.resolve()).lower()
        except OSError:
            key = str(path).lower()
        unique.setdefault(key, path)
    return list(unique.values())


def profile_layout(profile: Path) -> dict[str, Any]:
    local = profile / "AppData" / "Local" / "CitadelEWS"
    startup = profile / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
    return {
        "profile": profile,
        "agent_root": local / "agent",
        "state_root": local / "state",
        "startup_paths": [startup / name for name in STARTUP_NAMES],
    }


def relevant_profiles(profiles_root: Path | None = None) -> list[dict[str, Any]]:
    found = []
    for profile in profile_roots(profiles_root):
        layout = profile_layout(profile)
        if (
            layout["agent_root"].exists()
            or layout["state_root"].exists()
            or any(path.exists() for path in layout["startup_paths"])
        ):
            found.append(layout)
    return found


def write_marker(state_root: Path, value: dict[str, Any]) -> None:
    atomic_write(
        state_root / MARKER_NAME,
        (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    )


def load_marker(state_root: Path) -> dict[str, Any]:
    path = state_root / MARKER_NAME
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("invalid legacy cutover marker")
    return value


def migrate_identity(state_root: Path, profiles: list[dict[str, Any]]) -> str | None:
    state_root.mkdir(parents=True, exist_ok=True)
    destination = state_root / "identity.json"
    current = read_identity(destination)
    if current:
        return current

    identities: dict[str, Path] = {}
    for layout in profiles:
        source = layout["state_root"] / "identity.json"
        node_id = read_identity(source)
        if node_id:
            identities.setdefault(node_id, source)

    if len(identities) > 1:
        raise RuntimeError(
            "multiple distinct legacy CITADEL node identities were found; refusing to guess which one owns this machine"
        )
    if not identities:
        return None

    node_id, source = next(iter(identities.items()))
    atomic_copy(source, destination)
    if read_identity(destination) != node_id:
        raise RuntimeError("legacy identity migration verification failed")
    return node_id


def stage_cutover(app_root: Path, state_root: Path, profiles_root: Path | None = None) -> dict[str, Any]:
    profiles = relevant_profiles(profiles_root)
    destination_identity = read_identity(state_root / "identity.json")
    needs_cutover = any(
        layout["agent_root"].exists() or any(path.exists() for path in layout["startup_paths"])
        for layout in profiles
    ) or (
        destination_identity is None
        and any(read_identity(layout["state_root"] / "identity.json") for layout in profiles)
    )
    if not needs_cutover:
        return {"active": False}

    expected_node_id = migrate_identity(state_root, profiles)

    # Preserve pause intent before the replacement supervisor starts.
    if expected_node_id and not (state_root / "PAUSED").exists():
        for layout in profiles:
            if read_identity(layout["state_root"] / "identity.json") == expected_node_id:
                paused = layout["state_root"] / "PAUSED"
                if paused.is_file():
                    atomic_copy(paused, state_root / "PAUSED")
                    break

    state_root.mkdir(parents=True, exist_ok=True)
    atomic_write(state_root / HOLD_NAME, b"one-click legacy cutover hold\n")
    try:
        (state_root / READY_NAME).unlink()
    except FileNotFoundError:
        pass

    marker = {
        "schema": "citadel.windows-legacy-cutover.v1",
        "active": True,
        "app_root": str(app_root.resolve()),
        "state_root": str(state_root.resolve()),
        "expected_node_id": expected_node_id,
        "profiles": [str(layout["profile"].resolve()) for layout in profiles],
        "staged_at": time.time(),
    }
    write_marker(state_root, marker)
    return marker


def _norm(path: str | Path | None) -> str:
    if not path:
        return ""
    try:
        return str(Path(path).resolve()).lower()
    except OSError:
        return str(path).lower()


def managed_tree(app_root: Path) -> tuple[list[psutil.Process], list[psutil.Process]]:
    host_path = _norm(app_root / "CitadelNodeService.exe")
    python_path = _norm(app_root / "runtime" / "python.exe")
    hosts: list[psutil.Process] = []
    agents: list[psutil.Process] = []

    for process in psutil.process_iter(["pid", "ppid", "exe", "cmdline"], ad_value=None):
        try:
            exe = _norm(process.info.get("exe"))
            cmdline = " ".join(process.info.get("cmdline") or []).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if exe == host_path:
            hosts.append(process)
        if exe == python_path and "citadel_node_v2.py" in cmdline:
            agents.append(process)
    return hosts, agents


def wait_for_managed_tree(app_root: Path, timeout_seconds: float) -> tuple[int, int]:
    deadline = time.monotonic() + timeout_seconds
    stable = 0
    last: tuple[int, int] | None = None
    while time.monotonic() < deadline:
        hosts, agents = managed_tree(app_root)
        valid = (
            len(hosts) == 1
            and len(agents) == 1
            and agents[0].ppid() == hosts[0].pid
        )
        current = (hosts[0].pid, agents[0].pid) if valid else None
        if valid and current == last:
            stable += 1
            if stable >= 3:
                return current
        else:
            stable = 1 if valid else 0
            last = current
        time.sleep(1.0)
    raise RuntimeError("replacement Windows supervisor did not reach a stable single-host/single-agent state")


def verify_agent_version(app_root: Path, expected_version: str) -> None:
    source = app_root / "citadel_node_v2.py"
    if not source.is_file():
        raise RuntimeError("installed citadel_node_v2.py is missing")
    match = re.search(r'(?m)^VERSION\s*=\s*"([^"]+)"', source.read_text(encoding="utf-8"))
    actual = match.group(1) if match else ""
    if actual != expected_version:
        raise RuntimeError(f"installed agent version mismatch: expected {expected_version}, got {actual or 'unknown'}")


def legacy_processes(profiles: list[dict[str, Any]]) -> list[psutil.Process]:
    needles = []
    for layout in profiles:
        needles.extend((_norm(layout["agent_root"]), _norm(layout["state_root"])))
    needles = [value for value in needles if value]

    matches: list[psutil.Process] = []
    for process in psutil.process_iter(["pid", "cmdline"], ad_value=None):
        if process.pid == os.getpid():
            continue
        try:
            cmd = " ".join(process.info.get("cmdline") or []).lower()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
        if not ("citadel_node_v1.py" in cmd or "citadel_node_v2.py" in cmd):
            continue
        if any(needle in cmd for needle in needles):
            matches.append(process)
    return matches


def startup_backups(profiles: list[dict[str, Any]]) -> dict[Path, bytes]:
    backups: dict[Path, bytes] = {}
    for layout in profiles:
        for path in layout["startup_paths"]:
            try:
                if path.is_file():
                    backups[path] = path.read_bytes()
            except OSError as exc:
                raise RuntimeError(f"cannot read legacy Startup artifact: {path}") from exc
    return backups


def restore_startup(backups: dict[Path, bytes]) -> None:
    for path, data in backups.items():
        atomic_write(path, data)


def best_effort_restart_legacy(backups: dict[Path, bytes]) -> None:
    if os.name != "nt" or not backups:
        return
    for path in backups:
        try:
            os.startfile(str(path))  # type: ignore[attr-defined]
            return
        except OSError:
            continue


def stop_legacy_processes(profiles: list[dict[str, Any]]) -> None:
    candidates = legacy_processes(profiles)
    for process in candidates:
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied as exc:
            raise RuntimeError(f"cannot stop legacy CITADEL process {process.pid}") from exc

    gone, alive = psutil.wait_procs(candidates, timeout=7)
    for process in alive:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied as exc:
            raise RuntimeError(f"cannot kill legacy CITADEL process {process.pid}") from exc
    if alive:
        _, alive = psutil.wait_procs(alive, timeout=5)
    if alive or legacy_processes(profiles):
        raise RuntimeError("legacy CITADEL user-mode process remained alive after cutover")


def migrate_mutable_state(state_root: Path, profiles: list[dict[str, Any]], expected_node_id: str | None) -> None:
    if not expected_node_id:
        return
    for layout in profiles:
        if read_identity(layout["state_root"] / "identity.json") != expected_node_id:
            continue
        for name in MUTABLE_STATE_FILES:
            source = layout["state_root"] / name
            destination = state_root / name
            if source.is_file() and not destination.exists():
                atomic_copy(source, destination)


def commit_cutover(
    app_root: Path,
    state_root: Path,
    expected_version: str,
    timeout_seconds: float = 35.0,
    profiles_root: Path | None = None,
) -> None:
    marker = load_marker(state_root)
    if not marker.get("active"):
        return
    expected_node_id = marker.get("expected_node_id") or read_identity(state_root / "identity.json")
    verify_agent_version(app_root, expected_version)
    wait_for_managed_tree(app_root, timeout_seconds)

    profiles = relevant_profiles(profiles_root)
    backups = startup_backups(profiles)
    try:
        for path in backups:
            path.unlink(missing_ok=True)
        stop_legacy_processes(profiles)
        migrate_mutable_state(state_root, profiles, expected_node_id)

        hold = state_root / HOLD_NAME
        hold.unlink()
        try:
            (state_root / READY_NAME).unlink()
        except FileNotFoundError:
            pass
        try:
            (state_root / MARKER_NAME).unlink()
        except FileNotFoundError:
            pass
    except Exception:
        restore_startup(backups)
        if not legacy_processes(profiles):
            best_effort_restart_legacy(backups)
        raise


def abort_cutover(state_root: Path) -> None:
    for name in (HOLD_NAME, READY_NAME, MARKER_NAME):
        try:
            (state_root / name).unlink()
        except FileNotFoundError:
            pass


def uninstall_legacy(profiles_root: Path | None = None) -> None:
    profiles = relevant_profiles(profiles_root)
    backups = startup_backups(profiles)
    for path in backups:
        path.unlink(missing_ok=True)
    stop_legacy_processes(profiles)
    for layout in profiles:
        try:
            shutil.rmtree(layout["agent_root"], ignore_errors=True)
        except OSError:
            pass


def self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="citadel-legacy-cutover-") as tmp:
        root = Path(tmp)
        users = root / "Users"
        alice = users / "Alice"
        state = alice / "AppData" / "Local" / "CitadelEWS" / "state"
        startup = alice / "AppData" / "Roaming" / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
        state.mkdir(parents=True)
        startup.mkdir(parents=True)
        (state / "identity.json").write_text(
            json.dumps({"node_id": "node_selftest", "private": "test"}) + "\n",
            encoding="utf-8",
        )
        (startup / STARTUP_NAMES[0]).write_bytes(b"@echo off\r\n")
        destination = root / "ProgramData" / "CitadelEWS" / "state"
        app_root = root / "ProgramData" / "CitadelEWS" / "agent"
        app_root.mkdir(parents=True)

        marker = stage_cutover(app_root, destination, users)
        assert marker["expected_node_id"] == "node_selftest"
        assert read_identity(destination / "identity.json") == "node_selftest"
        assert (destination / HOLD_NAME).is_file()
        assert (destination / MARKER_NAME).is_file()
        backups = startup_backups(relevant_profiles(users))
        assert len(backups) == 1
        abort_cutover(destination)
        assert not (destination / HOLD_NAME).exists()
        assert not (destination / MARKER_NAME).exists()

    print("CITADEL Windows legacy cutover SELF TEST: PASS")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CITADEL Windows legacy lifecycle migration helper")
    parser.add_argument("command", choices=["stage", "commit", "abort", "uninstall", "self-test"])
    parser.add_argument("--app-root", type=Path)
    parser.add_argument("--state-root", type=Path)
    parser.add_argument("--profiles-root", type=Path)
    parser.add_argument("--expected-version", default="")
    parser.add_argument("--timeout", type=float, default=35.0)
    args = parser.parse_args(argv)

    if args.command == "self-test":
        return self_test()
    if args.command == "uninstall":
        uninstall_legacy(args.profiles_root)
        if args.state_root is not None:
            abort_cutover(args.state_root.resolve())
        return 0
    if args.state_root is None:
        parser.error("--state-root is required")
    state_root = args.state_root.resolve()

    if args.command == "abort":
        abort_cutover(state_root)
        return 0
    if args.app_root is None:
        parser.error("--app-root is required")
    app_root = args.app_root.resolve()

    if args.command == "stage":
        stage_cutover(app_root, state_root, args.profiles_root)
        return 0
    if not args.expected_version:
        parser.error("--expected-version is required for commit")
    commit_cutover(app_root, state_root, args.expected_version, args.timeout, args.profiles_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
