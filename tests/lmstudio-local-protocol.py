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

SEEN: dict[str, object] = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        body = json.loads(raw.decode("utf-8"))
        SEEN["path"] = self.path
        SEEN["body"] = body
        payload = (
            'event: message.delta\n'
            'data: {"type":"message.delta","content":"LM "}\n\n'
            'event: message.delta\n'
            'data: {"type":"message.delta","content":"OK"}\n\n'
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
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

        with ReusableTCPServer(("127.0.0.1", 1234), Handler) as server:
            thread = threading.Thread(target=server.handle_request, daemon=True)
            thread.start()
            answer = agent.stream_lmstudio_answer(
                "ping",
                {"temperature": 0.1, "max_output_tokens": 32},
                "request_ci_12345678",
            )
            thread.join(timeout=5)

        assert answer == "LM OK", answer
        assert SEEN["path"] == "/api/v1/chat", SEEN
        body = SEEN["body"]
        assert isinstance(body, dict)
        assert body["model"] == "test/model"
        assert body["input"] == "ping"
        assert body["stream"] is True
        assert body["temperature"] == 0.1
        print("LM Studio local streaming protocol: PASS")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
