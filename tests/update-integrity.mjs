import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { releaseForAgentVersion, updatePayloadReadyForAgent, failedBridgeUpdateNeedsNewRelease, rolloutCommandRetryBlocked } from "../src/index.js";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const releaseBlock = source.match(/const LATEST_NODE_RELEASE = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
assert.ok(releaseBlock, "latest release declaration missing");

const release = {
  version: "0.3.41",
  files: ["citadel_node_v1.py", "citadel_node_v2.py", "windows_enterprise_probe.ps1",
    "CitadelSshConsole.cs", "configure_restricted_ssh.ps1"].map((path) => ({path}))
};
const legacy031Bridge = releaseForAgentVersion(release, "0.3.1");
assert.equal(legacy031Bridge.version, "0.3.2-bridge.1");
assert.deepEqual(legacy031Bridge.files.map((file) => file.path),
  ["citadel_node_v1.py", "citadel_node_v2.py"]);
assert.ok(legacy031Bridge.files.every((file) =>
  file.url.includes("/0e168af8c39baad7c9157a732562dade0c58f12c/agent/")));
assert.deepEqual(legacy031Bridge.files.map((file) => file.sha256), [
  "4a5638a410ca689141a9a4c81d4e2d109c8cf2904e62df50ec6753f4146f5b37",
  "18fe495f2a46882e5c6c0172d217898d7374177c04b391a34931061b36342b6d"
]);
assert.equal(releaseForAgentVersion(release, "0.3.2-bridge.1").version, "0.3.41");
assert.deepEqual(releaseForAgentVersion(release, "0.3.2-bridge.1").files.map((file) => file.path),
  ["citadel_node_v1.py", "citadel_node_v2.py"]);
assert.deepEqual(releaseForAgentVersion(release, "0.3.13").files.map((file) => file.path),
  ["citadel_node_v1.py", "citadel_node_v2.py", "windows_enterprise_probe.ps1"]);
assert.deepEqual(releaseForAgentVersion(release, "0.3.27").files.map((file) => file.path),
  release.files.map((file) => file.path));
assert.match(source, /payload = releaseForAgentVersion\(LATEST_NODE_RELEASE, node\.agent_version\)/);
assert.match(source, /JSON\.stringify\(releaseForAgentVersion\(/);
const manualUpdate = source.slice(source.indexOf("async function architectCreateCommand"));
assert.match(manualUpdate, /updatePayloadReadyForAgent\(safeJson\(pending\.payload_json, \{\}\), node\.agent_version\)/);
assert.match(manualUpdate, /agent\.update\.incompatible_command_retired/);
assert.match(source, /await repairPendingUpdateForNode\(env, node\)/);
assert.match(source, /agent\.update\.incompatible_command_replaced/);
assert.match(source, /await continueCompletedBridgeUpdateForNode\(env, node\)/);
assert.match(source, /latestUpdate\.status !== "completed"/);
assert.match(source, /safeJson\(latestUpdate\.payload_json, \{\}\)\?\.version !== LEGACY_031_BRIDGE_RELEASE\.version/);
assert.match(source, /agent\.update\.bridge_continued/);

const currentRelease = {
  version: "0.3.41",
  files: [...releaseBlock[0].matchAll(/path: "([^"]+)",\s+url: "([^"]+)",\s+sha256: "([^"]+)"/g)]
    .map(([, path, url, sha256]) => ({ path, url, sha256 }))
};
const oldBridgeTarget = structuredClone(releaseForAgentVersion(currentRelease, "0.3.2-bridge.1"));
oldBridgeTarget.files[1].sha256 = "c04d60c25621f8f25e511b1b99a7d2b7f9dd721de1f5c35515eb854024e9b094";
const failedOldHop = {
  command_id: "command_failed",
  status: "failed",
  payload_json: JSON.stringify(oldBridgeTarget)
};
const oldNode = { agent_version: "0.3.2-bridge.1", status: "online", last_seen_at: new Date().toISOString() };
assert.equal(rolloutCommandRetryBlocked(failedOldHop, oldNode, currentRelease.version), false,
  "a corrected pinned payload is eligible for one recovery attempt");
assert.equal(rolloutCommandRetryBlocked({
  ...failedOldHop, payload_json: JSON.stringify(releaseForAgentVersion(currentRelease, oldNode.agent_version))
}, oldNode, currentRelease.version), true, "the same failed payload cannot be retried on every poll");
assert.equal(failedBridgeUpdateNeedsNewRelease(failedOldHop, "0.3.2-bridge.1", currentRelease), true);
assert.equal(failedBridgeUpdateNeedsNewRelease(failedOldHop, "0.3.36", currentRelease), false);
assert.equal(failedBridgeUpdateNeedsNewRelease(
  {...failedOldHop, status: "completed"}, "0.3.2-bridge.1", currentRelease
), false);
assert.equal(failedBridgeUpdateNeedsNewRelease({
  ...failedOldHop,
  payload_json: JSON.stringify(releaseForAgentVersion(currentRelease, "0.3.2-bridge.1"))
}, "0.3.2-bridge.1", currentRelease), false, "same failed release cannot retry");

for (const version of ["0.3.1", "0.3.2-bridge.1", "0.3.13", "0.3.27", "0.3.36"]) {
  const payload = releaseForAgentVersion(currentRelease, version);
  assert.equal(updatePayloadReadyForAgent(payload, version), true);
  assert.equal(updatePayloadReadyForAgent({...payload, version: "0.3.36"}, version), false);
  const stale = structuredClone(payload);
  stale.files[0].sha256 = "0".repeat(64);
  assert.equal(updatePayloadReadyForAgent(stale, version), false);
  const mutable = structuredClone(payload);
  mutable.files[0].url += "?stale";
  assert.equal(updatePayloadReadyForAgent(mutable, version), false);
}

for (const path of ["citadel_node_v1.py", "citadel_node_v2.py"]) {
  const bytes = await readFile(new URL(`../agent/${path}`, import.meta.url));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.match(releaseBlock[0], new RegExp(`path: "${path}"[\\s\\S]*?sha256: "${digest}"`));
}

assert.match(source, /ALLOWED_ARCHITECT_COMMAND_TYPES[^\n]+"update"/);
assert.match(source, /\/api\/v1\/hub\/nodes/);
assert.match(source, /architectRelease/);
console.log("Signed remote update release and live Hub wiring: OK");
