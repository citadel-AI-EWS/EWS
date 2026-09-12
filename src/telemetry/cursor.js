import { TelemetryError, requireString } from "./common.js";

export function encodeCursor(row) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([row.created_at, row.event_id])
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeCursor(value) {
  if (!value) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TelemetryError(400, "invalid_cursor");
  }
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0)
    );
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2) {
      throw new Error("bad_cursor");
    }
    return [
      requireString(parsed[0], "cursor_created_at", 64),
      requireString(parsed[1], "cursor_event_id", 128)
    ];
  } catch (error) {
    if (error instanceof TelemetryError) throw error;
    throw new TelemetryError(400, "invalid_cursor");
  }
}
