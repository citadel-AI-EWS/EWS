# Authorized agent deployment

This module adds controlled distribution of the CITADEL/EWS Windows agent to
computers that the operator owns or administers.

It is intentionally **not** worm-like self-propagation. The agent does not scan
the LAN, discover neighboring computers, reuse credentials, open WinRM/SSH,
exploit vulnerabilities, or silently install itself elsewhere.

## Flow

1. The Architect creates one deployment invitation with
   `POST /api/v1/architect/deployments`.
2. The Controller stores only the SHA-256 hash of the invitation token.
3. The operator copies `agent/install_from_invite.ps1` to the authorized
   target and runs it locally.
4. The target redeems the invitation once at
   `POST /api/v1/deployments/redeem`.
5. The Controller returns a pinned release manifest.
6. The bootstrap downloads only the approved CITADEL repository artifact,
   verifies the exact SHA-256 digest, and stages it.
7. Installation happens only when the operator explicitly supplies both
   `-Install` and `-AuthorizeThisHost`. Windows UAC/admin approval still
   applies.
8. The existing agent enrollment then creates/reconciles the node identity and
   the computer appears in the Hub.

## Example

Create an invite from an authenticated Architect client:

```http
POST /api/v1/architect/deployments
Authorization: Bearer <architect-token>
Content-Type: application/json

{"label":"Office PC 07","ttl_minutes":60}
```

On that authorized Windows computer:

```powershell
powershell -NoLogo -NoProfile -File .\install_from_invite.ps1 -InviteToken "<token>"
```

The first run only downloads and verifies the package. To install:

```powershell
powershell -NoLogo -NoProfile -File .\install_from_invite.ps1 -InviteToken "<new-token>" -Install -AuthorizeThisHost
```

Invitation tokens are single-use, so staging and installation should normally
be done in one run when installation is intended.

## Security boundaries

- Primary Architect token required to create/list/revoke invitations.
- One invitation = one target redemption.
- Maximum invitation TTL is 24 hours.
- Invitation plaintext is returned only once; D1 stores its SHA-256 hash.
- Package source is restricted to the official repository path.
- Package SHA-256 is pinned by the Controller and rechecked locally.
- No target discovery, no lateral movement, no remote shell, no credential
  collection, and no hidden persistence mechanism is added.
- Existing CITADEL installer/service behavior remains visible and uninstallable.

A future MDM/Intune/Ansible adapter can call the same invitation API, but any
such adapter must remain administrator-configured and target an explicit
inventory/allowlist rather than discovering machines autonomously.
