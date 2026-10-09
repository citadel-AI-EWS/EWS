// Fixed categories only: relay exceptions may contain URLs or request headers.
const HINT_WORDS = Object.freeze([
  "account", "daily", "limit", "limits", "quota", "exceeded", "exceed", "requests", "request",
  "operations", "operation", "units", "duration", "compute", "storage", "sqlite", "d1", "rows",
  "read", "reads", "written", "write", "writes", "durable", "object", "objects", "namespace",
  "binding", "class", "enabled", "disabled", "missing", "not", "found", "invalid", "unavailable",
  "reset", "aborted", "overloaded", "timeout", "transaction", "unauthorized", "forbidden", "permission"
]);
export const REPLAY_HINT_CODES = Object.freeze([
  ...HINT_WORDS.map(word => "replay_hint_" + word),
  "replay_kind_type_error", "replay_kind_range_error", "replay_flag_overloaded", "replay_flag_retryable"
]);

export function replayFailureHints(error) {
  const words = new Set(String(error?.message || error || "").slice(0, 8192).toLowerCase().match(/[a-z]+/g) || []);
  const hints = HINT_WORDS.filter(word => words.has(word)).map(word => "replay_hint_" + word);
  if (error?.name === "TypeError") hints.push("replay_kind_type_error");
  if (error?.name === "RangeError") hints.push("replay_kind_range_error");
  if (error?.overloaded === true) hints.push("replay_flag_overloaded");
  if (error?.retryable === true) hints.push("replay_flag_retryable");
  return hints;
}

export function replayFailureCode(error) {
  const message = String(error?.message || error || "");
  if (/D1.*daily.*read|daily row read limit/i.test(message)) return "replay_d1_daily_read_limit";
  if (/D1.*daily.*writ|daily row write limit/i.test(message)) return "replay_d1_daily_write_limit";
  if (/daily.*(?:written|write).*row|daily.*row.*(?:written|write)/i.test(message)) return "replay_storage_daily_write_limit";
  if (/daily.*(?:read).*row|daily.*row.*read/i.test(message)) return "replay_storage_daily_read_limit";
  if (/SQLITE_FULL|(?:SQLite|storage).*(?:exceed|quota|limit)/i.test(message)) return "replay_storage_sqlite_limit";
  if (/(?:limit|quota|exceed)/i.test(message) && /durable|free tier|request units/i.test(message)) {
    if (/duration|compute|GB.s/i.test(message)) return "replay_durable_duration_limit";
    if (/request|operation|invocation/i.test(message)) return "replay_durable_request_limit";
  }
  if (/no such (?:table|column)/i.test(message)) return "replay_database_schema_missing";
  if (/(?:database|storage|durable).*(?:overloaded|too many requests)/i.test(message)) return "replay_storage_overloaded";
  const hints = replayFailureHints(error);
  if (hints.length) console.warn("node_replay_failure_hints", hints);
  return "replay_transport_unavailable";
}
