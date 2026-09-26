#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import citadel_node_v1 as node  # noqa: E402


def make_agent(root: Path) -> node.Agent:
    config = node.AgentConfig(
        "https://controller.example.invalid",
        root,
        allowed_wifi_profiles=("BackupWiFi",),
    )
    agent = node.Agent(config)
    agent.last_network_recovery = -10000.0
    return agent


def main() -> int:
    original_which = node.shutil.which
    original_run = node.subprocess.run
    original_sleep = node.time.sleep
    try:
        node.shutil.which = lambda name: {
            "netsh.exe": "C:/Windows/System32/netsh.exe",
            "netsh": "C:/Windows/System32/netsh.exe",
            "ipconfig.exe": "C:/Windows/System32/ipconfig.exe",
            "ipconfig": "C:/Windows/System32/ipconfig.exe",
            "powershell.exe": "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
            "powershell": "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        }.get(name)
        node.time.sleep = lambda seconds: None

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            agent = make_agent(root)
            agent.network_recovery_path.write_text(
                json.dumps({
                    "last_windows_wifi_profile": "HomeWiFi",
                    "windows_profiles": ["HomeWiFi", "BackupWiFi"],
                }),
                encoding="utf-8",
            )
            commands: list[list[str]] = []

            def fake_run(argv, **kwargs):
                commands.append([str(item) for item in argv])
                # The PowerShell remember probe returns no data, preserving state.
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            node.subprocess.run = fake_run
            reachability = iter([False, False, False, False, True])
            agent.controller_reachable = lambda timeout=5.0: next(reachability)

            attempts: list[str] = []
            recovered = agent._recover_windows_network(
                json.loads(agent.network_recovery_path.read_text(encoding="utf-8")), attempts
            )
            assert recovered is True

            wlan = [cmd for cmd in commands if "wlan" in cmd]
            assert len(wlan) == 4, wlan
            assert all("name=HomeWiFi" in cmd for cmd in wlan[:3]), wlan
            assert "name=BackupWiFi" in wlan[3], wlan
            renew = [cmd for cmd in commands if any("/renew" == part for part in cmd)]
            assert len(renew) == 1, commands
            state = {
                "last_windows_wifi_profile": "HomeWiFi",
                "windows_profiles": ["HomeWiFi", "BackupWiFi"],
            }
            attempts = []
            reachability = iter([False, False, False, True])
            agent.controller_reachable = lambda timeout=5.0: next(reachability)
            commands.clear()
            recovered = agent._recover_windows_network(state, attempts)
            assert recovered is True
            wlan = [cmd for cmd in commands if "wlan" in cmd]
            assert len(wlan) == 4, wlan
            assert all("name=HomeWiFi" in cmd for cmd in wlan[:3]), wlan
            assert "name=BackupWiFi" in wlan[3], wlan
            assert state["last_windows_wifi_profile"] == "BackupWiFi", state

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            agent = make_agent(root)
            agent.network_recovery_path.write_text(
                json.dumps({
                    "last_windows_wifi_profile": "HomeWiFi",
                    "windows_profiles": ["HomeWiFi", "BackupWiFi"],
                }),
                encoding="utf-8",
            )
            commands = []

            def fake_run_primary(argv, **kwargs):
                commands.append([str(item) for item in argv])
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            node.subprocess.run = fake_run_primary
            reachability = iter([False, False, True])
            agent.controller_reachable = lambda timeout=5.0: next(reachability)

            state = {
                "last_windows_wifi_profile": "HomeWiFi",
                "windows_profiles": ["HomeWiFi", "BackupWiFi"],
            }
            attempts: list[str] = []
            recovered = agent._recover_windows_network(state, attempts)
            assert recovered is True

            wlan = [cmd for cmd in commands if "wlan" in cmd]
            assert len(wlan) == 2, wlan
            assert all("name=HomeWiFi" in cmd for cmd in wlan), wlan
            assert not any("name=BackupWiFi" in cmd for cmd in wlan), wlan
            assert state["last_windows_wifi_profile"] == "HomeWiFi", state

        print("Preferred-network recovery and bounded fallback: PASS")
        return 0
    finally:
        node.shutil.which = original_which
        node.subprocess.run = original_run
        node.time.sleep = original_sleep


if __name__ == "__main__":
    raise SystemExit(main())
