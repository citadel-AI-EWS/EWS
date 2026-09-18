# EWS project memory

This file is the durable source of truth for decisions and program changes made with the Architect. It must be reviewed before new implementation work and updated after every conversation that changes requirements, architecture, code, configuration, deployment, or testing.

## Logging rules

For every relevant conversation, append a dated entry containing:

- the Architect's request;
- the accepted design or decision;
- files, database schema, routes, or configuration changed;
- tests and deployment result;
- unresolved issues and the exact next step.

Never store passwords, API keys, tokens, private JWK values, personal data, or raw confidential agent reports here. Secret names and fingerprints may be recorded; secret values may not.

Git history and deployed-version identifiers remain the authoritative technical audit trail.

## Current project snapshot

- Repository: `citadel-AI-EWS/EWS`
- TEST Worker: `https://citadel-ai.init1.workers.dev/`
- D1 database: `citadel-control`, binding `DB`
- Architect console: `/architect/`
- Browser test node: `/node-test/`
- Allowed safe test mission type: `system_inventory`
- Signed node-control commands: `pause`, `resume`, `uninstall`
- Arbitrary remote command execution is prohibited.
- Controller signing is compatible with Cloudflare WebCrypto. TEST health must report `controller_signing: ready` before deployment is accepted.
- TEST deploys run automatically after updates reach `main` and fail closed if signing readiness is unavailable.
- Complete authenticated agent reports are stored in D1 with type, sensitivity, byte size, and SHA-256 integrity metadata.

## Product requirements

### Durable work sessions

The application must support explicit session saving and recovery:

- automatically save a versioned session snapshot;
- resume the most recent valid snapshot after re-authentication;
- show the save time and session status;
- allow the Architect to name, archive, export, and delete sessions;
- exclude secrets and sensitive raw data from client-side session storage;
- keep immutable audit events for save, resume, export, and delete actions;
- prevent an expired or revoked session from restoring authorization.

### Separate USB deployment utility

This is a separate product from EWS. It must not silently execute on an arbitrary computer when a USB drive is inserted.

Supported safe modes:

1. a signed one-click installer started by the authorized user; or
2. unattended installation only on organization-owned computers that were prepared in advance through MDM, Intune, Group Policy, an approved provisioning package, or an equivalent administrator-controlled mechanism.

Requirements:

- signed and checksummed package;
- compatibility and disk-space preflight;
- clear device authorization and enrollment policy;
- least privilege;
- rollback and installation log;
- no autorun bypass, exploit, stealth installation, persistence trick, or security-control bypass.

### AI report review gateway

Agent reports may be analyzed by multiple external AI providers, manually or on an Architect-approved daily or monthly schedule.

Required pipeline:

1. Store the original report only inside the trusted EWS boundary.
2. Classify sensitivity and apply an outbound allowlist.
3. Remove or replace API keys, passwords, tokens, cookies, private keys, credentials, personal data, internal hostnames/IPs, customer identifiers, confidential file contents, and other prohibited fields.
4. Block sending if sanitization confidence or policy checks fail.
5. Show the Architect exactly what sanitized package will leave the system when manual approval is required.
6. Send only the sanitized package through provider adapters such as Anthropic, DeepSeek, Moonshot, or other approved services.
7. Treat external AI output as untrusted advisory text: it may never execute commands or change nodes automatically.
8. Validate, compare, and archive responses with provider name, model, policy version, redaction summary, cost/usage, timestamps, and audit identity.
9. Keep provider API credentials only in the server-side secret store and never in reports, browser storage, or logs.
10. Support per-provider enable/disable controls, quotas, retry limits, and a global outbound-data kill switch.

Free tiers are optional capacity, not a system guarantee; providers may require API keys, impose limits, or change pricing. A local/private model adapter should be supported for reports that may not leave the trusted environment.

## Decision log

### 2026-09-12 — Persistent memory and new platform requirements

Architect requested:

- a durable log of every conversation that changes the program so future work does not rely only on chat history;
- session saving and recovery;
- a separate USB-based installation solution with no repeated human setup;
- daily/monthly or Architect-directed analysis of sanitized agent reports by several AI services, with secrets and confidential information withheld.

