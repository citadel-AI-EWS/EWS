#!/usr/bin/env python3
from __future__ import annotations

import ast
import importlib.util
import json
import platform
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
        if isinstance(node.func, ast.Name):
            require(node.func.id not in {"eval", "exec"}, f"forbidden execution primitive: {node.func.id}")
        elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
            owner, name = node.func.value.id, node.func.attr
            require(
                not (owner == "os" and name in {"system", "popen"})
                and not (owner == "subprocess" and name in {"Popen", "run", "call", "check_call", "check_output"}),
                f"forbidden execution primitive: {owner}.{name}",
            )

spec = importlib.util.spec_from_file_location("citadel_ssh_console", SOURCE)
require(spec is not None and spec.loader is not None, "unable to load restricted SSH console")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

expected = {
    "help", "status", "hostname", "whoami", "uname -a", "python --version", "python3 --version",
    "uptime", "cpu", "memory", "disk", "network",
    "agent-status", "agent-logs", "lmstudio-status", "diagnostics", "ping-controller", "exit",
}
require(set(module.ALLOWED_COMMANDS) == expected, "SSH command allow-list changed unexpectedly")

with tempfile.TemporaryDirectory() as temp:
    config = Path(temp) / "config.json"
    config.write_text('{"controller_url":"https://127.0.0.1:9"}\n', encoding="utf-8")
    for command in ("help", "status", "hostname", "whoami", "uname -a", "python --version", "python3 --version", "uptime", "cpu", "memory", "disk", "network", "agent-status", "diagnostics"):
        output, should_exit = module.execute(command, config)
        require(isinstance(output, str) and output != "", f"{command} returned no output")
        require(should_exit is False, f"{command} unexpectedly closed the session")
    require(module.execute("python3 --version", config)[0] == f"Python {platform.python_version()}", "Python version did not come from the running interpreter")
    require(module.execute("uname -a", config)[0].startswith(platform.system() + " "), "uname did not report the running OS")
    for unsafe in ("bash", "cmd", "powershell", "ls", "dir", "cat /etc/passwd", "status; hostname", "status | cat", "python -c pass", "python3 -c pass"):
        output, should_exit = module.execute(unsafe, config)
        require(output.startswith("DENIED:"), f"unsafe command accepted: {unsafe}")
        require(should_exit is False, f"unsafe command closed session: {unsafe}")
    state_dir = Path(temp) / "custom-state"
    state_dir.mkdir()
    log_path = state_dir / "agent.jsonl"
    log_path.write_text(
        "old-secret-must-not-survive-bounded-tail\n"
        + ("x" * 100 + "\n") * 1000
        + "tail-one\ntail-two\n",
        encoding="utf-8",
    )
    config.write_text(
        json.dumps({"controller_url": "https://127.0.0.1:9", "data_dir": str(state_dir)}) + "\n",
        encoding="utf-8",
    )
    output, should_exit = module.execute("agent-logs", config)
    require(should_exit is False, "agent-logs unexpectedly closed the session")
    require("tail-two" in output, "agent-logs did not read the configured data_dir")
    require("old-secret-must-not-survive-bounded-tail" not in output, "agent-logs read beyond the bounded tail")
    require(len(output.encode("utf-8")) <= 64 * 1024, "agent-logs exceeded the bounded read budget")

    output, should_exit = module.execute("exit", config)
    require(should_exit is True, "exit did not close the session")

print("Restricted SSH console allow-list and no-shell contract: PASS")
