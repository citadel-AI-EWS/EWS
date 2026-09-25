#!/usr/bin/env python3
"""User-mode CITADEL/EWS Windows installer.

Designed for an authorized user to launch from START_HERE.cmd.
It requires no administrator rights and does not register a Windows service.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import winreg
from pathlib import Path

VERSION = "0.3.16"
DEFAULT_CONTROLLER_URL = "https://citadel-ai.init1.workers.dev"
CONTROLLER_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
RUN_VALUE_NAME = "CitadelEWSQuickNode"


def log(message: str) -> None:
    print(f"[CITADEL] {message}", flush=True)


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def verify_package(root: Path) -> None:
    manifest = root / "SHA256SUMS.txt"
    if not manifest.is_file():
        fail("Package manifest SHA256SUMS.txt is missing.")
    checked = 0
    for raw in manifest.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            expected, rel = raw.split("  ", 1)
        except ValueError as exc:
            raise RuntimeError("Invalid package manifest.") from exc
        if not (len(expected) == 64 and all(ch in "0123456789abcdef" for ch in expected)):
            fail(f"Invalid package digest: {rel}")
        path = (root / rel).resolve()
        if root.resolve() != path and root.resolve() not in path.parents:
            fail("Unsafe package manifest path.")
        if not path.is_file():
            fail(f"Package file is missing: {rel}")
        if sha256(path) != expected:
            fail(f"Package integrity check failed: {rel}")
        checked += 1
    if checked < 5:
        fail("Package manifest is unexpectedly small.")
    log(f"Package integrity verified ({checked} files).")


def install_roots() -> tuple[Path, Path, Path]:
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if not local:
        fail("LOCALAPPDATA is unavailable.")
    base = (Path(local) / "CitadelEWS").resolve()
    release = base / "releases" / VERSION
    state = base / "state"
    return base, release, state


def release_payload_matches(package_root: Path, release_root: Path) -> bool:
    runtime_python = release_root / "runtime" / "python.exe"
    if not runtime_python.is_file():
        return False
    pairs = [
        (package_root / "citadel_node_v1.py", release_root / "citadel_node_v1.py"),
        (package_root / "citadel_node_v2.py", release_root / "citadel_node_v2.py"),
        (package_root / "quick_runner.py", release_root / "quick_runner.py"),
        (package_root / "windows_enterprise_probe.ps1", release_root / "windows_enterprise_probe.ps1"),
        (
            package_root / "lmstudio" / "install_llmstudio_headless.py",
            release_root / "lmstudio" / "install_llmstudio_headless.py",
        ),
    ]
    for source, destination in pairs:
        if not source.is_file() or not destination.is_file():
            return False
        try:
            if sha256(source) != sha256(destination):
                return False
        except OSError:
            return False
    return True


def copy_payload(package_root: Path, release_root: Path) -> None:
    release_root.parent.mkdir(parents=True, exist_ok=True)
    if release_root.exists() and release_payload_matches(package_root, release_root):
        log(f"Verified CITADEL Quick Agent {VERSION} release already exists; reusing it.")
        return

    staging = release_root.with_name(release_root.name + ".staging")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    for name in ("runtime", "citadel_node_v1.py", "citadel_node_v2.py", "quick_runner.py", "windows_enterprise_probe.ps1"):
        source = package_root / name
        target = staging / name
        if source.is_dir():
            shutil.copytree(source, target)
        elif source.is_file():
            shutil.copy2(source, target)
        else:
            fail(f"Required package component is missing: {name}")
    lm_source = package_root / "lmstudio"
    if not lm_source.is_dir():
        fail("LM Studio helper directory is missing.")
    shutil.copytree(lm_source, staging / "lmstudio")
    if release_root.exists():
        try:
            shutil.rmtree(release_root, ignore_errors=False)
        except OSError as exc:
            shutil.rmtree(staging, ignore_errors=True)
            fail(
                "An older/different Quick Agent release is currently in use. "
                "Close the running CITADEL Quick Agent or sign out, then run START_HERE.cmd again. "
                f"Windows reported: {exc}"
            )
    staging.replace(release_root)


def write_config(state_root: Path, controller_url: str) -> Path:
    state_root.mkdir(parents=True, exist_ok=True)
    config_path = state_root / "config.json"
    existing = {}
    if config_path.is_file():
        try:
            existing = json.loads(config_path.read_text(encoding="utf-8-sig"))
        except Exception:
            existing = {}
    if not isinstance(existing, dict):
        existing = {}
    config = {
        **existing,
        "controller_url": controller_url.rstrip("/"),
        "data_dir": str(state_root),
        "poll_seconds": 30,
        "heartbeat_seconds": 30,
        "request_timeout_seconds": 30,
        "max_cpu_percent": 90,
        "max_memory_percent": 90,
        "prevent_automatic_sleep": True,
        "network_recovery_enabled": True,
        "allowed_wifi_profiles": existing.get("allowed_wifi_profiles", []),
        "controller_public_x": CONTROLLER_PUBLIC_X,
    }
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return config_path


def run_checked(argv: list[str], *, env: dict[str, str] | None = None, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        shell=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"exit {result.returncode}").strip()
        fail(detail[:1200])
    return result


def set_user_autostart(release_root: Path, config_path: Path) -> None:
    pythonw = release_root / "runtime" / "pythonw.exe"
    runner = release_root / "quick_runner.py"
    if not pythonw.is_file():
        pythonw = release_root / "runtime" / "python.exe"
    command = f'"{pythonw}" "{runner}" --config "{config_path}"'
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run") as key:
        winreg.SetValueEx(key, RUN_VALUE_NAME, 0, winreg.REG_SZ, command)
    log("User-login autostart registered (HKCU only; no admin rights).")


def remove_user_autostart() -> None:
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.DeleteValue(key, RUN_VALUE_NAME)
    except FileNotFoundError:
        pass


def start_runner(release_root: Path, config_path: Path) -> None:
    pythonw = release_root / "runtime" / "pythonw.exe"
    if not pythonw.is_file():
        pythonw = release_root / "runtime" / "python.exe"
    runner = release_root / "quick_runner.py"
    flags = 0
    if os.name == "nt":
        flags = (
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    subprocess.Popen(
        [str(pythonw), str(runner), "--config", str(config_path)],
        cwd=str(release_root),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=flags,
    )


def lms_path(state_root: Path) -> Path | None:
    home = state_root / "lmstudio-runtime-home"
    candidates = [home / ".lmstudio" / "bin" / "lms.exe", home / ".lmstudio" / "bin" / "lms"]
    pointer = home / ".lmstudio-home-pointer"
    if pointer.is_file():
        try:
            target = Path(pointer.read_text(encoding="utf-8").strip()).expanduser()
            candidates.extend([target / "bin" / "lms.exe", target / "bin" / "lms"])
        except OSError:
            pass
    return next((item for item in candidates if item.is_file()), None)


def lm_env(state_root: Path) -> dict[str, str]:
    env = os.environ.copy()
    home = state_root / "lmstudio-runtime-home"
    home.mkdir(parents=True, exist_ok=True)
    env["HOME"] = str(home)
    env["CITADEL_LMSTUDIO_HOME"] = str(home)
    env["LMS_NO_MODIFY_PATH"] = "1"
    return env


def probe_lm_server(timeout_seconds: int = 45) -> bool:
    deadline = time.monotonic() + timeout_seconds
    token = os.environ.get("LM_API_TOKEN", "").strip()
    while time.monotonic() < deadline:
        try:
            headers = {"Accept": "application/json", "User-Agent": "CITADEL-EWS-Quick/0.3.16"}
            if token:
                headers["Authorization"] = "Bearer " + token
            request = urllib.request.Request("http://127.0.0.1:1234/v1/models", headers=headers)
            with urllib.request.urlopen(request, timeout=5) as response:
                raw = response.read(2 * 1024 * 1024)
                if 200 <= response.status < 300:
                    json.loads(raw.decode("utf-8") or "{}")
                    return True
        except Exception:
            time.sleep(1)
    return False


def install_and_verify_lmstudio(release_root: Path, state_root: Path) -> str:
    env = lm_env(state_root)
    lms = lms_path(state_root)
    if lms is None:
        helper = release_root / "lmstudio" / "install_llmstudio_headless.py"
        log("Installing verified LM Studio llmster (PowerShell is not used)...")
        run_checked([str(release_root / "runtime" / "python.exe"), str(helper)], env=env, timeout=1200)
        lms = lms_path(state_root)
    if lms is None:
        fail("LM Studio lms CLI is unavailable after bootstrap.")
    run_checked([str(lms), "daemon", "up"], env=env, timeout=180)
    server = subprocess.run(
        [str(lms), "server", "start", "--port", "1234", "--bind", "127.0.0.1"],
        capture_output=True,
        text=True,
        timeout=180,
        env=env,
        shell=False,
    )
    if server.returncode != 0:
        combined = ((server.stderr or "") + "\n" + (server.stdout or "")).lower()
        if "already" not in combined and "running" not in combined:
            fail((server.stderr or server.stdout or "LM Studio server failed").strip()[:1200])
    if not probe_lm_server():
        fail("LM Studio server did not answer http://127.0.0.1:1234/v1/models.")
    log("LM Studio server answered /v1/models on localhost:1234.")
    return "ready"


def install(controller_url: str, skip_lmstudio: bool, skip_enrollment: bool, no_start: bool) -> int:
    if os.name != "nt":
        fail("Quick Windows package can only be installed on Windows.")
    package_root = Path(__file__).resolve().parent
    verify_package(package_root)
    _, release_root, state_root = install_roots()
    copy_payload(package_root, release_root)
    config_path = write_config(state_root, controller_url)
    runtime_python = release_root / "runtime" / "python.exe"
    agent = release_root / "citadel_node_v2.py"

    log(f"Installing CITADEL Quick Agent {VERSION} for the current Windows user...")
    run_checked([str(runtime_python), str(agent), "self-test"], timeout=180)
    run_checked([str(runtime_python), str(agent), "doctor", "--config", str(config_path)], timeout=180)
    set_user_autostart(release_root, config_path)

    enrollment = "skipped" if skip_enrollment else "deferred"
    if not skip_enrollment:
        try:
            run_checked([str(runtime_python), str(agent), "once", "--config", str(config_path)], timeout=120)
            enrollment = "confirmed"
            log("Controller enrollment/heartbeat confirmed.")
        except Exception as exc:
            log(f"Controller is not reachable yet; background agent will retry automatically: {exc}")

    lm_status = "skipped" if skip_lmstudio else "deferred"
    if not skip_lmstudio:
        try:
            lm_status = install_and_verify_lmstudio(release_root, state_root)
        except Exception as exc:
            log(f"LM Studio setup deferred; the agent can retry later from Hub: {exc}")

    if not no_start:
        start_runner(release_root, config_path)
    status = {
        "version": VERSION,
        "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "release_root": str(release_root),
        "state_root": str(state_root),
        "controller": controller_url,
        "enrollment": enrollment,
        "lmstudio": lm_status,
        "mode": "quick-user",
        "admin_required": False,
        "powershell_required": False,
        "background_started": not no_start,
    }
    (state_root / "quick-install.json").write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    log("READY: CITADEL Quick Agent is installed and running.")
    log("No EXE installer, no Windows service, no administrator approval.")
    return 0


def uninstall() -> int:
    base, _, state = install_roots()
    remove_user_autostart()
    stop = state / "STOP"
    state.mkdir(parents=True, exist_ok=True)
    stop.write_text("uninstall\n", encoding="utf-8")
    log("Autostart removed. Agent stop marker written.")
    log(f"Program files remain under {base / 'releases'} until no CITADEL process is running.")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--controller-url", default=DEFAULT_CONTROLLER_URL)
    parser.add_argument("--skip-lmstudio", action="store_true")
    parser.add_argument("--skip-enrollment", action="store_true")
    parser.add_argument("--no-start", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.uninstall:
        return uninstall()
    return install(args.controller_url, args.skip_lmstudio, args.skip_enrollment, args.no_start)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[CITADEL] INSTALL FAILED: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
