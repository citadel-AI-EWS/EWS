import assert from "node:assert/strict";
import { googleDriveWritablePreflight } from "../src/index.js";

const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  },
  true,
  ["sign", "verify"]
);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
const privateKeyPem =
  "-----BEGIN PRIVATE KEY-----\n" +
  pkcs8.toString("base64").match(/.{1,64}/g).join("\n") +
  "\n-----END PRIVATE KEY-----\n";

function serviceAccount(email) {
  return JSON.stringify({
    type: "service_account",
    project_id: "citadel-test",
    private_key_id: "test-only",
    private_key: privateKeyPem,
    client_email: email,
    token_uri: "https://oauth2.googleapis.com/token"
  });
}

function decodeJwtSegment(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

const originalFetch = globalThis.fetch;
let tokenRequests = 0;
const folderRequests = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    tokenRequests += 1;
    const form = new URLSearchParams(String(init.body || ""));
    if (form.get("grant_type") === "refresh_token") {
      assert.equal(form.get("client_id"), "oauth-client");
      return new Response(JSON.stringify({
        access_token: "oauth-token-" + form.get("refresh_token"),
        expires_in: 3600
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion");
    assert.ok(assertion);
    const parts = assertion.split(".");
    assert.equal(parts.length, 3);
    assert.deepEqual(decodeJwtSegment(parts[0]), { alg: "RS256", typ: "JWT" });
    const claim = decodeJwtSegment(parts[1]);
    assert.equal(claim.aud, "https://oauth2.googleapis.com/token");
    assert.equal(claim.scope, "https://www.googleapis.com/auth/drive");
    assert.match(claim.iss, /@citadel-test\.iam\.gserviceaccount\.com$/);
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      Buffer.from(parts[2], "base64url"),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    assert.equal(verified, true);
    return new Response(JSON.stringify({
      access_token: "test-service-account-access-token",
      expires_in: 3600,
      token_type: "Bearer"
    }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const match = url.match(/\/drive\/v3\/files\/([^?]+)/);
  if (match) {
    const folderId = decodeURIComponent(match[1]);
    folderRequests.push(folderId);
    assert.ok(
      ["Bearer test-service-account-access-token", "Bearer oauth-token-first", "Bearer oauth-token-rotated"]
        .includes(init.headers.authorization)
    );
    if (folderId === "denied-folder") {
      return new Response(JSON.stringify({ error: { message: "forbidden" } }), {
        status: 403, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      id: folderId,
      name: folderId,
      mimeType: "application/vnd.google-apps.folder",
      capabilities: { canEdit: true }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error("unexpected fetch: " + url);
};

try {
  const env = {
    GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: serviceAccount("worker@citadel-test.iam.gserviceaccount.com"),
    GOOGLE_DRIVE_REPORTS_FOLDER_ID: "payload-folder",
    GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID: "ai-folder"
  };
  const first = await googleDriveWritablePreflight(env);
  assert.equal(first.ok, true);
  assert.deepEqual(folderRequests, ["payload-folder", "ai-folder"]);
  assert.equal(tokenRequests, 1);

  folderRequests.length = 0;
  const second = await googleDriveWritablePreflight(env);
  assert.equal(second.ok, true);
  assert.deepEqual(folderRequests, ["payload-folder", "ai-folder"]);
  assert.equal(tokenRequests, 1, "service-account access token should be cached");

  await assert.rejects(
    googleDriveWritablePreflight({
      GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON: serviceAccount("denied@citadel-test.iam.gserviceaccount.com"),
      GOOGLE_DRIVE_REPORTS_FOLDER_ID: "denied-folder",
      GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID: "ai-folder"
    }),
    (error) => error?.code === "drive_payload_write_denied"
  );
  assert.equal(tokenRequests, 2);

  const oauthEnv = {
    GOOGLE_DRIVE_CLIENT_ID: "oauth-client",
    GOOGLE_DRIVE_CLIENT_SECRET: "oauth-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "first",
    GOOGLE_DRIVE_REPORTS_FOLDER_ID: "oauth-folder",
    GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID: "oauth-ai-folder"
  };
  await googleDriveWritablePreflight(oauthEnv);
  await googleDriveWritablePreflight(oauthEnv);
  assert.equal(tokenRequests, 3, "unchanged OAuth credentials should reuse the token");
  await googleDriveWritablePreflight({ ...oauthEnv, GOOGLE_DRIVE_REFRESH_TOKEN: "rotated" });
  assert.equal(tokenRequests, 4, "rotating the refresh token must invalidate the cached access token");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Google Drive service-account JWT auth and writable folder preflight: OK");
