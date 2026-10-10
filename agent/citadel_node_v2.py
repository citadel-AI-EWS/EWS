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
import random
import signal
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import email.utils
import uuid
from pathlib import Path
from typing import Any, Callable

import citadel_node_v1 as v1

VERSION = "0.3.44"
v1.VERSION = VERSION
v1.USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"

WARN_EVENTS = {
    "resource_guard",
    "assignment_heartbeat_failed",
    "assignment_rejected_local",
    "result_queued",
    "command_signature_rejected",
    "ssh_relay_disconnected",
}
ERROR_EVENTS = {
    "cycle_error",
    "operation_heartbeat_failed",
    "operation_cancel_check_failed",
    "command_failed",
    "command_failure_ack_failed",
    "ssh_relay_error",
}
ALLOWED_EVENTS = {
    "agent_start",
    "agent_stop",
    "node_enrolled",
    "windows_sleep_inhibit",
    "cycle_error",
    "operation_heartbeat_failed",
    "operation_cancel_check_failed",
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
    "ssh_relay_connected",
    "ssh_relay_disconnected",
    "ssh_relay_error",
    "ssh_relay_local_ready",
    "agent_update_noop",
}
MAX_BATCH_EVENTS = 50
MAX_PAYLOAD_BYTES = 60 * 1024
MAX_DETAILS_BYTES = 1200
MAX_LOG_LINE_BYTES = 64 * 1024
MAX_SKIP_LINE_BYTES = 4 * 1024 * 1024
_SECURE_RANDOM = random.SystemRandom()


class TelemetryCursor:
    def __init__(self, log_path: Path, cursor_path: Path) -> None:
        self.log_path = log_path
        self.cursor_path = cursor_path
        self._lock = threading.RLock()

    def _offset(self) -> int:
        with self._lock:
            state = v1.load_json(self.cursor_path, {}) or {}
            if not isinstance(state, dict):
                state = {}
            try:
                offset = max(0, int(state.get("offset", 0)))
            except (TypeError, ValueError, OverflowError):
                offset = 0
            try:
                info = self.log_path.stat()
            except FileNotFoundError:
                return 0
            if (state.get("dev") is not None and state.get("ino") is not None
                    and (state["dev"], state["ino"]) != (info.st_dev, info.st_ino)):
                return 0
            return offset if info.st_size >= offset else 0

    def _save(self, offset: int, source: os.stat_result | None = None) -> None:
        with self._lock:
            current = self.log_path.stat()
            if source is not None and (
                (current.st_dev, current.st_ino) != (source.st_dev, source.st_ino)
                or current.st_size < offset
            ):
                # The log rotated or shrank while a POST was in flight.
                return
            v1.atomic_write(self.cursor_path, json.dumps({
                "offset": offset, "dev": current.st_dev, "ino": current.st_ino
            }, indent=2) + "\n")

    @staticmethod
    def _event_id(node_id: str, offset: int, raw: bytes) -> str:
        digest = hashlib.sha256(
            node_id.encode("utf-8") + b"\n" + str(offset).encode("ascii") + b"\n" + raw
        ).hexdigest()
        return "log_" + digest[:40]

    @staticmethod
    def _normalize(node_id: str, offset: int, raw: bytes) -> dict[str, Any] | None:
        try:
            item = json.loads(raw.decode("utf-8", errors="replace"))
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

    @staticmethod
    def _skip_oversized(stream, first: bytes) -> bool:
        if first.endswith(b"\n"):
            return True
        budget = MAX_SKIP_LINE_BYTES - len(first)
        while budget > 0:
            chunk = stream.readline(min(budget, MAX_LOG_LINE_BYTES))
            if not chunk:
                return False
            if chunk.endswith(b"\n"):
                return True
            budget -= len(chunk)
        raise ValueError("telemetry_line_exceeds_scan_limit")

    def _next_batch(self, node_id: str) -> tuple[list[dict[str, Any]], int, os.stat_result | None]:
        try:
            info = self.log_path.stat()
        except FileNotFoundError:
            return [], 0, None
        start = self._offset()
        events: list[dict[str, Any]] = []
        end_offset = start
        with self.log_path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise OSError("telemetry_log_rotated_during_open")
            stream.seek(start)
            while len(events) < MAX_BATCH_EVENTS:
                line_offset = stream.tell()
                raw = stream.readline(MAX_LOG_LINE_BYTES + 1)
                if not raw:
                    break
                if len(raw) > MAX_LOG_LINE_BYTES:
                    if not self._skip_oversized(stream, raw):
                        break
                    end_offset = stream.tell()
                    continue
                if not raw.endswith(b"\n"):
                    break  # never commit an unfinished JSONL record
                candidate_end = stream.tell()
                event = self._normalize(node_id, line_offset, raw)
                if event is None:
                    end_offset = candidate_end
                    continue
                candidate = events + [event]
                if len(v1.json_text({"events": candidate}).encode("utf-8")) > MAX_PAYLOAD_BYTES:
                    if events:
                        break
                    end_offset = candidate_end
                    continue
                events.append(event)
                end_offset = candidate_end
        return events, end_offset, info

    def next_batch(self, node_id: str) -> tuple[list[dict[str, Any]], int]:
        with self._lock:
            events, end_offset, _ = self._next_batch(node_id)
            return events, end_offset

    def flush(self, node_id: str, submit: Callable[[dict[str, Any]], Any]) -> int:
        with self._lock:
            events, end_offset, info = self._next_batch(node_id)
            current = self._offset()
            if not events:
                if info is not None and end_offset != current:
                    self._save(end_offset, info)
                return 0
            submit({"events": events})
            # On failed cursor persistence, retry identical event IDs on next cycle.
            # Never swallow an OSError here; controller deduplication is required.
            self._save(end_offset, info)
            return len(events)


