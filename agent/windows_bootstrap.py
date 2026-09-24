#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path, PurePosixPath

RELEASE_VERSION = "0.3.16"
CONTROLLER_URL = "https://citadel-ai.init1.workers.dev"
PUBLIC_KEY = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
PACKAGE_FILES = ("citadel_node_v1.py", "citadel_node_v2.py")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package_root() -> Path:
    return Path(__file__).resolve().parent


def selected_runtime(root: Path) -> Path:
    arch = os.environ.get("PROCESSOR_ARCHITECTURE", "").upper()
    wow = os.environ.get("PROCESSOR_ARCHITEW6432", "").upper()
    name = "win32" if arch == "X86" and not wow else "amd64"
    runtime = root / "python_runtime" / name
    if not (runtime / "python.exe").is_file() or not (runtime / "pythonw.exe").is_file():
        raise RuntimeError(f"bundled Python runtime is missing for {name}")
    return runtime


def verify_manifest(root: Path) -> None:
    manifest = root / "SHA256SUMS.txt"
    if not manifest.is_file():
        raise RuntimeError("SHA256SUMS.txt is missing")
    root_resolved = root.resolve()
    seen = set()
    for raw in manifest.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            expected, name = raw.split("  ", 1)
        except ValueError as exc:
            raise RuntimeError(f"invalid manifest line: {raw}") from exc
        rel = PurePosixPath(name.strip())
        if rel.is_absolute() or ".." in rel.parts:
            raise RuntimeError(f"unsafe manifest path: {name}")
        path = root.joinpath(*rel.parts).resolve()
        if root_resolved != path and root_resolved not in path.parents:
            raise RuntimeError(f"manifest path escaped package: {name}")
        if not path.is_file():
            raise RuntimeError(f"package file missing: {name}")
        if sha256(path) != expected.strip().lower():
            raise RuntimeError(f"package integrity check failed: {name}")
        seen.add(rel.as_posix())
    for required in (*PACKAGE_FILES, "windows_bootstrap.py"):
        if required not in seen:
            raise RuntimeError(f"package manifest does not cover {required}")


def verify_runtime(runtime: Path) -> None:
    manifest = runtime / "SHA256SUMS.txt"
    if not manifest.is_file():
        raise RuntimeError("bundled Python runtime manifest is missing")
    runtime_resolved = runtime.resolve()
    for raw in manifest.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        expected, name = raw.split("  ", 1)
        rel = PurePosixPath(name.strip())
        if rel.is_absolute() or ".." in rel.parts:
            raise RuntimeError(f"unsafe runtime manifest path: {name}")
        path = runtime.joinpath(*rel.parts).resolve()
        if runtime_resolved != path and runtime_resolved not in path.parents:
            raise RuntimeError(f"runtime manifest path escaped: {name}")
        if not path.is_file() or sha256(path) != expected.strip().lower():
            raise RuntimeError(f"bundled Python verification failed: {name}")


def run_checked(argv: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, shell=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-2000:]
        raise RuntimeError(f"command failed ({result.returncode}): {detail}")
    return result


def terminate_old_user_agents(state_root: Path) -> None:
    try:
        import psutil
    except Exception:
        return
    state_needle = str(state_root).lower()
    for process in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmd = " ".join(process.info.get("cmdline") or []).lower()
            if "citadel_node_v2.py" in cmd and state_needle in cmd:
                process.terminate()
                try:
                    process.wait(5)
                except psutil.TimeoutExpired:
                    process.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, path)


def install_user_mode(controller_url: str) -> dict:
    root = package_root()
    verify_manifest(root)
    runtime_source = selected_runtime(root)
    verify_runtime(runtime_source)

    local_app = os.environ.get("LOCALAPPDATA")
    app_data = os.environ.get("APPDATA")
    if not local_app or not app_data:
        raise RuntimeError("Windows user profile paths are unavailable")

    install_root = Path(local_app) / "CitadelEWS" / "agent"
    state_root = Path(local_app) / "CitadelEWS" / "state"
    releases = install_root / "releases"
    release_root = releases / f"{RELEASE_VERSION}-{uuid.uuid4().hex}"
    runtime_target = release_root / "python_runtime"
    release_root.mkdir(parents=True, exist_ok=False)
    state_root.mkdir(parents=True, exist_ok=True)

    try:
        shutil.copytree(runtime_source, runtime_target)
        for name in PACKAGE_FILES:
            shutil.copy2(root / name, release_root / name)

        config = {
            "controller_url": controller_url.rstrip("/"),
            "data_dir": str(state_root),
            "poll_seconds": 30,
            "heartbeat_seconds": 30,
            "request_timeout_seconds": 30,
            "max_cpu_percent": 90,
            "max_memory_percent": 90,
            "prevent_automatic_sleep": True,
            "network_recovery_enabled": True,
            "allowed_wifi_profiles": [],
            "controller_public_x": PUBLIC_KEY,
        }
        config_path = release_root / "config.json"
        write_json(config_path, config)

        python = runtime_target / "python.exe"
        pythonw = runtime_target / "pythonw.exe"
        agent = release_root / "citadel_node_v2.py"
        run_checked([str(python), "-c", "import cryptography, psutil; print('portable runtime OK')"])
        run_checked([str(python), str(agent), "self-test"], timeout=180)
        run_checked([str(python), str(agent), "doctor", "--config", str(config_path)], timeout=120)

        probe_ok = False
        try:
            run_checked([str(python), str(agent), "probe", "--config", str(config_path)], timeout=45)
            probe_ok = True
        except (RuntimeError, subprocess.TimeoutExpired):
            probe_ok = False

        terminate_old_user_agents(state_root)
        startup_dir = Path(app_data) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
        startup_dir.mkdir(parents=True, exist_ok=True)
        startup = startup_dir / "CITADEL EWS Agent.cmd"
        startup.write_text(
            "@echo off\r\n"
            f'start "" /b "{pythonw}" "{agent}" run --config "{config_path}"\r\n',
            encoding="utf-8",
            newline="",
        )

        creationflags = 0x08000000 | 0x00000008 if os.name == "nt" else 0
        subprocess.Popen(
            [str(pythonw), str(agent), "run", "--config", str(config_path)],
            cwd=str(release_root),
            creationflags=creationflags,
            close_fds=True,
        )

        install_state = {
            "mode": "user",
            "agent_version": RELEASE_VERSION,
            "controller_url": controller_url.rstrip("/"),
            "release_root": str(release_root),
            "state_root": str(state_root),
            "runtime": str(runtime_target),
            "controller_probe_ok_at_install": probe_ok,
            "installed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        write_json(install_root / "install-state.json", install_state)
        return install_state
    except Exception:
        shutil.rmtree(release_root, ignore_errors=True)
        raise


def self_test() -> int:
    root = package_root()
    if os.name == "nt":
        runtime = selected_runtime(root)
        verify_runtime(runtime)
    print("CITADEL Windows bootstrap SELF TEST: PASS")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="CITADEL Windows offline bootstrap")
    parser.add_argument("--controller-url", default=CONTROLLER_URL)
    parser.add_argument("--verify-package-only", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    root = package_root()
    verify_manifest(root)
    if args.verify_package_only:
        print("CITADEL package integrity: OK")
        return 0
    result = install_user_mode(args.controller_url)
    print("CITADEL installation complete")
    print(f"mode={result['mode']}")
    print(f"version={result['agent_version']}")
    print(f"controller_probe_ok={str(result['controller_probe_ok_at_install']).lower()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
