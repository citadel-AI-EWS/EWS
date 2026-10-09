// Fixed categories only: relay exceptions may contain URLs or request headers.
export function replayFailureCode(error) {
  const message = String(error?.message || error || "");
  if (/D1.*daily.*read|daily row read limit/i.test(message)) return "replay_d1_daily_read_limit";
  if (/D1.*daily.*writ|daily row write limit/i.test(message)) return "replay_d1_daily_write_limit";
  if (/daily.*(?:written|write).*row|daily.*row.*(?:written|write)/i.test(message)) return "replay_storage_daily_write_limit";
  if (/daily.*(?:read).*row|daily.*row.*read/i.test(message)) return "replay_storage_daily_read_limit";
  if (/SQLITE_FULL|(?:SQLite|storage).*(?:exceed|quota|limit)/i.test(message)) return "replay_storage_sqlite_limit";
  if (/(?:durable|free tier).*(?:request|operation).*limit/i.test(message)) return "replay_durable_request_limit";
  if (/no such (?:table|column)/i.test(message)) return "replay_database_schema_missing";
  if (/(?:database|storage|durable).*(?:overloaded|too many requests)/i.test(message)) return "replay_storage_overloaded";
  return "replay_transport_unavailable";
}
