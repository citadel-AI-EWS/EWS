import baseWorker from "./index.js";
import { json } from "./telemetry/common.js";
import { isTelemetryPath, handleTelemetryRequest } from "./telemetry/router.js";
import { ensureTelemetryStorage } from "./telemetry/schema.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isTelemetryPath(url.pathname)) {
      return handleTelemetryRequest(request, env, url);
    }

    if (url.pathname === "/api/health") {
      const telemetryStorage = await ensureTelemetryStorage(env)
        .then(() => "ready")
        .catch(() => "unavailable");
      const response = await baseWorker.fetch(request, env);
      let body;
      try {
        body = await response.json();
      } catch {
        return response;
      }
      body.telemetry_storage = telemetryStorage;
      body.ok = Boolean(body.ok) && telemetryStorage === "ready";
      return json(body, response.status);
    }

    return baseWorker.fetch(request, env);
  }
};
