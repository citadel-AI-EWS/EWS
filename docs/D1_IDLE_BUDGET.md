# D1 idle polling budget

The previous 30-second agent cycle issued separate command, heartbeat, AI-state
and assignment requests. Every signed request previously inserted a replay nonce; deleting
expired nonces also consumed the daily write quota. Modern signed node-request replay IDs now live in the per-node Durable Object instead of D1 on every route. D1-only deployments remain supported when no DO binding is configured. A configured DO outage (including a lost response after a committed claim) returns HTTP 503 `node_replay_store_unavailable`: automatically switching to an independent D1 store could accept the same request twice. Before a DO claim, one indexed read checks any legacy D1 nonce, preserving rejection when transitioning from D1 to DO. Do not remove a configured binding during signed traffic; drain the signature window before reverting to D1-only operation. Nonces outlive the entire accepted signature window, including future clock skew. Repeated identical `cycle_error` and `operation_heartbeat_failed` telemetry is also coalesced per node for five minutes in the Durable Object; unique errors, command failures, security events and results are never coalesced by this rule. Network, presence and AI
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
write only when their observed values change. SSH readiness follows the same rule
on both sync and legacy heartbeat; changes to every readiness bit and bind target
persist immediately, while owner-configured hostname/user/fingerprint are preserved.
Its `observed_at`/`updated_at` indicate the last changed observation, rather than a
keepalive. Live SSH relay connectivity still comes from the Durable Object.
The fleet view uses the same five-minute liveness lease as Guardian, so an unchanged
node does not flicker offline between four-minute heartbeat writes. Snapshot `updated_at` represents
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

The compatibility nonce lookup adds one indexed D1 read per signed request and
no D1 writes. For 50 stable sync nodes that is 144,000 additional reads/day.
The conservative three-route read model includes this lookup on all three routes.

| Source | Written row equivalents per day |
| --- | ---: |
| Sync replay claims in D1 | 0 |
| One persisted heartbeat every four minutes, including last-seen indexes | 1,080 |
| Unchanged SSH readiness snapshot | 0 |
| Five-minute AI refresh, two snapshot tables plus summary index | 864 |
| Total | 1,944 |

Twenty-seven stable nodes project about 52,488 written row-equivalents/day. Fifty
project about 97,200, leaving only 2.8% modeled headroom under the 100,000 daily
Free write limit before Guardian, tasks, logs, enrollment and other exceptional writes.
That is not a safe operational capacity claim for fifty nodes. The previous model
missed the AI summary index and the unconditional SSH snapshot. Before the latter
fix, a 30-second SSH probe could add 5,760 row-equivalents/day/node (table + index),
even through `/sync`. No agent upgrade is needed for this server-side correction.
This estimate excludes startup/schema work, changing network/hardware, browser
authentication, tasks, command acknowledgements, telemetry and other databases.
It is a capacity estimate, not measured production usage or a quota guarantee.
Cloudflare Analytics and per-query `meta.rows_read`/`meta.rows_written` remain
authoritative. Retention does not undo writes already charged that day.

## Measured write attribution

The D1 Capacity Check now runs after a successful main TEST deployment as well as
on its existing daily schedule/manual trigger. In addition to account/database UTC
daily totals, it reads Cloudflare `d1QueriesAdaptiveGroups`, sorted by written rows,
for the UTC day so far, the previous complete UTC hour and the current partial
UTC hour. Each window is explicit; the partial hour is not a full-hour rate.
Only allowlisted table labels, query hashes and numeric counters are published;
raw SQL, literals, node identifiers, IPs and credentials are never printed.
This diagnostic adds no operational D1 queries/writes. Query insights are adaptive
and can be sampled/delayed; the top 30 queries are not a complete billing ledger.
Unavailable insights are reported as incomplete, never as zero writes.

The 2026-10-03 07:01 UTC run on `9a3e5d9` reported 226,352 account writes and
226,376 database writes for that UTC day, after the #268 deployment at 20:36 UTC
on October 2. These approximate totals establish continued load, but do not
attribute all of it to SSH, legacy routes, AI state or any other single source.
Use the new query attribution before making that claim.

After #277/#278, capacity runs at 12:47:06 and 13:22:49 UTC on October 3 both
reported 267,902 writes, while reads rose from 1,368,630 to 1,380,079. The nonce
INSERT counter stayed at 34,247 executions / 102,741 writes; retained log INSERTs
stayed at 16,146 executions / 96,876 writes. This is a measured 35-minute plateau,
not proof of a full clean UTC day or 50 active physical hosts. The daily warning
remains because already-counted writes do not disappear after a fix.

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
