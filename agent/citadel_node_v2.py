#!/usr/bin/env python3
"""CITADEL/EWS node 0.3.1: bounded missions, telemetry, signed updates and opt-in SSH."""
from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import subprocess  # nosec B404
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

import citadel_node_v1 as v1

VERSION = "0.3.1"
v1.VERSION = VERSION
v1.USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"
SSH_COMMANDS = {"ssh_enable", "ssh_disable"}
v1.SUPPORTED_COMMANDS = set(v1.SUPPORTED_COMMANDS) | SSH_COMMANDS

WARN_EVENTS = {"resource_guard", "assignment_rejected_local", "result_queued", "command_signature_rejected"}
ERROR_EVENTS = {"cycle_error", "command_failed", "command_failure_ack_failed"}
ALLOWED_EVENTS = {
    "agent_start", "agent_stop", "node_enrolled", "cycle_error", "resource_guard",
    "assignment_rejected_local", "result_submitted", "result_queued",
    "queued_results_flushed", "command_signature_rejected", "command_completed",
    "agent_updated", "agent_update_rolled_back", "command_failure_ack_failed", "command_failed",
}
MAX_BATCH_EVENTS = 50
MAX_PAYLOAD_BYTES = 60 * 1024
MAX_DETAILS_BYTES = 1200
SSH_PORT = 22222
SSH_ALLOWED_KEY_TYPES = {"ssh-ed25519", "ecdsa-sha2-nistp256"}
SSH_USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
SSH_FINGERPRINT_RE = re.compile(r"^SHA256:[A-Za-z0-9+/=]{20,64}$")


class TelemetryCursor:
    def __init__(self, log_path: Path, cursor_path: Path) -> None:
        self.log_path, self.cursor_path = log_path, cursor_path

    def _offset(self) -> int:
        state = v1.load_json(self.cursor_path, {}) or {}
        try:
            offset = max(0, int(state.get("offset", 0)))
        except (TypeError, ValueError):
            offset = 0
        try:
            return 0 if self.log_path.stat().st_size < offset else offset
        except FileNotFoundError:
            return 0

    def _save(self, offset: int) -> None:
        v1.atomic_write(self.cursor_path, json.dumps({"offset": offset}, indent=2) + "\n")

    @staticmethod
    def _event_id(node_id: str, offset: int, raw: bytes) -> str:
        digest = hashlib.sha256(
            node_id.encode() + b"\n" + str(offset).encode("ascii") + b"\n" + raw
        ).hexdigest()
        return "log_" + digest[:40]

    @staticmethod
    def _normalize(node_id: str, offset: int, raw: bytes) -> dict[str, Any] | None:
        try:
            item = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(item, dict):
            return None
        event_type = str(item.get("event") or "").strip().lower()
        created_at = str(item.get("ts") or "").strip()
        if event_type not in ALLOWED_EVENTS or not created_at:
            return None
        details = {str(k)[:80]: v for k, v in item.items() if k not in {"ts", "event"}}
        if len(v1.json_text(details).encode()) > MAX_DETAILS_BYTES:
            details = {"truncated": True, "reason": "local_details_too_large"}
        level = "error" if event_type in ERROR_EVENTS else "warn" if event_type in WARN_EVENTS else "info"
        return {
            "event_id": TelemetryCursor._event_id(node_id, offset, raw),
            "level": level, "event_type": event_type, "message": event_type,
            "created_at": created_at, "details": details,
        }

    def next_batch(self, node_id: str) -> tuple[list[dict[str, Any]], int]:
        if not self.log_path.exists():
            return [], self._offset()
        start, events, end_offset = self._offset(), [], self._offset()
        with self.log_path.open("rb") as stream:
            stream.seek(start)
            while len(events) < MAX_BATCH_EVENTS:
                line_offset, raw = stream.tell(), stream.readline()
                if not raw:
                    end_offset = stream.tell()
                    break
                candidate_end = stream.tell()
                event = self._normalize(node_id, line_offset, raw)
                if event is None:
                    end_offset = candidate_end
                    continue
                candidate = events + [event]
                if len(v1.json_text({"events": candidate}).encode()) > MAX_PAYLOAD_BYTES:
                    if events:
                        break
                    end_offset = candidate_end
                    continue
                events.append(event)
                end_offset = candidate_end
        return events, end_offset

    def flush(self, node_id: str, submit: Callable[[dict[str, Any]], Any]) -> int:
        events, end_offset = self.next_batch(node_id)
        current = self._offset()
        if not events:
            if end_offset != current:
                self._save(end_offset)
            return 0
        submit({"events": events})
        self._save(end_offset)
        return len(events)


