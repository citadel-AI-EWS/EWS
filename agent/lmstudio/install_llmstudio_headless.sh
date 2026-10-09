#!/usr/bin/env bash
set -euo pipefail

runtime_home="${CITADEL_LMSTUDIO_HOME:-$HOME}"
if [ -z "$runtime_home" ]; then
  echo "LM Studio runtime HOME is unavailable." >&2
  exit 1
fi
mkdir -p "$runtime_home"
export HOME="$runtime_home"
export LMS_NO_MODIFY_PATH=1

official_installer="https://lmstudio.ai/install.sh"
tmp="$(mktemp -t citadel-lmstudio.XXXXXX.sh)"
lms_output="$(mktemp -t citadel-lms-output.XXXXXX)"
cleanup(){ rm -f "$tmp" "$lms_output"; }
trap cleanup EXIT

curl -fsSL "$official_installer" -o "$tmp"
size="$(wc -c < "$tmp" | tr -d ' ')"
if [ "$size" -lt 200 ] || [ "$size" -gt 2097152 ]; then
  echo "Unexpected LM Studio installer size." >&2
  exit 1
fi

bash "$tmp"

lms_bin="$HOME/.lmstudio/bin/lms"
if [ ! -x "$lms_bin" ]; then
  lms_bin="$(command -v lms || true)"
fi
if [ -z "$lms_bin" ] || [ ! -x "$lms_bin" ]; then
  echo "lms CLI was not found after installation." >&2
  exit 1
fi

# The first daemon launch can replace the CLI asynchronously. Do not return a
# half-ready runtime while the next agent command would hit Linux ETXTBSY.
run_lms_ready(){
  local deadline=$((SECONDS + 35))
  local command_status
  while true; do
    if timeout 120 "$lms_bin" "$@" < /dev/null > "$lms_output" 2>&1; then
      cat "$lms_output"
      return 0
    else
      command_status=$?
    fi
    if ! grep -qi 'Text file busy' "$lms_output" || [ "$SECONDS" -ge "$deadline" ]; then
      cat "$lms_output" >&2
      return "$command_status"
    fi
    sleep 0.25
  done
}

run_lms_ready daemon up
run_lms_ready server start --port 1234
echo "[CITADEL] LM Studio / llmster daemon and localhost:1234 server are ready."