def ssh_handshake_retry_after(error: Exception) -> float:
    """Handle websockets 16 InvalidStatus and legacy InvalidStatusCode."""
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None)
    headers = getattr(response, "headers", None)
    if status is None:
        status = getattr(error, "status_code", None)
        headers = getattr(error, "headers", None)
    if status not in (429, 503) or headers is None:
        return 0.0
    try:
        raw = headers.get("Retry-After")
        if not isinstance(raw, str) or not raw.strip():
            return 0.0
        try:
            seconds = float(raw)
        except ValueError:
            seconds = email.utils.parsedate_to_datetime(raw).timestamp() - time.time()
        return seconds if 0 < seconds <= 86400 else 0.0
    except (ValueError, TypeError, OverflowError, AttributeError):
        return 0.0


async def interruptible_relay_pause(stop_event: threading.Event, seconds: float) -> None:
    """Avoid spawning blocking executor threads which delay asyncio shutdown."""
    deadline = time.monotonic() + max(0.0, seconds)
    while not stop_event.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        await asyncio.sleep(min(0.5, remaining))


class Agent(v1.Agent):
    def __init__(self, config: v1.AgentConfig, config_path: Path | None = None) -> None:
        super().__init__(config, config_path)
        self.telemetry = TelemetryCursor(
            config.data_dir / "agent.jsonl",
            # Replay retained local history once for the archive-aware cursor,
            # including SSH events skipped by the pre-0.3.42 allowlist.
            config.data_dir / "telemetry-archive-cursor.json",
        )
        self._ssh_relay_stop = threading.Event()
        self._ssh_relay_thread: threading.Thread | None = None
        self._ssh_relay_enabled = False
        self.telemetry_api = v1.ApiClient(config, self.identity)
        self._telemetry_retry_at = 0.0
        self._telemetry_backoff = 2.0
        self._ssh_retry_at = 0.0
        self._lock = threading.Lock()

    def _shutdown_signal(self, _signum: int, _frame: Any) -> None:
        self._ssh_relay_stop.set()
        # Let the v1 runner handle its standard KeyboardInterrupt cleanup.
        raise KeyboardInterrupt

    def run(self, once: bool = False) -> int:
        self._ssh_relay_enabled = not once
        old_handlers = []
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    previous = signal.getsignal(sig)
                    signal.signal(sig, self._shutdown_signal)
                    old_handlers.append((sig, previous))
                except (ValueError, OSError, RuntimeError):
                    pass
        try:
            return super().run(once=once)
        finally:
            self._ssh_relay_stop.set()
            if self._ssh_relay_thread and self._ssh_relay_thread.is_alive():
                self._ssh_relay_thread.join(timeout=5.0)
            if threading.current_thread() is threading.main_thread():
                for sig, previous in old_handlers:
                    with contextlib.suppress(ValueError, OSError, RuntimeError):
                        if signal.getsignal(sig) == self._shutdown_signal:
                            signal.signal(sig, previous)

    def submit_telemetry(self, payload: dict[str, Any]) -> None:
        node_id = self.require_node_id()
        response = self.telemetry_api.request("POST", f"/api/v1/nodes/{node_id}/logs", payload)
        if (response.get("drive_archive") or {}).get("status") == "awaiting_write_test":
            # Keep the original local events until the archive can commit them.
            # A disabled archive is not a successful report delivery.
            raise v1.ControllerApiError(503, "node_report_archive_not_ready", 900)

    def flush_telemetry(self) -> None:
        """Reporting retains its cursor and retries without delaying node control."""
        if not self.identity.node_id or time.monotonic() < self._telemetry_retry_at:
            return
        # A known shared-controller outage must not generate another request.
        if self.api.retry_delay():
            return
        try:
            self.telemetry.flush(self.identity.node_id, self.submit_telemetry)
        except Exception as error:
            retry = error.retry_after_seconds if isinstance(error, v1.ControllerApiError) else 0
            self._telemetry_retry_at = time.monotonic() + min(86400, max(self._telemetry_backoff, retry))
            self._telemetry_backoff = min(300, self._telemetry_backoff * 2)
        else:
            self._telemetry_retry_at = 0.0
            self._telemetry_backoff = 2.0

    def cycle(self) -> None:
        try:
            super().cycle()
        except Exception:
            # Flush failure evidence even when the main cycle failed, preserving
            # its original exception and Controller quota backoff.
            self._start_ssh_relay()
            self.flush_telemetry()
            raise
        self._start_ssh_relay()
        self.flush_telemetry()

    def enroll(self) -> str:
        node_id = super().enroll()
        # Reconcile a persisted identity before starting a signed transport;
        # later task failures must not prevent that independent transport.
        self._start_ssh_relay()
        return node_id

    def _start_ssh_relay(self) -> None:
        node_id = self.identity.node_id
        if (not self.enrollment_confirmed or not node_id or self._ssh_relay_stop.is_set()
                or self.lifecycle_stop_requested() or self.stop_path.exists()):
            return
        with self._lock:
            if self._ssh_relay_enabled and (
                not self._ssh_relay_thread or not self._ssh_relay_thread.is_alive()
            ):
                self._ssh_relay_thread = threading.Thread(
                    target=self._ssh_relay_worker, args=(node_id,),
                    name="citadel-ssh-relay", daemon=True
                )
                self._ssh_relay_thread.start()

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
                quota_pause = max(self.api.retry_delay(),getattr(self, '_ssh_retry_at', 0.0)-time.monotonic())
                if quota_pause:
                    await interruptible_relay_pause(self._ssh_relay_stop, min(60, quota_pause))
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
                        ping_interval=20, ping_timeout=20, open_timeout=15, close_timeout=5) as socket:
                        if socket.subprotocol != "citadel-ssh-agent-v1":
                            raise RuntimeError("ssh_relay_protocol_mismatch")
                        self.log.write("ssh_relay_connected")
                        delay = 2
                        await asyncio.wait_for(
                            self._ssh_relay_session(socket, node_id, port, client_key, known_hosts, asyncssh),
                            timeout=1800
                        )
                except Exception as error:
                    self.log.write("ssh_relay_disconnected", reason=type(error).__name__)
                    retry = ssh_handshake_retry_after(error)
                    if retry > 0:
                        self._ssh_retry_at = max(self._ssh_retry_at, time.monotonic() + retry)
                jitter = 0.75 + _SECURE_RANDOM.random() * 0.5
                await interruptible_relay_pause(self._ssh_relay_stop, min(60, delay * 2) * jitter)
                delay = min(60, delay * 2)
        finally:
            server.close()
            with contextlib.suppress(asyncio.TimeoutError, OSError):
                await asyncio.wait_for(server.wait_closed(), timeout=5.0)

    async def _ssh_relay_session(self, socket, node_id, port, client_key, known_hosts, asyncssh) -> None:
        active = None
        reader = None
        active_session_id = None

        async def stop():
            nonlocal active, reader, active_session_id
            current_reader, reader = reader, None
            current_active, active = active, None
            active_session_id = None
            if current_reader:
                current_reader.cancel()
                with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
                    await asyncio.wait_for(current_reader, timeout=2.0)
            if current_active:
                connection, process = current_active
                with contextlib.suppress(Exception):
                    process.close()
                with contextlib.suppress(Exception):
                    connection.close()
                with contextlib.suppress(asyncio.TimeoutError, Exception):
                    await asyncio.wait_for(connection.wait_closed(), timeout=5.0)

        async def output_loop(process):
            try:
                while chunk := await process.stdout.read(8192):
                    await asyncio.wait_for(socket.send(chunk), timeout=10.0)
                await asyncio.wait_for(
                    socket.send(json.dumps({"type": "exit", "code": process.exit_status})),
                    timeout=10.0
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                return

        try:
            async for message in socket:
                if isinstance(message, bytes):
                    if active and len(message) <= 8192:
                        with contextlib.suppress(Exception):
                            active[1].stdin.write(message)
                    continue
                if not isinstance(message, str) or len(message) > 8192:
                    continue
                try:
                    command = json.loads(message)
                except (ValueError, TypeError):
                    continue
                if not isinstance(command, dict) or not isinstance(command.get("type"), str):
                    continue
                cmd_type = command["type"]
                if cmd_type == "stop":
                    # A delayed stop from an old ticket cannot terminate a new session.
                    if active and command.get("session_id") == active_session_id:
                        await stop()
                elif cmd_type == "resize" and active:
                    cols, rows = command.get("cols"), command.get("rows")
                    if (type(cols) is int and type(rows) is int
                            and 20 <= cols <= 300 and 5 <= rows <= 150):
                        with contextlib.suppress(Exception):
                            active[1].change_terminal_size(cols, rows)
                elif cmd_type == "start" and not active:
                    expires = command.get("expires_at")
                    session_id = command.get("session_id")
                    if (type(expires) is not int or not 0 < expires - time.time() <= 1800
                            or not isinstance(session_id, str) or not 0 < len(session_id) <= 128):
                        continue
                    connection = None
                    try:
                        connection = await asyncssh.connect(
                            "127.0.0.1", port, username="citadel",
                            client_keys=[client_key], known_hosts=known_hosts,
                            agent_path=None, connect_timeout=10
                        )
                        process = await asyncio.wait_for(
                            connection.create_process(term_type="xterm", encoding=None),
                            timeout=10.0
                        )
                        active = (connection, process)
                        active_session_id = session_id
                        await asyncio.wait_for(
                            socket.send(json.dumps({"type": "ready", "node_id": node_id})),
                            timeout=10.0
                        )
                        reader = asyncio.create_task(output_loop(process))
                    except Exception:
                        if active:
                            await stop()
                        elif connection:
                            with contextlib.suppress(Exception):
                                connection.close()
                            with contextlib.suppress(asyncio.TimeoutError, Exception):
                                await asyncio.wait_for(connection.wait_closed(), timeout=5.0)
                        with contextlib.suppress(Exception):
                            await asyncio.wait_for(
                                socket.send(json.dumps({"type": "error", "code": "ssh_connection_failed"})),
                                timeout=5.0
                            )
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
    """Check local activation for legacy bridge updates without a second network call.

    The running agent's heartbeat after restart is the Controller's proof that
    the new version is live. A transient failure of a second request here must
    not roll back already verified files.
    """
    config = v1.AgentConfig.from_file(config_path)
    agent = Agent(config, config_path)
    agent.identity.require_key()
    node_id = agent.identity.node_id
    if not node_id:
        raise RuntimeError("node is not enrolled")
    print(json.dumps({
        "ok": True,
        "node_id": node_id,
        "agent_version": VERSION,
        "check": "local_activation",
    }))
    return 0


def enrollment_probe(config_path: Path) -> int:
    """Enroll and verify a signed heartbeat before a Windows installer cutover."""
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
        choices=["doctor", "enroll", "probe", "enroll-probe", "once", "run", "self-test", "startup-check"],
    )
    parser.add_argument("--config", default="agent/config.json")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "self-test":
        try:
            return self_test()
        except Exception as error:
            # Historical updaters discard child stderr and remove staging.
            # Preserve only source locations and fixed assertion labels, never
            # exception text, paths, credentials or test identity key material.
            stage = Path(__file__).resolve().parent
            journal = stage.parent / "agent.jsonl"
            if stage.name.startswith("citadel-update-") and journal.is_file():
                frames = [frame for frame in traceback.extract_tb(error.__traceback__)
                          if Path(frame.filename).name in {"citadel_node_v1.py", "citadel_node_v2.py"}]
                label = str(error)
                assertion = label.removeprefix("self-test failed: ") if label.startswith("self-test failed: ") else None
                with contextlib.suppress(OSError):
                    v1.JsonlLogger(journal).write("agent_update_preflight_failed", version=VERSION,
                        exception_type=type(error).__name__, assertion=assertion,
                        source_locations=[{"file": Path(frame.filename).name, "line": frame.lineno,
                                           "function": frame.name} for frame in frames[-6:]])
            raise
    if args.command == "startup-check":
        return startup_check(Path(args.config))
    if args.command == "probe":
        return controller_probe(Path(args.config))
    if args.command == "enroll-probe":
        return enrollment_probe(Path(args.config))
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
