# Interactive SSH in Hub

The Machines/Operations UI exposes an interactive SSH terminal for registered
CITADEL nodes. The preferred transport from agent release 0.3.39 is the
agent-owned outbound relay; it does not require an inbound SSH port, VPN route or
Cloudflare Tunnel on the node.

## Preferred path: outbound node relay

```text
Browser
  -- same-origin WSS -->
Hub Worker / per-node SSH relay
  -- authenticated outbound WSS -->
CITADEL node agent
  -- SSH to 127.0.0.1:22 -->
Windows OpenSSH
  --> citadel-admin
```

The browser cannot choose the target address, username, key or port. The
Controller issues a short-lived session ticket for exactly one registered node.
The node signs its relay connection with its existing CITADEL Ed25519 identity.
Terminal bytes are relayed in memory and are not stored in D1.

### Windows managed administrator

On a new Windows install or an explicit installer repair, CITADEL attempts to
provision the managed SSH account automatically:

- local account: `citadel-admin`;
- membership: local `Administrators`;
- SSH listener: `127.0.0.1:22` only;
- authentication: public key only; password SSH authentication is disabled;
- forwarding: agent forwarding, TCP forwarding and gateway ports are disabled;
- Windows OpenSSH inbound firewall rule is disabled;
- a dedicated Ed25519 relay key is generated under
  `C:\ProgramData\CitadelEWS\ssh`;
- the private relay key stays on the node and is readable only by SYSTEM,
  Administrators and the LocalService account used by the CITADEL Core Agent;
- the agent pins the local OpenSSH Ed25519 host key before opening the local SSH
  connection.

The account receives a random local password only because Windows requires a
password value when creating the local account. CITADEL does not print or store
that password in Hub/D1, and SSH is configured not to accept it.

The bootstrap refuses to elevate an arbitrary pre-existing local account. It may
reuse/elevate the same account only when CITADEL's previous bootstrap state proves
that CITADEL created it. If OpenSSH already existed on a machine but is not under
CITADEL bootstrap control, automatic repair fails closed instead of silently
rewriting that administrator's SSH policy. The Core Agent remains installed.

Existing nodes which only self-update to 0.3.39 keep working through the restricted
fallback described below. They need one elevated Windows installer repair before
`citadel-admin` can be created because the normal Core Agent runs as
`NT AUTHORITY\LocalService` and deliberately cannot create local administrators.

## Compatibility fallback

If the managed Windows bootstrap state is absent, the outbound relay preserves
the existing restricted mode. The agent creates a temporary loopback AsyncSSH
server with a generated one-session key and exposes only the fixed CITADEL
read-only console. This lets older nodes continue to provide diagnostic SSH
without granting a shell.

The browser receives the relay mode in the ready message:

- `managed_admin` — real local OpenSSH shell as `citadel-admin`;
- `restricted_fallback` — fixed CITADEL diagnostic console.

Closing the dialog, changing the selected node, logging out or leaving the page
closes the browser session. Reconnecting starts a new session.

## Separate Cloudflare / external-gateway modes

`docs/SSH_ZERO_TRUST.md` documents the older Cloudflare Access/Tunnel path. It
continues to use the restricted ForceCommand console and can coexist with the
outbound relay.

The repository also retains the external SSH gateway implementation for
installations that intentionally route through a separately operated gateway.
That path uses short-lived Hub tickets, a pinned target map and host-key
verification. It is not required for the 0.3.39 outbound managed-admin relay.

## Security boundaries

Hub/D1 must not store the node relay private key, the random local password,
Cloudflare tokens or CA private material. The managed private key never leaves
the node. Browser users cannot override the node id or SSH target through the
session API.

The privileged shell is available only to an Architect role allowed to issue a
full SSH session. It is intentionally more powerful than the inline
`ssh_console` command channel, which remains a fixed diagnostic allow-list.

## Verification

Automated coverage includes:

- `tests/ssh-relay-agent.py` — real outbound relay plus restricted fallback;
- `tests/ssh-relay-workerd.mjs` — per-node relay ticket and Worker behavior;
- `tests/ssh-terminal-e2e.mjs` — browser/gateway protocol and terminal lifecycle;
- Windows CI PowerShell parsing/policy guards for loopback-only sshd and
  managed-admin bootstrap invariants.

A production Windows proof is complete only when the installer reports
`Managed SSH: READY / citadel-admin / loopback-only / key-only`, the node relay
is connected, Browser SSH reports `managed_admin`, and commands such as
`whoami` execute inside the remote Windows session.
