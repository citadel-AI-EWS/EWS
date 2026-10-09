import {spawn} from "node:child_process";
import {googleDriveNodeReportWriteTest} from "../src/index.js";

async function putSecrets(values) {
  // Secret bytes go through stdin; neither arguments nor output contain them.
  const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "secret", "bulk"],
    {stdio: ["pipe", "ignore", "ignore"], env: {...process.env, CI: "true"}});
  const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(values));
  try {
    await new Promise((resolve, reject) => {
      child.on("error", () => reject(new Error("drive_secret_sync_failed")));
      child.on("exit", code => code === 0 ? resolve() : reject(new Error("drive_secret_sync_failed")));
    });
  } finally {clearTimeout(timer);}
}

try {
  const proof = await googleDriveNodeReportWriteTest(process.env);
  if (process.argv.includes("--activate")) {
    // Use exactly the tested credential selection in the Worker. Explicitly
    // clear higher-priority stale credentials so the fingerprint also matches.
    const names = ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET",
      "GOOGLE_DRIVE_REFRESH_TOKEN", "GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON", "GOOGLE_DRIVE_AI_REPORTS_FOLDER_ID"];
    const values = Object.fromEntries(names.map(name => [name, String(process.env[name] || "").trim() || null]));
    values.GOOGLE_DRIVE_NODE_REPORTS_VERIFICATION = JSON.stringify(proof);
    await putSecrets(values);
  }
  console.log(JSON.stringify({status: "verified", live_write_verified: true, file_id: proof.file_id,
    folder_id: proof.folder_id, sha256: proof.sha256, activated: process.argv.includes("--activate")}, null, 2));
} catch (error) {
  const code = /^drive_[a-z_]+$/.test(error?.code || error?.message || "")
    ? error.code || error.message : "drive_write_test_failed";
  console.log(JSON.stringify({status: "blocked", live_write_verified: false, error: code}, null, 2));
  process.exitCode = 2;
}
