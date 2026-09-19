import assert from "node:assert/strict";
import {
  ENGINEERING_EXPERIENCE_VERSION,
  EWS_ENGINEERING_INVARIANTS,
  validateEngineeringExperience,
  validateEvidencePacket,
} from "../src/experience/policy.js";

assert.match(ENGINEERING_EXPERIENCE_VERSION, /^cre-v19\.2\.2-review-/);
assert.equal(validateEngineeringExperience().ok, true);
assert.equal(EWS_ENGINEERING_INVARIANTS.embedded_credentials, false);
assert.equal(EWS_ENGINEERING_INVARIANTS.external_code_execution_from_model, false);

const packet = {
  evidence: [
    { evidence_id: "src:1", classification: "KNOWN", value: "observed" },
    { evidence_id: "src:2", classification: "INFERRED", value: "derived" },
  ],
};
assert.deepEqual(validateEvidencePacket(packet, ["src:1"]), { ok: true, evidence_count: 2 });
assert.equal(validateEvidencePacket(packet, ["missing"]).error, "unknown_evidence_reference");
assert.equal(
  validateEvidencePacket({ evidence: [{ evidence_id: "x", classification: "UNVERIFIED" }] }).error,
  "invalid_evidence_classification",
);

console.log("Legacy CRE engineering-experience policy: OK");
