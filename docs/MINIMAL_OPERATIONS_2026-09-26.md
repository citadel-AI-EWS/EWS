# Two-page operations console

This branch implements the September 26 request to replace the Architect navigation with Machines and Logs. The static build ships operations.html as the root, and redirects old Hub/Architect URLs to it. Legacy source files are retained for rollback but are not served by the new build.

Implemented:
- Authenticated machine snapshot, control commands, one prompt submission through the existing project checks and scheduler, progress from recorded work-item counts, reports.
- No EE/Python/hybrid mode buttons. Natural-language prompts use the existing AI project dispatcher; automatic Python generation/execution is not implemented by this change.
- Visible-tab polling once per minute, immediate refresh on entry/return, abort on hide/logout, no browser-driven background polling.
- Dedicated lightweight machine endpoint avoids expensive full overview/report counts and telemetry subqueries.
- Heartbeats still replace current node state for scheduling but no longer append audit events. Migration 0015 removes old heartbeat history only and routine node events.
- Ingestion keeps errors, completion and report events; routine informational status is acknowledged and discarded. Security audit records remain stored separately. Task reports remain durable.
- Running/accepted command animation, queued indication, real task completion counts, reduced-motion support and mobile layout.
- Project creation fails before writing a project when there are no execution-ready nodes.

Remaining acceptance blockers (do not claim these are complete):
- SSH: current agent has no signed, short-lived SSH session command, lease enforcement or automatic session termination. UI explicitly reports unavailable. Need agent support plus a configured authenticated relay/SSH CA; do not expose port 22 or claim a timed session from a locally entered hostname.
- On-demand machine challenge: snapshot reads latest authenticated heartbeat with timestamp, not a new immediate response from each machine. Existing agent polling remains independent of the browser. A signed status-request command/response is still required for that exact behavior.
- Live end-to-end execution needs a connected execution-ready node and configured signing. Local mocked browser tests do not establish live readiness.
- Publication to main authorized by the user on September 26. Check deployment workflow status separately. Migration 0015 must be applied to remove existing history; stopping new heartbeat audit inserts takes effect on deployment.

Validation passed: npm test; npm run build; node --check src/index.js; git diff --check. Browser test added but NOT run successfully: Chromium is missing and its download failed (invalid archive). Run node tests/operations-browser.cjs with Playwright and Chromium installed (CODEX_PRIMARY_RUNTIME_NODE_MODULES). Visual layout is not verified.
