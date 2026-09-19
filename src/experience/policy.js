// Engineering lessons distilled from the legacy CRE v19.2.2 review.
// This module contains policy/integrity invariants only. It intentionally
// contains no legacy credentials, remote-execution logic, or autonomous model changes.

export const ENGINEERING_EXPERIENCE_VERSION = "cre-v19.2.2-review-2026-09-18";

export const EWS_ENGINEERING_INVARIANTS = Object.freeze({
  embedded_credentials: false,
  external_code_execution_from_model: false,
  malware_sample_download: false,
  automatic_network_blocking: false,
  automatic_model_download: false,
  automatic_model_switch: false,
  automatic_model_config_change: false,
  integrity_hash: "sha256",
  evidence_provenance_required: true,
  evidence_classifications: Object.freeze(["KNOWN", "INFERRED", "SPECULATIVE"]),
  bounded_inputs_required: true,
  explicit_failure_state_required: true,
});

export const EXPERIENCE_LIMITS = Object.freeze({
  max_evidence_items: 32,
  max_evidence_chars: 24 * 1024,
  max_reference_ids: 64,
});

export function validateEvidencePacket(packet, referencedIds = []) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { ok: false, error: "invalid_evidence_packet" };
  }
  if (packet.evidence !== undefined && !Array.isArray(packet.evidence)) {
    return { ok: false, error: "invalid_evidence" };
  }
  const evidence = packet.evidence || [];
  if (evidence.length > EXPERIENCE_LIMITS.max_evidence_items) {
    return { ok: false, error: "too_many_evidence_items" };
  }

  const serialized = JSON.stringify(packet);
  if (new TextEncoder().encode(serialized).byteLength > EXPERIENCE_LIMITS.max_evidence_chars) {
    return { ok: false, error: "evidence_packet_too_large" };
  }

  const knownIds = new Set();
  for (const item of evidence) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "invalid_evidence_item" };
    }
    const evidenceId = typeof item.evidence_id === "string" ? item.evidence_id.trim() : "";
    if (!evidenceId || evidenceId.length > 160 || knownIds.has(evidenceId)) {
      return { ok: false, error: "invalid_evidence_id" };
    }
    knownIds.add(evidenceId);
    if (!EWS_ENGINEERING_INVARIANTS.evidence_classifications.includes(item.classification)) {
      return { ok: false, error: "invalid_evidence_classification" };
    }
  }

  if (!Array.isArray(referencedIds) || referencedIds.length > EXPERIENCE_LIMITS.max_reference_ids) {
    return { ok: false, error: "invalid_reference_ids" };
  }
  const missing = referencedIds.filter((id) => !knownIds.has(id));
  if (missing.length) {
    return { ok: false, error: "unknown_evidence_reference", missing: missing.slice(0, 8) };
  }
  return { ok: true, evidence_count: evidence.length };
}

export function validateEngineeringExperience() {
  const violations = [];
  for (const key of [
    "embedded_credentials",
    "external_code_execution_from_model",
    "malware_sample_download",
    "automatic_network_blocking",
    "automatic_model_download",
    "automatic_model_switch",
    "automatic_model_config_change",
  ]) {
    if (EWS_ENGINEERING_INVARIANTS[key] !== false) violations.push(key);
  }
  if (EWS_ENGINEERING_INVARIANTS.integrity_hash !== "sha256") {
    violations.push("integrity_hash");
  }
  if (!EWS_ENGINEERING_INVARIANTS.evidence_provenance_required) {
    violations.push("evidence_provenance_required");
  }
  if (!EWS_ENGINEERING_INVARIANTS.bounded_inputs_required) {
    violations.push("bounded_inputs_required");
  }
  if (!EWS_ENGINEERING_INVARIANTS.explicit_failure_state_required) {
    violations.push("explicit_failure_state_required");
  }
  return { ok: violations.length === 0, violations };
}
