#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
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
    old_program_data = os.environ.get("PROGRAMDATA")
    temp_root = tempfile.TemporaryDirectory(prefix="citadel-mutex-test-")
    os.environ["PROGRAMDATA"] = temp_root.name
    citadel_root = Path(temp_root.name) / "CitadelEWS"
    citadel_root.mkdir(parents=True, exist_ok=True)
    lifecycle_root = citadel_root / "lifecycle"
    assert not lifecycle_root.exists()

    child = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "--holder"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=os.environ.copy(),
    )
    try:
        line = child.stdout.readline().strip() if child.stdout else ""
        if line != "HELD":
            stderr = child.stderr.read() if child.stderr else ""
            raise AssertionError(f"holder did not acquire mutex: {line!r} {stderr!r}")

        lock_path, _ = node.windows_install_update_paths()
        assert lifecycle_root.is_dir(), "agent did not create canonical lifecycle directory"
        assert lock_path.parent == lifecycle_root

        try:
            with node.install_update_mutex(timeout_seconds=0.2):
                raise AssertionError("second updater acquired busy machine mutex")
        except RuntimeError as error:
            assert str(error) == "install_update_lock_busy", error

        child.kill()
        child.wait(timeout=5)

        # The kernel releases the exclusive file handle when the owner dies,
        # but the crash marker remains. Remote update must fail closed instead
        # of treating the newly free handle as proof of a clean previous exit.
        try:
            with node.install_update_mutex(timeout_seconds=2):
                raise AssertionError("crash marker was ignored after updater death")
        except RuntimeError as error:
            assert str(error) == "install_update_lock_abandoned", error

        # A full installer is the repair authority for abandoned state. Simulate
        # that repair here by clearing the protected marker, then require the
        # next clean acquisition to succeed.
        _, marker_path = node.windows_install_update_paths()
        marker_path.unlink()
        with node.install_update_mutex(timeout_seconds=2):
            pass

        # Ordinary failures that occur before any mutation are safe to retry and
        # must not strand a false abandoned marker.
        try:
            with node.install_update_mutex(timeout_seconds=2):
                raise RuntimeError("pre-mutation failure")
        except RuntimeError as error:
            assert str(error) == "pre-mutation failure"
        assert not marker_path.exists(), "safe pre-mutation failure left an abandoned marker"

        # A recoverable mutation may clear the marker only after the caller has
        # explicitly proved rollback completed.
        try:
            with node.install_update_mutex(timeout_seconds=2) as lifecycle:
                lifecycle.mark_mutated()
                lifecycle.mark_recovered()
                raise RuntimeError("rolled back failure")
        except RuntimeError as error:
            assert str(error) == "rolled back failure"
        assert not marker_path.exists(), "verified rollback left an abandoned marker"

        # An ordinary exception after mutation without verified rollback must
        # fail closed just like a hard crash.
        try:
            with node.install_update_mutex(timeout_seconds=2) as lifecycle:
                lifecycle.mark_mutated()
                raise RuntimeError("incomplete mutation")
        except RuntimeError as error:
            assert str(error) == "incomplete mutation"
        assert marker_path.exists(), "incomplete mutation incorrectly cleared the crash marker"
        marker_path.unlink()

        # A BaseException is not a clean lifecycle completion. The crash marker
        # must remain even though Python unwinds the context manager normally.
        try:
            with node.install_update_mutex(timeout_seconds=2):
                raise KeyboardInterrupt()
        except KeyboardInterrupt:
            pass
        assert marker_path.exists(), "BaseException incorrectly cleared the lifecycle crash marker"
        marker_path.unlink()
        with node.install_update_mutex(timeout_seconds=2):
            pass
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
        if old_program_data is None:
            os.environ.pop("PROGRAMDATA", None)
        else:
            os.environ["PROGRAMDATA"] = old_program_data
        temp_root.cleanup()

    print("Windows install/update machine mutex: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
