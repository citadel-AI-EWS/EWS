# CITADEL node API v1

The Cloudflare Worker exposes a deliberately bounded node API backed by the
`citadel-control` D1 database. It stores and transfers work records; it does not
execute commands on nodes and it has no arbitrary-shell route.

## Public routes

- `GET /api/health` — D1 and controller-signing readiness check.
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
  "agent_version": "0.1.0",
  "capabilities": ["system_inventory", "file_hashing"]
}
```

## Signed node routes

- `POST /api/v1/nodes/{node_id}/heartbeat`
- `GET /api/v1/nodes/{node_id}/assignments`
- `POST /api/v1/nodes/{node_id}/assignments/{assignment_id}/accept`
- `POST /api/v1/nodes/{node_id}/results`
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
- `GET /api/v1/architect/reports/{result_id}`

The list route returns metadata only. Full report content is returned only by
the detail route. Both require the architect bearer token.

## Safety boundary

Mission types are constrained by D1 to inventory, log/config/dependency audits,
advisory analysis, and file hashing. Commands are constrained to `pause`,
`resume`, `update`, and `uninstall`. A node must independently validate a
command's controller signature and must never treat `payload` as shell code.

Architect routes require a separately configured bearer token. The browser
console exposes only allow-listed safe missions and signed node controls.