Decision:

- This file becomes the durable project memory and will be updated after each relevant conversation.
- Session recovery is part of EWS.
- USB installation remains a separate, signed deployment utility and may be unattended only on pre-authorized managed devices.
- External AI review will use a strict redaction and egress-policy gateway. External AI responses are advisory only.

Next steps:

- finish and deploy the Cloudflare controller-signing compatibility fix;
- design the session snapshot data model and recovery UI;
- specify the AI report redaction policy and provider-adapter interface;
- create the USB deployment utility as a separate repository/specification after the target operating system and device-management method are chosen.


### 2026-09-12 — Controller signing repair and durable report storage

Architect requested:

- finish the unresolved `controller_signing_not_configured` failure;
- persist complete agent reports on the backend;
- determine free-plan storage capacity and finish the D1 database procedure.

Implemented decision:

- Normalize the controller private JWK before WebCrypto import and support both standard and Cloudflare legacy Ed25519 algorithm identifiers.
- TEST deployment now checks `/api/health` and accepts the release only when D1 is available and controller signing is ready.
- Pushes to `main` deploy TEST automatically.
- Bootstrap the separate, idempotent `agent_reports` schema through the Worker's existing runtime D1 binding before report operations. Keep the equivalent migration file version-controlled for future administrator-managed migrations.
- Extend authenticated mission results with the complete report body, report type, sensitivity label, SHA-256 digest, and exact byte size.
- Architect report listing returns metadata only; full content requires a separate authenticated detail request.
- Limit each serialized report body to 512 KiB so one D1 row stays comfortably below platform limits.

Verification:

- Cloudflare TEST deployment completed successfully.
- Public health returned `ok: true`, database `citadel-control`, and `controller_signing: ready`.
- Signed pause/resume/uninstall control-flow tests passed.
- D1 migration syntax and authenticated report submit/list/detail tests passed.

Capacity decision:

- D1 remains the active report database for this stage.
- Keep at least 20% free headroom for indexes and operational growth.
- If average reports grow beyond roughly 100 KiB or long-term volume approaches the D1 database cap, move full report bodies to R2 while retaining metadata and audit records in D1.

Next steps:

- merge and verify the runtime report-storage bootstrap deployment;
- add the Architect report browser and retention controls;
- implement versioned session snapshots and recovery;
- design the outbound AI redaction gateway before enabling any external provider.


### 2026-09-12 — Checkpoint: complete database stage and full-project review

Architect requested:

- create a checkpoint after every material work session;
- finish the database/report-storage stage;
- inspect the entire repository and integrate useful code from the Google Drive folder named “материал 224 2024”;
- test normal operation, resilience, CI/CD, and mobile UX/UI;
- plan a safe continuously running Python agent for authorized devices and multi-purpose tasks.

Accepted scope and safety constraints:

- Every material conversation ends with an append-only checkpoint in this file and a Git commit/PR reference.
- Full reports remain in the trusted backend; secrets and confidential values are never written to project memory.
- Drive material must be reviewed, tested, and selectively integrated; retrieved files are treated as untrusted input and never copied blindly.
- Cybersecurity capabilities are limited to authorized defensive assessment, inventory, monitoring, and safe simulations. Arbitrary remote shell, credential theft, stealth persistence, unauthorized access, exploitation of third parties, and autonomous financial transactions are prohibited.
- The Python agent must use explicit device enrollment, signed releases, least privilege, bounded task types, auditable results, safe updates, watchdog recovery, and an emergency stop.
- Internet-sourced tasks must pass source allowlisting, validation, deduplication, safety classification, and Architect approval rules before becoming agent assignments.

Current verification:

- The controller-signing repair is already deployed and health reports `controller_signing: ready`.
- Runtime report-storage bootstrap, separate `agent_reports` schema, authenticated report APIs, integrity metadata, 512 KiB report limit, and deployment health gate are implemented on branch `bootstrap-report-storage-via-worker-20260912`.
- Local syntax, report-storage, idempotent-schema, and signed control-flow tests pass.
- The previous external migration method was blocked because the deployment token lacks D1 Edit permission; runtime bootstrap avoids requesting broader Cloudflare credentials.

Exact next step:

