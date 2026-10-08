"""HTTP protocol simulation for LM Studio 0.3 and 0.4, with real agent code."""
import http.server
import json
import subprocess
import sys
import tempfile
import threading
import time
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
                         {"identifier": "qwen/test-model", "type": "llm", "modelKey": "qwen/test-model", "quantization": "Q4_K_M"}]
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

    def test_legacy_load_selects_and_verifies_the_requested_variant(self):
        base_cli = self.agent.run_lms
        selected = "qwen/test-model-Q4_K_M.gguf"
        wrong = "qwen/test-model-Q8_0.gguf"
        loaded_key = selected

        def cli(args, timeout):
            if args == ["ls", "--json"]:
                value = [{"modelKey": "qwen/test-model", "variants": [wrong, selected], "selectedVariant": wrong}]
            elif args == ["ls", "qwen/test-model", "--json"]:
                value = [{"modelKey": wrong}, {"modelKey": selected}]
            elif args == ["ps", "--json"]:
                value = [{"identifier": "qwen/test-model", "type": "llm", "modelKey": loaded_key}]
            else:
                return base_cli(args, timeout)
            self.commands.append(list(args))
            return SimpleNamespace(stdout=json.dumps(value), returncode=0)

        self.agent.run_lms = cli
        payload = {"model": "qwen/test-model", "quantization": "Q4_K_M"}
        self.agent.load_lmstudio_model(payload)
        self.assertIn(["load", selected, "--identifier", "qwen/test-model", "--yes"], self.commands)
        self.assertNotIn(["load", "qwen/test-model", "--identifier", "qwen/test-model", "--yes"], self.commands)
        loaded_key = wrong
        with self.assertRaisesRegex(RuntimeError, "lmstudio_loaded_variant_mismatch"):
            self.agent.load_lmstudio_model(payload)

    def test_installer_revision_remains_in_the_reviewed_repository(self):
        name = "install_llmstudio_headless.ps1" if node.os.name == "nt" else "install_llmstudio_headless.sh"
        def payload(revision, owner="citadel-AI-EWS"):
            return {"asset": {"path": name, "sha256": "a" * 64,
                "url": f"https://raw.githubusercontent.com/{owner}/EWS/{revision}/agent/lmstudio/{name}"}}
        self.assertTrue(self.agent.validate_lmstudio_install_payload(payload("main")))
        self.assertTrue(self.agent.validate_lmstudio_install_payload(payload("a" * 40)))
        self.assertFalse(self.agent.validate_lmstudio_install_payload(payload("unreviewed-branch")))
        self.assertFalse(self.agent.validate_lmstudio_install_payload(payload("a" * 40, "different-owner")))


class CliLifecycleTests(unittest.TestCase):
    def test_long_cli_observes_stop_cancel_and_timeout(self):
        # A real child process stands in for the long official get/load CLI.
        # It must have exited before run_lms returns the original stop reason.
        for reason in ("stop", "cancel", "timeout"):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                agent = node.Agent(node.AgentConfig("https://example.invalid", root))
                agent.find_lms = lambda: sys.executable
                ready = root / "child.pid"
                script = "import os,time,sys;from pathlib import Path;Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(60)"
                failures = []

                def invoke():
                    try:
                        agent.run_lms(["-c", script, str(ready)], timeout=1 if reason == "timeout" else 60)
                    except BaseException as error:
                        failures.append(error)

                worker = threading.Thread(target=invoke)
                worker.start()
                deadline = time.monotonic() + 5
                while not ready.exists() and worker.is_alive() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(ready.exists(), "CLI child must start before the stop request")
                pid = int(ready.read_text())
                if reason == "stop":
                    agent.stop_path.write_text("stop")
                elif reason == "cancel":
                    agent._operation_cancel_requested.set()
                worker.join(8)
                self.assertFalse(worker.is_alive(), "long CLI must stop promptly")
                self.assertEqual(len(failures), 1)
                expected = {"stop": SystemExit, "cancel": node.OperationCancelled,
                            "timeout": subprocess.TimeoutExpired}[reason]
                self.assertIsInstance(failures[0], expected)
                self.assertFalse(node.psutil.pid_exists(pid), "CLI child must be reaped")

    def test_cli_preserves_output_and_exit_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = node.Agent(node.AgentConfig("https://example.invalid", Path(directory)))
            agent.find_lms = lambda: sys.executable
            result = agent.run_lms(["-c", "print('official-cli-output')"], timeout=5)
            self.assertEqual(result.stdout.strip(), "official-cli-output")
            result = agent.run_lms(["-c", "import sys;sys.stdout.buffer.write('Привет 🦉'.encode('utf-8'))"], timeout=5)
            self.assertEqual(result.stdout, "Привет 🦉")
            with self.assertRaisesRegex(RuntimeError, "official-cli-failure"):
                agent.run_lms(["-c", "import sys;print('official-cli-failure',file=sys.stderr);sys.exit(2)"], timeout=5)


if __name__ == "__main__":
    unittest.main()
