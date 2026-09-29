# CITADEL EWS Public Testing Guide

Thank you for testing CITADEL EWS.

The goal of public testing is to collect evidence from real machines: what installs, what survives reboot, what reconnects, what fails, and how local/multi-node AI behaves outside the development environment.

## Safety first

Use a spare, disposable, or otherwise non-critical test machine.

Do not use:

- employer-managed computers without permission;
- machines containing sensitive client data;
- production infrastructure;
- credentials or secrets you would not publish;
- irreplaceable data without a backup.

CITADEL EWS is an active prototype. A failed install, update, model download, service restart, or uninstall is exactly the kind of problem we want to discover.

## Recommended Windows test package

Current checked-in package:

`releases/CITADEL_FIXED_AGENT_0.3.20_2026-09-28.zip`

Matching checksum file:

`releases/CITADEL_FIXED_AGENT_0.3.20_2026-09-28.zip.sha256`

Always verify the package checksum before running it. If a newer package appears in `releases/`, test the newest package only when its matching `.sha256` file is present.

## Test 1 — clean installation

Record:

- Windows edition and version;
- x64 or x86;
- RAM;
- CPU;
- GPU and VRAM if present;
- whether Python was already installed;
- whether LM Studio/llmster was already installed.

Then:

1. Extract the package to a normal local folder.
2. Read the included README / START_HERE instructions.
3. Run the documented Windows installer.
4. Record whether installation completed without manual repair.
5. Confirm the CITADEL service/agent starts.
6. If you have access to an authorized CITADEL test controller, confirm the node enrolls and becomes visible.

**Pass evidence:** install completed, agent is running, and enrollment/heartbeat succeeds when test-controller access is available.

## Test 2 — reboot and persistence

1. Reboot Windows normally.
2. Do not manually start CITADEL.
3. Check whether the agent returns automatically.
4. If connected to a test controller, check whether the same node identity returns instead of creating a duplicate.

**Pass evidence:** automatic recovery after reboot with preserved identity.

## Test 3 — network recovery

1. Start with a healthy connected node.
2. Disconnect the network.
3. Reconnect the same approved network.
4. Observe whether the agent recovers without reinstalling or creating a new identity.

Do not intentionally connect the machine to unknown or unsafe networks for this test.

**Pass evidence:** the node resumes communication after connectivity returns.

## Test 4 — LM Studio / llmster

Run this only if you are comfortable testing local AI software.

Test both cases when possible:

- LM Studio/llmster already present;
- clean machine where the CITADEL path performs the setup.

Record:

- install result;
- probe result;
- whether localhost model service becomes reachable;
- model selected;
- model download result;
- model load result;
- first prompt result;
- whether the model still works after service restart or Windows reboot.

Never include API keys or private model credentials in an Issue.

## Test 5 — one-node prompt

With one healthy AI-capable node:

1. Submit a simple prompt through the authorized test Hub/controller.
2. Record whether the task is accepted.
3. Record whether execution begins visibly.
4. Record whether a final answer is returned.
5. Note the model and approximate execution time.

Useful prompt example:

`Explain in 5 bullet points why checking both expected and actual state is useful in a distributed system.`

Do not use sensitive input.

## Test 6 — multi-node prompt

If you have 2 or more authorized test machines:

1. Bring all nodes online.
2. Confirm they represent distinct physical hosts.
3. Submit a task requesting more than one node.
4. Record how many nodes were requested and how many actually participated.
5. Repeat with one node intentionally unavailable.

We especially want evidence for 2-node and 3-node fleets before attempting larger fleets.

**Pass evidence:** work is distributed only to healthy eligible nodes and partial availability produces a clear result instead of silent failure.

## Test 7 — mini-agents

On an AI-capable node, submit tasks of different complexity and record:

- how many mini-agents were created;
- whether their roles were distinguishable;
- whether verification/edge-case work ran when expected;
- whether synthesis returned one final answer;
- whether RAM/CPU pressure remained reasonable.

The purpose is not to maximize the number of mini-agents. The purpose is to verify bounded behavior appropriate to the machine.

## Test 8 — repair, update, uninstall

If your test machine can safely be reset:

1. Run repair/reinstall over the existing agent.
2. Test an available update path.
3. Reboot and verify the node still returns.
4. Run the documented uninstall path.
5. Confirm CITADEL services/processes are removed as documented.
6. Report any leftover files, services, scheduled tasks, duplicated node identities, or broken rollback state.

## What to include in every test report

Please include:

- test name;
- Windows version;
- hardware summary;
- agent package/version;
- whether LM Studio/llmster was preinstalled;
- number of physical nodes;
- exact step that succeeded or failed;
- expected behavior;
- actual behavior;
- sanitized error text;
- whether the failure reproduces after a clean retry.

Screenshots are welcome, but remove usernames, tokens, IPs you consider private, file paths containing personal names, and other sensitive data.

## Reporting

Use GitHub Issues:

- **Bug report** for a reproducible defect.
- **Test result** for a successful, partial, or exploratory test.

A useful report is more valuable than a long report. Exact reproduction steps matter most.

## High-value environments we still want

We especially want results from:

- Windows 10 and Windows 11;
- machines with no system Python;
- machines with existing Python;
- machines with and without LM Studio;
- low-RAM machines;
- systems with NVIDIA, AMD, Intel, or no discrete GPU;
- laptops that sleep/reconnect;
- 2–3 physical-node test fleets.

## Security reporting

Do not open a public Issue for a vulnerability that exposes credentials, authentication bypass, remote-code execution, private data, or other sensitive security impact.

Follow [SECURITY.md](SECURITY.md) for security reports.
