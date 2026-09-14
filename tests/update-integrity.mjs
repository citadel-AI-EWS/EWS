import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const releaseBlock = source.match(/const LATEST_NODE_RELEASE = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
assert.ok(releaseBlock, "latest release declaration missing");

for (const path of ["citadel_node_v1.py", "citadel_node_v2.py"]) {
  const bytes = await readFile(new URL(`../agent/${path}`, import.meta.url));
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.match(releaseBlock[0], new RegExp(`path: "${path}"[\\s\\S]*?sha256: "${digest}"`));
}

assert.match(source, /ALLOWED_ARCHITECT_COMMAND_TYPES[^\n]+"update"/);
assert.match(source, /\/api\/v1\/hub\/nodes/);
assert.match(source, /architectRelease/);
console.log("Signed remote update release and live Hub wiring: OK");
