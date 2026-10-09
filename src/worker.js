import baseWorker, { expireStaleCommands, recoverStaleProjectAssignments } from "./index.js";
import {withD1Availability, addD1RetryHint} from './d1-availability.js';
export {NodeSshRelay} from './ssh/relay.js';
import { runD1Guardian } from "./d1-guardian.js";
import {nodeReportsEnabled, enqueueControllerReport, drainNodeReports} from "./node-reports.js";
import { pruneExpiredD1Bookkeeping } from "./d1-retention.js";
import { json, pruneNodeRequestNonces } from "./telemetry/common.js";
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

const worker = {
  async scheduled(_controller, env) {
    const controller = _controller;
    if (controller?.cron === "*/5 * * * *") {
      const reporting = await nodeReportsEnabled(env);
      try {
        await runD1Guardian(env, {
          expireStaleCommands,
          recoverStaleProjectAssignments,
          pruneExpiredD1Bookkeeping,
          onNodesOffline: reporting ? async nodes => {
            for (const node of nodes) {
              await enqueueControllerReport(env, node.node_id, "node_disconnected",
                {reason: "heartbeat_stale", last_seen_at: node.last_seen_at}, undefined, node.hostname);
            }
          } : undefined
        });
      } catch (error) {
        console.error("D1 Guardian scheduled maintenance failed", error);
      }
      if (reporting) {
        try {
          console.log("node_report_delivery", JSON.stringify(await drainNodeReports(env)));
        } catch {console.error("node_report_delivery_unavailable");}
      }
    }
    if (controller?.cron === "17 * * * *") {
      await Promise.all([pruneExpiredTelemetry(env), pruneNodeRequestNonces(env)]);
    }
  },

  async fetch(request, env, executionCtx) {
    // This internal callback cannot be provided by the HTTP client.
    if (await nodeReportsEnabled(env)) {
      const original = env;
      env = {...env, __CITADEL_REPORT_EVENT: (nodeId, eventType, details, createdAt) =>
        enqueueControllerReport(original, nodeId, eventType, details, createdAt)};
    }
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
      body.node_reports_archive = await nodeReportsEnabled(env) ? "enabled" : "awaiting_write_test";
      body.engineering_experience = engineeringExperience.ok ? "ready" : "invalid";
      body.engineering_experience_version = ENGINEERING_EXPERIENCE_VERSION;
      body.ok = Boolean(body.ok) &&
        telemetryStorage === "ready" &&
        presenceStorage === "ready" &&
        engineeringExperience.ok;
      return json(body, response.status);
    }

    const response = await baseWorker.fetch(request, env, executionCtx);
    const heartbeatMatch = url.pathname.match(/^\/api\/v1\/nodes\/([^/]+)\/(?:heartbeat|sync)$/);
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

export default {
  scheduled(controller, env) {
    return worker.scheduled(controller, withD1Availability(env));
  },
  async fetch(request, env, executionCtx) {
    const guarded = withD1Availability(env);
    return addD1RetryHint(await worker.fetch(request, guarded, executionCtx), guarded);
  }
};
