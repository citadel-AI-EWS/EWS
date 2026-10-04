"""Real local HTTP traffic verifies quota backpressure and durable result retries."""
import datetime as dt
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import citadel_node_v1 as node


class QuotaRetryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.status = 503
        self.code = "controller_d1_daily_read_limit_exceeded"
        self.retry_header = "10"
        self.reply = {}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                owner.calls.append((self.path, body))
                self.send_response(owner.status)
                self.send_header("Content-Type", "application/json")
                if owner.retry_header is not None:
                    self.send_header("Retry-After", owner.retry_header)
                self.end_headers()
                self.wfile.write(json.dumps({"error": owner.code, **owner.reply}).encode())
            def log_message(self, *_args):
                pass
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        config = node.AgentConfig(f"http://127.0.0.1:{self.server.server_port}", Path(self.temp.name))
        identity = node.Identity(Path(self.temp.name) / "identity.json")
        identity.set_node_id("node_local_test")
        self.client = node.ApiClient(config, identity)

    def test_shared_pause_sends_no_extra_http_and_resumes_after_deadline(self):
        with patch.object(node.time, "monotonic", return_value=1000):
            with self.assertRaises(node.ControllerApiError) as result:
                self.client.request("POST", "/sync", {})
            self.assertEqual(result.exception.retry_after_seconds, 10)
            for route in ["/heartbeat", "/logs", "/results"]:
                with self.assertRaises(node.ControllerApiError):
                    self.client.request("POST", route, {})
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(self.client.retry_delay(), 10)
        self.status = 200
        with patch.object(node.time, "monotonic", return_value=1011):
            self.assertEqual(self.client.retry_delay(), 0)
            self.client.request("POST", "/sync", {})
        self.assertEqual(len(self.calls), 2)

    def test_results_survive_quota_and_agent_queue_reopen(self):
        path = Path(self.temp.name) / "results.json"
        queue = node.ResultQueue(path)
        result = {"assignment_id": "a1", "actual_response": "model response"}
        queue.push(result)
        with patch.object(node.time, "monotonic", return_value=1000):
            self.assertEqual(queue.flush(lambda value: self.client.request("POST", "/results", value)), 0)
            self.assertEqual(json.loads(path.read_text()), [result])
        self.status = 200
        with patch.object(node.time, "monotonic", return_value=1011):
            reopened = node.ResultQueue(path)
            self.assertEqual(reopened.flush(lambda value: self.client.request("POST", "/results", value)), 1)
        self.assertEqual(json.loads(path.read_text()), [])
        self.assertEqual(json.loads(self.calls[-1][1]), result)

    def test_http_date_and_json_retry_hints(self):
        for source in ["date", "json"]:
            with self.subTest(source=source):
                self.client._retry_until = 0
                self.retry_header = format_datetime(dt.datetime.fromtimestamp(2000, dt.timezone.utc), usegmt=True) if source == "date" else None
                self.reply = {} if source == "date" else {"retry_after_seconds": 15}
                with patch.object(node.time, "time", return_value=1980):
                    with self.assertRaises(node.ControllerApiError) as result:
                        self.client.request("POST", "/sync", {})
                self.assertEqual(result.exception.retry_after_seconds, 20 if source == "date" else 15)

    def test_old_hub_without_hint_uses_utc_reset(self):
        self.retry_header = None
        with self.assertRaises(node.ControllerApiError) as result:
            self.client.request("POST", "/sync", {})
        self.assertGreater(result.exception.retry_after_seconds, 0)
        self.assertLessEqual(result.exception.retry_after_seconds, 86400)

    def test_auth_and_transient_errors_do_not_open_daily_pause(self):
        for status, code in [(401, "invalid_signature"), (503, "node_replay_store_unavailable")]:
            self.status, self.code = status, code
            for _ in range(2):
                with self.assertRaises(node.ControllerApiError):
                    self.client.request("POST", "/sync", {})
            self.assertEqual(self.client.retry_delay(), 0)
        self.assertEqual(len(self.calls), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
