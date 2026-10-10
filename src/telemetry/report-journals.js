// Provider-neutral report classification. No credentials, network, or database access.
const SESSION_END_TYPES = new Set([
  "agent_stop", "session_finished", "agent_stop_requested", "hybrid_query_completed",
  "command_completed", "command_cancelled",
  "ssh_browser_disconnected", "ssh_agent_disconnected", "ssh_relay_disconnected",
  "node_disconnected"
]);

export function journalEventKind(event) {
  const type = String(event?.event_type || "");
  if (event?.level === "error" ||
      /(?:_failed|_error|_rolled_back|_rejected)$/.test(type)) return "ERROR";
  if (SESSION_END_TYPES.has(type)) return "SESSION_END";
  if (type === "log_interval_snapshot") return "INTERVAL";
  return "LOG";
}

export function splitJournalEvents(events) {
  if (!Array.isArray(events) || !events.length) return [];
  const batches = [];
  let routine = [];
  for (const event of events) {
    if (journalEventKind(event) === "LOG") {
      routine.push(event);
    } else {
      if (routine.length) batches.push(routine);
      routine = [];
      batches.push([event]);
    }
  }
  if (routine.length) batches.push(routine);
  return batches;
}

export function nodeJournalTitle(events) {
  const list = Array.isArray(events) ? events : [];
  if (list.length !== 1) return "Node operational events";
  const event = list[0];
  const category = journalEventKind(event);
  const type = String(event?.event_type || "event").slice(0, 80);
  return category === "ERROR" ? "Ошибка: " + type
    : category === "SESSION_END" ? "Завершение сессии: " + type
    : category === "INTERVAL" ? "30-минутный лог: " + type
    : "Событие: " + type;
}

function safePart(value, max = 85) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, max);
}

export function nodeJournalFileName(report) {
  const created = new Date(report?.created_at || Date.now());
  const stamp = Number.isFinite(created.getTime()) ? created.toISOString()
    .slice(0, 19).replace("T", "_").replace(/:/g, "-") : "unknown-time";
  let events = [];
  try {
    const envelope = JSON.parse(report?.report_json || "{}");
    if (envelope.schema === "citadel-node-report/v1") events = envelope.events || [];
    else if (envelope.schema === "citadel-node-report/v2") {
      events = (envelope.batches || []).flatMap(batch => batch.events || []);
    }
  } catch { /* Only the integrity gate can approve an upload. */ }
  const kind = events.length === 1 ? journalEventKind(events[0]) : "LOG";
  const type = kind === "LOG" ? "node_events" : safePart(events[0]?.event_type, 80);
  const batch = safePart(report?.batch_id, 80);
  return stamp + "__" + kind + "__" + type + "__" + batch + ".json";
}

export const DEDICATED_JOURNAL_SQL = `(
  json_valid(report_json)
  AND json_array_length(json_extract(report_json,'$.events'))=1
  AND (
    json_extract(report_json,'$.events[0].level')='error'
    OR json_extract(report_json,'$.events[0].event_type') IN (
      'agent_stop','session_finished','log_interval_snapshot','agent_stop_requested','hybrid_query_completed',
      'command_completed','command_cancelled','ssh_browser_disconnected',
      'ssh_agent_disconnected','ssh_relay_disconnected','node_disconnected'
    )
    OR json_extract(report_json,'$.events[0].event_type') GLOB '*_failed'
    OR json_extract(report_json,'$.events[0].event_type') GLOB '*_error'
    OR json_extract(report_json,'$.events[0].event_type') GLOB '*_rolled_back'
    OR json_extract(report_json,'$.events[0].event_type') GLOB '*_rejected'
  )
)`;
