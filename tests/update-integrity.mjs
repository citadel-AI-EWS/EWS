import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { releaseForAgentVersion } from "../src/index.js";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const releaseBlock = source.match(/const LATEST_NODE_RELEASE = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
assert.ok(releaseBlock, "latest release declaration missing");

const release = {
  version: "0.3.36",
  files: ["citadel_node_v1.py", "citadel_node_v2.py", "windows_enterprise_probe.ps1",
    "CitadelSshConsole.cs", "configure_restricted_ssh.ps1"].map((path) => ({path}))
};
assert.deepEqual(releaseForAgentVersion(release, "0.3.1").files.map((file) => file.path),
  ["citadel_node_v1.py", "citadel_node_v2.py"]);
assert.deepEqual(releaseForAgentVersion(release, "0.3.13").files.map((file) => file.path),
  ["citadel_node_v1.py", "citadel_node_v2.py", "windows_enterprise_probe.ps1"]);
assert.deepEqual(releaseForAgentVersion(release, "0.3.27").files.map((file) => file.path),
  release.files.map((file) => file.path));
assert.match(source, /payload = releaseForAgentVersion\(LATEST_NODE_RELEASE, node\.agent_version\)/);
assert.match(source, /JSON\.stringify\(releaseForAgentVersion\(/);
const manualUpdate = source.slice(source.indexOf("async function architectCreateCommand"));
assert.match(manualUpdate, /updatePayloadCompatibleWithAgent\(safeJson\(pending\.payload_json, \{\}\), node\.agent_version\)/);
assert.match(manualUpdate, /agent\.update\.incompatible_command_retired/);

for (const path of ["citadel_node_v1.py", "citadel_node_v2.py"]) {
  const bytes = await readFile(new URL(`../agent/${path}`, import.meta.url));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.match(releaseBlock[0], new RegExp(`path: "${path}"[\\s\\S]*?sha256: "${digest}"`));
}

assert.match(source, /ALLOWED_ARCHITECT_COMMAND_TYPES[^\n]+"update"/);
assert.match(source, /\/api\/v1\/hub\/nodes/);
assert.match(source, /architectRelease/);
console.log("Signed remote update release and live Hub wiring: OK");
