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
    "/api/v1/architect/nodes/${encodeURIComponent(node.node_id)}/wake",
    'id="nodePicker"',
    'id="fleetTablePanel"',
    'id="fleetTableBody"',
    "renderFleetTable",
    'id="siteClock"',
    'id="lmstudioPanel"',
    'id="lmstudioModel"',
    'id="lmstudioInstall"',
    '"lmstudio_install"',
    '"lmstudio_model_get"',
    '"lmstudio_model_load"',
    "agent/lmstudio",
    "/api/v1/architect/models/search",
    'id="lmstudioProgress"',
    'id="hybridPanel"',
    "\"hybrid_query\"",
    "\"lmstudio_probe\"",
    "installHubCollapsers",
    "panelToggle",
    'sessionStorage.getItem("citadel-architect-token")',
    'new URLSearchParams(location.search).get("lmnode")',
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

architect = Path("architect.html").read_text(encoding="utf-8")
worker = Path("src/index.js").read_text(encoding="utf-8")
for required in (
    "/api/v1/architect/work-roles",
    "LIVE OPERATIONS CENTER",
    "operationsAlert",
    "workRoles",
    "projectCreatedOverlay",
    "projectReportCard",
    "projectVoiceButton",
    "missionVoiceButton",
    "reportsDisclosure",
    "installSectionCollapsers",
    "section-toggle-button",
    'id="experienceDisclosure"',
    'id="experienceMeta"',
    'id="experienceList"',
    'id="refreshExperienceButton"',
    "/api/v1/architect/experience",
    'id="lostTokenButton"',
    'id="recoveryLoginPanel"',
    'id="createRecoveryCodeButton"',
    'id="rotateArchitectTokenButton"',
    'id="securitySecretPanel"',
    "Аварийное восстановление / сброс доступа",
    "Выполнить аварийный сброс доступа",
):
    if required not in architect:
        raise SystemExit(f"required Architect Live Operations capability missing: {required}")
if '/api/v1/architect/work-roles' not in worker or "architectWorkRoles" not in worker:
    raise SystemExit("Architect work-role API route/handler missing from Worker")
if '/api/v1/architect/experience' not in worker or "architectExperience" not in worker:
    raise SystemExit("Project Experience Registry API route/handler missing from Worker")
for required in ("architectGetProject", "project_specializations", "requested_roles"):
    if required not in worker:
        raise SystemExit(f"Project report/specialization backend missing: {required}")
for required in (
    "architectRotateToken",
    "architectRecoverToken",
    "architectCreateRecoveryCode",
    "architect_auth_state",
    "architect_recovery_attempts",
):
    if required not in worker:
        raise SystemExit(f"Architect auth recovery backend missing: {required}")

for required in (
    "/api/v1/architect/security/recover-token",
    "/api/v1/architect/security/recovery-code",
    "/api/v1/architect/security/rotate-token",
):
    if required not in architect or required not in worker:
        raise SystemExit(f"Architect auth recovery route missing: {required}")

for forbidden in (
    "/api/v1/architect/security/current-token",
    "showCurrentArchitectToken",
    "getCurrentArchitectToken",
):
    if forbidden in architect or forbidden in worker:
        raise SystemExit(f"current Architect token exposure path detected: {forbidden}")

for forbidden in ("Контрольные точки", "Последние события аудита"):
    if forbidden in architect:
        raise SystemExit(f"obsolete Architect UI surfaced again: {forbidden}")
for required in ('data-lang="ru"', 'data-lang="en"', 'data-lang="he"', "missionNodeState", "readableReport", "wakeButton", "updateAgentState", "siteClock", "projectStageTrack", "projectWorkerReadiness", "WAITING MODEL", "Подготовить ноду в Hub"):
    if required not in architect:
        raise SystemExit(f"Architect production UI capability missing: {required}")

logs = Path("architect-logs.html").read_text(encoding="utf-8")
home = Path("live-index.html").read_text(encoding="utf-8")
for page_name, page in (("home", home), ("hub", hub), ("architect", architect), ("logs", logs)):
    if 'id="siteClock"' not in page:
        raise SystemExit(f"{page_name} missing current date/time clock")
    for language in ('data-lang="ru"', 'data-lang="en"', 'data-lang="he"'):
        if language not in page:
            raise SystemExit(f"{page_name} missing language selector: {language}")

for forbidden in ("Command feed", "Audit feed", "commandTimeline", "auditTimeline"):
    if forbidden in hub:
        raise SystemExit(f"obsolete Hub feed surfaced again: {forbidden}")

for page_name, page in (("hub", hub), ("architect", architect)):
    for forbidden in ("Tailscale", "tailscale_ipv4"):
        if forbidden in page:
            raise SystemExit(f"{page_name} must not expose Tailscale-specific UI: {forbidden}")

