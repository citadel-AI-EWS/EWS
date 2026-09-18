#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

python -m unittest -v controller_tests.py
python -m py_compile controller_app.py controller_tests.py agent/citadel_node_v1.py agent/citadel_node_v2.py
python agent/citadel_node_v2.py self-test

python - <<'PY'
from pathlib import Path
import re

for source, target in (
    ("index.html", "/tmp/ews-site.js"),
    ("live-index.html", "/tmp/ews-live-site.js"),
    ("architect.html", "/tmp/ews-architect.js"),
    ("architect-logs.html", "/tmp/ews-architect-logs.js"),
    ("node-test.html", "/tmp/ews-node-test.js"),
    ("hub.html", "/tmp/ews-hub.js"),
):
    html = Path(source).read_text(encoding="utf-8")
    match = re.search(r"<script>(.*)</script>", html, re.S)
    if not match:
        raise SystemExit(f"embedded JavaScript not found in {source}")
    ids = re.findall(r'\bid="([^"]+)"', html)
    if len(ids) != len(set(ids)):
        raise SystemExit(f"duplicate HTML id in {source}")
    references = set(re.findall(r'''getElementById\(\s*["']([^"']+)["']\s*\)''', match.group(1)))
    missing = sorted(references - set(ids))
    if missing:
        raise SystemExit(f"missing HTML ids in {source}: {missing}")
    Path(target).write_text(match.group(1), encoding="utf-8")

hub = Path("hub.html").read_text(encoding="utf-8")
for required in (
    "/api/v1/hub/nodes",
    "/api/v1/architect/overview",
    "/api/v1/architect/presence",
    "/api/v1/architect/release",
    "/api/v1/architect/missions",
    "cloudflared access ssh --hostname %h",
    "CONFIGURED LOCALLY",
    "prefers-reduced-motion",
    "system_inventory",
):
    if required not in hub:
        raise SystemExit(f"required real Hub capability missing: {required}")

for forbidden in (
    "Math.random(",
    "eval(",
    "new Function(",
    "document.write(",
    'command_type:"shell"',
    'command_type: "shell"',
    'sessionStorage.setItem("citadelArchitectToken"',
    'localStorage.setItem("citadelArchitectToken"',
):
    if forbidden in hub:
        raise SystemExit(f"unsafe or simulated Hub pattern detected: {forbidden}")

if "SSH target configured locally; tunnel reachability is not yet verified" not in hub:
    raise SystemExit("Hub must not claim SSH reachability before Tunnel verification")

setup = Path("agent/setup_windows.ps1").read_text(encoding="utf-8").lower()
installer = Path("agent/Install Windows Node.cmd").read_text(encoding="utf-8").lower()
for forbidden in (
    "executionpolicy bypass",
    "-executionpolicy bypass",
    "register-scheduledtask",
    "schtasks",
    "runonce",
):
    if forbidden in setup or forbidden in installer:
        raise SystemExit(f"unsafe Windows installer pattern detected: {forbidden}")

if "https://citadel-ai.init1.workers.dev" not in setup:
    raise SystemExit("Windows installer Controller URL is missing")
PY

node --check /tmp/ews-site.js
node --check /tmp/ews-live-site.js
node --check /tmp/ews-architect.js
node --check /tmp/ews-architect-logs.js
node --check /tmp/ews-node-test.js
node --check /tmp/ews-hub.js
node --check src/index.js
node --check src/worker.js
node --check src/presence.js
node --check src/telemetry/common.js
node --check src/telemetry/schema.js
node --check src/telemetry/normalize.js
node --check src/telemetry/ingest.js
node --check src/telemetry/cursor.js
node --check src/telemetry/architect.js
node --check src/telemetry/router.js

node tests/report-storage.mjs
node tests/session-storage.mjs
node tests/telemetry-storage.mjs
node tests/presence-storage.mjs
node tests/update-integrity.mjs
node tests/review-backlog-guards.mjs

python - <<'PY'
from pathlib import Path
import sqlite3

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")
for migration in sorted(Path("migrations").glob("*.sql")):
    db.executescript(migration.read_text(encoding="utf-8"))

required = {
    "nodes", "missions", "assignments", "results", "commands", "audit_events",
    "agent_reports", "architect_sessions", "node_logs", "node_log_rate_limits",
}
tables = {
    row[0]
    for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )
}
missing = sorted(required - tables)
if missing:
    raise SystemExit(f"fresh migration chain missing tables: {missing}")

columns = {
    row[1]
    for row in db.execute("PRAGMA table_info(results)")
}
for column in ("report_type", "report_json", "report_sha256", "report_size_bytes", "sensitivity"):
    if column not in columns:
        raise SystemExit(f"fresh migration chain missing results.{column}")

print("Fresh D1 migration chain: OK")
PY

bash -n controller_deploy.sh scripts/build_site.sh scripts/package_controller.sh scripts/validate.sh
cfn-lint controller_template.yaml project_stack.yaml

artifact="$(mktemp --suffix=.zip)"
cleanup_validation_files() {
  for path in "$artifact" /tmp/ews-site.js /tmp/ews-live-site.js /tmp/ews-architect.js /tmp/ews-architect-logs.js /tmp/ews-node-test.js /tmp/ews-hub.js; do
    if [[ -e "$path" ]]; then
      unlink "$path"
    fi
  done
}
trap cleanup_validation_files EXIT
scripts/package_controller.sh "$artifact"
unzip -t "$artifact"

relative_pkg_root="$(mktemp -d)"
mkdir -p "$relative_pkg_root/build"
(
  cd "$relative_pkg_root"
  "$ROOT/scripts/package_controller.sh" build/controller.zip
  test -s build/controller.zip
)
ln -s "$relative_pkg_root/missing.zip" "$relative_pkg_root/dangling.zip"
"$ROOT/scripts/package_controller.sh" "$relative_pkg_root/dangling.zip"
test ! -L "$relative_pkg_root/dangling.zip"
test -s "$relative_pkg_root/dangling.zip"
find "$relative_pkg_root" -mindepth 1 -delete
rmdir "$relative_pkg_root"

site_dir="$(mktemp -d)"
scripts/build_site.sh "$site_dir"
test -s "$site_dir/index.html"
test -s "$site_dir/prototype/index.html"
test -s "$site_dir/hub/index.html"
test -s "$site_dir/_headers"
test -s "$site_dir/architect/logs/index.html"
find "$site_dir" -mindepth 1 -delete
rmdir "$site_dir"

site_parent="$(mktemp -d)"
site_target="$site_parent/target"
site_link="$site_parent/link"
mkdir -p "$site_target"
printf 'keep\n' > "$site_target/sentinel"
ln -s "$site_target" "$site_link"
if scripts/build_site.sh "$site_link"; then
  echo "build_site.sh accepted a symlinked output directory" >&2
  exit 1
fi
test -s "$site_target/sentinel"
(
  cd "$site_parent"
  scripts_path="$ROOT/scripts/build_site.sh"
  "$scripts_path" ./relative-site
  test -s ./relative-site/index.html
)
find "$site_parent" -mindepth 1 -delete
rmdir "$site_parent"

git diff --check
