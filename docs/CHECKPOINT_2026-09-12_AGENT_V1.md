# EWS checkpoint — Cloudflare v1 Python agent

Date: 2026-09-12

## Request carried forward

- keep a durable checkpoint after every material work session;
- finish the project around the existing Cloudflare/D1 database;
- reuse useful material from Google Drive `Материалы 2024` after review rather than copying it blindly;
- create a safe continuously-running Python node capable of receiving bounded tasks, returning results/logging locally, and reconnecting after outages;
- keep the site/controller professional, resilient, CI/CD checked and user-friendly;
- later ingest useful internet questions/tasks through a controlled queue.

## Completed in this increment

- Reviewed the existing deployed `/api/v1` Ed25519 node protocol and kept it as the single Controller protocol.
- Ported the safe structural ideas from Drive `CITADEL_UNIFIED_v20.1.0_2026-09-11` into a new `agent/` implementation instead of importing the incompatible local Hub/SQLite/HMAC stack.
- Added `agent/citadel_node_v1.py` with:
  - one Ed25519 identity per authorized computer;
  - exact signed Cloudflare v1 requests;
  - enrollment, heartbeat, assignment polling/acceptance, report submission and controller-command polling;
  - pinned verification of Controller signatures;
  - local offline result queue and retry;
  - CPU/RAM guard, exponential reconnect backoff, local JSONL audit log, `PAUSED` and `STOP` controls;
  - a strict local handler registry; v0.1.0 contains only `system_inventory`.
- Added a Windows setup helper that creates an isolated venv, installs only declared libraries, runs diagnostics, enrolls the node and never persists the one-time enrollment token.
- Deliberately did **not** add hidden autostart/persistence. Production unattended startup must use a signed package plus an explicitly authorized standard management mechanism.
- CI now installs agent dependencies, compiles and self-tests the agent, rejects unsafe Windows setup patterns, and runs Bandit against the agent.

## Safety boundary

The agent has no remote shell, arbitrary code loader, credential collector, exploit engine, lateral-movement feature, self-propagation, stealth installation or autonomous financial transaction capability. Cybersecurity tasks are limited to systems the operator is authorized to assess and to defensive/diagnostic handlers.

Internet-sourced tasks are not yet enabled. Required path before execution:

`source provenance → deduplication → safety classification → quarantine → Architect approval → bounded mission assignment`

## Database/capacity status

The TEST database stage is already operational: D1 persists nodes, missions, assignments, complete authenticated reports and Architect session checkpoints. The project uses a conservative 400 MiB operating target inside the 500 MB D1 Free per-database ceiling and will move large/full report bodies to R2 before approaching that target.

## Exact next steps

1. Pass PR CI and merge this Python-agent increment.
2. Add report retention/deletion policy and R2 overflow while leaving report metadata/audit in D1.
3. Port reviewed Drive handlers one at a time (`file_integrity`, `python_inventory`, `system_health`, `log_audit`, approved defensive feeds) with separate limits/tests.
4. Add server-side internet task intake with provenance, deduplication, quarantine and Architect approval. Internet content never directly controls a node.
5. Add a dedicated server-side telemetry/log ingestion route with retention and rate limits; v0.1.0 currently sends heartbeat/results and keeps its detailed operational log locally.
6. Complete browser/mobile UX, resilience/failure-injection, recovery and production tenant-isolation testing.
