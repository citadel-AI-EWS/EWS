Daily D1 housekeeping runs at 02:23 UTC through the Worker's Cron Trigger.
It deletes request nonces older than the existing ten-minute retention window
and log rate-limit windows older than the existing one-day lifetime. Each rule
removes at most 1,000 rows per run. A full batch is reported in structured Worker
logs so a backlog can be investigated without an unlimited delete consuming
the daily write allowance. Missing optional tables are reported; quota and other
database failures fail the scheduled invocation.

The five-minute Guardian and hourly seven-day telemetry retention remain in
place. Daily housekeeping does not delete projects, reports, session snapshots,
commands, results, audit events or Guardian action history.

Deployment adds the trigger through the existing TEST deployment workflow;
this source change alone does not clean the remote database. Verify the first
scheduled run in Worker logs, its deletion totals and any batch-limit flags.
Cloudflare Analytics is authoritative for account read/write usage. The public
status endpoint currently does not measure database storage, and unavailable
analytics must not be interpreted as zero usage or healthy capacity.
