"""Actual local SSH session through the node's outbound WebSocket relay."""
import asyncio
import json
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import asyncssh
import websockets
from citadel_node_v2 import Agent


async def main():
    with tempfile.TemporaryDirectory() as directory:
        config_path = Path(directory) / "config.json"
        config_path.write_text("{}", encoding="utf-8")
        events = []

        class FakeAgent:
            _managed_windows_ssh_target = Agent._managed_windows_ssh_target
            _ssh_relay_session = Agent._ssh_relay_session
            _ssh_relay_loop = Agent._ssh_relay_loop

        agent = FakeAgent()
        agent.config_path = config_path
        agent._ssh_relay_stop = threading.Event()
        agent.identity = SimpleNamespace(sign=lambda message: "test-signature")
        agent.api = SimpleNamespace(base_path="", retry_delay=lambda: 0)
        agent.log = SimpleNamespace(write=lambda name, **fields: events.append((name, fields)))
        finished = asyncio.Event()

        async def controller(socket):
            await socket.send(json.dumps({"type": "start", "session_id": "test",
                "expires_at": int(time.time()) + 1700}))
            output = bytearray()
            ready = False
            sent_hostname = False
            sent_exit = False
            async for frame in socket:
                if isinstance(frame, str):
                    value = json.loads(frame)
                    if value.get("type") == "ready":
                        assert value["node_id"] == "node_test"
                        ready = True
                    if value.get("type") == "error":
                        raise AssertionError(value)
                    if value.get("type") == "exit":
                        assert sent_exit and value["code"] == 0
                        assert b"DENIED:" in output
                        finished.set()
                        break
                else:
                    output.extend(frame)
                    if ready and b"citadel>" in output and not sent_hostname:
                        await socket.send(b"hostname\r")
                        sent_hostname = True
                    elif sent_hostname and not sent_exit and b"citadel>" in output.split(b"citadel>", 1)[1]:
                        await socket.send(b"id\r")
                        await socket.send(b"exit\r")
                        sent_exit = True
            assert b"CITADEL Restricted SSH Console" in output

        async with websockets.serve(controller, "127.0.0.1", 0,
                subprotocols=["citadel-ssh-agent-v1"]) as server:
            port = server.sockets[0].getsockname()[1]
            agent.config = SimpleNamespace(controller_url=f"http://127.0.0.1:{port}")
            task = asyncio.create_task(agent._ssh_relay_loop("node_test", asyncssh, websockets))
            try:
                await asyncio.wait_for(finished.wait(), 15)
            finally:
                agent._ssh_relay_stop.set()
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        assert any(name == "ssh_relay_local_ready" for name, _ in events)
    print("Node outbound relay -> pinned local SSH -> restricted console: PASS")


if __name__ == "__main__":
    asyncio.run(main())
