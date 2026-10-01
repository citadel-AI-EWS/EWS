#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "agent" / "ssh_configurator.py"

spec = importlib.util.spec_from_file_location("citadel_ssh_configurator", SOURCE)
if spec is None or spec.loader is None:
    raise RuntimeError("unable to load SSH configurator")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


sample = """# OpenSSH sample
Port 2222
ListenAddress 0.0.0.0
PasswordAuthentication yes

Match Group administrators
    AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
"""

rendered = module.render_config(
    sample,
    user="operator",
    python_path=r"C:\ProgramData\CitadelEWS\agent\releases\0.3.27\.venv\Scripts\python.exe",
    console_path=r"C:\ProgramData\CitadelEWS\agent\releases\0.3.27\ssh_restricted_console.py",
    agent_config_path=r"C:\ProgramData\CitadelEWS\agent\releases\0.3.27\config.json",
)
inspection = module.inspect_config(rendered, user="operator")
require(inspection["ready"] is True, "rendered config is not ready")
require(inspection["loopback_only_configured"] is True, "loopback listener missing")
require(inspection["force_command_configured"] is True, "ForceCommand missing")
require(inspection["forwarding_disabled"] is True, "forwarding restrictions missing")
require("# CITADEL disabled original: Port 2222" in rendered, "original non-22 port was not disabled")
require("# CITADEL disabled original: ListenAddress 0.0.0.0" in rendered, "external listener was not disabled")
require(rendered.index(module.GLOBAL_BEGIN) < rendered.index("Match Group administrators"), "global managed block must precede existing Match rules")
require(rendered.index(module.USER_BEGIN) < rendered.index("Match Group administrators"), "restricted user rule must precede existing Match rules")
require(rendered.count(module.GLOBAL_BEGIN) == 1 and rendered.count(module.USER_BEGIN) == 1, "managed blocks duplicated")

rerendered = module.render_config(
    rendered,
    user="operator",
    python_path=r"C:\ProgramData\CitadelEWS\agent\releases\0.3.27\.venv\Scripts\python.exe",
    console_path=r"C:\ProgramData\CitadelEWS\agent\releases\0.3.27\ssh_restricted_console.py",
    agent_config_path=r"C:\ProgramData\CitadelEWS\agent\releases\0.3.27\config.json",
)
require(rerendered == rendered, "SSH config rendering is not idempotent")

try:
    module.render_config(
        sample,
        user="operator;whoami",
        python_path="/opt/citadel/python",
        console_path="/opt/citadel/ssh_restricted_console.py",
        agent_config_path="/opt/citadel/config.json",
    )
except module.ConfigError:
    pass
else:
    raise RuntimeError("unsafe SSH username was accepted")

conflict = """Port 22
Match User operator
    ForceCommand /usr/bin/false
"""
try:
    module.render_config(
        conflict,
        user="operator",
        python_path="/opt/citadel/python",
        console_path="/opt/citadel/ssh_restricted_console.py",
        agent_config_path="/opt/citadel/config.json",
    )
except module.ConfigError:
    pass
else:
    raise RuntimeError("pre-existing ForceCommand conflict was silently overwritten")

with tempfile.TemporaryDirectory() as temp:
    path = Path(temp) / "sshd_config"
    path.write_text(rendered, encoding="utf-8")
    round_trip = module.inspect_config(path.read_text(encoding="utf-8"), user="operator")
    require(round_trip["ready"] is True, "round-trip inspection failed")

print("CITADEL SSH config renderer/inspection: PASS")
