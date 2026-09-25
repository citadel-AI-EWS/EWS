#!/usr/bin/env python3
"""Bounded CITADEL/EWS node for operator-owned or administered computers.

The node speaks the existing Cloudflare /api/v1 Ed25519 protocol. It has no
arbitrary remote-command executor, code loader, exploit engine, credential
collector, self-propagation, stealth installation, or autonomous financial
actions. An optional SSH gate can only expose an already-local SSH service
through a loopback-only, signed, time-limited proxy. Only locally registered
mission handlers and explicitly allowlisted controller actions can execute.
"""
from __future__ import annotations

import argparse
import ast
import base64
import binascii
import contextlib
import concurrent.futures
import ctypes
import dataclasses
import datetime as dt
import hashlib
import ipaddress
import http.client
import json
import os
import platform
import re
import select
import shutil
import socket
import threading
# Subprocesses below use a fixed interpreter, allowlisted local scripts and no shell.
import subprocess  # nosec B404
import sys
import tempfile
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Callable

try:
    import psutil
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey,
        Ed25519PublicKey,
    )
except ImportError as exc:
    raise SystemExit(
        "Missing dependencies. Run: python -m pip install -r agent/requirements.txt"
    ) from exc

VERSION = "0.3.17"
USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"
DEFAULT_CONTROLLER_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
SUPPORTED_COMMANDS = {"pause", "resume", "update", "restart", "stop", "rollback", "uninstall", "system_reboot", "system_shutdown", "wake_peer", "lmstudio_install", "lmstudio_uninstall", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query", "ssh_open", "ssh_close"}
CORE_UPDATE_FILE_NAMES = {"citadel_node_v1.py", "citadel_node_v2.py"}
UPDATE_FILE_NAMES = CORE_UPDATE_FILE_NAMES | {"windows_enterprise_probe.ps1"}
UPDATE_MAX_FILE_BYTES = 2 * 1024 * 1024
COMMAND_MAX_AGE_SECONDS = 15 * 60
SSH_GATE_MIN_TTL_SECONDS = 60
SSH_GATE_MAX_TTL_SECONDS = 15 * 60
SSH_GATE_DEFAULT_LISTEN_PORT = 2222
SSH_GATE_DEFAULT_TARGET_PORT = 22
SSH_GATE_SESSION_RE = re.compile(r"^ssh_[a-f0-9]{32}$")
SERVICE_RESTART_EXIT_CODE = 75
SERVICE_STOP_EXIT_CODE = 76
LMSTUDIO_INSTALL_FILE_NAMES = {"install_llmstudio_headless.py", "install_llmstudio_headless.ps1", "install_llmstudio_headless.sh"}
LMSTUDIO_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$")
LMSTUDIO_QUANT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
HYBRID_MODES = {"python", "lmstudio", "both"}
WINDOWS_DPAPI_PROTECTION = "windows-dpapi-local-machine-v1"
CRYPTPROTECT_UI_FORBIDDEN = 0x1
CRYPTPROTECT_LOCAL_MACHINE = 0x4
WINDOWS_ENTERPRISE_PROBE_SHA256 = "0d056ab71e2216821cd314a97bc14e87f87c60140a0bcf787a24cfa33212c2ee"
WINDOWS_ENTERPRISE_PROBE_MAX_BYTES = 256 * 1024
WINDOWS_ENTERPRISE_PROBE_B64 = (
    "JEVycm9yQWN0aW9uUHJlZmVyZW5jZSA9ICJTdG9wIgpTZXQtU3RyaWN0TW9kZSAtVmVyc2lvbiBMYXRlc3QKCmZ1bmN0aW9uIFNhZmUtQ2ltRmlyc3Qgewog"
    "IHBhcmFtKFtQYXJhbWV0ZXIoTWFuZGF0b3J5ID0gJHRydWUpXVtzdHJpbmddJENsYXNzTmFtZSwgW3N0cmluZ10kRmlsdGVyID0gIiIpCiAgdHJ5IHsKICAg"
    "IGlmIChbc3RyaW5nXTo6SXNOdWxsT3JXaGl0ZVNwYWNlKCRGaWx0ZXIpKSB7CiAgICAgIHJldHVybiBHZXQtQ2ltSW5zdGFuY2UgLUNsYXNzTmFtZSAkQ2xh"
    "c3NOYW1lIC1FcnJvckFjdGlvbiBTdG9wIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogICAgfQogICAgcmV0dXJuIEdldC1DaW1JbnN0YW5jZSAtQ2xhc3NO"
    "YW1lICRDbGFzc05hbWUgLUZpbHRlciAkRmlsdGVyIC1FcnJvckFjdGlvbiBTdG9wIHwgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQogIH0gY2F0Y2ggewogICAg"
    "cmV0dXJuICRudWxsCiAgfQp9CgpmdW5jdGlvbiBTYWZlLVNlcnZpY2UgewogIHBhcmFtKFtQYXJhbWV0ZXIoTWFuZGF0b3J5ID0gJHRydWUpXVtzdHJpbmdd"
    "JE5hbWUpCiAgdHJ5IHsgcmV0dXJuIEdldC1TZXJ2aWNlIC1OYW1lICROYW1lIC1FcnJvckFjdGlvbiBTdG9wIH0gY2F0Y2ggeyByZXR1cm4gJG51bGwgfQp9"
    "CgpmdW5jdGlvbiBSZWdpc3RyeS1FeGlzdHMgewogIHBhcmFtKFtQYXJhbWV0ZXIoTWFuZGF0b3J5ID0gJHRydWUpXVtzdHJpbmddJFBhdGgpCiAgdHJ5IHsg"
    "cmV0dXJuIFRlc3QtUGF0aCAtTGl0ZXJhbFBhdGggJFBhdGggLUVycm9yQWN0aW9uIFN0b3AgfSBjYXRjaCB7IHJldHVybiAkZmFsc2UgfQp9CgpmdW5jdGlv"
    "biBSZWNlbnQtRXZlbnRTdW1tYXJ5IHsKICBwYXJhbShbUGFyYW1ldGVyKE1hbmRhdG9yeSA9ICR0cnVlKV1bc3RyaW5nXSRMb2dOYW1lKQogICRyZXN1bHQg"
    "PSBbb3JkZXJlZF1AeyBsb2cgPSAkTG9nTmFtZTsgY3JpdGljYWxfb3JfZXJyb3JfbGFzdF9ob3VyID0gMDsgcXVlcnlfb2sgPSAkZmFsc2UgfQogIHRyeSB7"
    "CiAgICAkc3RhcnQgPSAoR2V0LURhdGUpLkFkZEhvdXJzKC0xKQogICAgJGV2ZW50cyA9IEAoR2V0LVdpbkV2ZW50IC1GaWx0ZXJIYXNodGFibGUgQHsgTG9n"
    "TmFtZSA9ICRMb2dOYW1lOyBMZXZlbCA9IDEsMjsgU3RhcnRUaW1lID0gJHN0YXJ0IH0gLU1heEV2ZW50cyAxMDAgLUVycm9yQWN0aW9uIFN0b3ApCiAgICAk"
    "cmVzdWx0LmNyaXRpY2FsX29yX2Vycm9yX2xhc3RfaG91ciA9ICRldmVudHMuQ291bnQKICAgICRyZXN1bHQucXVlcnlfb2sgPSAkdHJ1ZQogIH0gY2F0Y2gg"
    "ewogICAgJHJlc3VsdC5xdWVyeV9vayA9ICRmYWxzZQogIH0KICByZXR1cm4gJHJlc3VsdAp9Cgokb3MgPSBTYWZlLUNpbUZpcnN0ICJXaW4zMl9PcGVyYXRp"
    "bmdTeXN0ZW0iCiRjb21wdXRlciA9IFNhZmUtQ2ltRmlyc3QgIldpbjMyX0NvbXB1dGVyU3lzdGVtIgokc2VydmljZSA9IFNhZmUtQ2ltRmlyc3QgIldpbjMy"
    "X1NlcnZpY2UiICJOYW1lPSdDaXRhZGVsRVdTTm9kZSciCiRjcHVQZXJmID0gU2FmZS1DaW1GaXJzdCAiV2luMzJfUGVyZkZvcm1hdHRlZERhdGFfUGVyZk9T"
    "X1Byb2Nlc3NvciIgIk5hbWU9J19Ub3RhbCciCiRtZW1vcnlQZXJmID0gU2FmZS1DaW1GaXJzdCAiV2luMzJfUGVyZkZvcm1hdHRlZERhdGFfUGVyZk9TX01l"
    "bW9yeSIKJGh5cGVyVkZlYXR1cmUgPSBTYWZlLUNpbUZpcnN0ICJXaW4zMl9PcHRpb25hbEZlYXR1cmUiICJOYW1lPSdNaWNyb3NvZnQtSHlwZXItVi1BbGwn"
    "Igokd3VTZXJ2aWNlID0gU2FmZS1TZXJ2aWNlICJ3dWF1c2VydiIKJGdwc3ZjID0gU2FmZS1TZXJ2aWNlICJncHN2YyIKJGludHVuZVNlcnZpY2UgPSBTYWZl"
    "LVNlcnZpY2UgIkludHVuZU1hbmFnZW1lbnRFeHRlbnNpb24iCgokbGF0ZXN0SG90Zml4ID0gJG51bGwKdHJ5IHsKICAkbGF0ZXN0SG90Zml4ID0gR2V0LUNp"
    "bUluc3RhbmNlIC1DbGFzc05hbWUgV2luMzJfUXVpY2tGaXhFbmdpbmVlcmluZyAtRXJyb3JBY3Rpb24gU3RvcCB8CiAgICBTb3J0LU9iamVjdCAtUHJvcGVy"
    "dHkgSW5zdGFsbGVkT24gLURlc2NlbmRpbmcgfAogICAgU2VsZWN0LU9iamVjdCAtRmlyc3QgMQp9IGNhdGNoIHt9Cgokdm1Db3VudCA9ICRudWxsCiRydW5u"
    "aW5nVm1Db3VudCA9ICRudWxsCiRoeXBlclZRdWVyeU9rID0gJGZhbHNlCnRyeSB7CiAgaWYgKEdldC1Db21tYW5kIEdldC1WTSAtRXJyb3JBY3Rpb24gU2ls"
    "ZW50bHlDb250aW51ZSkgewogICAgJHZtcyA9IEAoR2V0LVZNIC1FcnJvckFjdGlvbiBTdG9wKQogICAgJHZtQ291bnQgPSAkdm1zLkNvdW50CiAgICAkcnVu"
    "bmluZ1ZtQ291bnQgPSBAKCR2bXMgfCBXaGVyZS1PYmplY3QgeyAkXy5TdGF0ZSAtZXEgIlJ1bm5pbmciIH0pLkNvdW50CiAgICAkaHlwZXJWUXVlcnlPayA9"
    "ICR0cnVlCiAgfQp9IGNhdGNoIHsKICAkaHlwZXJWUXVlcnlPayA9ICRmYWxzZQp9CgokbWRtRW5yb2xsbWVudENvdW50ID0gMAp0cnkgewogICRlbnJvbGxt"
    "ZW50Um9vdCA9ICJIS0xNOlxTT0ZUV0FSRVxNaWNyb3NvZnRcRW5yb2xsbWVudHMiCiAgaWYgKFRlc3QtUGF0aCAtTGl0ZXJhbFBhdGggJGVucm9sbG1lbnRS"
    "b290KSB7CiAgICAkbWRtRW5yb2xsbWVudENvdW50ID0gQChHZXQtQ2hpbGRJdGVtIC1MaXRlcmFsUGF0aCAkZW5yb2xsbWVudFJvb3QgLUVycm9yQWN0aW9u"
    "IFN0b3ApLkNvdW50CiAgfQp9IGNhdGNoIHsKICAkbWRtRW5yb2xsbWVudENvdW50ID0gMAp9CgokcGVuZGluZ1JlYm9vdCA9ICgKICAoUmVnaXN0cnktRXhp"
    "c3RzICJIS0xNOlxTT0ZUV0FSRVxNaWNyb3NvZnRcV2luZG93c1xDdXJyZW50VmVyc2lvblxDb21wb25lbnQgQmFzZWQgU2VydmljaW5nXFJlYm9vdFBlbmRp"
    "bmciKSAtb3IKICAoUmVnaXN0cnktRXhpc3RzICJIS0xNOlxTT0ZUV0FSRVxNaWNyb3NvZnRcV2luZG93c1xDdXJyZW50VmVyc2lvblxXaW5kb3dzVXBkYXRl"
    "XEF1dG8gVXBkYXRlXFJlYm9vdFJlcXVpcmVkIikKKQoKJHNlcnZpY2VBY2NvdW50ID0gaWYgKCRudWxsIC1uZSAkc2VydmljZSkgeyBbc3RyaW5nXSRzZXJ2"
    "aWNlLlN0YXJ0TmFtZSB9IGVsc2UgeyAiIiB9CiRtYW5hZ2VkU2VydmljZUFjY291bnRDYW5kaWRhdGUgPSAoLW5vdCBbc3RyaW5nXTo6SXNOdWxsT3JXaGl0"
    "ZVNwYWNlKCRzZXJ2aWNlQWNjb3VudCkpIC1hbmQgJHNlcnZpY2VBY2NvdW50LkVuZHNXaXRoKCIkIikKJGRvbWFpbkpvaW5lZCA9ICRmYWxzZQokZG9tYWlu"
    "TmFtZSA9ICRudWxsCmlmICgkbnVsbCAtbmUgJGNvbXB1dGVyKSB7CiAgJGRvbWFpbkpvaW5lZCA9IFtib29sXSRjb21wdXRlci5QYXJ0T2ZEb21haW4KICBp"
    "ZiAoJGRvbWFpbkpvaW5lZCkgeyAkZG9tYWluTmFtZSA9IFtzdHJpbmddJGNvbXB1dGVyLkRvbWFpbiB9Cn0KCiRnbXNhRG1zYSA9IFtvcmRlcmVkXUB7CiAg"
    "Y29uZmlndXJlZCA9ICRtYW5hZ2VkU2VydmljZUFjY291bnRDYW5kaWRhdGUKICBzZXJ2aWNlX2FjY291bnQgPSBpZiAoJHNlcnZpY2VBY2NvdW50KSB7ICRz"
    "ZXJ2aWNlQWNjb3VudCB9IGVsc2UgeyAkbnVsbCB9CiAgZG9tYWluX2pvaW5lZCA9ICRkb21haW5Kb2luZWQKICBkb21haW4gPSAkZG9tYWluTmFtZQogIGFk"
    "X21vZHVsZV9hdmFpbGFibGUgPSBbYm9vbF0oR2V0LU1vZHVsZSAtTGlzdEF2YWlsYWJsZSAtTmFtZSBBY3RpdmVEaXJlY3RvcnkgfCBTZWxlY3QtT2JqZWN0"
    "IC1GaXJzdCAxKQogIG5vdGUgPSBpZiAoJG1hbmFnZWRTZXJ2aWNlQWNjb3VudENhbmRpZGF0ZSkgewogICAgIk1hbmFnZWQgc2VydmljZSBhY2NvdW50IGNh"
    "bmRpZGF0ZSBkZXRlY3RlZCBmcm9tIFdpbmRvd3MgU2VydmljZSBpZGVudGl0eTsgYWNjb3VudCBzdWJ0eXBlIGlzIG5vdCBndWVzc2VkIHdpdGhvdXQgYXV0"
    "aG9yaXRhdGl2ZSBkaXJlY3RvcnkgZGF0YS4iCiAgfSBlbHNlIHsKICAgICJDSVRBREVMIGN1cnJlbnRseSB1c2VzIGl0cyBjb25maWd1cmVkIGxvY2FsIHNl"
    "cnZpY2UgaWRlbnRpdHkuIGdNU0EvZE1TQSBjYW4gb25seSBiZSBhY3RpdmF0ZWQgb24gYW4gZWxpZ2libGUgZG9tYWluLW1hbmFnZWQgaG9zdC4iCiAgfQp9"
    "CgokaG90cGF0Y2ggPSBbb3JkZXJlZF1AewogIHN0YXRlID0gImV4dGVybmFsLW1hbmFnZW1lbnQtcmVxdWlyZWQiCiAgcGVuZGluZ19yZWJvb3QgPSAkcGVu"
    "ZGluZ1JlYm9vdAogIG5vdGUgPSAiVGhlIGxvY2FsIHByb2JlIHJlcG9ydHMgV2luZG93cyBVcGRhdGUvcmVib290IHN0YXRlIGJ1dCBkb2VzIG5vdCBjbGFp"
    "bSBIb3RwYXRjaCBlbGlnaWJpbGl0eSB3aXRob3V0IGFuIGF1dGhvcml0YXRpdmUgTWljcm9zb2Z0IG1hbmFnZW1lbnQgc2lnbmFsLiIKfQoKJHJlc3VsdCA9"
    "IFtvcmRlcmVkXUB7CiAgc2NoZW1hID0gImNpdGFkZWwud2luZG93cy5lbnRlcnByaXNlLnYxIgogIGNhcHR1cmVkX2F0ID0gKEdldC1EYXRlKS5Ub1VuaXZl"
    "cnNhbFRpbWUoKS5Ub1N0cmluZygibyIpCiAgcmVhZG9ubHkgPSAkdHJ1ZQogIGNpbSA9IFtvcmRlcmVkXUB7CiAgICBvc19jYXB0aW9uID0gaWYgKCRudWxs"
    "IC1uZSAkb3MpIHsgW3N0cmluZ10kb3MuQ2FwdGlvbiB9IGVsc2UgeyAkbnVsbCB9CiAgICBvc192ZXJzaW9uID0gaWYgKCRudWxsIC1uZSAkb3MpIHsgW3N0"
    "cmluZ10kb3MuVmVyc2lvbiB9IGVsc2UgeyAkbnVsbCB9CiAgICBvc19idWlsZCA9IGlmICgkbnVsbCAtbmUgJG9zKSB7IFtzdHJpbmddJG9zLkJ1aWxkTnVt"
    "YmVyIH0gZWxzZSB7ICRudWxsIH0KICAgIG1hbnVmYWN0dXJlciA9IGlmICgkbnVsbCAtbmUgJGNvbXB1dGVyKSB7IFtzdHJpbmddJGNvbXB1dGVyLk1hbnVm"
    "YWN0dXJlciB9IGVsc2UgeyAkbnVsbCB9CiAgICBtb2RlbCA9IGlmICgkbnVsbCAtbmUgJGNvbXB1dGVyKSB7IFtzdHJpbmddJGNvbXB1dGVyLk1vZGVsIH0g"
    "ZWxzZSB7ICRudWxsIH0KICAgIGRvbWFpbl9qb2luZWQgPSAkZG9tYWluSm9pbmVkCiAgICBkb21haW4gPSAkZG9tYWluTmFtZQogICAgY2l0YWRlbF9zZXJ2"
    "aWNlX3N0YXRlID0gaWYgKCRudWxsIC1uZSAkc2VydmljZSkgeyBbc3RyaW5nXSRzZXJ2aWNlLlN0YXRlIH0gZWxzZSB7ICRudWxsIH0KICAgIGNpdGFkZWxf"
    "c2VydmljZV9zdGFydF9tb2RlID0gaWYgKCRudWxsIC1uZSAkc2VydmljZSkgeyBbc3RyaW5nXSRzZXJ2aWNlLlN0YXJ0TW9kZSB9IGVsc2UgeyAkbnVsbCB9"
    "CiAgfQogIHBlcmZvcm1hbmNlID0gW29yZGVyZWRdQHsKICAgIGNwdV9wZXJjZW50ID0gaWYgKCRudWxsIC1uZSAkY3B1UGVyZikgeyBbZG91YmxlXSRjcHVQ"
    "ZXJmLlBlcmNlbnRQcm9jZXNzb3JUaW1lIH0gZWxzZSB7ICRudWxsIH0KICAgIG1lbW9yeV9hdmFpbGFibGVfbWIgPSBpZiAoJG51bGwgLW5lICRtZW1vcnlQ"
    "ZXJmKSB7IFtkb3VibGVdJG1lbW9yeVBlcmYuQXZhaWxhYmxlTUJ5dGVzIH0gZWxzZSB7ICRudWxsIH0KICAgIHNvdXJjZSA9ICJDSU0gZm9ybWF0dGVkIHBl"
    "cmZvcm1hbmNlIGNsYXNzZXMiCiAgfQogIGV2ZW50X2xvZyA9IFtvcmRlcmVkXUB7CiAgICBzeXN0ZW0gPSBSZWNlbnQtRXZlbnRTdW1tYXJ5ICJTeXN0ZW0i"
    "CiAgICBhcHBsaWNhdGlvbiA9IFJlY2VudC1FdmVudFN1bW1hcnkgIkFwcGxpY2F0aW9uIgogIH0KICBzZXJ2aWNlX2lkZW50aXR5ID0gJGdtc2FEbXNhCiAg"
    "d2luZG93c191cGRhdGUgPSBbb3JkZXJlZF1AewogICAgc2VydmljZV9zdGF0dXMgPSBpZiAoJG51bGwgLW5lICR3dVNlcnZpY2UpIHsgW3N0cmluZ10kd3VT"
    "ZXJ2aWNlLlN0YXR1cyB9IGVsc2UgeyAkbnVsbCB9CiAgICBzZXJ2aWNlX3N0YXJ0X3R5cGUgPSBpZiAoJG51bGwgLW5lICR3dVNlcnZpY2UpIHsgW3N0cmlu"
    "Z10kd3VTZXJ2aWNlLlN0YXJ0VHlwZSB9IGVsc2UgeyAkbnVsbCB9CiAgICBwZW5kaW5nX3JlYm9vdCA9ICRwZW5kaW5nUmVib290CiAgICBsYXRlc3RfaG90"
    "Zml4X2lkID0gaWYgKCRudWxsIC1uZSAkbGF0ZXN0SG90Zml4KSB7IFtzdHJpbmddJGxhdGVzdEhvdGZpeC5Ib3RGaXhJRCB9IGVsc2UgeyAkbnVsbCB9CiAg"
    "ICBsYXRlc3RfaG90Zml4X2luc3RhbGxlZF9vbiA9IGlmICgkbnVsbCAtbmUgJGxhdGVzdEhvdGZpeCAtYW5kICRudWxsIC1uZSAkbGF0ZXN0SG90Zml4Lklu"
    "c3RhbGxlZE9uKSB7IFtzdHJpbmddJGxhdGVzdEhvdGZpeC5JbnN0YWxsZWRPbiB9IGVsc2UgeyAkbnVsbCB9CiAgICBob3RwYXRjaCA9ICRob3RwYXRjaAog"
    "IH0KICBoeXBlcl92ID0gW29yZGVyZWRdQHsKICAgIG9wdGlvbmFsX2ZlYXR1cmVfc3RhdGUgPSBpZiAoJG51bGwgLW5lICRoeXBlclZGZWF0dXJlKSB7IFtp"
    "bnRdJGh5cGVyVkZlYXR1cmUuSW5zdGFsbFN0YXRlIH0gZWxzZSB7ICRudWxsIH0KICAgIHF1ZXJ5X29rID0gJGh5cGVyVlF1ZXJ5T2sKICAgIHZtX2NvdW50"
    "ID0gJHZtQ291bnQKICAgIHJ1bm5pbmdfdm1fY291bnQgPSAkcnVubmluZ1ZtQ291bnQKICAgIHJlYWRvbmx5ID0gJHRydWUKICB9CiAgbWFuYWdlbWVudCA9"
    "IFtvcmRlcmVkXUB7CiAgICBncm91cF9wb2xpY3lfc2VydmljZSA9IGlmICgkbnVsbCAtbmUgJGdwc3ZjKSB7IFtzdHJpbmddJGdwc3ZjLlN0YXR1cyB9IGVs"
    "c2UgeyAkbnVsbCB9CiAgICBtZG1fZW5yb2xsbWVudF9jb3VudCA9ICRtZG1FbnJvbGxtZW50Q291bnQKICAgIGludHVuZV9tYW5hZ2VtZW50X2V4dGVuc2lv"
    "biA9IGlmICgkbnVsbCAtbmUgJGludHVuZVNlcnZpY2UpIHsgW3N0cmluZ10kaW50dW5lU2VydmljZS5TdGF0dXMgfSBlbHNlIHsgJG51bGwgfQogICAgZG9t"
    "YWluX2pvaW5lZCA9ICRkb21haW5Kb2luZWQKICAgIGRvbWFpbiA9ICRkb21haW5OYW1lCiAgfQp9CgokcmVzdWx0IHwgQ29udmVydFRvLUpzb24gLURlcHRo"
    "IDggLUNvbXByZXNzCg=="
)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


def _windows_dpapi(data: bytes, *, protect: bool) -> bytes:
    """Protect or unprotect a secret with machine-bound Windows DPAPI."""
    if os.name != "nt":
        raise RuntimeError("Windows DPAPI is only available on Windows")
    if not data:
        raise ValueError("DPAPI input must not be empty")

    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
        ]

    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    input_blob = DataBlob(
        len(data),
        ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)),
    )
    output_blob = DataBlob()

    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(DataBlob),
        wintypes.LPCWSTR,
        ctypes.POINTER(DataBlob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DataBlob),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(DataBlob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DataBlob),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p

    if protect:
        ok = crypt32.CryptProtectData(
            ctypes.byref(input_blob),
            "CITADEL/EWS node identity",
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE,
            ctypes.byref(output_blob),
        )
    else:
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(input_blob),
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(output_blob),
        )
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        if output_blob.pbData:
            kernel32.LocalFree(ctypes.cast(output_blob.pbData, ctypes.c_void_p))


