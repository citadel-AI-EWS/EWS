import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || process.env.CITADEL_BASE_URL || "https://citadel-ai.init1.workers.dev").replace(/\/$/, "");
const outDir = process.env.SYNTHETIC_OUT_DIR || "synthetic-artifacts";
const timeout = Number(process.env.SYNTHETIC_TIMEOUT_MS || 20000);

await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1365, height: 900 },
  locale: "ru-RU",
  timezoneId: "Asia/Jerusalem"
});

const report = {
  ok: true,
  base_url: baseUrl,
  started_at: new Date().toISOString(),
  persona: {
    name: "Nina Synthetic",
    role: "cautious test user",
    permissions: "public UI + negative authentication checks only"
  },
  pages: [],
  findings: []
};

function addFinding(kind, page, detail) {
  report.ok = false;
  report.findings.push({ kind, page, detail });
}

function attachObservers(page, entry) {
  page.on("console", msg => {
    if (msg.type() !== "error") return;
    const value = msg.text().slice(0, 1000);
    if (entry.auth_probe_active && /status of 401/i.test(value)) {
      entry.expected_auth_console_errors += 1;
      return;
    }
    entry.console_errors.push(value);
  });
  page.on("pageerror", error => entry.page_errors.push(String(error).slice(0, 1000)));
  page.on("requestfailed", request => {
    if (!request.url().startsWith("data:")) {
      entry.failed_requests.push({
        url: request.url(),
        failure: request.failure()?.errorText || "request failed"
      });
    }
  });
  page.on("response", response => {
    if (entry.auth_probe_active && response.status() === 401) {
      entry.expected_auth_401 += 1;
      return;
    }
    if (response.status() >= 500) {
      entry.server_errors.push({ url: response.url(), status: response.status() });
    }
  });
}

async function open(route, expectedHash = "") {
  const page = await context.newPage();
  const entry = {
    route,
    url: baseUrl + route,
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    server_errors: [],
    auth_probe_active: false,
    expected_auth_401: 0,
    expected_auth_console_errors: 0
  };
  report.pages.push(entry);
  attachObservers(page, entry);

  const response = await page.goto(baseUrl + route, { waitUntil: "domcontentloaded", timeout });
  if (!response || response.status() >= 400) {
    throw new Error(`navigation HTTP ${response?.status() ?? "no response"}`);
  }
  await page.locator("body").waitFor({ state: "visible", timeout });
  await page.locator("#login").waitFor({ state: "visible", timeout });

  const visible = new URL(page.url());
  if (visible.pathname !== "/" || visible.search || visible.hash !== expectedHash) {
    addFinding("unexpected_console_route", route, `expected /${expectedHash}, got ${visible.pathname}${visible.search}${visible.hash}`);
  }
  if (!(await page.title()).trim()) addFinding("missing_title", route, "Document title is empty");

  const bodyText = (await page.locator("body").innerText()).trim();
  if (bodyText.length < 20) addFinding("empty_page", route, "Visible page text is unexpectedly short");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 40) addFinding("desktop_horizontal_overflow", route, `horizontal overflow ${overflow}px`);

  return { page, entry };
}

async function closeChecked(page, entry, route, screenshotName) {
  if (entry.console_errors.length) addFinding("console_error", route, entry.console_errors.join(" | ").slice(0, 1600));
  if (entry.page_errors.length) addFinding("page_error", route, entry.page_errors.join(" | ").slice(0, 1600));
  if (entry.server_errors.length) addFinding("server_5xx", route, JSON.stringify(entry.server_errors).slice(0, 1600));
  await page.screenshot({ path: path.join(outDir, screenshotName), fullPage: true });
  await page.close();
}

