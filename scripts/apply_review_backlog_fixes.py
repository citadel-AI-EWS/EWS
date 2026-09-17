#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8", newline="\n")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"missing expected pattern: {label}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"expected exactly one regex match for {label}, got {count}")
    return new_text


# Keep the public/current docs aligned with tokenless automatic enrollment and Startup behavior.
path = "agent/README_RU.md"
text = read(path)
text = regex_once(
    text,
    r"## Windows setup\n.*?\n## Ручной запуск",
    '''## Windows setup

Адрес контроллера уже встроен. Setup при необходимости устанавливает Python 3.14 через Windows Package Manager, создаёт отдельное `.venv`, ставит зависимости, выполняет `doctor` и self-test, автоматически регистрирует узел и проверяет живой цикл с Controller. Узел получает постоянный номер; enrollment token, логин и код подтверждения не требуются.

```powershell
powershell -File .\\setup_windows.ps1
```

После успешной проверки Setup создаёт обычный ярлык в папке Windows Startup и запускает один фоновый экземпляр через `pythonw.exe`. Повторный запуск Setup использует ту же Ed25519-идентичность и не должен создавать второй экземпляр агента.

Unattended/autostart предназначен только для компьютеров, принадлежащих оператору или находящихся под его администрированием.

## Ручной запуск''',
    "README Windows setup",
)
write(path, text)


# Browser test must use the same tokenless enrollment contract as the Controller and Python agent.
path = "node-test.html"
text = read(path)
text = replace_once(
    text,
    '''      <label for="token">Одноразовый токен регистрации</label>
      <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="ews_enroll_…">
      <button id="enrollButton" type="button">Зарегистрировать этот телефон</button>
      <p class="small">Токен не сохраняется. Приватный ключ остаётся внутри защищённого хранилища браузера.</p>''',
    '''      <button id="enrollButton" type="button">Зарегистрировать этот телефон</button>
      <p class="small">Регистрация выполняется автоматически по новому ключу Ed25519. Приватный ключ остаётся внутри защищённого хранилища браузера.</p>''',
    "node-test token UI",
)
text = replace_once(text, '    const tokenInput = document.getElementById("token");\n', "", "node-test token element")
text = replace_once(
    text,
    '''    enrollButton.addEventListener("click", async () => {
      const enrollmentToken = tokenInput.value.trim();
      if (!enrollmentToken) {
        setStatus("Сначала вставьте одноразовый токен.", "bad");
        return;
      }

      enrollButton.disabled = true;''',
    '''    enrollButton.addEventListener("click", async () => {
      enrollButton.disabled = true;''',
    "node-test token requirement",
)
text = replace_once(text, "            enrollment_token: enrollmentToken,\n", "", "node-test token payload")
text = replace_once(text, '        tokenInput.value = "";\n', "", "node-test token cleanup")
write(path, text)


# Windows setup: fail closed when process discovery is unavailable and quote paths with spaces.
path = "agent/setup_windows.ps1"
text = read(path)
text = replace_once(
    text,
    '''  } catch {
    Write-Host "[CITADEL] Could not inspect running processes; startup will still be verified."
    return @()
  }''',
    '''  } catch {
    throw "[CITADEL] Could not inspect running CITADEL processes safely; refusing to start another copy."
  }''',
    "safe process inspection",
)
text = replace_once(
    text,
    '''if ($RunningAgents.Count -eq 0) {
  Start-Process -FilePath $VenvPythonw -ArgumentList @(
    $AgentScript,
    "run",
    "--config",
    $ConfigPath
  ) -WorkingDirectory $InstallRoot -WindowStyle Hidden''',
    '''if ($RunningAgents.Count -eq 0) {
  $RunArguments = '\"' + $AgentScript + '\" run --config \"' + $ConfigPath + '\"'
  Start-Process -FilePath $VenvPythonw -ArgumentList $RunArguments -WorkingDirectory $InstallRoot -WindowStyle Hidden''',
    "quoted background arguments",
)
text = replace_once(text, '  agent_version = "0.3.2"', '  agent_version = "0.3.3"', "setup release version")
write(path, text)