def _windows_dpapi_protect(data: bytes) -> bytes:
    return _windows_dpapi(data, protect=True)


def _windows_dpapi_unprotect(data: bytes) -> bytes:
    return _windows_dpapi(data, protect=False)


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def atomic_write(path: Path, text: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        with contextlib.suppress(OSError):
            os.chmod(temp_name, mode)
        os.replace(temp_name, path)
        with contextlib.suppress(OSError):
            os.chmod(path, mode)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def default_data_dir() -> Path:
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "CitadelEWS" / "state"
    state_home = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return state_home / "citadel-ews"


@dataclasses.dataclass
class AgentConfig:
    controller_url: str
    data_dir: Path
    poll_seconds: int = 30
    heartbeat_seconds: int = 30
    request_timeout_seconds: int = 30
    max_cpu_percent: float = 90.0
    max_memory_percent: float = 90.0
    controller_public_x: str = DEFAULT_CONTROLLER_PUBLIC_X
    prevent_automatic_sleep: bool = True
    network_recovery_enabled: bool = True
    allowed_wifi_profiles: tuple[str, ...] = ()
    lm_api_token: str | None = None
    ssh_gate_enabled: bool = False
    ssh_gate_listen_port: int = SSH_GATE_DEFAULT_LISTEN_PORT
    ssh_gate_target_port: int = SSH_GATE_DEFAULT_TARGET_PORT

    @classmethod
    def from_file(cls, path: Path) -> "AgentConfig":
        raw = load_json(path, {}) or {}
        controller_url = str(raw.get("controller_url") or "").strip().rstrip("/")
        parsed = urllib.parse.urlsplit(controller_url)
        secure = parsed.scheme == "https" and bool(parsed.hostname)
        local_test = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if not (secure or local_test):
            raise ValueError("controller_url must use HTTPS; loopback HTTP is test-only")
        raw_profiles = raw.get("allowed_wifi_profiles") or []
        if not isinstance(raw_profiles, list):
            raise ValueError("allowed_wifi_profiles must be a JSON array")
        profiles: list[str] = []
        for value in raw_profiles:
            if not isinstance(value, str):
                raise ValueError("allowed_wifi_profiles entries must be strings")
            name = value.strip()
            if name and len(name) <= 120 and name not in profiles:
                profiles.append(name)
        raw_lm_token = raw.get("lm_api_token")
        if raw_lm_token is None:
            raw_lm_token = os.environ.get("LM_API_TOKEN")
        lm_api_token = None
        if raw_lm_token is not None:
            token = str(raw_lm_token).strip()
            if token:
                if len(token) > 512 or any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
                    raise ValueError("lm_api_token must be 1-512 printable ASCII characters")
                lm_api_token = token

        ssh_gate_enabled = raw.get("ssh_gate_enabled", False) is True
        ssh_gate_listen_port = int(raw.get("ssh_gate_listen_port", SSH_GATE_DEFAULT_LISTEN_PORT))
        ssh_gate_target_port = int(raw.get("ssh_gate_target_port", SSH_GATE_DEFAULT_TARGET_PORT))
        if not 1024 <= ssh_gate_listen_port <= 65535:
            raise ValueError("ssh_gate_listen_port must be between 1024 and 65535")
        if not 1 <= ssh_gate_target_port <= 65535:
            raise ValueError("ssh_gate_target_port must be between 1 and 65535")

        return cls(
            controller_url=controller_url,
            data_dir=Path(raw.get("data_dir") or default_data_dir()).expanduser().resolve(),
            poll_seconds=max(5, int(raw.get("poll_seconds", 30))),
            heartbeat_seconds=max(10, int(raw.get("heartbeat_seconds", 30))),
            request_timeout_seconds=max(5, min(120, int(raw.get("request_timeout_seconds", 30)))),
            max_cpu_percent=max(10.0, min(100.0, float(raw.get("max_cpu_percent", 90)))),
            max_memory_percent=max(10.0, min(100.0, float(raw.get("max_memory_percent", 90)))),
            controller_public_x=str(raw.get("controller_public_x") or DEFAULT_CONTROLLER_PUBLIC_X),
            prevent_automatic_sleep=raw.get("prevent_automatic_sleep", True) is not False,
            network_recovery_enabled=raw.get("network_recovery_enabled", True) is not False,
            allowed_wifi_profiles=tuple(profiles[:16]),
            lm_api_token=lm_api_token,
            ssh_gate_enabled=ssh_gate_enabled,
            ssh_gate_listen_port=ssh_gate_listen_port,
            ssh_gate_target_port=ssh_gate_target_port,
        )


class JsonlLogger:
    def __init__(self, path: Path) -> None:
        self.path = path

    def write(self, event: str, **fields: Any) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        item = {"ts": now_iso(), "event": event, **fields}
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")


class Identity:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.node_id: str | None = None
        self.private_key: Ed25519PrivateKey | None = None
        state = load_json(path, {}) or {}
        self.node_id = state.get("node_id") or None

        if state.get("private_key_dpapi"):
            if os.name != "nt":
                raise ValueError("Windows-protected node identity cannot be used on this OS")
            if state.get("key_protection") != WINDOWS_DPAPI_PROTECTION:
                raise ValueError("unsupported Windows node identity protection format")
            raw = _windows_dpapi_unprotect(unb64url(str(state["private_key_dpapi"])))
            if len(raw) != 32:
                raise ValueError("invalid Windows-protected Ed25519 private key")
            self.private_key = Ed25519PrivateKey.from_private_bytes(raw)
        elif state.get("private_key_pem"):
            key = serialization.load_pem_private_key(
                state["private_key_pem"].encode("ascii"), password=None
            )
            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError("identity key is not Ed25519")
            self.private_key = key
            if os.name == "nt":
                # One-time migration: replace the legacy plaintext PEM with a
                # machine-bound DPAPI blob while preserving node_id.
                self.save()
        elif state:
            raise ValueError("identity state does not contain a supported private key")
        else:
            self.private_key = Ed25519PrivateKey.generate()
            self.save()

    def require_key(self) -> Ed25519PrivateKey:
        if self.private_key is None:
            raise RuntimeError("node identity unavailable")
        return self.private_key

    def save(self) -> None:
        key = self.require_key()
        if os.name == "nt":
            raw = key.private_bytes(
                serialization.Encoding.Raw,
                serialization.PrivateFormat.Raw,
                serialization.NoEncryption(),
            )
            payload = {
                "node_id": self.node_id,
                "key_protection": WINDOWS_DPAPI_PROTECTION,
                "private_key_dpapi": b64url(_windows_dpapi_protect(raw)),
            }
        else:
            pem = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode("ascii")
            payload = {"node_id": self.node_id, "private_key_pem": pem}
        atomic_write(self.path, json.dumps(payload, indent=2) + "\n")

    def set_node_id(self, node_id: str) -> None:
        self.node_id = node_id
        self.save()

    def public_jwk(self) -> dict[str, str]:
        raw = self.require_key().public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        return {"kty": "OKP", "crv": "Ed25519", "x": b64url(raw)}

    def sign(self, value: bytes) -> str:
        return b64url(self.require_key().sign(value))


class ApiClient:
    def __init__(self, config: AgentConfig, identity: Identity) -> None:
        self.config = config
        self.identity = identity
        parsed = urllib.parse.urlsplit(config.controller_url)
        self.scheme = parsed.scheme
        self.host = parsed.hostname or ""
        self.port = parsed.port
        self.base_path = parsed.path.rstrip("/")
        if self.scheme == "https":
            self.connection_type = http.client.HTTPSConnection
        elif self.scheme == "http" and self.host in {"127.0.0.1", "localhost", "::1"}:
            self.connection_type = http.client.HTTPConnection
        else:
            raise ValueError("unsupported controller scheme")

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        signed: bool = True,
    ) -> dict[str, Any]:
        method = method.upper()
        if not path.startswith("/"):
            raise ValueError("API path must begin with /")
        request_path = self.base_path + path
        body_text = "" if body is None else json_text(body)
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if signed:
            if not self.identity.node_id:
                raise RuntimeError("node is not enrolled")
            timestamp = str(int(time.time()))
            request_id = str(uuid.uuid4())
            canonical = "\n".join((method, request_path, timestamp, request_id, sha256_text(body_text)))
            headers.update({
                "x-node-id": self.identity.node_id,
                "x-node-timestamp": timestamp,
                "x-node-request-id": request_id,
                "x-node-signature": self.identity.sign(canonical.encode("utf-8")),
            })

        connection = self.connection_type(
            self.host,
            self.port,
            timeout=self.config.request_timeout_seconds,
        )
        try:
            connection.request(
                method,
                request_path,
                body=body_text.encode("utf-8") if body is not None else None,
                headers=headers,
            )
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("controller response too large")
            decoded = raw.decode("utf-8", errors="replace")
            try:
                value = json.loads(decoded) if decoded else {}
            except json.JSONDecodeError as exc:
                raise RuntimeError("controller returned invalid JSON") from exc
            if not 200 <= response.status < 300:
                error = value.get("error") if isinstance(value, dict) else decoded
                raise RuntimeError(f"controller HTTP {response.status}: {error}")
            if not isinstance(value, dict):
                raise RuntimeError("controller response must be a JSON object")
            return value
        finally:
            connection.close()


