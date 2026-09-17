import baseWorker from "./index.js";
import { json } from "./telemetry/common.js";
import { isTelemetryPath, handleTelemetryRequest } from "./telemetry/router.js";
import { ensureTelemetryStorage } from "./telemetry/schema.js";
import {
  ensurePresenceStorage,
  handlePresenceRequest,
  isPresencePath,
  recordNodePresence
} from "./presence.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isTelemetryPath(url.pathname)) {
      return handleTelemetryRequest(request, env, url);
    }

    if (isPresencePath(url.pathname)) {
      return handlePresenceRequest(request, env);
    }

    if (url.pathname === "/api/health") {
      const [telemetryStorage, presenceStorage] = await Promise.all([
        ensureTelemetryStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensurePresenceStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable")
      ]);
      const response = await baseWorker.fetch(request, env);
      let body;
      try {
        body = await response.json();
      } catch {
        return response;
      }
      body.telemetry_storage = telemetryStorage;
      body.presence_storage = presenceStorage;
      body.ok = Boolean(body.ok) &&
        telemetryStorage === "ready" &&
        presenceStorage === "ready";
      return json(body, response.status);
    }

    const response = await baseWorker.fetch(request, env);
    const heartbeatMatch = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/heartbeat$/);
    if (request.method === "POST" && heartbeatMatch && response.ok) {
      const nodeId = decodeURIComponent(heartbeatMatch[1]);
      try {
        await recordNodePresence(request, env, nodeId);
      } catch (error) {
        console.error("Failed to record node presence", error);
      }
    }
    return response;
  }
};
