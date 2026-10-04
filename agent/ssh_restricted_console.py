#!/usr/bin/env python3
"""Restricted interactive SSH console for CITADEL-managed computers.

This is designed to be used as an OpenSSH ForceCommand target. It deliberately
does not spawn a shell or arbitrary subprocess. Only the fixed read-only verbs
listed in ALLOWED_COMMANDS are accepted.
"""
from __future__ import annotations

import argparse
import getpass
import http.client
import json
import os
import platform
import shutil
import socket
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Callable

import psutil


ALLOWED_COMMANDS = (
    "help",
    "status",
    "hostname",
    "whoami",
    "uname -a",
    "python --version",
    "python3 --version",
    "uptime",
    "cpu",
    "memory",
    "disk",
    "network",
    "agent-status",
    "agent-logs",
    "lmstudio-status",
    "diagnostics",
    "ping-controller",
    "exit",
)


def default_state_dir() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("PROGRAMDATA") or r"C:\ProgramData") / "CitadelEWS" / "state"
    return Path(os.environ.get("CITADEL_STATE_ROOT") or Path.home() / ".local" / "state" / "citadel-node")


def load_config(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def format_bytes(value: int | float) -> str:
    number = float(value)
    for suffix in ("B", "KiB", "MiB", "GiB", "TiB"):
        if number < 1024 or suffix == "TiB":
            return f"{number:.1f} {suffix}"
        number /= 1024
    return f"{number:.1f} TiB"


def command_help() -> str:
    return "Allowed commands:\n  " + "\n  ".join(ALLOWED_COMMANDS)


def command_status() -> str:
    mem = psutil.virtual_memory()
    return "\n".join(
        (
            f"host: {socket.gethostname()}",
            f"os: {platform.system()} {platform.release()}",
            f"python: {platform.python_version()}",
            f"uptime_seconds: {max(0, int(time.time() - psutil.boot_time()))}",
            f"cpu_percent: {psutil.cpu_percent(interval=0.1):.1f}",
            f"memory_percent: {mem.percent:.1f}",
        )
    )


def command_hostname() -> str:
    return socket.gethostname()


def command_whoami() -> str:
    if os.name == "posix":
        import pwd
        return pwd.getpwuid(os.geteuid()).pw_name
    return getpass.getuser()


def command_uname() -> str:
    return " ".join(str(part) for part in platform.uname())


def command_python_version() -> str:
    return f"Python {platform.python_version()}"


def command_uptime() -> str:
    seconds = max(0, int(time.time() - psutil.boot_time()))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{days}d {hours:02d}:{minutes:02d}:{secs:02d}"


def command_cpu() -> str:
    return json.dumps(
        {
            "logical_count": psutil.cpu_count(logical=True),
            "physical_count": psutil.cpu_count(logical=False),
            "percent": psutil.cpu_percent(interval=0.2),
        },
        ensure_ascii=False,
    )


def command_memory() -> str:
    mem = psutil.virtual_memory()
    return json.dumps(
        {
            "total": format_bytes(mem.total),
            "available": format_bytes(mem.available),
            "used_percent": mem.percent,
        },
        ensure_ascii=False,
    )


def command_disk() -> str:
    root = Path.home().anchor or "/"
    usage = shutil.disk_usage(root)
    return json.dumps(
        {
            "path": str(root),
            "total": format_bytes(usage.total),
            "free": format_bytes(usage.free),
            "used_percent": round((usage.used / usage.total) * 100, 1) if usage.total else 0,
        },
        ensure_ascii=False,
    )


def command_network() -> str:
    rows = []
    try:
        stats = psutil.net_if_stats()
        addrs = psutil.net_if_addrs()
    except Exception:
        return "network inventory unavailable"
    for name, values in addrs.items():
        state = stats.get(name)
        ipv4 = [str(item.address) for item in values if item.family == socket.AF_INET]
        if not ipv4:
            continue
        rows.append(
            {
                "name": name[:120],
                "up": bool(state.isup) if state else None,
                "speed_mbps": int(state.speed) if state and state.speed >= 0 else None,
                "ipv4": ipv4[:8],
            }
        )
    return json.dumps(rows[:32], ensure_ascii=False, indent=2)


def command_agent_status() -> str:
    matches = []
    try:
        for proc in psutil.process_iter(["pid", "name", "cmdline"]):
            cmdline = " ".join(proc.info.get("cmdline") or [])
            if "citadel_node_v2.py" in cmdline or str(proc.info.get("name") or "").lower() == "citadelnodeservice.exe":
                matches.append({"pid": proc.info.get("pid"), "name": proc.info.get("name")})
    except Exception:
        pass
    return json.dumps({"running": bool(matches), "processes": matches[:8]}, ensure_ascii=False)


def _bounded_tail_lines(path: Path, max_bytes: int = 64 * 1024, max_lines: int = 40) -> str:
    try:
        size = path.stat().st_size
        with path.open("rb") as stream:
            truncated = size > max_bytes
            if truncated:
                stream.seek(-max_bytes, os.SEEK_END)
            raw = stream.read(max_bytes)
    except OSError:
        return "agent log unavailable"
    if truncated:
        split_at = raw.find(b"\n")
        raw = raw[split_at + 1 :] if split_at >= 0 else b""
    lines = raw.decode("utf-8", errors="replace").splitlines()
    return "\n".join(lines[-max_lines:]) or "(empty log)"


def command_agent_logs(config_path: Path) -> str:
    config = load_config(config_path)
    configured_dir = config.get("data_dir")
    candidates: list[Path] = []
    if isinstance(configured_dir, str) and configured_dir.strip():
        candidates.append(Path(configured_dir).expanduser())
    candidates.extend(
        [
            default_state_dir(),
            Path.home() / ".local" / "state" / "citadel-ews",
        ]
    )
    seen: set[str] = set()
    for root in candidates:
        path = root / "agent.jsonl"
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            return _bounded_tail_lines(path)
    return "agent log not found"


def command_lmstudio_status() -> str:
    conn = http.client.HTTPConnection("127.0.0.1", 1234, timeout=1.5)
    try:
        conn.request("GET", "/v1/models", headers={"accept": "application/json"})
        response = conn.getresponse()
        raw = response.read(64 * 1024)
        return f"HTTP {response.status}\n" + raw.decode("utf-8", errors="replace")[:12000]
    except OSError as error:
        return f"LM Studio unavailable: {type(error).__name__}"
    finally:
        conn.close()


def command_diagnostics() -> str:
    return "\n".join(
        (
            command_status(),
            "",
            "network:",
            command_network(),
            "",
            "agent:",
            command_agent_status(),
        )
    )


def controller_target(config_path: Path) -> tuple[str, int] | None:
    config = load_config(config_path)
    raw = str(config.get("controller_url") or "").strip()
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        return None
    if parsed.scheme == "http" and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        return None
    return parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)


