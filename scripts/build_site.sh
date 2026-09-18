#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT/public}"

if [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$PWD/$OUTPUT"
fi
# Reject the caller-supplied path before canonicalization so a symlink cannot be
# hidden by realpath and then cleaned through its target.
if [[ -L "$OUTPUT" ]]; then
  printf 'Refusing symlinked output directory: %s\n' "$OUTPUT" >&2
  exit 2
fi
OUTPUT="$(python - "$OUTPUT" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
)"

HOME_CANON=""
if [[ -n "${HOME:-}" ]]; then
  HOME_CANON="$(python - "$HOME" <<'PY'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PY
)"
fi

unsafe=0
if [[ "$OUTPUT" == "/" || "$OUTPUT" == "$ROOT" || ( -n "$HOME_CANON" && "$OUTPUT" == "$HOME_CANON" ) ]]; then
  unsafe=1
fi
case "$ROOT/" in
  "$OUTPUT/"*) unsafe=1 ;;
esac
if [[ -n "$HOME_CANON" ]]; then
  case "$HOME_CANON/" in
    "$OUTPUT/"*) unsafe=1 ;;
  esac
fi
if (( unsafe )); then
  printf 'Refusing unsafe output directory: %s\n' "$OUTPUT" >&2
  exit 2
fi

if [[ -e "$OUTPUT" && ! -d "$OUTPUT" ]]; then
  printf 'Refusing non-directory output path: %s\n' "$OUTPUT" >&2
  exit 2
fi
if [[ -d "$OUTPUT" ]]; then
  find "$OUTPUT" -mindepth 1 -delete
fi

mkdir -p "$OUTPUT/architect/logs" "$OUTPUT/hub"
cp "$ROOT/live-index.html" "$OUTPUT/index.html"
cp "$ROOT/architect.html" "$OUTPUT/architect/index.html"
cp "$ROOT/architect-logs.html" "$OUTPUT/architect/logs/index.html"
cp "$ROOT/hub.html" "$OUTPUT/hub/index.html"
cat > "$OUTPUT/_headers" <<'HEADERS'
/*
  Cache-Control: no-store
  Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
  Permissions-Policy: camera=(), geolocation=(), microphone=(self), payment=(), usb=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
HEADERS
printf 'Built static site in %s\n' "$OUTPUT"
