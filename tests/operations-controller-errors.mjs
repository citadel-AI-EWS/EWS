import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import * as miniflare from "miniflare";
import { chromium } from "@playwright/test";

// Browser/protocol regression only: the actual Worker runs in workerd with local
// SQLite. No physical node, live D1, installation or model inference is claimed.
const root = process.env.OPERATIONS_TEST_ROOT || resolve(new URL("..", import.meta.url).pathname);
const evidence = process.env.OPERATIONS_EVIDENCE_DIR || "/tmp/ews-controller-errors";
await mkdir(evidence, { recursive: true });
const token = "local-" + randomUUID();
const bundle = await build({
  entryPoints: [resolve(root, "src/worker.js")], bundle: true,
  format: "esm", write: false, target: "es2022"
});
const options = {
  modules: true, script: bundle.outputFiles[0].text,
  compatibilityDate: "2026-09-05", d1Databases: ["DB"],
  bindings: { ARCHITECT_TOKEN_HASH: createHash("sha256").update(token).digest("hex") }
};
const mf = new miniflare.Miniflare(miniflare.convertV4MiniflareOptions
  ? miniflare.convertV4MiniflareOptions(options) : options);
let browser, server;
try {
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir(resolve(root, "migrations"))).filter(f => f.endsWith(".sql")).sort()) {
    const sql = (await readFile(resolve(root, "migrations", file), "utf8"))
      .replace(/^\s*--.*$/gm, "").replace(/\n/g, " ");
    await db.exec(sql);
  }
  const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
  const enrolled = await mf.dispatchFetch("http://localhost/api/v1/enroll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      public_key: publicKey, hostname: "sandbox-browser", os_name: "Linux",
      agent_version: "0.3.20", capabilities: ["project_python"]
    })
  });
  assert.equal(enrolled.status, 201);
  const nodeId = (await enrolled.json()).node.node_id;
  const html = await readFile(resolve(root, "operations.html"));
  server = createServer(async (req, res) => {
    try {
      if (!req.url.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html); return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await mf.dispatchFetch("http://localhost" + req.url, {
        method: req.method, headers: req.headers,
        ...(body.length ? { body } : {})
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {})
  });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.locator("#token").fill(token);
  await page.locator("#login button").click();
  await page.locator("#nodes h2").waitFor();
  await page.getByRole("button", { name: "Подробнее", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("nodeDetailState").textContent.startsWith("Сведения загружены"));

  // Seed only the pending-operation UI state. Real installation is a separate
  // acceptance test requiring the pinned Controller key and a supported node.
  await page.evaluate(() => startDetailProgressWatch(currentNode, "Protocol polling check"));
  await db.exec("ALTER TABLE node_hardware_state RENAME TO node_hardware_fault");
  const failed = await page.waitForResponse(r => r.url().endsWith("/details") && r.status() === 500);
  const failure = await failed.json();
  assert.match(failure.request_id, /^[0-9a-f-]{36}$/);
  await page.waitForFunction(id => document.getElementById("nodeDetailState").textContent.includes(id), failure.request_id);
  assert.match(await page.locator("#lmLiveStatus").innerText(), /Код ошибки/);
  assert.equal(await page.locator("#lmLiveStatus .spin").count(), 0);
  // The clock must not repaint a failed state poll as an optimistic spinner.
  await page.evaluate(() => updateClock());
  assert.equal(await page.locator("#lmLiveStatus .spin").count(), 0);
  await page.screenshot({ path: resolve(evidence, "controller-500.png"), fullPage: true });

  await page.locator("#detailRefresh").click();
  await page.waitForFunction(() => document.getElementById("nodeDetailState").textContent.includes("Код ошибки"));
  assert.match(await page.locator("#nodeDetailState").innerText(), /Controller/);
  await db.exec("ALTER TABLE node_hardware_fault RENAME TO node_hardware_state");
  await page.locator("#detailRefresh").click();
  await page.waitForFunction(() => document.getElementById("nodeDetailState").textContent.startsWith("Сведения загружены"));
  assert.equal(await page.locator("#lmLiveStatus .spin").count(), 1);
  await page.locator("#closeNode").click();

  await page.locator("#prompt").fill("Return exactly: CITADEL_E2E_OK_7391");
  await page.locator("#submitTask").click();
  await page.waitForFunction(() => document.getElementById("notice").textContent.startsWith("Задание не запущено"));
  assert.equal(await page.locator("#submitTask").isDisabled(), false);
  assert.equal(await page.locator("#prompt").inputValue(), "Return exactly: CITADEL_E2E_OK_7391");
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    scope: "LOCAL browser/protocol", node_id: nodeId,
    endpoint: "/api/v1/architect/nodes/" + nodeId + "/details",
    http_status: failed.status(), request_id: failure.request_id,
    quiet_error_visible: true, failure_spinner_stopped: true, retry_recovered: true
  }));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await mf.dispose();
}
