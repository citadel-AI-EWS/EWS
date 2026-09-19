export const PROJECT_EXPERIENCE_REGISTRY_VERSION = "2026-09-18.1";

const ENTRIES = Object.freeze([
  {
    id: "CRE-001",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "security",
    status: "rejected",
    severity: "critical",
    problem: "Legacy source and configuration contained embedded credential material.",
    evidence: "Credential-shaped material was found during the archive review; secret values were intentionally excluded from the distilled project artifacts.",
    decision: "Never copy embedded credentials from historical material into EWS.",
    replacement: "Use server-side runtime secret stores and rotate or revoke any legacy credential that might still be valid.",
    artifact_refs: ["docs/LEGACY_CRE_REVIEW_2026-09-18.md"]
  },
  {
    id: "CRE-002",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "orchestration",
    status: "rejected",
    severity: "critical",
    problem: "The historical local-AI research cycle was not operationally healthy.",
    evidence: "650 of 650 structured cycles failed; 649 recorded EMPTY_MODEL_OUTPUT_ThreatScout and one recorded LM Studio authorization failure.",
    decision: "Do not port the monolithic research loop.",
    replacement: "Use bounded task types with explicit success criteria, timeouts, resource guards and end-to-end outcome checks.",
    artifact_refs: ["knowledge/legacy_cre_experience.sql", "docs/LEGACY_CRE_REVIEW_2026-09-18.md"]
  },
  {
    id: "CRE-003",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "resource-control",
    status: "guardrail",
    severity: "high",
    problem: "Large evidence packets overloaded a constrained local model host.",
    evidence: "Observed runs were roughly ten minutes long while the host operated under high memory pressure and processed multi-thousand-token prompts.",
    decision: "Bound evidence before it reaches an AI task.",
    replacement: "Current policy caps evidence item count, evidence characters and reference IDs; resource guards remain mandatory.",
    artifact_refs: ["src/experience/policy.js"]
  },
  {
    id: "CRE-004",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "provenance",
    status: "accepted",
    severity: "medium",
    problem: "External information can be fresh, cached or stale and must not be presented as equivalent.",
    evidence: "Legacy source collection generally stayed healthy and explicitly recorded cache and stale state.",
    decision: "Keep source provenance and cache/stale metadata.",
    replacement: "Carry provenance alongside evidence and require valid evidence references.",
    artifact_refs: ["src/experience/policy.js", "knowledge/legacy_cre_experience.sql"]
  },
  {
    id: "CRE-005",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "testing",
    status: "guardrail",
    severity: "high",
    problem: "Low-level regression checks can pass while the complete task still fails.",
    evidence: "Most legacy L001-L014 checks passed even though all 650 structured end-to-end cycles failed.",
    decision: "Do not treat component health as proof of mission success.",
    replacement: "Keep component tests plus end-to-end CI, health gates and explicit mission outcome checks.",
    artifact_refs: ["scripts/validate.sh", "knowledge/legacy_cre_experience.sql"]
  },
  {
    id: "CRE-006",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "safety",
    status: "accepted",
    severity: "high",
    problem: "Model-driven automation can become unsafe when recommendations directly cause actions.",
    evidence: "The useful legacy defaults separated analysis from dangerous actions.",
    decision: "Keep analysis advisory and bounded.",
    replacement: "No malware download, model-driven shell, automatic network blocking, automatic model download, switch or configuration change.",
    artifact_refs: ["src/experience/policy.js"]
  },
  {
    id: "CRE-007",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "integrity",
    status: "confirmed",
    severity: "medium",
    problem: "Interrupted or corrupted state updates can make recovery unreliable.",
    evidence: "The legacy engine used SHA-256 and atomic state concepts; current EWS already has stronger versions of both.",
    decision: "Retain integrity hashes and atomic writes as standard project patterns.",
    replacement: "Use current EWS signed updates, SHA-256 verification, atomic writes and rollback rather than porting old implementations.",
    artifact_refs: ["src/experience/policy.js"]
  },
  {
    id: "CRE-008",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "storage",
    status: "lesson",
    severity: "medium",
    problem: "External archival failures can destabilize a core processing cycle when tightly coupled.",
    evidence: "Historical Drive preflight/archive state included failed or missing-file conditions.",
    decision: "Keep archival storage outside the critical task path.",
    replacement: "Operational metadata remains independent; external storage adapters must have separate health and retry behavior.",
    artifact_refs: ["docs/LEGACY_CRE_REVIEW_2026-09-18.md"]
  },
  {
    id: "CRE-009",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "architecture",
    status: "rejected",
    severity: "high",
    problem: "A monolithic engine mixed collection, model inference, storage, repair, scheduling and reporting.",
    evidence: "The historical main program concentrated many unrelated responsibilities in one runtime.",
    decision: "Do not reproduce the monolith.",
    replacement: "Keep EWS concerns modular: Worker API, agent, telemetry, presence, experience policy and optional adapters.",
    artifact_refs: ["docs/LEGACY_CRE_REVIEW_2026-09-18.md"]
  },
  {
    id: "CRE-010",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "evidence",
    status: "accepted",
    severity: "medium",
    problem: "AI conclusions need a visible distinction between observed facts and inference.",
    evidence: "The legacy evidence model used KNOWN, INFERRED and SPECULATIVE classifications and evidence IDs.",
    decision: "Keep the evidence classification idea with tighter input budgets.",
    replacement: "Current engineering-experience policy validates classifications, unique evidence IDs and references.",
    artifact_refs: ["src/experience/policy.js", "tests/legacy-experience.mjs"]
  },
  {
    id: "CRE-011",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "model-management",
    status: "accepted",
    severity: "medium",
    problem: "Automatically changing models can hide orchestration faults and make failures harder to reproduce.",
    evidence: "The historical advisor correctly recommended fixing reliability before changing the model.",
    decision: "Model advice remains recommendation-only.",
    replacement: "A model may be proposed for review, but no automatic download, switch or configuration mutation is allowed.",
    artifact_refs: ["src/experience/policy.js"]
  },
  {
    id: "CRE-012",
    date: "2026-09-18",
    source: "legacy-cre-v19.2.2",
    area: "agent-resilience",
    status: "confirmed",
    severity: "medium",
    problem: "Useful old concepts should not be duplicated when EWS already implements stronger mechanisms.",
    evidence: "Current EWS already provides offline result queueing, exponential backoff, signed node commands, resource guards, update integrity checks and rollback.",
    decision: "Record the historical lesson without duplicating code.",
    replacement: "Reuse current EWS mechanisms and add regression tests only where the old archive exposed a missing contract.",
    artifact_refs: ["docs/PROJECT_MEMORY.md"]
  }
]);

export function getProjectExperienceRegistry() {
  const counts = {};
  for (const entry of ENTRIES) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return {
    registry_version: PROJECT_EXPERIENCE_REGISTRY_VERSION,
    scope: "sanitized-engineering-memory",
    storage: "repository-static-registry",
    operational_d1: false,
    raw_archive_embedded: false,
    raw_logs_embedded: false,
    legacy_summary: {
      reviewed_files: 4686,
      reviewed_log_files: 686,
      structured_runs: 650,
      structured_failures: 650
    },
    summary: { entries: ENTRIES.length, by_status: counts },
    artifacts: [
      "knowledge/legacy_cre_experience.sql",
      "docs/LEGACY_CRE_REVIEW_2026-09-18.md",
      "docs/PROJECT_EXPERIENCE_REGISTRY.md"
    ],
    entries: ENTRIES.map((entry) => ({ ...entry, artifact_refs: [...entry.artifact_refs] }))
  };
}
