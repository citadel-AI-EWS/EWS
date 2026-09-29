import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import citadel_node_v1 as agent_mod  # noqa: E402


class SshReadinessProbeTests(unittest.TestCase):
    def setUp(self):
        self.agent = object.__new__(agent_mod.Agent)

    def test_ready_requires_real_ssh_and_active_ingress(self):
        with mock.patch.object(agent_mod.shutil, "which", side_effect=lambda name: f"/usr/bin/{name}"), \
             mock.patch.object(agent_mod.Agent, "_local_port_open", return_value=True), \
             mock.patch.object(agent_mod.Agent, "_ssh_protocol_banner", return_value=True), \
             mock.patch.object(agent_mod.Agent, "_process_running", return_value=True), \
             mock.patch.object(agent_mod.Agent, "_active_ssh_tunnel_hostname", return_value="terminal.example.com"):
            state = self.agent.probe_ssh_readiness()
        self.assertTrue(state["ssh_server_running"])
        self.assertTrue(state["tunnel_configured"])
        self.assertEqual(state["access_hostname"], "terminal.example.com")
        self.assertNotIn("access_mode", state)

    def test_unrelated_listener_and_tunnel_fail_closed(self):
        with mock.patch.object(agent_mod.shutil, "which", return_value="/usr/bin/sshd"), \
             mock.patch.object(agent_mod.Agent, "_local_port_open", return_value=True), \
             mock.patch.object(agent_mod.Agent, "_ssh_protocol_banner", return_value=False), \
             mock.patch.object(agent_mod.Agent, "_process_running", return_value=True), \
             mock.patch.object(agent_mod.Agent, "_active_ssh_tunnel_hostname", return_value=None):
            state = self.agent.probe_ssh_readiness()
        self.assertTrue(state["local_port_open"])
        self.assertFalse(state["ssh_server_running"])
        self.assertFalse(state["tunnel_configured"])

    def test_active_tunnel_must_have_matching_ssh_ingress(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.yml"
            config.write_text("ingress: # active tunnel\n  - hostname: terminal.example.com # mapped host\n    service: ssh://localhost:22 # browser SSH\n  - service: http_status:404\n")
            process = mock.Mock(info={"name": "cloudflared", "cmdline": ["cloudflared", "--config", str(config), "tunnel", "run"]})
            with mock.patch.object(agent_mod.psutil, "process_iter", return_value=[process]):
                self.assertEqual(self.agent._active_ssh_tunnel_hostname(), "terminal.example.com")
            config.write_text("ingress:\n  - hostname: terminal.example.com\n    service: http://localhost:8080\n")
            with mock.patch.object(agent_mod.psutil, "process_iter", return_value=[process]):
                self.assertIsNone(self.agent._active_ssh_tunnel_hostname())

    def test_banner_accepts_fifty_preidentification_lines(self):
        data = (b"notice\r\n" * 50) + b"SSH-2.0-OpenSSH_9.0\r\n"
        connection = mock.MagicMock()
        connection.__enter__.return_value = connection
        connection.recv.side_effect = [bytes([byte]) for byte in data]
        with mock.patch.object(agent_mod.socket, "create_connection", return_value=connection):
            self.assertTrue(self.agent._ssh_protocol_banner())


if __name__ == "__main__":
    unittest.main()
