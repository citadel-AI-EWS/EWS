const tokenCache = new WeakMap();

function configuration(env) {
  return {
    clientId: String(env?.GOOGLE_DRIVE_CLIENT_ID || "").trim(),
    clientSecret: String(env?.GOOGLE_DRIVE_CLIENT_SECRET || "").trim(),
    refreshToken: String(env?.GOOGLE_DRIVE_REFRESH_TOKEN || "").trim(),
    folderId: String(env?.GOOGLE_DRIVE_REPORTS_FOLDER_ID || "").trim(),
    encryptionKey: String(env?.GOOGLE_DRIVE_REPORT_ENCRYPTION_KEY || "").trim(),
    keyVersion: String(env?.GOOGLE_DRIVE_REPORT_KEY_VERSION || "v1").trim()
  };
}

export function googleDriveStorageReady(env) {
  const value = configuration(env);
  return Boolean(
    value.clientId &&
    value.clientSecret &&
    value.refreshToken &&
    value.folderId &&
    value.encryptionKey
  );
}

function storageError(code, status = 503) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let decoded;
  try {
    decoded = atob(padded);
  } catch {
    throw storageError("google_drive_encryption_key_invalid");
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function importEncryptionKey(env) {
  const bytes = fromBase64Url(configuration(env).encryptionKey);
  if (bytes.byteLength !== 32) {
    throw storageError("google_drive_encryption_key_invalid");
  }
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptReport(env, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await importEncryptionKey(env),
    encoded
  );
  return JSON.stringify({
    version: 1,
    algorithm: "A256GCM",
    key_version: configuration(env).keyVersion,
    iv: base64Url(iv),
    ciphertext: base64Url(new Uint8Array(ciphertext))
  });
}

async function decryptReport(env, envelopeText) {
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw storageError("google_drive_report_envelope_invalid");
  }
  if (
    envelope?.version !== 1 ||
    envelope?.algorithm !== "A256GCM" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw storageError("google_drive_report_envelope_invalid");
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
      await importEncryptionKey(env),
      fromBase64Url(envelope.ciphertext)
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error?.code) throw error;
    throw storageError("google_drive_report_decryption_failed");
  }
}

async function accessToken(env, fetchImpl) {
  const cached = tokenCache.get(env);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const config = configuration(env);
  const response = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token"
    })
  });
  if (!response.ok) throw storageError("google_drive_oauth_failed");
  const body = await response.json().catch(() => ({}));
  if (!body?.access_token) throw storageError("google_drive_oauth_failed");
  tokenCache.set(env, {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000
  });
  return body.access_token;
}

async function authorizedFetch(env, fetchImpl, url, init = {}, retry = true) {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${await accessToken(env, fetchImpl)}`
    }
  });
  if (response.status === 401 && retry) {
    tokenCache.delete(env);
    return authorizedFetch(env, fetchImpl, url, init, false);
  }
  return response;
}

function safeFileName(logicalKey) {
  return String(logicalKey)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(-220) || `report_${crypto.randomUUID()}.json`;
}

function appProperty(value, maxLength = 124) {
  return String(value ?? "").slice(0, maxLength);
}

export function createGoogleDriveStore(env, fetchImpl = globalThis.fetch) {
  if (!googleDriveStorageReady(env)) {
    throw storageError("google_drive_not_configured");
  }
  if (typeof fetchImpl !== "function") throw storageError("google_drive_fetch_unavailable");

  return {
    provider: "gdrive",

    async put(logicalKey, plaintext, metadata = {}) {
      const config = configuration(env);
      const boundary = `citadel_${crypto.randomUUID().replace(/-/g, "")}`;
      const envelope = await encryptReport(env, String(plaintext));
      const fileMetadata = {
        name: safeFileName(logicalKey),
        parents: [config.folderId],
        mimeType: "application/vnd.citadel.report+json",
        appProperties: {
          citadel_report_id: appProperty(metadata?.customMetadata?.report_id),
          citadel_sha256: appProperty(metadata?.customMetadata?.sha256),
          citadel_size_bytes: appProperty(metadata?.customMetadata?.size_bytes),
          citadel_key_version: appProperty(config.keyVersion)
        }
      };
      const body = [
        `--${boundary}`,
        "Content-Type: application/json; charset=UTF-8",
        "",
        JSON.stringify(fileMetadata),
        `--${boundary}`,
        "Content-Type: application/vnd.citadel.report+json",
        "",
        envelope,
        `--${boundary}--`,
        ""
      ].join("\r\n");
      const response = await authorizedFetch(
        env,
        fetchImpl,
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size",
        {
          method: "POST",
          headers: { "content-type": `multipart/related; boundary=${boundary}` },
          body
        }
      );
      if (!response.ok) throw storageError("google_drive_upload_failed");
      const uploaded = await response.json().catch(() => ({}));
      if (!uploaded?.id) throw storageError("google_drive_upload_failed");
      return uploaded.id;
    },

    async get(fileId) {
      const response = await authorizedFetch(
        env,
        fetchImpl,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        { method: "GET" }
      );
      if (response.status === 404) return null;
      if (!response.ok) throw storageError("google_drive_download_failed");
      const envelope = await response.text();
      return {
        async text() {
          return decryptReport(env, envelope);
        }
      };
    },

    async delete(fileId) {
      const response = await authorizedFetch(
        env,
        fetchImpl,
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
        { method: "DELETE" }
      );
      if (response.status !== 404 && !response.ok) {
        throw storageError("google_drive_delete_failed");
      }
    }
  };
}
