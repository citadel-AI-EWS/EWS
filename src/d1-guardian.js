const GUARDIAN_INTERVAL_MINUTES = 5;
const GUARDIAN_DEEP_INTERVAL_MINUTES = 60;
const GUARDIAN_BATCH_LIMIT = 50;
let guardianSchemaPromise;

function changes(result) {
  return Number(result?.meta?.changes || 0);
}

function missingOptionalTable(error) {
  return /no such table:/i.test(String(error?.message || error || ""));
}

function errorCode(error) {
  return String(error?.code || error?.message || error || "guardian_rule_failed")
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 160);
}

export async function ensureD1GuardianStorage(env) {
  if (!guardianSchemaPromise) {
    guardianSchemaPromise = env.DB.batch([
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS d1_guardian_state (
          guardian_id INTEGER PRIMARY KEY CHECK (guardian_id = 1),
          status TEXT NOT NULL DEFAULT 'unknown'
            CHECK (status IN ('unknown','checking','healthy','repaired','warning','error')),
          next_run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          next_deep_check_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_run_at TEXT,
          last_ok_at TEXT,
          checked_rules INTEGER NOT NULL DEFAULT 0,
          detected_issues INTEGER NOT NULL DEFAULT 0,
          repaired_rows INTEGER NOT NULL DEFAULT 0,
          warning_count INTEGER NOT NULL DEFAULT 0,
          summary_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        INSERT OR IGNORE INTO d1_guardian_state (guardian_id)
        VALUES (1)
      `),
      env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS d1_guardian_actions (
          action_id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          severity TEXT NOT NULL
            CHECK (severity IN ('info','warning','error')),
          rows_affected INTEGER NOT NULL DEFAULT 0 CHECK (rows_affected >= 0),
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `),
      env.DB.prepare(`
        CREATE INDEX IF NOT EXISTS idx_d1_guardian_actions_created
        ON d1_guardian_actions(created_at DESC, action_id DESC)
      `)
    ]).catch((error) => {
      guardianSchemaPromise = undefined;
      throw error;
    });
  }
  await guardianSchemaPromise;
}

async function appendAction(env, action, severity, rowsAffected, details = {}) {
  await env.DB.prepare(`
    INSERT INTO d1_guardian_actions (
      action, severity, rows_affected, details_json
    ) VALUES (?, ?, ?, ?)
  `).bind(
    action,
    severity,
    Math.max(0, Number(rowsAffected || 0)),
    JSON.stringify(details)
  ).run();
}

async function markStaleNodesOffline(env) {
  const result = await env.DB.prepare(`
    UPDATE nodes
    SET status = 'offline'
    WHERE node_id IN (
      SELECT node_id
      FROM nodes
      WHERE status = 'online'
        AND (
          last_seen_at IS NULL
          OR datetime(last_seen_at) < datetime('now', '-5 minutes')
        )
      ORDER BY last_seen_at ASC
      LIMIT ?
    )
  `).bind(GUARDIAN_BATCH_LIMIT).run();
  return changes(result);
}

async function reconcileRunningProjects(env) {
  const result = await env.DB.prepare(`
    UPDATE architect_projects
    SET status = 'running', updated_at = CURRENT_TIMESTAMP
    WHERE project_id IN (
      SELECT p.project_id
      FROM architect_projects AS p
      WHERE p.status = 'planned'
        AND EXISTS (
          SELECT 1
          FROM project_work_items AS w
          WHERE w.project_id = p.project_id
            AND w.status IN ('assigned','running')
        )
      ORDER BY p.updated_at ASC
      LIMIT ?
    )
  `).bind(GUARDIAN_BATCH_LIMIT).run();
  return changes(result);
}

async function reconcileCompletedProjects(env) {
  const result = await env.DB.prepare(`
    UPDATE architect_projects
    SET status = 'completed', updated_at = CURRENT_TIMESTAMP
    WHERE project_id IN (
      SELECT p.project_id
      FROM architect_projects AS p
      WHERE p.status IN ('planned','running')
        AND EXISTS (
          SELECT 1
          FROM project_work_items AS w
          WHERE w.project_id = p.project_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM project_work_items AS w
          WHERE w.project_id = p.project_id
            AND w.status NOT IN ('completed','cancelled')
        )
      ORDER BY p.updated_at ASC
      LIMIT ?
    )
  `).bind(GUARDIAN_BATCH_LIMIT).run();
  return changes(result);
}

