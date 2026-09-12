import {
  TelemetryError,
  json,
  methodNotAllowed
} from "./common.js";
import { architectListLogs, architectLogStats } from "./architect.js";
import { ingestNodeLogs } from "./ingest.js";

export function isTelemetryPath(pathname) {
  return pathname === "/api/v1/architect/logs" ||
    pathname === "/api/v1/architect/logs/stats" ||
    /^\/api\/v1\/nodes\/[^/]+\/logs$/.test(pathname);
}

export async function handleTelemetryRequest(request, env, url = new URL(request.url)) {
  try {
    if (url.pathname === "/api/v1/architect/logs") {
      return request.method === "GET"
        ? await architectListLogs(request, env, url)
        : methodNotAllowed(["GET"]);
    }
    if (url.pathname === "/api/v1/architect/logs/stats") {
      return request.method === "GET"
        ? await architectLogStats(request, env)
        : methodNotAllowed(["GET"]);
    }
    const match = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/logs$/);
    if (match) {
      return request.method === "POST"
        ? await ingestNodeLogs(request, env, decodeURIComponent(match[1]), url)
        : methodNotAllowed(["POST"]);
    }
    return null;
  } catch (error) {
    if (error instanceof TelemetryError) {
      return json({ ok: false, error: error.code }, error.status);
    }
    console.error("Unhandled telemetry API error", error);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}
