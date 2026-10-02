import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hub = readFileSync("operations.html", "utf8");

for (const required of [
  "CITADEL TERMINAL GLITCH THEME v1",
  'class="terminal-strip"',
  'id="terminalPhrase"',
  'id="terminalNodes"',
  'id="terminalOnline"',
  'id="terminalAi"',
  'id="terminalSystem"',
  "function updateTerminalHud",
  "function rotateTerminalPhrase",
  "CONTROL / DEPLOY / MONITOR / SURVIVE.",
  "MAFIA IS NOT CHAOS. IT IS ORDER WITH PRIVATE RULES.",
  "ИСТОРИЯ ПОМНИТ ПОБЕДИТЕЛЕЙ. ЛОГИ ПОМНЯТ ВСЕХ.",
  "Math.floor(Math.random()*terminalPhrases.length)",
  "CITADEL CYBER ART LAYER v1",
  "CITADEL CHROME 80S APPROVED MOCKUP v2",
  "CITADEL EXACT CONCEPT LOGIN + OS NODE ICONS v3",
  "function nodeOsKind",
  "function nodeOsAvatar",
  "function nodeOsBadge",
  "os-windows",
  "os-linux",
  "RED ARMY   ·   BLACK ARMY   ·   SHADOW ARMY",
  'id="chromeSubbrand"',
  'id="chromeStats"',
  'id="chromeLogsPreview"',
  'id="chromeSshQuick"',
  'id="chromeAiQuick"',
  'id="taskExecution"',
  'class="chrome-global"',
  "AUTHORIZED PERSONNEL ONLY // ALL ACTIVITY MONITORED",
  "BLACK ARMY / RED ARMY / SHADOW ARMY",
  'id="cyberArt"',
  "art-mask-left",
  "art-network-bottom",
  "art-mask-right",
  "art-globe-left",
  "art-hood-right",
  "document.body.classList.toggle('authenticated',Boolean(token))",
  "prefers-reduced-motion:reduce",
]) {
  assert.ok(hub.includes(required), `missing terminal-theme marker: ${required}`);
}

assert.ok(!hub.includes("avatar=el('div','🖥️','node-avatar')"), "legacy machine emoji returned");
assert.match(hub, /node-card\[data-status="offline"\].*offlineGlitch/s);
assert.match(hub, /body::before.*repeating-linear-gradient/s);

console.log("hub terminal theme guards: ok");

assert.match(hub, /<svg class="login-only art-mask-left[\s\S]*CONTROL IS AN ILLUSION\./);
assert.match(hub, /<svg class="hub-only art-globe-left[\s\S]*BLACK ARMY \/ RED ARMY \/ SHADOW ARMY/);

assert.match(hub, /class="brand-lockup"[\s\S]*CITADEL[\s\S]*chromeSubbrand/);
assert.match(hub, /id="auth"[\s\S]*ACCESS KEY[\s\S]*LOGIN/);
assert.match(hub, /chrome-upper-grid[\s\S]*id="nodes"[\s\S]*SYSTEM LOGS/);
assert.match(hub, /chrome-lower-grid[\s\S]*SSH ACCESS[\s\S]*AI \/ LM STUDIO[\s\S]*id="d1Overview"[\s\S]*id="taskExecution"/);

assert.ok(!hub.includes("avatar=el('div','>_','node-avatar')"), "legacy terminal-only node avatar returned");
assert.match(hub, /function nodeOsKind\(n\)[\s\S]*windows[\s\S]*linux/);
assert.match(hub, /function nodeOsAvatar\(n\)[\s\S]*os-avatar[\s\S]*viewBox/);
assert.match(hub, /nodeOsBadge\(n\)[\s\S]*WINDOWS[\s\S]*LINUX/);
assert.match(hub, /body:not\(\.authenticated\) \.art-hood-right[\s\S]*body:not\(\.authenticated\) \.art-globe-left/);
