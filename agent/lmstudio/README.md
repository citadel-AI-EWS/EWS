# CITADEL / LM Studio remote-node integration

These reviewed helper scripts let a signed CITADEL node install the official LM Studio headless runtime (**llmster**) without enabling a general remote shell.

- Windows helper: `install_llmstudio_headless.ps1`
- Linux helper: `install_llmstudio_headless.sh`
- Official upstream installers are fetched only from `https://lmstudio.ai/`.
- CITADEL verifies the GitHub-hosted helper script by SHA-256 before running it.
- Model download/load requests are separate signed allowlist commands handled with fixed `lms` argv; user-provided shell text is never executed.

The headless runtime is the recommended LM Studio deployment for remote servers and GPU nodes. After installation, the node can use `lms get`, `lms load`, and the local server on port 1234.
