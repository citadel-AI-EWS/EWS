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


def main() -> int:
    if os.name != "nt":
        print("Windows install/update mutex test: SKIP (non-Windows)")
        return 0

    if "--holder" in sys.argv:
        return holder()

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

        child.kill()
        child.wait(timeout=5)

        # The first waiter after an owner crash receives WAIT_ABANDONED. Remote
        # update must fail closed rather than silently continue over a possibly
        # torn install tree.
        try:
            with node.install_update_mutex(timeout_seconds=2):
                raise AssertionError("abandoned mutex was treated as a clean update slot")
        except RuntimeError as error:
            assert str(error) == "install_update_lock_abandoned", error

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