async function countExpiredNonces(env) {
  const rows = await env.DB.prepare(`
    SELECT rowid
    FROM node_request_nonces
    WHERE received_at < datetime('now', '-10 minutes')
    ORDER BY received_at ASC
    LIMIT ?
  `).bind(GUARDIAN_BATCH_LIMIT).all();
  return (rows.results || []).length;
}

async function countOldRateWindows(env) {
  const rows = await env.DB.prepare(`
    SELECT rowid
    FROM node_log_rate_limits
    WHERE window_started_at < datetime('now', '-1 day')
    ORDER BY window_started_at ASC
    LIMIT ?
  `).bind(GUARDIAN_BATCH_LIMIT).all();
  return (rows.results || []).length;
}
async function deepConsistencyWarnings(env) {
  const warnings = [];
  try {
    const orphanWork = await env.DB.prepare(`
      SELECT w.work_item_id, w.project_id
      FROM project_work_items AS w
      LEFT JOIN architect_projects AS p ON p.project_id = w.project_id
      WHERE p.project_id IS NULL
      LIMIT 1
    `).first();
    if (orphanWork) {
      warnings.push({
        code: "orphan_project_work_item",
        target_id: orphanWork.work_item_id,
        project_id: orphanWork.project_id
      });
    }
  } catch (error) {
    if (!missingOptionalTable(error)) throw error;
  }

  try {
    const orphanNodeAi = await env.DB.prepare(`
      SELECT ai.node_id
      FROM node_ai_state AS ai
      LEFT JOIN nodes AS n ON n.node_id = ai.node_id
      WHERE n.node_id IS NULL
      LIMIT 1
    `).first();
    if (orphanNodeAi) {
      warnings.push({
        code: "orphan_node_ai_state",
        target_id: orphanNodeAi.node_id
      });
    }
  } catch (error) {
    if (!missingOptionalTable(error)) throw error;
  }
  return warnings;
}

async function claimGuardianRun(env, force) {
  return env.DB.prepare(`
    UPDATE d1_guardian_state
    SET status = 'checking',
        next_run_at = datetime('now', '+5 minutes'),
        updated_at = CURRENT_TIMESTAMP
    WHERE guardian_id = 1
      AND (status != 'checking' OR updated_at < datetime('now', '-2 minutes'))
      AND (? = 1 OR next_run_at <= CURRENT_TIMESTAMP)
  `).bind(force ? 1 : 0).run();
}

