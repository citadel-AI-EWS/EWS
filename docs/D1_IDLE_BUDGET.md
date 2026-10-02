# D1 idle polling budget

The previous 30-second agent cycle issued separate command, heartbeat, AI-state
and assignment requests. Every signed request previously inserted a replay nonce; deleting
expired nonces also consumed the daily write quota. Stable `/sync` replay IDs now live in the per-node Durable Object instead of D1. Network, presence and AI
snapshots were rewritten even when their values did not change. The existing
read-only projection therefore could not establish Free-plan capacity.

## Controller and agent changes

Agent 0.3.29 uses one signed `POST /api/v1/nodes/:id/sync` envelope for commands,
assignments and optional heartbeat/AI state. Signature verification, node
revocation and durable replay protection still apply before returning data.
Pending control commands take priority over reserving assignments. Paused nodes
do not receive assignments. Results and command acknowledgements retain their
existing signed routes. The configured polling interval remains 30 seconds.

The agent retries the legacy routes only when sync returns HTTP 404. It retries
sync discovery after five minutes. Authorization, quota and transport failures
do not trigger additional legacy requests. Service HOLD uses the existing
heartbeat-only readiness path.

Sync persists heartbeat metrics/liveness at most once every four minutes for unchanged
online/paused identity and capabilities. Recovery from offline status and
identity/capability changes persist immediately. Network, hardware and presence
write only when their observed values change. Their `updated_at` now represents
the last change; node liveness continues to come from `nodes.last_seen_at`.
Legacy heartbeat retains its original immediate liveness update.

AI state is sent on change or at least once every five minutes. Active progress
changes and explicit probes still publish immediately. Only acknowledged
requests advance the agent's last-sent state. A changed runtime payload exposes
its fresh timestamp even when the small AI summary itself is unchanged.
Long commands retain heartbeat keepalives and refresh correlated runtime state
at least once per minute, inside the existing two-minute active-command lease.

Legacy-route telemetry nonce cleanup uses the received-at index and no longer runs on every
log batch. The 30-second sync hot path no longer creates D1 nonce rows. The existing hourly cron also removes expired nonces. Project-list reads use
the read-first path already introduced on main, without schema or cleanup writes
when storage exists. Planned projects remain in the durable queue until an
executor is available; this change preserves that behavior. Keeping a nonce longer never weakens replay protection.

Log retention skips routine-only/duplicate batches. After retained inserts it
seeks the 5,000th event and deletes the indexed overflow range, preserving the
strict per-node cap, timestamp/event-ID ordering and seven-day retention.
Project-list counters aggregate work items once for the latest 50 projects.
Migration 0023 adds per-node normalized history indexes and a project time index;
runtime bootstrap installs the equivalent indexes for existing databases.

The published Operations UI shares one fleet poll: 60 seconds idle, 10 seconds
active. Detail progress polls run every 10 seconds, and the main refresh does not
also request details while that watcher is running. Hidden-tab guards remain.

## Capacity assumptions

Cloudflare Free currently allows 5,000,000 rows read and 100,000 rows written per
account per UTC day. Inserts, updates, deletes and affected indexes count.
See <https://developers.cloudflare.com/d1/platform/pricing/>.

`tests/d1-poll-budget.mjs` separately projects reads and writes. For one stable
sync node polling every 30 seconds it reserves:

| Source | Written row equivalents per day |
| --- | ---: |
| Sync replay claims in D1 | 0 |
| One persisted heartbeat every four minutes, including last-seen indexes | 1,080 |
| Five-minute AI refresh, two snapshot tables | 576 |
| Total | 1,656 |

Twenty-seven stable nodes project about 44,712 written row-equivalents/day. Fifty
project about 82,800, leaving roughly 17% modeled headroom under the 100,000 daily
Free write limit before tasks, logs, enrollment and other exceptional writes.
This estimate excludes startup/schema work, changing network/hardware, browser
authentication, tasks, command acknowledgements, telemetry and other databases.
It is a capacity estimate, not measured production usage or a quota guarantee.
Cloudflare Analytics and per-query `meta.rows_read`/`meta.rows_written` remain
authoritative. Retention does not undo writes already charged that day.

## Verification and rollout

`npm test` includes production SQL on SQLite, agent behavior/fallback tests and
actual workerd with local D1. These cover conditional snapshots, liveness refresh,
fresh progress timestamps, signatures, nonce replay, revocation, pause, delivery,
retention and indexed cleanup. `scripts/validate.sh` also runs these regressions.

The Controller/installer pins and Windows/Linux package builders select 0.3.35
(including Windows repair state protection). Release source URLs target main;
publish matching agent archives before initiating a live update.

Rollback: revert the Controller/UI/agent changes and coordinated release pins.
The additive history indexes can remain. No report, result, session or security
history is deleted by this migration.
