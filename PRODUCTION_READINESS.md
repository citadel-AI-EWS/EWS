# EWS production-readiness review

Review date: 2026-09-05 (UTC)

## Verdict

**NO-GO for client use.** This repository is a browser prototype plus a TEST-only AWS
provisioning controller. It can create an isolated EC2 instance, but it does not execute a
customer task, collect an output, verify it, bill it, or return a deliverable. The UI itself
labels the integration as TEST-only and uses a shared Architect token.

## What was verified

- Both HTML snapshots are byte-identical and load without a build step.
- The Python source parses, the shell deploy script parses, and the repository test suite runs.
- The missing CloudFormation templates and pricing manifest referenced by the code/tests are now
  present. The deployment script now rebuilds `controller_lambda.zip` from the current controller
  and worker template instead of deploying a stale artifact.
- Input validation now rejects text, zero, negative, NaN, and infinite project budgets with a
  controlled HTTP 400 response.
- `Test.zip` has no archive corruption, but it is an older v0.2 package and must not be treated as
  the current v0.3 release artifact.

## XPlace simulation

The public XPlace pages `/dev/jobs`, `/web/jobs`, and `/tech/jobs` were fetched while respecting
public access. On this unauthenticated session they rendered **0 projects**, so selecting or
bulk-processing actual customer listings requires an XPlace account/API permission and compliance
with XPlace terms. A multi-day crawl was not started: the site asks crawlers to delay requests,
and this project has neither a crawler, an ingestion connector, nor authorization to process the
site in bulk.

For a safe smoke test, the sample requirement publicly shown by XPlace's project form was used:
prepare an approximately 20-screen investor presentation for a cybersecurity startup, using
existing branding and a stated deadline. The controller's `/runs/plan` behavior was simulated.
It accepts the text only when the controller is ENABLED and returns metadata with
`execution_mode=PLAN_ONLY`, `worker_count=1`, `worker_launch=false`, sandbox required, and network
off. It does **not** generate stages, a proposal, files, estimates, or a completed presentation.
The apply path cannot be executed here because no deployed API, session token, AWS CLI, or AWS
credentials are available.

## Blocking gaps before clients can use it

### Product execution

1. Implement a real task engine and worker agent. The EC2 worker has no user data/bootstrap,
   instance role, queue, task payload, software runtime, output upload, or completion callback.
2. Add a durable task/run state machine, retries, idempotency keys, cancellation, timeouts,
   concurrency limits, and recovery from Lambda/CloudFormation partial failures.
3. Add artifact upload/download, malware scanning, per-project encrypted object storage,
   versioning, retention/deletion, and deliverable reporting.
4. Add quality gates, deterministic tests, independent verification, and human escalation.
5. Replace UI demo data with backend state; most visible stages, agents, costs, logs, sandbox
   controls, billing, and security events are simulations.

### Identity, security, and tenancy

1. Replace the shared TEST Architect secret with real client and administrator identities,
   authorization, session expiry/revocation, MFA/WebAuthn, and tenant isolation.
2. Put authorization at API Gateway and enforce role/project ownership on every object.
3. Add WAF/rate limits, abuse controls, request-size limits, audit-log storage, alerting, secret
   rotation, key management, security headers/CSP, and an incident-response process.
4. Harden worker isolation. A security group without ingress is not a complete untrusted-code
   sandbox; add an appropriate microVM/container boundary, resource quotas, immutable images,
   egress enforcement, teardown guarantees, and escape testing.
5. Perform threat modeling, dependency/SBOM and secret scanning, SAST/DAST, penetration testing,
   privacy review, and legal/acceptable-use review before handling real customer data.

### AWS and operations

1. **An AWS account is required for the next real integration test**, but no keys should be sent
   in chat. Use a dedicated non-production AWS account, IAM Identity Center/CloudShell, budgets,
   billing alarms, service quotas, and a least-privilege deployment role.
2. Install/configure AWS CLI and SAM/CloudFormation validation tooling, deploy in TEST, retrieve
   the temporary secret directly in AWS, then test create/status/terminate while watching billing.
3. Add CI/CD environments, signed immutable release artifacts, rollback, backups/restore tests,
   metrics/traces/alarms, runbooks, SLOs, support workflow, and disaster-recovery exercises.
4. Replace static prices with authoritative live regional pricing and implement reservation,
   metering, hard budget enforcement, taxes/currency, invoicing/refunds, and reconciliation.
5. The TEST controller now assigns every project a 1–24 hour TTL (six hours by default) and runs
   cleanup every 15 minutes. Before external use, add alarms and a second reconciliation path so a
   disabled or failed scheduler cannot leave billable resources behind.

### XPlace integration

1. Obtain explicit XPlace access/permission and confirm its terms before crawling or automating.
2. Prefer an official API/export/webhook; implement pagination, rate limiting, deduplication,
   deletion handling, provenance, language normalization, and personal-data minimization.
3. Build an admissibility classifier and require review before accepting work or submitting any
   proposal. Never submit bids or contact customers automatically in the initial release.

## Minimum next end-to-end acceptance test

1. Deploy into a budget-capped AWS sandbox account.
2. Authenticate as a real test client and submit one authorized synthetic requirement.
3. Confirm a unique tenant/project record, a bounded worker launch, no forbidden egress, and task
   receipt without credentials in logs.
4. Produce an artifact, scan it, verify it, and return it only to that client.
5. Cancel and terminate the project; prove the instance and storage are removed and reconcile cost.
6. Repeat failure injection for duplicate Apply, malformed budget, worker crash, timeout,
   CloudFormation failure, controller restart, and expired/revoked sessions.
7. Only after these pass, run a small, explicitly authorized XPlace pilot—not a whole-site crawl.

## Current AWS start verdict

Registering a dedicated AWS account is appropriate **only for a controlled TEST deployment now**.
Do not connect client traffic, accept real customer files, or promise production work yet. Use a
separate sandbox account with MFA/IAM Identity Center, a strict monthly budget and billing alarms,
then deploy the Controller and exercise health, authenticated pricing estimate, plan, apply, status,
TTL cleanup, and manual terminate with synthetic data. A public production launch remains NO-GO
until the product execution, identity/tenancy, artifact handling, isolation, metering, monitoring,
and incident-response blockers above are implemented and independently tested.
