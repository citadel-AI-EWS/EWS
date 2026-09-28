import assert from "node:assert/strict";
import { googleDrivePayloadReady } from "../src/index.js";

const originalFetch = globalThis.fetch;
const env = {
  GOOGLE_DRIVE_ACCESS_TOKEN: "test-token",
  GOOGLE_DRIVE_REPORTS_FOLDER_ID: "folder-test",
  GOOGLE_DRIVE_PAYLOAD_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
};

let mode = "writable";
globalThis.fetch = async (input) => {
  const url = String(input);
  assert.match(url, /drive\/v3\/files\/folder-test/);
  if (mode === "missing") return new Response("missing", { status: 404 });
  return new Response(JSON.stringify({
    id: "folder-test",
    mimeType: "application/vnd.google-apps.folder",
    trashed: false,
    capabilities: { canAddChildren: mode === "writable" }
  }), { status: 200, headers: { "content-type": "application/json" } });
};

assert.equal(await googleDrivePayloadReady(env), true);

mode = "readonly";
await assert.rejects(
  () => googleDrivePayloadReady(env),
  (error) => error?.code === "drive_payload_folder_not_writable"
);

mode = "missing";
await assert.rejects(
  () => googleDrivePayloadReady(env),
  (error) => error?.code === "drive_payload_folder_probe_failed"
);

globalThis.fetch = originalFetch;
console.log("Google Drive payload folder readiness probe: OK");
