# CITADEL EWS — selective adoption of Gemini architectural suggestions

The shared Gemini conversation is design input, **not** evidence of a GitHub change,
successful test, production deployment, or a guarantee of future availability.

## Adopted: integrity boundary independent of the storage vendor

- `src/telemetry/report-integrity.js` validates the immutable
  `citadel-node-report/v1` and `/v2` envelopes without Drive, Cloudflare,
  D1, or privileged credentials.
- Before any Google Drive upload, recompute the SHA-256 of the exact queued
  report bytes, verify `node_id` and schema, and verify each bundle member
  against the member's content-addressed SHA-256 batch ID.
- Historical guardian `disconnect:` IDs are allowed only for their matching
  node-disconnected event; existing workflows remain compatible.
- On mismatch, stop upload, keep the outbox and delivery records pending,
  and expose the sanitized `drive_report_integrity_mismatch` reason through
  the existing retry journal. Do **not** discard a corrupt report or silently
  mark it delivered. Recovery requires investigating the original record.
- This changes no tables, migrations, authentication, report schema, external
  URLs or D1 polling cadence. Normal delivery incurs local SHA-256 work
  but no extra D1 queries.

## Already present; retained instead of duplicated

- Persistent Ed25519 node identity and signed API calls: do not replace with
  a shared `citadel-master-secret`, HMAC-only auth, or random node IDs.
- Durable local result queue and JSONL telemetry cursor with retry semantics:
  a second SQLite buffer would duplicate state and add migration risks.
- Bounded, deduplicated D1 report outbox, immutable Drive delivery and
  quota/backpressure handling. Do not add a heartbeat insert every 10–15s.
- Drive write/readback verification is mandatory before report archiving is enabled.
- No unrestricted CORS, arbitrary shell commands, or automatic deployment.

## Deferred, needs explicit design and migrations

- Cloudflare/AWS/provider-agnostic persistence adapters and disaster-recovery
  snapshots are worthwhile future work, but are not production-ready simply
  because an interface or sample SQL exists.
- Cryptographic Merkle-chain archival, key rotation, backup restore drills, and
  local SQLite queues should have measurable requirements, retention limits,
  recovery procedures, and independent security reviews first.

## Absolutely do not apply

- Gemini's `DROP TABLE` examples (data loss).
- Hard-coded shared secrets, fake success responses from LM Studio, and
  unauthenticated `/api/telemetry` endpoints.
- Claims of `100 years` or `zero failure vectors` without evidence.

## Verification and rollout

`node tests/node-reports-drive.mjs` covers intact uploads, lost-response
retries, SHA tampering, pre-bundle member tampering, queue retention and
27-node load simulation. Run the repository CI and Drive verification tests.
Keep this change in a PR until CI passes; test a single canary before
production deployment. Do not mass-update agents for this Worker-only change.
