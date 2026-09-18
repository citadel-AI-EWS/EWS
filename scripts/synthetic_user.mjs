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

const forbiddenActionPattern = /(wipe|delete|shutdown|reboot|uninstall|terminate|stop all|pause all|update all|стер|удал|выключ|перезагруз|отключ|עצור|כבה)/i;

function addFinding(kind, page, detail) {
  report.ok = false;
  report.findings.push({ kind, page, detail });
}

async function inspectPage(route, interact) {
  const page = await context.newPage();
  const entry = { route, url: baseUrl + route, console_errors: [], page_errors: [], failed_requests: [], server_errors: [] };
  report.pages.push(entry);

  page.on("console", msg => {
    if (msg.type() === "error") entry.console_errors.push(msg.text().slice(0, 1000));
  });
  page.on("pageerror", error => entry.page_errors.push(String(error).slice(0, 1000)));
  page.on("requestfailed", request => {
    const failure = request.failure()?.errorText || "request failed";
    if (!request.url().startsWith("data:")) entry.failed_requests.push({ url: request.url(), failure });
  });
  page.on("response", response => {
    if (response.status() >= 500) entry.server_errors.push({ url: response.url(), status: response.status() });
  });

  try {
    const response = await page.goto(baseUrl + route, { waitUntil: "domcontentloaded", timeout });
    if (!response || response.status() >= 400) throw new Error(`navigation HTTP ${response?.status() ?? "no response"}`);
    await page.locator("body").waitFor({ state: "visible", timeout });
    await page.waitForTimeout(1200);

    const title = await page.title();
    if (!title.trim()) addFinding("missing_title", route, "Document title is empty");

    const bodyText = (await page.locator("body").innerText()).trim();
    if (bodyText.length < 20) addFinding("empty_page", route, "Visible page text is unexpectedly short");

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 40) addFinding("desktop_horizontal_overflow", route, `horizontal overflow ${overflow}px`);

    if (interact) await interact(page, entry);

    if (entry.console_errors.length) addFinding("console_error", route, entry.console_errors.join(" | ").slice(0, 1600));
    if (entry.page_errors.length) addFinding("page_error", route, entry.page_errors.join(" | ").slice(0, 1600));
    if (entry.server_errors.length) addFinding("server_5xx", route, JSON.stringify(entry.server_errors).slice(0, 1600));

    await page.screenshot({ path: path.join(outDir, route.replaceAll("/", "_") || "_root") + ".png", fullPage: true });
  } catch (error) {
    addFinding("scenario_failure", route, String(error).slice(0, 1600));
    try {
      await page.screenshot({ path: path.join(outDir, "failure" + route.replaceAll("/", "_") + ".png", fullPage: true });
    } catch {}
  } finally {
    await page.close();
  }
}

await inspectPage("/", async page => {
  await page.locator("#controllerStatus").waitFor({ state: "visible", timeout });
  await page.waitForFunction(() => {
    const el = document.getElementById("controllerStatus");
    return el && !el.textContent.includes("בודק");
  }, { timeout });

  for (const href of ["/hub/", "/architect/", "/prototype/"]) {
    const link = page.locator(`a[href="${href}"]`);
    if (await link.count() !== 1) addFinding("missing_navigation_link", "/", href);
  }
});

await inspectPage("/hub/", async page => {
  await page.locator("#refreshButton").click();
  await page.waitForTimeout(700);

  const search = page.locator("#nodeSearch");
  await search.fill("synthetic-no-such-node");
  await page.waitForTimeout(250);
  await search.fill("");

  const publicMode = (await page.locator("#modeLabel").innerText()).trim();
  if (publicMode !== "PUBLIC") addFinding("hub_public_mode", "/hub/", `expected PUBLIC, got ${publicMode}`);

  for (const id of ["exportButton", "updateAllButton", "pauseAllButton"]) {
    if (!(await page.locator("#" + id).isDisabled())) addFinding("privileged_button_enabled", "/hub/", id);
  }

  await page.locator("#sshHost").fill("ssh.example.invalid");
  await page.locator("#sshUser").fill("synthetic-user");
  const sshCommand = await page.locator("#sshCommand").innerText();
  if (!sshCommand.includes("ssh.example.invalid") || !sshCommand.includes("synthetic-user")) {
    addFinding("ssh_preview_broken", "/hub/", sshCommand.slice(0, 500));
  }
  await page.locator("#sshHost").fill("");
  await page.locator("#sshUser").fill("");

  await page.locator("#architectToken").fill("synthetic-invalid-token");
  await page.locator("#loginButton").click();
  await page.waitForTimeout(600);
  const afterInvalidLogin = (await page.locator("#modeLabel").innerText()).trim();
  if (afterInvalidLogin !== "PUBLIC") addFinding("invalid_auth_escalated", "/hub/", `mode became ${afterInvalidLogin}`);

  const buttons = await page.locator("button:visible").allTextContents();
  for (const label of buttons) {
    if (forbiddenActionPattern.test(label)) {
      // Presence is expected; synthetic user deliberately never executes destructive actions.
      continue;
    }
  }
});

