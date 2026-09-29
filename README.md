# CITADEL EWS

CITADEL EWS is an experimental distributed AI workspace for coordinating physical nodes, local AI runtimes, bounded mini-agents, and multi-node task execution from a central Hub.

> **Status:** active public prototype. This repository is not production-ready and should be tested only on machines and data you can safely use for experimentation.

## We need testers

We are actively looking for testers with Windows PCs, especially people who use local AI, LM Studio/llmster, homelab machines, or more than one computer.

The highest-value tests right now are:

- clean Windows agent installation and enrollment;
- reboot / restart / recovery behavior;
- loss and restoration of network connectivity;
- LM Studio/llmster install, probe, model download/load, and local prompt execution;
- one-node and multi-node prompt dispatch;
- mini-agent behavior and result aggregation;
- uninstall / repair / update paths;
- behavior on different hardware profiles.

You do **not** need to be a developer to help.

Start here: **[TESTING.md](TESTING.md)**

If something fails, open a **Bug report**. If a test succeeds or partially succeeds, use the **Test result** issue form so we can compare machines and environments.

## What the project contains

The current codebase includes:

- a Cloudflare Worker control plane and Hub UI;
- node enrollment, telemetry, status, and command paths;
- a Windows node agent and installer tooling;
- local LM Studio/llmster integration helpers;
- hardware-aware model recommendations and model search paths;
- bounded local mini-agent execution;
- multi-node scheduling/fan-out logic;
- Python-only task execution paths;
- update, recovery, rollback, and observability work;
- automated regression and validation tests.

The presence of a feature in the repository does **not** mean every real-world path is already reliable. Public testing is intended to find those gaps.

## Current versions

- Worker / control-plane version: **0.4.0**
- Latest packaged Windows test agent in this repository: **0.3.20**

See the checked-in test packages under [releases/](releases/).

## Quick test path

1. Read [TESTING.md](TESTING.md).
2. Use a disposable or non-critical Windows test machine.
3. Download the latest test package from [releases/](releases/).
4. Verify its SHA-256 file before running it.
5. Run only the included documented installer.
6. Record whether the node installs, starts, survives reboot, reconnects, and appears correctly in the test environment available to you.
7. If testing local AI, exercise LM Studio/llmster probe, model handling, and a prompt.
8. Report the result through GitHub Issues.

Do not post controller tokens, API keys, private logs, client data, passwords, machine secrets, or other credentials.

## Architecture areas under active test

### Windows node lifecycle

The Windows path is designed around a persistent service-style agent, automatic recovery, preserved node identity, update/rollback logic, and sleep/network resilience. Real-machine behavior across Windows versions and hardware is a priority test area.

### Local AI

The node code contains LM Studio/llmster install/probe/model-control paths and local prompt execution. We specifically want reports from machines where LM Studio is already installed and from clean machines where CITADEL performs the setup.

### Multi-node execution

The control plane contains scheduling and fan-out logic for distributing work across physical nodes. We want evidence from real fleets of 2, 3, and more machines, including partial availability and node failures.

### Mini-agents

Local AI tasks can use bounded mini-agents for primary work, verification, and edge-case analysis before synthesis. We want to verify that this behaves consistently on different RAM/CPU/GPU configurations.

## Repository layout

```text
.
├── agent/                       # Node agent, Windows/Linux setup and local-AI helpers
├── src/                         # Cloudflare Worker / controller logic
├── tests/                       # Regression tests
├── releases/                    # Checked-in test agent packages and hashes
├── hub.html                     # Hub UI
├── operations.html              # Operations UI
├── TESTING.md                   # Public testing guide
├── CONTRIBUTING.md
├── SECURITY.md
└── VERSION
```

## Contributing

You can help by:

- testing on real hardware;
- filing reproducible bugs;
- posting successful/partial test results;
- reviewing Issues and Pull Requests;
- improving installation documentation;
- submitting focused Pull Requests.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting code.

## Security

Do not publish credentials, private keys, recovery material, access tokens, client data, or real infrastructure secrets in Issues, Discussions, commits, screenshots, logs, or Pull Requests.

See [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
