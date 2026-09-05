# EWS TEST operations and delivery gates

This schedule is for a private, budget-capped AWS TEST environment. It is not authorization to
serve customers or process real customer data.

## Segment 1 — repository and CI (complete)

Canonical sources live in Git; generated ZIP bundles do not. Pull requests and pushes run Python,
JavaScript, shell, CloudFormation, package-integrity, and security checks. Dependabot and the full
validation job run weekly. Required gate: `scripts/validate.sh` passes from a clean checkout.

## Segment 2 — protected site delivery (ready; credentials required)

The Cloudflare bundle, security headers, Wrangler dry-run, and protected GitHub deployment workflow
are implemented. One-time GitHub environment secrets are required because account permission cannot
be manufactured by source code. Required gate: deployment reports success and the live response is
the Architect-only v15 page rather than the old mixed-role v14 page.

## Segment 3 — AWS account foundation (operator action)

Create a dedicated non-production AWS account, enable root MFA and IAM Identity Center, configure a
small monthly AWS Budget plus billing alerts, and avoid long-lived access keys. Record account,
region, owners, cost limit, and emergency contact outside the repository. Required gate: billing
alerts are tested and the deployer has only the permissions required by the template.

## Segment 4 — Controller deployment (ready for TEST)

Run `controller_deploy.sh` from an authenticated AWS CloudShell/session. It creates the isolated TEST
network, DynamoDB state table, temporary Architect secret, API, Lambda Controller, execution role,
and scheduled cleanup. Required gate: CloudFormation completes and `/health` reports v0.3.

## Segment 5 — private integration test (requires AWS)

Use only synthetic data. Verify health, authentication failures, Controller start/stop, STS identity,
pricing estimate, plan-only mode, Apply, project status, manual terminate, and automatic TTL cleanup.
Watch CloudWatch and billing during the entire run. Required gate: no orphan stack/instance remains
and actual charges reconcile with the recorded test.

## Segment 6 — execution product (not implemented; release blocker)

Implement a durable queue/state machine, a real isolated worker runtime, task delivery, artifacts,
malware scanning, verification, retry/cancel/idempotency, and completion callbacks. Required gate:
an authorized synthetic task produces a scanned artifact and survives injected worker/controller
failures without cross-project access or leaked credentials.

## Segment 7 — identity, tenancy, and data protection (not implemented; release blocker)

Replace the shared TEST token with managed identities and MFA, enforce project ownership at the API,
add encrypted tenant storage, retention/deletion, audit trails, WAF/rate limits, and incident alerts.
Required gate: independent security review and tenant-isolation tests pass.

## Segment 8 — metering and commercial readiness (not implemented; release blocker)

Use live AWS pricing, durable usage metering, hard spend caps, invoices/refunds, tax/currency policy,
support processes, SLOs, backups, recovery exercises, legal terms, and privacy review. Required gate:
finance, security, legal, and operations owners sign off.

## Decision

The site and Controller may be deployed now only for Segments 2–5 in a private TEST environment.
Production/customer launch remains blocked until Segments 6–8 pass. Pressure or a successful UI demo
does not replace these gates.
