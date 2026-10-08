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
    name = "install_llmstudio_headless.ps1" if os.name == "nt" else "install_llmstudio_headless.sh"
    # Match the canonical HTTP helper bytes even on a CRLF Windows checkout.
    helper_bytes = subprocess.check_output(["git", "show", f"HEAD:agent/lmstudio/{name}"],
                                         cwd=ROOT, timeout=30)
    model = "lmstudio-community/Qwen2.5-0.5B-Instruct-GGUF"
    with tempfile.TemporaryDirectory(prefix="citadel-real-lmstudio-") as directory:
        agent = node.Agent(node.AgentConfig("https://example.invalid", Path(directory)))
        # No Controller or fleet identity is involved in this ephemeral test.
        # Runtime installation, model transfer, load and inference are real.
        agent.report_ai_state = agent.save_lmstudio_state
        try:
            agent.install_lmstudio({"asset": {
                "path": name,
                "url": f"https://raw.githubusercontent.com/citadel-AI-EWS/EWS/main/agent/lmstudio/{name}",
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
                for argv in (["server", "stop"], ["daemon", "down"]):
                    try:
                        agent.run_lms(argv, timeout=30)
                    except RuntimeError:
                        pass


if __name__ == "__main__":
    main()
