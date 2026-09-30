import baseWorker, { expireStaleCommands, recoverStaleProjectAssignments } from "./index.js";
import { runD1Guardian } from "./d1-guardian.js";
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
          recoverStaleProjectAssignments
        });
      } catch (error) {
        console.error("D1 Guardian scheduled maintenance failed", error);
      }
    }
    if (controller?.cron === "17 * * * *") {
      await pruneExpiredTelemetry(env);
    }
  }};
