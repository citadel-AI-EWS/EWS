#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT/public}"
rm -rf "$OUTPUT"
mkdir -p "$OUTPUT"
cp "$ROOT/index.html" "$OUTPUT/index.html"
cat > "$OUTPUT/_headers" <<'HEADERS'
/*
  Cache-Control: no-store
  Content-Security-Policy: default-src 'self'; connect-src 'self' https://*.execute-api.*.amazonaws.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
  Permissions-Policy: camera=(), geolocation=(), microphone=(self), payment=(), usb=()
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
HEADERS
printf 'Built static site in %s\n' "$OUTPUT"
