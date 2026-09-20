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
  max_heartbeat_age_minutes: 5,
  min_disk_free_gb: 5,
  require_lan_address: false,
  require_windows_update_service: true,
  require_no_pending_reboot: false,
  require_domain_join: false,
  require_group_policy_service: false,
  require_intune_extension: false,
  require_hyperv: false,
  require_managed_service_account: false
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

function boundedNumber(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= min && numeric <= max
    ? numeric
    : fallback;
}

function parseControllerTimestamp(value) {
  if (!value) return null;
  const raw = String(value);
  const normalized = /[zZ]|[+-]\d\d:?\d\d$/.test(raw)
    ? raw
    : raw.replace(" ", "T") + "Z";
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
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
    max_heartbeat_age_minutes: boundedNumber(
      source.max_heartbeat_age_minutes,
      DEFAULT_ENTERPRISE_POLICY.max_heartbeat_age_minutes,
      1,
      1440
    ),
    min_disk_free_gb: boundedNumber(
      source.min_disk_free_gb,
      DEFAULT_ENTERPRISE_POLICY.min_disk_free_gb,
      0,
      1048576
    ),
    require_lan_address: source.require_lan_address === true,
    require_windows_update_service: source.require_windows_update_service === undefined
      ? DEFAULT_ENTERPRISE_POLICY.require_windows_update_service
      : source.require_windows_update_service === true,
    require_no_pending_reboot: source.require_no_pending_reboot === true,
    require_domain_join: source.require_domain_join === true,
    require_group_policy_service: source.require_group_policy_service === true,
    require_intune_extension: source.require_intune_extension === true,
    require_hyperv: source.require_hyperv === true,
    require_managed_service_account: source.require_managed_service_account === true
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

  const lastSeen = parseControllerTimestamp(node?.last_seen_at);
  const ageMinutes = lastSeen === null ? Infinity : Math.max(0, (Date.now() - lastSeen) / 60000);
  pushCheck(
    checks,
    "heartbeat",
    ageMinutes <= policy.max_heartbeat_age_minutes,
    Number.isFinite(ageMinutes)
      ? `${ageMinutes.toFixed(1)} min <= ${policy.max_heartbeat_age_minutes} min`
      : "heartbeat timestamp unavailable"
  );

  const diskFreeBytes = Number(inventory?.disk_home_free_bytes);
  const diskFreeGb = Number.isFinite(diskFreeBytes) ? diskFreeBytes / 1073741824 : null;
  pushCheck(
    checks,
    "disk_free",
    diskFreeGb !== null && diskFreeGb >= policy.min_disk_free_gb,
    diskFreeGb === null
      ? "disk inventory unavailable"
      : `${diskFreeGb.toFixed(2)} GB >= ${policy.min_disk_free_gb} GB`
  );

  if (policy.require_lan_address) {
    pushCheck(
      checks,
      "lan_address",
      Boolean(inventory?.network?.lan_ipv4),
      inventory?.network?.lan_ipv4 || "LAN IPv4 unavailable"
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
      const eventQueriesOk =
        enterprise?.event_log?.system?.query_ok === true &&
        enterprise?.event_log?.application?.query_ok === true;
      pushCheck(
        checks,
        "event_log",
        eventQueriesOk && eventCount <= policy.max_event_errors_last_hour,
        !eventQueriesOk
          ? "Windows Event Log query unavailable"
          : `${eventCount} critical/error events in last hour <= ${policy.max_event_errors_last_hour}`
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
      if (policy.require_domain_join) {
        pushCheck(
          checks,
          "domain_join",
          enterprise?.management?.domain_joined === true,
          enterprise?.management?.domain_joined === true
            ? `joined to ${enterprise?.management?.domain || "domain"}`
            : "host is not domain joined"
        );
      }
      if (policy.require_group_policy_service) {
        const gpsvc = String(enterprise?.management?.group_policy_service || "").toLowerCase();
        pushCheck(checks, "group_policy", gpsvc === "running", gpsvc || "unknown");
      }
      if (policy.require_intune_extension) {
        const intune = String(enterprise?.management?.intune_management_extension || "").toLowerCase();
        pushCheck(checks, "intune_extension", intune === "running", intune || "not installed");
      }
      if (policy.require_hyperv) {
        const hypervEnabled = Number(enterprise?.hyper_v?.optional_feature_state) === 1 ||
          enterprise?.hyper_v?.query_ok === true;
        pushCheck(
          checks,
          "hyper_v",
          hypervEnabled,
          hypervEnabled ? "Hyper-V available" : "Hyper-V not confirmed"
        );
      }
      if (policy.require_managed_service_account) {
        pushCheck(
          checks,
          "managed_service_account",
          enterprise?.service_identity?.configured === true,
          enterprise?.service_identity?.configured === true
            ? String(enterprise?.service_identity?.service_account || "managed account")
            : "managed service account not configured"
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
