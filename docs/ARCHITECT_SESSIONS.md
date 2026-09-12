# Architect session checkpoints

Architect checkpoints preserve a small, versioned view of the current work on
the server. They do not preserve authentication and do not duplicate full
report bodies.

## Stored fields

- generated session ID and user-provided name;
- schema version, status, and timestamps;
- selected node/report identifiers and the currently expanded section;
- server-generated counts for nodes, missions, results, and reports;
- exact UTF-8 byte size and SHA-256 digest of the snapshot.

Unknown UI fields are discarded by an allowlist. Architect bearer tokens,
private keys, passwords, API keys, cookies, and report contents are never
accepted as snapshot fields.

## Authenticated routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/architect/sessions` | List checkpoint metadata |
| `POST` | `/api/v1/architect/sessions` | Create a named checkpoint |
| `GET` | `/api/v1/architect/sessions/{id}` | Retrieve one checkpoint |
| `PATCH` | `/api/v1/architect/sessions/{id}` | Rename, archive, or reactivate |
| `DELETE` | `/api/v1/architect/sessions/{id}` | Delete with an audit record |
| `GET` | `/api/v1/architect/storage` | Read tracked report/session usage |

The Architect web console can save, restore, archive, export, and delete a
checkpoint. Restoring a checkpoint requires a currently valid Architect
login; the stored checkpoint cannot recreate or extend authorization.

## Storage limits

- request body: 24 KiB;
- normalized snapshot: 16 KiB;
- D1 operational target: remain below 400 MiB of the 500 MiB per-database
  Free-plan limit;
- the storage meter counts report payloads and session snapshots only, so D1
  tables and indexes still require reserved headroom.

The Worker creates the schema idempotently through its existing D1 runtime
binding. `migrations/0002_architect_sessions.sql` is retained for future
administrator-managed migrations.
