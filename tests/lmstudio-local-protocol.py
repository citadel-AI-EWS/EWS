#!/usr/bin/env python3
from __future__ import annotations

import http.server
import json
import socketserver
import sys
import tempfile
import threading
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
        agent.save_lmstudio_state(loaded_model="test/model", selected_model="test/model")

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

        print("LM Studio REST + OpenAI-compatible local protocols: PASS")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