# Bump both agent source versions so a changed telemetry contract is actually delivered as an update.
path = "agent/citadel_node_v1.py"
text = read(path)
text = replace_once(text, 'VERSION = "0.3.2"', 'VERSION = "0.3.3"', "agent v1 version")
write(path, text)

path = "agent/citadel_node_v2.py"
text = read(path)
text = replace_once(text, 'VERSION = "0.3.2"', 'VERSION = "0.3.3"', "agent v2 version")
text = replace_once(text, '    "node_enrolled",\n', '    "node_enrolled",\n    "windows_sleep_inhibit",\n', "agent telemetry allowlist")
text = replace_once(
    text,
    '''                json.dumps({"ts": "2026-09-12T20:00:00+00:00", "event": "agent_start", "version": VERSION}),
                json.dumps({"ts": "2026-09-12T20:00:01+00:00", "event": "resource_guard", "cpu_percent": 95.0}),''',
    '''                json.dumps({"ts": "2026-09-12T20:00:00+00:00", "event": "agent_start", "version": VERSION}),
                json.dumps({"ts": "2026-09-12T20:00:01+00:00", "event": "resource_guard", "cpu_percent": 95.0}),
                json.dumps({"ts": "2026-09-12T20:00:02+00:00", "event": "windows_sleep_inhibit", "enabled": True}),''',
    "agent telemetry fixture",
)
text = replace_once(
    text,
    '''        if sent != 2 or len(payloads) != 1:
            raise RuntimeError("telemetry self-test failed: batch not uploaded")''',
    '''        if sent != 3 or len(payloads) != 1:
            raise RuntimeError("telemetry self-test failed: batch not uploaded")''',
    "telemetry self-test count",
)
text = replace_once(
    text,
    '''        if payloads[0]["events"][1]["level"] != "warn":
            raise RuntimeError("telemetry self-test failed: severity mapping")''',
    '''        if payloads[0]["events"][1]["level"] != "warn":
            raise RuntimeError("telemetry self-test failed: severity mapping")
        if payloads[0]["events"][2]["event_type"] != "windows_sleep_inhibit":
            raise RuntimeError("telemetry self-test failed: sleep inhibit event dropped")''',
    "telemetry self-test event",
)
write(path, text)


# Controller must accept every operational event emitted by the current v2 agent.
path = "src/telemetry/normalize.js"
text = read(path)
text = replace_once(text, '  "node_enrolled",\n', '  "node_enrolled",\n  "windows_sleep_inhibit",\n', "controller sleep event")
text = replace_once(
    text,
    '  "command_completed",\n',
    '  "command_completed",\n  "agent_updated",\n  "agent_update_rolled_back",\n  "agent_update_healthcheck_passed",\n  "agent_update_manual_rollback",\n  "agent_restart_requested",\n',
    "controller update events",
)
write(path, text)


# Controller enrollment: global bounded creation, legacy-key reconciliation, and permanent numbers in Architect.
path = "src/index.js"
text = read(path)
text = replace_once(
    text,
    "const SIGNATURE_WINDOW_SECONDS = 300;\n",
    '''const SIGNATURE_WINDOW_SECONDS = 300;
const AUTO_ENROLLMENT_DEFAULT_HOURLY_LIMIT = 120;
const AUTO_ENROLLMENT_DEFAULT_NODE_CAP = 10000;
''',
    "enrollment constants",
)
text = replace_once(text, '  version: "0.3.2",', '  version: "0.3.3",', "controller release version")

