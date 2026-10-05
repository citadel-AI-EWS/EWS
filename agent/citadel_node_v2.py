#!/usr/bin/env python3
"""CITADEL/EWS node v0.3: bounded node, telemetry and signed self-update.

Telemetry only uploads the node's own JSONL operational events to the existing
Controller. It does not add remote execution, credential collection, discovery,
or any new command capability.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Callable

import citadel_node_v1 as v1

VERSION = "0.3.39"
v1.VERSION = VERSION
v1.USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"

WARN_EVENTS = {
    "resource_guard",
    "assignment_heartbeat_failed",
    "assignment_rejected_local",
    "result_queued",
    "command_signature_rejected",
}
ERROR_EVENTS = {
    "cycle_error",
    "operation_heartbeat_failed",
    "operation_cancel_check_failed",
    "command_failed",
    "command_failure_ack_failed",
}
ALLOWED_EVENTS = {
    "agent_start",
    "agent_stop",
    "node_enrolled",
    "windows_sleep_inhibit",
    "cycle_error",
    "operation_heartbeat_failed",
    "assignment_heartbeat_failed",
    "resource_guard",
    "assignment_rejected_local",
    "result_submitted",
    "result_queued",
    "queued_results_flushed",
    "command_signature_rejected",
    "command_completed",
    "command_cancelled",
    "agent_updated",
    "agent_update_rolled_back",
    "agent_update_healthcheck_passed",
    "agent_update_manual_rollback",
    "agent_restart_requested",
    "agent_stop_requested",
    "system_reboot_scheduled",
    "system_shutdown_scheduled",
    "wake_packet_sent",
    "lmstudio_installed",
    "lmstudio_uninstalled",
    "python_mini_agents_completed",
    "lmstudio_model_downloaded",
    "lmstudio_model_loaded",
    "network_recovery_attempted",
    "network_recovery_not_needed",
    "network_recovery_failed",
    "network_profile_remember_failed",
    "windows_sleep_hibernate_inhibit",
    "linux_sleep_hibernate_inhibit",
    "hybrid_query_completed",
    "lmstudio_state_report_failed",
    "lmstudio_heartbeat_probe_failed",
    "python_mode_calculation_fallback",
    "lmstudio_model_key_resolution_fallback",
    "command_failure_ack_failed",
    "command_failed",
}
MAX_BATCH_EVENTS = 50
MAX_PAYLOAD_BYTES = 60 * 1024
MAX_DETAILS_BYTES = 1200


class TelemetryCursor:
    def __init__(self, log_path: Path, cursor_path: Path) -> None:
        self.log_path = log_path
        self.cursor_path = cursor_path

    def _offset(self) -> int:
        state = v1.load_json(self.cursor_path, {}) or {}
        try:
            offset = max(0, int(state.get("offset", 0)))
        except (TypeError, ValueError):
            offset = 0
        try:
            if self.log_path.stat().st_size < offset:
                return 0
        except FileNotFoundError:
            return 0
        return offset

    def _save(self, offset: int) -> None:
        v1.atomic_write(
            self.cursor_path,
            json.dumps({"offset": offset}, indent=2) + "\n",
        )

    @staticmethod
    def _event_id(node_id: str, offset: int, raw: bytes) -> str:
        digest = hashlib.sha256(
            node_id.encode("utf-8") + b"\n" + str(offset).encode("ascii") + b"\n" + raw
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
        if event_type not in ALLOWED_EVENTS:
            return None
        created_at = str(item.get("ts") or "").strip()
        if not created_at:
            return None
        details = {
            str(key)[:80]: value
            for key, value in item.items()
            if key not in {"ts", "event"}
        }
        details_text = v1.json_text(details)
        if len(details_text.encode("utf-8")) > MAX_DETAILS_BYTES:
            details = {"truncated": True, "reason": "local_details_too_large"}
        level = "error" if event_type in ERROR_EVENTS else "warn" if event_type in WARN_EVENTS else "info"
        return {
            "event_id": TelemetryCursor._event_id(node_id, offset, raw),
            "level": level,
            "event_type": event_type,
            "message": event_type,
            "created_at": created_at,
            "details": details,
        }

    def next_batch(self, node_id: str) -> tuple[list[dict[str, Any]], int]:
        if not self.log_path.exists():
            return [], self._offset()
        start = self._offset()
        events: list[dict[str, Any]] = []
        end_offset = start
        with self.log_path.open("rb") as stream:
            stream.seek(start)
            while len(events) < MAX_BATCH_EVENTS:
                line_offset = stream.tell()
                raw = stream.readline()
                if not raw:
                    end_offset = stream.tell()
                    break
                candidate_end = stream.tell()
                event = self._normalize(node_id, line_offset, raw)
                if event is None:
                    end_offset = candidate_end
                    continue
                candidate = events + [event]
                payload_size = len(v1.json_text({"events": candidate}).encode("utf-8"))
                if payload_size > MAX_PAYLOAD_BYTES:
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


class Agent(v1.Agent):
    def __init__(self, config: v1.AgentConfig, config_path: Path | None = None) -> None:
        super().__init__(config, config_path)
        self.telemetry = TelemetryCursor(
            config.data_dir / "agent.jsonl",
            config.data_dir / "telemetry-cursor.json",
        )
        self._ssh_relay_stop = threading.Event()
        self._ssh_relay_thread: threading.Thread | None = None
        self._ssh_relay_enabled = False

    def run(self, once: bool = False) -> int:
        self._ssh_relay_enabled = not once
        try:
            return super().run(once=once)
        finally:
            self._ssh_relay_stop.set()

    def submit_telemetry(self, payload: dict[str, Any]) -> None:
        node_id = self.require_node_id()
        self.api.request("POST", f"/api/v1/nodes/{node_id}/logs", payload)

    def cycle(self) -> None:
        super().cycle()
        node_id = self.require_node_id()
        if self._ssh_relay_enabled and (not self._ssh_relay_thread or not self._ssh_relay_thread.is_alive()):
            self._ssh_relay_thread = threading.Thread(target=self._ssh_relay_worker,
                args=(node_id,), name="citadel-ssh-relay", daemon=True)
            self._ssh_relay_thread.start()
        self.telemetry.flush(node_id, self.submit_telemetry)

    def _ssh_relay_worker(self, node_id: str) -> None:
        try:
            try:
                import asyncssh
                import websockets
            except ImportError:
                # Existing nodes receive the core self-update before the installer
                # can refresh the venv. Install only the fixed, pinned relay runtime.
                result = v1._citadel_subprocess_run([sys.executable, "-m", "pip", "install",
                    "--disable-pip-version-check", "asyncssh==2.24.0", "websockets==16.0"],
                    capture_output=True, text=True, timeout=180, check=False, shell=False)
                if result.returncode:
                    raise RuntimeError("ssh_relay_dependency_install_failed")
                import asyncssh
                import websockets
            asyncio.run(self._ssh_relay_loop(node_id, asyncssh, websockets))
        except Exception as error:
            self.log.write("ssh_relay_error", error=type(error).__name__ + ": " + str(error)[:160])
            self._ssh_relay_stop.wait(60)

    async def _ssh_relay_loop(self, node_id, asyncssh, websockets) -> None:
        from ssh_restricted_console import execute

        host_key = asyncssh.generate_private_key("ssh-ed25519")
        client_key = asyncssh.generate_private_key("ssh-ed25519")
        host_public = host_key.export_public_key()
        client_public = client_key.export_public_key()
        config_path = self.config_path

        class LocalServer(asyncssh.SSHServer):
            def begin_auth(self, username):
                return True

            def public_key_auth_supported(self):
                return True

            def validate_public_key(self, username, key):
                return username == "citadel" and key.export_public_key() == client_public

        async def console(process):
            if process.command:
                process.exit(2)
                return
            process.stdout.write("CITADEL Restricted SSH Console\r\nType 'help'.\r\ncitadel> ")
            while True:
                line = await process.stdin.readline()
                if not line:
                    break
                output, done = await asyncio.to_thread(execute, line, config_path)
                if output:
                    process.stdout.write(output.replace("\n", "\r\n") + "\r\n")
                if done:
                    break
                process.stdout.write("citadel> ")
            process.exit(0)

        server = await asyncssh.listen("127.0.0.1", 0, server_host_keys=[host_key],
            server_factory=LocalServer, process_factory=console)
        port = server.sockets[0].getsockname()[1]
        known_hosts = asyncssh.import_known_hosts(
            f"[127.0.0.1]:{port} {host_public.decode('ascii').strip()}")
        self.log.write("ssh_relay_local_ready", bind="127.0.0.1", platform=os.name)
        try:
            delay = 2
            while not self._ssh_relay_stop.is_set():
                quota_pause = self.api.retry_delay()
                if quota_pause:
                    await asyncio.to_thread(self._ssh_relay_stop.wait, min(60, quota_pause))
                    continue
                path = f"/api/v1/nodes/{node_id}/ssh/relay"
                route = self.api.base_path + path
                parsed = urllib.parse.urlsplit(self.config.controller_url)
                url = urllib.parse.urlunsplit(("wss" if parsed.scheme == "https" else "ws",
                    parsed.netloc, route, "", ""))
                stamp, request_id = str(int(time.time())), str(uuid.uuid4())
                canonical = "\n".join(("GET", route, stamp, request_id, v1.sha256_text("")))
                headers = {"x-node-id": node_id, "x-node-timestamp": stamp,
                    "x-node-request-id": request_id,
                    "x-node-signature": self.identity.sign(canonical.encode("utf-8"))}
                try:
                    async with websockets.connect(url, additional_headers=headers,
                        subprotocols=["citadel-ssh-agent-v1"], max_size=8192,
                        ping_interval=20, ping_timeout=20, open_timeout=15) as socket:
                        if socket.subprotocol != "citadel-ssh-agent-v1":
                            raise RuntimeError("ssh_relay_protocol_mismatch")
                        self.log.write("ssh_relay_connected")
                        delay = 2
                        await self._ssh_relay_session(socket, node_id, port, client_key, known_hosts, asyncssh)
                except Exception as error:
                    self.log.write("ssh_relay_disconnected", reason=type(error).__name__)
                await asyncio.to_thread(self._ssh_relay_stop.wait, delay)
                delay = min(60, delay * 2)
        finally:
            server.close()
            await server.wait_closed()

    async def _ssh_relay_session(self, socket, node_id, port, client_key, known_hosts, asyncssh) -> None:
        active = None
        reader = None
        async def stop():
            nonlocal active, reader
            if reader:
                reader.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await reader
                reader = None
            if active:
                connection, process = active
                process.close()
                connection.close()
                await connection.wait_closed()
                active = None

        async def output_loop(process):
            try:
                while chunk := await process.stdout.read(8192):
                    await socket.send(chunk)
                await socket.send(json.dumps({"type": "exit", "code": process.exit_status}))
            except (asyncio.CancelledError, Exception):
                return

        try:
            async for message in socket:
                if isinstance(message, bytes):
                    if active and len(message) <= 8192:
                        active[1].stdin.write(message)
                    continue
                try:
                    command = json.loads(message)
                except (ValueError, TypeError):
                    continue
                if command.get("type") == "stop":
                    await stop()
                elif command.get("type") == "resize" and active:
                    cols, rows = command.get("cols"), command.get("rows")
                    if isinstance(cols, int) and isinstance(rows, int) and 20 <= cols <= 300 and 5 <= rows <= 150:
                        active[1].change_terminal_size(cols, rows)
                elif command.get("type") == "start" and not active:
                    expires = command.get("expires_at")
                    if not isinstance(expires, int) or not 0 < expires - time.time() <= 1800:
                        continue
                    try:
                        connection = await asyncssh.connect("127.0.0.1", port, username="citadel",
                            client_keys=[client_key], known_hosts=known_hosts,
                            agent_path=None, connect_timeout=10)
                        process = await connection.create_process(term_type="xterm", encoding=None)
                        active = (connection, process)
                        await socket.send(json.dumps({"type": "ready", "node_id": node_id}))
                        reader = asyncio.create_task(output_loop(process))
                    except Exception:
                        await socket.send(json.dumps({"type": "error", "code": "ssh_connection_failed"}))
                        await stop()
        finally:
            await stop()


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
                json.dumps({"ts": "2026-09-12T20:00:02+00:00", "event": "windows_sleep_inhibit", "enabled": True}),
            ]) + "\n",
            encoding="utf-8",
        )
        cursor = TelemetryCursor(log_path, root / "cursor.json")
        payloads: list[dict[str, Any]] = []
        sent = cursor.flush("node_test", payloads.append)
        if sent != 3 or len(payloads) != 1:
            raise RuntimeError("telemetry self-test failed: batch not uploaded")
        if cursor.flush("node_test", payloads.append) != 0:
            raise RuntimeError("telemetry self-test failed: cursor did not advance")
        if payloads[0]["events"][1]["level"] != "warn":
            raise RuntimeError("telemetry self-test failed: severity mapping")
        if payloads[0]["events"][2]["event_type"] != "windows_sleep_inhibit":
            raise RuntimeError("telemetry self-test failed: sleep inhibit event dropped")
    print("CITADEL v2 telemetry SELF TEST: PASS")
    return 0


def startup_check(config_path: Path) -> int:
    """Validate the installed release in a fresh process before daemon handoff."""
    if self_test() != 0:
        return 2
    config = v1.AgentConfig.from_file(config_path)
    agent = Agent(config, config_path)
    agent.identity.require_key()
    if not config.data_dir.exists():
        raise RuntimeError("agent data directory is unavailable")
    agent.log.write(
        "agent_update_healthcheck_passed",
        version=VERSION,
        phase="fresh_process_startup",
    )
    print(f"CITADEL startup health-check {VERSION}: PASS")
    return 0


def controller_probe(config_path: Path) -> int:
    """Verify enrollment and a signed heartbeat without consuming work."""
    config = v1.AgentConfig.from_file(config_path)
    agent = Agent(config, config_path)
    node_id = agent.enroll()
    agent.heartbeat()
    print(json.dumps({"ok": True, "node_id": node_id, "agent_version": VERSION}))
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"CITADEL/EWS Cloudflare v1 node agent {VERSION}"
    )
    parser.add_argument(
        "command",
        choices=["doctor", "enroll", "probe", "once", "run", "self-test", "startup-check"],
    )
    parser.add_argument("--config", default="agent/config.json")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "self-test":
        return self_test()
    if args.command == "startup-check":
        return startup_check(Path(args.config))
    if args.command == "probe":
        return controller_probe(Path(args.config))
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
