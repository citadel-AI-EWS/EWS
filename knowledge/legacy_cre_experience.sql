-- Separate, sanitized reference database seed distilled from legacy CRE v19.2.2.
-- Create independently from operational D1, e.g.:
--   sqlite3 legacy_experience.sqlite < knowledge/legacy_cre_experience.sql
-- No credential values or raw user data are included.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS legacy_findings (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  integration_decision TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_run_summary (
  day TEXT PRIMARY KEY,
  runs INTEGER NOT NULL,
  successes INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  empty_model_output INTEGER NOT NULL,
  auth_401 INTEGER NOT NULL,
  median_seconds REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_reusable_features (
  feature TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  target TEXT NOT NULL,
  rationale TEXT NOT NULL
);

INSERT OR REPLACE INTO legacy_findings VALUES
('F001','security','critical','Hard-coded credentials in legacy source/config','Legacy package embedded a Google service-account private key and API-style credential. Values are intentionally omitted.','Rotate/revoke if still valid; use runtime secret storage only.','REJECT_SECRET_VALUES'),
('F002','reliability','critical','650/650 recorded pipeline cycles failed','All 650 structured runs failed; 649 cite EMPTY_MODEL_OUTPUT_ThreatScout and one cites LM_STUDIO_AUTH_401.','Do not port the monolithic execution loop; preserve bounded diagnostics and preflight patterns.','PARTIAL_PORT'),
('F003','performance','high','Local model workload exceeded host headroom','Seven-day advisor recorded 0% success, about 635 seconds average run time and about 93.4% RAM utilization.','Use tighter resource-aware budgets and deterministic failure states.','PORT_GUARDS'),
('F004','observability','positive','Structured reports and regression checks were strong','Runs recorded source provenance, hashes, timings, safety state, failure reasons and L001-L014 checks.','Carry the health-contract pattern into EWS tests and telemetry.','PORT'),
('F005','data-quality','positive','TTL cache and stale metadata were useful','Source state distinguished fresh/cache/stale data and retained hashes.','Reuse the generic provenance pattern, not mandatory threat feeds.','PORT_PATTERN'),
('F006','safety','positive','Defensive defaults were explicit','Legacy safety settings disabled malware download, external-code execution, model shell access, auto-blocking and automatic model switching.','Preserve these as EWS invariants.','PORT_POLICY'),
('F007','integrity','positive','SHA-256 and atomic state writes were widespread','Legacy code hashed artifacts/config/data and used atomic JSON writes.','Reuse integrity metadata and crash-safe local state.','PORT'),
('F008','operations','medium','External Drive archival was brittle','Latest Drive preflight reported a missing target file and latest startup repair status was FAILED.','Keep external storage optional and independently health-checked.','PORT_LESSON'),
('F009','architecture','medium','Monolithic engine coupled unrelated concerns','A single process handled startup, network repair, sources, model inference, advisor, reporting, Drive and archives.','Keep EWS capabilities modular with narrow interfaces and tests.','REFACTOR_PATTERN'),
('F010','prompting','high','Evidence discipline was good but prompts remained heavy','Evidence IDs and classifications existed, yet LM Studio logs show multi-thousand-token prompt processing on constrained hardware.','Keep provenance validation but tighten dynamic budgets.','PORT_WITH_TIGHTER_LIMITS');

INSERT OR REPLACE INTO legacy_run_summary VALUES
('2026-09-09',62,0,62,62,0,0.0),
('2026-09-10',107,0,107,107,0,0.0),
('2026-09-11',105,0,105,105,0,0.0),
('2026-09-12',105,0,105,105,0,0.0),
('2026-09-13',104,0,104,104,0,0.0),
('2026-09-14',105,0,105,105,0,0.0),
('2026-09-15',53,0,53,53,0,0.0),
('2026-09-17',9,0,9,8,1,735.712);

INSERT OR REPLACE INTO legacy_reusable_features VALUES
('atomic state writes','PORT','agent/local state','Avoid torn state after crash.'),
('SHA-256 artifact/config hashing','PORT','agent + controller','Matches signed report/update integrity.'),
('structured JSONL event logging','PORT/ALREADY_PRESENT','node telemetry','EWS already has bounded signed telemetry.'),
('single-instance supervisor concept','ADAPT','agent service lifecycle','Prefer explicit service/process locking over hidden VBS repair.'),
('network health preflight','PORT','agent doctor/health','Use bounded diagnostics, not aggressive autonomous repair.'),
('runtime dependency bootstrap','REJECT_AUTO_INSTALL','installer','Dependencies belong in signed install/update flows.'),
('TTL cache with stale flag','PORT_PATTERN','ingestion/storage','Useful generic resilient-ingestion pattern.'),
('KNOWN/INFERRED/SPECULATIVE evidence classes','PORT','report schema','Improves provenance and unsupported-claim resistance.'),
('evidence ID validation','PORT','report validator','Reject references absent from supplied evidence.'),
('regression check registry','PORT','tests/health','Turn legacy lessons into deterministic health contracts.'),
('daily rolling archive','ADAPT','retention','Bound retention and avoid indefinite D1 duplication.'),
('model advisor recommend-only mode','PORT_PATTERN','optional local-AI module','No automatic download/switch/config change.'),
('embedded Drive credentials','REJECT','secrets','Severe secret-management flaw.'),
('monolithic endless research loop','REJECT','runtime','Observed zero successful structured runs.'),
('threat-specific feeds','DO_NOT_CORE_PORT','optional plugin','Keep domain feeds optional in a general EWS platform.');
