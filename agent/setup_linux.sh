#!/usr/bin/env bash
set -euo pipefail

CONTROLLER_URL="${CITADEL_CONTROLLER_URL:-https://citadel-ai.init1.workers.dev}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${CITADEL_INSTALL_ROOT:-$HOME/.local/share/citadel-node}"
STATE_ROOT="${CITADEL_STATE_ROOT:-$HOME/.local/state/citadel-node}"
SERVICE_NAME="citadel-node.service"
EXPECTED_V1_SHA256="5b814a2a93511366a980ee36f5102a04c44704b596415a4af55339d07dc655ac"
EXPECTED_V2_SHA256="7d3cbeecaa9a58d30d1cc9e12a3cf60c86112a857df4188d02453caa09954a52"
CONTROLLER_PUBLIC_X="erXWuWm8Yhk-p9aQARBND17jGkQ5_kUKetaliE1isy0"

log(){ printf '[CITADEL] %s\n' "$*"; }
fail(){ printf '[CITADEL] ERROR: %s\n' "$*" >&2; exit 1; }
sha(){ sha256sum "$1" | awk '{print $1}'; }

for command in python3 sha256sum; do
  command -v "$command" >/dev/null 2>&1 || fail "$command is required."
done

python3 - <<'PY' || fail "Python 3.12 or newer is required."
import sys
raise SystemExit(0 if sys.version_info >= (3, 12) else 1)
PY

for pair in   "citadel_node_v1.py:$EXPECTED_V1_SHA256"   "citadel_node_v2.py:$EXPECTED_V2_SHA256"; do
  name="${pair%%:*}"
  expected="${pair##*:}"
  source="$SCRIPT_DIR/$name"
  [[ -f "$source" ]] || fail "Required package file is missing: $name"
  actual="$(sha "$source")"
  [[ "$actual" == "$expected" ]] || fail "Package integrity check failed for $name."
done
[[ -f "$SCRIPT_DIR/requirements.txt" ]] || fail "requirements.txt is missing."

mkdir -p "$INSTALL_ROOT" "$STATE_ROOT"
chmod 700 "$STATE_ROOT" || true

copy_if_changed(){
  local source="$1" destination="$2"
  if [[ -f "$destination" ]] && [[ "$(sha "$source")" == "$(sha "$destination")" ]]; then
    log "$(basename "$source") already current."
  else
    install -m 600 "$source" "$destination"
    log "Installed $(basename "$source")."
  fi
}

copy_if_changed "$SCRIPT_DIR/citadel_node_v1.py" "$INSTALL_ROOT/citadel_node_v1.py"
copy_if_changed "$SCRIPT_DIR/citadel_node_v2.py" "$INSTALL_ROOT/citadel_node_v2.py"
copy_if_changed "$SCRIPT_DIR/requirements.txt" "$INSTALL_ROOT/requirements.txt"

VENV="$INSTALL_ROOT/.venv"
VENV_PY="$VENV/bin/python"
if [[ ! -x "$VENV_PY" ]]; then
  log "Creating Python virtual environment..."
  python3 -m venv "$VENV" || fail "python3-venv is required."
fi

"$VENV_PY" -m pip install --disable-pip-version-check --upgrade pip
"$VENV_PY" -m pip install --disable-pip-version-check --upgrade --requirement "$INSTALL_ROOT/requirements.txt"

CONFIG="$INSTALL_ROOT/config.json"
python3 - "$CONFIG" "$CONTROLLER_URL" "$STATE_ROOT" "$CONTROLLER_PUBLIC_X" <<'PY'
import json, pathlib, sys
path, controller, state, public_x = sys.argv[1:]
payload = {
    "controller_url": controller.rstrip("/"),
    "data_dir": state,
    "poll_seconds": 30,
    "heartbeat_seconds": 30,
    "request_timeout_seconds": 30,
    "max_cpu_percent": 90,
    "max_memory_percent": 90,
    "controller_public_x": public_x,
}
pathlib.Path(path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "$CONFIG"

rm -f "$STATE_ROOT/STOP"

AGENT="$INSTALL_ROOT/citadel_node_v2.py"
"$VENV_PY" "$AGENT" doctor --config "$CONFIG"
"$VENV_PY" "$AGENT" self-test
NODE_ID="$("$VENV_PY" "$AGENT" enroll --config "$CONFIG" | tail -n 1)"
[[ "$NODE_ID" == node_* ]] || fail "Controller did not return a valid node id."
log "Controller enrollment confirmed: $NODE_ID"
"$VENV_PY" "$AGENT" once --config "$CONFIG"
log "Live heartbeat/controller cycle confirmed."

SERVICE_COMMAND="$VENV_PY $AGENT run --config $CONFIG"
if command -v systemctl >/dev/null 2>&1; then
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
    cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=CITADEL EWS Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$SERVICE_COMMAND
WorkingDirectory=$INSTALL_ROOT
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$SERVICE_NAME"
    log "Installed system service: $SERVICE_NAME"
  else
    USER_SYSTEMD="$HOME/.config/systemd/user"
    mkdir -p "$USER_SYSTEMD"
    SERVICE_PATH="$USER_SYSTEMD/$SERVICE_NAME"
    cat > "$SERVICE_PATH" <<EOF
[Unit]
Description=CITADEL EWS Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$SERVICE_COMMAND
WorkingDirectory=$INSTALL_ROOT
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVICE_NAME"
    log "Installed user systemd service: $SERVICE_NAME"
    if command -v loginctl >/dev/null 2>&1; then
      LINGER="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
      if [[ "$LINGER" != "yes" ]]; then
        log "Note: for service startup before login, an administrator may run: loginctl enable-linger $USER"
      fi
    fi
  fi
else
  fail "systemd is required for persistent Linux service installation."
fi

python3 - "$INSTALL_ROOT/install-state.json" "$NODE_ID" "$CONTROLLER_URL" <<'PY'
import json, pathlib, sys, datetime
path, node_id, controller = sys.argv[1:]
payload = {
    "node_id": node_id,
    "controller_url": controller.rstrip("/"),
    "agent_version": "0.3.10",
    "platform": "linux",
    "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}
pathlib.Path(path).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

log "Setup/repair complete."
log "Node: $NODE_ID"
log "Controller: ${CONTROLLER_URL%/}"
log "Re-running this installer preserves identity and repairs the same installation."
