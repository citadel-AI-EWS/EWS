#!/usr/bin/env python3
from __future__ import annotations

import ast
import importlib.util
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "agent" / "ssh_restricted_console.py"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


tree = ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE))
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        require(all(alias.name != "subprocess" for alias in node.names), "restricted SSH console imports subprocess")
    if isinstance(node, ast.ImportFrom):
        require(node.module != "subprocess", "restricted SSH console imports subprocess")
    if isinstance(node, ast.Call):
        name = ""
        if isinstance(node.func, ast.Name):
            name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            name = node.func.attr
        require(name not in {"system", "popen", "Popen", "run", "call", "check_call", "check_output", "eval", "exec"}, f"forbidden execution primitive: {name}")

spec = importlib.util.spec_from_file_location("citadel_ssh_console", SOURCE)
require(spec is not None and spec.loader is not None, "unable to load restricted SSH console")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

expected = {
    "help", "status", "hostname", "uptime", "cpu", "memory", "disk", "network",
    "agent-status", "agent-logs", "lmstudio-status", "diagnostics", "ping-controller", "exit",
}
require(set(module.ALLOWED_COMMANDS) == expected, "SSH command allow-list changed unexpectedly")

with tempfile.TemporaryDirectory() as temp:
    config = Path(temp) / "config.json"
    config.write_text('{"controller_url":"https://127.0.0.1:9"}\n', encoding="utf-8")
    for command in ("help", "status", "hostname", "uptime", "cpu", "memory", "disk", "network", "agent-status", "diagnostics"):
        output, should_exit = module.execute(command, config)
        require(isinstance(output, str) and output != "", f"{command} returned no output")
        require(should_exit is False, f"{command} unexpectedly closed the session")
    for unsafe in ("bash", "cmd", "powershell", "whoami", "ls", "dir", "cat /etc/passwd", "status; hostname", "status | cat", "python -c pass"):
        output, should_exit = module.execute(unsafe, config)
        require(output.startswith("DENIED:"), f"unsafe command accepted: {unsafe}")
        require(should_exit is False, f"unsafe command closed session: {unsafe}")
    output, should_exit = module.execute("exit", config)
    require(should_exit is True, "exit did not close the session")

print("Restricted SSH console allow-list and no-shell contract: PASS")