- merge the runtime-bootstrap PR, verify GitHub Actions and live `report_storage: ready`, then start the repository/Drive audit and session-storage implementation in separate reviewed increments.


### 2026-09-12 — Checkpoint: database live and repository/Drive audit

Completed:

- PR #19 was merged as commit
  `c936e754af01137d798ae1d89d4874a0f275b190`.
- GitHub Actions CI and Cloudflare TEST deploy run 17 completed successfully.
- Live `/api/health` returned `ok: true`, `controller_signing: ready`, and
  `report_storage: ready`.
- All repository source/text files were reviewed and the Drive folder
  `Материалы 2024` was inspected.
- The Drive package `CITADEL_UNIFIED_v20.1.0_2026-09-11` passed Python syntax
  compilation and its built-in self-test when used as a complete package.
- A full review and capacity calculation were recorded in
  `docs/FULL_PROJECT_REVIEW_2026-09-12.md`.

Decision:

- The database/report-storage stage is complete.
- The Drive Python package will not replace the Cloudflare Controller because
  its local Hub/SQLite/HMAC protocol is incompatible with the deployed
  Worker/D1/Ed25519 protocol.
- Safe mission handlers, offline queue, resource limits, diagnostics, and
  transparent installer behavior will be ported through a Cloudflare v1
  adapter in reviewed increments.
- Add authenticated report browsing to the Architect console first so stored
  reports are usable from the current mobile workflow.

Next step:

- merge and deploy the Architect report browser and expanded JavaScript CI
  checks; then implement report retention and versioned session snapshots.


### 2026-09-12 — Checkpoint: report browser live and session storage prepared

Completed:

- PR #20 merged as commit
  `d0d47fe91e0cde5a257b658f0d8fe96f99c23571`.
- CI run 35 and Cloudflare TEST deploy run 18 completed successfully.
- The live Architect page exposes authenticated full-report browsing and the
  live health endpoint still reports controller signing and report storage
  ready.
- A versioned `architect_sessions` D1 schema, authenticated create/list/get/
  update/delete routes, storage-usage route, and mobile UI were implemented
  locally for the next reviewed increment.
- Session snapshots accept only allowlisted UI identifiers and server-generated
  counts. They exclude login secrets and full report contents.
- The UI supports save, restore, archive/reactivate, export, and audited delete.
- Worker/page syntax checks, DOM consistency checks, 15 controller tests,
  report-storage tests, and session-storage tests pass locally.

Current decision:

- Keep session snapshots small (16 KiB maximum) and versioned.
- Use 400 MiB as the operating target for the 500 MiB D1 Free database, while
  clearly labeling the UI meter as tracked report/session payloads rather than
  total physical database usage.
- Do not broaden the Cloudflare deployment token; bootstrap the idempotent
  session schema through the runtime D1 binding.

Next step:

- publish the session checkpoint increment through CI and TEST deployment;
  then implement report retention controls and the Cloudflare-v1 Python agent
  adapter as separate reviewed changes.


### 2026-09-12 — Checkpoint: session storage live

Completed:

- PR #21 merged as commit
  `ff6ad73028c7a0e9b497976c8174ebc57915b198`.
- Main CI run 39 completed successfully.
- Cloudflare TEST deploy run 19 succeeded on its second verification attempt.
  The first attempt deployed correctly but its 10-second health window ended
  before the new Worker version had propagated to every request path.
- Live `/api/health` returns `controller_signing: ready`,
  `report_storage: ready`, and `session_storage: ready`.
- The live Architect page contains “Контрольные точки”, “Сохранить сессию”,
  and the tracked-storage meter.

Database-stage result:

- D1 now persistently stores operational entities, authenticated full reports,
  and versioned Architect session checkpoints.
- Reports and sessions have integrity metadata; sensitive authorization is not
  restored from snapshots.
- The database stage requested for TEST is complete. Automated retention and
  D1-to-R2 overflow are capacity improvements, not blockers for current TEST
  operation.

Resilience follow-up:

- extend the deployment health window to 60 seconds and add a per-attempt cache
  buster so normal Cloudflare propagation does not create a false-negative CD
  result.

Next step:

