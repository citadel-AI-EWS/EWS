#!/usr/bin/env python3
from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))

import citadel_node_v1 as node  # noqa: E402


def make_agent(root: Path) -> node.Agent:
    return node.Agent(
        node.AgentConfig(
            "https://controller.example.invalid",
            root,
            allowed_wifi_profiles=("BackupWiFi",),
        )
    )


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
        }.get(name)
        node.time.sleep = lambda seconds: None

        # Primary network is retried three times before fallback is attempted.
        with tempfile.TemporaryDirectory() as temp:
            agent = make_agent(Path(temp))
            commands: list[list[str]] = []

            def fake_run(argv, **kwargs):
                commands.append([str(item) for item in argv])
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            node.subprocess.run = fake_run
            reachability = iter([False, False, False, True])
            agent.controller_reachable = lambda timeout=5.0: next(reachability)
            state = {
                "last_windows_wifi_profile": "HomeWiFi",
                "windows_profiles": ["HomeWiFi", "BackupWiFi"],
            }
            attempts: list[str] = []

            recovered = agent._recover_windows_network(state, attempts)

            assert recovered is True
            wlan = [cmd for cmd in commands if "wlan" in cmd]
            assert len(wlan) == 4, wlan
            assert all("name=HomeWiFi" in cmd for cmd in wlan[:3]), wlan
            assert "name=BackupWiFi" in wlan[3], wlan
            assert len([cmd for cmd in commands if "/renew" in cmd]) == 1, commands
            assert state["last_windows_wifi_profile"] == "BackupWiFi", state
            assert attempts[:4] == [
                "wifi_primary_retry:1:HomeWiFi",
                "dhcp_renew",
                "wifi_primary_retry:2:HomeWiFi",
                "wifi_primary_retry:3:HomeWiFi",
            ], attempts
            assert attempts[-1] == "wifi_fallback_profile:BackupWiFi", attempts

        # If the preferred network returns on the second retry, fallback is never touched.
        with tempfile.TemporaryDirectory() as temp:
            agent = make_agent(Path(temp))
            commands = []

            def fake_run_primary(argv, **kwargs):
                commands.append([str(item) for item in argv])
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            node.subprocess.run = fake_run_primary
            reachability = iter([False, True])
            agent.controller_reachable = lambda timeout=5.0: next(reachability)
            state = {
                "last_windows_wifi_profile": "HomeWiFi",
                "windows_profiles": ["HomeWiFi", "BackupWiFi"],
            }
            attempts = []

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
