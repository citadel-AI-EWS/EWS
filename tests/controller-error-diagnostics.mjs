import assert from "node:assert/strict";
import fs from "node:fs";
import worker from "../src/index.js";

const hub = fs.readFileSync("hub.html", "utf8");
const operations = fs.readFileSync("operations.html", "utf8");
const index = fs.readFileSync("src/index.js", "utf8");

assert.match(index, /observed: false/);
assert.match(index, /observed: true/);
assert.match(index, /request_id: requestId/);
assert.match(hub, /ai\.observed===false\?null:ai\.installed/);
assert.match(hub, /request \$\{ref\}/);
assert.match(operations, /Код ошибки: '\+ref/);
assert.match(operations, /ai\.observed===false\?'◷ Состояние не получено'/);

const logs = [];
const originalError = console.error;
let response;
try {
  console.error = (...args) => logs.push(args);
  response = await worker.fetch(
    new Request("https://example.test/api/v1/architect/nodes/test/ai-state"),
    {
      ARCHITECT_TOKEN_HASH: "a".repeat(64),
      DB: { prepare() { throw new Error("private database diagnostic"); } }
    }
  );
} finally {
  console.error = originalError;
}

assert.equal(response.status, 500);
assert.equal(response.headers.get("cache-control"), "no-store");
const failure = await response.json();
assert.equal(failure.error, "internal_error");
assert.match(failure.request_id, /^[0-9a-f-]{36}$/);
assert.equal(logs.length, 1);
assert.equal(logs[0][1].request_id, failure.request_id);
assert.doesNotMatch(JSON.stringify(failure), /private database diagnostic/);

console.log("Controller request-id diagnostics + unknown AI state: PASS");
