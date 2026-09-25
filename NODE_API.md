# CITADEL node API v1

The Cloudflare Worker exposes a deliberately bounded node API backed by the
`citadel-control` D1 database. It stores and transfers work records; it does not
execute commands on nodes and it has no arbitrary-shell route.

## Public routes

- `GET /api/health` — D1, controller-signing, report/session and telemetry readiness check.
- `GET /api/v1` — supported mission and command types.
- `POST /api/v1/enroll` — automatically register a new node and assign its permanent sequential number.

No manual code, login, confirmation, or enrollment token is required. The node generates its own Ed25519 identity locally and supplies only the public key. Repeating enrollment with the same key returns the same node ID and number:

```json
{
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
value is included in the signed message. The private key never leaves the computer.

## Controller-signed commands

Commands returned by `GET /api/v1/nodes/{node_id}/commands` are authenticated
independently from the node request signature. A node must reject a command unless
all of the following verify:

- algorithm: Ed25519;
- trust root: the pinned Controller public JWK whose `x` value is
  `erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0`;
- signature: unpadded base64url in the command's `signature` field;
- payload hash: SHA-256 of the exact UTF-8 bytes of `JSON.stringify(command.payload || {})`;
- signed UTF-8 message:

```text
CITADEL-COMMAND-V1
COMMAND_ID
NODE_ID
COMMAND_TYPE
SHA256_HEX_OF_PAYLOAD_JSON
CREATED_AT
```

The private Controller signing key exists only as the protected
`CONTROLLER_COMMAND_PRIVATE_JWK` deployment secret. Nodes never receive it.
Unknown command types, a mismatched node ID, an invalid signature, or a command
outside the local allow-list must be rejected without execution.

### Restricted host power controls

The allow-list includes two host-level power operations:

- `system_reboot` — schedule an operating-system reboot;
- `system_shutdown` — schedule an operating-system shutdown.

These are not arbitrary SSH or shell commands. The node maps each command type to
fixed local argv and always uses `shell=False`; the Controller cannot supply an
executable, flags, script, path, service name, or other command text. The
Architect API also requires the exact confirmation word `REBOOT` or `SHUTDOWN`
before it will queue the corresponding signed command.

The node never performs privilege escalation. The account running CITADEL must
already have the operating-system permission required to reboot or power off the
machine. Windows schedules the action with the built-in shutdown utility after a
short delay; POSIX systems schedule it through the local shutdown utility, giving
the agent time to acknowledge and log the request first.

Read-only diagnostics such as inventory, CPU/RAM, network state and operational
logs remain separate bounded APIs/missions rather than shell commands.

### Temporary SSH gate (TEST)

`ssh_open` and `ssh_close` are allow-listed transport-gate commands, not a
Controller-supplied shell. `ssh_open` is admin-only, requires `OPEN_SSH`,
carries a Controller-generated session id and a TTL from 60 through 900 seconds,
and is covered by the normal Ed25519 Controller signature.

When locally enabled, the agent checks an already-existing loopback SSH service
and temporarily binds only `127.0.0.1:2222`; it proxies only to the configured
loopback SSH target (default `127.0.0.1:22`). The listener is closed on TTL,
`ssh_close`, or agent exit/restart. The agent never opens a firewall rule or
binds the gate to a LAN/public interface.

Cloudflare Tunnel should target the loopback gate and Cloudflare Access/MFA must
remain the external identity boundary. See `docs/SSH_GATE.md`.

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

Authenticated Architect routes include:

- `GET /api/v1/architect/overview`
- `POST /api/v1/architect/missions`
- `POST /api/v1/architect/nodes/{node_id}/commands`
- `GET /api/v1/architect/reports?limit=50&offset=0`
- `GET /api/v1/architect/reports/{report_id-or-result_id}`
- `GET|POST /api/v1/architect/sessions`
- `GET|PATCH|DELETE /api/v1/architect/sessions/{session_id}`
- `GET /api/v1/architect/storage`

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
- at most 60 authenticated telemetry requests per node in a five-minute window;
- rate-limited requests return HTTP 429 with `Retry-After: 300`;
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

The active Python node contains only locally registered bounded mission handlers
and explicitly allow-listed signed controls. It has no arbitrary remote-command
API, arbitrary code loader, credential collector, exploit engine, lateral
movement, stealth installation, self-propagation, or autonomous financial
transaction capability. The optional SSH gate is a fixed loopback transport
window; it cannot carry Controller-supplied command text and is disabled unless
the local node configuration explicitly opts in.

Architect routes require a separately configured bearer token. The browser
console exposes only allow-listed missions, signed node controls, the bounded
temporary SSH gate, and read-only operational telemetry.


## Replay protection (agent 0.3.10+)

Signed node requests from agent 0.3.10 and later include a UUIDv4 `x-node-request-id` header. The request id is part of the Ed25519 canonical request between the timestamp and body hash. The Controller stores recent per-node request ids and rejects reuse with `409 replayed_request`.

For compatibility during rollout, nodes older than 0.3.10 may continue using the previous signature form inside the existing timestamp window. Once a node reports agent 0.3.10 or later, `x-node-request-id` is mandatory.
