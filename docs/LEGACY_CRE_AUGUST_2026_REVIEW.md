# Review of the CRE v19.2.1 August archive — 2026-10-07

Source archive SHA-256: `ec380351b2dc7abe4a5090d9dc8fe6032a3612404649b142dc9afd7511ffd7cc`. This review concerns the August 27–30, 2026 archive supplied by the project owner. It is distinct from the September v19.2.2 review.

## Inventory and method

The RAR has 7,217 file entries (about 284 MB uncompressed). 4,264 entries are the bundled Python environment. The review inventoried all entries, extracted 2,929 non-environment files, inspected the main Python engine and 22 node scripts, aggregated all 408 distinct daily JSON reports and the run/event logs, and inspected the five daily/rolling ZIP archives. The ZIPs duplicate the same run history; they were not counted as independent runs. Third-party packages in `.venv` were inventoried, not treated as project source.

The 22 node files are role-specific copies of one roughly 847-line program. They should not be imported into EWS as 22 independent runtimes.

## Findings

| Evidence | Result | EWS decision |
|---|---|---|
| 408/408 daily run reports say `FAILED`; all cite the ThreatScout HTTP read timeout. | Median cycle 429.5 seconds (range 428.5–436.3). The configured model passed metadata/auth preflight but did not return a usable answer. | Require a bounded `hi` inference that returns nonempty content before reporting AI readiness; track model-loaded, inference-pending, timeout and answer as separate states. |
| Typical evidence packet: 20 items, 23,236 characters; requests were estimated near 6,000 prompt tokens. | Two 210-second attempts dominated each cycle. | Bound prompt size by model context and available RAM; stop after a finite deadline and record a terminal error. Do not replay the same oversized request automatically. |
| Feodo Tracker was served from stale cache in 153 of 408 source records, while source status remained `OK` with `stale: true`. | A source can be available yet stale. | Preserve `cache_used`, `stale`, timestamp and hash. Do not equate a cached response with a fresh fetch. |
| Drive preflight and the latest midnight upload state both reported success in this August snapshot. | Authentication and an existing-file update worked then, but this does not prove current access or new-file creation. | Keep current server-side Drive authentication and test the configured folders with live preflight plus an actual report upload before claiming end-to-end delivery. |
| The main engine and node scripts embed a Google service-account private key; configuration also contains credential-like values. | The archive cannot be copied directly into a public repository. | Rotate/revoke any still-active legacy key. Inject a newly issued credential through `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` in the Worker secret store or use the existing OAuth refresh-token path; never commit the archive's key. |

## Integration

EWS already has a sanitized experience registry, evidence validation and a server-side Google Drive service-account/OAuth implementation. This review adds the August end-to-end inference failure to the registry and fixes the Drive token cache to follow credential rotation. The legacy Drive code updated pre-created files using an embedded key; EWS retains its own folder/report storage design.

This is historical evidence from one host and four days. It does not establish that today's CITADEL nodes or Google Drive access are healthy. No raw log, host address, credential, or archive payload is committed here.
