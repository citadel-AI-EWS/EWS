import assert from "node:assert/strict";
import {
  decryptDrivePayload,
  encryptDrivePayload,
  verifyDrivePayloadEncryption
} from "../src/google_drive_payload_crypto.js";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const env = {
  GOOGLE_DRIVE_PAYLOAD_ENCRYPTION_KEY: key,
  GOOGLE_DRIVE_PAYLOAD_KEY_VERSION: "v1"
};

assert.equal(await verifyDrivePayloadEncryption(env), true);

const plaintext = JSON.stringify({
  secret: "payload-must-not-be-visible-in-drive",
  nested: { value: 42 }
});
const encrypted = await encryptDrivePayload(env, plaintext);
assert.equal(encrypted.key_version, "v1");
assert.match(encrypted.text, /"algorithm":"A256GCM"/);
assert.equal(encrypted.text.includes("payload-must-not-be-visible-in-drive"), false);

const decoded = await decryptDrivePayload(env, encrypted.text);
assert.equal(decoded.encrypted, true);
assert.equal(decoded.key_version, "v1");
assert.equal(decoded.plaintext, plaintext);

// Legacy plain JSON remains readable after enabling encryption.
const legacy = await decryptDrivePayload(env, plaintext);
assert.equal(legacy.encrypted, false);
assert.equal(legacy.plaintext, plaintext);

// Envelopes produced by the 2026-09-13 Drive prototype (#37) did not include
// the citadel_envelope discriminator. They remain decryptable.
const oldEnvelope = JSON.parse(encrypted.text);
delete oldEnvelope.citadel_envelope;
const oldDecoded = await decryptDrivePayload(env, JSON.stringify(oldEnvelope));
assert.equal(oldDecoded.encrypted, true);
assert.equal(oldDecoded.plaintext, plaintext);

await assert.rejects(
  () => decryptDrivePayload(
    { ...env, GOOGLE_DRIVE_PAYLOAD_KEY_VERSION: "v2" },
    encrypted.text
  ),
  (error) => error?.code === "drive_payload_key_version_mismatch"
);

await assert.rejects(
  () => verifyDrivePayloadEncryption({
    GOOGLE_DRIVE_PAYLOAD_ENCRYPTION_KEY: "not-a-32-byte-key"
  }),
  (error) => error?.code === "drive_payload_encryption_key_invalid"
);

console.log("Google Drive payload encryption compatibility: OK");
