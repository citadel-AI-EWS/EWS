#!/usr/bin/env python3
"""CITADEL/EWS node v0.3: bounded node, telemetry and signed self-update.

Telemetry only uploads the node's own JSONL operational events to the existing
Controller. It does not add remote execution, credential collection, discovery,
or any new command capability.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any, Callable

import citadel_node_v1 as v1

VERSION = "0.3.3"
v1.VERSION = VERSION
v1.USER_AGENT = f"CITADEL-EWS-Node/{VERSION}"

WARN_EVENTS = {
    "resource_guard",
    "assignment_rejected_local",
    "result_queued",
    "command_signature_rejected",
}
ERROR_EVENTS = {
    "cycle_error",
    "command_failed",
    "command_failure_ack_failed",
}
ALLOWED_EVENTS = {
    "agent_start",
    "agent_stop",
    "node_enrolled",
    "windows_sleep_inhibit",
    "cycle_error",
    "resource_guard",
    "assignment_rejected_local",
    "result_submitted",
    "result_queued",
    "queued_results_flushed",
    "command_signature_rejected",
    "command_completed",
    "agent_updated",
    "agent_update_rolled_back",
    "agent_update_healthcheck_passed",
    "agent_update_manual_rollback",
    "agent_restart_requested",
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

    def submit_telemetry(self, payload: dict[str, Any]) -> None:
        node_id = self.require_node_id()
        self.api.request("POST", f"/api/v1/nodes/{node_id}/logs", payload)

    def cycle(self) -> None:
        super().cycle()
        node_id = self.require_node_id()
        self.telemetry.flush(node_id, self.submit_telemetry)


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


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=f"CITADEL/EWS Cloudflare v1 node agent {VERSION}"
    )
    parser.add_argument(
        "command",
        choices=["doctor", "enroll", "once", "run", "self-test", "startup-check"],
    )
    parser.add_argument("--config", default="agent/config.json")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "self-test":
        return self_test()
    if args.command == "startup-check":
        return startup_check(Path(args.config))
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
