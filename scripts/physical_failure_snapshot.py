"""Classify a private database export in memory; emit fixed codes only."""
import json
import re
import sqlite3
import sys


def classify(value):
    text = str(value or "")
    patterns = [
        (r"LASTEXITCODE.{0,100}(?:not been set|cannot be retrieved|not set)|variable.{0,80}LASTEXITCODE", "powershell_exit_code_unset"),
        (r"running scripts.{0,80}disabled|not digitally signed|PSSecurityException|ExecutionPolicy|AuthorizationManager|SecurityError|выполнение.{0,80}сценари.{0,80}отключено", "powershell_execution_policy"),
        (r"lms CLI (?:unavailable|was not found) after installation", "lms_missing_after_install"),
        (r"lmstudio installer helper hash mismatch", "installer_helper_hash_mismatch"),
        (r"PowerShell unavailable", "powershell_unavailable"),
        (r"underlying connection.{0,40}closed|SSL/TLS secure channel|Invoke-WebRequest|Unable to connect to the remote server|remote name could not be resolved", "upstream_installer_download_failed"),
        (r"updated agent startup health-check failed", "startup_healthcheck_failed"),
        (r"updated agent self-test failed", "self_test_failed"),
        (r"WinError 5|PermissionError|Permission denied|Access is denied", "file_access_denied"),
        (r"WinError 32|being used by another process", "file_locked"),
        (r"CERTIFICATE_VERIFY_FAILED|certificate verify failed", "tls_certificate_rejected"),
        (r"timed out|WinError 10060|TimeoutExpired", "timeout"),
    ]
    for pattern, code in patterns:
        if re.search(pattern, text, re.IGNORECASE | re.DOTALL):
            return code
    return "unclassified_error" if text else "error_detail_unavailable"


def facts(value):
    text = str(value or "")
    numeric = re.search(r"\[(?:WinError|Errno) (\d{1,5})\]", text)
    role = "unknown"
    for marker, code in [("update-backup", "update_backup"), ("citadel-update-", "update_staging"),
                         ("citadel_node_v1.py", "core_v1"), ("citadel_node_v2.py", "core_v2"),
                         ("windows_enterprise_probe.ps1", "enterprise_probe"), ("citadel-lmstudio-", "lm_installer_helper")]:
        if marker in text:
            role = code
            break
    # This small word vocabulary cannot reveal usernames, hosts, paths or keys.
    words = set(re.findall(r"[a-z]+", text.lower()))
    hints = [w for w in ["scripts", "disabled", "signed", "variable", "installation", "cli", "powershell",
                         "denied", "directory", "file", "cannot", "download", "found", "parameter", "binding", "exception"] if w in words]
    return {"failure_code": classify(text), "os_error_number": int(numeric.group(1)) if numeric else None,
            "file_role": role, "detail_length": len(text), "has_decode_replacement": "\ufffd" in text, "hints": hints}


def main():
    source = sys.stdin.read(64 * 1024 * 1024 + 1)
    if len(source) > 64 * 1024 * 1024:
        raise ValueError("snapshot_too_large")
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(source)
    failures = db.execute("""SELECT c.command_id,c.node_id,c.command_type,n.agent_version,n.os_name,n.architecture
        FROM commands c JOIN nodes n ON n.node_id=c.node_id
        WHERE c.status='failed' AND datetime(c.created_at)>=datetime('2026-10-09T19:00:00Z') AND
         ((c.command_type='update' AND json_extract(c.payload_json,'$.version')='0.3.44') OR
          (c.command_type='lmstudio_install' AND EXISTS(SELECT 1 FROM audit_events a WHERE
           a.target_id=c.command_id AND a.actor_id='authorized-lmstudio-pilot-20261009')))
        ORDER BY c.created_at DESC LIMIT 5""").fetchall()
    for failed in failures:
        error = ""
        rows = db.execute("SELECT details_json FROM node_logs WHERE node_id=? AND event_type='command_failed' ORDER BY created_at DESC LIMIT 100",
                          (failed["node_id"],)).fetchall()
        for row in rows:
            details = json.loads(row["details_json"])
            if details.get("command_id") == failed["command_id"]:
                error = details.get("error", "")
                break
        consoles = db.execute("SELECT output FROM ssh_console_results WHERE command_id=?",
                              ("command_audit_read_failure_" + __import__("hashlib").sha256(failed["command_id"].encode()).hexdigest()[:24],)).fetchall()
        for row in consoles:
            for line in row["output"].splitlines():
                try:
                    event = json.loads(line)
                    if event.get("event") == "command_failed" and event.get("command_id") == failed["command_id"]:
                        error = event.get("error", "")
                except (ValueError, AttributeError):
                    pass
        os_name = failed["os_name"] if failed["os_name"] in ("Windows", "Linux", "Darwin") else "other"
        architecture = failed["architecture"] if failed["architecture"] in ("AMD64", "x86_64", "aarch64", "arm64", "x86") else "other"
        print(json.dumps({"test": "physical-failure-snapshot", "source": "cloudflare_export",
                          "command_type": failed["command_type"], "agent_version": failed["agent_version"],
                          "os": os_name, "architecture": architecture, **facts(error)}))
    db.close()
    print(json.dumps({"test": "physical-failure-snapshot", "status": "read_complete", "failure_count": len(failures)}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print('{"status":"snapshot_diagnostic_unavailable"}')
        sys.exit(2)
