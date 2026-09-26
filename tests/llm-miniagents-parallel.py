#!/usr/bin/env python3
from __future__ import annotations

import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import citadel_node_v1 as node  # noqa: E402


def make_agent(root: Path) -> node.Agent:
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
    return agent


def main() -> int:
    original_virtual_memory = node.psutil.virtual_memory
    original_gpu_inventory = node.gpu_inventory
    try:
        node.psutil.virtual_memory = lambda: SimpleNamespace(
            total=64 * 1024 ** 3,
            available=48 * 1024 ** 3,
            percent=25.0,
        )
        node.gpu_inventory = lambda: [
            {"name": "Test GPU", "vram_total_bytes": 24 * 1024 ** 3}
        ]

        with tempfile.TemporaryDirectory() as temp:
            agent = make_agent(Path(temp))

            # Short work stays single-agent.
            agent._project_llm_chat = lambda *args, **kwargs: "SHORT OK"
            short = agent.execute_project_text({
                "project_id": "short",
                "work_item_id": "short-1",
                "role_name": "reviewer",
                "task_text": "Check this short task.",
            })
            assert short["mini_agent_requested_count"] == 1, short
            assert short["mini_agent_concurrency"] == 1, short
            assert short["mini_agent_count"] == 1, short
            assert short["content"] == "SHORT OK", short

            # A complex task with sufficient resources must overlap LLM mini-agent calls.
            barrier = threading.Barrier(3)
            active = 0
            max_active = 0
            lock = threading.Lock()

            def parallel_chat(model, system_prompt, user_prompt, *, max_tokens, temperature=0.2, timeout_seconds=None):
                nonlocal active, max_active
                if "synthesis agent" in system_prompt:
                    return "SYNTHESIS OK"
                with lock:
                    active += 1
                    max_active = max(max_active, active)
                try:
                    barrier.wait(timeout=2.0)
                    time.sleep(0.05)
                    return system_prompt.split("mini-agent ", 1)[1].split(" ", 1)[0] + " OK"
                finally:
                    with lock:
                        active -= 1

            agent._project_llm_chat = parallel_chat
            complex_report = agent.execute_project_text({
                "project_id": "complex",
                "work_item_id": "complex-1",
                "role_name": "reviewer",
                "task_text": "X" * 1901,
            })
            assert complex_report["mini_agent_requested_count"] == 3, complex_report
            assert complex_report["mini_agent_concurrency"] == 3, complex_report
            assert complex_report["mini_agent_count"] == 3, complex_report
            assert max_active >= 3, max_active
            assert complex_report["content"] == "SYNTHESIS OK", complex_report

            # One permanently failing secondary worker must not destroy successful work.
            def partial_failure_chat(model, system_prompt, user_prompt, *, max_tokens, temperature=0.2, timeout_seconds=None):
                if "synthesis agent" in system_prompt:
                    return "PARTIAL SYNTHESIS OK"
                if "mini-agent 2 " in system_prompt:
                    raise RuntimeError("simulated_secondary_failure")
                return "SURVIVOR"

            agent._project_llm_chat = partial_failure_chat
            partial = agent.execute_project_text({
                "project_id": "partial",
                "work_item_id": "partial-1",
                "role_name": "reviewer",
                "task_text": "Y" * 1901,
            })
            assert partial["mini_agent_requested_count"] == 3, partial
            assert partial["mini_agent_count"] == 2, partial
            assert partial["content"] == "PARTIAL SYNTHESIS OK", partial
            assert partial["mini_agent_failures"] == [
                {"mini_agent_id": "llm-mini-2", "error": "simulated_secondary_failure"}
            ], partial

        print("LLM mini-agent bounded parallelism: PASS")
        return 0
    finally:
        node.psutil.virtual_memory = original_virtual_memory
        node.gpu_inventory = original_gpu_inventory


if __name__ == "__main__":
    raise SystemExit(main())