new_storage = r'''function autoEnrollmentLimit(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maximum);
}

async function ensureAutoEnrollmentStorage(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS node_numbers (
        node_number INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
      )
    `),
    env.DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_node_numbers_public_key
      ON node_numbers(public_key)
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS auto_enrollment_windows (
        window_key TEXT PRIMARY KEY,
        created_count INTEGER NOT NULL DEFAULT 0 CHECK (created_count >= 0),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
  ]);
}

async function consumeAutoEnrollmentSlot(env) {
  const hourlyLimit = autoEnrollmentLimit(
    env.AUTO_ENROLL_MAX_NEW_PER_HOUR,
    AUTO_ENROLLMENT_DEFAULT_HOURLY_LIMIT,
    100000
  );
  const nodeCap = autoEnrollmentLimit(
    env.AUTO_ENROLL_MAX_NODES,
    AUTO_ENROLLMENT_DEFAULT_NODE_CAP,
    1000000
  );
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM nodes"
  ).first();
  if (Number(total?.count || 0) >= nodeCap) {
    throw new ApiError(503, "auto_enrollment_capacity_reached");
  }

  const now = new Date();
  const windowKey = now.toISOString().slice(0, 13);
  const pruneBefore = new Date(now.getTime() - 48 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 13);
  await env.DB.prepare(
    "DELETE FROM auto_enrollment_windows WHERE window_key < ?"
  ).bind(pruneBefore).run();

  const slot = await env.DB.prepare(`
    INSERT INTO auto_enrollment_windows (window_key, created_count, updated_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(window_key) DO UPDATE SET
      created_count = auto_enrollment_windows.created_count + 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE auto_enrollment_windows.created_count < ?
    RETURNING created_count
  `).bind(windowKey, hourlyLimit).first();
  if (!slot) {
    throw new ApiError(429, "auto_enrollment_rate_limited");
  }
}'''
text = regex_once(
    text,
    r"async function ensureAutoEnrollmentStorage\(env\) \{.*?\n\}\n\nfunction enrollmentResponse",
    new_storage + "\n\nfunction enrollmentResponse",
    "auto enrollment storage",
)

