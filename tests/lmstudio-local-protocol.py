#!/usr/bin/env python3
from __future__ import annotations

import http.server
import json
import socketserver
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import citadel_node_v1 as node  # noqa: E402

SEEN: list[dict[str, object]] = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        body = json.loads(raw.decode("utf-8"))
        SEEN.append({"path": self.path, "body": body})

        if self.path == "/api/v1/chat":
            payload = (
                'event: message.delta\n'
                'data: {"type":"message.delta","content":"LM "}\n\n'
                'event: message.delta\n'
                'data: {"type":"message.delta","content":"OK"}\n\n'
            ).encode("utf-8")
            content_type = "text/event-stream"
        elif self.path == "/v1/chat/completions":
            payload = json.dumps({
                "choices": [{"message": {"role": "assistant", "content": "PROJECT OK"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14},
            }).encode("utf-8")
            content_type = "application/json"
        else:
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main() -> int:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        config = node.AgentConfig(
            "https://example.invalid",
            root,
            controller_public_x="erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0",
        )
        agent = node.Agent(config)
        agent.probe_lmstudio = lambda: {
            "installed": True,
            "daemon_running": True,
            "server_running": True,
            "loaded_model": "test/model",
        }
        # Deliberately stale persisted state: project execution must use the live probe.
        agent.save_lmstudio_state(loaded_model="stale/model", selected_model="test/model")

        with ReusableTCPServer(("127.0.0.1", 1234), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                answer = agent.stream_lmstudio_answer(
                    "ping",
                    {"temperature": 0.1, "max_output_tokens": 32},
                    "request_ci_12345678",
                )
                report = agent.execute_project_text({
                    "project_id": "project_ci",
                    "work_item_id": "work_ci",
                    "role_name": "reviewer",
                    "task_text": "Return PROJECT OK",
                })
            finally:
                server.shutdown()
                thread.join(timeout=5)

        assert answer == "LM OK", answer
        assert report["content"] == "PROJECT OK", report
        assert report["model"] == "test/model", report
        assert report["token_usage"]["total_tokens"] == 14, report
        assert report["token_usage"]["agents"]["llm-mini-1"]["prompt_tokens"] == 11, report

        stream = next(item for item in SEEN if item["path"] == "/api/v1/chat")
        stream_body = stream["body"]
        assert isinstance(stream_body, dict)
        assert stream_body["model"] == "test/model"
        assert stream_body["input"] == "ping"
        assert stream_body["stream"] is True
        assert stream_body["temperature"] == 0.1

        project = next(item for item in SEEN if item["path"] == "/v1/chat/completions")
        project_body = project["body"]
        assert isinstance(project_body, dict)
        assert project_body["model"] == "test/model"
        assert project_body["messages"][-1]["content"] == "Return PROJECT OK"

        # A dead server is restarted before an AI assignment instead of trusting stale state.
        recovery = node.Agent(config)
        recovery.save_lmstudio_state(selected_model="test/model")
        recovery_states = iter([
            {
                "installed": True,
                "server_running": False,
                "loaded_model": None,
                "selected_model": "test/model",
            },
            {
                "installed": True,
                "server_running": True,
                "loaded_model": "test/model",
                "selected_model": "test/model",
            },
        ])
        recovery.probe_lmstudio = lambda: next(recovery_states)
        recovery_commands: list[list[str]] = []
        recovery.run_lms = lambda args, timeout: recovery_commands.append(list(args))
        assert recovery.ensure_lmstudio_ready_for_inference() == "test/model"
        assert recovery_commands == [
            ["daemon", "up"],
            ["server", "start", "--port", "1234"],
        ], recovery_commands

        # A selected local model is reloaded when the server is alive but memory is empty.
        reload_agent = node.Agent(config)
        reload_agent.save_lmstudio_state(selected_model="test/model")
        reload_states = iter([
            {
                "installed": True,
                "server_running": True,
                "loaded_model": None,
                "selected_model": "test/model",
            },
            {
                "installed": True,
                "server_running": True,
                "loaded_model": "test/model",
                "selected_model": "test/model",
            },
        ])
        reload_agent.probe_lmstudio = lambda: next(reload_states)
        reload_payloads: list[dict[str, object]] = []
        reload_agent.load_lmstudio_model = lambda payload: reload_payloads.append(dict(payload))
        assert reload_agent.ensure_lmstudio_ready_for_inference() == "test/model"
        assert reload_payloads == [{
            "model": "test/model",
            "source": "catalog",
            "settings": {},
        }], reload_payloads

        # Prefer the explicitly selected model when several models are live.
        preference = node.Agent(config)
        preference.save_lmstudio_state(selected_model="selected/model")
        class FakeResult:
            def __init__(self, stdout: str) -> None:
                self.stdout = stdout
        preference.find_lms = lambda: "lms"
        def preference_run(args, timeout):
            if args[:2] == ["server", "status"]:
                return FakeResult('{"running":true}')
            if args[:2] == ["ps", "--json"]:
                return FakeResult('[{"model":"other/model"},{"model":"selected/model"}]')
            raise AssertionError(args)
        preference.run_lms = preference_run
        preferred_snapshot = preference.probe_lmstudio()
        assert preferred_snapshot["loaded_model"] == "selected/model", preferred_snapshot

        # Actual inference must do another live preflight under the lifecycle lock.
        guarded = node.Agent(config)
        guard_calls: list[str] = []
        guarded._ensure_lmstudio_ready_for_inference_locked = lambda: guard_calls.append("preflight") or "live/model"
        guarded._project_llm_chat_unlocked = lambda model, *args, **kwargs: (model, None)
        guarded_answer, _ = guarded._project_llm_chat("stale/model", "system", "user", max_tokens=8)
        assert guarded_answer == "live/model", guarded_answer
        assert guard_calls == ["preflight"], guard_calls

        # Duplicate agent instances sharing a data_dir must serialize recovery.
        first = node.Agent(config)
        second = node.Agent(config)
        runtime = {"server": False, "loaded": None, "server_starts": 0}
        runtime_guard = threading.Lock()
        def shared_probe():
            with runtime_guard:
                return {
                    "installed": True,
                    "server_running": runtime["server"],
                    "loaded_model": runtime["loaded"],
                    "selected_model": "test/model",
                }
        def shared_run(args, timeout):
            if args[:2] == ["server", "start"]:
                with runtime_guard:
                    runtime["server_starts"] += 1
                time.sleep(0.15)
                with runtime_guard:
                    runtime["server"] = True
                    runtime["loaded"] = "test/model"
            return None
        for candidate in (first, second):
            candidate.probe_lmstudio = shared_probe
            candidate.run_lms = shared_run
            candidate.save_lmstudio_state(selected_model="test/model")
        barrier = threading.Barrier(3)
        recovery_results: list[str] = []
        recovery_errors: list[str] = []
        def recover(candidate):
            barrier.wait()
            try:
                recovery_results.append(candidate.ensure_lmstudio_ready_for_inference())
            except Exception as error:
                recovery_errors.append(str(error))
        workers = [threading.Thread(target=recover, args=(candidate,)) for candidate in (first, second)]
        for worker in workers:
            worker.start()
        barrier.wait()
        for worker in workers:
            worker.join(timeout=5)
        assert not recovery_errors, recovery_errors
        assert sorted(recovery_results) == ["test/model", "test/model"], recovery_results
        assert runtime["server_starts"] == 1, runtime

        # State updates serialize the read/merge/write transaction, not only os.replace().
        state_agent = node.Agent(config)
        original_atomic_write = node.atomic_write
        write_guard = threading.Lock()
        active_writes = 0
        max_active_writes = 0
        def slow_atomic_write(path, text, mode=0o600):
            nonlocal active_writes, max_active_writes
            with write_guard:
                active_writes += 1
                max_active_writes = max(max_active_writes, active_writes)
            time.sleep(0.05)
            try:
                return original_atomic_write(path, text, mode)
            finally:
                with write_guard:
                    active_writes -= 1
        node.atomic_write = slow_atomic_write
        try:
            writers = [
                threading.Thread(target=state_agent.save_lmstudio_state, kwargs={"race_a": "A"}),
                threading.Thread(target=state_agent.save_lmstudio_state, kwargs={"race_b": "B"}),
            ]
            for worker in writers:
                worker.start()
            for worker in writers:
                worker.join(timeout=5)
        finally:
            node.atomic_write = original_atomic_write
        final_state = state_agent.lmstudio_state()
        assert max_active_writes == 1, max_active_writes
        assert final_state["race_a"] == "A" and final_state["race_b"] == "B", final_state

        print("LM Studio REST + live preflight/self-heal/race guards: PASS")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
