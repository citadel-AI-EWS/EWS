import baseWorker, { expireStaleCommands, recoverStaleProjectAssignments } from "./index.js";
import { runD1Guardian } from "./d1-guardian.js";
import { pruneExpiredD1Bookkeeping } from "./d1-retention.js";
import { json } from "./telemetry/common.js";
import { isTelemetryPath, handleTelemetryRequest } from "./telemetry/router.js";
import { ensureTelemetryStorage, pruneExpiredTelemetry } from "./telemetry/schema.js";
import {
  ENGINEERING_EXPERIENCE_VERSION,
  validateEngineeringExperience
} from "./experience/policy.js";
import {
  ensurePresenceStorage,
  handlePresenceRequest,
  isPresencePath,
  recordNodePresence
} from "./presence.js";

export default {
  async scheduled(_controller, env) {
    const controller = _controller;
    if (controller?.cron === "*/5 * * * *") {
      try {
        await runD1Guardian(env, {
          expireStaleCommands,
          recoverStaleProjectAssignments,
          pruneExpiredD1Bookkeeping
        });
      } catch (error) {
        console.error("D1 Guardian scheduled maintenance failed", error);
      }
    }
    if (controller?.cron === "17 * * * *") {
      await pruneExpiredTelemetry(env);
    }
  },

  async fetch(request, env, executionCtx) {
    const url = new URL(request.url);
    if (isTelemetryPath(url.pathname)) {
      return handleTelemetryRequest(request, env, url);
    }

    if (isPresencePath(url.pathname)) {
      return handlePresenceRequest(request, env);
    }

    if (url.pathname === "/api/health") {
      const engineeringExperience = validateEngineeringExperience();
      const [telemetryStorage, presenceStorage] = await Promise.all([
        ensureTelemetryStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensurePresenceStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable")
      ]);
      const response = await baseWorker.fetch(request, env, executionCtx);
      let body;
      try {
        body = await response.json();
      } catch {
        return response;
      }
      body.telemetry_storage = telemetryStorage;
      body.presence_storage = presenceStorage;
      body.engineering_experience = engineeringExperience.ok ? "ready" : "invalid";
      body.engineering_experience_version = ENGINEERING_EXPERIENCE_VERSION;
      body.ok = Boolean(body.ok) &&
        telemetryStorage === "ready" &&
        presenceStorage === "ready" &&
        engineeringExperience.ok;
      return json(body, response.status);
    }

    const response = await baseWorker.fetch(request, env, executionCtx);
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