- finish and verify the CD propagation fix; then port the reviewed Python agent
  behind the Cloudflare v1 Ed25519 protocol without arbitrary command execution.


## 2026-09-17 — Remote update guard 0.3.2

- Hub and Architect console can issue signed allowlisted `update`, `restart`, and `rollback` commands.
- Remote update still accepts only official `raw.githubusercontent.com/citadel-AI-EWS/EWS/.../agent/` files with pinned SHA-256 hashes.
- After replacing files, the agent launches the newly installed v2 in a fresh `startup-check` process using the real local config. Failure triggers automatic file rollback before daemon handoff.
- Manual rollback validates the complete local backup with self-test before restoring it.
- No arbitrary shell/command execution was introduced.


## 2026-09-18 — Architect UX review from live operator use

Operator feedback from the live Architect page:

- checkpoint/session controls were confusing and not useful in the main workflow;
- node control lacked visible IP, health diagnostics and a non-revoking stop action;
- mission creation did not expose any place to describe the requested task;
- system-inventory reports looked like completed user work even when they were diagnostics;
- SSH existed in Hub but was missing from Architect.

Test-branch changes:

- hide checkpoint/session UI from the Architect dashboard while preserving the backend data/schema;
- add selected-node diagnostics with public IP/presence, CPU, RAM, agent version and last contact;
- add one-click health-check using the existing bounded `system_inventory` mission;
- add non-revoking signed `stop` command in agent release 0.3.5; Controller marks a completed stop as offline rather than revoked;
- keep `uninstall` as the separate revoke/remove operation;
- add explicit PC reboot/shutdown controls with existing confirmation guards;
- add mission `task_text` (max 2000 chars) as operator intent; it is stored/reported but never executed as shell/code;
- rename system-inventory reports in the UI as diagnostics and explain their origin;
- add Cloudflare Zero-Trust SSH configuration/command block directly to Architect;
- gate the new stop command to nodes already running the current 0.3.5 release;
- add `tests/architect-ux-guards.mjs` to prevent regressions.

Release note:

- existing 0.3.4 nodes must first take the normal signed remote update to 0.3.5 before the new stop command becomes available.


## 2026-09-18 — Correction: Architect text is a real project input

Operator correction:

- The large Architect text field is not a note attached to diagnostics.
- It is the real project request that must travel through the project intake pipeline.
- The four automatic gates are, in order:
  1. source allowlisting;
  2. validation;
  3. deduplication;
  4. safety classification.
- Architect approval is a separate gate after those four checks.
- After approval, Hub/Controller creates a project, builds work items and automatically selects available Python nodes.
- The Hub decides worker allocation from one node up to the currently available eligible pool; large-scale operation must be implemented through queue/shard architecture rather than a browser loop.
- Architect now has a visible **Python / Создать проект** workflow showing the four checks and the resulting Hub allocation.
- **Обновить все агенты** is a server-side rollout: one Architect action records the target signed release; each outdated node materializes its own signed update command on the next command poll.
- A 10-minute completed-update guard prevents an updated node from receiving the same rollout twice before its next heartbeat refreshes agent_version.

Current execution boundary:

- Project intake, four-gate approval, storage, work-item creation and node allocation are real.
- Generic arbitrary-text project execution is not falsely reported as complete: work items are currently planned in `project_work_items`; execution requires an explicit reviewed project-worker capability rather than turning Architect text into arbitrary shell/code.


## 2026-09-18 — Live Operations command-center redesign and work specializations

Operator requirements:

- First Architect page is **LIVE OPERATIONS** and must display real Controller data only.
- Remove the visible **Latest audit events** block from the operations page. Audit storage remains intact for security and forensic accountability.
- Every node card must show, without opening details:
  - CITADEL node identity;
  - derived local agent label tied to the real node number;
  - last contact;
  - alive/dead state;
  - healthy/unhealthy state.
- Health detail expands with a **+** control and shows hostname, Node ID, Controller status, OS/architecture, CPU/RAM, public IP/presence, enrollment, agent version and warnings.
- Alive means non-revoked/non-offline with a heartbeat no older than five minutes.
- Healthy means alive with no critical CPU/RAM signal (critical threshold 95%).
- On entry, show a closable **OPERATIONS BRIEF** containing only currently important node problems; if there are none, state that no critical node problem is present.
- Add professional animated visualizations, but never synthetic operational values. Current UI charts use only real node snapshots:
  - fleet health;
  - CPU;
  - RAM;
  - Controller→node topology.
