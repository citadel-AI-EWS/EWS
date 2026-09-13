import baseWorker from "./index.js";
import { json } from "./telemetry/common.js";
import { isTelemetryPath, handleTelemetryRequest } from "./telemetry/router.js";
import { ensureTelemetryStorage } from "./telemetry/schema.js";
import {
  handleReportTieringArchitectRequest,
  isReportTieringArchitectPath,
  purgeExpiredReportObjects,
  reportTieringHealth,
  tierResultResponse
} from "./report_tiering.js";

const RESULT_PATH = /^\/api\/v1\/nodes\/[^/]+\/results$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isTelemetryPath(url.pathname)) {
      return handleTelemetryRequest(request, env, url);
    }

    if (isReportTieringArchitectPath(request.method, url.pathname)) {
      return handleReportTieringArchitectRequest(request, env, url);
    }

    if (request.method === "POST" && RESULT_PATH.test(url.pathname)) {
      const response = await baseWorker.fetch(request, env);
      return tierResultResponse(response, env);
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
      const tiering = await reportTieringHealth(env);
      body.telemetry_storage = telemetryStorage;
      body.report_tiering_schema = tiering.schema;
      body.report_storage_provider = tiering.provider;
      body.report_google_drive = tiering.google_drive;
      body.report_r2 = tiering.r2;
      body.ok = Boolean(body.ok) &&
        telemetryStorage === "ready" &&
        tiering.schema === "ready";
      return json(body, response.status);
    }

    return baseWorker.fetch(request, env);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      purgeExpiredReportObjects(env).catch((error) => {
        console.error("Report lifecycle purge failed", error);
      })
    );
  }
};
