import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import citadel_node_v1 as agent_mod  # noqa: E402


class SshReadinessProbeTests(unittest.TestCase):
    def setUp(self):
        self.agent = object.__new__(agent_mod.Agent)

    def test_ready_browser_access(self):
        def which(name):
            return {
                "sshd": "/usr/sbin/sshd",
                "cloudflared": "/usr/local/bin/cloudflared",
            }.get(name)

        env = {
            "CITADEL_SSH_ACCESS_HOSTNAME": "node-1.example.com",
            "CITADEL_SSH_ACCESS_MODE": "browser",
        }
        with mock.patch.object(agent_mod.shutil, "which", side_effect=which),              mock.patch.object(agent_mod.Agent, "_local_port_open", return_value=True), mock.patch.object(agent_mod.Agent, "_ssh_protocol_banner", return_value=True),              mock.patch.object(agent_mod.Agent, "_process_running", side_effect=lambda names: "cloudflared" in names or "sshd" in names),              mock.patch.dict(os.environ, env, clear=False):
            state = self.agent.probe_ssh_readiness()

        self.assertTrue(state["ssh_server_installed"])
        self.assertTrue(state["ssh_server_running"])
        self.assertTrue(state["local_port_open"])
        self.assertTrue(state["cloudflared_installed"])
        self.assertTrue(state["cloudflared_running"])
        self.assertTrue(state["tunnel_configured"])
        self.assertNotIn("access_hostname", state)

    def test_non_ssh_listener_does_not_confirm_server(self):
        with mock.patch.object(agent_mod.shutil, "which", return_value="/usr/sbin/sshd"), mock.patch.object(agent_mod.Agent, "_local_port_open", return_value=True), mock.patch.object(agent_mod.Agent, "_process_running", return_value=True), mock.patch.object(agent_mod.Agent, "_ssh_protocol_banner", return_value=False):
            state = self.agent.probe_ssh_readiness()
        self.assertTrue(state["local_port_open"])
        self.assertFalse(state["ssh_server_running"])

    def test_hostname_is_bounded_and_probe_does_not_invent_tunnel(self):
        def which(name):
            return "/usr/sbin/sshd" if name == "sshd" else None

        env = {
            "CITADEL_SSH_ACCESS_HOSTNAME": "bad host;rm -rf",
            "CITADEL_SSH_ACCESS_MODE": "browser",
        }
        with mock.patch.object(agent_mod.shutil, "which", side_effect=which),              mock.patch.object(agent_mod.Agent, "_local_port_open", return_value=False),              mock.patch.object(agent_mod.Agent, "_process_running", return_value=False),              mock.patch.dict(os.environ, env, clear=False):
            state = self.agent.probe_ssh_readiness()

        self.assertTrue(state["ssh_server_installed"])
        self.assertFalse(state["ssh_server_running"])
        self.assertFalse(state["local_port_open"])
        self.assertFalse(state["cloudflared_installed"])
        self.assertFalse(state["cloudflared_running"])
        self.assertFalse(state["tunnel_configured"])
        self.assertNotIn("access_hostname", state)


if __name__ == "__main__":
    unittest.main()
