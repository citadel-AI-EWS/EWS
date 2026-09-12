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
- Controller signing is being repaired for Cloudflare WebCrypto compatibility. Deployment must verify signing readiness before reporting success.

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
