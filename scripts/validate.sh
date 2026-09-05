#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
python -m unittest -v controller_tests.py
python -m py_compile controller_app.py controller_tests.py
python - <<'PY'
from pathlib import Path
import re
html = Path("index.html").read_text(encoding="utf-8")
match = re.search(r"<script>(.*)</script>", html, re.S)
if not match:
    raise SystemExit("embedded JavaScript not found")
Path("/tmp/ews-site.js").write_text(match.group(1), encoding="utf-8")
PY
node --check /tmp/ews-site.js
bash -n controller_deploy.sh scripts/package_controller.sh scripts/validate.sh
cfn-lint controller_template.yaml project_stack.yaml
artifact="$(mktemp --suffix=.zip)"
trap 'rm -f "$artifact" /tmp/ews-site.js' EXIT
scripts/package_controller.sh "$artifact"
unzip -t "$artifact"
git diff --check
