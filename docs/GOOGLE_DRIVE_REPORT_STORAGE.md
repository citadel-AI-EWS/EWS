# Encrypted Google Drive report storage

EWS keeps searchable report metadata in Cloudflare D1 and can store the large
report body in a private Google Drive folder. Every body is encrypted before it
leaves the Worker with AES-256-GCM. D1 keeps the original SHA-256 and plaintext
byte length, and EWS reads the uploaded object back and verifies both values
before replacing the inline D1 body with a sentinel.

## Private folder layout

- Root: `CITADEL_EWS_REPORT_STORAGE_PRIVATE`
- `reports`: encrypted report envelopes used by the Worker
- `manifests`: reserved for signed export/checkpoint manifests
- `quarantine`: reserved for objects that fail future integrity review

Folder IDs are configuration values, not credentials. The folders must remain
private and owned by the project owner. Do not publish a link with edit access.

## Runtime secrets

The Worker requires these encrypted Cloudflare/GitHub environment secrets:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REFRESH_TOKEN`
- `GOOGLE_DRIVE_REPORT_ENCRYPTION_KEY` (32 random bytes, base64url encoded)

The non-secret folder ID and key-version settings live in `wrangler.jsonc`.
Never commit OAuth credentials, refresh tokens, encryption keys, service-account
JSON, or downloaded Google credentials. The previously exposed project Google
and LM Studio credentials must not be reused; revoke/rotate them first.

The ChatGPT Drive connection is not a runtime credential for a deployed
Cloudflare Worker. Runtime OAuth must therefore be authorized once for the EWS
Google Cloud application. Use the narrowest workable Drive permission and grant
the EWS application access to the dedicated storage folder only.

## Fail-safe behavior

If Google OAuth or the encryption key is absent, invalid, rate-limited, or
temporarily unavailable, report submission still succeeds and the full body
stays in D1 with a `deferred` storage state. A controlled migration can be
retried later. No D1 body is removed until upload, authenticated decryption,
plaintext size verification, and SHA-256 verification all succeed.

Deletion is recoverable for seven days. The external file remains intact during
that window. A daily cron permanently removes expired objects; failed deletes
are reverted to a retryable state and recorded in the append-only audit log.

## Activation sequence

1. Revoke the old exposed Google credential and create a clean OAuth client.
2. Authorize only the dedicated storage folder and obtain a refresh token.
3. Generate a new 32-byte encryption key outside the repository.
4. Add the four values as protected TEST secrets.
5. Deploy TEST and require `/api/health` to report `report_google_drive=ready`.
6. Migrate a single non-sensitive report and verify read-back and SHA-256.
7. Increase to a batch of ten, inspect the append-only audit trail, then merge.

Until steps 1–5 are complete, TEST deliberately uses the D1 fallback and the
draft pull request must not be merged to production.
