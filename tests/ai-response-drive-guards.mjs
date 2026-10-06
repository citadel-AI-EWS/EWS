import assert from "node:assert/strict";
import fs from "node:fs";
import { aiResponseArchiveValue, timestampedAiReportFileName } from "../src/index.js";

const source = fs.readFileSync("src/index.js", "utf8");

assert.match(source, /DEFAULT_GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID/);
assert.match(source, /GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID/);
assert.match(source, /ensureDriveChildFolder/);
assert.match(source, /timestampedAiReportFileName/);
assert.match(source, /CREATE TABLE IF NOT EXISTS ai_response_archives/);
assert.match(source, /archiveCompletedAiResponse/);
assert.match(source, /await archiveCompletedAiResponse\(env, nodeId, state\)/);
assert.match(source, /kind: "ai_response"[\s\S]*node_id: nodeId/);
assert.match(source, /kind: "agent_report"[\s\S]*node_id: nodeId/);
assert.equal(
  timestampedAiReportFileName("ai_response", "query_hi", new Date("2026-10-06T11:00:00Z")),
  "2026-10-06_11-00-00__ai_response__query_hi.json"
);

assert.deepEqual(
  aiResponseArchiveValue("node_a8", "a8", {
    query_id: "query_hi", query_status: "completed", loaded_model: "tiny-model",
    query_prompt: "hi", query_answer: "Hello."
  }, "2026-10-06T11:00:00Z"),
  {
    node_id: "node_a8", hostname: "a8", query_id: "query_hi",
    status: "completed", model: "tiny-model", mode: null,
    prompt: "hi", response: "Hello.", completed_at: "2026-10-06T11:00:00Z"
  }
);

const start = source.indexOf("async function architectCreateCommand");
const end = source.indexOf("async function nodeUpdateAiState", start);
const block = source.slice(start, end);
assert.match(block, /INSERT INTO commands/);
assert.match(block, /SELECT command_id FROM commands WHERE command_id = \?/);
assert.match(block, /Command audit persistence failed/);
assert.match(block, /\.bind\(actor\.actor_id, commandId, detailsJson\)\.run\(\)/);
assert.doesNotMatch(
  block,
  /env\.DB\.batch\(\[\s*env\.DB\.prepare\(\s*"INSERT INTO commands/
);

console.log("AI Drive archive hierarchy + resilient command persistence guards: OK");