new_enroll = r'''async function enrollNode(request, env) {
  const bodyText = await readBodyText(request, MAX_ENROLLMENT_BODY_BYTES);
  const body = parseJsonObject(bodyText);

  const publicKey = normalizePublicKey(body.public_key);
  const hostname = requireString(body.hostname, "hostname", 255);
  const osName = requireString(body.os_name, "os_name", 80);
  const osVersion = optionalString(body.os_version, "os_version", 80);
  const architecture = optionalString(body.architecture, "architecture", 80);
  const agentVersion = requireString(body.agent_version, "agent_version", 80);
  const capabilitiesJson = normalizeCapabilities(body.capabilities);
  const detailsJson = JSON.stringify({
    hostname,
    os_name: osName,
    agent_version: agentVersion,
    enrollment: "automatic"
  });

  await ensureAutoEnrollmentStorage(env);

  let existing = await env.DB.prepare(`
    SELECT n.node_id, n.status, nn.node_number
    FROM node_numbers AS nn
    JOIN nodes AS n ON n.node_id = nn.node_id
    WHERE nn.public_key = ?
  `).bind(publicKey).first();
  if (existing) {
    if (existing.status === "revoked") {
      throw new ApiError(403, "node_revoked");
    }
    return enrollmentResponse(existing.node_id, existing.node_number, existing.status, 200);
  }

  const legacyNode = await env.DB.prepare(`
    SELECT node_id, status
    FROM nodes
    WHERE public_key = ?
  `).bind(publicKey).first();
  if (legacyNode) {
    if (legacyNode.status === "revoked") {
      throw new ApiError(403, "node_revoked");
    }
    await env.DB.prepare(`
      INSERT OR IGNORE INTO node_numbers (node_id, public_key)
      VALUES (?, ?)
    `).bind(legacyNode.node_id, publicKey).run();
    existing = await env.DB.prepare(`
      SELECT n.node_id, n.status, nn.node_number
      FROM node_numbers AS nn
      JOIN nodes AS n ON n.node_id = nn.node_id
      WHERE nn.public_key = ?
    `).bind(publicKey).first();
    if (!existing?.node_number) {
      throw new ApiError(500, "node_number_assignment_failed");
    }
    return enrollmentResponse(existing.node_id, existing.node_number, existing.status, 200);
  }

  await consumeAutoEnrollmentSlot(env);

  const nodeId = `node_${crypto.randomUUID()}`;
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO nodes (
          node_id, public_key, hostname, os_name, os_version,
          architecture, agent_version, status, capabilities_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?)
      `).bind(nodeId, publicKey, hostname, osName, osVersion, architecture, agentVersion, capabilitiesJson),
      env.DB.prepare(`
        INSERT INTO node_numbers (node_id, public_key)
        VALUES (?, ?)
      `).bind(nodeId, publicKey),
      env.DB.prepare(`
        INSERT INTO audit_events (
          actor_type, actor_id, action, target_type, target_id, details_json
        ) VALUES ('node', ?, 'node.auto_enrolled', 'node', ?, ?)
      `).bind(nodeId, nodeId, detailsJson)
    ]);
  } catch (error) {
    if (String(error).includes("public_key") || String(error).includes("UNIQUE")) {
      const raced = await env.DB.prepare(`
        SELECT n.node_id, n.status, nn.node_number
        FROM node_numbers AS nn
        JOIN nodes AS n ON n.node_id = nn.node_id
        WHERE nn.public_key = ?
      `).bind(publicKey).first();
      if (raced) {
        if (raced.status === "revoked") {
          throw new ApiError(403, "node_revoked");
        }
        return enrollmentResponse(raced.node_id, raced.node_number, raced.status, 200);
      }
    }
    throw error;
  }

  const assigned = await env.DB.prepare(
    "SELECT node_number FROM node_numbers WHERE node_id = ?"
  ).bind(nodeId).first();
  if (!assigned?.node_number) {
    throw new ApiError(500, "node_number_assignment_failed");
  }
  return enrollmentResponse(nodeId, assigned.node_number);
}'''
text = regex_once(
    text,
    r"async function enrollNode\(request, env\) \{.*?\n\}\n\nasync function heartbeat",
    new_enroll + "\n\nasync function heartbeat",
    "enrollNode",
)
text = replace_once(
    text,
    "  await Promise.all([ensureReportStorage(env), ensureSessionStorage(env)]);\n\n  const [counts, nodesQuery, missionsQuery, commandsQuery, auditQuery] = await Promise.all([",
    "  await Promise.all([ensureReportStorage(env), ensureSessionStorage(env), ensureAutoEnrollmentStorage(env)]);\n\n  const [counts, nodesQuery, missionsQuery, commandsQuery, auditQuery] = await Promise.all([",
    "Architect enrollment storage",
)
text = replace_once(
    text,
    '''    env.DB.prepare(
      "SELECT node_id, hostname, os_name, os_version, architecture, " +
      "agent_version, status, cpu_percent, memory_percent, " +
      "enrolled_at, last_seen_at FROM nodes " +
      "ORDER BY last_seen_at DESC LIMIT 100"
    ).all(),''',
    '''    env.DB.prepare(
      "SELECT n.node_id, nn.node_number, n.hostname, n.os_name, n.os_version, n.architecture, " +
      "n.agent_version, n.status, n.cpu_percent, n.memory_percent, " +
      "n.enrolled_at, n.last_seen_at FROM nodes AS n " +
      "LEFT JOIN node_numbers AS nn ON nn.node_id = n.node_id " +
      "ORDER BY n.last_seen_at DESC LIMIT 100"
    ).all(),''',
    "Architect node number",
)
write(path, text)


# Re-pin release hashes after source version/telemetry changes.
v1_hash = hashlib.sha256((ROOT / "agent/citadel_node_v1.py").read_bytes()).hexdigest()
v2_hash = hashlib.sha256((ROOT / "agent/citadel_node_v2.py").read_bytes()).hexdigest()

path = "agent/setup_windows.ps1"
text = read(path)
text, c1 = re.subn(r'\$ExpectedV1Sha256 = "[0-9a-f]{64}"', f'$ExpectedV1Sha256 = "{v1_hash}"', text, count=1)
text, c2 = re.subn(r'\$ExpectedV2Sha256 = "[0-9a-f]{64}"', f'$ExpectedV2Sha256 = "{v2_hash}"', text, count=1)
if c1 != 1 or c2 != 1:
    raise RuntimeError("could not update setup hash pins")
