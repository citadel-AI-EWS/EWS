import assert from "node:assert/strict";
import {
  PROJECT_EXPERIENCE_REGISTRY_VERSION,
  getProjectExperienceRegistry
} from "../src/experience/registry.js";

const registry = getProjectExperienceRegistry();
assert.match(PROJECT_EXPERIENCE_REGISTRY_VERSION, /^2026-09-18\./);
assert.equal(registry.registry_version, PROJECT_EXPERIENCE_REGISTRY_VERSION);
assert.equal(registry.operational_d1, false);
assert.equal(registry.raw_archive_embedded, false);
assert.equal(registry.raw_logs_embedded, false);
assert.equal(registry.legacy_summary.structured_runs, 650);
assert.equal(registry.legacy_summary.structured_failures, 650);
assert.ok(registry.entries.length >= 12);

const ids = registry.entries.map((entry) => entry.id);
assert.equal(new Set(ids).size, ids.length);
const allowedStatuses = new Set(["accepted", "confirmed", "guardrail", "lesson", "rejected"]);
for (const entry of registry.entries) {
  assert.match(entry.id, /^CRE-\d{3}$/);
  assert.ok(allowedStatuses.has(entry.status), `unexpected status: ${entry.status}`);
  assert.ok(entry.problem.length > 10);
  assert.ok(entry.decision.length > 10);
  assert.ok(entry.replacement.length > 10);
  assert.ok(Array.isArray(entry.artifact_refs) && entry.artifact_refs.length > 0);
}

const serialized = JSON.stringify(registry);
for (const forbidden of [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "private_key_id",
  "client_secret"
]) {
  assert.equal(serialized.includes(forbidden), false, `forbidden credential material: ${forbidden}`);
}

console.log("Project Experience Registry: OK");
