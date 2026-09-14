#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT/controller_lambda.zip}"
BUILD_DIR="$(mktemp -d)"
cleanup_build_dir() {
  if [[ -d "$BUILD_DIR" ]]; then
    find "$BUILD_DIR" -mindepth 1 -delete
    rmdir "$BUILD_DIR"
  fi
}
trap cleanup_build_dir EXIT
cp "$ROOT/controller_app.py" "$BUILD_DIR/app.py"
cp "$ROOT/project_stack.yaml" "$ROOT/pricing_catalog.json" "$BUILD_DIR/"
if [[ -e "$OUTPUT" ]]; then
  unlink "$OUTPUT"
fi
( cd "$BUILD_DIR" && zip -q -X "$OUTPUT" app.py project_stack.yaml pricing_catalog.json )
unzip -t "$OUTPUT" >/dev/null
printf 'Built %s\n' "$OUTPUT"