def command_ping_controller(config_path: Path) -> str:
    target = controller_target(config_path)
    if not target:
        return "controller target unavailable"
    host, port = target
    try:
        started = time.monotonic()
        with socket.create_connection((host, port), timeout=2.0):
            elapsed = int((time.monotonic() - started) * 1000)
        return f"{host}:{port} reachable in {elapsed} ms"
    except OSError as error:
        return f"{host}:{port} unreachable: {type(error).__name__}"


def execute(command: str, config_path: Path) -> tuple[str, bool]:
    verb = command.strip()
    if not verb:
        return "", False
    if any(char in verb for char in (";", "|", "&", ">", "<", "`", "$", "\n", "\r")):
        return "DENIED: shell syntax is not supported.", False
    if verb not in ALLOWED_COMMANDS:
        return "DENIED: command is not in the CITADEL SSH allow-list. Type 'help'.", False
    if verb == "exit":
        return "Session closed.", True
    handlers: dict[str, Callable[[], str]] = {
        "help": command_help,
        "status": command_status,
        "hostname": command_hostname,
        "whoami": command_whoami,
        "uname -a": command_uname,
        "python --version": command_python_version,
        "python3 --version": command_python_version,
        "uptime": command_uptime,
        "cpu": command_cpu,
        "memory": command_memory,
        "disk": command_disk,
        "network": command_network,
        "agent-status": command_agent_status,
        "lmstudio-status": command_lmstudio_status,
        "diagnostics": command_diagnostics,
    }
    if verb == "agent-logs":
        return command_agent_logs(config_path), False
    if verb == "ping-controller":
        return command_ping_controller(config_path), False
    return handlers[verb](), False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config_path = Path(args.config).resolve()

    original = str(os.environ.get("SSH_ORIGINAL_COMMAND") or "").strip()
    if original:
        output, _ = execute(original, config_path)
        print(output)
        return 0 if not output.startswith("DENIED:") else 2

    print("CITADEL Restricted SSH Console")
    print("No shell, no arbitrary executables, no file mutation. Type 'help'.")
    while True:
        try:
            line = input("citadel> ")
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        output, should_exit = execute(line, config_path)
        if output:
            print(output)
        if should_exit:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
