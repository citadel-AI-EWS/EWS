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
  'id="cyberArt"',
  "art-mask-left",
  "art-network-bottom",
  "art-mask-right",
  "art-globe-left",
  "art-hood-right",
  "document.body.classList.toggle('authenticated',Boolean(token))",
  "prefers-reduced-motion:reduce",
  "avatar=el('div','>_','node-avatar')",
]) {
  assert.ok(hub.includes(required), `missing terminal-theme marker: ${required}`);
}

assert.ok(!hub.includes("avatar=el('div','🖥️','node-avatar')"), "legacy machine emoji returned");
assert.match(hub, /node-card\[data-status="offline"\].*offlineGlitch/s);
assert.match(hub, /body::before.*repeating-linear-gradient/s);

console.log("hub terminal theme guards: ok");

assert.match(hub, /<svg class="login-only art-mask-left[\s\S]*CONTROL IS AN ILLUSION\./);
assert.match(hub, /<svg class="hub-only art-globe-left[\s\S]*BLACK ARMY \/ RED ARMY \/ SHADOW ARMY/);
