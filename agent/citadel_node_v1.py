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
import contextlib
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
import shutil
import socket
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

VERSION = "0.3.12"
USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"
DEFAULT_CONTROLLER_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
SUPPORTED_COMMANDS = {"pause", "resume", "update", "restart", "stop", "rollback", "uninstall", "system_reboot", "system_shutdown", "wake_peer", "lmstudio_install", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query"}
UPDATE_FILE_NAMES = {"citadel_node_v1.py", "citadel_node_v2.py"}
UPDATE_MAX_FILE_BYTES = 2 * 1024 * 1024
COMMAND_MAX_AGE_SECONDS = 15 * 60
SERVICE_RESTART_EXIT_CODE = 75
SERVICE_STOP_EXIT_CODE = 76
LMSTUDIO_INSTALL_FILE_NAMES = {"install_llmstudio_headless.ps1", "install_llmstudio_headless.sh"}
LMSTUDIO_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}(?:/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?(?:@[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$")
LMSTUDIO_QUANT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
HYBRID_MODES = {"python", "lmstudio", "both"}
WINDOWS_DPAPI_PROTECTION = "windows-dpapi-local-machine-v1"
CRYPTPROTECT_UI_FORBIDDEN = 0x1
CRYPTPROTECT_LOCAL_MACHINE = 0x4


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

    @classmethod
    def from_file(cls, path: Path) -> "AgentConfig":
        raw = load_json(path, {}) or {}
        controller_url = str(raw.get("controller_url") or "").strip().rstrip("/")
        parsed = urllib.parse.urlsplit(controller_url)
        secure = parsed.scheme == "https" and bool(parsed.hostname)
        local_test = parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if not (secure or local_test):
            raise ValueError("controller_url must use HTTPS; loopback HTTP is test-only")
        return cls(
            controller_url=controller_url,
            data_dir=Path(raw.get("data_dir") or default_data_dir()).expanduser().resolve(),
            poll_seconds=max(5, int(raw.get("poll_seconds", 30))),
            heartbeat_seconds=max(10, int(raw.get("heartbeat_seconds", 30))),
            request_timeout_seconds=max(5, min(120, int(raw.get("request_timeout_seconds", 30)))),
            max_cpu_percent=max(10.0, min(100.0, float(raw.get("max_cpu_percent", 90)))),
            max_memory_percent=max(10.0, min(100.0, float(raw.get("max_memory_percent", 90)))),
            controller_public_x=str(raw.get("controller_public_x") or DEFAULT_CONTROLLER_PUBLIC_X),
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
        "cpu_logical_count": psutil.cpu_count(logical=True),
        "memory_total_bytes": int(memory.total),
        "disk_home_total_bytes": int(disk.total),
        "disk_home_free_bytes": int(disk.free),
        "network": local_network_addresses(),
    }


HANDLERS: dict[str, MissionHandler] = {"system_inventory": system_inventory}


class Agent:
    def __init__(self, config: AgentConfig, config_path: Path | None = None) -> None:
        self.config = config
        self.config_path = (config_path or Path("config.json")).resolve()
        config.data_dir.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            os.chmod(config.data_dir, 0o700)
        self.identity = Identity(config.data_dir / "identity.json")
        self.api = ApiClient(config, self.identity)
        self.log = JsonlLogger(config.data_dir / "agent.jsonl")
        self.results = ResultQueue(config.data_dir / "pending-results.json")
        self.stop_path = config.data_dir / "STOP"
        self.paused_path = config.data_dir / "PAUSED"
        self.lmstudio_state_path = config.data_dir / "lmstudio-state.json"
        self.network_recovery_path = config.data_dir / "network-recovery.json"
        self.last_network_recovery = 0.0
        self.last_network_remember = 0.0
        self.last_heartbeat = 0.0
        self.enrollment_confirmed = False

    @property
    def capabilities(self) -> list[str]:
        return sorted(set(HANDLERS) | {"lmstudio_remote", "project_text"})

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

    def execute_assignment(self, assignment: dict[str, Any]) -> None:
        node_id = self.require_node_id()
        assignment_id = str(assignment.get("assignment_id") or "")
        mission_type = str(assignment.get("mission_type") or "")
        handler = HANDLERS.get(mission_type)
        is_project_text = mission_type == "project_text"
        if not assignment_id or (handler is None and not is_project_text):
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
            report = (
                self.execute_project_text(assignment.get("payload") or {})
                if is_project_text
                else handler(assignment.get("payload") or {})
            )
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
        elif command_type in {"lmstudio_model_get", "lmstudio_model_load"}:
            if not self.validate_lmstudio_model_payload(payload):
                return False
        elif command_type == "hybrid_query":
            if not self.validate_hybrid_payload(payload):
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
        home = Path.home()
        if os.name == "nt":
            candidates.extend([
                str(home / ".lmstudio" / "bin" / "lms.exe"),
                str(home / ".lmstudio" / "bin" / "lms.cmd"),
            ])
        else:
            candidates.append(str(home / ".lmstudio" / "bin" / "lms"))
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return str(Path(candidate))
        return None

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
            result = subprocess.run(  # nosec B603
                argv,
                timeout=1800,
                capture_output=True,
                text=True,
                shell=False,
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
        stripped = prompt.strip()
        expression = stripped[5:].strip() if stripped.lower().startswith("calc:") else stripped
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
        inv = system_inventory({"task_text": prompt})
        return (
            "Python agent deterministic node context:\n"
            f"hostname={inv['hostname']}\n"
            f"platform={inv['platform']} {inv['platform_release']}\n"
            f"architecture={inv['architecture']}\n"
            f"cpu_logical_count={inv['cpu_logical_count']}\n"
            f"memory_total_bytes={inv['memory_total_bytes']}\n"
            f"disk_free_bytes={inv['disk_home_free_bytes']}\n"
            f"network={json_text(inv['network'])}"
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
                headers={"Content-Type": "application/json", "Accept": "text/event-stream", "User-Agent": USER_AGENT},
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
            for item in payload["files"]:
                data = self.download_update_file(item["url"])
                if hashlib.sha256(data).hexdigest() != item["sha256"]:
                    raise RuntimeError(f"update hash mismatch: {item['path']}")
                (staging / item["path"]).write_bytes(data)
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
            for item in payload["files"]:
                name = item["path"]
                current = install_root / name
                existed_before[name] = current.exists()
                if current.exists():
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
        missing = [name for name in UPDATE_FILE_NAMES if not (backup / name).is_file()]
        if missing:
            raise RuntimeError("complete update backup unavailable")
        staging = Path(tempfile.mkdtemp(prefix="citadel-rollback-", dir=self.config.data_dir))
        try:
            for name in sorted(UPDATE_FILE_NAMES):
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
            for name in sorted(UPDATE_FILE_NAMES):
                shutil.copy2(staging / name, install_root / name)
            self.log.write(
                "agent_update_manual_rollback",
                files=sorted(UPDATE_FILE_NAMES),
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
                elif command_type == "lmstudio_probe":
                    snapshot = self.probe_lmstudio()
                    self.report_ai_state(**{key: value for key, value in snapshot.items() if key != "loaded_models"})
                elif command_type == "lmstudio_model_get":
                    self.download_lmstudio_model(command.get("payload") or {})
                elif command_type == "lmstudio_model_load":
                    self.load_lmstudio_model(command.get("payload") or {})
                elif command_type == "hybrid_query":
                    self.run_hybrid_query(command.get("payload") or {})
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
                        if names:
                            state["windows_profiles"] = names[:8]
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
        now = time.monotonic()
        if now - self.last_network_recovery < 60:
            return
        self.last_network_recovery = now
        state = load_json(self.network_recovery_path, {}) or {}
        attempts: list[str] = []
        try:
            if os.name == "nt":
                ipconfig = shutil.which("ipconfig.exe") or shutil.which("ipconfig")
                if ipconfig:
                    subprocess.run(  # nosec B603
                        [ipconfig, "/renew"], timeout=60, capture_output=True, text=True, shell=False,
                    )
                    attempts.append("dhcp_renew")
                netsh = shutil.which("netsh.exe") or shutil.which("netsh")
                if netsh:
                    for profile in state.get("windows_profiles") or []:
                        if not isinstance(profile, str) or not profile or len(profile) > 120:
                            continue
                        subprocess.run(  # nosec B603
                            [netsh, "wlan", "connect", f"name={profile}"],
                            timeout=30, capture_output=True, text=True, shell=False,
                        )
                        attempts.append("wifi_saved_profile")
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
                            subprocess.run(  # nosec B603
                                [nmcli, "connection", "up", name],
                                timeout=60, capture_output=True, text=True, shell=False,
                            )
                            attempts.append("saved_connection")
                            break
            self.log.write("network_recovery_attempted", attempts=attempts)
        except Exception as error:
            self.log.write("network_recovery_failed", error=str(error)[:300])

    def cycle(self) -> None:
        self.enroll()
        if self.stop_path.exists():
            raise SystemExit(0)
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
        keep_awake = False
        if os.name == "nt" and not once:
            import ctypes

            es_continuous = 0x80000000
            es_system_required = 0x00000001
            keep_awake = bool(
                ctypes.windll.kernel32.SetThreadExecutionState(
                    es_continuous | es_system_required
                )
            )
            self.log.write("windows_sleep_hibernate_inhibit", enabled=keep_awake)
        backoff = 2
        try:
            while True:
                try:
                    self.cycle()
                    backoff = 2
                    if once:
                        return 0
                    time.sleep(self.config.poll_seconds)
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
                    time.sleep(backoff)
                    backoff = min(60, backoff * 2)
        finally:
            if os.name == "nt" and keep_awake:
                import ctypes

                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)


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
            {"system_reboot", "system_shutdown", "wake_peer", "lmstudio_install", "lmstudio_probe", "lmstudio_model_get", "lmstudio_model_load", "hybrid_query"}.issubset(SUPPORTED_COMMANDS),
            "restricted power/wake/LM Studio commands missing",
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
            "project_text" in agent.capabilities,
            "project text capability missing",
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
