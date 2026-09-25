#!/usr/bin/env python3
"""Visible user-mode lifecycle host for CITADEL Quick Agent on Windows."""
from __future__ import annotations

import argparse
import ctypes
import os
import subprocess
import sys
import time
from pathlib import Path

RESTART_EXIT_CODE = 75
STOP_EXIT_CODE = 76
ERROR_ALREADY_EXISTS = 183
MUTEX_NAME = r"Local\CitadelEWSQuickAgent"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    return parser.parse_args()


def acquire_mutex():
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not handle:
        raise OSError(ctypes.get_last_error(), "CreateMutexW failed")
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        kernel32.CloseHandle(handle)
        return None
    return handle


def main() -> int:
    args = parse_args()
    mutex = acquire_mutex()
    if os.name == "nt" and mutex is None:
        return 0

    root = Path(__file__).resolve().parent
    agent = root / "citadel_node_v2.py"
    config = Path(args.config).resolve()
    python = root / "runtime" / "python.exe"
    if not python.is_file():
        python = Path(sys.executable)

    backoff = 2
    try:
        while True:
            child_env = os.environ.copy()
            child_env["CITADEL_QUICK_USER"] = "1"
            result = subprocess.run(
                [str(python), str(agent), "run", "--config", str(config)],
                cwd=str(root),
                shell=False,
                env=child_env,
            )
            code = int(result.returncode)
            if code in {0, STOP_EXIT_CODE}:
                return code
            if code == RESTART_EXIT_CODE:
                backoff = 2
                time.sleep(1)
                continue
            time.sleep(backoff)
            backoff = min(60, backoff * 2)
    finally:
        if os.name == "nt" and mutex:
            ctypes.WinDLL("kernel32").CloseHandle(mutex)


if __name__ == "__main__":
    raise SystemExit(main())
