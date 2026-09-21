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
cleanup(){ rm -f "$tmp"; }
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

echo "[CITADEL] LM Studio / llmster is installed; CITADEL agent will start daemon/server."
