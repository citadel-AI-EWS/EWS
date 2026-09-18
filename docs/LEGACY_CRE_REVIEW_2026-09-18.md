# Legacy CRE v19.2.2 review — 2026-09-18

## Scope

Reviewed the uploaded legacy archive as historical engineering evidence for EWS/CITADEL. The extracted set contained 4,686 files and roughly 280 MiB. All 686 `.log` files were included in the inventory/aggregate scan. A separate local SQLite review database was also generated with file SHA-256 fingerprints, structured run outcomes, source observations, regression-check outcomes, sanitized security findings and integration decisions. Credential values and raw logs were deliberately excluded from the distilled project knowledge.

## Operational result

The legacy research loop was not production-healthy. Across 650 structured run reports, **650 failed**. Of those, **649** cite `EMPTY_MODEL_OUTPUT_ThreatScout`; the final observed failure cites `LM_STUDIO_AUTH_401`. The seven-day model advisor itself recorded a 0% success rate, about 635 seconds average run time, and about 93.4% RAM utilization, and correctly recommended fixing orchestration/reliability before replacing the model.

External feed acquisition was substantially healthier than inference: CISA KEV, GitHub advisories/malware metadata, Spamhaus DROP and Feodo Tracker observations were consistently recorded as OK, with explicit cache/stale provenance.

## What is worth carrying forward

- SHA-256 integrity metadata and atomic local-state writes.
- Bounded evidence/prompt concepts with explicit evidence IDs.
- `KNOWN` / `INFERRED` / `SPECULATIVE` classification and validation that references exist in the supplied evidence.
- Structured JSON/JSONL observability with timings, source state, hashes, failure reason and safety state.
- Regression-check / health-contract thinking (the old L001-L014 pattern).
- TTL cache with explicit `cache_used` and `stale` metadata.
- Recommend-only model advice: no automatic model download, switch or configuration mutation.
- Defensive defaults: no malware-sample download, no model-driven shell, no automatic firewall/blocking behavior.

## What is rejected

- Embedded credentials or private keys.
- Runtime self-install of dependencies as normal application behavior.
- Hidden autostart repair as the primary supervisor.
- The monolithic endless research loop that couples network repair, feeds, LM calls, Drive upload, archives and supervision.
- Threat-intelligence feeds as mandatory EWS core behavior; those belong in optional task/plugin modules.
- Large static prompt budgets without resource-aware limits.

## Security finding

The legacy package contains credential material directly in source/config, including a Google service-account private key and an API-style key. Values are intentionally not copied into this repository or the sanitized knowledge seed. Any credential that might still be valid should be rotated/revoked.

## Integration into EWS

This branch does **not** copy the old engine. It adds a small engineering-experience policy module and tests that preserve the strongest lessons: no embedded credentials, SHA-256 integrity, bounded inputs, evidence provenance, explicit failure states and no autonomous model/network escalation.

The sanitized reference database seed lives at `knowledge/legacy_cre_experience.sql`. It is intentionally separate from operational D1 and can be materialized as its own SQLite database for research/history without contaminating production state.
