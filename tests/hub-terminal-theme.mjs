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
  "prefers-reduced-motion:reduce",
  "avatar=el('div','>_','node-avatar')",
]) {
  assert.ok(hub.includes(required), `missing terminal-theme marker: ${required}`);
}

assert.ok(!hub.includes("avatar=el('div','🖥️','node-avatar')"), "legacy machine emoji returned");
assert.match(hub, /node-card\[data-status="offline"\].*offlineGlitch/s);
assert.match(hub, /body::before.*repeating-linear-gradient/s);

console.log("hub terminal theme guards: ok");