await inspectPage("/architect/", async page => {
  const restrictedVisible = await page.locator("#secureContent:not(.hidden)").count();
  if (restrictedVisible) addFinding("architect_content_exposed", "/architect/", "secure content visible before authentication");

  await page.locator("#architectToken").fill("synthetic-invalid-token");
  await page.locator("#loginButton").click();
  await page.waitForTimeout(600);
  const stillLocked = await page.locator("#loginCard").isVisible();
  if (!stillLocked) addFinding("architect_invalid_auth", "/architect/", "invalid token appears to unlock Architect");

  const dangerous = ["#pauseButton", "#resumeButton", "#updateButton", "#restartButton", "#rollbackButton", "#disconnectButton"];
  for (const selector of dangerous) {
    if (await page.locator(selector).count()) {
      const disabled = await page.locator(selector).isDisabled().catch(() => true);
      if (!disabled && await page.locator("#secureContent").isVisible().catch(() => false)) {
        addFinding("dangerous_control_available_unauthenticated", "/architect/", selector);
      }
    }
  }
});

await inspectPage("/architect/logs/", async page => {
  const passwordInputs = await page.locator('input[type="password"]').count();
  if (passwordInputs < 1) addFinding("logs_auth_missing", "/architect/logs/", "no password/token input found");
});

await inspectPage("/prototype/", async page => {
  const langButton = page.locator("#langBtn");
  if (await langButton.count()) {
    const before = await langButton.innerText();
    await langButton.click();
    await page.waitForTimeout(150);
    const after = await langButton.innerText();
    if (before === after) addFinding("language_toggle_no_effect", "/prototype/", `label stayed ${before}`);
    await langButton.click();
  }

  const safeNav = page.locator("button.nav:visible");
  const count = Math.min(await safeNav.count(), 8);
  for (let i = 0; i < count; i += 1) {
    const button = safeNav.nth(i);
    const label = (await button.innerText()).trim();
    if (!label || forbiddenActionPattern.test(label)) continue;
    await button.click();
    await page.waitForTimeout(100);
  }
});

const mobile = await context.newPage();
const mobileEntry = { route: "/hub/ mobile", url: baseUrl + "/hub/", console_errors: [], page_errors: [], failed_requests: [], server_errors: [] };
report.pages.push(mobileEntry);
mobile.on("console", msg => { if (msg.type() === "error") mobileEntry.console_errors.push(msg.text().slice(0, 1000)); });
mobile.on("pageerror", error => mobileEntry.page_errors.push(String(error).slice(0, 1000)));
try {
  await mobile.setViewportSize({ width: 390, height: 844 });
  const response = await mobile.goto(baseUrl + "/hub/", { waitUntil: "domcontentloaded", timeout });
  if (!response || response.status() >= 400) throw new Error(`mobile navigation HTTP ${response?.status() ?? "no response"}`);
  await mobile.waitForTimeout(800);
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 20) addFinding("mobile_horizontal_overflow", "/hub/", `horizontal overflow ${overflow}px at 390px viewport`);
  await mobile.screenshot({ path: path.join(outDir, "hub-mobile.png"), fullPage: true });
} catch (error) {
  addFinding("mobile_scenario_failure", "/hub/", String(error).slice(0, 1600));
}
await mobile.close();

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