class ResultQueue:
    def __init__(self, path: Path) -> None:
        self.path = path

    def push(self, result: dict[str, Any]) -> None:
        items = load_json(self.path, []) or []
        items.append(result)
        atomic_write(self.path, json.dumps(items, ensure_ascii=False, indent=2) + "\n")

    def flush(self, submit: Callable[[dict[str, Any]], None]) -> int:
        items = load_json(self.path, []) or []
        if not items:
            return 0
        remaining: list[dict[str, Any]] = []
        sent = 0
        for index, item in enumerate(items):
            try:
                submit(item)
                sent += 1
            except Exception:
                remaining.extend(items[index:])
                break
        atomic_write(self.path, json.dumps(remaining, ensure_ascii=False, indent=2) + "\n")
        return sent


MissionHandler = Callable[[dict[str, Any]], dict[str, Any]]


class SshGateProxy:
    """Loopback-only TCP gate for an already-local SSH daemon.

    The listener never binds to a LAN/public address. Cloudflare Tunnel/Access
    can target the loopback listener, while the signed controller command
    decides when the listener exists. Agent exit closes the socket, so a crash
    fails closed.
    """

    def __init__(self, listen_port: int, target_port: int) -> None:
        self.listen_port = listen_port
        self.target_port = target_port
        self._listener: socket.socket | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._deadline = 0.0

    @property
    def active(self) -> bool:
        thread = self._thread
        return bool(
            thread
            and thread.is_alive()
            and self._listener is not None
            and time.monotonic() < self._deadline
            and not self._stop.is_set()
        )

    def _target_is_loopback_only(self) -> bool:
        """Require the underlying SSH daemon itself to be loopback-only."""
        found_loopback = False
        try:
            connections = psutil.net_connections(kind="tcp")
        except Exception:
            return False
        for connection in connections:
            if connection.status != psutil.CONN_LISTEN or not connection.laddr:
                continue
            local = connection.laddr
            port = getattr(local, "port", local[1] if len(local) > 1 else None)
            if port != self.target_port:
                continue
            host = str(getattr(local, "ip", local[0] if len(local) else "")).split("%", 1)[0]
            try:
                address = ipaddress.ip_address(host)
            except ValueError:
                return False
            if not address.is_loopback:
                return False
            found_loopback = True
        return found_loopback

    def start(self, ttl_seconds: int) -> None:
        self.stop()
        # Fail closed if the actual SSH daemon listens on LAN/all interfaces.
        if not self._target_is_loopback_only():
            raise RuntimeError("ssh_target_not_loopback_only")
        # Require an IPv4 loopback listener because the fixed proxy target is 127.0.0.1.
        with socket.create_connection(("127.0.0.1", self.target_port), timeout=2.0):
            pass
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", self.listen_port))
        listener.listen(16)
        listener.settimeout(0.5)
        with self._lock:
            self._stop.clear()
            self._deadline = time.monotonic() + ttl_seconds
            self._listener = listener
            self._thread = threading.Thread(
                target=self._serve,
                name="citadel-ssh-gate",
                daemon=True,
            )
            self._thread.start()

    def _serve(self) -> None:
        try:
            while not self._stop.is_set() and time.monotonic() < self._deadline:
                listener = self._listener
                if listener is None:
                    return
                try:
                    client, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                threading.Thread(
                    target=self._relay,
                    args=(client,),
                    name="citadel-ssh-gate-client",
                    daemon=True,
                ).start()
        finally:
            self._close_listener()

    def _relay(self, client: socket.socket) -> None:
        target: socket.socket | None = None
        try:
            target = socket.create_connection(("127.0.0.1", self.target_port), timeout=5.0)
            client.settimeout(2.0)
            target.settimeout(2.0)
            sockets = [client, target]
            while not self._stop.is_set() and time.monotonic() < self._deadline:
                readable, _, _ = select.select(sockets, [], [], 0.5)
                if not readable:
                    continue
                for source in readable:
                    data = source.recv(65536)
                    if not data:
                        return
                    destination = target if source is client else client
                    destination.sendall(data)
        except (OSError, ValueError):
            return
        finally:
            with contextlib.suppress(OSError):
                client.close()
            if target is not None:
                with contextlib.suppress(OSError):
                    target.close()

    def _close_listener(self) -> None:
        with self._lock:
            listener = self._listener
            self._listener = None
        if listener is not None:
            with contextlib.suppress(OSError):
                listener.close()

    def stop(self) -> None:
        self._stop.set()
        self._close_listener()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        self._thread = None
        self._deadline = 0.0


TAILSCALE_INTERFACE_MARKER = "tailscale"
VIRTUAL_INTERFACE_TOKENS = (
    "loopback",
    "docker",
    "vethernet",
    "hyper-v",
    "vmware",
    "virtualbox",
    "wsl",
)


def _normalize_mac(value: str) -> str | None:
    compact = "".join(ch for ch in str(value) if ch.isalnum()).upper()
    if len(compact) != 12 or any(ch not in "0123456789ABCDEF" for ch in compact):
        return None
    if compact == "000000000000":
        return None
    return ":".join(compact[index:index + 2] for index in range(0, 12, 2))


def local_network_addresses() -> dict[str, Any]:
    """Discover current physical LAN/Tailscale IPv4 and MAC addresses."""
    lan: list[str] = []
    tailscale: list[str] = []
    mac_addresses: list[str] = []
    interfaces: list[dict[str, str]] = []
    try:
        stats = psutil.net_if_stats()
        addresses = psutil.net_if_addrs()
    except Exception:
        return {
            "lan_ipv4": None,
            "tailscale_ipv4": None,
            "private_ipv4": [],
            "mac_addresses": [],
            "interfaces": [],
        }

    link_family = getattr(psutil, "AF_LINK", None)
    for interface_name, items in addresses.items():
        state = stats.get(interface_name)
        if state is not None and not state.isup:
            continue
        lowered = interface_name.lower()
        is_virtual = any(token in lowered for token in VIRTUAL_INTERFACE_TOKENS)
        interface_ipv4: str | None = None
        interface_mac: str | None = None
        for item in items:
            if item.family == socket.AF_INET:
                try:
                    address = ipaddress.ip_address(item.address)
                except ValueError:
                    continue
                if (
                    address.is_loopback
                    or address.is_link_local
                    or address.is_multicast
                    or address.is_unspecified
                ):
                    continue
                value = str(address)
                interface_ipv4 = interface_ipv4 or value
                if TAILSCALE_INTERFACE_MARKER in lowered:
                    tailscale.append(value)
                elif address.is_private and not is_virtual:
                    lan.append(value)
            elif link_family is not None and item.family == link_family and not is_virtual:
                normalized = _normalize_mac(item.address)
                if normalized:
                    interface_mac = normalized
                    mac_addresses.append(normalized)
        if interface_ipv4 or interface_mac:
            entry = {"name": interface_name[:120]}
            if interface_ipv4:
                entry["ipv4"] = interface_ipv4
            if interface_mac:
                entry["mac"] = interface_mac
            interfaces.append(entry)

    lan = list(dict.fromkeys(lan))
    tailscale = list(dict.fromkeys(tailscale))
    mac_addresses = list(dict.fromkeys(mac_addresses))
    return {
        "lan_ipv4": lan[0] if lan else None,
        "tailscale_ipv4": tailscale[0] if tailscale else None,
        "private_ipv4": lan,
        "mac_addresses": mac_addresses[:16],
        "interfaces": interfaces[:32],
    }


def _windows_enterprise_probe_path() -> Path:
    return Path(__file__).resolve().with_name("windows_enterprise_probe.ps1")


def _windows_enterprise_probe_file_valid() -> bool:
    if os.name != "nt":
        return False
    path = _windows_enterprise_probe_path()
    try:
        data = path.read_bytes()
    except OSError:
        return False
    return (
        0 < len(data) <= WINDOWS_ENTERPRISE_PROBE_MAX_BYTES
        and hashlib.sha256(data).hexdigest() == WINDOWS_ENTERPRISE_PROBE_SHA256
    )


def _ensure_windows_enterprise_probe_file() -> bool:
    """Restore the fixed, release-embedded probe if a legacy update lacked the companion file."""
    if os.name != "nt":
        return False
    if _windows_enterprise_probe_file_valid():
        return True
    try:
        data = base64.b64decode(WINDOWS_ENTERPRISE_PROBE_B64, validate=True)
    except (ValueError, binascii.Error):
        return False
    if (
        not data
        or len(data) > WINDOWS_ENTERPRISE_PROBE_MAX_BYTES
        or hashlib.sha256(data).hexdigest() != WINDOWS_ENTERPRISE_PROBE_SHA256
    ):
        return False

    path = _windows_enterprise_probe_path()
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp_name)
    return _windows_enterprise_probe_file_valid()


def windows_enterprise_probe() -> dict[str, Any]:
    """Run the reviewed, hash-pinned read-only Microsoft/Windows probe."""
    if os.name != "nt":
        return {
            "supported": False,
            "available": False,
            "reason": "windows_only",
            "readonly": True,
        }

    script = _windows_enterprise_probe_path()
    if not _windows_enterprise_probe_file_valid():
        return {
            "supported": True,
            "available": False,
            "reason": "probe_missing_or_integrity_failed",
            "readonly": True,
        }

    system_root = Path(os.environ.get("SystemRoot") or r"C:\Windows")
    powershell = system_root / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        fallback = shutil.which("powershell.exe")
        if not fallback:
            return {
                "supported": True,
                "available": False,
                "reason": "windows_powershell_unavailable",
                "readonly": True,
            }
        powershell = Path(fallback)

    try:
        result = subprocess.run(  # nosec B603
            [
                str(powershell),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                str(script),
            ],
            timeout=30,
            capture_output=True,
            text=True,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "supported": True,
            "available": False,
            "reason": "probe_execution_failed",
            "detail": str(exc)[:200],
            "readonly": True,
        }

    if result.returncode != 0:
        return {
            "supported": True,
            "available": False,
            "reason": "probe_returned_error",
            "detail": (result.stderr or result.stdout or "")[:300],
            "readonly": True,
        }

    try:
        payload = json.loads(result.stdout.strip())
    except (json.JSONDecodeError, TypeError):
        return {
            "supported": True,
            "available": False,
            "reason": "probe_invalid_json",
            "readonly": True,
        }
    if not isinstance(payload, dict) or payload.get("readonly") is not True:
        return {
            "supported": True,
            "available": False,
            "reason": "probe_invalid_schema",
            "readonly": True,
        }
    payload["supported"] = True
    payload["available"] = True
    return payload


def system_inventory(payload: dict[str, Any]) -> dict[str, Any]:
    disk = shutil.disk_usage(Path.home())
    memory = psutil.virtual_memory()
    requested_task = str(payload.get("task_text") or "").strip()[:2000]
    return {
        "captured_at": now_iso(),
        "requested_task": requested_task or None,
        "hostname": socket.gethostname(),
        "platform": platform.system(),
        "platform_release": platform.release(),
        "architecture": platform.machine(),
        "python_version": platform.python_version(),
        "windows_core_service": os.name == "nt" and os.environ.get("CITADEL_SERVICE_MANAGED") == "1",
        "windows_quick_user": os.name == "nt" and os.environ.get("CITADEL_QUICK_USER") == "1",
        "cpu_logical_count": psutil.cpu_count(logical=True),
        "memory_total_bytes": int(memory.total),
        "disk_home_total_bytes": int(disk.total),
        "disk_home_free_bytes": int(disk.free),
        "network": local_network_addresses(),
        "windows_enterprise": windows_enterprise_probe(),
    }


HANDLERS: dict[str, MissionHandler] = {"system_inventory": system_inventory}


