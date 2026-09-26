import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  deploymentReleaseManifest,
  isDeploymentPath
} from "../src/deployment.js";

assert.equal(isDeploymentPath("/api/v1/architect/deployments"), true);
assert.equal(isDeploymentPath("/api/v1/deployments/redeem"), true);
assert.equal(
  isDeploymentPath("/api/v1/architect/deployments/deploy_123/revoke"),
  true
);
assert.equal(isDeploymentPath("/api/v1/nodes/node_1/commands"), false);

const manifest = deploymentReleaseManifest();
assert.equal(manifest.schema, "citadel.deployment.manifest.v1");
assert.equal(manifest.safety.target_initiated, true);
assert.equal(manifest.safety.autonomous_network_discovery, false);
assert.equal(manifest.safety.lateral_movement, false);
assert.equal(manifest.safety.credential_collection, false);
assert.match(manifest.release.sha256, /^[a-f0-9]{64}$/);
assert.match(manifest.release.artifact_url, /^https:\/\/raw\.githubusercontent\.com\/citadel-AI-EWS\/EWS\//);

const bootstrap = await readFile(
  new URL("../agent/install_from_invite.ps1", import.meta.url),
  "utf8"
);
for (const required of [
  "-AuthorizeThisHost",
  "/api/v1/deployments/redeem",
  "Get-FileHash",
  "raw.githubusercontent.com",
  "CitadelEWSNode"
]) {
  assert.ok(bootstrap.includes(required), `bootstrap missing guard: ${required}`);
}
for (const forbidden of [
  "ExecutionPolicy Bypass",
  "Enable-PSRemoting",
  "Invoke-Command",
  "Enter-PSSession",
  "New-PSSession",
  "Get-ADComputer",
  "net view",
  "arp -a"
]) {
  assert.equal(
    bootstrap.toLowerCase().includes(forbidden.toLowerCase()),
    false,
    `bootstrap contains forbidden propagation primitive: ${forbidden}`
  );
}

console.log("Authorized target-initiated deployment guards: OK");
