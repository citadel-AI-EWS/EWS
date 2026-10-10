# Per-node Google Drive session and error journals

## Destination

User-approved root: `Отчеты ИИ` (Drive folder ID `1cUOu0FFbMMaf32tvPMK0bgsFsLyVAyTn`).

The existing Worker selects or creates **one folder per enrolled node**, named
`<hostname>__<persistent_node_id>`. Do not use a random agent ID on startup.
Store file metadata including timestamp, event category, event name, immutable
batch ID, node ID and SHA256. Repeated events are distinct because each local
record is assigned an offset-derived event ID; retries use the same ID.

- `YYYY-MM-DD_HH-MM-SS__SESSION_END__hybrid_query_completed__<batch-id>.json`
- `YYYY-MM-DD_HH-MM-SS__SESSION_END__ssh_browser_disconnected__<batch-id>.json`
- `YYYY-MM-DD_HH-MM-SS__SESSION_END__agent_stop__<batch-id>.json`
- `YYYY-MM-DD_HH-MM-SS__SESSION_END__session_finished__<batch-id>.json`
- `YYYY-MM-DD_HH-MM-SS__ERROR__cycle_error__<batch-id>.json`
- `YYYY-MM-DD_HH-MM-SS__LOG__node_events__<bundle-id>.json`
- `YYYY-MM-DD_HH-MM-SS__INTERVAL__log_interval_snapshot__<batch-id>.json`

A running node writes a small `log_interval_snapshot` marker every 1800 seconds (30 minutes), including its session ID and estimated locally pending journal bytes. This occurs even without new tasks; the timer uses a daemon thread and does not block the agent. Its event is visible in Architect Logs and archived as a dedicated INTERVAL JSON in the existing controller-relayed transport. While the Logs page is open and authenticated, it checks for new events automatically every 30 minutes; hidden or closed pages do not poll. The timer is not a guarantee of remote delivery while network or Drive authorization is unavailable.

Each individual error/close report contains a human-readable `title`.
Healthy events are grouped into compact archives to avoid excessive writes
and API calls. Every error and close event creates its own document, not a
shared bundle. The agent writes an explicit `session_finished` marker with its
process session ID for both successful one-shot execution and exceptional exit.
A sudden power loss cannot be logged until the next successful startup; already
queued records are retried after reconnection. Operational metadata only: the restricted SSH console logs the
command *identifier*, but secrets, credentials, raw console transcripts and
full model prompts are **not** copied into these operational journals.

## No arbitrary limit on Drive file count

Do not impose a cap on the cumulative number of Drive files per node.
Google Drive storage, API rate limits, account quotas, and disk space remain
finite. **The system cannot promise literally unlimited bytes or guaranteed
delivery while Google Drive credentials are missing**.

The existing short-term D1 outbox remains bounded to protect Cloudflare Free
tier. When full or offline, the controller returns 503; the agent retains its
durable local JSONL/cursor and retries. Never mark a failed/queued Drive upload
as delivered. Existing Drive readback and SHA256 verification are retained.
To scale to thousands of high-rate nodes, a separately approved Drive
upload worker/broker and monitoring are recommended.

## Connected Google account and authentication

The user has granted permission for this configuration but must finish
the interactive Google Cloud sign-in profile and OAuth consent.
**DO NOT store OAuth client secrets, refresh tokens or private keys in Git**.

The CI workflow `.github/workflows/node-reports-drive.yml` takes credentials
from GitHub Actions Environment `cloudflare-test`, performs a real write and
readback through `scripts/google_drive_write_test.mjs --activate`, and only
then activates archival with `GOOGLE_DRIVE_NODE_REPORTS_VERIFICATION`.
The stored folder is personal Google Drive: favor OAuth with a refresh token
over a service-account-only flow that lacks ownership/quota on My Drive.

Required environment secrets, never committed:
`GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
`GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID`
(and `CLOUDFLARE_API_TOKEN` for Wrangler). Clear stale higher priority
`GOOGLE_DRIVE_ACCESS_TOKEN` and service-account secrets when using OAuth.
Existing CI synchronization handles that after a successful write test.

## Release process

1. Run CI including `node tests/node-reports-drive.mjs`, Linux/Windows
   agents, SSH browser integration, manifest SHA256 and package builds.
2. Integrate compatible node code with open relay fix PR #320; do not
   mass-update 0.3.44 agents before canary and rollback verification.
3. Complete user Google Cloud sign-in; configure OAuth secrets and scoped
   folder access. Run the live Drive write/readback job and inspect errors.
4. Deploy controller only after valid tests; run a single-node LM Studio
   request and SSH browser close; check distinct files by node and category.
5. Enable fleet rollout incrementally, monitor 503 backpressure and Drive
   pending/delivered states, without silently dropping unsent local logs.

## Direct Google Drive transport not yet implemented

The owner subsequently requested direct agent-to-Google-Drive uploads, without Cloudflare handling log bodies. This PR still uses the older controller-relayed pipeline for uploads; the 30-minute timer does not change its destination. A dedicated direct-upload implementation, safe per-node authorization and a real-node Drive write/readback canary are required before declaring that requirement delivered.
