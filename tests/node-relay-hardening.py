"""Regression coverage for relay retry, telemetry cursor and thread lifecycle."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import citadel_node_v1 as v1
import citadel_node_v2 as v2


class NodeHardeningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / "agent.jsonl"
        self.cursor = v2.TelemetryCursor(self.log, self.root / "cursor.json")

    @staticmethod
    def event(number):
        return json.dumps({"ts": "2026-10-10T20:00:00+00:00",
                           "event": "agent_start", "index": number}) + "\n"

    def test_partial_line_not_committed(self):
        self.log.write_text(self.event(1)[:-1], encoding="utf-8")
        payloads = []
        self.assertEqual(self.cursor.flush("n", payloads.append), 0)
        self.assertEqual(payloads, [])
        with self.log.open("a", encoding="utf-8") as stream:
            stream.write("\n")
        self.assertEqual(self.cursor.flush("n", payloads.append), 1)
        self.assertEqual(self.cursor.flush("n", payloads.append), 0)

    def test_rotated_larger_file_resets_cursor(self):
        self.log.write_text(self.event(1), encoding="utf-8")
        received = []
        self.assertEqual(self.cursor.flush("n", received.append), 1)
        self.log.rename(self.root / "agent.jsonl.1")
        self.log.write_text(self.event(2) + self.event(3), encoding="utf-8")
        self.assertEqual(self.cursor.flush("n", received.append), 2)
        self.assertEqual(received[-1]["events"][0]["details"]["index"], 2)

    def test_failed_upload_is_retried_with_same_id(self):
        self.log.write_text(self.event(1), encoding="utf-8")
        events = []
        def failed(payload):
            events.append(payload["events"][0]["event_id"])
            raise ConnectionError("simulated outage")
        with self.assertRaises(ConnectionError):
            self.cursor.flush("n", failed)
        self.assertEqual(self.cursor.flush("n", lambda payload: events.append(
            payload["events"][0]["event_id"])), 1)
        self.assertEqual(events[0], events[1])

    def test_cursor_write_failure_must_raise(self):
        self.log.write_text(self.event(1), encoding="utf-8")
        with patch.object(v1, "atomic_write", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                self.cursor.flush("n", lambda _payload: None)
        self.assertEqual(self.cursor.flush("n", lambda _payload: None), 1)

    def test_corrupt_and_oversize_records_are_bounded(self):
        self.log.write_bytes(b"{bad json}\n" + b"x" * (v2.MAX_LOG_LINE_BYTES + 5) +
                             b"\n" + self.event(10).encode())
        uploads = []
        self.assertEqual(self.cursor.flush("n", uploads.append), 1)
        self.assertEqual(uploads[0]["events"][0]["details"]["index"], 10)

    def test_parallel_flush_does_not_duplicate_events(self):
        self.log.write_text(self.event(1), encoding="utf-8")
        uploaded = []
        def submit(payload):
            uploaded.append(payload)
            time.sleep(0.03)
        with ThreadPoolExecutor(max_workers=2) as executor:
            jobs = [executor.submit(self.cursor.flush, "n", submit) for _ in range(2)]
            self.assertEqual(sorted(job.result(timeout=3) for job in jobs), [0, 1])
        self.assertEqual(len(uploaded), 1)

    def test_retry_after_both_websocket_error_apis(self):
        new = RuntimeError("handshake")
        new.response = SimpleNamespace(status_code=503, headers={"Retry-After": "60"})
        old = RuntimeError("legacy")
        old.status_code = 429
        old.headers = {"Retry-After": "30"}
        self.assertEqual(v2.ssh_handshake_retry_after(new), 60)
        self.assertEqual(v2.ssh_handshake_retry_after(old), 30)
        old.status_code = 401
        self.assertEqual(v2.ssh_handshake_retry_after(old), 0)
        new.response.headers["Retry-After"] = "bogus"
        self.assertEqual(v2.ssh_handshake_retry_after(new), 0)

    def test_retry_after_http_date(self):
        from datetime import datetime, timezone
        from email.utils import format_datetime
        later = datetime.fromtimestamp(1100, tz=timezone.utc)
        error = RuntimeError("date")
        error.response = SimpleNamespace(
            status_code=503, headers={"Retry-After": format_datetime(later, usegmt=True)})
        with patch.object(v2.time, "time", return_value=1000):
            self.assertAlmostEqual(v2.ssh_handshake_retry_after(error), 100)

    def test_background_thread_run_never_registers_signal_handlers(self):
        agent = v2.Agent(v1.AgentConfig("https://example.invalid", self.root))
        agent.cycle = Mock(side_effect=KeyboardInterrupt())
        agent.config.prevent_automatic_sleep = False
        with patch.object(v2.signal, "signal", side_effect=AssertionError("not main")):
            with ThreadPoolExecutor(max_workers=1) as executor:
                self.assertEqual(executor.submit(agent.run, True).result(timeout=5), 0)

    def test_main_thread_handlers_restored(self):
        agent = v2.Agent(v1.AgentConfig("https://example.invalid", self.root))
        agent.cycle = Mock(side_effect=KeyboardInterrupt())
        agent.config.prevent_automatic_sleep = False
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
        self.assertEqual(agent.run(once=True), 0)
        self.assertEqual(before, {sig: signal.getsignal(sig) for sig in before})


class RelayFrameTests(unittest.IsolatedAsyncioTestCase):
    async def test_bad_control_frames_do_not_open_session(self):
        frames = [
            "[]", "null", "123", '""',
            '{"type":"start","expires_at":true,"session_id":"s1"}',
            '{"type":"start","expires_at":999999999999,"session_id":"s1"}',
            '{"type":"start","expires_at":1,"session_id":"s1"}',
            '{"type":"start","expires_at":123,"session_id":[]}',
            '{"type":"resize","cols":true,"rows":10}',
            '{"type":"stop","session_id":true}',
        ]
        class Socket:
            def __aiter__(self):
                async def stream():
                    for msg in frames:
                        yield msg
                return stream()
            async def send(self, *_args):
                raise AssertionError("unexpected outgoing SSH frame")
        class FakeAgent:
            _ssh_relay_session = v2.Agent._ssh_relay_session
        fake = FakeAgent()
        asyncssh = SimpleNamespace(connect=Mock(side_effect=AssertionError("bad start accepted")))
        await fake._ssh_relay_session(Socket(), "n", 1234, None, None, asyncssh)

    async def test_interruptible_pause_does_not_leave_executor_workers(self):
        flag = threading.Event()
        task = asyncio.create_task(v2.interruptible_relay_pause(flag, 1000))
        flag.set()
        await asyncio.wait_for(task, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
