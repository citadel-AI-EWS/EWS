# Temporary SSH gate (TEST)

This branch implements the "site knocks, agent opens" model without exposing TCP/22 to the Internet.

## Security model

1. The node keeps the SSH gate closed by default.
2. Architect selects a live node and explicitly requests temporary access.
3. Controller creates an `ssh_open` command only for an admin role, requires the exact confirmation `OPEN_SSH`, generates a random session id, bounds TTL to 60–900 seconds, and signs the complete command with the existing Controller Ed25519 key.
4. The node rejects stale/invalid/unknown commands. If SSH gate is enabled in local config, it checks that an SSH service is already reachable at `127.0.0.1:22`, then binds a proxy only to `127.0.0.1:2222`.
5. Cloudflare Tunnel should point the SSH application at `127.0.0.1:2222`. Cloudflare Access/MFA remains the identity gate.
6. The in-process proxy disappears at TTL, on `ssh_close`, or whenever the agent exits/restarts. It is never recreated automatically after restart; a new signed Controller command is required.

There is no firewall rule and no listener on a LAN/public address in this feature.

## Prerequisites

The gate does **not** install or reconfigure OpenSSH and does not create SSH users, passwords, keys, Cloudflare tunnels, DNS records, or Access policies. Those are separate administrator actions.

Before enabling the gate, the machine should have:

- a local SSH daemon listening only on loopback (`127.0.0.1:22`, or another explicitly configured loopback target port);
- key/certificate authentication preferred; password authentication disabled where practical;
- a Cloudflare Tunnel whose SSH origin is the gate listener (`127.0.0.1:2222`);
- a Cloudflare Access policy with MFA/step-up for the intended administrators.

## Agent configuration

The gate is opt-in:

```json
{
  "ssh_gate_enabled": true,
  "ssh_gate_listen_port": 2222,
  "ssh_gate_target_port": 22
}
```

Windows Core Service installation can preserve this explicit opt-in with:

```powershell
.\setup_windows.ps1 -EnableSshGate
```

The Quick user-mode installer never silently enables remote administration. If the setting was explicitly enabled in its existing state config, reinstall preserves it.

## What this is not

- not classic unauthenticated UDP/TCP port knocking;
- not an arbitrary Controller shell command;
- not a public TCP/22 exposure;
- not lateral movement or host discovery;
- not an SSH credential store.

The Controller only controls the lifetime of a fixed loopback transport. SSH authentication and Cloudflare identity enforcement remain separate layers.
