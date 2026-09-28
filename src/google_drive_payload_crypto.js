function storageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let decoded;
  try {
    decoded = atob(padded);
  } catch {
    throw storageError("drive_payload_encryption_key_invalid");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function encryptionConfig(env) {
  const key = String(
    env?.GOOGLE_DRIVE_PAYLOAD_ENCRYPTION_KEY ||
    env?.GOOGLE_DRIVE_REPORT_ENCRYPTION_KEY ||
    ""
  ).trim();
  const keyVersion = String(
    env?.GOOGLE_DRIVE_PAYLOAD_KEY_VERSION ||
    env?.GOOGLE_DRIVE_REPORT_KEY_VERSION ||
    "v1"
  ).trim() || "v1";
  return { key, keyVersion };
}

async function importEncryptionKey(env) {
  const config = encryptionConfig(env);
  if (!config.key) throw storageError("drive_payload_encryption_unavailable");
  const bytes = fromBase64Url(config.key);
  if (bytes.byteLength !== 32) throw storageError("drive_payload_encryption_key_invalid");
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  } catch {
    throw storageError("drive_payload_encryption_key_invalid");
  }
}

export async function verifyDrivePayloadEncryption(env) {
  await importEncryptionKey(env);
  return true;
}

export async function encryptDrivePayload(env, plaintext) {
  const config = encryptionConfig(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(String(plaintext));
  let ciphertext;
  try {
    ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await importEncryptionKey(env),
      encoded
    );
  } catch (error) {
    if (error?.code) throw error;
    throw storageError("drive_payload_encryption_failed");
  }
  return {
    text: JSON.stringify({
      citadel_envelope: "drive-payload-v1",
      version: 1,
      algorithm: "A256GCM",
      key_version: config.keyVersion,
      iv: base64Url(iv),
      ciphertext: base64Url(new Uint8Array(ciphertext))
    }),
    key_version: config.keyVersion
  };
}

function encryptedEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (
    value.citadel_envelope === "drive-payload-v1" &&
    value.version === 1 &&
    value.algorithm === "A256GCM"
  ) return true;

  // Compatibility with the encrypted report envelopes from the 2026-09-13
  // Google Drive tiering prototype (#37).
  const allowed = new Set(["version", "algorithm", "key_version", "iv", "ciphertext"]);
  return value.version === 1 &&
    value.algorithm === "A256GCM" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    Object.keys(value).every((key) => allowed.has(key));
}

export async function decryptDrivePayload(env, storedText) {
  const raw = String(storedText);
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { plaintext: raw, encrypted: false, key_version: null };
  }
  if (!encryptedEnvelope(envelope)) {
    return { plaintext: raw, encrypted: false, key_version: null };
  }
  if (typeof envelope.iv !== "string" || typeof envelope.ciphertext !== "string") {
    throw storageError("drive_payload_envelope_invalid");
  }
  const config = encryptionConfig(env);
  if (envelope.key_version && envelope.key_version !== config.keyVersion) {
    throw storageError("drive_payload_key_version_mismatch");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
      await importEncryptionKey(env),
      fromBase64Url(envelope.ciphertext)
    );
    return {
      plaintext: new TextDecoder().decode(plaintext),
      encrypted: true,
      key_version: envelope.key_version || config.keyVersion
    };
  } catch (error) {
    if (error?.code) throw error;
    throw storageError("drive_payload_decryption_failed");
  }
}