write(path, text)

path = "src/index.js"
text = read(path)
text, c1 = re.subn(
    r'(path: "citadel_node_v1\.py",\n\s+url: "[^"]+",\n\s+sha256: ")[0-9a-f]{64}(")',
    rf'\g<1>{v1_hash}\2',
    text,
    count=1,
)
text, c2 = re.subn(
    r'(path: "citadel_node_v2\.py",\n\s+url: "[^"]+",\n\s+sha256: ")[0-9a-f]{64}(")',
    rf'\g<1>{v2_hash}\2',
    text,
    count=1,
)
if c1 != 1 or c2 != 1:
    raise RuntimeError("could not update controller release hashes")
write(path, text)


# Fixed package must identify the new source-level release.
path = "scripts/build_fixed_agent_package.py"
text = read(path)
text = text.replace("0.3.2", "0.3.3")
write(path, text)


# Regression guards for every issue found in the old review mail.
(ROOT / "tests/review-backlog-guards.mjs").write_text(r'''import fs from "node:fs";
function need(value, message) { if (!value) throw new Error(message); }
const index = fs.readFileSync("src/index.js", "utf8");
const setup = fs.readFileSync("agent/setup_windows.ps1", "utf8");
const readme = fs.readFileSync("agent/README_RU.md", "utf8");
const nodeTest = fs.readFileSync("node-test.html", "utf8");
const agentV1 = fs.readFileSync("agent/citadel_node_v1.py", "utf8");
const agentV2 = fs.readFileSync("agent/citadel_node_v2.py", "utf8");
const telemetry = fs.readFileSync("src/telemetry/normalize.js", "utf8");
need(index.includes("auto_enrollment_windows"), "global auto-enrollment window missing");
need(index.includes("AUTO_ENROLL_MAX_NEW_PER_HOUR"), "enrollment hourly setting missing");
need(index.includes("AUTO_ENROLL_MAX_NODES"), "enrollment node cap setting missing");
need(index.includes("auto_enrollment_rate_limited"), "enrollment rate error missing");
need(index.includes("INSERT OR IGNORE INTO node_numbers"), "legacy number reconciliation missing");
need(index.includes("nn.node_number"), "Architect permanent node number missing");
need(index.includes("LEFT JOIN node_numbers AS nn"), "Architect node number join missing");
need(!readme.includes("-EnrollmentToken"), "README still documents EnrollmentToken");
need(!nodeTest.includes("enrollment_token"), "browser still sends enrollment_token");
need(!nodeTest.includes("tokenInput"), "browser still depends on token input");
need(setup.includes("$RunArguments"), "Windows paths are not quoted");
need(setup.includes("refusing to start another copy"), "process inspection is not fail-closed");
need(agentV1.includes('VERSION = "0.3.3"'), "v1 release not bumped");
need(agentV2.includes('VERSION = "0.3.3"'), "v2 release not bumped");
need(agentV2.includes('"windows_sleep_inhibit"'), "agent drops sleep event");
for (const eventType of [
  "windows_sleep_inhibit",
  "agent_updated",
  "agent_update_rolled_back",
  "agent_update_healthcheck_passed",
  "agent_update_manual_rollback",
  "agent_restart_requested"
]) {
  need(telemetry.includes(`"${eventType}"`), `controller drops ${eventType}`);
}
need(index.includes('version: "0.3.3"'), "Controller release not bumped");
console.log("Review backlog guards: PASS");
''', encoding="utf-8", newline="\n")

path = "scripts/validate.sh"
text = read(path)
text = replace_once(
    text,
    "node tests/update-integrity.mjs\n",
    "node tests/update-integrity.mjs\nnode tests/review-backlog-guards.mjs\n",
    "validate guard",
)
write(path, text)

print("Applied review backlog fixes on Agent 0.3.3")
print("v1_sha256", v1_hash)
print("v2_sha256", v2_hash)
