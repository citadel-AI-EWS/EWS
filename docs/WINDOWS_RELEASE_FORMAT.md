# Windows release format (schema 1)

This document defines the immutable on-disk release contract for Issue #160.
It is normative for `agent/windows/release_format.py`.

## Security model

A release is trusted only after full verification. The verifier is pure and
does not mutate service state, release-state, ACLs, or update journals.

For schema 1, release descriptors reuse the existing pinned CITADEL Controller
Ed25519 public key as the release-signing trust root. Nodes never receive the
private key. A later migration may introduce a dedicated release-signing key,
but it must use a new `signing_key_id` and an explicit compatibility plan.

## Files

A release directory contains:

- `RELEASE.json` — canonical UTF-8 JSON descriptor;
- `RELEASE.json.sig` — detached base64url Ed25519 signature over the exact
  bytes of `RELEASE.json`;
- `RELEASE.OK` — canonical JSON binding the committed directory to the exact
  descriptor SHA-256;
- every payload file listed in `RELEASE.json.files`.

`RELEASE.OK` may be absent while a release is still in staging. A committed
release must have it.

## RELEASE.json schema 1

Required fields:

- `schema`: integer `1`
- `product`: `"citadel-ews-node"`
- `version`: release version such as `0.3.22`
- `release_id`: deterministic ID
- `manifest_sha256`: SHA-256 of the canonical whole-release manifest
- `min_launcher_version`
- `min_state_schema`
- `max_state_schema`
- `writes_state_schema`
- `files`: non-empty array of file records
- `created_at`: UTC ISO-8601 ending in `Z`
- `signing_key_id`: schema-1 default is
  `controller-command-ed25519-v1`

Optional field: `build_id`.

Unknown fields are rejected in schema 1.

Each file record contains exactly:

```json
{"path":"runtime/python.exe","sha256":"<64 lowercase hex>","size":123}
```

The JSON descriptor itself is canonicalized with sorted keys, UTF-8,
no insignificant whitespace, and no NaN/Infinity.

## Manifest digest and release ID

For each file record, after path validation, create this UTF-8 line:

```text
<path>\0<size>\0<sha256>\n
```

Sort records case-insensitively by path, concatenate the lines, then calculate
SHA-256.

`release_id` is:

```text
<version>-<first 16 hex chars of manifest_sha256>
```

This gives deterministic content binding without using a random GUID as the
committed release identity.

## Path rules

Manifest paths:

- use forward slashes only;
- are relative;
- cannot contain `.`, `..`, `:`, NUL, control characters, or alternate
  data streams;
- cannot end a path component with a dot or space;
- cannot use reserved Windows device names such as `CON`, `NUL`, `COM1`;
- must be unique case-insensitively.

Release IDs use only `A-Z a-z 0-9 . _ -`, must begin and end with an
alphanumeric character, and cannot contain `..`.

## Tree verification

The verifier must reject:

- a reparse/symlink release root or payload path;
- a hard-linked payload file where link count is exposed;
- missing files;
- size or SHA-256 mismatch;
- an invalid or missing Ed25519 signature;
- a descriptor whose `release_id` does not match the directory;
- a non-deterministic release ID;
- unmanifested executable/script payloads such as `.exe`, `.dll`, `.pyd`,
  `.ps1`, `.bat`, `.cmd`;
- missing `runtime/python.exe` or `citadel_node_v2.py`.

## RELEASE.OK

A committed release uses canonical JSON:

```json
{"descriptor_sha256":"<sha256>","release_id":"<id>","verified_at":"<UTC Z>"}
```

The descriptor hash is over the exact canonical `RELEASE.json` bytes.

The stable launcher does not redo the full manifest/hash/signature verification
on every service start. Full verification belongs to the release manager before
commit. The launcher trusts the immutable committed tree ACL plus `RELEASE.OK`
and its existing structural checks.

## Non-goals of this format PR

This format does not define or implement:

- `release-state.json` writes;
- staging transactions;
- update journals;
- Service/Task ImagePath cutover;
- remote-update migration;
- rollback or GC.

Those are separate Issue #160 PRs.
