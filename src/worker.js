import baseWorker from "./index.js";
import { json } from "./telemetry/common.js";
import { isTelemetryPath, handleTelemetryRequest } from "./telemetry/router.js";
import { ensureTelemetryStorage } from "./telemetry/schema.js";
import { ensureDeploymentStorage, handleDeploymentRequest, isDeploymentPath } from "./deployment.js";
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isTelemetryPath(url.pathname)) {
      return handleTelemetryRequest(request, env, url);
    }

    if (isPresencePath(url.pathname)) {
      return handlePresenceRequest(request, env);
    }

    if (isDeploymentPath(url.pathname)) {
      return handleDeploymentRequest(request, env, url);
    }

    if (url.pathname === "/api/health") {
      const engineeringExperience = validateEngineeringExperience();
      const [telemetryStorage, presenceStorage, deploymentStorage] = await Promise.all([
        ensureTelemetryStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensurePresenceStorage(env)
          .then(() => "ready")
          .catch(() => "unavailable"),
        ensureDeploymentStorage(env)
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
      body.deployment_storage = deploymentStorage;
      body.engineering_experience = engineeringExperience.ok ? "ready" : "invalid";
      body.engineering_experience_version = ENGINEERING_EXPERIENCE_VERSION;
      body.ok = Boolean(body.ok) &&
        telemetryStorage === "ready" &&
        presenceStorage === "ready" &&
        deploymentStorage === "ready" &&
        engineeringExperience.ok;
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
