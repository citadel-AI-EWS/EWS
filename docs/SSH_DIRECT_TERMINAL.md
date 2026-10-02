# Interactive SSH in Hub without Cloudflare Tunnel

The Machines page now offers **SSH** on every registered node. Its dialog has a
host selector, an xterm terminal, Connect and Disconnect. The terminal transports
real SSH PTY input/output, including control keys and resize events, **only after** the remote account proves that OpenSSH launched `CITADEL Restricted SSH Console` via ForceCommand. Ordinary bash, PowerShell, cmd or administrator shells are rejected. Closing the
dialog, selecting another node, logging out or leaving the page closes the
session. Reconnecting starts a new session; output from the previous node is cleared.

The transport is:

```text
Browser -- same-origin WSS --> Hub Worker -- HTTPS/WebSocket --> SSH gateway -- TCP/SSH --> host
```

Cloudflare Tunnel and Access are not used. The existing Hub UI/control plane
still runs on Workers/D1. The SSH gateway is a separate Node 22+ service on a
server you control, behind a TLS reverse proxy. D1 stores audit metadata only;
SSH private keys remain on the gateway. The gateway must be able to reach each
configured SSH address. A node behind NAT needs port forwarding, VPN routing or
a separately implemented reverse relay. This version does not add a reverse
relay or open ports on nodes automatically.

## Provision one host

1. Install/enable OpenSSH on the target. Choose the SSH account and its OS
   permissions. The terminal gets exactly that account's permissions.
2. On the gateway, create a dedicated Ed25519 key with `ssh-keygen`. Put its
   public key in the target account's `authorized_keys`. Protect the private key
   with filesystem permissions readable only by the gateway service account.
3. Verify the target host fingerprint through a trusted administrative channel.
   On the target, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`
   prints it on Linux. Windows normally stores host keys under
   `C:\ProgramData\ssh`. A remotely collected `ssh-keyscan` key still needs
   independent verification before trusting it.
4. Restrict the host's SSH firewall rule to the gateway's source address, or
   use private VPN routing. Test key authentication from the gateway.
5. Copy `gateway/targets.example.json` to `/etc/citadel-ssh/targets.json` and
   replace its placeholders. Each map key is the registered CITADEL `node_id`
   from `/api/v1/architect/machines`. The value contains `host`, integer `port`,
   `username`, `mode: "citadel-restricted"`, verified `hostKeySha256` and absolute `privateKeyFile`.

Targets are provisioned by the gateway administrator. A browser cannot change
the IP, port, user, fingerprint or key through the session API. A missing target
produces an explicit not-configured error before any SSH connection is attempted.
Hosts without a registered CITADEL node are not selectable in this first version.

Existing CITADEL Windows Zero Trust bootstrap binds OpenSSH to loopback and enforces the restricted ForceCommand. Direct gateway routing must expose that same dedicated restricted SSH account to the gateway through a separately reviewed network path. The gateway waits for the exact `CITADEL Restricted SSH Console` banner before enabling browser input; if it sees an ordinary shell instead, the session is terminated. This feature does not remove ForceCommand or grant administrator rights.

## Run the gateway

Install Node 22.13+ and install the gateway dependencies from the pinned lockfile:

```sh
cd /opt/citadel/EWS
npm ci --omit=dev --workspace=citadel-ssh-gateway --ignore-scripts
```

Run it under a dedicated `citadel-ssh` service account. Create a protected
`/etc/citadel-ssh/gateway.env` containing:

```text
CITADEL_HUB_ORIGIN=https://citadel-ai.init1.workers.dev
CITADEL_SSH_TARGETS_FILE=/etc/citadel-ssh/targets.json
SSH_GATEWAY_TICKET_SECRET=<random shared secret, at least 32 characters>
PORT=8080
CITADEL_SSH_REPLAY_DB=/var/lib/citadel-ssh/replays.sqlite
```

Generate the shared secret locally, for example with `openssl rand -hex 32`.
Do not put its value in the repository, tickets, chat or logs. Give the same
value to the Hub deployment secret described below. Make configuration and key
files readable by the service account only. Use the sample
`gateway/citadel-ssh-gateway.service`, adapting paths to your installation.

The HTTP listener binds only to `127.0.0.1`. Configure your TLS reverse proxy
to forward `/ssh` upgrades to it; `gateway/Caddyfile.example` shows Caddy's
configuration. Configure a real hostname and certificate for that server.
The gateway checks the exact Hub origin and validates the signed ticket, so
do not configure proxy logs to capture request headers or session tickets.

Use one gateway process. Ticket ids/expiry times are stored atomically in its
local SQLite replay database and survive restart; no credentials or terminal
output are written there. The sample systemd service creates the writable
`/var/lib/citadel-ssh` state directory. Session quotas are kept in process memory.
Multiple replicas need a shared atomic replay/session store before using the
same ticket secret. Restarting the gateway closes active sessions.

## Enable Hub

In the protected GitHub `cloudflare-test` environment, set these secrets:

- `SSH_GATEWAY_URL`: `https://ssh-gateway.example.com/ssh`
- `SSH_GATEWAY_TICKET_SECRET`: the shared secret above

The deploy workflow syncs them only when both are configured. A partial
configuration fails deployment rather than enabling an incomplete gateway.
Then run Deploy Cloudflare TEST. Without these secrets, the terminal tells
the user that interactive SSH is not configured; it does not simulate a session.

Sign into Hub as the owner, choose **SSH** on a node and click **Connect**.
Operator/viewer tokens cannot obtain full SSH sessions. The node need not have
a fresh agent heartbeat if its independently configured SSH endpoint is reachable;
revoked/deleted nodes cannot obtain tickets or connect. Agent revocation during an
existing SSH session does not interrupt that session automatically: use Disconnect
or stop the gateway. Sessions are capped at 30 minutes, and tickets expire after
60 seconds. Architect token revocation takes effect for ticket issuance; a ticket
already issued can be redeemed until its 60-second expiry.

The gateway accepts a ticket once, limits each actor to two active sessions and
the process to 32, pins the SSH host key, requires key authentication and bounds
input/output buffers. The idle timeout is ten minutes. It logs session opens,
closes and reason codes without command text, terminal output or credentials.
Gateway credentials are unavailable to the browser and the Hub/D1 database.

## Verification

`node tests/ssh-terminal-e2e.mjs` runs the actual Worker, local D1, WebSocket
gateway and SSH protocol server with generated test keys. It checks PTY I/O and
resize, owner permission, target override rejection, replay, host-key mismatch,
unconfigured targets, revocation and audit privacy.

`scripts/build_site.sh && node tests/ssh-terminal-e2e.mjs --browser` adds Chromium
checks of the real terminal, node switching, mobile layout, disconnect and logout.
The SSH fixture is a real protocol server; it is not proof of a connection to a
production Windows/Linux host. A live test requires the configured gateway and
reachable target described above.