export async function runD1Guardian(env, hooks = {}) {
  let claim;
  try {
    claim = await claimGuardianRun(env, hooks.force === true);
  } catch (error) {
    if (!missingOptionalTable(error)) throw error;
    await ensureD1GuardianStorage(env);
    claim = await claimGuardianRun(env, hooks.force === true);
  }
  if (changes(claim) !== 1) {
    return { ok: true, skipped: true, reason: "guardian_not_due" };
  }

  const previous = await env.DB.prepare(`
    SELECT next_deep_check_at
    FROM d1_guardian_state
    WHERE guardian_id = 1
  `).first();
  const deep = !previous?.next_deep_check_at ||
    Date.parse(String(previous.next_deep_check_at).replace(" ", "T") + "Z") <= Date.now();

  let checkedRules = 0;
  let detectedIssues = 0;
  let repairedRows = 0;
  let warningCount = 0;
  const actions = [];
  const warnings = [];

  const repairRule = async (name, fn, details = {}) => {
    checkedRules += 1;
    try {
      const affected = Math.max(0, Number(await fn() || 0));
      if (affected > 0) {
        detectedIssues += affected;
        repairedRows += affected;
        actions.push({ name, affected, details });
      }
      return affected;
    } catch (error) {
      if (missingOptionalTable(error)) return 0;
      warningCount += 1;
      warnings.push({ rule: name, error: errorCode(error) });
      return 0;
    }
  };

  const observations = [];
  const observeRule = async (name, fn) => {
    checkedRules += 1;
    try {
      const count = Math.max(0, Number(await fn() || 0));
      if (count > 0) {
        detectedIssues += count;
        observations.push({ action: name, rows_detected: count });
      }
      return count;
    } catch (error) {
      if (missingOptionalTable(error)) return 0;
      warningCount += 1;
      warnings.push({ rule: name, error: errorCode(error) });
      return 0;
    }
  };

  await repairRule("stale_nodes_offline", () => markStaleNodesOffline(env));
  if (typeof hooks.expireStaleCommands === "function") {
    await repairRule("stale_commands_expired", () => hooks.expireStaleCommands(env, null, GUARDIAN_BATCH_LIMIT));
  }
  if (typeof hooks.recoverStaleProjectAssignments === "function") {
    await repairRule("stale_project_assignments_requeued", () =>
      hooks.recoverStaleProjectAssignments(env, GUARDIAN_BATCH_LIMIT)
    );
  }
  await repairRule("projects_marked_running", () => reconcileRunningProjects(env));
  await repairRule("projects_marked_completed", () => reconcileCompletedProjects(env));
  await observeRule("expired_request_nonces_detected", () => countExpiredNonces(env));
  await observeRule("old_rate_windows_detected", () => countOldRateWindows(env));

  if (deep) {
    checkedRules += 1;
    try {
      const deepWarnings = await deepConsistencyWarnings(env);
      for (const warning of deepWarnings) {
        warningCount += 1;
        detectedIssues += 1;
        warnings.push({ rule: "deep_consistency", ...warning });
      }
    } catch (error) {
      warningCount += 1;
      warnings.push({ rule: "deep_consistency", error: errorCode(error) });
    }
  }

  for (const action of actions.slice(0, 12)) {
    await appendAction(env, action.name, "info", action.affected, action.details);
  }
  for (const warning of warnings.slice(0, 12)) {
    await appendAction(env, warning.rule, "warning", 0, warning);
  }

  const status = warningCount > 0
    ? "warning"
    : repairedRows > 0
      ? "repaired"
      : "healthy";
  const summary = {
    deep_check: deep,
    actions: actions.map((item) => ({
      action: item.name,
      rows_affected: item.affected
    })),
    warnings,
    observations
  };

  await env.DB.prepare(`
    UPDATE d1_guardian_state
    SET status = ?,
        last_run_at = CURRENT_TIMESTAMP,
        last_ok_at = CASE WHEN ? IN ('healthy','repaired') THEN CURRENT_TIMESTAMP ELSE last_ok_at END,
        next_deep_check_at = CASE
          WHEN ? = 1 THEN datetime('now', '+60 minutes')
          ELSE next_deep_check_at
        END,
        checked_rules = ?,
        detected_issues = ?,
        repaired_rows = ?,
        warning_count = ?,
        summary_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE guardian_id = 1
  `).bind(
    status,
    status,
    deep ? 1 : 0,
    checkedRules,
    detectedIssues,
    repairedRows,
    warningCount,
    JSON.stringify(summary)
  ).run();

  return {
    ok: true,
    skipped: false,
    status,
    checked_rules: checkedRules,
    detected_issues: detectedIssues,
    repaired_rows: repairedRows,
    warning_count: warningCount,
    deep_check: deep
  };
}

async function guardianStatusRows(env) {
  const [state, actions] = await Promise.all([
    env.DB.prepare(`
      SELECT status, next_run_at, next_deep_check_at, last_run_at, last_ok_at,
        checked_rules, detected_issues, repaired_rows, warning_count,
        summary_json, updated_at
      FROM d1_guardian_state
      WHERE guardian_id = 1
    `).first(),
    env.DB.prepare(`
      SELECT action_id, action, severity, rows_affected, details_json, created_at
      FROM d1_guardian_actions
      ORDER BY created_at DESC, action_id DESC
      LIMIT 12
    `).all()
  ]);
  return { state, actions };
}

export async function readD1GuardianStatus(env) {
  let rows;
  try {
    rows = await guardianStatusRows(env);
  } catch (error) {
    if (!missingOptionalTable(error)) throw error;
    await ensureD1GuardianStorage(env);
    rows = await guardianStatusRows(env);
  }
  const { state, actions } = rows;

  let summary = {};
  try {
    summary = state?.summary_json ? JSON.parse(state.summary_json) : {};
  } catch {
    summary = {};
  }

  return {
    ok: true,
    guardian: {
      ...(state || {
        status: "unknown",
        checked_rules: 0,
        detected_issues: 0,
        repaired_rows: 0,
        warning_count: 0
      }),
      summary,
      summary_json: undefined
    },
    recent_actions: (actions.results || []).map((row) => {
      let details = {};
      try {
        details = JSON.parse(row.details_json || "{}");
      } catch {
        details = {};
      }
      return { ...row, details, details_json: undefined };
    })
  };
}