// The deployed product is the consolidated Operations console at /.
// It must remain locked until a valid Architect token is supplied.
{
  const { page, entry } = await open("/");
  try {
    if (!(await page.locator("#auth").isVisible())) addFinding("auth_not_visible", "/", "login panel is not visible");
    if (await page.locator("#machines").isVisible()) addFinding("machines_exposed", "/", "machine controls visible before authentication");
    if (await page.locator("#logs").isVisible()) addFinding("logs_exposed", "/", "logs visible before authentication");

    for (const selector of ["#refresh", "#submitTask", "#lmInstall", "#nodeQuery", "#detailShutdown", "#detailUninstall"]) {
      if (await page.locator(selector).count() !== 1) addFinding("missing_control", "/", selector);
    }

    for (const selector of ["#sshDialog", "#sshHost", "#sshUser", "#sshProbe", "#sshOpen", "#sshInlineInput", "#sshInlineSend"]) {
      if (await page.locator(selector).count() !== 1) addFinding("missing_ssh_control", "/", selector);
    }
    if (await page.locator('#sshDialog a[href="/hub/"]').count()) {
      addFinding("legacy_ssh_redirect", "/", "deployed Machines console still sends SSH users to the retired /hub/ route");
    }

    entry.auth_probe_active = true;
    const invalidAuthStatus = await page.evaluate(async () => {
      const response = await fetch("/api/v1/architect/machines", {
        method: "GET",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer synthetic-invalid-token"
        }
      });
      return response.status;
    });
    if (invalidAuthStatus !== 401) {
      addFinding("invalid_auth_not_rejected", "/", `invalid token returned HTTP ${invalidAuthStatus}, expected 401`);
    }

    await page.locator("#token").fill("synthetic-invalid-token");
    await page.locator("#login").evaluate(form => form.requestSubmit());
    await page.waitForTimeout(500);
    entry.auth_probe_active = false;
    if (!(await page.locator("#auth").isVisible())) {
      addFinding("invalid_auth_unlocked", "/", "invalid token hid login panel");
    }
    if (await page.locator("#machines").isVisible()) {
      addFinding("invalid_auth_exposed_controls", "/", "invalid token exposed machine controls");
    }
  } catch (error) {
    addFinding("scenario_failure", "/", String(error).slice(0, 1600));
  }
  await closeChecked(page, entry, "/", "root.png");
}

// Compatibility URLs must land on the same deployed console, not revive stale pages.
for (const route of ["/hub/", "/architect/"]) {
  let page, entry;
  try {
    ({ page, entry } = await open(route));
    if (!(await page.locator("#auth").isVisible())) {
      addFinding("compatibility_route_not_locked", route, "redirected console is not showing login");
    }
  } catch (error) {
    addFinding("scenario_failure", route, String(error).slice(0, 1600));
  }
  if (page) await closeChecked(page, entry, route, route.includes("hub") ? "compat-hub.png" : "compat-architect.png");
}

// Logs compatibility URL intentionally resolves to /#logs. Authentication still gates the data.
{
  let page, entry;
  try {
    ({ page, entry } = await open("/architect/logs/", "#logs"));
    if (!(await page.locator("#auth").isVisible())) addFinding("logs_auth_missing", "/architect/logs/", "login panel is not visible");
    if (await page.locator("#logs").isVisible()) addFinding("logs_exposed", "/architect/logs/", "logs visible without authentication");
  } catch (error) {
    addFinding("scenario_failure", "/architect/logs/", String(error).slice(0, 1600));
  }
  if (page) await closeChecked(page, entry, "/architect/logs/", "compat-logs.png");
}

// Mobile acceptance tests the actual root console.
{
  const page = await context.newPage();
  const entry = {
    route: "/ mobile",
    url: baseUrl + "/",
    console_errors: [],
    page_errors: [],
    failed_requests: [],
    server_errors: [],
    auth_probe_active: false,
    expected_auth_401: 0,
    expected_auth_console_errors: 0
  };
  report.pages.push(entry);
  attachObservers(page, entry);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded", timeout });
    if (!response || response.status() >= 400) throw new Error(`mobile navigation HTTP ${response?.status() ?? "no response"}`);
    await page.locator("#login").waitFor({ state: "visible", timeout });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 20) addFinding("mobile_horizontal_overflow", "/", `horizontal overflow ${overflow}px at 390px viewport`);
    await page.screenshot({ path: path.join(outDir, "root-mobile.png"), fullPage: true });
  } catch (error) {
    addFinding("mobile_scenario_failure", "/", String(error).slice(0, 1600));
  }
  if (entry.console_errors.length) addFinding("mobile_console_error", "/", entry.console_errors.join(" | ").slice(0, 1600));
  if (entry.page_errors.length) addFinding("mobile_page_error", "/", entry.page_errors.join(" | ").slice(0, 1600));
  if (entry.server_errors.length) addFinding("mobile_server_5xx", "/", JSON.stringify(entry.server_errors).slice(0, 1600));
  await page.close();
}

report.finished_at = new Date().toISOString();
await fs.writeFile(path.join(outDir, "synthetic-user-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
await browser.close();

console.log(JSON.stringify({
  ok: report.ok,
  persona: report.persona.name,
  pages_checked: report.pages.length,
  findings: report.findings.length,
  report: path.join(outDir, "synthetic-user-report.json")
}));

if (!report.ok) {
  for (const finding of report.findings) console.error(JSON.stringify(finding));
  process.exit(1);
}
