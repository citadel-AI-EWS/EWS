import assert from "node:assert/strict";
import {
  handlePresenceRequest,
  recordNodePresence
} from "../src/presence.js";

const architectToken = "presence-test-architect-token-with-entropy";
const architectHash = Buffer.from(await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(architectToken)
)).toString("hex");

const state = {
  nodes: new Map([["node_presence_test", { node_id: "node_presence_test", status: "online" }]]),
  presence: new Map()
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
    if (this.sql.includes("SELECT token_hash") && this.sql.includes("FROM architect_auth_state")) return { token_hash: architectHash };
    throw new Error(`Unhandled first(): ${this.sql}`);
  }
  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO architect_auth_state")) return { meta: { changes: 0 } };
    if (this.sql.startsWith("CREATE TABLE") || this.sql.startsWith("CREATE INDEX")) {
      return { meta: { changes: 0 } };
    }
    if (this.sql.startsWith("INSERT INTO node_presence")) {
      const [nodeId, publicIp, country, colo, asn] = this.args;
      const existing = state.presence.get(nodeId);
      state.presence.set(nodeId, {
        node_id: nodeId,
        public_ip: publicIp,
        country,
        colo,
        asn,
        first_seen_at: existing?.first_seen_at || "2026-09-17 10:00:00",
        updated_at: "2026-09-17 10:00:30"
      });
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled run(): ${this.sql}`);
  }
  async all() {
    if (this.sql.includes("FROM node_presence AS p") && this.sql.includes("JOIN nodes AS n")) {
      return {
        results: [...state.presence.values()].filter((item) =>
          state.nodes.get(item.node_id)?.status !== "revoked"
        )
      };
    }
    throw new Error(`Unhandled all(): ${this.sql}`);
  }
}

const env = {
  ARCHITECT_TOKEN_HASH: architectHash,
  DB: {
    prepare(sql) {
      return new Statement(sql);
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  }
};

const heartbeat = new Request("https://example.test/api/v1/nodes/node_presence_test/heartbeat", {
  method: "POST",
  headers: { "cf-connecting-ip": "203.0.113.42" },
  body: "{}"
});
Object.defineProperty(heartbeat, "cf", {
  value: { country: "IL", colo: "TLV", asn: 64500 },
  configurable: true
});

await recordNodePresence(heartbeat, env, "node_presence_test");
assert.equal(state.presence.get("node_presence_test").public_ip, "203.0.113.42");
assert.equal(state.presence.get("node_presence_test").country, "IL");
assert.equal(state.presence.get("node_presence_test").colo, "TLV");
assert.equal(state.presence.get("node_presence_test").asn, 64500);

let response = await handlePresenceRequest(
  new Request("https://example.test/api/v1/architect/presence"),
  env
);
assert.equal(response.status, 401);

response = await handlePresenceRequest(
  new Request("https://example.test/api/v1/architect/presence", {
    headers: { authorization: `Bearer ${architectToken}` }
  }),
  env
);
assert.equal(response.status, 200);
const data = await response.json();
assert.equal(data.ok, true);
assert.equal(data.presence.length, 1);
assert.equal(data.presence[0].public_ip, "203.0.113.42");

const spoofed = new Request("https://example.test/api/v1/nodes/node_presence_test/heartbeat", {
  method: "POST",
  headers: { "cf-connecting-ip": "not-an-ip" },
  body: "{}"
});
await recordNodePresence(spoofed, env, "node_presence_test");
assert.equal(state.presence.get("node_presence_test").public_ip, "203.0.113.42");

console.log("Presence storage tests: PASS");
