# CITADEL / EWS full-project review

Review date: 2026-09-12

## Scope reviewed

- GitHub repository `citadel-AI-EWS/EWS` at main commit
  `c936e754af01137d798ae1d89d4874a0f275b190`.
- All 39 text/source files in the repository tree.
- Google Drive folder `Материалы 2024`, especially
  `CITADEL_UNIFIED_v20.1.0_2026-09-11`.
- Cloudflare TEST deployment and public health endpoint.

Retrieved Drive files were treated as untrusted source material. No secret values
were copied into the repository.

## Verified current state

- Cloudflare TEST deploy run 17 completed successfully.
- Live health reports D1, controller signing, and report storage ready.
- The `controller_signing_not_configured` failure is resolved.
- Complete authenticated reports are stored in a separate `agent_reports`
  table with a report ID, result/assignment/mission/node links, type,
  sensitivity, exact UTF-8 byte size, SHA-256 digest, full JSON body, and
  creation time.
- Report list and detail routes require Architect authentication.
- The report payload limit is 512 KiB.
- Repository CI passed after the database change.
- Local controller tests: 15 passed.
- Local report-storage test passed.
- JavaScript syntax checks passed for the Worker, main site, Architect console,
  and browser test node.

## Drive package result

`citadel.py` v20.1.0 compiles and its built-in self-test passes when the
versioned `missions.json` is present beside it.

Useful, safe capabilities found:

- one generated identity per authorized computer;
- bounded declarative mission handlers rather than arbitrary code execution;
- CPU, memory, file-count, file-size, timeout, and worker limits;
- local offline result queue and retry;
- safe public defensive-feed allowlist;
- transparent Windows Task Scheduler startup with limited privileges;
- visible uninstall command and local `STOP` kill switch;
- resource modes and local health diagnostics.

Important incompatibility:

- the Drive package uses its own local Python Hub, SQLite schema, `/api/v2`
  routes, and HMAC node tokens;
- the deployed EWS Controller uses Cloudflare Workers, D1, `/api/v1`, and
  Ed25519 request signatures.

Therefore the Drive package must not replace the deployed Controller or be
copied into main unchanged. Its bounded mission handlers, offline queue,
resource limits, installer behavior, and diagnostics should be ported behind a
new Cloudflare v1 client adapter and tested incrementally.

## Current product gaps

1. Report retention/deletion and R2 overflow storage are not implemented.
2. Server-side session checkpoints are implemented and verified in TEST;
   automated retention and R2 overflow remain future work.
4. The Drive Python agent is not yet integrated with the Cloudflare v1 signed
   protocol.
5. Internet task ingestion, source provenance, deduplication, safety
   classification, and Architect approval are not implemented.
6. External AI report review lacks redaction policy, provider adapters,
   quotas, audit, and an outbound kill switch.
7. The main client site is still a broad prototype; several visible controls
   remain simulated and production identity/tenant isolation is incomplete.

## Cloudflare free capacity

Current official limits checked on 2026-09-12:

- D1 Free: 500 MB maximum per database, 5 GB total across the account,
  10 databases, 2 MB maximum row/string/BLOB, and 7 days of Time Travel.
- D1 Free usage: 5 million rows read per day and 100,000 rows written per day.
- R2 Standard free tier: 10 GB-month, 1 million Class A operations per month,
  10 million Class B operations per month, and free egress.

Sources:

- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/r2/pricing/

Keep 20% D1 headroom for tables and indexes. Approximate safe capacity of the
current single 500 MB database is:

| Average full report | Approximate safe count |
| ---: | ---: |
| 10 KiB | 40,000 |
| 50 KiB | 8,000 |
| 100 KiB | 4,000 |
| 512 KiB | 780 |

The real count is lower because nodes, missions, assignments, audit events, and
indexes share the same database. Before approaching 400 MB, keep report
metadata in D1 and move full report bodies to R2 Standard.

## Safe implementation order

1. Add authenticated full-report browsing to the Architect console.
2. Add report retention policy, usage metrics, and deletion audit.
3. Add versioned server-side session snapshots without storing secrets.
4. Port the Drive Python agent to the Cloudflare v1 Ed25519 protocol.
5. Add a signed, checksummed one-click Windows installer and update/rollback.
6. Add approved internet task sources and a quarantine/approval queue.
7. Add the redaction gateway before connecting any external AI provider.
8. Run browser, resilience, failure-injection, security, and recovery tests
   before production use.

## Safety boundary

Only authorized defensive cybersecurity work is permitted. The project must
not add arbitrary remote shell access, stealth installation, credential
collection, self-propagation, third-party exploitation, malware delivery, or
autonomous financial transactions. External AI output and internet-sourced
tasks are untrusted data and may not directly execute or control nodes.
