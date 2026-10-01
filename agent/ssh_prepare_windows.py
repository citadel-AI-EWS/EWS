#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess  # nosec B404 - fixed Windows system executables only; never shell=True.
import sys
import time
from pathlib import Path

import psutil

import ssh_configurator

USER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class BootstrapError(RuntimeError):
    pass


def run_fixed(executable: Path, *args: str, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    if not executable.is_file():
        raise BootstrapError(f"required executable missing: {executable}")
    try:
        return subprocess.run(  # nosec B603
            [str(executable), *args],
            shell=False,
            check=False,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise BootstrapError(f"command timed out: {executable.name}") from exc


def require_success(result: subprocess.CompletedProcess[str], label: str) -> None:
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().replace("\r", " ").replace("\n", " ")
        raise BootstrapError(f"{label} failed ({result.returncode}): {detail[:300]}")


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def write_state(state_root: Path, *, configured: bool, status: str, user: str | None) -> None:
    directory = state_root / "ssh-bootstrap"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "state.json"
    temp = directory / "state.json.new"
    payload = {
        "schema": "citadel.ssh-bootstrap.v1",
        "platform": "windows",
        "configured": bool(configured),
        "status": status,
        "user": user,
        "config_path": str(Path(os.environ.get("PROGRAMDATA") or r"C:\ProgramData") / "ssh" / "sshd_config"),
        "updated_at_epoch": int(time.time()),
        "private_keys_stored": False,
        "public_port_opened": False,
    }
    temp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, target)


def local_user_exists(net_exe: Path, user: str) -> bool:
    result = run_fixed(net_exe, "user", user, timeout=30)
    return result.returncode == 0


def find_openssh() -> tuple[Path, Path, Path]:
    windir = Path(os.environ.get("WINDIR") or r"C:\Windows")
    root = windir / "System32" / "OpenSSH"
    return root / "sshd.exe", root / "ssh-keygen.exe", root / "sshd_config_default"


def install_openssh(dism: Path) -> None:
    result = run_fixed(
        dism,
        "/Online",
        "/Add-Capability",
        "/CapabilityName:OpenSSH.Server~~~~0.0.1.0",
        "/NoRestart",
        timeout=1800,
    )
    require_success(result, "Windows OpenSSH Server capability installation")


def service_control(sc_exe: Path, action: str, *extra: str, allow_missing: bool = False) -> int:
    result = run_fixed(sc_exe, action, "sshd", *extra, timeout=60)
    if result.returncode != 0 and not allow_missing:
        require_success(result, f"sc.exe {action} sshd")
    return result.returncode


def wait_service(sc_exe: Path, desired: str, timeout: float = 20.0) -> None:
    deadline = time.monotonic() + timeout
    desired_upper = desired.upper()
    while time.monotonic() < deadline:
        result = run_fixed(sc_exe, "query", "sshd", timeout=20)
        text = (result.stdout or "") + "\n" + (result.stderr or "")
        if result.returncode == 0 and desired_upper in text.upper():
            return
        time.sleep(0.4)
    raise BootstrapError(f"sshd service did not reach {desired}")


def stop_sshd(sc_exe: Path) -> bool:
    query = run_fixed(sc_exe, "query", "sshd", timeout=30)
    if query.returncode != 0:
        return False
    text = (query.stdout or "").upper()
    was_running = "RUNNING" in text
    if was_running:
        result = run_fixed(sc_exe, "stop", "sshd", timeout=60)
        if result.returncode not in {0, 1062}:
            require_success(result, "stop sshd")
        wait_service(sc_exe, "STOPPED", timeout=30)
    return was_running


def start_sshd(sc_exe: Path) -> None:
    config = run_fixed(sc_exe, "config", "sshd", "start=", "auto", timeout=30)
    require_success(config, "configure sshd automatic start")
    start = run_fixed(sc_exe, "start", "sshd", timeout=60)
    if start.returncode not in {0, 1056}:
        require_success(start, "start sshd")
    wait_service(sc_exe, "RUNNING", timeout=30)


def validate_sshd(sshd: Path, config: Path) -> None:
    result = run_fixed(sshd, "-t", "-f", str(config), timeout=30)
    require_success(result, f"sshd config validation: {config}")


def verify_loopback_listener() -> list[str]:
    listeners: list[str] = []
    try:
        for connection in psutil.net_connections(kind="inet"):
            if connection.status != psutil.CONN_LISTEN or not connection.laddr:
                continue
            if int(connection.laddr.port) != 22:
                continue
            listeners.append(str(connection.laddr.ip))
    except (psutil.Error, OSError) as exc:
        raise BootstrapError("unable to inspect SSH listener exposure") from exc
    unique = sorted(set(listeners))
    if not unique:
        raise BootstrapError("sshd did not create a listener on port 22")
    if any(value not in {"127.0.0.1", "::1"} for value in unique):
        raise BootstrapError("sshd exposed a non-loopback listener")
    return unique


def resolve_paths(args: argparse.Namespace) -> dict[str, Path]:
    release_root = Path(args.release_root).resolve()
    state_root = Path(args.state_root).resolve()
    python_path = Path(args.python_path).resolve() if args.python_path else (
        release_root / ".venv" / "Scripts" / "python.exe"
    )
    if not python_path.is_file():
        bundled = release_root / "runtime" / "python.exe"
        if bundled.is_file():
            python_path = bundled
    agent_config = Path(args.agent_config).resolve() if args.agent_config else (
        release_root / "config.json"
    )
    if not agent_config.is_file():
        state_config = state_root / "config.json"
        if state_config.is_file():
            agent_config = state_config
    return {
        "release_root": release_root,
        "state_root": state_root,
        "python": python_path,
        "configurator": release_root / "ssh_configurator.py",
        "console": release_root / "ssh_restricted_console.py",
        "agent_config": agent_config,
    }


def configure(args: argparse.Namespace) -> None:
    if not is_admin():
        raise BootstrapError("Administrator privileges are required")
    user = str(args.ssh_user or "").strip()
    if not USER_RE.fullmatch(user):
        raise BootstrapError("invalid SSH username")

    paths = resolve_paths(args)
    for key in ("python", "configurator", "console", "agent_config"):
        if not paths[key].is_file():
            raise BootstrapError(f"required CITADEL SSH asset missing: {paths[key]}")

    windir = Path(os.environ.get("WINDIR") or r"C:\Windows")
    program_data = Path(os.environ.get("PROGRAMDATA") or r"C:\ProgramData")
    system32 = windir / "System32"
    sc_exe = system32 / "sc.exe"
    net_exe = system32 / "net.exe"
    dism = system32 / "dism.exe"
    sshd, ssh_keygen, default_config = find_openssh()

    if not sshd.is_file() and args.install_openssh:
        install_openssh(dism)
        sshd, ssh_keygen, default_config = find_openssh()
    if not sshd.is_file():
        write_state(paths["state_root"], configured=False, status="openssh_server_missing", user=user)
        raise BootstrapError("Windows OpenSSH Server is not installed")
    if not ssh_keygen.is_file():
        raise BootstrapError("OpenSSH ssh-keygen.exe is missing")
    if not local_user_exists(net_exe, user):
        write_state(paths["state_root"], configured=False, status="ssh_user_missing", user=user)
        raise BootstrapError("requested local Windows SSH user does not exist")

    ssh_root = program_data / "ssh"
    ssh_root.mkdir(parents=True, exist_ok=True)
    config_path = ssh_root / "sshd_config"
    if not config_path.is_file():
        if not default_config.is_file():
            raise BootstrapError("OpenSSH default sshd_config is missing")
        shutil.copy2(default_config, config_path)

    host_keys = list(ssh_root.glob("ssh_host_*_key"))
    if not host_keys:
        result = run_fixed(ssh_keygen, "-A", timeout=60)
        require_success(result, "OpenSSH host key generation")

    bootstrap_root = paths["state_root"] / "ssh-bootstrap"
    bootstrap_root.mkdir(parents=True, exist_ok=True)
    original = bootstrap_root / "sshd_config.original"
    prechange = bootstrap_root / "sshd_config.prechange"
    working = bootstrap_root / "sshd_config.citadel.new"
    if not original.is_file():
        shutil.copy2(config_path, original)

    text = config_path.read_text(encoding="utf-8-sig")
    rendered = ssh_configurator.render_config(
        text,
        user=user,
        python_path=str(paths["python"]),
        console_path=str(paths["console"]),
        agent_config_path=str(paths["agent_config"]),
    )
    working.write_text(rendered, encoding="utf-8", newline="\n")
    validate_sshd(sshd, working)

    shutil.copy2(config_path, prechange)
    was_running = stop_sshd(sc_exe)
    try:
        os.replace(working, config_path)
        validate_sshd(sshd, config_path)
        start_sshd(sc_exe)
        time.sleep(0.8)
        verify_loopback_listener()
        inspected = ssh_configurator.inspect_config(
            config_path.read_text(encoding="utf-8-sig"),
            user=user,
        )
        if not inspected.get("ready"):
            raise BootstrapError("installed SSH config does not satisfy CITADEL restricted policy")
    except Exception:
        service_control(sc_exe, "stop", allow_missing=True)
        shutil.copy2(prechange, config_path)
        try:
            validate_sshd(sshd, config_path)
            if was_running:
                start_sshd(sc_exe)
        finally:
            write_state(
                paths["state_root"],
                configured=False,
                status="rollback_after_verification_failure",
                user=user,
            )
        raise

    write_state(paths["state_root"], configured=True, status="ready", user=user)


def remove(args: argparse.Namespace) -> None:
    if not is_admin():
        raise BootstrapError("Administrator privileges are required")
    paths = resolve_paths(args)
    state_file = paths["state_root"] / "ssh-bootstrap" / "state.json"
    user: str | None = str(args.ssh_user or "").strip() or None
    if state_file.is_file():
        try:
            saved = json.loads(state_file.read_text(encoding="utf-8"))
            if not user:
                candidate = saved.get("user")
                if isinstance(candidate, str) and USER_RE.fullmatch(candidate):
                    user = candidate
        except (OSError, json.JSONDecodeError):
            pass

    program_data = Path(os.environ.get("PROGRAMDATA") or r"C:\ProgramData")
    windir = Path(os.environ.get("WINDIR") or r"C:\Windows")
    sc_exe = windir / "System32" / "sc.exe"
    sshd, _, _ = find_openssh()
    config_path = program_data / "ssh" / "sshd_config"
    original = paths["state_root"] / "ssh-bootstrap" / "sshd_config.original"
    if original.is_file() and sshd.is_file():
        validate_sshd(sshd, original)
        was_running = stop_sshd(sc_exe)
        shutil.copy2(original, config_path)
        validate_sshd(sshd, config_path)
        if was_running:
            start_sshd(sc_exe)
    write_state(paths["state_root"], configured=False, status="removed", user=user)


def main() -> int:
    if os.name != "nt":
        print("Windows-only SSH bootstrap.", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser()
    parser.add_argument("--release-root", required=True)
    parser.add_argument("--state-root", required=True)
    parser.add_argument("--ssh-user")
    parser.add_argument("--python-path")
    parser.add_argument("--agent-config")
    parser.add_argument("--install-openssh", action="store_true")
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()

    try:
        if args.remove:
            remove(args)
        else:
            configure(args)
    except (BootstrapError, OSError, ValueError) as exc:
        print(f"CITADEL SSH bootstrap failed: {exc}", file=sys.stderr)
        return 1
    print("CITADEL restricted SSH bootstrap: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
