# Google Drive payload storage

CITADEL stores large project/session/report payloads in the private Google Drive
reports folder while D1 keeps identifiers, ownership, hashes, sizes and Drive
file pointers.

## Authentication

The Worker uses the same OAuth refresh-token flow preserved from the earlier
Google Drive tiering prototype (#37):

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REFRESH_TOKEN`

The Worker exchanges those values at Google's OAuth token endpoint and uses the
short-lived access token only in memory.

## Encryption

New Drive payloads are encrypted inside the Worker before upload with
AES-256-GCM. Configure one protected 32-byte base64url key:

- `GOOGLE_DRIVE_PAYLOAD_ENCRYPTION_KEY`

For compatibility, the runtime also accepts the historical
`GOOGLE_DRIVE_REPORT_ENCRYPTION_KEY` name. Key version defaults to `v1` and
may be set with `GOOGLE_DRIVE_PAYLOAD_KEY_VERSION`.

D1 continues to store the SHA-256 and exact byte size of the plaintext payload.
On read, the Worker decrypts first, then verifies plaintext byte size and SHA-256
before parsing JSON.

Legacy unencrypted Drive payloads remain readable so an upgrade does not make
older data inaccessible. Every new write is encrypted.

## Readiness

`/api/health` reports `payload_storage=ready` only when both conditions hold:

1. Google Drive OAuth can produce an access token.
2. The payload encryption key is present and valid.

The deployment smoke test requires that readiness state, so TEST cannot be
reported green while payload storage is unusable.

Never commit OAuth credentials or encryption keys to the repository, issues,
logs, Drive documents or artifacts.
