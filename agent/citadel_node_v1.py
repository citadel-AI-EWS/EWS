#!/usr/bin/env python3
"""Bounded CITADEL/EWS node for operator-owned or administered computers.

The node speaks the existing Cloudflare /api/v1 Ed25519 protocol. It has no
remote shell, arbitrary code loader, exploit engine, credential collector,
self-propagation, stealth installation, or autonomous financial actions.
Only locally registered mission handlers can execute.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import dataclasses
import datetime as dt
import hashlib
import ipaddress
import http.client
import json
import os
import platform
import shutil
import socket
# Subprocesses below use a fixed interpreter, allowlisted local scripts and no shell.
import subprocess  # nosec B404
import sys
import tempfile
import time
import urllib.parse
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

VERSION = "0.3.6"
USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"
DEFAULT_CONTROLLER_PUBLIC_X = "erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
SUPPORTED_COMMANDS = {"pause", "resume", "update", "restart", "stop", "rollback", "uninstall", "system_reboot", "system_shutdown", "wake_peer"}
UPDATE_FILE_NAMES = {"citadel_node_v1.py", "citadel_node_v2.py"}
UPDATE_MAX_FILE_BYTES = 2 * 1024 * 1024


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))


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
        if state.get("private_key_pem"):
            key = serialization.load_pem_private_key(
                state["private_key_pem"].encode("ascii"), password=None
            )
            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError("identity key is not Ed25519")
            self.private_key = key
            self.node_id = state.get("node_id") or None
        else:
            self.private_key = Ed25519PrivateKey.generate()
            self.save()

    def require_key(self) -> Ed25519PrivateKey:
        if self.private_key is None:
            raise RuntimeError("node identity unavailable")
        return self.private_key

    def save(self) -> None:
        pem = self.require_key().private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        atomic_write(
            self.path,
            json.dumps({"node_id": self.node_id, "private_key_pem": pem}, indent=2) + "\n",
        )

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
            canonical = "\n".join((method, request_path, timestamp, sha256_text(body_text)))
            headers.update({
                "x-node-id": self.identity.node_id,
                "x-node-timestamp": timestamp,
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
        self.last_heartbeat = 0.0
        self.enrollment_confirmed = False

    @property
    def capabilities(self) -> list[str]:
        return sorted(HANDLERS)

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

    def execute_assignment(self, assignment: dict[str, Any]) -> None:
        node_id = self.require_node_id()
        assignment_id = str(assignment.get("assignment_id") or "")
        mission_type = str(assignment.get("mission_type") or "")
        handler = HANDLERS.get(mission_type)
        if not assignment_id or handler is None:
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
        payload = command.get("payload") or {}
        if not isinstance(payload, dict):
            return False
        if command_type == "update":
            if not self.validate_update_payload(payload):
                return False
        elif command_type == "wake_peer":
            if not self.validate_wake_payload(payload):
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
                elif command_type in {"system_reboot", "system_shutdown"}:
                    self.schedule_system_power_action(command_type)
                elif command_type == "wake_peer":
                    self.send_wake_packet(command.get("payload") or {})
                self.ack_command(command_id, "completed")
                self.log.write(
                    "command_completed",
                    command_id=command_id,
                    command_type=command_type,
                )
                if stop_after:
                    raise SystemExit(0)
                if restart_after:
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
            self.log.write("windows_sleep_inhibit", enabled=keep_awake)
        backoff = 2
        try:
            while True:
                try:
                    self.cycle()
                    backoff = 2
                    if once:
                        return 0
                    time.sleep(self.config.poll_seconds)
                except SystemExit:
                    self.log.write("agent_stop", reason="STOP")
                    return 0
                except KeyboardInterrupt:
                    self.log.write("agent_stop", reason="keyboard_interrupt")
                    return 0
                except Exception as error:
                    self.log.write("cycle_error", error=str(error)[:500])
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
        identity = Identity(root / "identity.json")
        identity.set_node_id("node_test")
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
            "created_at": "2026-09-12T00:00:00.000Z",
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
        command["command_type"] = "shell"
        require_test(
            not agent.verify_controller_command(command),
            "unapproved command accepted",
        )
        require_test(
            {"system_reboot", "system_shutdown", "wake_peer"}.issubset(SUPPORTED_COMMANDS),
            "restricted power/wake commands missing",
        )
        require_test(
            "shell" not in SUPPORTED_COMMANDS,
            "arbitrary shell command registered",
        )
        require_test(
            set(HANDLERS) == {"system_inventory"},
            "unexpected handler registered",
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
