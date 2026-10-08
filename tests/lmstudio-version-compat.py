"""HTTP protocol simulation for LM Studio 0.3 and 0.4, with real agent code."""
import http.server
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import citadel_node_v1 as node


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        self.server.requests.append((self.path, body))
        if self.path.startswith("/api/v1/"):
            self.send_response(self.server.native_status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":"native API unavailable"}')
            return
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for text in ("h", "i"):
            self.wfile.write(("data: " + json.dumps({"choices": [{"delta": {"content": text}}]}) + "\n\n").encode())
        if not self.server.truncated:
            self.wfile.write(b'data: [DONE]\n\n')


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.agent = node.Agent(node.AgentConfig("https://example.invalid", Path(self.temp.name)))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 1234), Handler)
        self.server.native_status = 404
        self.server.truncated = False
        self.server.requests = []
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.commands = []

        def cli(args, timeout):
            self.commands.append(list(args))
            if args[0] == "ls":
                value = [{"modelKey": "qwen/test-model", "type": "llm", "quantization": "Q4_K_M"}]
            elif args[:2] == ["server", "status"]:
                value = {"running": True, "port": 1234}
            elif args[0] == "ps":
                value = [{"identifier": "embedding-test", "type": "embedding"},
                         {"identifier": "qwen/test-model", "type": "llm"}]
            else:
                value = {}
            return SimpleNamespace(stdout=json.dumps(value), returncode=0)

        self.agent.run_lms = cli
        self.agent.find_lms = lambda: "lms"
        self.agent.report_ai_state = self.agent.save_lmstudio_state

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.temp.cleanup()

    def test_legacy_download_load_and_query(self):
        self.agent.download_lmstudio_model({"model": "qwen/test-model"})
        self.assertIn(["get", "qwen/test-model", "--yes"], self.commands)
        self.agent.load_lmstudio_model({"model": "qwen/test-model", "settings": {"context_length": 2048}})
        self.assertIn(["load", "qwen/test-model", "--identifier", "qwen/test-model", "--yes", "--context-length", "2048"], self.commands)
        self.agent.verify_lmstudio_inference = Mock()
        answer = self.agent.stream_lmstudio_answer("hi", {"max_output_tokens": 8}, "query_test_12345")
        self.assertEqual(answer, "hi")
        self.assertEqual(self.server.requests[-1][0], "/v1/chat/completions")
        body = self.server.requests[-1][1]
        self.assertEqual(body["messages"], [{"role": "user", "content": "hi"}])
        self.assertEqual(body["max_tokens"], 8)
        self.assertNotIn("max_output_tokens", body)
        self.assertEqual(self.agent.probe_lmstudio()["loaded_model"], "qwen/test-model")

    def test_authorization_failure_never_uses_cli_or_another_route(self):
        self.server.native_status = 401
        with self.assertRaises(node.LmStudioApiError):
            self.agent.download_lmstudio_model({"model": "qwen/test-model"})
        with self.assertRaises(node.LmStudioApiError):
            self.agent.load_lmstudio_model({"model": "qwen/test-model"})
        self.agent.ensure_lmstudio_ready_for_inference = lambda: "qwen/test-model"
        with self.assertRaisesRegex(RuntimeError, "lmstudio_http_401"):
            self.agent.stream_lmstudio_answer("hi", {}, "query_test_12345")
        self.assertFalse(any(c[0] in {"get", "load"} for c in self.commands))
        self.assertFalse(any(path == "/v1/chat/completions" for path, _ in self.server.requests))

    def test_partial_legacy_stream_is_not_success(self):
        self.server.truncated = True
        self.agent.ensure_lmstudio_ready_for_inference = lambda: "qwen/test-model"
        with self.assertRaisesRegex(RuntimeError, "lmstudio_stream_incomplete"):
            self.agent.stream_lmstudio_answer("hi", {}, "query_test_12345")

    def test_legacy_load_requires_actual_loaded_identifier(self):
        self.agent.probe_lmstudio = lambda: {"loaded_models": []}
        with self.assertRaisesRegex(RuntimeError, "lmstudio_model_not_loaded"):
            self.agent.load_lmstudio_model({"model": "qwen/test-model"})

    def test_unsupported_load_settings_are_not_silently_ignored(self):
        with self.assertRaisesRegex(RuntimeError, "lmstudio_legacy_load_settings_unsupported"):
            self.agent.load_lmstudio_model({"model": "qwen/test-model", "settings": {"flash_attention": True}})
        self.assertFalse(any(c[0] == "load" for c in self.commands))


if __name__ == "__main__":
    unittest.main()