class SshAccessManager:
    """Only adds/removes one expiring public key after local admin provisioning."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir.resolve()
        self.ssh_dir = (self.data_dir / "ssh").resolve()
        self.provision_path = self.data_dir / "ssh-provision.json"
        self.session_path = self.data_dir / "ssh-session.json"

    @staticmethod
    def validate_public_key(value: Any) -> str:
        if not isinstance(value, str) or "\n" in value or "\r" in value or len(value) > 1024:
            raise ValueError("invalid ssh public key")
        parts = value.strip().split()
        if len(parts) not in (2, 3) or parts[0] not in SSH_ALLOWED_KEY_TYPES:
            raise ValueError("unsupported ssh public key")
        try:
            decoded = base64.b64decode(parts[1], validate=True)
        except Exception as exc:
            raise ValueError("invalid ssh public key encoding") from exc
        if not 32 <= len(decoded) <= 700:
            raise ValueError("invalid ssh public key length")
        return value.strip()

    @staticmethod
    def validate_enable_payload(payload: dict[str, Any]) -> bool:
        if not isinstance(payload, dict) or set(payload) != {"duration_minutes", "public_key"}:
            return False
        duration = payload.get("duration_minutes")
        if not isinstance(duration, int) or not 5 <= duration <= 120:
            return False
        try:
            SshAccessManager.validate_public_key(payload.get("public_key"))
            return True
        except ValueError:
            return False

    def _marker(self) -> dict[str, Any] | None:
        if os.name != "nt":
            return None
        raw = v1.load_json(self.provision_path, {}) or {}
        if not isinstance(raw, dict) or raw.get("managed") is not True:
            return None
        try:
            port = int(raw.get("port"))
            authorized = Path(str(raw.get("authorized_keys_path") or "")).resolve()
        except (TypeError, ValueError, OSError, RuntimeError):
            return None
        username = str(raw.get("username") or "")
        fingerprint = str(raw.get("host_fingerprint") or "")
        if (
            port != SSH_PORT or raw.get("service_name") != "sshd"
            or not SSH_USERNAME_RE.fullmatch(username)
            or authorized != self.ssh_dir / "authorized_keys"
        ):
            return None
        if fingerprint and not SSH_FINGERPRINT_RE.fullmatch(fingerprint):
            fingerprint = ""
        return {
            "port": port, "username": username, "service_name": "sshd",
            "authorized_keys_path": str(authorized), "host_fingerprint": fingerprint,
        }

    @staticmethod
    def _service_running(name: str) -> bool:
        if os.name != "nt":
            return False
        try:
            return v1.psutil.win_service_get(name).status().lower() == "running"
        except Exception:
            return False

    def _expiry_epoch(self) -> int | None:
        raw = (v1.load_json(self.session_path, {}) or {}).get("expires_at_epoch")
        try:
            value = int(raw)
            return value if value > 0 else None
        except (TypeError, ValueError):
            return None

    def expire_if_needed(self) -> None:
        expiry = self._expiry_epoch()
        if expiry is None or int(dt.datetime.now(dt.timezone.utc).timestamp()) < expiry:
            return
        marker = self._marker()
        if marker:
            with contextlib.suppress(FileNotFoundError, OSError):
                Path(marker["authorized_keys_path"]).unlink()
        with contextlib.suppress(FileNotFoundError, OSError):
            self.session_path.unlink()

    def disable(self) -> dict[str, Any]:
        marker = self._marker()
        if marker:
            with contextlib.suppress(FileNotFoundError, OSError):
                Path(marker["authorized_keys_path"]).unlink()
        with contextlib.suppress(FileNotFoundError, OSError):
            self.session_path.unlink()
        return self._status_no_expire()

    def enable(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.validate_enable_payload(payload):
            raise RuntimeError("invalid ssh enable payload")
        marker = self._marker()
        if marker is None:
            raise RuntimeError("ssh not provisioned; run Prepare SSH Support.cmd as administrator")
        if not self._service_running(marker["service_name"]):
            raise RuntimeError("Windows OpenSSH service is not running")
        key = self.validate_public_key(payload["public_key"])
        duration = int(payload["duration_minutes"])
        self.ssh_dir.mkdir(parents=True, exist_ok=True)
        authorized = Path(marker["authorized_keys_path"]).resolve()
        if authorized != self.ssh_dir / "authorized_keys":
            raise RuntimeError("unsafe ssh authorized_keys path")
        now = dt.datetime.now(dt.timezone.utc)
        expiry = now + dt.timedelta(minutes=duration)
        v1.atomic_write(
            authorized,
            f'expiry-time="{expiry.strftime("%Y%m%d%H%M%SZ")}" {key}\n',
        )
        v1.atomic_write(
            self.session_path,
            json.dumps({
                "enabled_at": now.isoformat(timespec="seconds"),
                "expires_at_epoch": int(expiry.timestamp()),
                "duration_minutes": duration,
            }, indent=2) + "\n",
        )
        return self._status_no_expire()

    def _status_no_expire(self) -> dict[str, Any]:
        marker = self._marker()
        if marker is None:
            return {
                "supported": os.name == "nt", "provisioned": False, "enabled": False,
                "service_running": False, "port": SSH_PORT, "username": None,
                "host_fingerprint": None, "expires_at_epoch": None,
            }
        expiry = self._expiry_epoch()
        running = self._service_running(marker["service_name"])
        enabled = bool(expiry and Path(marker["authorized_keys_path"]).exists() and running)
        return {
            "supported": True, "provisioned": True, "enabled": enabled,
            "service_running": running, "port": marker["port"], "username": marker["username"],
            "host_fingerprint": marker["host_fingerprint"] or None,
            "expires_at_epoch": expiry if enabled else None,
        }

    def status(self) -> dict[str, Any]:
        self.expire_if_needed()
        return self._status_no_expire()

    def capability_strings(self) -> list[str]:
        state = self.status()
        if not state["supported"]:
            return []
        values = ["ssh-control"]
        if not state["provisioned"]:
            return values + ["ssh-unprepared"]
        values += ["ssh-provisioned", "ssh-service-running" if state["service_running"] else "ssh-service-stopped"]
        if not state["enabled"]:
            return values + ["ssh-disabled"]
        values += [
            "ssh-enabled", f"ssh-port:{state['port']}", f"ssh-expires:{state['expires_at_epoch']}",
            f"ssh-user:{state['username']}",
        ]
        if state["host_fingerprint"]:
            values.append(f"ssh-fingerprint:{state['host_fingerprint']}")
        return values


class Agent(v1.Agent):
    def __init__(self, config: v1.AgentConfig, config_path: Path | None = None) -> None:
        super().__init__(config, config_path)
        self.telemetry = TelemetryCursor(config.data_dir / "agent.jsonl", config.data_dir / "telemetry-cursor.json")
        self.ssh = SshAccessManager(config.data_dir)

    @property
    def capabilities(self) -> list[str]:
        return sorted(set(super().capabilities) | set(self.ssh.capability_strings()))

    def submit_telemetry(self, payload: dict[str, Any]) -> None:
        self.api.request("POST", f"/api/v1/nodes/{self.require_node_id()}/logs", payload)

    def verify_controller_command(self, command: dict[str, Any]) -> bool:
        command_type = str(command.get("command_type") or "")
        if command_type not in SSH_COMMANDS:
            return super().verify_controller_command(command)
        command_id = str(command.get("command_id") or "")
        created_at = str(command.get("created_at") or "")
        signature = str(command.get("signature") or "")
        payload = command.get("payload") or {}
        if not all((command_id, created_at, signature, self.identity.node_id)) or not isinstance(payload, dict):
            return False
        if command_type == "ssh_enable":
            if not self.ssh.validate_enable_payload(payload):
                return False
        elif payload != {}:
            return False
        canonical = "\n".join((
            "CITADEL-COMMAND-V1", command_id, self.identity.node_id or "", command_type,
            v1.sha256_text(v1.json_text(payload)), created_at,
        )).encode()
        try:
            key = v1.Ed25519PublicKey.from_public_bytes(v1.unb64url(self.config.controller_public_x))
            key.verify(v1.unb64url(signature), canonical)
            return True
        except Exception:
            return False

    def handle_commands(self) -> None:
        self.ssh.expire_if_needed()
        node_id = self.require_node_id()
        response = self.api.request("GET", f"/api/v1/nodes/{node_id}/commands")
        for command in response.get("commands") or []:
            command_id = str(command.get("command_id") or "")
            command_type = str(command.get("command_type") or "")
            if not self.verify_controller_command(command):
                self.log.write("command_signature_rejected", command_id=command_id, command_type=command_type)
                continue
            try:
                restart_after = False
                if command.get("status") == "pending":
                    self.ack_command(command_id, "accepted")
                if command_type == "pause":
                    v1.atomic_write(self.paused_path, v1.now_iso() + "\n")
                elif command_type == "resume":
                    with contextlib.suppress(FileNotFoundError):
                        self.paused_path.unlink()
                elif command_type == "update":
                    self.apply_update(command.get("payload") or {})
                    restart_after = True
                elif command_type == "uninstall":
                    self.ssh.disable()
                    v1.atomic_write(self.stop_path, "controller stop " + v1.now_iso() + "\n")
                elif command_type == "ssh_enable":
                    self.ssh.enable(command.get("payload") or {})
                elif command_type == "ssh_disable":
                    self.ssh.disable()
                self.ack_command(command_id, "completed")
                self.log.write("command_completed", command_id=command_id, command_type=command_type)
                if restart_after:
                    entrypoint = Path(__file__).resolve().parent / "citadel_node_v2.py"
                    subprocess.Popen(  # nosec B603
                        [sys.executable, str(entrypoint), "run", "--config", str(self.config_path)],
                        cwd=entrypoint.parent, shell=False,
                        creationflags=(0x08000000 if os.name == "nt" else 0),
                    )
                    raise SystemExit(0)
            except Exception as error:
                try:
                    self.ack_command(command_id, "failed")
                except Exception as ack_error:
                    self.log.write("command_failure_ack_failed", command_id=command_id, error=str(ack_error)[:300])
                self.log.write("command_failed", command_id=command_id, error=str(error)[:300])

    def cycle(self) -> None:
        super().cycle()
        self.telemetry.flush(self.require_node_id(), self.submit_telemetry)


def self_test() -> int:
    if v1.self_test() != 0:
        return 2
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        log_path = root / "agent.jsonl"
        log_path.write_text(
            "\n".join([
                json.dumps({"ts": "2026-09-12T20:00:00+00:00", "event": "agent_start", "version": VERSION}),
                json.dumps({"ts": "2026-09-12T20:00:01+00:00", "event": "resource_guard", "cpu_percent": 95.0}),
            ]) + "\n", encoding="utf-8",
        )
        cursor, payloads = TelemetryCursor(log_path, root / "cursor.json"), []
        if cursor.flush("node_test", payloads.append) != 2 or len(payloads) != 1:
            raise RuntimeError("telemetry self-test failed")
        if cursor.flush("node_test", payloads.append) != 0 or payloads[0]["events"][1]["level"] != "warn":
            raise RuntimeError("telemetry self-test cursor/severity failed")
        public_key = (
            v1.Ed25519PrivateKey.generate().public_key().public_bytes(
                v1.serialization.Encoding.OpenSSH, v1.serialization.PublicFormat.OpenSSH
            ).decode()
        )
        if SshAccessManager.validate_public_key(public_key) != public_key:
            raise RuntimeError("ssh self-test valid key rejected")
        if not SshAccessManager.validate_enable_payload({"duration_minutes": 30, "public_key": public_key}):
            raise RuntimeError("ssh self-test payload rejected")
        if SshAccessManager.validate_enable_payload({"duration_minutes": 300, "public_key": public_key}):
            raise RuntimeError("ssh self-test unsafe duration accepted")
    print("CITADEL v2 telemetry/SSH SELF TEST: PASS")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=f"CITADEL/EWS Cloudflare node agent {VERSION}")
    parser.add_argument("command", choices=["doctor", "enroll", "once", "run", "self-test"])
    parser.add_argument("--config", default="agent/config.json")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "self-test":
        return self_test()
    config = v1.AgentConfig.from_file(Path(args.config))
    if args.command == "doctor":
        return v1.doctor(config)
    agent = Agent(config, Path(args.config))
    if args.command == "enroll":
        print(agent.enroll())
        return 0
    return agent.run(once=args.command == "once")


if __name__ == "__main__":
    raise SystemExit(main())
