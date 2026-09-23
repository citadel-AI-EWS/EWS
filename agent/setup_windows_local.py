#!/usr/bin/env python3
"""No-admin Windows installer for the CITADEL local agent."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

VERSION = "0.3.16"
DEFAULT_CONTROLLER = "https://citadel-ai.init1.workers.dev"
RESTART_CODE = 75
STOP_CODE = 76


def default_local_app_data() -> Path:
    value = os.environ.get("LOCALAPPDATA")
    if not value:
        raise RuntimeError("LOCALAPPDATA is unavailable")
    return Path(value).resolve()


def startup_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is unavailable")
    return Path(appdata).resolve() / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_manifest(root: Path) -> None:
    manifest = root / "SHA256SUMS.txt"
    if not manifest.is_file():
        raise RuntimeError("SHA256SUMS.txt is missing")
    for raw in manifest.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line:
            continue
        if "  " not in line:
            raise RuntimeError("invalid package manifest")
        digest, name = line.split("  ", 1)
        if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest.lower()):
            raise RuntimeError("invalid package hash")
        target = (root / name).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError as exc:
            raise RuntimeError("unsafe package path") from exc
        if not target.is_file():
            raise RuntimeError(f"package file missing: {name}")
        if sha256(target) != digest.lower():
            raise RuntimeError(f"package hash mismatch: {name}")


def select_runtime(root: Path) -> Path:
    machine = os.environ.get("PROCESSOR_ARCHITEW6432") or os.environ.get("PROCESSOR_ARCHITECTURE") or ""
    token = machine.strip().upper()
    if token == "AMD64":
        runtime = root / "python-runtime-amd64"
    elif token in {"X86", "I386"}:
        runtime = root / "python-runtime-win32"
    elif token == "ARM64":
        runtime = root / "python-runtime-arm64"
    else:
        raise RuntimeError(f"unsupported Windows architecture: {token or 'unknown'}")
    python = runtime / "python.exe"
    if not python.is_file():
        raise RuntimeError(f"bundled Python runtime missing for {token}")
    return runtime


def kill_existing(install_root: Path) -> None:
    try:
        import psutil
    except Exception:
        return
    prefix = str(install_root.resolve()).lower()
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            if proc.pid == os.getpid():
                continue
            cmdline = " ".join(proc.info.get("cmdline") or []).lower()
            if prefix in cmdline and ("local_watchdog.py" in cmdline or "citadel_node_v2.py" in cmdline):
                proc.terminate()
                try:
                    proc.wait(timeout=8)
                except psutil.TimeoutExpired:
                    proc.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue


def write_watchdog(path: Path) -> None:
    path.write_text(
        '''from __future__ import annotations
import subprocess, sys, time
from pathlib import Path

root = Path(__file__).resolve().parent
python = root / "python-runtime" / "python.exe"
agent = root / "citadel_node_v2.py"
config = root / "config.json"

while True:
    result = subprocess.run([str(python), str(agent), "run", "--config", str(config)], cwd=root)
    if result.returncode == 76:
        break
    if result.returncode == 75:
        time.sleep(1)
        continue
    time.sleep(5)
''',
        encoding="utf-8",
        newline="\n",
    )


def write_startup(startup: Path, installed_root: Path) -> Path:
    startup.mkdir(parents=True, exist_ok=True)
    target = startup / "CITADEL Local Agent.cmd"
    pythonw = installed_root / "python-runtime" / "pythonw.exe"
    watchdog = installed_root / "local_watchdog.py"
    target.write_text(
        '@echo off\r\n'
        f'start "" "{pythonw}" "{watchdog}"\r\n'
        'exit /b 0\r\n',
        encoding="utf-8",
        newline="",
    )
    return target


def launch(installed_root: Path) -> None:
    pythonw = installed_root / "python-runtime" / "pythonw.exe"
    watchdog = installed_root / "local_watchdog.py"
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen(
        [str(pythonw), str(watchdog)],
        cwd=installed_root,
        creationflags=flags,
        close_fds=True,
    )


def run_checked(argv: list[str], cwd: Path, label: str) -> None:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=180)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or label).strip()
        raise RuntimeError(f"{label}: {detail[:1000]}")


def install(args: argparse.Namespace) -> int:
    if os.name != "nt":
        raise RuntimeError("local Windows installer can only run on Windows")
    source = Path(__file__).resolve().parent
    verify_manifest(source)
    runtime_source = select_runtime(source)

    base = default_local_app_data()
    install_root = Path(args.install_root).expanduser().resolve() if args.install_root else base / "CitadelEWS" / "local-agent"
    state_root = Path(args.state_root).expanduser().resolve() if args.state_root else base / "CitadelEWS" / "state"
    install_root.mkdir(parents=True, exist_ok=True)
    state_root.mkdir(parents=True, exist_ok=True)

    kill_existing(install_root)
    runtime_target = install_root / "python-runtime"
    if runtime_target.exists():
        shutil.rmtree(runtime_target)
    shutil.copytree(runtime_source, runtime_target)

    for name in ("citadel_node_v1.py", "citadel_node_v2.py", "windows_enterprise_probe.ps1"):
        src = source / name
        if not src.is_file():
            raise RuntimeError(f"required agent file missing: {name}")
        shutil.copy2(src, install_root / name)

    write_watchdog(install_root / "local_watchdog.py")
    config = {
        "controller_url": args.controller_url.rstrip("/"),
        "data_dir": str(state_root),
        "poll_seconds": 30,
        "heartbeat_seconds": 30,
        "request_timeout_seconds": 30,
        "max_cpu_percent": 90,
        "max_memory_percent": 90,
        "prevent_automatic_sleep": True,
        "network_recovery_enabled": True,
        "allowed_wifi_profiles": [],
        "controller_public_x": "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0",
    }
    (install_root / "config.json").write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    python = runtime_target / "python.exe"
    agent = install_root / "citadel_node_v2.py"
    config_path = install_root / "config.json"
    run_checked([str(python), str(agent), "self-test"], install_root, "agent self-test failed")
    run_checked([str(python), str(agent), "doctor", "--config", str(config_path)], install_root, "agent doctor failed")
    if not args.skip_probe:
        run_checked([str(python), str(agent), "probe", "--config", str(config_path)], install_root, "Controller probe failed")

    if not args.no_autostart:
        write_startup(startup_dir(), install_root)
    if not args.no_start:
        launch(install_root)

    print("CITADEL Local Agent installed successfully.")
    print(f"Agent root: {install_root}")
    print(f"State root: {state_root}")
    print("No Administrator permission or system Python was used.")
    return 0


def uninstall(args: argparse.Namespace) -> int:
    base = default_local_app_data()
    install_root = Path(args.install_root).expanduser().resolve() if args.install_root else base / "CitadelEWS" / "local-agent"
    state_root = Path(args.state_root).expanduser().resolve() if args.state_root else base / "CitadelEWS" / "state"
    kill_existing(install_root)
    startup = startup_dir() / "CITADEL Local Agent.cmd"
    try:
        startup.unlink()
    except FileNotFoundError:
        pass
    if install_root.exists():
        shutil.rmtree(install_root)
    if args.purge_state and state_root.exists():
        shutil.rmtree(state_root)
    print("CITADEL Local Agent uninstalled.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller-url", default=DEFAULT_CONTROLLER)
    parser.add_argument("--install-root", default="")
    parser.add_argument("--state-root", default="")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--purge-state", action="store_true")
    parser.add_argument("--no-start", action="store_true")
    parser.add_argument("--no-autostart", action="store_true")
    parser.add_argument("--skip-probe", action="store_true")
    args = parser.parse_args()
    return uninstall(args) if args.uninstall else install(args)


if __name__ == "__main__":
    raise SystemExit(main())
