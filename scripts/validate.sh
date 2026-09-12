#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
python -m unittest -v controller_tests.py
python -m py_compile controller_app.py controller_tests.py
python - <<'PY'
from pathlib import Path
import re
for source, target in (
    ("index.html", "/tmp/ews-site.js"),
    ("architect.html", "/tmp/ews-architect.js"),
    ("node-test.html", "/tmp/ews-node-test.js"),
):
    html = Path(source).read_text(encoding="utf-8")
    match = re.search(r"<script>(.*)</script>", html, re.S)
    if not match:
        raise SystemExit(f"embedded JavaScript not found in {source}")
    ids = re.findall(r'\bid="([^"]+)"', html)
    if len(ids) != len(set(ids)):
        raise SystemExit(f"duplicate HTML id in {source}")
    references = set(re.findall(r'getElementById\("([^"]+)"\)', match.group(1)))
    missing = sorted(references - set(ids))
    if missing:
        raise SystemExit(f"missing HTML ids in {source}: {missing}")
    Path(target).write_text(match.group(1), encoding="utf-8")
PY
node --check /tmp/ews-site.js
node --check /tmp/ews-architect.js
node --check /tmp/ews-node-test.js
node --check src/index.js
node tests/report-storage.mjs
node tests/session-storage.mjs
bash -n controller_deploy.sh scripts/build_site.sh scripts/package_controller.sh scripts/validate.sh
cfn-lint controller_template.yaml project_stack.yaml
artifact="$(mktemp --suffix=.zip)"
trap 'rm -f "$artifact" /tmp/ews-site.js /tmp/ews-architect.js /tmp/ews-node-test.js' EXIT
scripts/package_controller.sh "$artifact"
unzip -t "$artifact"
site_dir="$(mktemp -d)"
scripts/build_site.sh "$site_dir"
test -s "$site_dir/index.html"
test -s "$site_dir/_headers"
rm -rf "$site_dir"
git diff --check
