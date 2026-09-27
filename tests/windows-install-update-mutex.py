#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AGENT_PATH = ROOT / "agent" / "citadel_node_v1.py"


def load_agent_module():
    spec = importlib.util.spec_from_file_location("citadel_node_v1_mutex_test", AGENT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load citadel_node_v1.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def holder() -> int:
    node = load_agent_module()
    with node.install_update_mutex(timeout_seconds=2):
        print("HELD", flush=True)
        time.sleep(30)
    return 0


def waiter() -> int:
    node = load_agent_module()
    try:
        with node.install_update_mutex(timeout_seconds=10):
            print("UNEXPECTED_ACQUIRE", flush=True)
            return 3
    except RuntimeError as error:
        print(str(error), flush=True)
        return 0 if str(error) == "install_update_lock_abandoned" else 4


def main() -> int:
    if os.name != "nt":
        print("Windows install/update mutex test: SKIP (non-Windows)")
        return 0

    if "--holder" in sys.argv:
        return holder()
    if "--waiter" in sys.argv:
        return waiter()

    node = load_agent_module()
    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--holder"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        line = child.stdout.readline().strip() if child.stdout else ""
        if line != "HELD":
            stderr = child.stderr.read() if child.stderr else ""
            raise AssertionError(f"holder did not acquire mutex: {line!r} {stderr!r}")

        try:
            with node.install_update_mutex(timeout_seconds=0.2):
                raise AssertionError("second updater acquired busy machine mutex")
        except RuntimeError as error:
            assert str(error) == "install_update_lock_busy", error

        waiter_process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--waiter"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        time.sleep(0.5)
        child.kill()
        child.wait(timeout=5)

        # The waiter already has a handle to the mutex when the owner dies, so
        # Windows must report WAIT_ABANDONED and remote update must fail closed.
        waiter_out, waiter_err = waiter_process.communicate(timeout=5)
        assert waiter_process.returncode == 0, (waiter_process.returncode, waiter_out, waiter_err)
        assert "install_update_lock_abandoned" in waiter_out, waiter_out

        # The abandoned ownership was released while failing closed, so a
        # subsequent repair/update attempt can acquire a fresh clean mutex.
        with node.install_update_mutex(timeout_seconds=2):
            pass
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)

    print("Windows install/update machine mutex: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
