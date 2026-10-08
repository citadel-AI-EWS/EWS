"""Install official llmster and prove a downloaded model generates real tokens."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import citadel_node_v1 as node


def main():
    revision = os.environ.get("CITADEL_TEST_REVISION") or subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=30).strip()
    if len(revision) != 40 or any(c not in "0123456789abcdef" for c in revision):
        raise RuntimeError("invalid test revision")
    name = "install_llmstudio_headless.ps1" if os.name == "nt" else "install_llmstudio_headless.sh"
    # Match the canonical HTTP helper bytes even on a CRLF Windows checkout.
    helper_bytes = subprocess.check_output(["git", "show", f"HEAD:agent/lmstudio/{name}"],
                                         cwd=ROOT, timeout=30)
    model = "lmstudio-community/Qwen2.5-0.5B-Instruct-GGUF"
    with tempfile.TemporaryDirectory(prefix="citadel-lm-", dir=os.environ.get("RUNNER_TEMP")) as directory:
        agent = node.Agent(node.AgentConfig("https://example.invalid", Path(directory)))
        # No Controller or fleet identity is involved in this ephemeral test.
        # Runtime installation, model transfer, load and inference are real.
        agent.report_ai_state = agent.save_lmstudio_state
        try:
            agent.install_lmstudio({"asset": {
                "path": name,
                "url": f"https://raw.githubusercontent.com/citadel-AI-EWS/EWS/{revision}/agent/lmstudio/{name}",
                "sha256": hashlib.sha256(helper_bytes).hexdigest(),
            }})
            payload = {"model": model, "source": "huggingface", "quantization": "Q4_K_M"}
            agent.download_lmstudio_model(payload)
            agent.load_lmstudio_model({**payload, "settings": {"context_length": 2048}})
            # This path performs its own actual inference-readiness request,
            # then a streamed request. A listed model is not enough to pass.
            answer = agent.stream_lmstudio_answer("Reply with the single word hi.",
                {"temperature": 0.0, "max_output_tokens": 16}, "query_real_runtime_1234")
            assert answer.strip(), "real model returned no tokens"
            assert agent.probe_lmstudio()["inference_ready"], "inference proof missing"
            print(json.dumps({"test": "official-llmster-real-model", "platform": sys.platform,
                "model": model, "downloaded": True, "loaded": True,
                "inference_verified": True, "answer": answer[:160]}))
        finally:
            if agent.find_lms():
                for argv in (["unload", "--all"], ["server", "stop"], ["daemon", "down"]):
                    try:
                        agent.run_lms(argv, timeout=30)
                    except RuntimeError:
                        pass
                # Windows releases backend DLL handles after the child workers
                # exit. Wait only for executables inside this isolated test home.
                owned = []
                runtime_home = agent.lmstudio_runtime_home()
                for process in node.psutil.process_iter(["exe"]):
                    try:
                        executable = process.info.get("exe")
                        if executable and Path(executable).resolve().is_relative_to(runtime_home):
                            owned.append(process)
                    except (node.psutil.NoSuchProcess, node.psutil.AccessDenied, OSError):
                        continue
                _, alive = node.psutil.wait_procs(owned, timeout=20)
                if alive:
                    raise RuntimeError("isolated LM Studio test workers did not stop")


if __name__ == "__main__":
    main()
