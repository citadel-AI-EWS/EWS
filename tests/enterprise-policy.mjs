import assert from "node:assert/strict";
import {
  DEFAULT_ENTERPRISE_POLICY,
  evaluateEnterpriseNode,
  normalizeEnterprisePolicy,
  requiredArchitectPermission,
  roleHasPermission
} from "../src/enterprise/policy.js";

assert.equal(roleHasPermission("owner", "admin"), true);
assert.equal(roleHasPermission("operator", "operate"), true);
assert.equal(roleHasPermission("operator", "admin"), false);
assert.equal(roleHasPermission("viewer", "read"), true);
assert.equal(roleHasPermission("viewer", "operate"), false);

assert.equal(requiredArchitectPermission("GET", "/api/v1/architect/overview"), "read");
assert.equal(requiredArchitectPermission("POST", "/api/v1/architect/projects"), "operate");
assert.equal(requiredArchitectPermission("POST", "/api/v1/architect/enterprise/policy"), "admin");
assert.equal(requiredArchitectPermission("GET", "/api/v1/architect/security/access-tokens"), "admin");
assert.equal(requiredArchitectPermission("GET", "/api/v1/architect/enterprise/recovery-manifest"), "admin");

const normalized = normalizeEnterprisePolicy({
  max_cpu_percent: 77,
  max_memory_percent: 81,
  max_event_errors_last_hour: 4,
  require_no_pending_reboot: true
});
assert.equal(normalized.max_cpu_percent, 77);
assert.equal(normalized.max_memory_percent, 81);
assert.equal(normalized.max_event_errors_last_hour, 4);
assert.equal(normalized.require_no_pending_reboot, true);
assert.equal(normalizeEnterprisePolicy({ max_cpu_percent: 999 }).max_cpu_percent, DEFAULT_ENTERPRISE_POLICY.max_cpu_percent);

const healthyWindowsInventory = {
  windows_core_service: true,
  windows_enterprise: {
    available: true,
    readonly: true,
    event_log: {
      system: { critical_or_error_last_hour: 1 },
      application: { critical_or_error_last_hour: 1 }
    },
    windows_update: {
      service_status: "Running",
      pending_reboot: false
    }
  }
};
const healthyNode = {
  os_name: "Windows",
  agent_version: "0.3.13",
  cpu_percent: 21,
  memory_percent: 44
};
const healthy = evaluateEnterpriseNode(
  healthyNode,
  healthyWindowsInventory,
  { ...DEFAULT_ENTERPRISE_POLICY, require_no_pending_reboot: true },
  "0.3.13"
);
assert.equal(healthy.compliant, true);
assert.equal(healthy.failed_count, 0);

const unhealthy = evaluateEnterpriseNode(
  { ...healthyNode, agent_version: "0.3.12", cpu_percent: 99 },
  {
    windows_core_service: false,
    windows_enterprise: {
      available: true,
      readonly: true,
      event_log: {
        system: { critical_or_error_last_hour: 50 },
        application: { critical_or_error_last_hour: 10 }
      },
      windows_update: {
        service_status: "Stopped",
        pending_reboot: true
      }
    }
  },
  { ...DEFAULT_ENTERPRISE_POLICY, require_no_pending_reboot: true },
  "0.3.13"
);
assert.equal(unhealthy.compliant, false);
assert.ok(unhealthy.failed_count >= 5);
assert.ok(unhealthy.checks.some((check) => check.key === "latest_agent" && !check.ok));
assert.ok(unhealthy.checks.some((check) => check.key === "event_log" && !check.ok));
assert.ok(unhealthy.checks.some((check) => check.key === "pending_reboot" && !check.ok));

console.log("Enterprise policy/RBAC guards: PASS");
