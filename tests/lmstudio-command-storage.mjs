import assert from "node:assert/strict";
import worker from "../src/index.js";

const architectToken = "test-architect-token-with-enough-entropy";
const architectHash = Buffer.from(await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(architectToken)
)).toString("hex");

const state = {
  tables: new Set(["nodes", "architect_auth_state", "commands"]),
  indexes: new Set(),
  commandColumns: new Set(["command_id","node_id","command_type","payload_json","signature","status","created_at"]),
  commands: [],
  audit: [],
  activeCommand: null,
  runtimeState: null
};

function compact(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

class Statement {
  constructor(sql) {
    this.sql = compact(sql);
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async first() {
    if (this.sql.includes("FROM architect_auth_state WHERE singleton_id = 1")) {
      return {
        token_hash: architectHash,
        bootstrap_mode: 0,
        recovery_hash: null,
        recovery_used: 1,
        token_rotated_at: null,
        recovery_created_at: null,
        updated_at: new Date().toISOString()
      };
    }
    if (this.sql.includes("FROM nodes WHERE node_id = ?")) {
      return {
        node_id: this.args[0],
        hostname: "lm-bootstrap-test",
        status: "online",
        agent_version: "0.3.19",
        os_name: "Windows 11",
        architecture: "x86_64",
        last_seen_at: new Date().toISOString(),
        recently_seen: 1
      };
    }
    if (this.sql === "SELECT state_json FROM node_ai_runtime_state WHERE node_id = ?") {
      return state.runtimeState ? { state_json: JSON.stringify(state.runtimeState) } : null;
    }
    if (this.sql.includes("FROM commands") && this.sql.includes("status IN ('pending', 'accepted')")) {
      return state.activeCommand ? { ...state.activeCommand } : null;
    }
    throw new Error(`Unhandled first(): ${this.sql}`);
  }
  async all() {
    if (this.sql === "PRAGMA table_info(commands)") {
      return { results: [...state.commandColumns].map((name, cid) => ({ cid, name })) };
    }
    if (this.sql.includes("FROM commands") && this.sql.includes("datetime(created_at) < datetime(?)")) {
      if (!state.tables.has("commands")) throw new Error("no such table: commands");
      return { results: [] };
    }
    throw new Error(`Unhandled all(): ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith("CREATE TABLE IF NOT EXISTS commands")) {
      state.tables.add("commands");
      return { meta: { changes: 0 } };
    }
    if (this.sql === "ALTER TABLE commands ADD COLUMN completed_at TEXT") {
      if (state.commandColumns.has("completed_at")) throw new Error("duplicate column name: completed_at");
      state.commandColumns.add("completed_at");
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("CREATE TABLE IF NOT EXISTS audit_events")) {
      state.tables.add("audit_events");
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX") || this.sql.startsWith("CREATE UNIQUE INDEX")) {
      const match = this.sql.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ([^ ]+)/);
      if (match) state.indexes.add(match[1]);
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT OR IGNORE INTO architect_auth_state")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("UPDATE commands")) {
      if (!state.tables.has("commands")) throw new Error("no such table: commands");
      if (
        this.sql.startsWith("UPDATE commands SET status = ?, completed_at = COALESCE") &&
        state.activeCommand &&
        state.activeCommand.command_id === this.args[1] &&
        state.activeCommand.node_id === this.args[2] &&
        ["pending", "accepted"].includes(state.activeCommand.status)
      ) {
        state.activeCommand.status = this.args[0];
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO commands")) {
      if (!state.tables.has("commands")) throw new Error("no such table: commands");
      state.commands.push([...this.args]);
      return { meta: { changes: 1 } };
    }
    if (this.sql.startsWith("INSERT INTO audit_events")) {
      if (!state.tables.has("audit_events")) throw new Error("no such table: audit_events");
      state.audit.push([...this.args]);
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled run(): ${this.sql}`);
  }
}

const env = {
  ARCHITECT_TOKEN_HASH: architectHash,
  // Deliberately omit CONTROLLER_COMMAND_PRIVATE_JWK. The request should get
  // a concrete signing error only after command storage bootstraps successfully.
  DB: {
    prepare(sql) {
      return new Statement(sql);
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  },
  ASSETS: { fetch() { return new Response("asset"); } }
};

assert.equal(state.tables.has("commands"), true);
assert.equal(state.commandColumns.has("completed_at"), false);
assert.equal(state.tables.has("audit_events"), false);

const response = await worker.fetch(new Request(
  "https://example.test/api/v1/architect/nodes/node_lm_bootstrap/commands",
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${architectToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ command_type: "lmstudio_install" })
  }
), env);

assert.equal(response.status, 503);
const data = await response.json();
assert.equal(data.error, "controller_signing_not_configured");
assert.notEqual(data.error, "internal_error");
assert.equal(state.tables.has("commands"), true);
assert.equal(state.commandColumns.has("completed_at"), true);
assert.equal(state.tables.has("audit_events"), true);
assert.equal(state.indexes.has("idx_commands_one_active_per_node"), true);
assert.equal(state.commands.length, 0);

state.activeCommand = {
  command_id: "command_terminal_load",
  node_id: "node_lm_bootstrap",
  command_type: "lmstudio_model_load",
  payload_json: "{}",
  status: "accepted"
};
state.runtimeState = {
  operation_id: "command_terminal_load",
  progress_phase: "load_complete"
};

const recoveredResponse = await worker.fetch(new Request(
  "https://example.test/api/v1/architect/nodes/node_lm_bootstrap/commands",
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${architectToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ command_type: "lmstudio_install" })
  }
), env);

assert.equal(recoveredResponse.status, 503);
assert.equal((await recoveredResponse.json()).error, "controller_signing_not_configured");
assert.equal(state.activeCommand.status, "completed");

console.log("LM Studio legacy command schema repair + terminal runtime recovery regression: OK");
