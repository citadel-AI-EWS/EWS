#!/usr/bin/env python3
"""User-mode emergency launcher for the CITADEL Windows node.

This helper is intentionally narrow: it installs only the reviewed CITADEL
agent into the current user's profile, starts it with the bundled Python
runtime, and keeps it connected to the configured HTTPS Controller. It does
not provide a shell, elevate privileges, or disable Windows protections.
"""
from __future__ import annotations

import argparse
import json
import msvcrt
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_CONTROLLER = "https://citadel-ai.init1.workers.dev"
CONTROLLER_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
SERVICE_NAME = "CitadelEWSNode"
RESTART_EXIT_CODE = 75
STOP_EXIT_CODE = 76


def _env_path(name: str) -> Path:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is unavailable")
    return Path(value)


def roots() -> tuple[Path, Path, Path]:
    base = _env_path("LOCALAPPDATA") / "CitadelEWS"
    startup = (
        _env_path("APPDATA")
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / "CITADEL EWS Portable.cmd"
    )
    return base / "agent", base / "state", startup


def validate_controller(value: str) -> str:
    value = value.strip().rstrip("/")
    parsed = urlsplit(value)
    https = parsed.scheme == "https" and bool(parsed.hostname)
    loopback = (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    )
    if not (https or loopback):
        raise RuntimeError("Controller must use HTTPS; loopback HTTP is test-only")
    if parsed.username or parsed.password or parsed.fragment:
        raise RuntimeError("Controller URL contains unsupported components")
    return value


def creation_flags() -> int:
    return int(getattr(subprocess, "CREATE_NO_WINDOW", 0)) | int(
        getattr(subprocess, "DETACHED_PROCESS", 0)
    )


def service_running() -> bool:
    completed = subprocess.run(
        ["sc.exe", "query", SERVICE_NAME],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        creationflags=int(getattr(subprocess, "CREATE_NO_WINDOW", 0)),
        check=False,
    )
    return completed.returncode == 0 and "RUNNING" in completed.stdout.upper()


def atomic_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".new")
    temp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(temp, path)


def write_startup(startup: Path, agent_root: Path) -> None:
    pythonw = agent_root / "runtime" / "pythonw.exe"
    if not pythonw.exists():
        pythonw = agent_root / "runtime" / "python.exe"
    helper = agent_root / "portable_fallback.py"
    runtime = agent_root / "runtime"
    startup.parent.mkdir(parents=True, exist_ok=True)
    startup.write_text(
        "@echo off\r\n"
        "setlocal\r\n"
        f'set "PYTHONHOME={runtime}"\r\n'
        f'if not exist "{helper}" exit /b 0\r\n'
        f'start "" /b "{pythonw}" "{helper}" supervise\r\n'
        "exit /b 0\r\n",
        encoding="utf-8",
        newline="",
    )


def copy_payload(source: Path, agent_root: Path) -> None:
    source = source.resolve()
    agent_root.mkdir(parents=True, exist_ok=True)
    if source != agent_root.resolve():
        runtime = source / "runtime"
        if not (runtime / "python.exe").exists():
            raise RuntimeError("bundled Python runtime is missing from portable package")
        shutil.copytree(runtime, agent_root / "runtime", dirs_exist_ok=True)
        for name in (
            "citadel_node_v1.py",
            "citadel_node_v2.py",
            "windows_enterprise_probe.ps1",
            "portable_fallback.py",
        ):
            src = source / name
            if not src.exists():
                raise RuntimeError(f"portable package file is missing: {name}")
            shutil.copy2(src, agent_root / name)
        if (source / "lmstudio").is_dir():
            shutil.copytree(
                source / "lmstudio",
                agent_root / "lmstudio",
                dirs_exist_ok=True,
            )


