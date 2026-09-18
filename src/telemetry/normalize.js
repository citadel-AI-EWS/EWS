import {
  TELEMETRY_LIMITS,
  TelemetryError,
  optionalString,
  requireString,
  sanitizeTelemetryValue,
  utf8Bytes
} from "./common.js";

const ALLOWED_LEVELS = new Set(["debug", "info", "warn", "error"]);
export const ALLOWED_EVENT_TYPES = new Set([
  "agent_start",
  "agent_stop",
  "node_enrolled",
  "windows_sleep_inhibit",
  "cycle_error",
  "resource_guard",
  "assignment_rejected_local",
  "result_submitted",
  "result_queued",
  "queued_results_flushed",
  "command_signature_rejected",
  "command_completed",
  "agent_updated",
  "agent_update_rolled_back",
  "agent_update_healthcheck_passed",
  "agent_update_manual_rollback",
  "agent_restart_requested",
  "agent_stop_requested",
  "system_reboot_scheduled",
  "system_shutdown_scheduled",
  "wake_packet_sent",
  "lmstudio_installed",
  "lmstudio_model_downloaded",
  "lmstudio_model_loaded",
  "command_failure_ack_failed",
  "command_failed"
]);

export function normalizeTelemetryEvent(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TelemetryError(400, "invalid_event");
  }
  const eventId = requireString(raw.event_id, "event_id", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(eventId)) {
    throw new TelemetryError(400, "invalid_event_id");
  }
  const level = requireString(raw.level ?? "info", "level", 16).toLowerCase();
  if (!ALLOWED_LEVELS.has(level)) {
    throw new TelemetryError(400, "invalid_level");
  }
  const eventType = requireString(raw.event_type ?? raw.event, "event_type", 80).toLowerCase();
  if (!ALLOWED_EVENT_TYPES.has(eventType)) {
    throw new TelemetryError(400, "event_type_not_allowed");
  }
  const createdAt = requireString(raw.created_at ?? raw.ts, "created_at", 64);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new TelemetryError(400, "invalid_created_at");
  }
  const messageValue = optionalString(raw.message, "message", 1024) || eventType;
  const sanitizedMessage = sanitizeTelemetryValue(messageValue);
  const message = typeof sanitizedMessage === "string" ? sanitizedMessage : eventType;

  let details = sanitizeTelemetryValue(raw.details ?? {});
  let detailsJson = JSON.stringify(details);
  if (utf8Bytes(detailsJson) > 1400) {
    details = { truncated: true, reason: "details_too_large" };
    detailsJson = JSON.stringify(details);
  }
  const normalized = {
    event_id: eventId,
    level,
    event_type: eventType,
    message,
    details,
    created_at: createdAt
  };
  if (utf8Bytes(JSON.stringify(normalized)) > TELEMETRY_LIMITS.event_bytes) {
    throw new TelemetryError(413, "event_too_large");
  }
  return { ...normalized, details_json: detailsJson };
}

export function validLogLevel(value) {
  return !value || ALLOWED_LEVELS.has(value);
}
