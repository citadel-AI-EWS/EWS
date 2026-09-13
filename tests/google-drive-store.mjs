import assert from "node:assert/strict";
import {
  createGoogleDriveStore,
  googleDriveStorageReady
} from "../src/google_drive_store.js";

const key = Buffer.alloc(32, 7).toString("base64url");
const env = {
  GOOGLE_DRIVE_CLIENT_ID: "test-client-id",
  GOOGLE_DRIVE_CLIENT_SECRET: "test-client-secret",
  GOOGLE_DRIVE_REFRESH_TOKEN: "test-refresh-token",
  GOOGLE_DRIVE_REPORTS_FOLDER_ID: "test-reports-folder",
  GOOGLE_DRIVE_REPORT_ENCRYPTION_KEY: key,
  GOOGLE_DRIVE_REPORT_KEY_VERSION: "test-v1"
};

const files = new Map();
let tokenRequests = 0;
let uploadMetadata = null;

async function fakeFetch(input, init = {}) {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    tokenRequests += 1;
    assert.equal(init.method, "POST");
    assert.ok(String(init.body).includes("grant_type=refresh_token"));
    return Response.json({ access_token: "test-access-token", expires_in: 3600 });
  }

  assert.equal(init.headers.authorization, "Bearer test-access-token");
  if (url.includes("upload/drive/v3/files")) {
    const contentType = init.headers["content-type"];
    const boundary = contentType.match(/boundary=(.+)$/)?.[1];
    assert.ok(boundary);
    const parts = String(init.body).split(`--${boundary}`);
    uploadMetadata = JSON.parse(parts[1].split("\r\n\r\n")[1].trim());
    const encryptedEnvelope = parts[2].split("\r\n\r\n")[1].trim();
    const id = "drive-file-1";
    files.set(id, encryptedEnvelope);
    return Response.json({ id, name: uploadMetadata.name, size: encryptedEnvelope.length });
  }

  const id = decodeURIComponent(url.match(/\/files\/([^?]+)/)?.[1] || "");
  if (init.method === "DELETE") {
    if (!files.has(id)) return new Response(null, { status: 404 });
    files.delete(id);
    return new Response(null, { status: 204 });
  }
  if (!files.has(id)) return new Response(null, { status: 404 });
  return new Response(files.get(id), {
    status: 200,
    headers: { "content-type": "application/vnd.citadel.report+json" }
  });
}

assert.equal(googleDriveStorageReady(env), true);
assert.equal(googleDriveStorageReady({ ...env, GOOGLE_DRIVE_REFRESH_TOKEN: "" }), false);

const store = createGoogleDriveStore(env, fakeFetch);
const plaintext = JSON.stringify({ finding: "safe", secret: "never stored as plaintext" });
const fileId = await store.put("reports/2026/09/report-1.json", plaintext, {
  customMetadata: {
    report_id: "report-1",
    sha256: "a".repeat(64),
    size_bytes: String(new TextEncoder().encode(plaintext).byteLength)
  }
});

assert.equal(store.provider, "gdrive");
assert.equal(fileId, "drive-file-1");
assert.deepEqual(uploadMetadata.parents, [env.GOOGLE_DRIVE_REPORTS_FOLDER_ID]);
assert.equal(uploadMetadata.appProperties.citadel_report_id, "report-1");
assert.equal(files.get(fileId).includes("never stored as plaintext"), false);

const downloaded = await store.get(fileId);
assert.equal(await downloaded.text(), plaintext);
assert.equal(tokenRequests, 1, "access token must be cached without exposing credentials");

await store.delete(fileId);
assert.equal(await store.get(fileId), null);

console.log("Encrypted Google Drive report store: OK");
