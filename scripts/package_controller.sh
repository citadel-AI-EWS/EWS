#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT/controller_lambda.zip}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
cp "$ROOT/controller_app.py" "$BUILD_DIR/app.py"
cp "$ROOT/project_stack.yaml" "$ROOT/pricing_catalog.json" "$BUILD_DIR/"
rm -f "$OUTPUT"
( cd "$BUILD_DIR" && zip -q -X "$OUTPUT" app.py project_stack.yaml pricing_catalog.json )
unzip -t "$OUTPUT" >/dev/null
printf 'Built %s\n' "$OUTPUT"
