#!/usr/bin/env python3
"""Bounded CITADEL/EWS node for operator-owned or administered computers.

The node speaks the existing Cloudflare /api/v1 Ed25519 protocol. It has no
remote shell, arbitrary code loader, exploit engine, credential collector,
self-propagation, stealth installation, or autonomous financial actions.
Only locally registered mission handlers can execute.
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
import email.utils
import hashlib
import importlib.util
import ipaddress
import http.client
import json
import os
import platform
import re
import select
import shutil
import socket
# Subprocesses below use a fixed interpreter, allowlisted local scripts and no shell.
import subprocess  # nosec B404
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Callable

WINDOWS_CREATE_NO_WINDOW = 0x08000000


def _citadel_subprocess_run(*args, **kwargs):
    """Run child tools without opening transient Windows console windows."""
    if os.name == "nt":
        kwargs.setdefault("creationflags", WINDOWS_CREATE_NO_WINDOW)
        if kwargs.get("text") or kwargs.get("universal_newlines") or kwargs.get("encoding"):
            # A decode error in Windows Popen's reader thread otherwise leaves
            # stdout=None despite capture_output=True, hiding the real result.
            kwargs.setdefault("errors", "replace")
    return subprocess.run(*args, **kwargs)  # nosec B603


def _citadel_subprocess_popen(*args, **kwargs):
    """Start child tools without opening transient Windows console windows."""
    if os.name == "nt":
        kwargs.setdefault("creationflags", WINDOWS_CREATE_NO_WINDOW)
    return subprocess.Popen(*args, **kwargs)  # nosec B603

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

VERSION = "0.3.44"
USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"
DEFAULT_CONTROLLER_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
SUPPORTED_COMMANDS = {"pause", "resume", "update", "restart", "stop", "rollback", "uninstall", "system_reboot", "system_shutdown", "wake_peer", "lmstudio_install", "lmstudio_uninstall", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query", "ssh_probe", "ssh_console"}
CORE_UPDATE_FILE_NAMES = {"citadel_node_v1.py", "citadel_node_v2.py"}
UPDATE_FILE_NAMES = CORE_UPDATE_FILE_NAMES | {"windows_enterprise_probe.ps1", "CitadelSshConsole.cs", "configure_restricted_ssh.ps1"}
UPDATE_MAX_FILE_BYTES = 2 * 1024 * 1024
COMMAND_MAX_AGE_SECONDS = 15 * 60
SERVICE_RESTART_EXIT_CODE = 75
SERVICE_STOP_EXIT_CODE = 76
LMSTUDIO_INSTALL_FILE_NAMES = {"install_llmstudio_headless.ps1", "install_llmstudio_headless.sh"}
LMSTUDIO_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$")
LMSTUDIO_QUANT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
HYBRID_MODES = {"python", "lmstudio", "both"}
LMSTUDIO_INFERENCE_PROBE_TIMEOUT_SECONDS = 30
LMSTUDIO_INFERENCE_PROOF_TTL_SECONDS = 5 * 60
LMSTUDIO_QUERY_TIMEOUT_SECONDS = 4 * 60
SSH_INLINE_COMMANDS = frozenset({
    "help", "status", "hostname", "whoami", "uname -a", "python --version", "python3 --version",
    "uptime", "cpu", "memory", "disk", "network",
    "agent-status", "agent-logs", "lmstudio-status", "diagnostics", "ping-controller", "exit",
})
SSH_INLINE_OUTPUT_MAX_BYTES = 24 * 1024
NETWORK_PRIMARY_PROFILE_RETRIES = 3
NETWORK_PRIMARY_RETRY_DELAYS = (2, 4, 8)
WINDOWS_DPAPI_PROTECTION = "windows-dpapi-local-machine-v1"
CRYPTPROTECT_UI_FORBIDDEN = 0x1
CRYPTPROTECT_LOCAL_MACHINE = 0x4
WINDOWS_ENTERPRISE_PROBE_SHA256 = "0d056ab71e2216821cd314a97bc14e87f87c60140a0bcf787a24cfa33212c2ee"
WINDOWS_ENTERPRISE_PROBE_MAX_BYTES = 256 * 1024
SSH_RESTRICTED_CONSOLE_SHA256 = "f60aa3cbd89dcf4dc38615dcda36b57530efa7995ac4cf38925b2b29fb02da96"
SSH_RESTRICTED_CONSOLE_MAX_BYTES = 128 * 1024
SSH_RESTRICTED_CONSOLE_B64 = "IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiJSZXN0cmljdGVkIGludGVyYWN0aXZlIFNTSCBjb25zb2xlIGZvciBDSVRBREVMLW1hbmFnZWQgY29tcHV0ZXJzLgoKVGhpcyBpcyBkZXNpZ25lZCB0byBiZSB1c2VkIGFzIGFuIE9wZW5TU0ggRm9yY2VDb21tYW5kIHRhcmdldC4gSXQgZGVsaWJlcmF0ZWx5CmRvZXMgbm90IHNwYXduIGEgc2hlbGwgb3IgYXJiaXRyYXJ5IHN1YnByb2Nlc3MuIE9ubHkgdGhlIGZpeGVkIHJlYWQtb25seSB2ZXJicwpsaXN0ZWQgaW4gQUxMT1dFRF9DT01NQU5EUyBhcmUgYWNjZXB0ZWQuCiIiIgpmcm9tIF9fZnV0dXJlX18gaW1wb3J0IGFubm90YXRpb25zCgppbXBvcnQgYXJncGFyc2UKaW1wb3J0IGdldHBhc3MKaW1wb3J0IGh0dHAuY2xpZW50CmltcG9ydCBqc29uCmltcG9ydCBvcwppbXBvcnQgcGxhdGZvcm0KaW1wb3J0IHNodXRpbAppbXBvcnQgc29ja2V0CmltcG9ydCBzeXMKaW1wb3J0IHRpbWUKaW1wb3J0IHVybGxpYi5wYXJzZQpmcm9tIHBhdGhsaWIgaW1wb3J0IFBhdGgKZnJvbSB0eXBpbmcgaW1wb3J0IENhbGxhYmxlCgppbXBvcnQgcHN1dGlsCgoKQUxMT1dFRF9DT01NQU5EUyA9ICgKICAgICJoZWxwIiwKICAgICJzdGF0dXMiLAogICAgImhvc3RuYW1lIiwKICAgICJ3aG9hbWkiLAogICAgInVuYW1lIC1hIiwKICAgICJweXRob24gLS12ZXJzaW9uIiwKICAgICJweXRob24zIC0tdmVyc2lvbiIsCiAgICAidXB0aW1lIiwKICAgICJjcHUiLAogICAgIm1lbW9yeSIsCiAgICAiZGlzayIsCiAgICAibmV0d29yayIsCiAgICAiYWdlbnQtc3RhdHVzIiwKICAgICJhZ2VudC1sb2dzIiwKICAgICJsbXN0dWRpby1zdGF0dXMiLAogICAgImRpYWdub3N0aWNzIiwKICAgICJwaW5nLWNvbnRyb2xsZXIiLAogICAgImV4aXQiLAopCgoKZGVmIGRlZmF1bHRfc3RhdGVfZGlyKCkgLT4gUGF0aDoKICAgIGlmIG9zLm5hbWUgPT0gIm50IjoKICAgICAgICByZXR1cm4gUGF0aChvcy5lbnZpcm9uLmdldCgiUFJPR1JBTURBVEEiKSBvciByIkM6XFByb2dyYW1EYXRhIikgLyAiQ2l0YWRlbEVXUyIgLyAic3RhdGUiCiAgICByZXR1cm4gUGF0aChvcy5lbnZpcm9uLmdldCgiQ0lUQURFTF9TVEFURV9ST09UIikgb3IgUGF0aC5ob21lKCkgLyAiLmxvY2FsIiAvICJzdGF0ZSIgLyAiY2l0YWRlbC1ub2RlIikKCgpkZWYgbG9hZF9jb25maWcocGF0aDogUGF0aCkgLT4gZGljdDoKICAgIHRyeToKICAgICAgICB2YWx1ZSA9IGpzb24ubG9hZHMocGF0aC5yZWFkX3RleHQoZW5jb2Rpbmc9InV0Zi04LXNpZyIpKQogICAgZXhjZXB0IChPU0Vycm9yLCBqc29uLkpTT05EZWNvZGVFcnJvcik6CiAgICAgICAgcmV0dXJuIHt9CiAgICByZXR1cm4gdmFsdWUgaWYgaXNpbnN0YW5jZSh2YWx1ZSwgZGljdCkgZWxzZSB7fQoKCmRlZiBmb3JtYXRfYnl0ZXModmFsdWU6IGludCB8IGZsb2F0KSAtPiBzdHI6CiAgICBudW1iZXIgPSBmbG9hdCh2YWx1ZSkKICAgIGZvciBzdWZmaXggaW4gKCJCIiwgIktpQiIsICJNaUIiLCAiR2lCIiwgIlRpQiIpOgogICAgICAgIGlmIG51bWJlciA8IDEwMjQgb3Igc3VmZml4ID09ICJUaUIiOgogICAgICAgICAgICByZXR1cm4gZiJ7bnVtYmVyOi4xZn0ge3N1ZmZpeH0iCiAgICAgICAgbnVtYmVyIC89IDEwMjQKICAgIHJldHVybiBmIntudW1iZXI6LjFmfSBUaUIiCgoKZGVmIGNvbW1hbmRfaGVscCgpIC0+IHN0cjoKICAgIHJldHVybiAiQWxsb3dlZCBjb21tYW5kczpcbiAgIiArICJcbiAgIi5qb2luKEFMTE9XRURfQ09NTUFORFMpCgoKZGVmIGNvbW1hbmRfc3RhdHVzKCkgLT4gc3RyOgogICAgbWVtID0gcHN1dGlsLnZpcnR1YWxfbWVtb3J5KCkKICAgIHJldHVybiAiXG4iLmpvaW4oCiAgICAgICAgKAogICAgICAgICAgICBmImhvc3Q6IHtzb2NrZXQuZ2V0aG9zdG5hbWUoKX0iLAogICAgICAgICAgICBmIm9zOiB7cGxhdGZvcm0uc3lzdGVtKCl9IHtwbGF0Zm9ybS5yZWxlYXNlKCl9IiwKICAgICAgICAgICAgZiJweXRob246IHtwbGF0Zm9ybS5weXRob25fdmVyc2lvbigpfSIsCiAgICAgICAgICAgIGYidXB0aW1lX3NlY29uZHM6IHttYXgoMCwgaW50KHRpbWUudGltZSgpIC0gcHN1dGlsLmJvb3RfdGltZSgpKSl9IiwKICAgICAgICAgICAgZiJjcHVfcGVyY2VudDoge3BzdXRpbC5jcHVfcGVyY2VudChpbnRlcnZhbD0wLjEpOi4xZn0iLAogICAgICAgICAgICBmIm1lbW9yeV9wZXJjZW50OiB7bWVtLnBlcmNlbnQ6LjFmfSIsCiAgICAgICAgKQogICAgKQoKCmRlZiBjb21tYW5kX2hvc3RuYW1lKCkgLT4gc3RyOgogICAgcmV0dXJuIHNvY2tldC5nZXRob3N0bmFtZSgpCgoKZGVmIGNvbW1hbmRfd2hvYW1pKCkgLT4gc3RyOgogICAgaWYgb3MubmFtZSA9PSAicG9zaXgiOgogICAgICAgIGltcG9ydCBwd2QKICAgICAgICByZXR1cm4gcHdkLmdldHB3dWlkKG9zLmdldGV1aWQoKSkucHdfbmFtZQogICAgcmV0dXJuIGdldHBhc3MuZ2V0dXNlcigpCgoKZGVmIGNvbW1hbmRfdW5hbWUoKSAtPiBzdHI6CiAgICByZXR1cm4gIiAiLmpvaW4oc3RyKHBhcnQpIGZvciBwYXJ0IGluIHBsYXRmb3JtLnVuYW1lKCkpCgoKZGVmIGNvbW1hbmRfcHl0aG9uX3ZlcnNpb24oKSAtPiBzdHI6CiAgICByZXR1cm4gZiJQeXRob24ge3BsYXRmb3JtLnB5dGhvbl92ZXJzaW9uKCl9IgoKCmRlZiBjb21tYW5kX3VwdGltZSgpIC0+IHN0cjoKICAgIHNlY29uZHMgPSBtYXgoMCwgaW50KHRpbWUudGltZSgpIC0gcHN1dGlsLmJvb3RfdGltZSgpKSkKICAgIGRheXMsIHJlbSA9IGRpdm1vZChzZWNvbmRzLCA4NjQwMCkKICAgIGhvdXJzLCByZW0gPSBkaXZtb2QocmVtLCAzNjAwKQogICAgbWludXRlcywgc2VjcyA9IGRpdm1vZChyZW0sIDYwKQogICAgcmV0dXJuIGYie2RheXN9ZCB7aG91cnM6MDJkfTp7bWludXRlczowMmR9OntzZWNzOjAyZH0iCgoKZGVmIGNvbW1hbmRfY3B1KCkgLT4gc3RyOgogICAgcmV0dXJuIGpzb24uZHVtcHMoCiAgICAgICAgewogICAgICAgICAgICAibG9naWNhbF9jb3VudCI6IHBzdXRpbC5jcHVfY291bnQobG9naWNhbD1UcnVlKSwKICAgICAgICAgICAgInBoeXNpY2FsX2NvdW50IjogcHN1dGlsLmNwdV9jb3VudChsb2dpY2FsPUZhbHNlKSwKICAgICAgICAgICAgInBlcmNlbnQiOiBwc3V0aWwuY3B1X3BlcmNlbnQoaW50ZXJ2YWw9MC4yKSwKICAgICAgICB9LAogICAgICAgIGVuc3VyZV9hc2NpaT1GYWxzZSwKICAgICkKCgpkZWYgY29tbWFuZF9tZW1vcnkoKSAtPiBzdHI6CiAgICBtZW0gPSBwc3V0aWwudmlydHVhbF9tZW1vcnkoKQogICAgcmV0dXJuIGpzb24uZHVtcHMoCiAgICAgICAgewogICAgICAgICAgICAidG90YWwiOiBmb3JtYXRfYnl0ZXMobWVtLnRvdGFsKSwKICAgICAgICAgICAgImF2YWlsYWJsZSI6IGZvcm1hdF9ieXRlcyhtZW0uYXZhaWxhYmxlKSwKICAgICAgICAgICAgInVzZWRfcGVyY2VudCI6IG1lbS5wZXJjZW50LAogICAgICAgIH0sCiAgICAgICAgZW5zdXJlX2FzY2lpPUZhbHNlLAogICAgKQoKCmRlZiBjb21tYW5kX2Rpc2soKSAtPiBzdHI6CiAgICByb290ID0gUGF0aC5ob21lKCkuYW5jaG9yIG9yICIvIgogICAgdXNhZ2UgPSBzaHV0aWwuZGlza191c2FnZShyb290KQogICAgcmV0dXJuIGpzb24uZHVtcHMoCiAgICAgICAgewogICAgICAgICAgICAicGF0aCI6IHN0cihyb290KSwKICAgICAgICAgICAgInRvdGFsIjogZm9ybWF0X2J5dGVzKHVzYWdlLnRvdGFsKSwKICAgICAgICAgICAgImZyZWUiOiBmb3JtYXRfYnl0ZXModXNhZ2UuZnJlZSksCiAgICAgICAgICAgICJ1c2VkX3BlcmNlbnQiOiByb3VuZCgodXNhZ2UudXNlZCAvIHVzYWdlLnRvdGFsKSAqIDEwMCwgMSkgaWYgdXNhZ2UudG90YWwgZWxzZSAwLAogICAgICAgIH0sCiAgICAgICAgZW5zdXJlX2FzY2lpPUZhbHNlLAogICAgKQoKCmRlZiBjb21tYW5kX25ldHdvcmsoKSAtPiBzdHI6CiAgICByb3dzID0gW10KICAgIHRyeToKICAgICAgICBzdGF0cyA9IHBzdXRpbC5uZXRfaWZfc3RhdHMoKQogICAgICAgIGFkZHJzID0gcHN1dGlsLm5ldF9pZl9hZGRycygpCiAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgIHJldHVybiAibmV0d29yayBpbnZlbnRvcnkgdW5hdmFpbGFibGUiCiAgICBmb3IgbmFtZSwgdmFsdWVzIGluIGFkZHJzLml0ZW1zKCk6CiAgICAgICAgc3RhdGUgPSBzdGF0cy5nZXQobmFtZSkKICAgICAgICBpcHY0ID0gW3N0cihpdGVtLmFkZHJlc3MpIGZvciBpdGVtIGluIHZhbHVlcyBpZiBpdGVtLmZhbWlseSA9PSBzb2NrZXQuQUZfSU5FVF0KICAgICAgICBpZiBub3QgaXB2NDoKICAgICAgICAgICAgY29udGludWUKICAgICAgICByb3dzLmFwcGVuZCgKICAgICAgICAgICAgewogICAgICAgICAgICAgICAgIm5hbWUiOiBuYW1lWzoxMjBdLAogICAgICAgICAgICAgICAgInVwIjogYm9vbChzdGF0ZS5pc3VwKSBpZiBzdGF0ZSBlbHNlIE5vbmUsCiAgICAgICAgICAgICAgICAic3BlZWRfbWJwcyI6IGludChzdGF0ZS5zcGVlZCkgaWYgc3RhdGUgYW5kIHN0YXRlLnNwZWVkID49IDAgZWxzZSBOb25lLAogICAgICAgICAgICAgICAgImlwdjQiOiBpcHY0Wzo4XSwKICAgICAgICAgICAgfQogICAgICAgICkKICAgIHJldHVybiBqc29uLmR1bXBzKHJvd3NbOjMyXSwgZW5zdXJlX2FzY2lpPUZhbHNlLCBpbmRlbnQ9MikKCgpkZWYgY29tbWFuZF9hZ2VudF9zdGF0dXMoKSAtPiBzdHI6CiAgICBtYXRjaGVzID0gW10KICAgIHRyeToKICAgICAgICBmb3IgcHJvYyBpbiBwc3V0aWwucHJvY2Vzc19pdGVyKFsicGlkIiwgIm5hbWUiLCAiY21kbGluZSJdKToKICAgICAgICAgICAgY21kbGluZSA9ICIgIi5qb2luKHByb2MuaW5mby5nZXQoImNtZGxpbmUiKSBvciBbXSkKICAgICAgICAgICAgaWYgImNpdGFkZWxfbm9kZV92Mi5weSIgaW4gY21kbGluZSBvciBzdHIocHJvYy5pbmZvLmdldCgibmFtZSIpIG9yICIiKS5sb3dlcigpID09ICJjaXRhZGVsbm9kZXNlcnZpY2UuZXhlIjoKICAgICAgICAgICAgICAgIG1hdGNoZXMuYXBwZW5kKHsicGlkIjogcHJvYy5pbmZvLmdldCgicGlkIiksICJuYW1lIjogcHJvYy5pbmZvLmdldCgibmFtZSIpfSkKICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgcGFzcwogICAgcmV0dXJuIGpzb24uZHVtcHMoeyJydW5uaW5nIjogYm9vbChtYXRjaGVzKSwgInByb2Nlc3NlcyI6IG1hdGNoZXNbOjhdfSwgZW5zdXJlX2FzY2lpPUZhbHNlKQoKCmRlZiBfYm91bmRlZF90YWlsX2xpbmVzKHBhdGg6IFBhdGgsIG1heF9ieXRlczogaW50ID0gNjQgKiAxMDI0LCBtYXhfbGluZXM6IGludCA9IDQwKSAtPiBzdHI6CiAgICB0cnk6CiAgICAgICAgc2l6ZSA9IHBhdGguc3RhdCgpLnN0X3NpemUKICAgICAgICB3aXRoIHBhdGgub3BlbigicmIiKSBhcyBzdHJlYW06CiAgICAgICAgICAgIHRydW5jYXRlZCA9IHNpemUgPiBtYXhfYnl0ZXMKICAgICAgICAgICAgaWYgdHJ1bmNhdGVkOgogICAgICAgICAgICAgICAgc3RyZWFtLnNlZWsoLW1heF9ieXRlcywgb3MuU0VFS19FTkQpCiAgICAgICAgICAgIHJhdyA9IHN0cmVhbS5yZWFkKG1heF9ieXRlcykKICAgIGV4Y2VwdCBPU0Vycm9yOgogICAgICAgIHJldHVybiAiYWdlbnQgbG9nIHVuYXZhaWxhYmxlIgogICAgaWYgdHJ1bmNhdGVkOgogICAgICAgIHNwbGl0X2F0ID0gcmF3LmZpbmQoYiJcbiIpCiAgICAgICAgcmF3ID0gcmF3W3NwbGl0X2F0ICsgMSA6XSBpZiBzcGxpdF9hdCA+PSAwIGVsc2UgYiIiCiAgICBsaW5lcyA9IHJhdy5kZWNvZGUoInV0Zi04IiwgZXJyb3JzPSJyZXBsYWNlIikuc3BsaXRsaW5lcygpCiAgICByZXR1cm4gIlxuIi5qb2luKGxpbmVzWy1tYXhfbGluZXM6XSkgb3IgIihlbXB0eSBsb2cpIgoKCmRlZiBjb21tYW5kX2FnZW50X2xvZ3MoY29uZmlnX3BhdGg6IFBhdGgpIC0+IHN0cjoKICAgIGNvbmZpZyA9IGxvYWRfY29uZmlnKGNvbmZpZ19wYXRoKQogICAgY29uZmlndXJlZF9kaXIgPSBjb25maWcuZ2V0KCJkYXRhX2RpciIpCiAgICBjYW5kaWRhdGVzOiBsaXN0W1BhdGhdID0gW10KICAgIGlmIGlzaW5zdGFuY2UoY29uZmlndXJlZF9kaXIsIHN0cikgYW5kIGNvbmZpZ3VyZWRfZGlyLnN0cmlwKCk6CiAgICAgICAgY2FuZGlkYXRlcy5hcHBlbmQoUGF0aChjb25maWd1cmVkX2RpcikuZXhwYW5kdXNlcigpKQogICAgY2FuZGlkYXRlcy5leHRlbmQoCiAgICAgICAgWwogICAgICAgICAgICBkZWZhdWx0X3N0YXRlX2RpcigpLAogICAgICAgICAgICBQYXRoLmhvbWUoKSAvICIubG9jYWwiIC8gInN0YXRlIiAvICJjaXRhZGVsLWV3cyIsCiAgICAgICAgXQogICAgKQogICAgc2Vlbjogc2V0W3N0cl0gPSBzZXQoKQogICAgZm9yIHJvb3QgaW4gY2FuZGlkYXRlczoKICAgICAgICBwYXRoID0gcm9vdCAvICJhZ2VudC5qc29ubCIKICAgICAgICBrZXkgPSBzdHIocGF0aCkKICAgICAgICBpZiBrZXkgaW4gc2VlbjoKICAgICAgICAgICAgY29udGludWUKICAgICAgICBzZWVuLmFkZChrZXkpCiAgICAgICAgaWYgcGF0aC5pc19maWxlKCk6CiAgICAgICAgICAgIHJldHVybiBfYm91bmRlZF90YWlsX2xpbmVzKHBhdGgpCiAgICByZXR1cm4gImFnZW50IGxvZyBub3QgZm91bmQiCgoKZGVmIGNvbW1hbmRfbG1zdHVkaW9fc3RhdHVzKCkgLT4gc3RyOgogICAgY29ubiA9IGh0dHAuY2xpZW50LkhUVFBDb25uZWN0aW9uKCIxMjcuMC4wLjEiLCAxMjM0LCB0aW1lb3V0PTEuNSkKICAgIHRyeToKICAgICAgICBjb25uLnJlcXVlc3QoIkdFVCIsICIvdjEvbW9kZWxzIiwgaGVhZGVycz17ImFjY2VwdCI6ICJhcHBsaWNhdGlvbi9qc29uIn0pCiAgICAgICAgcmVzcG9uc2UgPSBjb25uLmdldHJlc3BvbnNlKCkKICAgICAgICByYXcgPSByZXNwb25zZS5yZWFkKDY0ICogMTAyNCkKICAgICAgICByZXR1cm4gZiJIVFRQIHtyZXNwb25zZS5zdGF0dXN9XG4iICsgcmF3LmRlY29kZSgidXRmLTgiLCBlcnJvcnM9InJlcGxhY2UiKVs6MTIwMDBdCiAgICBleGNlcHQgT1NFcnJvciBhcyBlcnJvcjoKICAgICAgICByZXR1cm4gZiJMTSBTdHVkaW8gdW5hdmFpbGFibGU6IHt0eXBlKGVycm9yKS5fX25hbWVfX30iCiAgICBmaW5hbGx5OgogICAgICAgIGNvbm4uY2xvc2UoKQoKCmRlZiBjb21tYW5kX2RpYWdub3N0aWNzKCkgLT4gc3RyOgogICAgcmV0dXJuICJcbiIuam9pbigKICAgICAgICAoCiAgICAgICAgICAgIGNvbW1hbmRfc3RhdHVzKCksCiAgICAgICAgICAgICIiLAogICAgICAgICAgICAibmV0d29yazoiLAogICAgICAgICAgICBjb21tYW5kX25ldHdvcmsoKSwKICAgICAgICAgICAgIiIsCiAgICAgICAgICAgICJhZ2VudDoiLAogICAgICAgICAgICBjb21tYW5kX2FnZW50X3N0YXR1cygpLAogICAgICAgICkKICAgICkKCgpkZWYgY29udHJvbGxlcl90YXJnZXQoY29uZmlnX3BhdGg6IFBhdGgpIC0+IHR1cGxlW3N0ciwgaW50XSB8IE5vbmU6CiAgICBjb25maWcgPSBsb2FkX2NvbmZpZyhjb25maWdfcGF0aCkKICAgIHJhdyA9IHN0cihjb25maWcuZ2V0KCJjb250cm9sbGVyX3VybCIpIG9yICIiKS5zdHJpcCgpCiAgICBwYXJzZWQgPSB1cmxsaWIucGFyc2UudXJsc3BsaXQocmF3KQogICAgaWYgcGFyc2VkLnNjaGVtZSBub3QgaW4geyJodHRwcyIsICJodHRwIn0gb3Igbm90IHBhcnNlZC5ob3N0bmFtZToKICAgICAgICByZXR1cm4gTm9uZQogICAgaWYgcGFyc2VkLnNjaGVtZSA9PSAiaHR0cCIgYW5kIHBhcnNlZC5ob3N0bmFtZSBub3QgaW4geyIxMjcuMC4wLjEiLCAibG9jYWxob3N0IiwgIjo6MSJ9OgogICAgICAgIHJldHVybiBOb25lCiAgICByZXR1cm4gcGFyc2VkLmhvc3RuYW1lLCBwYXJzZWQucG9ydCBvciAoNDQzIGlmIHBhcnNlZC5zY2hlbWUgPT0gImh0dHBzIiBlbHNlIDgwKQoKCmRlZiBjb21tYW5kX3BpbmdfY29udHJvbGxlcihjb25maWdfcGF0aDogUGF0aCkgLT4gc3RyOgogICAgdGFyZ2V0ID0gY29udHJvbGxlcl90YXJnZXQoY29uZmlnX3BhdGgpCiAgICBpZiBub3QgdGFyZ2V0OgogICAgICAgIHJldHVybiAiY29udHJvbGxlciB0YXJnZXQgdW5hdmFpbGFibGUiCiAgICBob3N0LCBwb3J0ID0gdGFyZ2V0CiAgICB0cnk6CiAgICAgICAgc3RhcnRlZCA9IHRpbWUubW9ub3RvbmljKCkKICAgICAgICB3aXRoIHNvY2tldC5jcmVhdGVfY29ubmVjdGlvbigoaG9zdCwgcG9ydCksIHRpbWVvdXQ9Mi4wKToKICAgICAgICAgICAgZWxhcHNlZCA9IGludCgodGltZS5tb25vdG9uaWMoKSAtIHN0YXJ0ZWQpICogMTAwMCkKICAgICAgICByZXR1cm4gZiJ7aG9zdH06e3BvcnR9IHJlYWNoYWJsZSBpbiB7ZWxhcHNlZH0gbXMiCiAgICBleGNlcHQgT1NFcnJvciBhcyBlcnJvcjoKICAgICAgICByZXR1cm4gZiJ7aG9zdH06e3BvcnR9IHVucmVhY2hhYmxlOiB7dHlwZShlcnJvcikuX19uYW1lX199IgoKCmRlZiBleGVjdXRlKGNvbW1hbmQ6IHN0ciwgY29uZmlnX3BhdGg6IFBhdGgpIC0+IHR1cGxlW3N0ciwgYm9vbF06CiAgICB2ZXJiID0gY29tbWFuZC5zdHJpcCgpCiAgICBpZiBub3QgdmVyYjoKICAgICAgICByZXR1cm4gIiIsIEZhbHNlCiAgICBpZiBhbnkoY2hhciBpbiB2ZXJiIGZvciBjaGFyIGluICgiOyIsICJ8IiwgIiYiLCAiPiIsICI8IiwgImAiLCAiJCIsICJcbiIsICJcciIpKToKICAgICAgICByZXR1cm4gIkRFTklFRDogc2hlbGwgc3ludGF4IGlzIG5vdCBzdXBwb3J0ZWQuIiwgRmFsc2UKICAgIGlmIHZlcmIgbm90IGluIEFMTE9XRURfQ09NTUFORFM6CiAgICAgICAgcmV0dXJuICJERU5JRUQ6IGNvbW1hbmQgaXMgbm90IGluIHRoZSBDSVRBREVMIFNTSCBhbGxvdy1saXN0LiBUeXBlICdoZWxwJy4iLCBGYWxzZQogICAgaWYgdmVyYiA9PSAiZXhpdCI6CiAgICAgICAgcmV0dXJuICJTZXNzaW9uIGNsb3NlZC4iLCBUcnVlCiAgICBoYW5kbGVyczogZGljdFtzdHIsIENhbGxhYmxlW1tdLCBzdHJdXSA9IHsKICAgICAgICAiaGVscCI6IGNvbW1hbmRfaGVscCwKICAgICAgICAic3RhdHVzIjogY29tbWFuZF9zdGF0dXMsCiAgICAgICAgImhvc3RuYW1lIjogY29tbWFuZF9ob3N0bmFtZSwKICAgICAgICAid2hvYW1pIjogY29tbWFuZF93aG9hbWksCiAgICAgICAgInVuYW1lIC1hIjogY29tbWFuZF91bmFtZSwKICAgICAgICAicHl0aG9uIC0tdmVyc2lvbiI6IGNvbW1hbmRfcHl0aG9uX3ZlcnNpb24sCiAgICAgICAgInB5dGhvbjMgLS12ZXJzaW9uIjogY29tbWFuZF9weXRob25fdmVyc2lvbiwKICAgICAgICAidXB0aW1lIjogY29tbWFuZF91cHRpbWUsCiAgICAgICAgImNwdSI6IGNvbW1hbmRfY3B1LAogICAgICAgICJtZW1vcnkiOiBjb21tYW5kX21lbW9yeSwKICAgICAgICAiZGlzayI6IGNvbW1hbmRfZGlzaywKICAgICAgICAibmV0d29yayI6IGNvbW1hbmRfbmV0d29yaywKICAgICAgICAiYWdlbnQtc3RhdHVzIjogY29tbWFuZF9hZ2VudF9zdGF0dXMsCiAgICAgICAgImxtc3R1ZGlvLXN0YXR1cyI6IGNvbW1hbmRfbG1zdHVkaW9fc3RhdHVzLAogICAgICAgICJkaWFnbm9zdGljcyI6IGNvbW1hbmRfZGlhZ25vc3RpY3MsCiAgICB9CiAgICBpZiB2ZXJiID09ICJhZ2VudC1sb2dzIjoKICAgICAgICByZXR1cm4gY29tbWFuZF9hZ2VudF9sb2dzKGNvbmZpZ19wYXRoKSwgRmFsc2UKICAgIGlmIHZlcmIgPT0gInBpbmctY29udHJvbGxlciI6CiAgICAgICAgcmV0dXJuIGNvbW1hbmRfcGluZ19jb250cm9sbGVyKGNvbmZpZ19wYXRoKSwgRmFsc2UKICAgIHJldHVybiBoYW5kbGVyc1t2ZXJiXSgpLCBGYWxzZQoKCmRlZiBtYWluKCkgLT4gaW50OgogICAgcGFyc2VyID0gYXJncGFyc2UuQXJndW1lbnRQYXJzZXIoKQogICAgcGFyc2VyLmFkZF9hcmd1bWVudCgiLS1jb25maWciLCByZXF1aXJlZD1UcnVlKQogICAgYXJncyA9IHBhcnNlci5wYXJzZV9hcmdzKCkKICAgIGNvbmZpZ19wYXRoID0gUGF0aChhcmdzLmNvbmZpZykucmVzb2x2ZSgpCgogICAgb3JpZ2luYWwgPSBzdHIob3MuZW52aXJvbi5nZXQoIlNTSF9PUklHSU5BTF9DT01NQU5EIikgb3IgIiIpLnN0cmlwKCkKICAgIGlmIG9yaWdpbmFsOgogICAgICAgIG91dHB1dCwgXyA9IGV4ZWN1dGUob3JpZ2luYWwsIGNvbmZpZ19wYXRoKQogICAgICAgIHByaW50KG91dHB1dCkKICAgICAgICByZXR1cm4gMCBpZiBub3Qgb3V0cHV0LnN0YXJ0c3dpdGgoIkRFTklFRDoiKSBlbHNlIDIKCiAgICBwcmludCgiQ0lUQURFTCBSZXN0cmljdGVkIFNTSCBDb25zb2xlIikKICAgIHByaW50KCJObyBzaGVsbCwgbm8gYXJiaXRyYXJ5IGV4ZWN1dGFibGVzLCBubyBmaWxlIG11dGF0aW9uLiBUeXBlICdoZWxwJy4iKQogICAgd2hpbGUgVHJ1ZToKICAgICAgICB0cnk6CiAgICAgICAgICAgIGxpbmUgPSBpbnB1dCgiY2l0YWRlbD4gIikKICAgICAgICBleGNlcHQgKEVPRkVycm9yLCBLZXlib2FyZEludGVycnVwdCk6CiAgICAgICAgICAgIHByaW50KCkKICAgICAgICAgICAgcmV0dXJuIDAKICAgICAgICBvdXRwdXQsIHNob3VsZF9leGl0ID0gZXhlY3V0ZShsaW5lLCBjb25maWdfcGF0aCkKICAgICAgICBpZiBvdXRwdXQ6CiAgICAgICAgICAgIHByaW50KG91dHB1dCkKICAgICAgICBpZiBzaG91bGRfZXhpdDoKICAgICAgICAgICAgcmV0dXJuIDAKCgppZiBfX25hbWVfXyA9PSAiX19tYWluX18iOgogICAgcmFpc2UgU3lzdGVtRXhpdChtYWluKCkpCg=="
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


def local_error_code(error: Exception) -> str:
    """Only expose fixed diagnostic codes, never arbitrary exception text."""
    code = str(error)
    if re.fullmatch(r"lmstudio_[a-z_]+|lmstudio_http_[0-9]{3}", code):
        return code
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "lmstudio_timeout"
    if isinstance(error, ConnectionError):
        return "lmstudio_connection_failed"
    return "local_execution_error"


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


class ControllerApiError(RuntimeError):
    def __init__(self, status: int, code: str, retry_after_seconds: float = 0) -> None:
        self.status = int(status)
        self.code = str(code)
        self.retry_after_seconds = max(0, retry_after_seconds)
        super().__init__(f"controller HTTP {self.status}: {self.code}")


class OperationCancelled(RuntimeError):
    """Raised when the Controller cancels one active long-running operation."""


class LmStudioApiError(RuntimeError):
    def __init__(self, status: int, detail: Any = None) -> None:
        self.status_code = status
        super().__init__(f"lmstudio_http_{status}:{str(detail)[:300]}")


class ApiClient:
    def __init__(self, config: AgentConfig, identity: Identity) -> None:
        self.config = config
        self.identity = identity
        parsed = urllib.parse.urlsplit(config.controller_url)
        self.scheme = parsed.scheme
        self.host = parsed.hostname or ""
        self.port = parsed.port
        self.base_path = parsed.path.rstrip("/")
        self._retry_lock = threading.Lock()
        self._retry_until = 0.0
        self._retry_error = None
        if self.scheme == "https":
            self.connection_type = http.client.HTTPSConnection
        elif self.scheme == "http" and self.host in {"127.0.0.1", "localhost", "::1"}:
            self.connection_type = http.client.HTTPConnection
        else:
            raise ValueError("unsupported controller scheme")

    def retry_delay(self) -> float:
        with self._retry_lock:
            return max(0, self._retry_until - time.monotonic())

    def _check_retry_pause(self) -> None:
        with self._retry_lock:
            remaining = self._retry_until - time.monotonic()
            if remaining > 0 and self._retry_error:
                status, code = self._retry_error
                raise ControllerApiError(status, code, remaining)

    def _quota_retry(self, response, value, code: str) -> float:
        daily_quota = response.status == 503 and bool(re.search(r"d1_daily_(read|write)_limit_exceeded", code))
        if response.status not in {429, 503}:
            return 0
        header = response.getheader("Retry-After") if hasattr(response, "getheader") else None
        delay = None
        if header:
            try:
                delay = float(header)
            except (ValueError, TypeError):
                try:
                    date = email.utils.parsedate_to_datetime(header)
                    delay = date.timestamp() - time.time()
                except (ValueError, TypeError, OverflowError):
                    pass
        if delay is None and isinstance(value, dict):
            raw = value.get("retry_after_seconds")
            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                delay = float(raw)
        if delay is None and not daily_quota:
            return 0
        if delay is None or not 0 <= delay <= 86400:
            if not daily_quota:
                return 0
            utc = dt.datetime.now(dt.timezone.utc)
            reset = (utc + dt.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            delay = (reset - utc).total_seconds()
        delay = max(1.0, min(86400.0, delay))
        if daily_quota:
            with self._retry_lock:
                self._retry_until = max(self._retry_until, time.monotonic() + delay)
                self._retry_error = (response.status, code)
        return delay

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        signed: bool = True,
        *,
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        self._check_retry_pause()
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
            timeout=(
                self.config.request_timeout_seconds
                if timeout_seconds is None
                else max(1.0, float(timeout_seconds))
            ),
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
                retry = self._quota_retry(response, value, str(error))
                raise ControllerApiError(response.status, str(error), retry)
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
            except ControllerApiError as error:
                if error.status == 409 and error.code in {
                    "assignment_not_active",
                    "result_already_exists",
                }:
                    continue
                remaining.extend(items[index:])
                break
            except Exception:
                remaining.extend(items[index:])
                break
        atomic_write(self.path, json.dumps(remaining, ensure_ascii=False, indent=2) + "\n")
        return sent


MissionHandler = Callable[[dict[str, Any]], dict[str, Any]]



VIRTUAL_INTERFACE_TOKENS = (
    "loopback",
    "docker",
    "vethernet",
    "hyper-v",
    "vmware",
    "virtualbox",
    "wsl",
    "tailscale",
)
SHARED_IPV4_NETWORK = ipaddress.ip_network("100.64.0.0/10")


def _normalize_mac(value: str) -> str | None:
    compact = "".join(ch for ch in str(value) if ch.isalnum()).upper()
    if len(compact) != 12 or any(ch not in "0123456789ABCDEF" for ch in compact):
        return None
    if compact == "000000000000":
        return None
    return ":".join(compact[index:index + 2] for index in range(0, 12, 2))


def local_network_addresses() -> dict[str, Any]:
    """Discover current physical/private LAN IPv4 and MAC addresses."""
    lan: list[str] = []
    mac_addresses: list[str] = []
    interfaces: list[dict[str, str]] = []
    try:
        stats = psutil.net_if_stats()
        addresses = psutil.net_if_addrs()
    except Exception:
        return {
            "lan_ipv4": None,
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
        if any(token in lowered for token in VIRTUAL_INTERFACE_TOKENS):
            continue
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
                    or address in SHARED_IPV4_NETWORK
                ):
                    continue
                if address.is_private:
                    value = str(address)
                    interface_ipv4 = interface_ipv4 or value
                    lan.append(value)
            elif link_family is not None and item.family == link_family:
                normalized = _normalize_mac(item.address)
                if normalized:
                    interface_mac = normalized
        if interface_ipv4:
            entry = {"name": interface_name[:120], "ipv4": interface_ipv4}
            if interface_mac:
                entry["mac"] = interface_mac
                mac_addresses.append(interface_mac)
            interfaces.append(entry)

    lan = list(dict.fromkeys(lan))
    mac_addresses = list(dict.fromkeys(mac_addresses))
    return {
        "lan_ipv4": lan[0] if lan else None,
        "private_ipv4": lan,
        "mac_addresses": mac_addresses[:16],
        "interfaces": interfaces[:32],
    }


def _doctor_powershell_json(command: str, timeout: int = 12) -> Any:
    """Run a fixed, read-only PowerShell inventory query and decode JSON."""
    if os.name != "nt":
        return None
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return None
    try:
        result = _citadel_subprocess_run(  # nosec B603
            [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
             "$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" + command],
            timeout=timeout,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    output = result.stdout or ""
    if result.returncode != 0 or not output.strip():
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        return None


def _doctor_pci_ids(value: str) -> dict[str, str]:
    text = str(value or "").upper()
    found: dict[str, str] = {}
    for key, pattern in (
        ("vendor_id", r"(?:VEN|VID)_([0-9A-F]{4})"),
        ("device_id", r"(?:DEV|PID)_([0-9A-F]{4})"),
        ("subsystem_id", r"SUBSYS_([0-9A-F]{8})"),
    ):
        match = re.search(pattern, text)
        if match:
            found[key] = match.group(1)
    return found


def _doctor_local_interfaces() -> list[dict[str, Any]]:
    try:
        stats = psutil.net_if_stats()
        addresses = psutil.net_if_addrs()
    except Exception:
        return []
    link_family = getattr(psutil, "AF_LINK", None)
    rows: list[dict[str, Any]] = []
    for name, items in addresses.items():
        lowered = name.lower()
        if any(token in lowered for token in VIRTUAL_INTERFACE_TOKENS):
            continue
        state = stats.get(name)
        row: dict[str, Any] = {
            "name": name[:120],
            "is_up": bool(state.isup) if state is not None else None,
            "speed_mbps": int(state.speed) if state is not None and state.speed >= 0 else None,
            "mtu": int(state.mtu) if state is not None and state.mtu > 0 else None,
            "ipv4": [],
            "mac": None,
        }
        for item in items:
            if item.family == socket.AF_INET:
                try:
                    address = ipaddress.ip_address(item.address)
                except ValueError:
                    continue
                if not (
                    address.is_loopback
                    or address.is_link_local
                    or address.is_multicast
                    or address.is_unspecified
                ):
                    row["ipv4"].append(str(address))
            elif link_family is not None and item.family == link_family:
                row["mac"] = row["mac"] or _normalize_mac(str(item.address or ""))
        if row["ipv4"] or row["mac"]:
            rows.append(row)
    return rows[:32]


def _doctor_windows_network_devices() -> list[dict[str, Any]]:
    decoded = _doctor_powershell_json(
        "Get-CimInstance Win32_NetworkAdapter | "
        "Where-Object {$_.PhysicalAdapter -eq $true} | "
        "Select-Object Name,Manufacturer,MACAddress,Speed,PNPDeviceID,"
        "NetConnectionID,NetConnectionStatus | ConvertTo-Json -Compress"
    )
    rows = decoded if isinstance(decoded, list) else ([decoded] if isinstance(decoded, dict) else [])
    drivers_decoded = _doctor_powershell_json(
        "Get-CimInstance Win32_PnPSignedDriver | "
        "Where-Object {$_.DeviceClass -eq 'NET'} | "
        "Select-Object DeviceName,Manufacturer,DriverVersion,DriverDate,DeviceID | "
        "ConvertTo-Json -Compress"
    )
    drivers = drivers_decoded if isinstance(drivers_decoded, list) else (
        [drivers_decoded] if isinstance(drivers_decoded, dict) else []
    )
    by_device_id = {
        str(item.get("DeviceID") or "").upper(): item
        for item in drivers
        if isinstance(item, dict) and item.get("DeviceID")
    }
    result: list[dict[str, Any]] = []
    for item in rows[:32]:
        if not isinstance(item, dict):
            continue
        pnp_id = str(item.get("PNPDeviceID") or "")
        driver = by_device_id.get(pnp_id.upper(), {})
        speed = item.get("Speed")
        row: dict[str, Any] = {
            "name": str(item.get("NetConnectionID") or item.get("Name") or "")[:160],
            "description": str(item.get("Name") or "")[:200] or None,
            "manufacturer": str(item.get("Manufacturer") or driver.get("Manufacturer") or "")[:160] or None,
            "mac": _normalize_mac(str(item.get("MACAddress") or "")),
            "speed_bps": int(speed) if isinstance(speed, (int, float)) and speed >= 0 else None,
            "driver_version": str(driver.get("DriverVersion") or "")[:80] or None,
            "driver_date": str(driver.get("DriverDate") or "")[:80] or None,
            "pnp_device_id": pnp_id[:240] or None,
            "source": "windows_cim_readonly",
        }
        row.update(_doctor_pci_ids(pnp_id))
        result.append({key: value for key, value in row.items() if value is not None})
    return result


def _doctor_ethtool_driver(interface_name: str) -> dict[str, str]:
    executable = shutil.which("ethtool")
    if not executable:
        return {}
    try:
        result = _citadel_subprocess_run(  # nosec B603
            [executable, "-i", interface_name],
            timeout=5,
            capture_output=True,
            text=True,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    mapped: dict[str, str] = {}
    keys = {
        "driver": "driver",
        "version": "driver_version",
        "firmware-version": "firmware_version",
        "bus-info": "pci_address",
    }
    for line in result.stdout.splitlines():
        key, sep, value = line.partition(":")
        target = keys.get(key.strip().lower())
        if sep and target and value.strip():
            mapped[target] = value.strip()[:160]
    return mapped


def _doctor_linux_vpd(pci_address: str) -> dict[str, str]:
    executable = shutil.which("lspci")
    if not executable or not pci_address:
        return {}
    try:
        result = _citadel_subprocess_run(  # nosec B603
            [executable, "-s", pci_address, "-vv"],
            timeout=6,
            capture_output=True,
            text=True,
            errors="replace",
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    summary: dict[str, str] = {}
    labels = {
        "product name": "product_name",
        "part number": "part_number",
        "revision": "revision",
        "serial number": "serial_number",
    }
    for raw_line in result.stdout.splitlines():
        normalized = re.sub(r"^\[[A-Za-z0-9]+\]\s*", "", raw_line.strip())
        key, sep, value = normalized.partition(":")
        target = labels.get(key.strip().lower())
        if sep and target and value.strip():
            summary[target] = value.strip()[:200]
    return summary


def _doctor_linux_network_devices() -> list[dict[str, Any]]:
    if os.name == "nt":
        return []
    try:
        names = list(psutil.net_if_addrs())
    except Exception:
        return []
    result: list[dict[str, Any]] = []
    sys_net = Path("/sys/class/net")
    for name in names[:64]:
        lowered = name.lower()
        if any(token in lowered for token in VIRTUAL_INTERFACE_TOKENS):
            continue
        device_link = sys_net / name / "device"
        if not device_link.exists():
            continue
        try:
            pci_address = device_link.resolve().name
        except OSError:
            pci_address = device_link.name
        driver_name = None
        with contextlib.suppress(OSError):
            driver_name = (device_link / "driver").resolve().name

        def read_id(filename: str) -> str | None:
            try:
                value = (device_link / filename).read_text(
                    encoding="ascii", errors="replace"
                ).strip()
            except OSError:
                return None
            return value.removeprefix("0x").upper()[:32] or None

        row: dict[str, Any] = {
            "name": name[:120],
            "pci_address": pci_address[:40],
            "vendor_id": read_id("vendor"),
            "device_id": read_id("device"),
            "subsystem_vendor_id": read_id("subsystem_vendor"),
            "subsystem_device_id": read_id("subsystem_device"),
            "driver": driver_name,
            "vpd_available": (device_link / "vpd").exists(),
            "source": "linux_sysfs_readonly",
        }
        row.update(_doctor_ethtool_driver(name))
        row.update(_doctor_linux_vpd(pci_address))
        result.append({key: value for key, value in row.items() if value is not None})
    return result


def _doctor_network_devices() -> list[dict[str, Any]]:
    return _doctor_windows_network_devices() if os.name == "nt" else _doctor_linux_network_devices()


def _doctor_default_routes() -> list[dict[str, Any]]:
    if os.name == "nt":
        decoded = _doctor_powershell_json(
            "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | "
            "Sort-Object RouteMetric | Select-Object -First 4 "
            "InterfaceAlias,NextHop,RouteMetric,State | ConvertTo-Json -Compress"
        )
        rows = decoded if isinstance(decoded, list) else ([decoded] if isinstance(decoded, dict) else [])
        return [
            {
                "interface": str(item.get("InterfaceAlias") or "")[:120] or None,
                "gateway": str(item.get("NextHop") or "")[:64] or None,
                "metric": item.get("RouteMetric"),
                "state": str(item.get("State") or "")[:40] or None,
            }
            for item in rows[:4]
            if isinstance(item, dict)
        ]

    try:
        lines = Path("/proc/net/route").read_text(
            encoding="ascii", errors="replace"
        ).splitlines()[1:]
    except OSError:
        return []
    rows: list[dict[str, Any]] = []
    for line in lines:
        fields = line.split()
        if len(fields) < 8 or fields[1] != "00000000":
            continue
        try:
            gateway_raw = int(fields[2], 16).to_bytes(4, "little")
            gateway = socket.inet_ntoa(gateway_raw)
            metric = int(fields[6])
        except (ValueError, OSError):
            continue
        rows.append({"interface": fields[0][:120], "gateway": gateway, "metric": metric})
    return rows[:4]


def hardware_doctor_snapshot() -> dict[str, Any]:
    """Bounded hardware inventory derived from physical-NIC/MAC/VPD diagnostics."""
    interfaces = _doctor_local_interfaces()
    devices = _doctor_network_devices()
    macs = [str(row.get("mac")) for row in interfaces if row.get("mac")]
    duplicate_macs = sorted({value for value in macs if macs.count(value) > 1})
    return {
        "schema": "citadel.hardware-doctor.v1",
        "readonly": True,
        "usb_scanning": False,
        "network_interfaces": interfaces,
        "network_devices": devices,
        "default_routes": _doctor_default_routes(),
        "checks": {
            "physical_network_present": bool(devices or macs),
            "duplicate_mac_addresses": duplicate_macs,
            "pci_metadata_available": any(
                item.get("pci_address") or item.get("pnp_device_id")
                for item in devices if isinstance(item, dict)
            ),
            "firmware_metadata_available": any(
                item.get("firmware_version")
                for item in devices if isinstance(item, dict)
            ),
            "vpd_metadata_available": any(
                item.get("vpd_available") or item.get("product_name") or item.get("part_number")
                for item in devices if isinstance(item, dict)
            ),
        },
    }


def network_doctor_snapshot(controller_url: str) -> dict[str, Any]:
    """Check local link, route, DNS and TCP reachability to the configured Controller."""
    parsed = urllib.parse.urlsplit(controller_url)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    interfaces = _doctor_local_interfaces()
    routes = _doctor_default_routes()
    checks: list[dict[str, Any]] = [
        {
            "name": "local_interface",
            "ok": any(row.get("is_up") and row.get("ipv4") for row in interfaces),
            "detail": next(
                (", ".join(row.get("ipv4") or []) for row in interfaces
                 if row.get("is_up") and row.get("ipv4")),
                "no active physical IPv4 interface detected",
            ),
        },
        {
            "name": "default_route",
            "ok": bool(routes),
            "detail": routes[0].get("gateway") if routes else "default route not detected",
        },
    ]
    resolved: list[str] = []
    dns_error = None
    try:
        resolved = list(dict.fromkeys(
            item[4][0]
            for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
            if item and item[4]
        ))[:8]
    except OSError as error:
        dns_error = type(error).__name__
    checks.append({
        "name": "controller_dns",
        "ok": bool(resolved),
        "detail": ", ".join(resolved) if resolved else (dns_error or "resolution failed"),
    })
    tcp_ok = False
    tcp_error = None
    if resolved:
        try:
            with socket.create_connection((host, port), timeout=3.0):
                tcp_ok = True
        except OSError as error:
            tcp_error = type(error).__name__
    checks.append({
        "name": "controller_tcp",
        "ok": tcp_ok,
        "detail": f"{host}:{port}" if tcp_ok else (tcp_error or "not attempted"),
    })
    passed = sum(1 for item in checks if item.get("ok"))
    return {
        "schema": "citadel.network-doctor.v1",
        "readonly": True,
        "controller_host": host,
        "controller_port": port,
        "checks": checks,
        "passed": passed,
        "total": len(checks),
        "status": "ok" if passed == len(checks) else ("degraded" if passed >= 2 else "failed"),
    }


def _windows_restricted_ssh_policy_snapshot() -> dict[str, Any]:
    if os.name != "nt":
        return {
            "restricted_bootstrap_state_present": False,
            "restricted_console_installed": False,
            "cloudflare_ca_public_key_present": False,
            "sshd_force_command_managed": False,
            "restricted_policy_ready": False,
        }
    program_data = Path(os.environ.get("PROGRAMDATA") or r"C:\ProgramData")
    state_root = program_data / "CitadelEWS" / "ssh"
    state_path = state_root / "bootstrap-state.json"
    console_path = state_root / "CitadelSshConsole.exe"
    ca_path = program_data / "ssh" / "citadel_cloudflare_ca.pub"
    sshd_config = program_data / "ssh" / "sshd_config"
    state = load_json(state_path, {}) if state_path.is_file() else {}
    state_present = bool(
        isinstance(state, dict)
        and state.get("schema") == "citadel.restricted-ssh-bootstrap.v1"
        and isinstance(state.get("ssh_user"), str)
        and bool(state.get("ssh_user"))
    )
    config_text = ""
    try:
        if sshd_config.is_file():
            config_text = sshd_config.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        config_text = ""
    ssh_user = str(state.get("ssh_user") or "") if isinstance(state, dict) else ""
    managed = bool(ssh_user) and all(token in config_text for token in (
        "# BEGIN CITADEL SSH GLOBAL",
        "ListenAddress 127.0.0.1",
        f"AllowUsers {ssh_user}",
        "TrustedUserCAKeys C:/ProgramData/ssh/citadel_cloudflare_ca.pub",
        "# BEGIN CITADEL SSH USER",
        f"Match User {ssh_user}",
        "ForceCommand C:/ProgramData/CitadelEWS/ssh/CitadelSshConsole.exe",
        "AuthenticationMethods publickey",
        "PasswordAuthentication no",
        "AllowAgentForwarding no",
        "AllowTcpForwarding no",
        "GatewayPorts no",
    ))
    console_installed = console_path.is_file()
    ca_present = ca_path.is_file()
    return {
        "restricted_bootstrap_state_present": state_present,
        "restricted_console_installed": console_installed,
        "cloudflare_ca_public_key_present": ca_present,
        "sshd_force_command_managed": managed,
        "restricted_policy_ready": bool(state_present and console_installed and ca_present and managed),
    }


def ssh_runtime_snapshot() -> dict[str, Any]:
    """Read-only SSH/Cloudflare readiness for Zero Trust browser access."""
    ssh_client = shutil.which("ssh") or shutil.which("ssh.exe")
    cloudflared = shutil.which("cloudflared") or shutil.which("cloudflared.exe")
    sshd_running = False
    cloudflared_running = False
    try:
        for proc in psutil.process_iter(["name"]):
            name = str((proc.info or {}).get("name") or "").lower()
            if name in {"sshd", "sshd.exe"}:
                sshd_running = True
            if name in {"cloudflared", "cloudflared.exe"}:
                cloudflared_running = True
            if sshd_running and cloudflared_running:
                break
    except (psutil.Error, OSError):
        sshd_running = False
        cloudflared_running = False

    local_port_open = False
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.35)
    try:
        local_port_open = probe.connect_ex(("127.0.0.1", 22)) == 0
    except OSError:
        local_port_open = False
    finally:
        probe.close()

    listener_ips: list[str] = []
    exposure_verified = False
    try:
        for connection in psutil.net_connections(kind="inet"):
            if connection.status != psutil.CONN_LISTEN or not connection.laddr:
                continue
            if int(connection.laddr.port) != 22:
                continue
            listener_ips.append(str(connection.laddr.ip))
        exposure_verified = True
    except (psutil.AccessDenied, OSError):
        exposure_verified = False
    listener_ips = sorted(set(listener_ips))
    loopback_only = bool(
        exposure_verified
        and listener_ips
        and all(ipaddress.ip_address(value).is_loopback for value in listener_ips)
    )
    policy = _windows_restricted_ssh_policy_snapshot()
    policy_gate = policy["restricted_policy_ready"] if os.name == "nt" else True

    return {
        "schema": "citadel.ssh-readiness.v2",
        "transport": "cloudflare_access_browser_ssh",
        "bind_target": "localhost:22",
        "ssh_client_available": bool(ssh_client),
        "sshd_process_running": sshd_running,
        "sshd_listening_local": local_port_open,
        "sshd_listener_ips": listener_ips[:8],
        "sshd_exposure_verified": exposure_verified,
        "sshd_loopback_only": loopback_only,
        "cloudflared_installed": bool(cloudflared),
        "cloudflared_running": cloudflared_running,
        **policy,
        "browser_terminal_local_ready": bool(local_port_open and loopback_only and cloudflared_running and policy_gate),
        "private_keys_on_hub": False,
        "recommended_restricted_commands": [
            "help",
            "status",
            "hostname",
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
        ],
    }


def _ssh_restricted_console_path() -> Path:
    return Path(__file__).resolve().parent / "ssh_restricted_console.py"


def _ensure_ssh_restricted_console_file() -> Path:
    path = _ssh_restricted_console_path()
    try:
        existing = path.read_bytes() if path.is_file() else b""
    except OSError:
        existing = b""
    if existing and hashlib.sha256(existing).hexdigest() == SSH_RESTRICTED_CONSOLE_SHA256:
        return path
    try:
        payload = base64.b64decode(SSH_RESTRICTED_CONSOLE_B64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise RuntimeError("embedded SSH restricted console is invalid") from exc
    if len(payload) > SSH_RESTRICTED_CONSOLE_MAX_BYTES:
        raise RuntimeError("embedded SSH restricted console is too large")
    if hashlib.sha256(payload).hexdigest() != SSH_RESTRICTED_CONSOLE_SHA256:
        raise RuntimeError("embedded SSH restricted console hash mismatch")
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RuntimeError("embedded SSH restricted console is not UTF-8") from exc
    atomic_write(path, text, 0o600)
    return path



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
        result = _citadel_subprocess_run(  # nosec B603
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
        payload = json.loads((result.stdout or "").strip())
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


def gpu_inventory() -> list[dict[str, Any]]:
    """Collect bounded GPU identity/VRAM data without installing vendor tooling."""
    rows: list[dict[str, Any]] = []
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi:
        try:
            result = _citadel_subprocess_run(  # nosec B603
                [
                    nvidia_smi,
                    "--query-gpu=name,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                timeout=10,
                capture_output=True,
                text=True,
                shell=False,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines()[:8]:
                    parts = [part.strip() for part in line.split(",", 1)]
                    if not parts or not parts[0]:
                        continue
                    vram_bytes = None
                    if len(parts) > 1:
                        with contextlib.suppress(ValueError):
                            vram_bytes = max(0, int(float(parts[1]) * 1024 * 1024))
                    rows.append({"name": parts[0][:160], "vram_total_bytes": vram_bytes})
        except (OSError, subprocess.SubprocessError):
            pass
    if rows or os.name != "nt":
        return rows

    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        return rows
    try:
        result = _citadel_subprocess_run(  # nosec B603
            [
                powershell,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | "
                "Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
            ],
            timeout=12,
            capture_output=True,
            text=True,
            shell=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return rows
        decoded = json.loads(result.stdout)
        devices = decoded if isinstance(decoded, list) else [decoded]
        for item in devices[:8]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("Name") or "").strip()
            if not name:
                continue
            raw_vram = item.get("AdapterRAM")
            vram_bytes = int(raw_vram) if isinstance(raw_vram, (int, float)) and raw_vram > 0 else None
            rows.append({"name": name[:160], "vram_total_bytes": vram_bytes})
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, ValueError, TypeError):
        pass
    return rows


def hardware_snapshot() -> dict[str, Any]:
    memory = psutil.virtual_memory()
    return {
        "cpu_logical_count": int(psutil.cpu_count(logical=True) or 1),
        "memory_total_bytes": int(memory.total),
        "gpus": gpu_inventory(),
        "gpus": gpu_inventory(),
    }


def system_inventory(payload: dict[str, Any]) -> dict[str, Any]:
    # Service accounts can have a configured profile that has never been created.
    # Inventory must still describe a real accessible filesystem in that case.
    disk = None
    for location in (Path.home(), Path(__file__).resolve().parent, Path.cwd()):
        try:
            disk = shutil.disk_usage(location)
            break
        except OSError:
            continue
    if disk is None:
        raise RuntimeError("inventory_disk_unavailable")
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
        "cpu_logical_count": psutil.cpu_count(logical=True),
        "memory_total_bytes": int(memory.total),
        "disk_home_total_bytes": int(disk.total),
        "disk_home_free_bytes": int(disk.free),
        "network": local_network_addresses(),
        "hardware_doctor": hardware_doctor_snapshot(),
        "windows_enterprise": windows_enterprise_probe(),
    }


HANDLERS: dict[str, MissionHandler] = {"system_inventory": system_inventory}


class LocalWatchdog:
    """Exit a supervised agent only after local progress stops for ten minutes."""

    def __init__(self, timeout_seconds: float = 600, exit_process=None) -> None:
        self.timeout_seconds = timeout_seconds
        self.exit_process = exit_process or os._exit
        self.last_progress = time.monotonic()
        self.finished = threading.Event()
        self.thread = None

    def touch(self) -> None:
        self.last_progress = time.monotonic()

    def check(self) -> bool:
        if time.monotonic() - self.last_progress < self.timeout_seconds:
            return False
        self.exit_process(1)
        return True

    def start(self) -> None:
        self.touch()
        self.thread = threading.Thread(target=self._monitor, name="citadel-local-watchdog", daemon=True)
        self.thread.start()

    def _monitor(self) -> None:
        interval = min(5, max(0.05, self.timeout_seconds / 4))
        while not self.finished.wait(interval):
            if self.check():
                return

    def stop(self) -> None:
        self.finished.set()
        if self.thread:
            self.thread.join(timeout=2)


class Agent:
    def __init__(self, config: AgentConfig, config_path: Path | None = None) -> None:
        self.config = config
        self._state_lock = threading.RLock()
        self._operation_depth = 0
        self._active_lm_connection = None
        self._operation_cancel_requested = threading.Event()
        # A readiness proof is valid only inside this running Agent process.
        self.runtime_session_id = uuid.uuid4().hex
        self.config_path = (config_path or Path("config.json")).resolve()
        if os.name == "nt":
            _ensure_windows_enterprise_probe_file()
        _ensure_ssh_restricted_console_file()
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
        self.network_recovery_path = config.data_dir / "network-recovery.json"
        self.last_network_recovery = 0.0
        self.last_network_remember = 0.0
        self.last_power_guard = 0.0
        self.power_guard_active = False
        self.power_guard_process = None
        self.power_guard_attempted = False
        self.watchdog = None
        self.last_heartbeat = 0.0
        self.last_hardware_report = 0.0
        self.last_ssh_report = 0.0
        self.enrollment_confirmed = False
        self.sync_retry_at = 0.0
        self.last_ai_report = 0.0
        self.last_ai_fingerprint = None

    @property
    def capabilities(self) -> list[str]:
        capabilities = set(HANDLERS) | {"hardware_doctor_readonly", "lmstudio_remote", "project_text", "project_python", "ssh_probe_readonly"}
        if os.name == "nt" and all(
            (Path(__file__).resolve().parent / name).is_file()
            for name in ("CitadelSshConsole.cs", "configure_restricted_ssh.ps1")
        ):
            capabilities.add("windows_restricted_ssh_bootstrap")
        if self.config.prevent_automatic_sleep and self.power_guard_active:
            capabilities.add("always_on_guard")
        if self.config.network_recovery_enabled:
            capabilities.add("known_network_recovery")
        if os.name == "nt" and os.environ.get("CITADEL_SERVICE_MANAGED") == "1":
            capabilities.add("windows_core_service")
        if _windows_enterprise_probe_file_valid():
            capabilities.add("windows_enterprise_readonly")
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

    def heartbeat(self, *, timeout_seconds: float | None = None) -> None:
        node_id = self.require_node_id()
        payload = self.heartbeat_payload()
        self.api.request("POST", f"/api/v1/nodes/{node_id}/heartbeat", payload,
                         timeout_seconds=timeout_seconds)
        self.heartbeat_succeeded(payload)

    def heartbeat_payload(self) -> dict[str, Any]:
        network = local_network_addresses()
        now = time.monotonic()
        payload: dict[str, Any] = {
            "cpu_percent": float(psutil.cpu_percent(interval=0.05)),
            "memory_percent": float(psutil.virtual_memory().percent),
            "agent_version": VERSION,
            "capabilities": self.capabilities,
            "network": {
                "lan_ipv4": network.get("lan_ipv4"),
                "mac_addresses": network.get("mac_addresses") or [],
            },
        }
        if now - self.last_hardware_report >= 300:
            payload["hardware"] = hardware_snapshot()
        if now - self.last_ssh_report >= 300:
            payload["ssh"] = ssh_runtime_snapshot()
        return payload

    def heartbeat_succeeded(self, payload: dict[str, Any]) -> None:
        self.last_heartbeat = time.monotonic()
        if "hardware" in payload:
            self.last_hardware_report = self.last_heartbeat
        if "ssh" in payload:
            self.last_ssh_report = self.last_heartbeat
        if time.monotonic() - self.last_network_remember >= 300:
            self.remember_network_profile()
            self.last_network_remember = time.monotonic()
    def refresh_lmstudio_readiness(self) -> dict[str, Any]:
        """Refresh runtime state and prove inference once when readiness is unknown or stale."""
        snapshot = self.probe_lmstudio()
        model = str(snapshot.get("loaded_model") or "").strip()
        if (
            snapshot.get("installed")
            and snapshot.get("server_running")
            and model
            and not snapshot.get("inference_ready")
        ):
            try:
                self.verify_lmstudio_inference(model)
            except Exception as error:
                self.log.write("lmstudio_inference_probe_failed", error=local_error_code(error))
            snapshot = self.probe_lmstudio()
        return snapshot

    def sync_lmstudio_readiness(self) -> None:
        """Refresh scheduler-visible LM Studio state with bounded real inference proof."""
        try:
            self.report_ai_state(**self.refresh_lmstudio_readiness())
        except Exception as error:
            self.log.write("lmstudio_heartbeat_probe_failed", error=str(error)[:300])


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

    def _project_llm_chat(
        self,
        model: str,
        system_prompt: str,
        user_prompt: str,
        *,
        max_tokens: int,
        temperature: float = 0.2,
        timeout_seconds: float = LMSTUDIO_QUERY_TIMEOUT_SECONDS,
    ) -> tuple[str, dict[str, int] | None]:
        request_body = json_text({
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        })
        timeout_limit = max(1.0, min(float(timeout_seconds), LMSTUDIO_QUERY_TIMEOUT_SECONDS))
        connection = http.client.HTTPConnection(
            "127.0.0.1",
            1234,
            timeout=timeout_limit,
        )
        with self.lm_connection_deadline(connection, timeout_limit) as deadline_expired:
            try:
                connection.request(
                    "POST",
                    "/v1/chat/completions",
                    body=request_body.encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                )
                response = connection.getresponse()
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("lmstudio_response_too_large")
                if response.status != 200:
                    raise RuntimeError(f"lmstudio_http_{response.status}")
            except Exception as error:
                if deadline_expired.is_set():
                    raise RuntimeError("lmstudio_query_timeout") from error
                raise
            finally:
                connection.close()
        if deadline_expired.is_set():
            raise RuntimeError("lmstudio_query_timeout")

        try:
            decoded = json.loads(raw.decode("utf-8"))
            content = decoded["choices"][0]["message"]["content"]
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
            raise RuntimeError("lmstudio_invalid_response")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("lmstudio_empty_response")
        usage = decoded.get("usage")
        measured = None
        if isinstance(usage, dict):
            prompt_tokens = usage.get("prompt_tokens")
            completion_tokens = usage.get("completion_tokens")
            if (type(prompt_tokens) is int and prompt_tokens >= 0
                    and type(completion_tokens) is int and completion_tokens >= 0):
                measured = {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                }
        return content.strip(), measured

    def verify_lmstudio_inference(self, model: str) -> None:
        """Prove the loaded model can produce tokens; listing it is not enough."""
        started = time.monotonic()
        try:
            answer, _ = self._project_llm_chat(
                model,
                "CITADEL readiness probe. Reply with one short word.",
                "hi",
                max_tokens=4,
                temperature=0.0,
                timeout_seconds=LMSTUDIO_INFERENCE_PROBE_TIMEOUT_SECONDS,
            )
        except Exception as error:
            # Keep heartbeat/sync polling to one Controller request.  Readiness
            # proof is local here; the next normal sync carries the state.
            self.save_lmstudio_state(
                installed=True,
                server_running=True,
                loaded_model=model,
                inference_ready=False,
                inference_model=model,
                inference_checked_at=now_iso(),
                inference_error=local_error_code(error),
                inference_session_id=self.runtime_session_id,
                last_action="inference_preflight",
                progress_phase="failed",
                progress_detail="lmstudio_inference_probe_failed",
            )
            raise RuntimeError("lmstudio_inference_probe_failed") from error
        if not answer.strip():
            raise RuntimeError("lmstudio_inference_probe_failed")
        self.save_lmstudio_state(
            installed=True,
            server_running=True,
            loaded_model=model,
            inference_ready=True,
            inference_model=model,
            inference_checked_at=now_iso(),
            inference_error=None,
            inference_session_id=self.runtime_session_id,
            last_action="inference_preflight",
            progress_phase="ready",
            progress_detail=f"LM Studio inference verified in {time.monotonic() - started:.1f}s",
        )

    def ensure_lmstudio_ready_for_inference(self) -> str:
        """Use live LM Studio state and repair daemon/server/model drift before inference."""
        previous = self.lmstudio_state()
        snapshot = self.probe_lmstudio()
        if not snapshot.get("installed"):
            self.report_ai_state(
                last_action="project_preflight",
                progress_phase="failed",
                progress_detail="lmstudio_not_installed",
            )
            raise RuntimeError("lmstudio_not_installed")

        if not snapshot.get("server_running"):
            self.report_ai_state(
                installed=True,
                server_running=False,
                last_action="project_preflight",
                progress_phase="server_recovery",
                progress_detail="LM Studio server is down; restarting daemon and server",
            )
            self.run_lms(["daemon", "up"], timeout=120)
            self.run_lms(["server", "start", "--port", "1234"], timeout=120)
            snapshot = self.probe_lmstudio()
            if not snapshot.get("server_running"):
                self.report_ai_state(
                    installed=True,
                    server_running=False,
                    last_action="project_preflight",
                    progress_phase="failed",
                    progress_detail="lmstudio_server_not_running",
                )
                raise RuntimeError("lmstudio_server_not_running")

        model = str(snapshot.get("loaded_model") or "").strip()
        if not model:
            selected = str(
                snapshot.get("selected_model")
                or previous.get("selected_model")
                or ""
            ).strip()
            if selected and LMSTUDIO_MODEL_RE.fullmatch(selected):
                self.report_ai_state(
                    installed=True,
                    server_running=True,
                    selected_model=selected,
                    last_action="project_preflight",
                    progress_phase="model_recovery",
                    progress_detail=f"Reloading selected model: {selected}",
                )
                try:
                    self.load_lmstudio_model({
                        "model": selected,
                        "source": "catalog",
                        "settings": {},
                    })
                except Exception as error:
                    self.report_ai_state(
                        installed=True,
                        server_running=True,
                        selected_model=selected,
                        loaded_model=None,
                        last_action="project_preflight",
                        progress_phase="failed",
                        progress_detail=local_error_code(error),
                    )
                    raise RuntimeError("lmstudio_model_not_loaded") from error
                snapshot = self.probe_lmstudio()
                model = str(snapshot.get("loaded_model") or "").strip()

        if not model or not LMSTUDIO_MODEL_RE.fullmatch(model):
            self.report_ai_state(
                installed=True,
                server_running=True,
                last_action="project_preflight",
                progress_phase="failed",
                progress_detail="lmstudio_model_not_loaded",
            )
            raise RuntimeError("lmstudio_model_not_loaded")

        self.verify_lmstudio_inference(model)
        self.report_ai_state(
            installed=True,
            server_running=True,
            loaded_model=model,
            inference_ready=True,
            last_action="project_preflight",
            progress_phase="ready",
            progress_detail=f"LM Studio inference-ready: {model}",
        )
        return model

    def execute_project_text(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.long_operation():
            return self._execute_project_text(payload)

    def _execute_project_text(self, payload: dict[str, Any]) -> dict[str, Any]:
        task_text = str(payload.get("task_text") or "").strip()
        role_name = str(payload.get("role_name") or "planner").strip()
        project_id = str(payload.get("project_id") or "").strip()
        work_item_id = str(payload.get("work_item_id") or "").strip()
        if not task_text or len(task_text) > 20000:
            raise RuntimeError("invalid project task")
        if not role_name or len(role_name) > 64:
            raise RuntimeError("invalid project role")

        model = self.ensure_lmstudio_ready_for_inference()

        desired = 1 + int(len(task_text) > 800) + int(len(task_text) > 1800)
        ram_gib = float(psutil.virtual_memory().total) / float(1024 ** 3)
        capacity = 1 if ram_gib < 12 else (2 if ram_gib < 24 else 3)
        mini_count = max(1, min(3, desired, capacity))
        focuses = [
            "primary analysis and direct solution",
            "independent verification, contradictions and unsupported claims",
            "edge cases, risks, missing assumptions and practical improvements",
        ]
        mini_agents: list[dict[str, Any]] = []
        failures: list[dict[str, str]] = []
        token_usage: dict[str, Any] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "measured_calls": 0, "unmeasured_calls": 0, "agents": {}}
        def record_usage(agent_id: str, usage: dict[str, int] | None) -> None:
            token_usage["agents"][agent_id] = usage
            if usage is None:
                token_usage["unmeasured_calls"] += 1
            else:
                token_usage["measured_calls"] += 1
                for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
                    token_usage[key] += usage[key]
        base_guard = (
            "Work only on the supplied text task. Return useful factual plain text. "
            "Do not execute commands, access credentials, modify the host, or claim actions you did not perform. "
        )
        for index in range(mini_count):
            self.report_ai_state(last_action="project_text", progress_phase="mini_agent_running",
                                 progress_current=index, progress_total=mini_count + int(mini_count > 1),
                                 progress_detail=f"Mini-agent {index + 1}/{mini_count} · {role_name}")
            system_prompt = (
                "You are CITADEL local mini-agent "
                + str(index + 1)
                + " for project role: "
                + role_name
                + ". Focus on "
                + focuses[index]
                + ". "
                + base_guard
            )
            try:
                answer, usage = self._project_llm_chat(
                    model,
                    system_prompt,
                    task_text,
                    max_tokens=1536,
                    temperature=0.2 + (0.05 * index),
                )
            except Exception as error:
                failures.append({"mini_agent_id": f"llm-mini-{index + 1}", "error_code": local_error_code(error)})
                if index == 0:
                    self.report_ai_state(progress_phase="failed", progress_detail=local_error_code(error))
                    raise
                continue
            record_usage(f"llm-mini-{index + 1}", usage)
            mini_agents.append({
                "mini_agent_id": f"llm-mini-{index + 1}",
                "focus": focuses[index],
                "content": answer[:12000],
            })

        if not mini_agents:
            raise RuntimeError("lmstudio_mini_agents_failed")

        if len(mini_agents) == 1:
            content = mini_agents[0]["content"]
        else:
            synthesis_parts = []
            for item in mini_agents:
                synthesis_parts.append(
                    "[" + item["mini_agent_id"] + " · " + item["focus"] + "]\n" +
                    str(item["content"])[:3500]
                )
            synthesis_prompt = (
                "ORIGINAL TASK\n" + task_text[:8000] +
                "\n\nINDEPENDENT MINI-AGENT RESULTS\n" +
                "\n\n".join(synthesis_parts)
            )
            try:
                self.report_ai_state(progress_phase="synthesis_running", progress_current=mini_count,
                                     progress_detail="Combining mini-agent answers")
                content, usage = self._project_llm_chat(
                    model,
                    (
                        "You are the CITADEL local synthesis agent for role: " + role_name + ". "
                        "Combine the independent results into one accurate answer. Resolve contradictions, "
                        "remove duplication, preserve useful caveats, and do not mention the internal mini-agent process. "
                        + base_guard
                    ),
                    synthesis_prompt,
                    max_tokens=3072,
                    temperature=0.15,
                )
                record_usage("synthesis", usage)
            except Exception as error:
                failures.append({"mini_agent_id": "synthesis", "error_code": local_error_code(error)})
                content = "\n\n".join(str(item["content"]) for item in mini_agents)

        if len(content) > 180000:
            content = content[:180000] + "\n\n[truncated]"
        token_usage["unmeasured_failed_calls"] = len(failures)
        self.report_ai_state(progress_phase="completed_partial" if failures else "completed",
                             progress_current=mini_count + int(mini_count > 1),
                             progress_detail=f"Completed {len(mini_agents)}/{mini_count} mini-agents")
        return {
            "project_id": project_id or None,
            "work_item_id": work_item_id or None,
            "role_name": role_name,
            "engine": "lmstudio",
            "model": model,
            "mini_agent_requested_count": mini_count,
            "mini_agent_count": len(mini_agents),
            "mini_agents": mini_agents,
            "mini_agent_failures": failures,
            "token_usage": token_usage,
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

    def _keep_assignment_live(self, stop_event: threading.Event) -> None:
        """Keep node liveness fresh while a long local assignment is executing."""
        interval = max(5.0, min(float(self.config.heartbeat_seconds), 30.0))
        while not stop_event.wait(interval):
            self.mark_local_progress()
            try:
                self.heartbeat(timeout_seconds=5.0)
            except Exception as error:
                self.log.write(
                    "assignment_heartbeat_failed",
                    error=str(error)[:300],
                )

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
        heartbeat_stop = threading.Event()
        heartbeat_thread = threading.Thread(
            target=self._keep_assignment_live,
            args=(heartbeat_stop,),
            name="citadel-assignment-heartbeat",
            daemon=True,
        )
        heartbeat_thread.start()
        started = time.monotonic()
        try:
            if is_project_python:
                report = self.execute_project_python(assignment.get("payload") or {})
            elif is_project_text:
                report = self.execute_project_text(assignment.get("payload") or {})
            else:
                report = handler(assignment.get("payload") or {})
                if mission_type == "system_inventory" and isinstance(report, dict):
                    report["network_doctor"] = network_doctor_snapshot(self.config.controller_url)
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
                "report": {"error_type": type(error).__name__, "error_code": local_error_code(error)},
            }
        finally:
            heartbeat_stop.set()
            heartbeat_thread.join(timeout=6.0)
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
        elif command_type == "ssh_console":
            if not self.validate_ssh_console_payload(payload):
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
    def validate_ssh_console_payload(payload: dict[str, Any]) -> bool:
        if set(payload) != {"command"}:
            return False
        command = payload.get("command")
        return isinstance(command, str) and command in SSH_INLINE_COMMANDS

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
            or not re.fullmatch(r"/citadel-AI-EWS/EWS/(?:main|[a-f0-9]{40})/agent/lmstudio/" + re.escape(name), parsed.path)
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(char not in "0123456789abcdef" for char in digest)
        ):
            return False
        expected = "install_llmstudio_headless.ps1" if os.name == "nt" else "install_llmstudio_headless.sh"
        return name == expected

    @staticmethod
    def validate_lmstudio_model_payload(payload: dict[str, Any]) -> bool:
        model = payload.get("model")
        return isinstance(model, str) and bool(LMSTUDIO_MODEL_RE.fullmatch(model))

    def lmstudio_state(self) -> dict[str, Any]:
        state = load_json(self.lmstudio_state_path, {}) or {}
        return state if isinstance(state, dict) else {}

    def save_lmstudio_state(self, **updates: Any) -> None:
        with self._state_lock:
            state = self.lmstudio_state()
            state.update(updates)
            state["updated_at"] = now_iso()
            atomic_write(self.lmstudio_state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")

    def raise_if_stopping(self) -> None:
        if self._operation_cancel_requested.is_set():
            raise OperationCancelled("operation_cancelled")
        if self.lifecycle_stop_requested() or self.stop_path.exists():
            raise SystemExit(0)

    def command_cancel_requested(self, command_id: str) -> bool:
        node_id = self.require_node_id()
        quoted = urllib.parse.quote(command_id, safe="")
        try:
            response = self.api.request(
                "GET",
                f"/api/v1/nodes/{node_id}/commands/{quoted}/cancel-state",
                timeout_seconds=min(5.0, float(self.config.request_timeout_seconds)),
            )
        except Exception as error:
            self.log.write(
                "operation_cancel_check_failed",
                command_id=command_id,
                error=local_error_code(error),
            )
            return False
        return bool(response.get("cancel_requested"))

    def interrupt_active_lm_connection(self) -> None:
        connection = self._active_lm_connection
        if not connection:
            return
        sock = getattr(connection, "sock", None)
        if sock:
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
        with contextlib.suppress(OSError):
            connection.close()

    @contextlib.contextmanager
    def lm_connection_deadline(self, connection: http.client.HTTPConnection, timeout_seconds: float):
        """Interrupt a local LM HTTP connection at an absolute wall-clock deadline."""
        expired = threading.Event()
        seconds = max(0.1, float(timeout_seconds))

        def expire() -> None:
            expired.set()
            sock = getattr(connection, "sock", None)
            if sock:
                with contextlib.suppress(OSError):
                    sock.shutdown(socket.SHUT_RDWR)
            with contextlib.suppress(OSError):
                connection.close()

        timer = threading.Timer(seconds, expire)
        timer.daemon = True
        timer.start()
        try:
            yield expired
        finally:
            timer.cancel()

    @contextlib.contextmanager
    def long_operation(self, command_id: str | None = None, *, cancellable: bool = False):
        """Maintain liveness and optionally watch a Controller cancellation request."""
        if self._operation_depth:
            yield
            return
        self._operation_cancel_requested.clear()
        self.raise_if_stopping()
        self._operation_depth += 1
        finished = threading.Event()
        if command_id:
            self.report_ai_state(operation_id=command_id, progress_current=0, progress_total=None,
                                 progress_bytes=None, progress_total_bytes=None,
                                 progress_phase="waiting_agent",
                                 progress_detail="Command accepted by the agent")

        def keepalive():
            heartbeat_period = max(0.01, float(self.config.heartbeat_seconds))
            local_tick = min(1.0, max(0.01, heartbeat_period / 4.0))
            next_heartbeat = 0.0
            next_cancel_check = 0.0
            while not finished.is_set():
                self.mark_local_progress()
                try:
                    if self.lifecycle_stop_requested() or self.stop_path.exists():
                        self.interrupt_active_lm_connection()
                        return
                    now = time.monotonic()
                    if cancellable and command_id and now >= next_cancel_check:
                        if self.command_cancel_requested(command_id):
                            self._operation_cancel_requested.set()
                            self.interrupt_active_lm_connection()
                            return
                        next_cancel_check = now + 2.0
                    if now >= next_heartbeat:
                        self.heartbeat()
                        if command_id:
                            self.report_ai_state()
                        next_heartbeat = now + heartbeat_period
                except Exception as error:
                    self.log.write("operation_heartbeat_failed", error=local_error_code(error))
                finished.wait(local_tick)

        thread = None
        if self.identity.node_id:
            thread = threading.Thread(target=keepalive, name="citadel-operation-heartbeat", daemon=True)
            thread.start()
        try:
            yield
        except OperationCancelled:
            self.report_ai_state(progress_phase="cancelled",
                                 progress_detail="Query stopped by Architect")
            raise
        except SystemExit:
            self.report_ai_state(progress_phase="cancelled",
                                 progress_detail="Operation stopped locally")
            raise
        except Exception as error:
            self.report_ai_state(progress_phase="failed", progress_detail=local_error_code(error))
            raise
        finally:
            finished.set()
            self.interrupt_active_lm_connection()
            if thread:
                thread.join(timeout=self.config.request_timeout_seconds + 1)
            self._operation_cancel_requested.clear()
            self._operation_depth -= 1

    def report_ai_state(self, force: bool = False, **updates: Any) -> None:
        self.save_lmstudio_state(**updates)
        if not self.identity.node_id:
            return
        body = self.ai_report_body()
        if not force and not self.ai_report_due(body):
            return
        try:
            self.api.request(
                "POST",
                f"/api/v1/nodes/{self.require_node_id()}/ai-state",
                body,
            )
            self.ai_report_succeeded(body)
        except Exception as error:
            self.log.write("lmstudio_state_report_failed", error=str(error)[:300])

    def ai_report_body(self) -> dict[str, Any]:
        state = self.lmstudio_state()
        allowed = {
            "installed", "selected_model", "loaded_model", "server_running", "last_action",
            "progress_phase", "progress_current", "progress_total", "progress_bytes",
            "progress_total_bytes", "progress_detail", "download_job_id",
            "query_id", "query_mode", "query_status", "query_prompt", "query_answer",
            "load_config", "operation_id", "live_checked_at",
            "inference_ready", "inference_model", "inference_checked_at", "inference_error",
        }
        return {key: state.get(key) for key in allowed if key in state}

    @staticmethod
    def ai_fingerprint(body: dict[str, Any]) -> str:
        # Probe timestamps change every cycle; operational state does not.
        return json.dumps({key: value for key, value in body.items() if key != "live_checked_at"},
                          ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    def ai_report_due(self, body: dict[str, Any]) -> bool:
        # Accepted long commands need runtime freshness inside the Controller's
        # two-minute lease. Idle snapshots can wait five minutes.
        interval = 60 if self._operation_depth else 300
        return (self.ai_fingerprint(body) != self.last_ai_fingerprint
                or time.monotonic() - self.last_ai_report >= interval)

    def ai_report_succeeded(self, body: dict[str, Any]) -> None:
        self.last_ai_fingerprint = self.ai_fingerprint(body)
        self.last_ai_report = time.monotonic()

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

    def lmstudio_process_env(self, *, managed_windows_profile: bool = True) -> dict[str, str]:
        env = os.environ.copy()
        runtime_home = str(self.lmstudio_runtime_home())
        env["CITADEL_LMSTUDIO_HOME"] = runtime_home
        env["HOME"] = runtime_home
        env["LMS_NO_MODIFY_PATH"] = "1"
        if os.name == "nt" and managed_windows_profile:
            # Node.js uses USERPROFILE rather than HOME on Windows. Keep the
            # official bootstrap and subsequent CLI in the same managed profile.
            env["USERPROFILE"] = runtime_home
            for key, suffix in (("LOCALAPPDATA", "Local"), ("APPDATA", "Roaming")):
                directory = Path(runtime_home) / "AppData" / suffix
                directory.mkdir(parents=True, exist_ok=True)
                env[key] = str(directory)
        return env

    def run_lms(self, args: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
        self.raise_if_stopping()
        executable = self.find_lms()
        if not executable:
            raise RuntimeError("lmstudio_not_installed")
        argv = [executable, *args]
        process = _citadel_subprocess_popen(  # nosec B603
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
            stdin=subprocess.DEVNULL,
            env=self.lmstudio_process_env(managed_windows_profile=Path(executable).resolve().is_relative_to(self.lmstudio_runtime_home())),
        )
        deadline = time.monotonic() + timeout
        try:
            while True:
                self.raise_if_stopping()
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                try:
                    stdout, stderr = process.communicate(timeout=min(0.25, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
            result = subprocess.CompletedProcess(argv, process.returncode, stdout, stderr)
        except BaseException:
            # lms.cmd can own a Node.js child on Windows. Stop this command's
            # process tree and reap it before propagating STOP/cancel/timeout.
            children = []
            with contextlib.suppress(psutil.Error):
                children = psutil.Process(process.pid).children(recursive=True)
            for child in reversed(children):
                with contextlib.suppress(psutil.Error):
                    child.kill()
            with contextlib.suppress(OSError):
                process.kill()
            psutil.wait_procs(children, timeout=5)
            with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                process.wait(timeout=5)
            raise
        finally:
            for stream in (process.stdout, process.stderr):
                if stream:
                    with contextlib.suppress(OSError):
                        stream.close()
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
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
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
                if not 200 <= response.status < 300:
                    raise LmStudioApiError(response.status) from exc
                raise RuntimeError("lmstudio_invalid_json") from exc
            if not 200 <= response.status < 300:
                detail = value.get("error") if isinstance(value, dict) else None
                raise LmStudioApiError(response.status, detail)
            return value if isinstance(value, dict) else {"items": value}
        finally:
            connection.close()

    @staticmethod
    def _loaded_model_name(item: Any) -> str | None:
        if not isinstance(item, dict):
            return None
        for key in ("identifier", "modelKey", "model_key", "key", "model", "path", "name", "id"):
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
                    loaded = self.run_lms(["ps", "--json"], timeout=20)
                    decoded = json.loads(loaded.stdout or "[]")
                    rows = decoded if isinstance(decoded, list) else decoded.get("models", []) if isinstance(decoded, dict) else []
                    for item in rows:
                        if isinstance(item, dict) and item.get("type") in {"embedding", "embeddings"}:
                            continue
                        name = self._loaded_model_name(item)
                        if name and name not in loaded_models:
                            loaded_models.append(name)
                except Exception:
                    loaded_models = []
        selected_model = str(state.get("selected_model") or "").strip()
        loaded_model = (
            selected_model
            if selected_model and selected_model in loaded_models
            else loaded_models[0] if loaded_models else None
        )
        prior_inference_model = str(state.get("inference_model") or "").strip()
        same_inference_model = bool(loaded_model and prior_inference_model == loaded_model)
        proof_fresh = False
        checked_at = state.get("inference_checked_at")
        if isinstance(checked_at, str) and checked_at:
            try:
                checked = dt.datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
                if checked.tzinfo is None:
                    checked = checked.replace(tzinfo=dt.timezone.utc)
                proof_age = (
                    dt.datetime.now(dt.timezone.utc) - checked.astimezone(dt.timezone.utc)
                ).total_seconds()
                proof_fresh = 0 <= proof_age <= LMSTUDIO_INFERENCE_PROOF_TTL_SECONDS
            except (TypeError, ValueError):
                proof_fresh = False
        inference_ready = bool(
            state.get("inference_ready") and server_running and same_inference_model
            and state.get("inference_session_id") == self.runtime_session_id
            and proof_fresh
        )
        snapshot = {
            "installed": installed,
            "selected_model": state.get("selected_model"),
            "loaded_model": loaded_model,
            "server_running": server_running,
            "inference_ready": inference_ready,
            "inference_model": prior_inference_model if same_inference_model else None,
            # Preserve failed-proof evidence while the same model remains loaded.
            "inference_checked_at": state.get("inference_checked_at") if same_inference_model else None,
            "inference_error": state.get("inference_error") if same_inference_model else None,
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
            inference_ready=inference_ready,
            inference_model=snapshot["inference_model"],
            inference_checked_at=snapshot["inference_checked_at"],
            inference_error=snapshot["inference_error"],
            inference_session_id=(
                state.get("inference_session_id") if same_inference_model else None
            ),
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
            or not re.fullmatch(r"/citadel-AI-EWS/EWS/(?:main|[a-f0-9]{40})/agent/lmstudio/" + re.escape(name), parsed.path)
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
            result = _citadel_subprocess_run(  # nosec B603
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
            self.run_lms(["server", "start", "--port", "1234"], timeout=120)
            self.report_ai_state(
                installed=True, server_running=True, last_action="installed",
                progress_phase="complete", progress_current=5, progress_total=5,
                progress_detail="LM Studio server running on localhost:1234",
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
        if os.name == "nt":
            candidates.extend((home / "AppData" / "Local" / "lm-studio").resolve()
                              for home in (runtime_home, legacy_home))
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
        managed_home = self.lmstudio_runtime_home()
        roots = []
        for root in self.lmstudio_managed_roots():
            try:
                root.relative_to(managed_home)
                roots.append(root)
            except ValueError:
                continue
        executable = self.find_lms()
        if executable and not any(Path(executable).resolve().is_relative_to(root) for root in roots):
            raise RuntimeError("lmstudio_external_runtime_not_managed")
        if executable:
            for args in (["unload", "--all"], ["server", "stop"], ["daemon", "down"]):
                try:
                    self.run_lms(args, timeout=120)
                except Exception as error:
                    self.log.write(
                        "lmstudio_uninstall_stop_warning",
                        argv=args[:2],
                        error=str(error)[:200],
                    )
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
            for pointer_home in (self.lmstudio_runtime_home(),):
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

    @staticmethod
    def lmstudio_cli_model_rows(raw: str) -> list[dict[str, Any]]:
        decoded = json.loads(raw or "[]")
        rows = decoded if isinstance(decoded, list) else decoded.get("models", []) if isinstance(decoded, dict) else []
        return [item for item in rows if isinstance(item, dict)]

    @staticmethod
    def lmstudio_quantization_matches(item: dict[str, Any], quantization: str) -> bool:
        # Parent rows can advertise many variants. Only the concrete row's
        # key/path/quantization (not its variants list) proves the chosen format.
        values = [item.get(key) for key in ("modelKey", "model_key", "key", "path", "quantization", "selectedVariant")]
        encoded = json.dumps(values, ensure_ascii=False).lower().replace("-", "_")
        quant = quantization.lower().replace("-", "_")
        return re.search(r"(?<![a-z0-9])" + re.escape(quant) + r"(?![a-z0-9])", encoded) is not None

    def resolve_lmstudio_model_key(self, model: str, quantization: str | None = None) -> str:
        try:
            result = self.run_lms(["ls", "--json"], timeout=30)
            rows = self.lmstudio_cli_model_rows(result.stdout)
            needle = model.lower()
            for item in rows:
                encoded = json.dumps(item, ensure_ascii=False).lower()
                if needle not in encoded and needle.split("/")[-1] not in encoded:
                    continue
                candidate = str(item.get("modelKey") or item.get("path") or self._loaded_model_name(item) or "")
                if not candidate:
                    continue
                if quantization and item.get("variants"):
                    variants = self.run_lms(["ls", candidate, "--json"], timeout=30)
                    for variant in self.lmstudio_cli_model_rows(variants.stdout):
                        if self.lmstudio_quantization_matches(variant, quantization):
                            key = variant.get("modelKey") or variant.get("path") or self._loaded_model_name(variant)
                            if key:
                                return str(key)
                    continue
                if not quantization or self.lmstudio_quantization_matches(item, quantization):
                    return candidate
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
        try:
            job = self.lmstudio_http_json("POST", "/api/v1/models/download", body, timeout=120)
        except LmStudioApiError as error:
            if error.status_code != 404:
                raise
            # LM Studio 0.3 has no native v1 model-management API. The
            # official noninteractive CLI remains available on these installs.
            target = request_model + ("@" + quantization.lower() if quantization else "")
            self.raise_if_stopping()
            self.run_lms(["get", target, "--yes"], timeout=3600)
            self.raise_if_stopping()
            job = {"status": "completed"}
        status = str(job.get("status") or "")
        job_id = job.get("job_id")
        if status not in {"already_downloaded", "completed"}:
            if not isinstance(job_id, str) or not job_id:
                raise RuntimeError("lmstudio_download_job_missing")
            deadline = time.monotonic() + 3600
            while True:
                self.raise_if_stopping()
                if time.monotonic() >= deadline:
                    raise RuntimeError("lmstudio_download_timeout")
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
                self.interruptible_sleep(2)
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
        try:
            loaded = self.lmstudio_http_json("POST", "/api/v1/models/load", body, timeout=1800)
        except LmStudioApiError as error:
            if error.status_code != 404:
                raise
            unsupported = set(settings) - {"context_length"}
            if unsupported:
                raise RuntimeError("lmstudio_legacy_load_settings_unsupported") from error
            argv = ["load", model_key, "--identifier", model, "--yes"]
            if "context_length" in settings:
                argv.extend(["--context-length", str(settings["context_length"])])
            self.raise_if_stopping()
            self.run_lms(argv, timeout=1800)
            self.raise_if_stopping()
            snapshot = self.probe_lmstudio()
            if model not in snapshot.get("loaded_models", []):
                raise RuntimeError("lmstudio_model_not_loaded")
            if quantization:
                inventory = self.run_lms(["ps", "--json"], timeout=20)
                exact = any(
                    item.get("identifier") == model and
                    model_key in [item.get(key) for key in ("modelKey", "model_key", "path", "selectedVariant")] and
                    self.lmstudio_quantization_matches(item, quantization)
                    for item in self.lmstudio_cli_model_rows(inventory.stdout)
                )
                if not exact:
                    raise RuntimeError("lmstudio_loaded_variant_mismatch")
            loaded = {"status": "loaded", "instance_id": model, "load_config": settings}
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
        model = self.ensure_lmstudio_ready_for_inference()
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
        connection = http.client.HTTPConnection(
            "127.0.0.1", 1234, timeout=LMSTUDIO_QUERY_TIMEOUT_SECONDS
        )
        answer = ""
        completed = False
        self._active_lm_connection = connection
        last_report = 0.0
        deadline = time.monotonic() + LMSTUDIO_QUERY_TIMEOUT_SECONDS
        with self.lm_connection_deadline(
            connection, LMSTUDIO_QUERY_TIMEOUT_SECONDS
        ) as deadline_expired:
            try:
                connection.request(
                    "POST",
                    "/api/v1/chat",
                    body=json_text(body).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "Accept": "text/event-stream",
                        "User-Agent": USER_AGENT,
                    },
                )
                response = connection.getresponse()
                legacy_stream = response.status == 404
                if legacy_stream:
                    if "context_length" in settings or settings.get("reasoning") not in {None, "off"}:
                        raise RuntimeError("lmstudio_legacy_query_settings_unsupported")
                    # The native chat route starts with LM Studio 0.4. Retry
                    # only a missing route, before any generation has started.
                    response.close()
                    connection.close()
                    messages = []
                    if body.get("system_prompt"):
                        messages.append({"role": "system", "content": body["system_prompt"]})
                    messages.append({"role": "user", "content": prompt})
                    compatible = {key: value for key, value in settings.items()
                                  if key in {"temperature", "top_p", "top_k", "min_p", "repeat_penalty"}}
                    if "max_output_tokens" in settings:
                        compatible["max_tokens"] = settings["max_output_tokens"]
                    connection.request(
                        "POST", "/v1/chat/completions",
                        body=json_text({"model": model, "messages": messages,
                                        "stream": True, **compatible}).encode("utf-8"),
                        headers={"Content-Type": "application/json", "Accept": "text/event-stream", "User-Agent": USER_AGENT},
                    )
                    response = connection.getresponse()
                if response.status != 200:
                    raw = response.read(4096).decode("utf-8", errors="replace")
                    raise RuntimeError(f"lmstudio_http_{response.status}:{raw[:300]}")
                event_type = ""
                while True:
                    self.raise_if_stopping()
                    if time.monotonic() >= deadline:
                        raise RuntimeError("lmstudio_query_timeout")
                    raw_line = response.readline(262145)
                    if len(raw_line) > 262144:
                        raise RuntimeError("lmstudio_event_too_large")
                    if not raw_line:
                        break
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                    if line.startswith("event:"):
                        event_type = line[6:].strip()
                        continue
                    if not line.startswith("data:"):
                        continue
                    encoded_event = line[5:].strip()
                    if legacy_stream and encoded_event == "[DONE]":
                        completed = True
                        break
                    try:
                        event = json.loads(encoded_event)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        raise RuntimeError("lmstudio_invalid_event")
                    kind = str(event.get("type") or event_type)
                    if legacy_stream and event.get("error"):
                        raise RuntimeError("lmstudio_chat_error:" + str(event["error"])[:300])
                    content = None
                    if legacy_stream:
                        choices = event.get("choices")
                        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                            delta = choices[0].get("delta")
                            if isinstance(delta, dict):
                                content = delta.get("content")
                    elif kind == "message.delta":
                        content = event.get("content")
                    if legacy_stream or kind == "message.delta":
                        if isinstance(content, str):
                            answer += content
                            if len(answer) > 64000:
                                raise RuntimeError("lmstudio_response_too_large")
                            now = time.monotonic()
                            if now - last_report >= 0.8:
                                self.report_ai_state(
                                    query_id=request_id,
                                    query_status="running",
                                    query_answer=answer,
                                    last_action="hybrid_query",
                                )
                                last_report = now
                    elif kind == "chat.end":
                        completed = True
                        break
                    elif kind == "error":
                        error = event.get("error")
                        raise RuntimeError("lmstudio_chat_error:" + str(error)[:300])
            except Exception as error:
                if self._operation_cancel_requested.is_set():
                    raise OperationCancelled("operation_cancelled")
                if deadline_expired.is_set():
                    raise RuntimeError("lmstudio_query_timeout") from error
                raise
            finally:
                self._active_lm_connection = None
                connection.close()
        if deadline_expired.is_set():
            raise RuntimeError("lmstudio_query_timeout")
        self.raise_if_stopping()
        if not completed:
            raise RuntimeError("lmstudio_stream_incomplete")
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
        try:
            python_answer = self.python_mode_answer(prompt) if mode in {"python", "both"} else None
            if mode == "python":
                answer = python_answer or ""
            else:
                answer = self.stream_lmstudio_answer(
                    prompt, settings, request_id,
                    python_context=python_answer if mode == "both" else None,
                )
        except OperationCancelled:
            partial = str(self.lmstudio_state().get("query_answer") or "")
            self.report_ai_state(
                query_id=request_id, query_status="cancelled", query_answer=partial,
                progress_phase="cancelled", progress_detail="Query stopped by Architect",
            )
            raise
        except SystemExit:
            self.report_ai_state(
                query_id=request_id, query_status="cancelled",
                progress_phase="cancelled", progress_detail="Operation stopped locally",
            )
            raise
        except Exception as error:
            self.report_ai_state(
                query_id=request_id, query_status="failed",
                progress_phase="failed", progress_detail=local_error_code(error),
            )
            raise
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
            for name in CORE_UPDATE_FILE_NAMES:
                companion = staging / name
                if not companion.exists() and (install_root / name).is_file():
                    shutil.copy2(install_root / name, companion)
            entrypoint = staging / "citadel_node_v2.py"
            if entrypoint.exists():
                # The argv is fixed and the shell remains disabled.
                result = _citadel_subprocess_run(  # nosec B603
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
            if CORE_UPDATE_FILE_NAMES.intersection(replaced):
                installed_entrypoint = install_root / "citadel_node_v2.py"
                result = _citadel_subprocess_run(  # nosec B603
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
            result = _citadel_subprocess_run(  # nosec B603
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

        result = _citadel_subprocess_run(  # nosec B603
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

    def execute_ssh_console_command(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.validate_ssh_console_payload(payload):
            raise RuntimeError("invalid restricted SSH console payload")
        console_path = _ensure_ssh_restricted_console_file()
        if hashlib.sha256(console_path.read_bytes()).hexdigest() != SSH_RESTRICTED_CONSOLE_SHA256:
            raise RuntimeError("restricted SSH console integrity mismatch")
        spec = importlib.util.spec_from_file_location(
            "citadel_restricted_ssh_console_runtime",
            console_path,
        )
        if spec is None or spec.loader is None:
            raise RuntimeError("restricted SSH console loader unavailable")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        execute = getattr(module, "execute", None)
        if not callable(execute):
            raise RuntimeError("restricted SSH console execute function missing")
        output, _ = execute(payload["command"], self.config_path)
        text = str(output or "")
        encoded = text.encode("utf-8")
        if len(encoded) > SSH_INLINE_OUTPUT_MAX_BYTES:
            suffix = "\n...[truncated]"
            budget = max(0, SSH_INLINE_OUTPUT_MAX_BYTES - len(suffix.encode("utf-8")))
            text = encoded[:budget].decode("utf-8", errors="ignore") + suffix
        return {"output": text, "exit_code": 0}

    def ack_command(
        self,
        command_id: str,
        status: str,
        result: dict[str, Any] | None = None,
    ) -> None:
        node_id = self.require_node_id()
        quoted = urllib.parse.quote(command_id, safe="")
        body: dict[str, Any] = {"status": status}
        if result is not None:
            body["result"] = result
        self.api.request(
            "POST",
            f"/api/v1/nodes/{node_id}/commands/{quoted}/ack",
            body,
        )

    def handle_commands(self, response: dict[str, Any] | None = None) -> None:
        node_id = self.require_node_id()
        if response is None:
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
                    with self.long_operation(command_id):
                        self.install_lmstudio(command.get("payload") or {})
                elif command_type == "lmstudio_uninstall":
                    with self.long_operation(command_id):
                        self.uninstall_lmstudio(command.get("payload") or {})
                elif command_type == "lmstudio_probe":
                    snapshot = self.probe_lmstudio()
                    self.report_ai_state(**{key: value for key, value in snapshot.items() if key != "loaded_models"})
                elif command_type == "lmstudio_model_get":
                    with self.long_operation(command_id):
                        self.download_lmstudio_model(command.get("payload") or {})
                elif command_type == "lmstudio_model_load":
                    with self.long_operation(command_id):
                        self.load_lmstudio_model(command.get("payload") or {})
                elif command_type == "hybrid_query":
                    with self.long_operation(command_id, cancellable=True):
                        self.run_hybrid_query(command.get("payload") or {})
                elif command_type == "ssh_probe":
                    self.last_ssh_report = 0.0
                    self.heartbeat(timeout_seconds=5.0)
                elif command_type == "ssh_console":
                    ssh_result = self.execute_ssh_console_command(command.get("payload") or {})
                    self.ack_command(command_id, "completed", ssh_result)
                    self.log.write(
                        "ssh_console_command_completed",
                        command_id=command_id,
                        command=str((command.get("payload") or {}).get("command") or ""),
                    )
                    continue
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
                    supervised = service_managed or os.environ.get("CITADEL_SUPERVISED") == "1" or bool(os.environ.get("INVOCATION_ID"))
                    if supervised:
                        raise SystemExit(SERVICE_RESTART_EXIT_CODE)
                    entrypoint = Path(__file__).resolve().parent / "citadel_node_v2.py"
                    # The argv is fixed and the shell remains disabled.
                    _citadel_subprocess_popen(  # nosec B603
                        [sys.executable, str(entrypoint), "run", "--config", str(self.config_path)],
                        cwd=entrypoint.parent,
                        shell=False,
                        creationflags=(0x08000000 if os.name == "nt" else 0),
                    )
                    raise SystemExit(0)
            except OperationCancelled:
                try:
                    self.ack_command(command_id, "cancelled")
                except Exception as ack_error:
                    self.log.write(
                        "command_failure_ack_failed",
                        command_id=command_id,
                        error=str(ack_error)[:300],
                    )
                self.log.write("command_cancelled", command_id=command_id, command_type=command_type)
                continue
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
        if not self.config.prevent_automatic_sleep:
            return False
        if os.name != "nt":
            return self.enforce_linux_power_guard()
        if time.monotonic() - self.last_power_guard < 60 and self.power_guard_active:
            return True
        self.last_power_guard = time.monotonic()
        es_continuous = 0x80000000
        es_system_required = 0x00000001
        try:
            result = ctypes.windll.kernel32.SetThreadExecutionState(
                es_continuous | es_system_required
            )
        except (AttributeError, OSError):
            result = 0
        self.power_guard_active = bool(result)
        self.log.write(
            "windows_sleep_hibernate_inhibit",
            enabled=self.power_guard_active,
            mode="automatic_sleep_guard",
        )
        return self.power_guard_active

    def enforce_linux_power_guard(self) -> bool:
        if not sys.platform.startswith("linux"):
            return False
        process = self.power_guard_process
        if process is not None and process.poll() is None:
            self.power_guard_active = True
            return True
        self.clear_power_guard()
        now = time.monotonic()
        if self.power_guard_attempted and now - self.last_power_guard < 60:
            return False
        self.power_guard_attempted = True
        self.last_power_guard = now
        inhibitor = shutil.which("systemd-inhibit")
        try:
            if not inhibitor:
                raise OSError("systemd-inhibit unavailable")
            # The fixed child holds logind's inhibitor until this process closes
            # its pipe or exits. Its readiness byte confirms inhibitor acquisition.
            process = _citadel_subprocess_popen(
                [inhibitor, "--what=sleep:idle", "--mode=block", "--who=CITADEL",
                 "--why=CITADEL agent is running", sys.executable, "-c",
                 "import sys; sys.stdout.write('1'); sys.stdout.flush(); sys.stdin.buffer.read()"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                shell=False,
            )
            self.power_guard_process = process
            ready, _, _ = select.select([process.stdout], [], [], 3)
            if not ready or os.read(process.stdout.fileno(), 1) != b"1" or process.poll() is not None:
                raise OSError("sleep inhibitor did not become ready")
            self.power_guard_active = True
        except (OSError, ValueError):
            self.clear_power_guard()
        self.log.write("linux_sleep_hibernate_inhibit", enabled=self.power_guard_active)
        return self.power_guard_active

    def clear_power_guard(self) -> None:
        if os.name == "nt" and self.power_guard_active:
            with contextlib.suppress(Exception):
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
        self.power_guard_active = False
        process = self.power_guard_process
        self.power_guard_process = None
        if process is not None:
            if process.stdin:
                with contextlib.suppress(OSError):
                    process.stdin.close()
            if process.poll() is None:
                with contextlib.suppress(OSError):
                    process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    with contextlib.suppress(OSError):
                        process.kill()
                    with contextlib.suppress(subprocess.TimeoutExpired, OSError):
                        process.wait(timeout=3)
            if process.stdout:
                process.stdout.close()

    def mark_local_progress(self) -> None:
        if self.watchdog:
            self.watchdog.touch()

    def remember_network_profile(self) -> None:
        state = load_json(self.network_recovery_path, {}) or {}
        try:
            if os.name == "nt":
                powershell = shutil.which("powershell.exe") or shutil.which("powershell")
                if powershell:
                    script = (
                        "$profiles = Get-NetConnectionProfile | "
                        "Where-Object {$_.IPv4Connectivity -ne 'Disconnected'} | "
                        "ForEach-Object { "
                        "$adapter = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue; "
                        "$wireless = $false; "
                        "if ($adapter) { "
                        "$wireless = ($adapter.NdisPhysicalMedium -eq 9) -or "
                        "([string]$adapter.PhysicalMediaType -match '802\\.11|Wireless'); "
                        "}; "
                        "[PSCustomObject]@{Name=$_.Name;InterfaceAlias=$_.InterfaceAlias;"
                        "IPv4Connectivity=$_.IPv4Connectivity;IsWireless=$wireless} "
                        "}; "
                        "$profiles | ConvertTo-Json -Compress"
                    )
                    result = _citadel_subprocess_run(  # nosec B603
                        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                        timeout=20, capture_output=True, text=True, shell=False,
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        decoded = json.loads(result.stdout)
                        rows = decoded if isinstance(decoded, list) else [decoded]
                        names = [str(item.get("Name") or "").strip() for item in rows if isinstance(item, dict)]
                        names = [name for name in names if name]
                        active_wifi = next(
                            (
                                str(item.get("Name") or "").strip()
                                for item in rows
                                if isinstance(item, dict)
                                and item.get("IsWireless") is True
                                and str(item.get("Name") or "").strip()
                            ),
                            None,
                        )
                        remembered = list(state.get("windows_profiles") or [])
                        for name in [*names, *self.config.allowed_wifi_profiles]:
                            if name and name not in remembered:
                                remembered.append(name)
                        if remembered:
                            state["windows_profiles"] = remembered[:16]
                        if active_wifi:
                            state["last_windows_wifi_profile"] = active_wifi[:120]
            elif os.name == "posix":
                nmcli = shutil.which("nmcli")
                if nmcli:
                    result = _citadel_subprocess_run(  # nosec B603
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
                            state["last_linux_profile"] = profiles[0]["name"]
            state["remembered_at"] = now_iso()
            atomic_write(self.network_recovery_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        except Exception as error:
            self.log.write("network_profile_remember_failed", error=str(error)[:300])

    def _recover_windows_network(self, state: dict[str, Any], attempts: list[str]) -> bool:
        """Recover Controller connectivity by preferring the last active Windows Wi-Fi profile."""
        ipconfig = shutil.which("ipconfig.exe") or shutil.which("ipconfig")
        netsh = shutil.which("netsh.exe") or shutil.which("netsh")
        profiles: list[str] = []
        preferred = state.get("last_windows_wifi_profile")
        if isinstance(preferred, str):
            preferred = preferred.strip()
            if not preferred or len(preferred) > 120:
                preferred = None
        else:
            preferred = None
        for profile in [
            preferred,
            *(state.get("windows_profiles") or []),
            *self.config.allowed_wifi_profiles,
        ]:
            if isinstance(profile, str):
                name = profile.strip()
                if name and len(name) <= 120 and name not in profiles:
                    profiles.append(name)

        if netsh and preferred:
            for retry_index in range(NETWORK_PRIMARY_PROFILE_RETRIES):
                result = _citadel_subprocess_run(  # nosec B603
                    [netsh, "wlan", "connect", f"name={preferred}"],
                    timeout=30, capture_output=True, text=True, shell=False,
                )
                attempts.append(
                    f"wifi_primary_retry:{retry_index + 1}:" + preferred[:64]
                )
                if result.returncode == 0:
                    if ipconfig and retry_index == 0:
                        _citadel_subprocess_run(  # nosec B603
                            [ipconfig, "/renew"],
                            timeout=60, capture_output=True, text=True, shell=False,
                        )
                        attempts.append("dhcp_renew")
                    time.sleep(NETWORK_PRIMARY_RETRY_DELAYS[retry_index])
                    if self.controller_reachable():
                        state["last_windows_wifi_profile"] = preferred
                        return True

        if ipconfig and not preferred:
            _citadel_subprocess_run(  # nosec B603
                [ipconfig, "/renew"], timeout=60, capture_output=True, text=True, shell=False,
            )
            attempts.append("dhcp_renew")
            if self.controller_reachable():
                return True

        if netsh:
            for profile in profiles[:16]:
                if profile == preferred:
                    continue
                result = _citadel_subprocess_run(  # nosec B603
                    [netsh, "wlan", "connect", f"name={profile}"],
                    timeout=30, capture_output=True, text=True, shell=False,
                )
                attempts.append("wifi_fallback_profile:" + profile[:64])
                if result.returncode == 0:
                    time.sleep(3)
                    if self.controller_reachable():
                        state["last_windows_wifi_profile"] = profile
                        return True
        return False

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
                recovered = self._recover_windows_network(state, attempts)
            elif os.name == "posix":
                nmcli = shutil.which("nmcli")
                if nmcli:
                    _citadel_subprocess_run(  # nosec B603
                        [nmcli, "networking", "on"], timeout=20, capture_output=True, text=True, shell=False,
                    )
                    linux_profiles: list[str] = []
                    preferred = state.get("last_linux_profile")
                    if isinstance(preferred, str):
                        preferred = preferred.strip()
                        if not preferred or len(preferred) > 120:
                            preferred = None
                    else:
                        preferred = None
                    for item in state.get("linux_profiles") or []:
                        name = item.get("name") if isinstance(item, dict) else None
                        if isinstance(name, str):
                            name = name.strip()
                            if name and len(name) <= 120 and name not in linux_profiles:
                                linux_profiles.append(name)
                    if preferred and preferred not in linux_profiles:
                        linux_profiles.insert(0, preferred)

                    if preferred:
                        for retry_index in range(NETWORK_PRIMARY_PROFILE_RETRIES):
                            result = _citadel_subprocess_run(  # nosec B603
                                [nmcli, "connection", "up", preferred],
                                timeout=60, capture_output=True, text=True, shell=False,
                            )
                            attempts.append(
                                f"linux_primary_retry:{retry_index + 1}:" + preferred[:64]
                            )
                            if result.returncode == 0:
                                time.sleep(NETWORK_PRIMARY_RETRY_DELAYS[retry_index])
                                if self.controller_reachable():
                                    recovered = True
                                    state["last_linux_profile"] = preferred
                                    break

                    if not recovered:
                        for name in linux_profiles[:8]:
                            if name == preferred:
                                continue
                            result = _citadel_subprocess_run(  # nosec B603
                                [nmcli, "connection", "up", name],
                                timeout=60, capture_output=True, text=True, shell=False,
                            )
                            attempts.append("saved_connection:" + name[:64])
                            if result.returncode == 0:
                                time.sleep(3)
                                if self.controller_reachable():
                                    recovered = True
                                    state["last_linux_profile"] = name
                                    break
            if recovered:
                atomic_write(
                    self.network_recovery_path,
                    json.dumps(state, ensure_ascii=False, indent=2) + "\n",
                )
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
            if self.lifecycle_stop_requested() or self.stop_path.exists():
                raise SystemExit(0)
            self.mark_local_progress()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.5, remaining))

    def cycle(self) -> None:
        if self.lifecycle_stop_requested() or self.stop_path.exists():
            raise SystemExit(0)
        self.enforce_power_guard()
        self.enroll()
        if self.service_hold_requested():
            if time.monotonic() - self.last_heartbeat >= self.config.heartbeat_seconds:
                self.heartbeat()
                self.mark_service_ready()
            return
        sent = self.results.flush(self.submit_result)
        if sent:
            self.log.write("queued_results_flushed", count=sent)
        response = self.sync_cycle()
        if response is not None:
            poll_hint = response.get("idle_poll_seconds")
            if isinstance(poll_hint, int) and not isinstance(poll_hint, bool) and 5 <= poll_hint <= 300:
                self._controller_poll_seconds = poll_hint
            self.handle_commands(response)
            if not self.paused_path.exists() and response.get("node_status") != "paused":
                for assignment in response.get("assignments") or []:
                    self.execute_assignment(assignment)
            return
        self.handle_commands()
        if time.monotonic() - self.last_heartbeat >= self.config.heartbeat_seconds:
            self.heartbeat()
            self.sync_lmstudio_readiness()
        if self.paused_path.exists():
            return
        node_id = self.require_node_id()
        response = self.api.request("GET", f"/api/v1/nodes/{node_id}/assignments")
        for assignment in response.get("assignments") or []:
            self.execute_assignment(assignment)

    def sync_cycle(self) -> dict[str, Any] | None:
        now = time.monotonic()
        if now < self.sync_retry_at:
            return None
        body: dict[str, Any] = {"paused": self.paused_path.exists()}
        if now - self.last_heartbeat >= self.config.heartbeat_seconds:
            body["heartbeat"] = self.heartbeat_payload()
            try:
                self.refresh_lmstudio_readiness()
            except Exception as error:
                self.log.write("lmstudio_heartbeat_probe_failed", error=str(error)[:300])
        ai = self.ai_report_body()
        if self.ai_report_due(ai):
            body["ai"] = ai
        try:
            response = self.api.request("POST", f"/api/v1/nodes/{self.require_node_id()}/sync", body)
        except RuntimeError as error:
            # Only a missing route permits legacy fallback. Auth, quota and
            # transport failures must not multiply requests or bypass protection.
            if str(error).startswith("controller HTTP 404: "):
                self.sync_retry_at = time.monotonic() + 300
                return None
            raise
        if "heartbeat" in body:
            self.heartbeat_succeeded(body["heartbeat"])
        if "ai" in body:
            self.ai_report_succeeded(ai)
        return response

    def run(self, once: bool = False) -> int:
        self.log.write("agent_start", version=VERSION, once=once)
        if not once:
            self.enforce_power_guard()
        backoff = 2
        try:
            supervised = any(os.environ.get(flag) == "1" for flag in (
                "CITADEL_SERVICE_MANAGED", "CITADEL_TASK_MANAGED", "CITADEL_SUPERVISED"
            )) or bool(os.environ.get("INVOCATION_ID"))
            if not once and supervised:
                self.watchdog = LocalWatchdog()
                self.watchdog.start()
            while True:
                try:
                    self.mark_local_progress()
                    self.cycle()
                    self.mark_local_progress()
                    backoff = 2
                    if once:
                        return 0
                    self.interruptible_sleep(max(self.config.poll_seconds, getattr(self, "_controller_poll_seconds", 0)))
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
                    retry = error.retry_after_seconds if isinstance(error, ControllerApiError) else 0
                    self.interruptible_sleep(min(300, max(backoff, retry)))
                    backoff = min(60, backoff * 2)
        finally:
            if self.watchdog:
                self.watchdog.stop()
                self.watchdog = None
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
            {"system_reboot", "system_shutdown", "wake_peer", "lmstudio_install", "lmstudio_uninstall", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query", "ssh_probe", "ssh_console"}.issubset(SUPPORTED_COMMANDS),
            "restricted power/wake/LM Studio commands missing",
        )
        require_test(
            "shell" not in SUPPORTED_COMMANDS,
            "arbitrary shell command registered",
        )
        require_test(
            agent.validate_ssh_console_payload({"command": "status"})
            and agent.validate_ssh_console_payload({"command": "diagnostics"})
            and agent.validate_ssh_console_payload({"command": "whoami"})
            and agent.validate_ssh_console_payload({"command": "python3 --version"})
            and not agent.validate_ssh_console_payload({"command": "python3 -c pass"})
            and not agent.validate_ssh_console_payload({"command": "status", "extra": True}),
            "restricted Hub SSH command validation failed",
        )
        inline_ssh_result = agent.execute_ssh_console_command({"command": "help"})
        require_test(
            inline_ssh_result.get("exit_code") == 0
            and "Allowed commands:" in str(inline_ssh_result.get("output") or "")
            and len(str(inline_ssh_result.get("output") or "").encode("utf-8")) <= SSH_INLINE_OUTPUT_MAX_BYTES,
            "restricted Hub SSH command execution failed",
        )
        ssh_console = _ensure_ssh_restricted_console_file()
        require_test(
            ssh_console.is_file()
            and hashlib.sha256(ssh_console.read_bytes()).hexdigest() == SSH_RESTRICTED_CONSOLE_SHA256,
            "restricted SSH console materialization failed",
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
            set(network) == {"lan_ipv4", "private_ipv4", "mac_addresses", "interfaces"},
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