setup = Path("agent/setup_windows.ps1").read_text(encoding="utf-8").lower()
installer = Path("agent/Install Windows Node.cmd").read_text(encoding="utf-8").lower()
service_helper = Path("agent/windows_service.ps1").read_text(encoding="utf-8")
service_host = Path("agent/CitadelNodeService.cs").read_text(encoding="utf-8")
agent_v1 = Path("agent/citadel_node_v1.py").read_text(encoding="utf-8")
enterprise_probe = Path("agent/windows_enterprise_probe.ps1").read_text(encoding="utf-8")

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
for required in (
    'servicename = "citadelewsnode"',
    "legacyusersid",
    "set-citadeldirectoryacl",
    "set-citadelservicedefinition",
    "restore-citadelservicedefinition",
    '"paused"',
    "programdata\\citadelews\\state",
    "expectedservicehostsha256",
    "expectedservicehelpersha256",
    "expectedenterpriseprobesha256",
    "windows_enterprise_probe.ps1",
    "-uninstall",
):
    if required not in setup:
        raise SystemExit(f"Windows Core Service capability missing: {required}")
for forbidden in ("createshortcut(", "pythonw.exe", "binpath="):
    if forbidden in setup:
        raise SystemExit(f"legacy/fragile Windows lifecycle returned: {forbidden}")

for required in ("Invoke-CimMethod", "Win32_Service", "DelayedAutostart", "PathName"):
    if required not in service_helper:
        raise SystemExit(f"Windows SCM helper capability missing: {required}")
for required in (
    "ServiceBase.Run",
    "CITADEL_SERVICE_MANAGED",
    "CITADEL_SERVICE_STOP_FILE",
    "RequestAdditionalTime(60000)",
    "AutoLog = false",
    "RestartExitCode = 75",
    "StopExitCode = 76",
):
    if required not in service_host:
        raise SystemExit(f"Windows service host capability missing: {required}")
for forbidden in ("cmd.exe", "powershell.exe", "UseShellExecute = true"):
    if forbidden in service_host:
        raise SystemExit(f"unsafe Windows service host pattern detected: {forbidden}")
if '"windows_core_service"' not in agent_v1:
    raise SystemExit("Windows SCM capability reporting is missing")

for required in (
    "Get-CimInstance",
    "Get-WinEvent",
    "Win32_PerfFormattedData_PerfOS_Processor",
    "Win32_PerfFormattedData_PerfOS_Memory",
    "Win32_QuickFixEngineering",
    "Microsoft-Hyper-V-All",
    "Get-VM",
    "IntuneManagementExtension",
    "SOFTWARE\\Microsoft\\Enrollments",
    "readonly",
):
    if required not in enterprise_probe:
        raise SystemExit(f"Windows Enterprise Probe capability missing: {required}")
for forbidden in (
    "Invoke-Expression",
    "IEX ",
    "DownloadString",
    "DownloadFile",
    "-ExecutionPolicy Bypass",
    "Enable-PSRemoting",
    "Invoke-Command",
    "Enter-PSSession",
    "New-PSSession",
):
    if forbidden.lower() in enterprise_probe.lower():
        raise SystemExit(f"unsafe Windows Enterprise Probe pattern detected: {forbidden}")
if '"windows_enterprise_readonly"' not in agent_v1:
    raise SystemExit("Windows Enterprise Probe capability reporting is missing")
if "WINDOWS_ENTERPRISE_PROBE_SHA256" not in agent_v1:
    raise SystemExit("Windows Enterprise Probe is not hash pinned")


linux_setup = Path("agent/setup_linux.sh").read_text(encoding="utf-8")
linux_entry = Path("agent/Install Linux Node.sh").read_text(encoding="utf-8")
for required in (
    "https://citadel-ai.init1.workers.dev",
    "systemctl",
    "citadel_node_v2.py",
    "self-test",
    "enroll",
    "sha256sum",
):
    if required not in linux_setup:
        raise SystemExit(f"Linux installer capability missing: {required}")
for forbidden in ("curl |", "wget |", "eval ", "nohup "):
    if forbidden in linux_setup or forbidden in linux_entry:
        raise SystemExit(f"unsafe Linux installer pattern detected: {forbidden}")
PY

node --check /tmp/ews-site.js
node --check /tmp/ews-live-site.js
node --check /tmp/ews-architect.js
node --check /tmp/ews-architect-logs.js
node --check /tmp/ews-node-test.js
node --check /tmp/ews-hub.js
node --check src/index.js
node --check src/quality/openrouter.js
node --check src/worker.js
node --check src/experience/policy.js
node --check src/experience/registry.js
node --check src/enterprise/policy.js
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
node tests/legacy-experience.mjs
node tests/experience-registry.mjs
node tests/architect-ux-guards.mjs
node tests/enterprise-policy.mjs
node tests/hub-five-questions.mjs
node tests/openrouter-quality-gate.mjs

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
    "agent_rollouts", "architect_projects", "project_work_items",
    "project_specializations", "project_quality_gates", "node_network_state", "node_ai_state",
    "architect_auth_state", "architect_recovery_attempts",
    "architect_access_tokens", "enterprise_sites", "enterprise_node_groups",
    "enterprise_node_scope", "enterprise_desired_state",
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

bash -n controller_deploy.sh scripts/build_site.sh scripts/package_controller.sh scripts/validate.sh agent/setup_linux.sh "agent/Install Linux Node.sh"
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
test -s "$site_dir/hub/index.html"
test -s "$site_dir/architect/index.html"
test -s "$site_dir/architect/logs/index.html"
test -s "$site_dir/_headers"
test ! -e "$site_dir/prototype"
test ! -e "$site_dir/node-test"
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

sha256sum architect.html scripts/validate.sh src/index.js
sha256sum -c SHA256SUMS.txt

git diff --check