- Old simulations are the evidence for these legacy worker concepts:
  - Planner;
  - Verifier;
  - Research;
  - Report;
  - Metrics;
  - Recovery.
- The Architect explicitly requested additional work specializations Programmer and Mathematician. Security Analyst is included as a new Hub specialization for security/audit blocks.
- Architect is represented separately as a human approval gate, not as a machine worker.
- Every project work item now persists `role_name`; deterministic classification assigns a primary specialization before node allocation.
- Current agent capability reporting only exposes real executable mission handlers (currently `system_inventory`). Therefore role assignment is project metadata/planning and must not be misrepresented as capability-aware execution until worker capabilities are actually implemented.

## 2026-09-18 — LM Studio / llmster per-node control

Architect requirement:

- A managed remote node must be able to install LM Studio from Hub without opening a general remote shell.
- The reviewed CITADEL helper installers live in the project GitHub repository under `agent/lmstudio/`.
- On remote/server nodes the runtime is LM Studio headless (`llmster`) with the `lms` CLI.
- Installation, model download, and model load are separate signed allowlist commands.
- The node accepts only a reviewed GitHub helper with an exact path and SHA-256; the helper fetches the official upstream installer only from `lmstudio.ai`.
- Model identifiers are validated as data and are passed only as fixed argv to `lms`; model text is never executed as shell input.
- When LM Studio is selected for a node, Hub must immediately show a persistent floating per-node control panel with:
  - LM Studio installation state;
  - a link to the reviewed installer directory in GitHub;
  - a language-model selector;
  - download-model control;
  - load-model control;
  - the active/loaded model status.
- The floating panel remains associated with the selected node while live Controller data refreshes.
- Initial curated model presets are only convenience choices; Architect may enter another valid LM Studio model identifier.

Release decision:

- Agent release 0.3.8 extends bounded signed AI controls with live LM Studio probing, real installation/download progress, Hugging Face model discovery through Hub, and the Hybrid node mode. The signed allowlist includes `lmstudio_install`, `lmstudio_probe`, `lmstudio_model_get`, `lmstudio_model_load`, and `hybrid_query`.
- Arbitrary remote command execution remains prohibited.

## 2026-09-18 — Project Plan must execute, report progress, and produce a final result

Operator found that real projects created from Architect text remained permanently in `Plan`.

Root cause:

- `architectCreateProject` stored `project_work_items` as `planned` but created no executable node assignments.
- The UI could therefore show a plan and selected nodes, but no actual progress, work result, or final report.

Required behavior:

- `Plan` is only the first state. Project work must advance through `Assigned → Running → Completed/Failed`.
- Existing projects already stuck in `planned` must be recoverable automatically; the Architect must not recreate them.
- A live node with the `project_text` capability and a loaded/running LM Studio model may claim planned project blocks.
- Project text execution is bounded local inference through `127.0.0.1:1234/v1/chat/completions`; it does not enable shell, host modification, credential access, or arbitrary remote command execution.
- Controller must persist each real node result against the original project work item.
- Project report UI must show:
  - completed/total;
  - percentage;
  - assigned/running/failed counts;
  - per-block result and model;
  - automatic refresh while the report is open;
  - a combined final project result when all blocks reach a terminal state.
- Projects with failed blocks may finish with a failure status while still preserving available completed-block outputs.

Implementation is being delivered in the same reviewed LM Studio release branch so project execution and per-node model control stay consistent.



### Network resilience rule for 0.3.8

- Windows sleep/hibernate inhibition stays active while the agent service runs.
- The agent already retries Controller failures with bounded exponential backoff; on real network errors it also attempts bounded OS network recovery.
- Windows recovery uses DHCP renew and only reconnects to previously saved Windows Wi-Fi profiles.
- Linux recovery uses NetworkManager and only raises previously active saved connections.
- The agent never reads, exports, or stores Wi-Fi passwords and never joins an unknown network automatically.