class Agent:
    def __init__(self, config: AgentConfig, config_path: Path | None = None) -> None:
        self.config = config
        self.config_path = (config_path or Path("config.json")).resolve()
        if os.name == "nt":
            _ensure_windows_enterprise_probe_file()
        config.data_dir.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(config.data_dir, 0o700)
        self.identity = Identity(config.data_dir / "identity.json")
        self.api = ApiClient(config, self.identity)
        self.log = JsonlLogger(config.data_dir / "agent.jsonl")
        self.results = ResultQueue(config.data_dir / "pending-results.json")
        self.stop_path = config.data_dir / "STOP"
        lifecycle_stop = os.environ.get("CITADEL_SERVICE_STOP_FILE", "").strip()
        self.lifecycle_stop_path = Path(lifecycle_stop).resolve() if lifecycle_stop else None
        service_hold = os.environ.get("CITADEL_SERVICE_HOLD_FILE", "").strip()
        self.service_hold_path = Path(service_hold).resolve() if service_hold else None
        service_ready = os.environ.get("CITADEL_SERVICE_READY_FILE", "").strip()
        self.service_ready_path = Path(service_ready).resolve() if service_ready else None
        self.paused_path = config.data_dir / "PAUSED"
        self.lmstudio_state_path = config.data_dir / "lmstudio-state.json"
        self.ssh_gate_state_path = config.data_dir / "ssh-gate-state.json"
        self.ssh_gate = (
            SshGateProxy(config.ssh_gate_listen_port, config.ssh_gate_target_port)
            if config.ssh_gate_enabled
            else None
        )
        self.network_recovery_path = config.data_dir / "network-recovery.json"
        self.last_network_recovery = 0.0
        self.last_network_remember = 0.0
        self.last_power_guard = 0.0
        self.power_guard_active = False
        self.last_heartbeat = 0.0
        self.enrollment_confirmed = False

    @property
    def capabilities(self) -> list[str]:
        capabilities = set(HANDLERS) | {"lmstudio_remote", "project_text", "project_python"}
        if self.config.prevent_automatic_sleep:
            capabilities.add("always_on_guard")
        if self.config.network_recovery_enabled:
            capabilities.add("known_network_recovery")
        if os.name == "nt" and os.environ.get("CITADEL_SERVICE_MANAGED") == "1":
            capabilities.add("windows_core_service")
        if os.name == "nt" and os.environ.get("CITADEL_QUICK_USER") == "1":
            capabilities.add("windows_quick_user")
        if _windows_enterprise_probe_file_valid():
            capabilities.add("windows_enterprise_readonly")
        if self.config.ssh_gate_enabled:
            capabilities.add("ssh_gate_loopback")
        return sorted(capabilities)

    def require_node_id(self) -> str:
        if not self.identity.node_id:
            raise RuntimeError("node is not enrolled")
        return self.identity.node_id

    def enroll(self) -> str:
        if self.enrollment_confirmed and self.identity.node_id:
            return self.identity.node_id
        previous_node_id = self.identity.node_id
        response = self.api.request(
            "POST",
            "/api/v1/enroll",
            {
                "public_key": self.identity.public_jwk(),
                "hostname": socket.gethostname(),
                "os_name": platform.system() or "Unknown",
                "os_version": platform.release(),
                "architecture": platform.machine() or "unknown",
                "agent_version": VERSION,
                "capabilities": self.capabilities,
            },
            signed=False,
        )
        node = response.get("node", {})
        node_id = str(node.get("node_id") or "")
        node_number = int(node.get("node_number") or 0)
        if not node_id.startswith("node_") or node_number <= 0:
            raise RuntimeError("controller returned invalid node identity")
        if previous_node_id != node_id:
            self.identity.set_node_id(node_id)
        self.enrollment_confirmed = True
        self.log.write(
            "node_enrolled",
            node_id=node_id,
            node_number=node_number,
            reconciled=bool(previous_node_id and previous_node_id != node_id),
        )
        return node_id

    def heartbeat(self) -> None:
        node_id = self.require_node_id()
        network = local_network_addresses()
        self.api.request(
            "POST",
            f"/api/v1/nodes/{node_id}/heartbeat",
            {
                "cpu_percent": float(psutil.cpu_percent(interval=0.05)),
                "memory_percent": float(psutil.virtual_memory().percent),
                "agent_version": VERSION,
                "capabilities": self.capabilities,
                "network": {
                    "lan_ipv4": network.get("lan_ipv4"),
                    "tailscale_ipv4": network.get("tailscale_ipv4"),
                    "mac_addresses": network.get("mac_addresses") or [],
                },
            },
        )
        self.last_heartbeat = time.monotonic()
        if time.monotonic() - self.last_network_remember >= 300:
            self.remember_network_profile()
            self.last_network_remember = time.monotonic()

    def resources_ok(self) -> tuple[bool, dict[str, float]]:
        cpu = float(psutil.cpu_percent(interval=0.1))
        memory = float(psutil.virtual_memory().percent)
        return (
            cpu <= self.config.max_cpu_percent and memory <= self.config.max_memory_percent,
            {"cpu_percent": cpu, "memory_percent": memory},
        )

    def submit_result(self, result: dict[str, Any]) -> None:
        node_id = self.require_node_id()
        self.api.request("POST", f"/api/v1/nodes/{node_id}/results", result)

    def execute_project_text(self, payload: dict[str, Any]) -> dict[str, Any]:
        task_text = str(payload.get("task_text") or "").strip()
        role_name = str(payload.get("role_name") or "planner").strip()
        project_id = str(payload.get("project_id") or "").strip()
        work_item_id = str(payload.get("work_item_id") or "").strip()
        if not task_text or len(task_text) > 20000:
            raise RuntimeError("invalid project task")
        if not role_name or len(role_name) > 64:
            raise RuntimeError("invalid project role")

        state = self.lmstudio_state()
        model = str(state.get("loaded_model") or "").strip()
        if not model or not LMSTUDIO_MODEL_RE.fullmatch(model):
            raise RuntimeError("lmstudio_model_not_loaded")

        system_prompt = (
            "You are the CITADEL project worker for role: " + role_name + ". "
            "Work only on the supplied text task. Return a useful factual result in plain text. "
            "Do not execute commands, access credentials, modify the host, or claim actions you did not perform."
        )
        request_body = json_text({
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": task_text},
            ],
            "temperature": 0.2,
            "max_tokens": 4096,
        })
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            1234,
            timeout=max(1800, self.config.request_timeout_seconds),
        )
        try:
            connection.request(
                "POST",
                "/v1/chat/completions",
                body=request_body.encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": USER_AGENT,
                    **self.lmstudio_auth_headers(),
                },
            )
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("lmstudio_response_too_large")
            if response.status != 200:
                raise RuntimeError(f"lmstudio_http_{response.status}")
        finally:
            connection.close()

        try:
            decoded = json.loads(raw.decode("utf-8"))
            content = decoded["choices"][0]["message"]["content"]
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
            raise RuntimeError("lmstudio_invalid_response")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("lmstudio_empty_response")
        content = content.strip()
        if len(content) > 180000:
            content = content[:180000] + "\n\n[truncated]"
        return {
            "project_id": project_id or None,
            "work_item_id": work_item_id or None,
            "role_name": role_name,
            "model": model,
            "content": content,
            "completed_at": now_iso(),
        }

    def python_mini_agent_tasks(self, task_text: str) -> list[str]:
        """Split a Python-only project into a bounded set of local deterministic workers."""
        raw_parts = [
            re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", part).strip()
            for part in re.split(r"\r?\n|(?<=;)\s+", task_text)
            if part.strip()
        ]
        supported_prefix = ("calc:", "calculate:", "посчитай:", "вычисли:", "text:", "текст:", "json:", "json ")
        parts = [part for part in raw_parts if part]
        if len(parts) <= 1 and task_text.lower().startswith(supported_prefix):
            return [task_text.strip()]
        if len(parts) <= 1:
            return [task_text.strip()]
        return parts[:8]

    def execute_project_python(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Coordinate bounded local Python mini-workers without calling any LLM."""
        task_text = str(payload.get("task_text") or "").strip()
        role_name = str(payload.get("role_name") or "programmer").strip()
        project_id = str(payload.get("project_id") or "").strip()
        work_item_id = str(payload.get("work_item_id") or "").strip()
        if not task_text or len(task_text) > 20000:
            raise RuntimeError("invalid project task")
        if not role_name or len(role_name) > 64:
            raise RuntimeError("invalid project role")
        tasks = self.python_mini_agent_tasks(task_text)
        max_workers = min(4, len(tasks))
        def run_worker(index_and_task: tuple[int, str]) -> dict[str, Any]:
            index, subtask = index_and_task
            answer = self.python_mode_answer(subtask)
            return {
                "mini_agent_id": f"py-mini-{index + 1}",
                "task": subtask,
                "status": "completed",
                "content": answer,
            }
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="citadel-python-mini",
        ) as pool:
            mini_agents = list(pool.map(run_worker, enumerate(tasks)))
        content = "\n\n".join(
            f"[{worker['mini_agent_id']}]\n{worker['content']}"
            for worker in mini_agents
        )
        self.log.write(
            "python_mini_agents_completed",
            project_id=project_id or None,
            work_item_id=work_item_id or None,
            mini_agent_count=len(mini_agents),
        )
        return {
            "project_id": project_id or None,
            "work_item_id": work_item_id or None,
            "role_name": role_name,
            "engine": "python",
            "model": None,
            "mini_agent_count": len(mini_agents),
            "mini_agents": mini_agents,
            "content": content,
            "completed_at": now_iso(),
        }

    def execute_assignment(self, assignment: dict[str, Any]) -> None:
        node_id = self.require_node_id()
        assignment_id = str(assignment.get("assignment_id") or "")
        mission_type = str(assignment.get("mission_type") or "")
        handler = HANDLERS.get(mission_type)
        is_project_text = mission_type == "project_text"
        is_project_python = mission_type == "project_python"
        if not assignment_id or (handler is None and not is_project_text and not is_project_python):
            self.log.write(
                "assignment_rejected_local",
                assignment_id=assignment_id,
                mission_type=mission_type,
            )
            return
        allowed, metrics = self.resources_ok()
        if not allowed:
            self.log.write("resource_guard", assignment_id=assignment_id, **metrics)
            return
        quoted = urllib.parse.quote(assignment_id, safe="")
        self.api.request(
            "POST",
            f"/api/v1/nodes/{node_id}/assignments/{quoted}/accept",
            {},
        )
        started = time.monotonic()
        try:
            if is_project_python:
                report = self.execute_project_python(assignment.get("payload") or {})
            elif is_project_text:
                report = self.execute_project_text(assignment.get("payload") or {})
            else:
                report = handler(assignment.get("payload") or {})
            result = {
                "assignment_id": assignment_id,
                "outcome": "success",
                "summary": f"{mission_type} completed by CITADEL node {VERSION}",
                "metrics": {
                    **metrics,
                    "duration_ms": int((time.monotonic() - started) * 1000),
                },
                "report_type": mission_type,
                "sensitivity": "internal",
                "report": report,
            }
        except Exception as error:
            result = {
                "assignment_id": assignment_id,
                "outcome": "failed",
                "summary": f"{mission_type} failed locally: {type(error).__name__}",
                "metrics": {
                    **metrics,
                    "duration_ms": int((time.monotonic() - started) * 1000),
                },
                "report_type": mission_type,
                "sensitivity": "internal",
                "report": {"error_type": type(error).__name__},
            }
        try:
            self.submit_result(result)
            self.log.write(
                "result_submitted",
                assignment_id=assignment_id,
                outcome=result["outcome"],
            )
        except Exception as error:
            self.results.push(result)
            self.log.write(
                "result_queued",
                assignment_id=assignment_id,
                error=str(error)[:300],
            )

    def verify_controller_command(self, command: dict[str, Any]) -> bool:
        command_id = str(command.get("command_id") or "")
        command_type = str(command.get("command_type") or "")
        created_at = str(command.get("created_at") or "")
        signature = str(command.get("signature") or "")
        if command_type not in SUPPORTED_COMMANDS:
            return False
        if not all((command_id, created_at, signature, self.identity.node_id)):
            return False
        try:
            created = dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            if created.tzinfo is None:
                created = created.replace(tzinfo=dt.timezone.utc)
            age_seconds = (dt.datetime.now(dt.timezone.utc) - created.astimezone(dt.timezone.utc)).total_seconds()
            if age_seconds < -60 or age_seconds > COMMAND_MAX_AGE_SECONDS:
                return False
        except (TypeError, ValueError):
            return False
        payload = command.get("payload") or {}
        if not isinstance(payload, dict):
            return False
        if command_type == "update":
            if not self.validate_update_payload(payload):
                return False
        elif command_type == "wake_peer":
            if not self.validate_wake_payload(payload):
                return False
        elif command_type == "lmstudio_install":
            if not self.validate_lmstudio_install_payload(payload):
                return False
        elif command_type == "lmstudio_uninstall":
            if not self.validate_lmstudio_uninstall_payload(payload):
                return False
        elif command_type in {"lmstudio_model_get", "lmstudio_model_load"}:
            if not self.validate_lmstudio_model_payload(payload):
                return False
        elif command_type == "hybrid_query":
            if not self.validate_hybrid_payload(payload):
                return False
        elif command_type == "ssh_open":
            if not self.validate_ssh_open_payload(payload):
                return False
        elif payload != {}:
            return False
        payload_json = json_text(payload)
        canonical = "\n".join(
            (
                "CITADEL-COMMAND-V1",
                command_id,
                self.identity.node_id or "",
                command_type,
                sha256_text(payload_json),
                created_at,
            )
        ).encode("utf-8")
        try:
            key = Ed25519PublicKey.from_public_bytes(
                unb64url(self.config.controller_public_x)
            )
            key.verify(unb64url(signature), canonical)
            return True
        except Exception:
            return False

    @staticmethod
    def validate_ssh_open_payload(payload: dict[str, Any]) -> bool:
        if set(payload) != {"session_id", "ttl_seconds"}:
            return False
        session_id = payload.get("session_id")
        ttl_seconds = payload.get("ttl_seconds")
        return (
            isinstance(session_id, str)
            and bool(SSH_GATE_SESSION_RE.fullmatch(session_id))
            and isinstance(ttl_seconds, int)
            and not isinstance(ttl_seconds, bool)
            and SSH_GATE_MIN_TTL_SECONDS <= ttl_seconds <= SSH_GATE_MAX_TTL_SECONDS
        )

    @staticmethod
    def validate_update_payload(payload: dict[str, Any]) -> bool:
        version = payload.get("version")
        files = payload.get("files")
        if not isinstance(version, str) or not version or len(version) > 32:
            return False
        if not isinstance(files, list) or not 1 <= len(files) <= len(UPDATE_FILE_NAMES):
            return False
        seen: set[str] = set()
        for item in files:
            if not isinstance(item, dict):
                return False
            name = item.get("path")
            url = item.get("url")
            digest = item.get("sha256")
            if name not in UPDATE_FILE_NAMES or name in seen:
                return False
            parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
            if (
                parsed is None
                or parsed.scheme != "https"
                or parsed.hostname != "raw.githubusercontent.com"
                or not parsed.path.startswith("/citadel-AI-EWS/EWS/")
                or not parsed.path.endswith("/agent/" + name)
                or not isinstance(digest, str)
                or len(digest) != 64
                or any(char not in "0123456789abcdef" for char in digest)
            ):
                return False
            seen.add(name)
        return True

    @staticmethod
    def validate_wake_payload(payload: dict[str, Any]) -> bool:
        target_node_id = payload.get("target_node_id")
        target_mac = payload.get("target_mac")
        target_lan_ipv4 = payload.get("target_lan_ipv4")
        if not isinstance(target_node_id, str) or not target_node_id.startswith("node_") or len(target_node_id) > 128:
            return False
        if not isinstance(target_mac, str) or _normalize_mac(target_mac) != target_mac.upper():
            return False
        try:
            address = ipaddress.ip_address(target_lan_ipv4)
        except (ValueError, TypeError):
            return False
        return address.version == 4 and address.is_private

    @staticmethod
    def validate_lmstudio_install_payload(payload: dict[str, Any]) -> bool:
        asset = payload.get("asset")
        if not isinstance(asset, dict):
            return False
        name = asset.get("path")
        url = asset.get("url")
        digest = asset.get("sha256")
        if name not in LMSTUDIO_INSTALL_FILE_NAMES:
            return False
        parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
        if (
            parsed is None
            or parsed.scheme != "https"
            or parsed.hostname != "raw.githubusercontent.com"
            or parsed.path != f"/citadel-AI-EWS/EWS/main/agent/lmstudio/{name}"
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(char not in "0123456789abcdef" for char in digest)
        ):
            return False
        expected = "install_llmstudio_headless.py" if os.name == "nt" else "install_llmstudio_headless.sh"
        return name == expected

    @staticmethod
    def validate_lmstudio_model_payload(payload: dict[str, Any]) -> bool:
        model = payload.get("model")
        return isinstance(model, str) and bool(LMSTUDIO_MODEL_RE.fullmatch(model))

    def lmstudio_state(self) -> dict[str, Any]:
        state = load_json(self.lmstudio_state_path, {}) or {}
        return state if isinstance(state, dict) else {}

    def save_lmstudio_state(self, **updates: Any) -> None:
        state = self.lmstudio_state()
        state.update(updates)
        state["updated_at"] = now_iso()
        atomic_write(self.lmstudio_state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")

    def report_ai_state(self, **updates: Any) -> None:
        self.save_lmstudio_state(**updates)
        if not self.identity.node_id:
            return
        state = self.lmstudio_state()
        allowed = {
            "installed", "selected_model", "loaded_model", "server_running", "last_action",
            "progress_phase", "progress_current", "progress_total", "progress_bytes",
            "progress_total_bytes", "progress_detail", "download_job_id",
            "query_id", "query_mode", "query_status", "query_prompt", "query_answer",
            "load_config",
        }
        body = {key: state.get(key) for key in allowed if key in state}
        try:
            self.api.request(
                "POST",
                f"/api/v1/nodes/{self.require_node_id()}/ai-state",
                body,
            )
        except Exception as error:
            self.log.write("lmstudio_state_report_failed", error=str(error)[:300])

    def find_lms(self) -> str | None:
        candidates: list[str | None] = [shutil.which("lms")]
        for root in self.lmstudio_managed_roots():
            if os.name == "nt":
                candidates.extend([
                    str(root / "bin" / "lms.exe"),
                    str(root / "bin" / "lms.cmd"),
                    str(root / "bin" / "lms"),
                ])
            else:
                candidates.append(str(root / "bin" / "lms"))
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return str(Path(candidate))
        return None

    def lmstudio_runtime_home(self) -> Path:
        """Return the stable CITADEL-managed HOME used by llmster."""
        home = (self.config.data_dir / "lmstudio-runtime-home").resolve()
        home.mkdir(parents=True, exist_ok=True)
        return home

    def lmstudio_process_env(self) -> dict[str, str]:
        env = os.environ.copy()
        runtime_home = str(self.lmstudio_runtime_home())
        env["CITADEL_LMSTUDIO_HOME"] = runtime_home
        env["HOME"] = runtime_home
        env["LMS_NO_MODIFY_PATH"] = "1"
        if self.config.lm_api_token:
            env["LM_API_TOKEN"] = self.config.lm_api_token
        return env

    def lmstudio_auth_headers(self) -> dict[str, str]:
        if not self.config.lm_api_token:
            return {}
        return {"Authorization": "Bearer " + self.config.lm_api_token}

    def run_lms(self, args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
        executable = self.find_lms()
        if not executable:
            raise RuntimeError("lmstudio_not_installed")
        result = subprocess.run(  # nosec B603
            [executable, *args],
            timeout=timeout,
            capture_output=True,
            text=True,
            shell=False,
            env=self.lmstudio_process_env(),
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "lms command failed").strip()
            raise RuntimeError(detail[:500])
        return result

    def lmstudio_http_json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        timeout: int = 120,
    ) -> dict[str, Any]:
        if not path.startswith("/api/v1/") and path != "/v1/models":
            raise RuntimeError("lmstudio_path_not_allowed")
        encoded = None if body is None else json_text(body).encode("utf-8")
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT, **self.lmstudio_auth_headers()}
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", 1234, timeout=timeout)
        try:
            connection.request(method.upper(), path, body=encoded, headers=headers)
            response = connection.getresponse()
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("lmstudio_response_too_large")
            try:
                value = json.loads(raw.decode("utf-8")) if raw else {}
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RuntimeError("lmstudio_invalid_json") from exc
            if not 200 <= response.status < 300:
                detail = value.get("error") if isinstance(value, dict) else None
                raise RuntimeError(f"lmstudio_http_{response.status}:{str(detail)[:300]}")
            return value if isinstance(value, dict) else {"items": value}
        finally:
            connection.close()

    @staticmethod
    def _loaded_model_name(item: Any) -> str | None:
        if not isinstance(item, dict):
            return None
        for key in ("identifier", "modelKey", "model_key", "model", "path", "name", "id"):
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def probe_lmstudio(self) -> dict[str, Any]:
        state = self.lmstudio_state()
        installed = self.find_lms() is not None
        server_running = False
        loaded_models: list[str] = []
        if installed:
            try:
                status = self.run_lms(["server", "status", "--json", "--quiet"], timeout=15)
                decoded = json.loads(status.stdout or "{}")
                server_running = bool(decoded.get("running")) if isinstance(decoded, dict) else False
            except Exception:
                server_running = False
            if server_running:
                try:
                    self.lmstudio_http_json("GET", "/v1/models", timeout=10)
                except Exception:
                    server_running = False
            if server_running:
                try:
                    loaded = self.run_lms(["ps", "--json"], timeout=20)
                    decoded = json.loads(loaded.stdout or "[]")
                    rows = decoded if isinstance(decoded, list) else decoded.get("models", []) if isinstance(decoded, dict) else []
                    for item in rows:
                        name = self._loaded_model_name(item)
                        if name and name not in loaded_models:
                            loaded_models.append(name)
                except Exception:
                    loaded_models = []
        loaded_model = loaded_models[0] if loaded_models else None
        snapshot = {
            "installed": installed,
            "selected_model": state.get("selected_model"),
            "loaded_model": loaded_model,
            "server_running": server_running,
            "last_action": state.get("last_action"),
            "progress_phase": state.get("progress_phase"),
            "progress_current": state.get("progress_current"),
            "progress_total": state.get("progress_total"),
            "progress_bytes": state.get("progress_bytes"),
            "progress_total_bytes": state.get("progress_total_bytes"),
            "progress_detail": state.get("progress_detail"),
            "download_job_id": state.get("download_job_id"),
            "query_id": state.get("query_id"),
            "query_mode": state.get("query_mode"),
            "query_status": state.get("query_status"),
            "load_config": state.get("load_config"),
            "loaded_models": loaded_models[:8],
            "live_checked_at": now_iso(),
        }
        self.save_lmstudio_state(
            installed=installed,
            server_running=server_running,
            loaded_model=loaded_model,
            live_checked_at=snapshot["live_checked_at"],
        )
        return snapshot

    @staticmethod
    def validate_lmstudio_install_payload(payload: dict[str, Any]) -> bool:
        asset = payload.get("asset")
        if not isinstance(asset, dict):
            return False
        name = asset.get("path")
        url = asset.get("url")
        digest = asset.get("sha256")
        if name not in LMSTUDIO_INSTALL_FILE_NAMES:
            return False
        parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
        if (
            parsed is None
            or parsed.scheme != "https"
            or parsed.hostname != "raw.githubusercontent.com"
            or parsed.path != f"/citadel-AI-EWS/EWS/main/agent/lmstudio/{name}"
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(char not in "0123456789abcdef" for char in digest)
        ):
            return False
        expected = "install_llmstudio_headless.ps1" if os.name == "nt" else "install_llmstudio_headless.sh"
        return name == expected

    @staticmethod
    def validate_lmstudio_uninstall_payload(payload: dict[str, Any]) -> bool:
        return (
            isinstance(payload, dict)
            and set(payload).issubset({"purge_data"})
            and isinstance(payload.get("purge_data", False), bool)
        )

    @staticmethod
    def validate_lmstudio_model_payload(payload: dict[str, Any]) -> bool:
        model = payload.get("model")
        if not isinstance(model, str) or not LMSTUDIO_MODEL_RE.fullmatch(model):
            return False
        source = payload.get("source", "catalog")
        if source not in {"catalog", "huggingface"}:
            return False
        quantization = payload.get("quantization")
        if quantization is not None and (
            not isinstance(quantization, str) or not LMSTUDIO_QUANT_RE.fullmatch(quantization)
        ):
            return False
        settings = payload.get("settings", {})
        if not isinstance(settings, dict):
            return False
        allowed = {"context_length", "flash_attention", "offload_kv_cache_to_gpu", "num_experts"}
        if any(key not in allowed for key in settings):
            return False
        context = settings.get("context_length")
        if context is not None and (not isinstance(context, int) or context < 256 or context > 1048576):
            return False
        for key in ("flash_attention", "offload_kv_cache_to_gpu"):
            if key in settings and not isinstance(settings[key], bool):
                return False
        experts = settings.get("num_experts")
        if experts is not None and (not isinstance(experts, int) or experts < 1 or experts > 256):
            return False
        return True

    @staticmethod
    def validate_hybrid_payload(payload: dict[str, Any]) -> bool:
        mode = payload.get("mode")
        prompt = payload.get("prompt")
        request_id = payload.get("request_id")
        if mode not in HYBRID_MODES:
            return False
        if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 8000:
            return False
        if not isinstance(request_id, str) or not re.fullmatch(r"query_[A-Za-z0-9_-]{8,80}", request_id):
            return False
        settings = payload.get("settings", {})
        if not isinstance(settings, dict):
            return False
        allowed = {"temperature", "top_p", "top_k", "min_p", "repeat_penalty", "max_output_tokens", "reasoning", "context_length"}
        if any(key not in allowed for key in settings):
            return False
        for key in ("temperature", "top_p", "min_p"):
            if key in settings and (not isinstance(settings[key], (int, float)) or not 0 <= float(settings[key]) <= 1):
                return False
        if "top_k" in settings and (not isinstance(settings["top_k"], int) or not 0 <= settings["top_k"] <= 1000):
            return False
        if "repeat_penalty" in settings and (
            not isinstance(settings["repeat_penalty"], (int, float)) or not 0.5 <= float(settings["repeat_penalty"]) <= 2.0
        ):
            return False
        if "max_output_tokens" in settings and (
            not isinstance(settings["max_output_tokens"], int) or not 1 <= settings["max_output_tokens"] <= 32768
        ):
            return False
        if "context_length" in settings and (
            not isinstance(settings["context_length"], int) or not 256 <= settings["context_length"] <= 1048576
        ):
            return False
        if "reasoning" in settings and settings["reasoning"] not in {"off", "low", "medium", "high", "on"}:
            return False
        return True

    def install_lmstudio(self, payload: dict[str, Any]) -> None:
        if not self.validate_lmstudio_install_payload(payload):
            raise RuntimeError("invalid lmstudio installer payload")
        asset = payload["asset"]
        self.report_ai_state(
            installed=False, last_action="installing",
            progress_phase="helper_download", progress_current=0, progress_total=5,
            progress_detail="Downloading reviewed CITADEL installer helper",
        )
        data = self.download_update_file(asset["url"])
        if hashlib.sha256(data).hexdigest() != asset["sha256"]:
            raise RuntimeError("lmstudio installer helper hash mismatch")
        self.report_ai_state(
            progress_phase="helper_verified", progress_current=1, progress_total=5,
            progress_detail="Installer helper SHA-256 verified",
        )
        suffix = ".ps1" if os.name == "nt" else ".sh"
        fd, temp_name = tempfile.mkstemp(prefix="citadel-lmstudio-", suffix=suffix, dir=self.config.data_dir)
        os.close(fd)
        helper = Path(temp_name)
        try:
            helper.write_bytes(data)
            if os.name == "nt":
                if helper.suffix.lower() == ".py":
                    argv = [sys.executable, str(helper)]
                else:
                    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
                    if not powershell:
                        raise RuntimeError("PowerShell unavailable")
                    argv = [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", str(helper)]
            else:
                bash = shutil.which("bash")
                if not bash:
                    raise RuntimeError("bash unavailable")
                argv = [bash, str(helper)]
            self.report_ai_state(
                progress_phase="upstream_installer", progress_current=2, progress_total=5,
                progress_detail="Official LM Studio / llmster installer is running",
            )
            result = subprocess.run(  # nosec B603
                argv,
                timeout=1800,
                capture_output=True,
                text=True,
                shell=False,
                env=self.lmstudio_process_env(),
            )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "LM Studio installation failed").strip()
                raise RuntimeError(detail[:500])
            if not self.find_lms():
                raise RuntimeError("lms CLI unavailable after installation")
            self.report_ai_state(
                installed=True, progress_phase="runtime_verified", progress_current=3, progress_total=5,
                progress_detail="lms CLI verified",
            )
            self.run_lms(["daemon", "up"], timeout=120)
            self.report_ai_state(
                installed=True, progress_phase="daemon_running", progress_current=4, progress_total=5,
                progress_detail="llmster daemon running",
            )
            self.run_lms(["server", "start", "--port", "1234", "--bind", "127.0.0.1"], timeout=120)
            deadline = time.monotonic() + 45
            last_error: Exception | None = None
            while time.monotonic() < deadline:
                try:
                    self.lmstudio_http_json("GET", "/v1/models", timeout=5)
                    last_error = None
                    break
                except Exception as error:
                    last_error = error
                    time.sleep(1)
            if last_error is not None:
                raise RuntimeError("lmstudio_server_not_responding:" + str(last_error)[:300])
            self.report_ai_state(
                installed=True, server_running=True, last_action="installed",
                progress_phase="complete", progress_current=5, progress_total=5,
                progress_detail="LM Studio server verified on http://127.0.0.1:1234/v1/models",
            )
            self.log.write("lmstudio_installed")
        finally:
            with contextlib.suppress(FileNotFoundError):
                helper.unlink()

    def lmstudio_managed_roots(self) -> list[Path]:
        """Return only allowlisted LM Studio roots under CITADEL or the legacy user home."""
        legacy_home = Path.home().resolve()
        runtime_home = self.lmstudio_runtime_home()
        candidates: list[Path] = [
            (runtime_home / ".lmstudio").resolve(),
            (runtime_home / ".cache" / "lm-studio").resolve(),
            (legacy_home / ".lmstudio").resolve(),
            (legacy_home / ".cache" / "lm-studio").resolve(),
        ]
        for home in (runtime_home, legacy_home):
            pointer = home / ".lmstudio-home-pointer"
            if pointer.is_file():
                try:
                    value = pointer.read_text(encoding="utf-8").strip()
                    if value:
                        candidates.append(Path(value).expanduser().resolve())
                except OSError:
                    pass
        allowed_names = {".lmstudio", "lm-studio"}
        safe: list[Path] = []
        for path in candidates:
            allowed_parent = None
            for parent in (runtime_home, legacy_home):
                try:
                    path.relative_to(parent)
                    allowed_parent = parent
                    break
                except ValueError:
                    continue
            if allowed_parent is None or path == allowed_parent or path.name not in allowed_names:
                continue
            if path not in safe:
                safe.append(path)
        return safe

    def uninstall_lmstudio(self, payload: dict[str, Any]) -> None:
        """Remove the CITADEL-managed LM Studio runtime without touching the agent."""
        if not self.validate_lmstudio_uninstall_payload(payload):
            raise RuntimeError("invalid lmstudio uninstall payload")
        purge_data = bool(payload.get("purge_data", False))
        self.report_ai_state(
            last_action="uninstalling",
            progress_phase="runtime_uninstall",
            progress_current=0,
            progress_total=3,
            progress_detail="Stopping LM Studio runtime",
        )
        if self.find_lms():
            for args in (["unload", "--all"], ["server", "stop"], ["daemon", "down"]):
                try:
                    self.run_lms(args, timeout=120)
                except Exception as error:
                    self.log.write(
                        "lmstudio_uninstall_stop_warning",
                        argv=args[:2],
                        error=str(error)[:200],
                    )
        roots = self.lmstudio_managed_roots()
        self.report_ai_state(
            progress_phase="runtime_remove",
            progress_current=1,
            progress_total=3,
            progress_detail="Removing CITADEL-managed LM Studio runtime files",
        )
        removed: list[str] = []
        for root in roots:
            target = root if purge_data else root / "bin"
            if not target.exists():
                continue
            shutil.rmtree(target)
            removed.append(str(target))
        if purge_data:
            for pointer_home in (self.lmstudio_runtime_home(), Path.home().resolve()):
                pointer = pointer_home / ".lmstudio-home-pointer"
                with contextlib.suppress(FileNotFoundError):
                    pointer.unlink()
        if self.find_lms():
            raise RuntimeError("lmstudio_runtime_still_detected")
        self.report_ai_state(
            installed=False,
            selected_model=None,
            loaded_model=None,
            server_running=False,
            last_action="uninstalled",
            progress_phase="complete",
            progress_current=3,
            progress_total=3,
            progress_detail=(
                "LM Studio runtime and managed data removed"
                if purge_data else
                "LM Studio runtime removed; models/data preserved"
            ),
            load_config=None,
        )
        self.log.write(
            "lmstudio_uninstalled",
            purge_data=purge_data,
            removed=removed[:4],
        )

    def resolve_lmstudio_model_key(self, model: str, quantization: str | None = None) -> str:
        try:
            result = self.run_lms(["ls", "--json"], timeout=30)
            decoded = json.loads(result.stdout or "[]")
            rows = decoded if isinstance(decoded, list) else decoded.get("models", []) if isinstance(decoded, dict) else []
            needle = model.lower()
            quant = (quantization or "").lower()
            best: str | None = None
            for item in rows:
                if not isinstance(item, dict):
                    continue
                encoded = json.dumps(item, ensure_ascii=False).lower()
                if needle not in encoded and needle.split("/")[-1] not in encoded:
                    continue
                if quant and quant not in encoded:
                    continue
                candidate = self._loaded_model_name(item)
                if candidate:
                    best = candidate
                    break
            if best:
                return best
        except Exception as error:
            self.log.write("lmstudio_model_key_resolution_fallback", error=str(error)[:300])
        return model + (("@" + quantization.lower()) if quantization else "")

    def download_lmstudio_model(self, payload: dict[str, Any]) -> None:
        if not self.validate_lmstudio_model_payload(payload):
            raise RuntimeError("invalid lmstudio model")
        model = payload["model"]
        source = payload.get("source", "catalog")
        quantization = payload.get("quantization")
        self.run_lms(["daemon", "up"], timeout=120)
        self.run_lms(["server", "start", "--port", "1234"], timeout=120)
        request_model = f"https://huggingface.co/{model}" if source == "huggingface" else model
        body: dict[str, Any] = {"model": request_model}
        if quantization:
            body["quantization"] = quantization
        self.report_ai_state(
            installed=True, server_running=True, selected_model=model,
            last_action="model_downloading", progress_phase="model_download",
            progress_bytes=0, progress_total_bytes=None, progress_detail=f"Starting download: {model}",
        )
        job = self.lmstudio_http_json("POST", "/api/v1/models/download", body, timeout=120)
        status = str(job.get("status") or "")
        job_id = job.get("job_id")
        if status not in {"already_downloaded", "completed"}:
            if not isinstance(job_id, str) or not job_id:
                raise RuntimeError("lmstudio_download_job_missing")
            while True:
                current = self.lmstudio_http_json(
                    "GET",
                    "/api/v1/models/download/status/" + urllib.parse.quote(job_id, safe=""),
                    timeout=60,
                )
                status = str(current.get("status") or "")
                downloaded = int(current.get("downloaded_bytes") or 0)
                total = int(current.get("total_size_bytes") or 0) or None
                self.report_ai_state(
                    installed=True, server_running=True, selected_model=model,
                    last_action="model_downloading", progress_phase="model_download",
                    progress_bytes=downloaded, progress_total_bytes=total,
                    download_job_id=job_id,
                    progress_detail=f"{status}: {model}",
                )
                if status == "completed":
                    break
                if status == "failed":
                    raise RuntimeError("lmstudio_model_download_failed")
                time.sleep(2)
        model_key = self.resolve_lmstudio_model_key(model, quantization)
        self.report_ai_state(
            installed=True, server_running=True, selected_model=model_key,
            last_action="model_downloaded", progress_phase="download_complete",
            progress_bytes=None, progress_total_bytes=None, download_job_id=job_id,
            progress_detail=f"Downloaded: {model_key}",
        )
        self.log.write("lmstudio_model_downloaded", model=model_key)

    def load_lmstudio_model(self, payload: dict[str, Any]) -> None:
        if not self.validate_lmstudio_model_payload(payload):
            raise RuntimeError("invalid lmstudio model")
        model = payload["model"]
        quantization = payload.get("quantization")
        settings = payload.get("settings") or {}
        model_key = self.resolve_lmstudio_model_key(model, quantization)
        self.run_lms(["daemon", "up"], timeout=120)
        self.run_lms(["server", "start", "--port", "1234"], timeout=120)
        body = {"model": model_key, "echo_load_config": True, **settings}
        self.report_ai_state(
            installed=True, server_running=True, selected_model=model_key,
            last_action="model_loading", progress_phase="model_load",
            progress_current=0, progress_total=1, progress_detail=f"Loading {model_key}",
        )
        loaded = self.lmstudio_http_json("POST", "/api/v1/models/load", body, timeout=1800)
        if loaded.get("status") != "loaded":
            raise RuntimeError("lmstudio_model_not_loaded")
        load_config = loaded.get("load_config") if isinstance(loaded.get("load_config"), dict) else settings
        instance = loaded.get("instance_id")
        loaded_model = str(instance or model_key)
        self.report_ai_state(
            installed=True, selected_model=model_key, loaded_model=loaded_model,
            server_running=True, last_action="model_loaded",
            progress_phase="load_complete", progress_current=1, progress_total=1,
            progress_detail=f"Loaded: {loaded_model}", load_config=load_config,
        )
        self.log.write("lmstudio_model_loaded", model=loaded_model)

    def python_mode_answer(self, prompt: str) -> str:
        """Answer only operations Python can determine without inference or an LLM."""
        stripped = prompt.strip()
        lowered = stripped.lower()
        expression = stripped
        for prefix in ("calc:", "calculate:", "посчитай:", "вычисли:"):
            if lowered.startswith(prefix):
                expression = stripped[len(prefix):].strip()
                break
        if re.fullmatch(r"[0-9eE+\-*/%().\s]{1,300}", expression):
            try:
                tree = ast.parse(expression, mode="eval")
                def calc(node: ast.AST) -> float | int:
                    if isinstance(node, ast.Expression):
                        return calc(node.body)
                    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
                        return node.value
                    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
                        value = calc(node.operand)
                        return value if isinstance(node.op, ast.UAdd) else -value
                    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow)):
                        left, right = calc(node.left), calc(node.right)
                        if isinstance(node.op, ast.Pow) and abs(float(right)) > 10:
                            raise ValueError("exponent too large")
                        result = {
                            ast.Add: lambda: left + right,
                            ast.Sub: lambda: left - right,
                            ast.Mult: lambda: left * right,
                            ast.Div: lambda: left / right,
                            ast.FloorDiv: lambda: left // right,
                            ast.Mod: lambda: left % right,
                            ast.Pow: lambda: left ** right,
                        }[type(node.op)]()
                        if abs(float(result)) > 1e15:
                            raise ValueError("result too large")
                        return result
                    raise ValueError("unsupported expression")
                return "Python calculation: " + str(calc(tree))
            except Exception as error:
                self.log.write("python_mode_calculation_fallback", error=str(error)[:300])

        text_prefix = next((p for p in ("text:", "текст:") if lowered.startswith(p)), None)
        if text_prefix:
            source = stripped[len(text_prefix):].strip()
            words = re.findall(r"[\w'-]+", source, flags=re.UNICODE)
            lines = source.splitlines() or ([source] if source else [])
            frequencies: dict[str, int] = {}
            for word in words:
                key = word.casefold()
                frequencies[key] = frequencies.get(key, 0) + 1
            common = sorted(frequencies.items(), key=lambda item: (-item[1], item[0]))[:10]
            return (
                "Python text analysis (no AI/LLM):\n"
                f"characters={len(source)}\n"
                f"words={len(words)}\n"
                f"lines={len(lines)}\n"
                f"sha256={hashlib.sha256(source.encode('utf-8')).hexdigest()}\n"
                "top_words=" + json.dumps(common, ensure_ascii=False)
            )

        json_prefix = next((p for p in ("json:", "json ") if lowered.startswith(p)), None)
        if json_prefix:
            source = stripped[len(json_prefix):].strip()
            try:
                value = json.loads(source)
            except json.JSONDecodeError as error:
                return f"Python JSON validation: invalid JSON at line {error.lineno}, column {error.colno}."
            if isinstance(value, dict):
                shape = f"object keys={len(value)} names={list(value)[:30]}"
            elif isinstance(value, list):
                shape = f"array items={len(value)}"
            else:
                shape = f"type={type(value).__name__}"
            preview = json.dumps(value, ensure_ascii=False, indent=2)
            if len(preview) > 12000:
                preview = preview[:12000] + "\n[truncated]"
            return "Python JSON analysis (no AI/LLM):\n" + shape + "\n" + preview

        system_terms = (
            "system", "computer", "cpu", "ram", "memory", "disk", "network",
            "система", "компьютер", "процессор", "памят", "диск", "сеть",
        )
        if any(term in lowered for term in system_terms):
            inv = system_inventory({"task_text": prompt})
            return (
                "Python agent deterministic node context (no AI/LLM):\n"
                f"hostname={inv['hostname']}\n"
                f"platform={inv['platform']} {inv['platform_release']}\n"
                f"architecture={inv['architecture']}\n"
                f"cpu_logical_count={inv['cpu_logical_count']}\n"
                f"memory_total_bytes={inv['memory_total_bytes']}\n"
                f"disk_free_bytes={inv['disk_home_free_bytes']}\n"
                f"network={json_text(inv['network'])}"
            )

        return (
            "Python-only mode: no AI/LLM was called. "
            "This prompt does not contain a deterministic operation Python can safely derive by itself. "
            "Supported forms: calc:/вычисли:, text:/текст:, json:, or a system/CPU/RAM/disk/network diagnostic question. "
            "For a free-form knowledge answer, use LM Studio/AI or provide structured data for Python to analyze."
        )

    def stream_lmstudio_answer(
        self,
        prompt: str,
        settings: dict[str, Any],
        request_id: str,
        python_context: str | None = None,
    ) -> str:
        state = self.probe_lmstudio()
        model = str(state.get("loaded_model") or state.get("selected_model") or "").strip()
        if not model:
            raise RuntimeError("lmstudio_model_not_loaded")
        body: dict[str, Any] = {
            "model": model,
            "input": prompt,
            "stream": True,
            **settings,
        }
        if python_context:
            body["system_prompt"] = (
                "Answer the user's question using the deterministic CITADEL Python-node context below when relevant. "
                "Do not invent machine state that is not present.\n\n" + python_context[:12000]
            )
        connection = http.client.HTTPConnection("127.0.0.1", 1234, timeout=1800)
        answer = ""
        last_report = 0.0
        try:
            connection.request(
                "POST",
                "/api/v1/chat",
                body=json_text(body).encode("utf-8"),
                headers={"Content-Type": "application/json", "Accept": "text/event-stream", "User-Agent": USER_AGENT, **self.lmstudio_auth_headers()},
            )
            response = connection.getresponse()
            if response.status != 200:
                raw = response.read(4096).decode("utf-8", errors="replace")
                raise RuntimeError(f"lmstudio_http_{response.status}:{raw[:300]}")
            event_type = ""
            while True:
                raw_line = response.readline()
                if not raw_line:
                    break
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                    continue
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                kind = str(event.get("type") or event_type)
                if kind == "message.delta":
                    content = event.get("content")
                    if isinstance(content, str):
                        answer += content
                        if len(answer) > 64000:
                            answer = answer[:64000] + "\n[truncated]"
                            break
                        now = time.monotonic()
                        if now - last_report >= 0.8:
                            self.report_ai_state(
                                query_id=request_id, query_status="running",
                                query_answer=answer, last_action="hybrid_query",
                            )
                            last_report = now
                elif kind == "error":
                    error = event.get("error")
                    raise RuntimeError("lmstudio_chat_error:" + str(error)[:300])
        finally:
            connection.close()
        if not answer.strip():
            raise RuntimeError("lmstudio_empty_response")
        return answer.strip()

    def run_hybrid_query(self, payload: dict[str, Any]) -> None:
        if not self.validate_hybrid_payload(payload):
            raise RuntimeError("invalid_hybrid_query")
        mode = payload["mode"]
        prompt = payload["prompt"].strip()
        request_id = payload["request_id"]
        settings = payload.get("settings") or {}
        self.report_ai_state(
            query_id=request_id, query_mode=mode, query_status="running",
            query_prompt=prompt, query_answer="", last_action="hybrid_query",
            progress_phase="query_running", progress_detail=f"Hybrid query: {mode}",
        )
        python_answer = self.python_mode_answer(prompt) if mode in {"python", "both"} else None
        if mode == "python":
            answer = python_answer or ""
        else:
            answer = self.stream_lmstudio_answer(
                prompt, settings, request_id,
                python_context=python_answer if mode == "both" else None,
            )
        self.report_ai_state(
            query_id=request_id, query_mode=mode, query_status="completed",
            query_prompt=prompt, query_answer=answer, last_action="hybrid_query_completed",
            progress_phase="query_complete", progress_detail="Hybrid response completed",
        )
        self.log.write("hybrid_query_completed", mode=mode, request_id=request_id)

    def send_wake_packet(self, payload: dict[str, Any]) -> None:
        if not self.validate_wake_payload(payload):
            raise RuntimeError("invalid wake payload")
        target_mac = str(payload["target_mac"]).replace(":", "")
        packet = bytes.fromhex("FF" * 6 + target_mac * 16)
        target_ip = ipaddress.ip_address(payload["target_lan_ipv4"])
        subnet = ipaddress.ip_network(f"{target_ip}/24", strict=False)
        destinations = ["255.255.255.255", str(subnet.broadcast_address)]
        sent = 0
        for destination in dict.fromkeys(destinations):
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                sock.settimeout(2.0)
                for _ in range(3):
                    sock.sendto(packet, (destination, 9))
                    sent += 1
            finally:
                sock.close()
        self.log.write(
            "wake_packet_sent",
            target_node_id=payload["target_node_id"],
            target_lan_ipv4=str(target_ip),
            packets=sent,
        )

    def download_update_file(self, url: str) -> bytes:
        parsed = urllib.parse.urlsplit(url)
        connection = http.client.HTTPSConnection(
            parsed.hostname,
            parsed.port or 443,
            timeout=self.config.request_timeout_seconds,
        )
        target = urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))
        try:
            connection.request("GET", target, headers={"User-Agent": USER_AGENT})
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError(f"update download failed: HTTP {response.status}")
            data = response.read(UPDATE_MAX_FILE_BYTES + 1)
            if len(data) > UPDATE_MAX_FILE_BYTES:
                raise RuntimeError("update file exceeds size limit")
            return data
        finally:
            connection.close()

    def apply_update(self, payload: dict[str, Any]) -> None:
        if not self.validate_update_payload(payload):
            raise RuntimeError("invalid update payload")
        install_root = Path(__file__).resolve().parent
        staging = Path(tempfile.mkdtemp(prefix="citadel-update-", dir=self.config.data_dir))
        backup = self.config.data_dir / "update-backup"
        replaced: list[str] = []
        existed_before: dict[str, bool] = {}
        try:
            changed_items: list[dict[str, Any]] = []
            for item in payload["files"]:
                current = install_root / item["path"]
                if current.is_file():
                    current_hash = hashlib.sha256(current.read_bytes()).hexdigest()
                    if current_hash == item["sha256"]:
                        continue
                data = self.download_update_file(item["url"])
                if hashlib.sha256(data).hexdigest() != item["sha256"]:
                    raise RuntimeError(f"update hash mismatch: {item['path']}")
                (staging / item["path"]).write_bytes(data)
                changed_items.append(item)
            if not changed_items:
                self.log.write("agent_update_noop", version=payload["version"], files=[])
                return
            entrypoint = staging / "citadel_node_v2.py"
            if entrypoint.exists():
                # The argv is fixed and the shell remains disabled.
                result = subprocess.run(  # nosec B603
                    [sys.executable, str(entrypoint), "self-test"],
                    cwd=staging,
                    timeout=120,
                    capture_output=True,
                    text=True,
                    shell=False,
                )
                if result.returncode != 0:
                    raise RuntimeError("updated agent self-test failed")
            backup.mkdir(parents=True, exist_ok=True)
            for core_name in sorted(CORE_UPDATE_FILE_NAMES):
                current_core = install_root / core_name
                if current_core.is_file():
                    shutil.copy2(current_core, backup / core_name)
            for item in changed_items:
                name = item["path"]
                current = install_root / name
                existed_before[name] = current.exists()
                if current.exists() and name not in CORE_UPDATE_FILE_NAMES:
                    shutil.copy2(current, backup / name)
                os.replace(staging / name, current)
                replaced.append(name)
            if "citadel_node_v2.py" in replaced:
                installed_entrypoint = install_root / "citadel_node_v2.py"
                result = subprocess.run(  # nosec B603
                    [
                        sys.executable,
                        str(installed_entrypoint),
                        "startup-check",
                        "--config",
                        str(self.config_path),
                    ],
                    cwd=install_root,
                    timeout=120,
                    capture_output=True,
                    text=True,
                    shell=False,
                )
                if result.returncode != 0:
                    raise RuntimeError("updated agent startup health-check failed")
                self.log.write(
                    "agent_update_healthcheck_passed",
                    version=payload["version"],
                    files=replaced,
                )
            self.log.write("agent_updated", version=payload["version"], files=replaced)
        except Exception:
            for name in replaced:
                saved = backup / name
                if saved.exists():
                    shutil.copy2(saved, install_root / name)
                elif not existed_before.get(name, False):
                    with contextlib.suppress(FileNotFoundError):
                        (install_root / name).unlink()
            self.log.write("agent_update_rolled_back", files=replaced)
            raise
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def rollback_last_update(self) -> None:
        install_root = Path(__file__).resolve().parent
        backup = self.config.data_dir / "update-backup"
        missing_core = [name for name in CORE_UPDATE_FILE_NAMES if not (backup / name).is_file()]
        if missing_core:
            raise RuntimeError("complete core update backup unavailable")
        rollback_names = {
            name for name in UPDATE_FILE_NAMES
            if (backup / name).is_file()
        }
        staging = Path(tempfile.mkdtemp(prefix="citadel-rollback-", dir=self.config.data_dir))
        try:
            for name in sorted(rollback_names):
                shutil.copy2(backup / name, staging / name)
            entrypoint = staging / "citadel_node_v2.py"
            result = subprocess.run(  # nosec B603
                [sys.executable, str(entrypoint), "self-test"],
                cwd=staging,
                timeout=120,
                capture_output=True,
                text=True,
                shell=False,
            )
            if result.returncode != 0:
                raise RuntimeError("rollback backup self-test failed")
            for name in sorted(rollback_names):
                shutil.copy2(staging / name, install_root / name)
            self.log.write(
                "agent_update_manual_rollback",
                files=sorted(rollback_names),
                legacy_companion_backup="windows_enterprise_probe.ps1" not in rollback_names,
            )
        finally:
            shutil.rmtree(staging, ignore_errors=True)

    def schedule_system_power_action(self, command_type: str) -> None:
        """Schedule a signed, allowlisted OS reboot or shutdown without a shell.

        This method never accepts command text or arguments from the Controller.
        The argv is fixed locally. The agent does not attempt privilege escalation:
        the operating-system account running CITADEL must already have the required
        reboot/shutdown permission.
        """
        if command_type not in {"system_reboot", "system_shutdown"}:
            raise RuntimeError("unsupported system power action")

        if os.name == "nt":
            executable = shutil.which("shutdown.exe") or shutil.which("shutdown")
            if not executable:
                raise RuntimeError("Windows shutdown utility unavailable")
            mode = "/r" if command_type == "system_reboot" else "/s"
            comment = (
                "CITADEL signed system reboot"
                if command_type == "system_reboot"
                else "CITADEL signed system shutdown"
            )
            argv = [
                executable,
                mode,
                "/t",
                "15",
                "/d",
                "p:0:0",
                "/c",
                comment,
            ]
        elif os.name == "posix":
            executable = shutil.which("shutdown")
            if not executable:
                raise RuntimeError("POSIX shutdown utility unavailable")
            mode = "-r" if command_type == "system_reboot" else "-h"
            message = (
                "CITADEL signed system reboot"
                if command_type == "system_reboot"
                else "CITADEL signed system shutdown"
            )
            # One minute gives the node time to upload telemetry and close cleanly.
            argv = [executable, mode, "+1", message]
        else:
            raise RuntimeError("system power control unsupported on this OS")

        result = subprocess.run(  # nosec B603
            argv,
            timeout=15,
            capture_output=True,
            text=True,
            shell=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "power command failed").strip()
            raise RuntimeError(detail[:300])
        event = (
            "system_reboot_scheduled"
            if command_type == "system_reboot"
            else "system_shutdown_scheduled"
        )
        self.log.write(event)

    def open_ssh_gate(self, payload: dict[str, Any], command_created_at: str) -> None:
        if not self.config.ssh_gate_enabled or self.ssh_gate is None:
            raise RuntimeError("ssh_gate_disabled")
        if not self.validate_ssh_open_payload(payload):
            raise RuntimeError("invalid_ssh_gate_payload")
        session_id = str(payload["session_id"])
        ttl_seconds = int(payload["ttl_seconds"])
        try:
            created_at = dt.datetime.fromisoformat(str(command_created_at).replace("Z", "+00:00"))
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=dt.timezone.utc)
            expires_at = created_at.astimezone(dt.timezone.utc) + dt.timedelta(seconds=ttl_seconds)
        except (TypeError, ValueError):
            raise RuntimeError("invalid_ssh_gate_created_at") from None
        remaining_seconds = int((expires_at - dt.datetime.now(dt.timezone.utc)).total_seconds())
        if remaining_seconds <= 0:
            raise RuntimeError("ssh_gate_command_expired")
        self.close_ssh_gate("replaced", log_if_absent=False)
        # The gate may never outlive the signed Controller command's own expiry.
        self.ssh_gate.start(min(ttl_seconds, remaining_seconds))
        atomic_write(
            self.ssh_gate_state_path,
            json.dumps(
                {
                    "session_id": session_id,
                    "expires_at": expires_at.isoformat(timespec="seconds"),
                    "listen_host": "127.0.0.1",
                    "listen_port": self.config.ssh_gate_listen_port,
                    "target_host": "127.0.0.1",
                    "target_port": self.config.ssh_gate_target_port,
                },
                sort_keys=True,
            )
            + "\n",
        )
        self.log.write(
            "ssh_gate_opened",
            session_id=session_id,
            ttl_seconds=min(ttl_seconds, remaining_seconds),
            listen_host="127.0.0.1",
            listen_port=self.config.ssh_gate_listen_port,
        )

    def close_ssh_gate(self, reason: str, log_if_absent: bool = True) -> None:
        state = load_json(self.ssh_gate_state_path, {}) or {}
        session_id = state.get("session_id") if isinstance(state, dict) else None
        existed = self.ssh_gate_state_path.exists() or bool(self.ssh_gate and self.ssh_gate.active)
        if self.ssh_gate is not None:
            self.ssh_gate.stop()
        with contextlib.suppress(FileNotFoundError):
            self.ssh_gate_state_path.unlink()
        if existed or log_if_absent:
            self.log.write("ssh_gate_closed", session_id=session_id, reason=reason)

    def enforce_ssh_gate_ttl(self) -> None:
        state = load_json(self.ssh_gate_state_path, {}) or {}
        if not isinstance(state, dict) or not state:
            return
        session_id = str(state.get("session_id") or "")
        expires_at = str(state.get("expires_at") or "")
        try:
            expires = dt.datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=dt.timezone.utc)
        except (TypeError, ValueError):
            self.close_ssh_gate("invalid_state")
            return
        if expires <= dt.datetime.now(dt.timezone.utc):
            self.close_ssh_gate("ttl_expired")
            return
        # A persisted state without a live in-process listener means the agent
        # restarted/crashed. Do not recreate it automatically: fail closed and
        # require a fresh signed Controller knock.
        if self.ssh_gate is None or not self.ssh_gate.active:
            self.close_ssh_gate("agent_restart_fail_closed")

    def ack_command(self, command_id: str, status: str) -> None:
        node_id = self.require_node_id()
        quoted = urllib.parse.quote(command_id, safe="")
        self.api.request(
            "POST",
            f"/api/v1/nodes/{node_id}/commands/{quoted}/ack",
            {"status": status},
        )

    def handle_commands(self) -> None:
        node_id = self.require_node_id()
        response = self.api.request("GET", f"/api/v1/nodes/{node_id}/commands")
        for command in response.get("commands") or []:
            command_id = str(command.get("command_id") or "")
            command_type = str(command.get("command_type") or "")
            if not self.verify_controller_command(command):
                self.log.write(
                    "command_signature_rejected",
                    command_id=command_id,
                    command_type=command_type,
                )
                continue
            try:
                restart_after = False
                stop_after = False
                if command.get("status") == "pending":
                    self.ack_command(command_id, "accepted")
                if command_type == "pause":
                    atomic_write(self.paused_path, now_iso() + "\n")
                elif command_type == "resume":
                    with contextlib.suppress(FileNotFoundError):
                        self.paused_path.unlink()
                elif command_type == "update":
                    self.apply_update(command.get("payload") or {})
                    restart_after = True
                elif command_type == "restart":
                    self.log.write("agent_restart_requested")
                    restart_after = True
                elif command_type == "stop":
                    self.log.write("agent_stop_requested")
                    stop_after = True
                elif command_type == "rollback":
                    self.rollback_last_update()
                    restart_after = True
                elif command_type == "uninstall":
                    atomic_write(self.stop_path, "controller stop " + now_iso() + "\n")
                    stop_after = True
                elif command_type in {"system_reboot", "system_shutdown"}:
                    self.schedule_system_power_action(command_type)
                elif command_type == "wake_peer":
                    self.send_wake_packet(command.get("payload") or {})
                elif command_type == "lmstudio_install":
                    self.install_lmstudio(command.get("payload") or {})
                elif command_type == "lmstudio_uninstall":
                    self.uninstall_lmstudio(command.get("payload") or {})
                elif command_type == "lmstudio_probe":
                    snapshot = self.probe_lmstudio()
                    self.report_ai_state(**{key: value for key, value in snapshot.items() if key != "loaded_models"})
                elif command_type == "lmstudio_model_get":
                    self.download_lmstudio_model(command.get("payload") or {})
                elif command_type == "lmstudio_model_load":
                    self.load_lmstudio_model(command.get("payload") or {})
                elif command_type == "hybrid_query":
                    self.run_hybrid_query(command.get("payload") or {})
                elif command_type == "ssh_open":
                    self.open_ssh_gate(
                        command.get("payload") or {},
                        str(command.get("created_at") or ""),
                    )
                elif command_type == "ssh_close":
                    self.close_ssh_gate("controller")
                self.ack_command(command_id, "completed")
                self.log.write(
                    "command_completed",
                    command_id=command_id,
                    command_type=command_type,
                )
                service_managed = os.environ.get("CITADEL_SERVICE_MANAGED") == "1"
                if stop_after:
                    if service_managed and command_type == "stop":
                        raise SystemExit(SERVICE_STOP_EXIT_CODE)
                    raise SystemExit(0)
                if restart_after:
                    if service_managed:
                        raise SystemExit(SERVICE_RESTART_EXIT_CODE)
                    entrypoint = Path(__file__).resolve().parent / "citadel_node_v2.py"
                    # The argv is fixed and the shell remains disabled.
                    subprocess.Popen(  # nosec B603
                        [sys.executable, str(entrypoint), "run", "--config", str(self.config_path)],
                        cwd=entrypoint.parent,
                        shell=False,
                        creationflags=(0x08000000 if os.name == "nt" else 0),
                    )
                    raise SystemExit(0)
            except Exception as error:
                try:
                    self.ack_command(command_id, "failed")
                except Exception as ack_error:
                    self.log.write(
                        "command_failure_ack_failed",
                        command_id=command_id,
                        error=str(ack_error)[:300],
                    )
                self.log.write(
                    "command_failed",
                    command_id=command_id,
                    error=str(error)[:300],
                )

    @staticmethod
    def is_network_error(error: Exception) -> bool:
        return isinstance(error, (OSError, TimeoutError, ConnectionError, http.client.HTTPException))

    def controller_reachable(self, timeout: float = 5.0) -> bool:
        parsed = urllib.parse.urlsplit(self.config.controller_url)
        host = parsed.hostname
        if not host:
            return False
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            return False

    def enforce_power_guard(self) -> bool:
        if not self.config.prevent_automatic_sleep or os.name != "nt":
            return False
        if time.monotonic() - self.last_power_guard < 60 and self.power_guard_active:
            return True
        self.last_power_guard = time.monotonic()
        es_continuous = 0x80000000
        es_system_required = 0x00000001
        result = ctypes.windll.kernel32.SetThreadExecutionState(
            es_continuous | es_system_required
        )
        self.power_guard_active = bool(result)
        self.log.write(
            "windows_sleep_hibernate_inhibit",
            enabled=self.power_guard_active,
            mode="automatic_sleep_guard",
        )
        return self.power_guard_active

    def clear_power_guard(self) -> None:
        if os.name == "nt" and self.power_guard_active:
            with contextlib.suppress(Exception):
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
        self.power_guard_active = False

    def remember_network_profile(self) -> None:
        state = load_json(self.network_recovery_path, {}) or {}
        try:
            if os.name == "nt":
                powershell = shutil.which("powershell.exe") or shutil.which("powershell")
                if powershell:
                    script = (
                        "Get-NetConnectionProfile | "
                        "Where-Object {$_.IPv4Connectivity -ne 'Disconnected'} | "
                        "Select-Object Name,InterfaceAlias,IPv4Connectivity | ConvertTo-Json -Compress"
                    )
                    result = subprocess.run(  # nosec B603
                        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                        timeout=20, capture_output=True, text=True, shell=False,
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        decoded = json.loads(result.stdout)
                        rows = decoded if isinstance(decoded, list) else [decoded]
                        names = [str(item.get("Name") or "").strip() for item in rows if isinstance(item, dict)]
                        names = [name for name in names if name]
                        remembered = list(state.get("windows_profiles") or [])
                        for name in [*names, *self.config.allowed_wifi_profiles]:
                            if name and name not in remembered:
                                remembered.append(name)
                        if remembered:
                            state["windows_profiles"] = remembered[:16]
            elif os.name == "posix":
                nmcli = shutil.which("nmcli")
                if nmcli:
                    result = subprocess.run(  # nosec B603
                        [nmcli, "-t", "-f", "NAME,TYPE", "connection", "show", "--active"],
                        timeout=20, capture_output=True, text=True, shell=False,
                    )
                    if result.returncode == 0:
                        profiles = []
                        for line in result.stdout.splitlines():
                            if ":" not in line:
                                continue
                            name, kind = line.rsplit(":", 1)
                            if kind in {"wifi", "802-11-wireless", "ethernet", "802-3-ethernet"} and name:
                                profiles.append({"name": name[:120], "type": kind})
                        if profiles:
                            state["linux_profiles"] = profiles[:8]
            state["remembered_at"] = now_iso()
            atomic_write(self.network_recovery_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        except Exception as error:
            self.log.write("network_profile_remember_failed", error=str(error)[:300])

    def recover_network(self) -> None:
        if not self.config.network_recovery_enabled:
            return
        now = time.monotonic()
        if now - self.last_network_recovery < 60:
            return
        self.last_network_recovery = now
        if self.controller_reachable():
            self.log.write("network_recovery_not_needed", reachable=True)
            return
        state = load_json(self.network_recovery_path, {}) or {}
        attempts: list[str] = []
        recovered = False
        try:
            if os.name == "nt":
                ipconfig = shutil.which("ipconfig.exe") or shutil.which("ipconfig")
                if ipconfig:
                    subprocess.run(  # nosec B603
                        [ipconfig, "/renew"], timeout=60, capture_output=True, text=True, shell=False,
                    )
                    attempts.append("dhcp_renew")
                    recovered = self.controller_reachable()
                netsh = shutil.which("netsh.exe") or shutil.which("netsh")
                if netsh and not recovered:
                    profiles: list[str] = []
                    for profile in [*(state.get("windows_profiles") or []), *self.config.allowed_wifi_profiles]:
                        if isinstance(profile, str):
                            name = profile.strip()
                            if name and len(name) <= 120 and name not in profiles:
                                profiles.append(name)
                    for profile in profiles[:16]:
                        result = subprocess.run(  # nosec B603
                            [netsh, "wlan", "connect", f"name={profile}"],
                            timeout=30, capture_output=True, text=True, shell=False,
                        )
                        attempts.append("wifi_saved_profile:" + profile[:64])
                        if result.returncode == 0:
                            time.sleep(3)
                            if self.controller_reachable():
                                recovered = True
                                break
            elif os.name == "posix":
                nmcli = shutil.which("nmcli")
                if nmcli:
                    subprocess.run(  # nosec B603
                        [nmcli, "networking", "on"], timeout=20, capture_output=True, text=True, shell=False,
                    )
                    for item in state.get("linux_profiles") or []:
                        name = item.get("name") if isinstance(item, dict) else None
                        if isinstance(name, str) and name and len(name) <= 120:
                            result = subprocess.run(  # nosec B603
                                [nmcli, "connection", "up", name],
                                timeout=60, capture_output=True, text=True, shell=False,
                            )
                            attempts.append("saved_connection:" + name[:64])
                            if result.returncode == 0:
                                time.sleep(3)
                                if self.controller_reachable():
                                    recovered = True
                                    break
            if recovered:
                self.remember_network_profile()
            self.log.write("network_recovery_attempted", attempts=attempts, recovered=recovered)
        except Exception as error:
            self.log.write("network_recovery_failed", error=str(error)[:300])

    def lifecycle_stop_requested(self) -> bool:
        return bool(self.lifecycle_stop_path and self.lifecycle_stop_path.exists())

    def service_hold_requested(self) -> bool:
        return bool(self.service_hold_path and self.service_hold_path.exists())

    def mark_service_ready(self) -> None:
        if not self.service_ready_path:
            return
        atomic_write(
            self.service_ready_path,
            json.dumps(
                {
                    "node_id": self.require_node_id(),
                    "agent_version": VERSION,
                    "windows_core_service": "windows_core_service" in self.capabilities,
                    "heartbeat_at": now_iso(),
                },
                sort_keys=True,
            )
            + "\n",
        )

    def interruptible_sleep(self, seconds: float) -> None:
        deadline = time.monotonic() + max(0.0, seconds)
        while True:
            if self.lifecycle_stop_requested():
                raise SystemExit(0)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.5, remaining))

    def cycle(self) -> None:
        self.enforce_power_guard()
        self.enroll()
        self.enforce_ssh_gate_ttl()
        if self.lifecycle_stop_requested() or self.stop_path.exists():
            raise SystemExit(0)
        if self.service_hold_requested():
            if time.monotonic() - self.last_heartbeat >= self.config.heartbeat_seconds:
                self.heartbeat()
                self.mark_service_ready()
            return
        self.handle_commands()
        if time.monotonic() - self.last_heartbeat >= self.config.heartbeat_seconds:
            self.heartbeat()
        sent = self.results.flush(self.submit_result)
        if sent:
            self.log.write("queued_results_flushed", count=sent)
        if self.paused_path.exists():
            return
        node_id = self.require_node_id()
        response = self.api.request("GET", f"/api/v1/nodes/{node_id}/assignments")
        for assignment in response.get("assignments") or []:
            self.execute_assignment(assignment)

    def run(self, once: bool = False) -> int:
        self.log.write("agent_start", version=VERSION, once=once)
        if not once:
            self.enforce_power_guard()
        backoff = 2
        try:
            while True:
                try:
                    self.cycle()
                    backoff = 2
                    if once:
                        return 0
                    self.interruptible_sleep(self.config.poll_seconds)
                except SystemExit as exit_request:
                    code = exit_request.code if isinstance(exit_request.code, int) else 0
                    reason = (
                        "service_restart"
                        if code == SERVICE_RESTART_EXIT_CODE
                        else "service_stop"
                        if code == SERVICE_STOP_EXIT_CODE
                        else "STOP"
                    )
                    self.log.write("agent_stop", reason=reason, exit_code=code)
                    return code
                except KeyboardInterrupt:
                    self.log.write("agent_stop", reason="keyboard_interrupt")
                    return 0
                except Exception as error:
                    self.log.write("cycle_error", error=str(error)[:500])
                    if self.is_network_error(error):
                        self.recover_network()
                    if once:
                        raise
                    self.interruptible_sleep(backoff)
                    backoff = min(60, backoff * 2)
        finally:
            # The SSH listener is in-process and loopback-only. Closing it here
            # makes process exit/restart fail closed even before TTL.
            self.close_ssh_gate("agent_exit", log_if_absent=False)
            self.clear_power_guard()


def doctor(config: AgentConfig) -> int:
    config.data_dir.mkdir(parents=True, exist_ok=True)
    checks = {
        "controller_url": config.controller_url,
        "data_dir": str(config.data_dir),
        "data_dir_writable": os.access(config.data_dir, os.W_OK),
        "controller_public_key_bytes": len(unb64url(config.controller_public_x)),
        "mission_handlers": sorted(HANDLERS),
    }
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    healthy = checks["data_dir_writable"] and checks["controller_public_key_bytes"] == 32
    return 0 if healthy else 2


def require_test(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError("self-test failed: " + message)


def self_test() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        identity_path = root / "identity.json"
        identity = Identity(identity_path)
        identity.set_node_id("node_test")
        identity_state = load_json(identity_path, {}) or {}
        if os.name == "nt":
            require_test(
                identity_state.get("key_protection") == WINDOWS_DPAPI_PROTECTION
                and bool(identity_state.get("private_key_dpapi"))
                and "private_key_pem" not in identity_state,
                "Windows identity was not stored as DPAPI-protected key material",
            )
        message = "\n".join(
            (
                "POST",
                "/api/v1/nodes/node_test/heartbeat",
                "1700000000",
                sha256_text(json_text({"hello": "world"})),
            )
        ).encode("utf-8")
        identity.require_key().public_key().verify(
            unb64url(identity.sign(message)),
            message,
        )
        reloaded_identity = Identity(identity_path)
        require_test(
            reloaded_identity.node_id == "node_test",
            "node_id changed while reloading node identity",
        )
        identity.require_key().public_key().verify(
            unb64url(reloaded_identity.sign(message)),
            message,
        )

        if os.name == "nt":
            legacy_path = root / "legacy-identity.json"
            legacy_key = Ed25519PrivateKey.generate()
            legacy_pem = legacy_key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode("ascii")
            atomic_write(
                legacy_path,
                json.dumps(
                    {"node_id": "node_legacy", "private_key_pem": legacy_pem},
                    indent=2,
                )
                + "\n",
            )
            migrated_identity = Identity(legacy_path)
            migrated_state = load_json(legacy_path, {}) or {}
            require_test(
                migrated_identity.node_id == "node_legacy"
                and migrated_state.get("key_protection") == WINDOWS_DPAPI_PROTECTION
                and bool(migrated_state.get("private_key_dpapi"))
                and "private_key_pem" not in migrated_state,
                "legacy Windows identity did not migrate away from plaintext PEM",
            )
            legacy_message = b"legacy-identity-migration"
            legacy_key.public_key().verify(
                unb64url(migrated_identity.sign(legacy_message)),
                legacy_message,
            )

        controller_private = Ed25519PrivateKey.generate()
        controller_x = b64url(
            controller_private.public_key().public_bytes(
                serialization.Encoding.Raw,
                serialization.PublicFormat.Raw,
            )
        )
        config = AgentConfig(
            "https://example.test",
            root,
            controller_public_x=controller_x,
        )
        agent = Agent(config)
        agent.identity = identity
        command: dict[str, Any] = {
            "command_id": "command_test",
            "command_type": "pause",
            "payload": {},
            "status": "pending",
            "created_at": now_iso(),
        }
        canonical = "\n".join(
            (
                "CITADEL-COMMAND-V1",
                command["command_id"],
                "node_test",
                "pause",
                sha256_text("{}"),
                command["created_at"],
            )
        ).encode("utf-8")
        command["signature"] = b64url(controller_private.sign(canonical))
        require_test(
            agent.verify_controller_command(command),
            "valid controller signature rejected",
        )
        stale_command = dict(command)
        stale_command["created_at"] = (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=COMMAND_MAX_AGE_SECONDS + 1)
        ).isoformat(timespec="seconds")
        stale_canonical = "\n".join(
            (
                "CITADEL-COMMAND-V1",
                stale_command["command_id"],
                "node_test",
                "pause",
                sha256_text("{}"),
                stale_command["created_at"],
            )
        ).encode("utf-8")
        stale_command["signature"] = b64url(controller_private.sign(stale_canonical))
        require_test(
            not agent.verify_controller_command(stale_command),
            "stale controller command accepted",
        )
        command["command_type"] = "shell"
        require_test(
            not agent.verify_controller_command(command),
            "unapproved command accepted",
        )
        require_test(
            {"system_reboot", "system_shutdown", "wake_peer", "lmstudio_install", "lmstudio_uninstall", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query", "ssh_open", "ssh_close"}.issubset(SUPPORTED_COMMANDS),
            "restricted power/wake/LM Studio/SSH gate commands missing",
        )
        require_test(
            agent.validate_ssh_open_payload({"session_id": "ssh_" + "a" * 32, "ttl_seconds": 600})
            and not agent.validate_ssh_open_payload({"session_id": "ssh_" + "a" * 32, "ttl_seconds": 3600})
            and not agent.validate_ssh_open_payload({"session_id": "bad", "ttl_seconds": 600}),
            "SSH gate payload validation failed",
        )
        require_test(
            "shell" not in SUPPORTED_COMMANDS,
            "arbitrary shell command registered",
        )
        require_test(
            set(HANDLERS) == {"system_inventory"},
            "unexpected handler registered",
        )
        require_test(
            "project_text" in agent.capabilities and "project_python" in agent.capabilities,
            "project execution capabilities missing",
        )
        require_test(
            agent.validate_lmstudio_uninstall_payload({"purge_data": False})
            and agent.validate_lmstudio_uninstall_payload({"purge_data": True})
            and not agent.validate_lmstudio_uninstall_payload({"purge_data": "yes"}),
            "LM Studio uninstall payload validation failed",
        )
        require_test(
            agent.python_mode_answer("calc: 2 + 3 * 4") == "Python calculation: 14",
            "Python-only deterministic calculation failed",
        )
        require_test(
            "no AI/LLM was called" in agent.python_mode_answer("Who wrote Hamlet?"),
            "Python-only unsupported prompt did not fail closed",
        )
        mini_report = agent.execute_project_python({
            "project_id": "project_test",
            "work_item_id": "work_test",
            "role_name": "programmer",
            "task_text": "calc: 2 + 2\ncalc: 5 * 6",
        })
        require_test(
            mini_report.get("mini_agent_count") == 2
            and len(mini_report.get("mini_agents") or []) == 2
            and "Python calculation: 4" in mini_report.get("content", "")
            and "Python calculation: 30" in mini_report.get("content", ""),
            "Python mini-agent coordinator failed deterministic subtask execution",
        )
        require_test(
            str(agent.lmstudio_runtime_home()).startswith(str(root.resolve())),
            "LM Studio managed HOME escaped the agent data directory",
        )
        require_test(
            agent.validate_lmstudio_model_payload({"model": "openai/gpt-oss-20b"}),
            "valid LM Studio model id rejected",
        )
        require_test(
            not agent.validate_lmstudio_model_payload({"model": "x;calc.exe"}),
            "unsafe LM Studio model id accepted",
        )
        require_test(
            agent.validate_lmstudio_model_payload({
                "model": "Qwen/Qwen3-4B-GGUF",
                "source": "huggingface",
                "quantization": "Q4_K_M",
                "settings": {"context_length": 8192, "flash_attention": True},
            }),
            "valid LM Studio settings rejected",
        )
        service_hold_path = root / "SERVICE_HOLD"
        service_ready_path = root / "SERVICE_READY"
        previous_hold_file = os.environ.get("CITADEL_SERVICE_HOLD_FILE")
        previous_ready_file = os.environ.get("CITADEL_SERVICE_READY_FILE")
        try:
            os.environ["CITADEL_SERVICE_HOLD_FILE"] = str(service_hold_path)
            os.environ["CITADEL_SERVICE_READY_FILE"] = str(service_ready_path)
            hold_agent = Agent(config)
            require_test(
                hold_agent.service_hold_path == service_hold_path.resolve()
                and hold_agent.service_ready_path == service_ready_path.resolve(),
                "service hold/readiness paths were not accepted",
            )
            service_hold_path.write_text("hold\n", encoding="utf-8")
            require_test(
                hold_agent.service_hold_requested(),
                "service hold marker was not detected",
            )
        finally:
            if previous_hold_file is None:
                os.environ.pop("CITADEL_SERVICE_HOLD_FILE", None)
            else:
                os.environ["CITADEL_SERVICE_HOLD_FILE"] = previous_hold_file
            if previous_ready_file is None:
                os.environ.pop("CITADEL_SERVICE_READY_FILE", None)
            else:
                os.environ["CITADEL_SERVICE_READY_FILE"] = previous_ready_file

        lifecycle_stop_path = root / "SERVICE_STOP"
        previous_stop_file = os.environ.get("CITADEL_SERVICE_STOP_FILE")
        try:
            os.environ["CITADEL_SERVICE_STOP_FILE"] = str(lifecycle_stop_path)
            lifecycle_agent = Agent(config)
            require_test(
                lifecycle_agent.lifecycle_stop_path == lifecycle_stop_path.resolve(),
                "service lifecycle stop path was not accepted",
            )
            lifecycle_stop_path.write_text("stop\n", encoding="utf-8")
            require_test(
                lifecycle_agent.lifecycle_stop_requested(),
                "service lifecycle stop marker was not detected",
            )
        finally:
            if previous_stop_file is None:
                os.environ.pop("CITADEL_SERVICE_STOP_FILE", None)
            else:
                os.environ["CITADEL_SERVICE_STOP_FILE"] = previous_stop_file

        previous_service_flag = os.environ.get("CITADEL_SERVICE_MANAGED")
        try:
            os.environ["CITADEL_SERVICE_MANAGED"] = "1"
            service_capability_agent = Agent(config)
            if os.name == "nt":
                require_test(
                    "windows_core_service" in service_capability_agent.capabilities,
                    "SCM-managed Windows agent did not advertise windows_core_service",
                )
                require_test(
                    system_inventory({}).get("windows_core_service") is True,
                    "Windows inventory did not report SCM service mode",
                )
        finally:
            if previous_service_flag is None:
                os.environ.pop("CITADEL_SERVICE_MANAGED", None)
            else:
                os.environ["CITADEL_SERVICE_MANAGED"] = previous_service_flag

        class _ServiceExitAgent(Agent):
            def cycle(self) -> None:
                raise SystemExit(SERVICE_RESTART_EXIT_CODE)

        service_exit_config = AgentConfig(
            "https://example.test",
            root / "service-exit",
            controller_public_x=controller_x,
        )
        service_exit_agent = _ServiceExitAgent(service_exit_config)
        require_test(
            service_exit_agent.run(once=True) == SERVICE_RESTART_EXIT_CODE,
            "service-managed restart exit code was swallowed",
        )

        require_test(
            agent.validate_hybrid_payload({
                "request_id": "query_12345678",
                "mode": "both",
                "prompt": "status?",
                "settings": {"temperature": 0.2, "max_output_tokens": 128},
            }),
            "valid Hybrid payload rejected",
        )
        require_test(
            not agent.validate_hybrid_payload({
                "request_id": "bad",
                "mode": "shell",
                "prompt": "x",
            }),
            "unsafe Hybrid payload accepted",
        )

        bom_json = root / "bom.json"
        bom_json.write_bytes(b"\xef\xbb\xbf{\"ok\":true}\n")
        require_test(load_json(bom_json, {}).get("ok") is True, "UTF-8 BOM JSON rejected")
        network = local_network_addresses()
        require_test(
            set(network) == {"lan_ipv4", "tailscale_ipv4", "private_ipv4", "mac_addresses", "interfaces"},
            "network discovery returned an unexpected shape",
        )

        pending = ResultQueue(root / "queue.json")
        pending.push({"assignment_id": "a1"})
        collected: list[dict[str, Any]] = []
        require_test(pending.flush(collected.append) == 1, "offline queue did not flush")
        require_test(
            collected == [{"assignment_id": "a1"}],
            "offline queue content changed",
        )
        require_test(system_inventory({})["memory_total_bytes"] > 0, "inventory failed")
        reconcile_root = root / "reconcile"
        reconcile_root.mkdir()
        reconcile_config = AgentConfig(
            "https://example.test",
            reconcile_root,
            controller_public_x=controller_x,
        )
        reconcile_agent = Agent(reconcile_config)
        reconcile_agent.identity.set_node_id("node_stale")
        reconcile_agent.api.request = lambda *args, **kwargs: {
            "node": {"node_id": "node_reconciled", "node_number": 7}
        }
        require_test(
            reconcile_agent.enroll() == "node_reconciled"
            and reconcile_agent.identity.node_id == "node_reconciled",
            "stale node id was not reconciled with Controller",
        )

    print("CITADEL v1 agent SELF TEST: PASS")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"CITADEL/EWS Cloudflare v1 node agent {VERSION}"
    )
    parser.add_argument(
        "command",
        choices=["doctor", "enroll", "once", "run", "self-test"],
    )
    parser.add_argument("--config", default="agent/config.json")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "self-test":
        return self_test()
    config = AgentConfig.from_file(Path(args.config))
    if args.command == "doctor":
        return doctor(config)
    agent = Agent(config, Path(args.config))
    if args.command == "enroll":
        print(agent.enroll())
        return 0
    return agent.run(once=args.command == "once")


if __name__ == "__main__":
    raise SystemExit(main())