def agent_env(agent_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONHOME"] = str(agent_root / "runtime")
    env["CITADEL_SUPERVISED"] = "1"
    return env


def run_self_test(agent_root: Path) -> None:
    python = agent_root / "runtime" / "python.exe"
    agent = agent_root / "citadel_node_v2.py"
    completed = subprocess.run(
        [str(python), str(agent), "self-test"],
        cwd=str(agent_root),
        env=agent_env(agent_root),
        creationflags=int(getattr(subprocess, "CREATE_NO_WINDOW", 0)),
        check=False,
        timeout=90,
    )
    if completed.returncode != 0:
        raise RuntimeError("bundled CITADEL self-test failed")


def launch_supervisor(agent_root: Path) -> None:
    pythonw = agent_root / "runtime" / "pythonw.exe"
    if not pythonw.exists():
        pythonw = agent_root / "runtime" / "python.exe"
    helper = agent_root / "portable_fallback.py"
    subprocess.Popen(
        [str(pythonw), str(helper), "supervise"],
        cwd=str(agent_root),
        env=agent_env(agent_root),
        creationflags=creation_flags(),
        close_fds=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def install(source: Path, controller: str) -> int:
    if os.name != "nt":
        raise RuntimeError("portable fallback is Windows-only")
    if service_running():
        print("CITADEL Windows Service is already running; portable fallback is not needed.")
        return 0

    agent_root, state_root, startup = roots()
    controller = validate_controller(controller)
    copy_payload(source, agent_root)
    state_root.mkdir(parents=True, exist_ok=True)

    config = {
        "controller_url": controller,
        "data_dir": str(state_root),
        "poll_seconds": 30,
        "heartbeat_seconds": 30,
        "request_timeout_seconds": 30,
        "max_cpu_percent": 90,
        "max_memory_percent": 90,
        "prevent_automatic_sleep": True,
        "network_recovery_enabled": True,
        "allowed_wifi_profiles": [],
        "controller_public_x": CONTROLLER_PUBLIC_X,
    }
    atomic_json(state_root / "config.json", config)
    (state_root / "install-mode.txt").write_text(
        "windows_user_portable\n", encoding="utf-8"
    )
    write_startup(startup, agent_root)
    run_self_test(agent_root)

    if (state_root / "STOP").exists():
        print("Portable CITADEL installed, but STOP is active; it was not started.")
        return 0

    launch_supervisor(agent_root)
    print("CITADEL portable fallback installed.")
    print(f"Controller: {controller}")
    print("The node will enroll automatically when the Controller is reachable.")
    return 0


def terminate_tree(pid: int) -> None:
    subprocess.run(
        ["taskkill.exe", "/PID", str(pid), "/T", "/F"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=int(getattr(subprocess, "CREATE_NO_WINDOW", 0)),
        check=False,
    )


def supervise() -> int:
    if os.name != "nt":
        return 2
    agent_root, state_root, _ = roots()
    if service_running() or (state_root / "STOP").exists():
        return 0

    lock_path = state_root / "portable-supervisor.lock"
    state_root.mkdir(parents=True, exist_ok=True)
    lock = lock_path.open("a+b")
    if lock.tell() == 0:
        lock.write(b"0")
        lock.flush()
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        lock.close()
        return 0

    pid_path = state_root / "portable-supervisor.pid"
    pid_path.write_text(str(os.getpid()) + "\n", encoding="ascii")

    python = agent_root / "runtime" / "python.exe"
    agent = agent_root / "citadel_node_v2.py"
    config = state_root / "config.json"

    try:
        while True:
            if service_running() or (state_root / "STOP").exists():
                return 0
            child = subprocess.Popen(
                [str(python), str(agent), "run", "--config", str(config)],
                cwd=str(agent_root),
                env=agent_env(agent_root),
                creationflags=int(getattr(subprocess, "CREATE_NO_WINDOW", 0)),
                close_fds=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            while child.poll() is None:
                if service_running() or (state_root / "STOP").exists():
                    terminate_tree(child.pid)
                    return 0
                time.sleep(2)
            code = int(child.returncode or 0)
            if code == STOP_EXIT_CODE:
                return 0
            if code == RESTART_EXIT_CODE:
                continue
            time.sleep(5)
    finally:
        try:
            pid_path.unlink(missing_ok=True)
        finally:
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            finally:
                lock.close()


def uninstall(purge_state: bool) -> int:
    if os.name != "nt":
        raise RuntimeError("portable fallback is Windows-only")
    agent_root, state_root, startup = roots()
    startup.unlink(missing_ok=True)

    pid_path = state_root / "portable-supervisor.pid"
    if pid_path.exists():
        try:
            pid = int(pid_path.read_text(encoding="ascii").strip())
            if pid > 0 and pid != os.getpid():
                terminate_tree(pid)
                time.sleep(1)
        except (OSError, ValueError):
            pass

    if agent_root.exists():
        shutil.rmtree(agent_root, ignore_errors=False)
    pid_path.unlink(missing_ok=True)
    (state_root / "portable-supervisor.lock").unlink(missing_ok=True)
    if purge_state and state_root.exists():
        shutil.rmtree(state_root, ignore_errors=False)

    print("CITADEL portable fallback removed.")
    if not purge_state:
        print("Node identity/state was preserved for later normal installation.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    install_parser = sub.add_parser("install")
    install_parser.add_argument("--source", required=True)
    install_parser.add_argument("--controller", default=DEFAULT_CONTROLLER)

    sub.add_parser("supervise")

    uninstall_parser = sub.add_parser("uninstall")
    uninstall_parser.add_argument("--purge-state", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "install":
        return install(Path(args.source), args.controller)
    if args.command == "supervise":
        return supervise()
    if args.command == "uninstall":
        return uninstall(bool(args.purge_state))
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"CITADEL portable fallback failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
