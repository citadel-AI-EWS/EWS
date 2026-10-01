#!/usr/bin/env bash
set -euo pipefail

SSH_USER="${1:-${CITADEL_SSH_USER:-}}"
RELEASE_ROOT="${CITADEL_RELEASE_ROOT:-}"
STATE_ROOT="${CITADEL_STATE_ROOT:-}"
ACTION="${CITADEL_SSH_ACTION:-configure}"

fail(){ printf '[CITADEL] ERROR: %s\n' "$*" >&2; exit 1; }
log(){ printf '[CITADEL] %s\n' "$*"; }

[[ "${EUID:-$(id -u)}" -eq 0 ]] || fail "SSH bootstrap must run as root."
[[ "$SSH_USER" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail "Unsafe SSH username."
[[ -n "$RELEASE_ROOT" && -n "$STATE_ROOT" ]] || fail "CITADEL_RELEASE_ROOT and CITADEL_STATE_ROOT are required."

RELEASE_ROOT="$(python3 - "$RELEASE_ROOT" <<'PY'
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)"
STATE_ROOT="$(python3 - "$STATE_ROOT" <<'PY'
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
)"

PYTHON="$RELEASE_ROOT/.venv/bin/python"
CONFIGURATOR="$RELEASE_ROOT/ssh_configurator.py"
CONSOLE="$RELEASE_ROOT/ssh_restricted_console.py"
AGENT_CONFIG="$RELEASE_ROOT/config.json"
for path in "$PYTHON" "$CONFIGURATOR" "$CONSOLE" "$AGENT_CONFIG"; do
  [[ -f "$path" || -x "$path" ]] || fail "Required CITADEL SSH bootstrap asset is missing: $path"
done

id "$SSH_USER" >/dev/null 2>&1 || fail "SSH user '$SSH_USER' does not exist. CITADEL will not create password-bearing accounts automatically."

SSHD="$(command -v sshd || true)"
[[ -n "$SSHD" ]] || fail "OpenSSH server is not installed. Install the distribution's openssh-server package first."
SSHD_CONFIG="/etc/ssh/sshd_config"
[[ -f "$SSHD_CONFIG" ]] || fail "OpenSSH server config is missing: $SSHD_CONFIG"

BOOTSTRAP_DIR="$STATE_ROOT/ssh-bootstrap"
BACKUP="$BOOTSTRAP_DIR/sshd_config.original"
WORKING="$BOOTSTRAP_DIR/sshd_config.citadel.new"
PRECHANGE="$BOOTSTRAP_DIR/sshd_config.prechange"
STATE_FILE="$BOOTSTRAP_DIR/state.json"
mkdir -p "$BOOTSTRAP_DIR"
chmod 755 "$BOOTSTRAP_DIR"

write_state(){
  local configured="$1" status="$2"
  python3 - "$STATE_FILE" "$configured" "$status" "$SSH_USER" <<'PY'
import datetime, json, pathlib, sys
path, configured, status, user = sys.argv[1:]
payload = {
    "schema": "citadel.ssh-bootstrap.v1",
    "platform": "linux",
    "configured": configured == "true",
    "status": status,
    "user": user,
    "config_path": "/etc/ssh/sshd_config",
    "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "private_keys_stored": False,
    "public_port_opened": False,
}
target = pathlib.Path(path)
temp = target.with_suffix(".new")
temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
temp.replace(target)
PY
  chmod 644 "$STATE_FILE"
}

reload_sshd(){
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files ssh.service >/dev/null 2>&1; then
      systemctl reload-or-restart ssh.service
      return
    fi
    if systemctl list-unit-files sshd.service >/dev/null 2>&1; then
      systemctl reload-or-restart sshd.service
      return
    fi
  fi
  fail "Unable to locate ssh/sshd systemd service."
}

if [[ "$ACTION" == "remove" ]]; then
  if [[ -f "$BACKUP" ]]; then
    "$SSHD" -t -f "$BACKUP"
    cp -f "$BACKUP" "$SSHD_CONFIG"
    "$SSHD" -t -f "$SSHD_CONFIG"
    reload_sshd
  fi
  write_state false removed
  log "Restricted SSH bootstrap removed."
  exit 0
fi

[[ "$ACTION" == "configure" ]] || fail "Unsupported CITADEL_SSH_ACTION."

if [[ ! -f "$BACKUP" ]]; then
  cp -f "$SSHD_CONFIG" "$BACKUP"
  chmod 600 "$BACKUP"
fi

"$PYTHON" "$CONFIGURATOR" render \
  --input "$SSHD_CONFIG" \
  --output "$WORKING" \
  --user "$SSH_USER" \
  --python "$PYTHON" \
  --console "$CONSOLE" \
  --agent-config "$AGENT_CONFIG"

"$SSHD" -t -f "$WORKING"
cp -f "$SSHD_CONFIG" "$PRECHANGE"
chmod 600 "$PRECHANGE"

if ! cp -f "$WORKING" "$SSHD_CONFIG"; then
  write_state false config_copy_failed
  fail "Unable to install rendered sshd_config."
fi

if ! "$SSHD" -t -f "$SSHD_CONFIG"; then
  cp -f "$PRECHANGE" "$SSHD_CONFIG"
  "$SSHD" -t -f "$SSHD_CONFIG" || true
  write_state false rollback_after_validation_failure
  fail "Installed sshd_config failed validation and was rolled back."
fi

if ! reload_sshd; then
  cp -f "$PRECHANGE" "$SSHD_CONFIG"
  "$SSHD" -t -f "$SSHD_CONFIG" || true
  reload_sshd || true
  write_state false rollback_after_reload_failure
  fail "sshd reload failed and config was rolled back."
fi

sleep 1
if command -v ss >/dev/null 2>&1; then
  listeners="$(ss -ltnH 'sport = :22' 2>/dev/null | awk '{print $4}' | sort -u)"
  [[ -n "$listeners" ]] || fail "sshd did not create a listener on port 22."
  while IFS= read -r addr; do
    [[ "$addr" == 127.0.0.1:22 || "$addr" == "[::1]:22" || "$addr" == "::1:22" ]] ||
      fail "sshd exposed a non-loopback listener: $addr"
  done <<< "$listeners"
fi

"$PYTHON" "$CONFIGURATOR" inspect --input "$SSHD_CONFIG" --user "$SSH_USER" >/dev/null
write_state true ready
log "Restricted SSH is ready on loopback port 22 for user '$SSH_USER'."
log "No inbound firewall rule was created and no SSH private key/password was stored."
