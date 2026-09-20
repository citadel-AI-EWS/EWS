export const ARCHITECT_ROLE_PERMISSIONS = Object.freeze({
  owner: Object.freeze(["read", "operate", "admin"]),
  operator: Object.freeze(["read", "operate"]),
  viewer: Object.freeze(["read"])
});

export const DEFAULT_ENTERPRISE_POLICY = Object.freeze({
  require_latest_agent: true,
  require_windows_core_service: true,
  require_windows_enterprise_probe: true,
  max_cpu_percent: 90,
  max_memory_percent: 90,
  max_event_errors_last_hour: 25,
  require_windows_update_service: true,
  require_no_pending_reboot: false
});

function boundedPercent(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 && numeric <= 100
    ? numeric
    : fallback;
}

function boundedCount(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 10000
    ? numeric
    : fallback;
}

export function normalizeEnterprisePolicy(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    require_latest_agent: source.require_latest_agent === undefined
      ? DEFAULT_ENTERPRISE_POLICY.require_latest_agent
      : source.require_latest_agent === true,
    require_windows_core_service: source.require_windows_core_service === undefined
      ? DEFAULT_ENTERPRISE_POLICY.require_windows_core_service
      : source.require_windows_core_service === true,
    require_windows_enterprise_probe: source.require_windows_enterprise_probe === undefined
      ? DEFAULT_ENTERPRISE_POLICY.require_windows_enterprise_probe
      : source.require_windows_enterprise_probe === true,
    max_cpu_percent: boundedPercent(
      source.max_cpu_percent,
      DEFAULT_ENTERPRISE_POLICY.max_cpu_percent
    ),
    max_memory_percent: boundedPercent(
      source.max_memory_percent,
      DEFAULT_ENTERPRISE_POLICY.max_memory_percent
    ),
    max_event_errors_last_hour: boundedCount(
      source.max_event_errors_last_hour,
      DEFAULT_ENTERPRISE_POLICY.max_event_errors_last_hour
    ),
    require_windows_update_service: source.require_windows_update_service === undefined
      ? DEFAULT_ENTERPRISE_POLICY.require_windows_update_service
      : source.require_windows_update_service === true,
    require_no_pending_reboot: source.require_no_pending_reboot === true
  };
}

export function roleHasPermission(role, permission) {
  return (ARCHITECT_ROLE_PERMISSIONS[role] || []).includes(permission);
}

export function requiredArchitectPermission(method, pathname) {
  const upper = String(method || "GET").toUpperCase();
  const path = String(pathname || "");

  if (
    path.startsWith("/api/v1/architect/security/access-tokens") ||
    path === "/api/v1/architect/enterprise/recovery-manifest"
  ) {
    return "admin";
  }
  if (upper === "GET" || upper === "HEAD") return "read";
  if (
    path.startsWith("/api/v1/architect/security/") ||
    path === "/api/v1/architect/update-all" ||
    path.startsWith("/api/v1/architect/enterprise/")
  ) {
    return "admin";
  }
  return "operate";
}

function pushCheck(checks, key, ok, detail) {
  checks.push({ key, ok: Boolean(ok), detail: String(detail || "") });
}

export function evaluateEnterpriseNode(node, inventory, policyInput, latestVersion) {
  const policy = normalizeEnterprisePolicy(policyInput);
  const checks = [];
  const isWindows = String(node?.os_name || "").toLowerCase() === "windows";
  const enterprise = inventory?.windows_enterprise &&
    typeof inventory.windows_enterprise === "object"
    ? inventory.windows_enterprise
    : null;

  if (policy.require_latest_agent) {
    pushCheck(
      checks,
      "latest_agent",
      Boolean(latestVersion) && node?.agent_version === latestVersion,
      `agent ${node?.agent_version || "unknown"} / desired ${latestVersion || "unknown"}`
    );
  }

  if (node?.cpu_percent != null) {
    pushCheck(
      checks,
      "cpu",
      Number(node.cpu_percent) <= policy.max_cpu_percent,
      `${Number(node.cpu_percent).toFixed(1)}% <= ${policy.max_cpu_percent}%`
    );
  }

  if (node?.memory_percent != null) {
    pushCheck(
      checks,
      "memory",
      Number(node.memory_percent) <= policy.max_memory_percent,
      `${Number(node.memory_percent).toFixed(1)}% <= ${policy.max_memory_percent}%`
    );
  }

  if (isWindows) {
    if (policy.require_windows_core_service) {
      pushCheck(
        checks,
        "windows_core_service",
        inventory?.windows_core_service === true,
        inventory?.windows_core_service === true
          ? "SCM-managed Core Service reported"
          : "SCM-managed Core Service not confirmed"
      );
    }

    if (policy.require_windows_enterprise_probe) {
      pushCheck(
        checks,
        "windows_enterprise_probe",
        enterprise?.available === true && enterprise?.readonly === true,
        enterprise?.available === true
          ? "read-only Microsoft/Windows probe available"
          : "enterprise probe not yet confirmed"
      );
    }

    if (enterprise?.available === true) {
      const eventCount =
        Number(enterprise?.event_log?.system?.critical_or_error_last_hour || 0) +
        Number(enterprise?.event_log?.application?.critical_or_error_last_hour || 0);
      pushCheck(
        checks,
        "event_log",
        eventCount <= policy.max_event_errors_last_hour,
        `${eventCount} critical/error events in last hour <= ${policy.max_event_errors_last_hour}`
      );

      if (policy.require_windows_update_service) {
        const status = String(enterprise?.windows_update?.service_status || "").toLowerCase();
        pushCheck(
          checks,
          "windows_update_service",
          status === "running",
          status || "unknown"
        );
      }

      if (policy.require_no_pending_reboot) {
        pushCheck(
          checks,
          "pending_reboot",
          enterprise?.windows_update?.pending_reboot !== true,
          enterprise?.windows_update?.pending_reboot === true
            ? "reboot pending"
            : "no pending reboot detected"
        );
      }
    }
  }

  const failed = checks.filter((check) => !check.ok);
  return {
    compliant: failed.length === 0,
    failed_count: failed.length,
    checks,
    windows_enterprise: enterprise,
    policy
  };
}
