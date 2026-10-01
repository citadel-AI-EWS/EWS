Daily D1 housekeeping runs once per UTC day through the five-minute Guardian.
The first tick after deployment performs the initial cleanup. A durable success
marker prevents repeat deletion on later ticks that day; failed runs may retry.
It deletes request nonces older than the existing ten-minute retention window
and log rate-limit windows older than the existing one-day lifetime. Each rule
removes at most 1,000 rows per run. A full batch is reported in structured Worker
logs so a backlog can be investigated without an unlimited delete consuming
the daily write allowance. Missing optional tables are reported; quota and other
database failures fail the scheduled invocation.

The five-minute Guardian and hourly seven-day telemetry retention remain in
place. Daily housekeeping does not delete projects, reports, session snapshots,
commands, results, audit events or Guardian action history.

Deployment uses the existing TEST deployment workflow;
this source change alone does not clean the remote database. Verify the first
scheduled run via `/api/v1/status/d1-retention` or Worker logs, its deletion
totals and any batch-limit flags. The public endpoint exposes aggregate
maintenance counters only, without record identifiers or action details.
Cloudflare Analytics is authoritative for account read/write usage. The public
status endpoint currently does not measure database storage, and unavailable
analytics must not be interpreted as zero usage or healthy capacity.

The `D1 Capacity Check` workflow runs daily at 06:37 UTC and supports manual
dispatch. It reads account-wide daily rows-read/rows-written and this database's
maximum observed storage today from Cloudflare GraphQL Analytics using the
existing Analytics credential, without requiring D1 administration permission. It publishes
numeric results, cleanup counters and safe availability reasons in a GitHub
check named `D1 capacity diagnostics`. Missing API permissions are reported as
incomplete diagnostics. The workflow performs no database writes or deletion.
Usage at 80% or above, an unverified cleanup in 26 hours, and a full cleanup
batch are flagged for review.
