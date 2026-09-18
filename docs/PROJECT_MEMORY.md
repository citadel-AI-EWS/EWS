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


## 2026-09-18 — Legacy CRE archive review and engineering-experience layer

Architect requested:

- inspect the uploaded historical program and all available logs;
- preserve relevant experience in a separate database kept with the project;
- selectively reuse only the strongest ideas from the old program;
- treat the archive as an engineering stage/lesson rather than copying it wholesale.

Reviewed evidence:

- 4,686 extracted files, roughly 280 MiB;
- all 686 `.log` files included in the inventory/aggregate scan;
- 650 structured daily run reports;
- 650/650 structured cycles failed: 649 with `EMPTY_MODEL_OUTPUT_ThreatScout` and one observed structured run with `LM_STUDIO_AUTH_401`;
- external source acquisition was generally healthy while local-model orchestration was not;
- legacy source/config contained embedded credential material. Secret values are excluded from EWS and must not be copied into project memory.

Accepted integration:

- Do not import the monolithic CRE runtime.
- Preserve SHA-256 integrity, atomic state concepts, bounded evidence, source provenance, explicit failure states, cache/stale metadata, regression health contracts and recommend-only model guidance.
- Preserve defensive defaults: no malware download, no model-driven external code/shell, no automatic firewall blocking, no automatic model download/switch/configuration.
- Keep threat-intelligence feeds optional rather than part of EWS core.
- Store historical experience outside operational D1. The repository carries the sanitized reproducible seed at `knowledge/legacy_cre_experience.sql`; the detailed local review database also contains file fingerprints and aggregate log/run analysis.
- Wire the engineering-experience invariant check into `/api/health`.
- Add CI tests for the experience policy, evidence-reference validation, DB completeness and accidental PEM credential material.

Implementation:

- branch: `legacy-cre-experience-20260918`;
- draft PR: #51;
- `src/experience/policy.js`;
- `tests/legacy-experience.mjs`;
- `knowledge/legacy_cre_experience.sql`;
- `docs/LEGACY_CRE_REVIEW_2026-09-18.md`;
- `src/worker.js` health integration;
- `scripts/validate.sh` CI integration.

Security follow-up:

- Treat any credential embedded in the legacy archive as compromised if it might still be valid; rotate/revoke it outside the repository.
- Never commit the raw legacy archive, raw LM Studio logs, service-account key material, or the legacy config to EWS.

Verification:

- code/diff review completed;
- sanitized database seed records all 650 structured runs and observed average/median timing summaries;
- PR #51 CI run 138 passed all gates: Linux validation, Cloudflare build/check, Bandit, Windows agent validation and agent-package integrity;
- PR #51 remains draft for deliberate review; `main` is unchanged.


## 2026-09-18 — Project Experience Registry in Architect

Architect requested:

- turn the reviewed historical reports into durable project experience instead of leaving them as a dead archive;
- keep raw logs outside the live product;
- make the lessons visible inside Architect.

Implemented decision:

- Add a sanitized, read-only Project Experience Registry at `src/experience/registry.js`.
- Keep the detailed historical SQL seed separate from operational D1.
- Expose the registry only through authenticated `GET /api/v1/architect/experience`.
- Add an “Опыт проекта” section to the Architect console showing the observed problem, engineering decision, current replacement/guardrail, evidence summary and repository references.
- Preserve raw logs, archived binaries, old configs and credential material outside the runtime registry.
- Add CI checks for registry structure, unique IDs, credential-material exclusion, API wiring and Architect UI wiring.

Initial registry:

- 12 reviewed records from the CRE v19.2.2 stage;
- includes security, orchestration, resource control, provenance, end-to-end testing, safe defaults, integrity, storage decoupling, modular architecture, evidence discipline, recommend-only model management and reuse of current EWS resilience mechanisms.

Release policy:

- Remain on draft PR #51 until the updated branch passes CI.
- Do not merge or deploy this increment to `main` without explicit Architect approval.
