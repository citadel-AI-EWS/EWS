# CITADEL node API v1

The Cloudflare Worker exposes a deliberately bounded node API backed by the
`citadel-control` D1 database. It stores and transfers work records; it does not
execute commands on nodes and it has no arbitrary-shell route.

## Public routes

- `GET /api/health` — D1, controller-signing, report/session and telemetry readiness check.
- `GET /api/v1` — supported mission and command types.
- `POST /api/v1/enroll` — enroll one node using an active enrollment batch token.

The enrollment token is sent once over HTTPS. D1 stores only its SHA-256 hash.
The node supplies an Ed25519 public key as JWK:

```json
{
  "enrollment_token": "one-time-high-entropy-token",
  "public_key": { "kty": "OKP", "crv": "Ed25519", "x": "base64url-key" },
  "hostname": "owned-node-01",
  "os_name": "Linux",
  "os_version": "example",
  "architecture": "x86_64",
  "agent_version": "0.2.0",
  "capabilities": ["system_inventory"]
}
```

## Signed node routes

- `POST /api/v1/nodes/{node_id}/heartbeat`
- `GET /api/v1/nodes/{node_id}/assignments`
- `POST /api/v1/nodes/{node_id}/assignments/{assignment_id}/accept`
- `POST /api/v1/nodes/{node_id}/results`
- `POST /api/v1/nodes/{node_id}/logs`
- `GET /api/v1/nodes/{node_id}/commands`
- `POST /api/v1/nodes/{node_id}/commands/{command_id}/ack`

Each request must include:

- `x-node-id`
- `x-node-timestamp` — Unix seconds or milliseconds, within five minutes.
- `x-node-signature` — unpadded base64url Ed25519 signature.

The signed UTF-8 message is:

```text
METHOD
/path?query
TIMESTAMP
SHA256_HEX_OF_EXACT_BODY
```

For a request without a body, hash the empty string. The exact timestamp header
value is included in the signed message.

## Durable reports

`POST /api/v1/nodes/{node_id}/results` stores the complete authenticated report
in D1 together with its SHA-256 digest, byte size, type and sensitivity label.
The request remains backward compatible with the earlier result shape. A full
report can be supplied as `report`:

```json
{
  "assignment_id": "assignment_example",
  "outcome": "success",
  "summary": "Short operator-facing summary",
  "metrics": { "files_checked": 42 },
  "report_type": "system_inventory",
  "sensitivity": "internal",
  "report": {
    "findings": [],
    "evidence": { "example": true }
  }
}
```

The maximum serialized `report` size is 512 KiB. Supported sensitivity labels
are `public`, `internal`, `confidential`, and `restricted`.

Authenticated architect routes:

- `GET /api/v1/architect/reports?limit=50`
- `GET /api/v1/architect/reports/{report_id-or-result_id}`

The list route returns metadata only. Full report content is returned only by
the detail route. Both require the architect bearer token.

## Operational telemetry

`POST /api/v1/nodes/{node_id}/logs` accepts only the node's bounded operational
JSONL events after the same Ed25519 authentication used by the rest of the node
API. The telemetry channel is observability-only and is not a command channel.

Server limits:

- request body: at most 64 KiB;
- at most 50 events per batch;
- serialized event: about 2 KiB maximum;
- allow-listed event types and levels only;
- obvious secret-bearing fields and common credential patterns are redacted;
- duplicate `event_id` values are ignored;
- default D1 retention is 7 days;
- hard cap is 5,000 events per node.

Architect-only routes:

- `GET /api/v1/architect/logs?limit=50&node_id=...&level=...&event_type=...`
- `GET /api/v1/architect/logs/stats`

The list route uses an opaque `next_cursor` for pagination. The browser is
published at `/architect/logs/` and reuses the same session-scoped Architect
bearer token as the main Architect console.

The v0.2 Python node reads only its own local `agent.jsonl`, assigns deterministic
event IDs from the node ID, byte offset and original line, and advances a local
cursor only after a successful upload. A retry therefore does not duplicate
stored events.

## Safety boundary

The active Python node contains only locally registered bounded mission handlers.
It has no remote shell, arbitrary code loader, credential collector, exploit
engine, lateral movement, stealth installation, self-propagation, or autonomous
financial transaction capability.

Architect routes require a separately configured bearer token. The browser
console exposes only allow-listed safe missions, signed node controls and
read-only operational telemetry.
