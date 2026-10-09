"""Behavioral regressions for batching, fallback and acknowledged state changes."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import citadel_node_v1 as agent_module


class PollingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        config = agent_module.AgentConfig("https://example.test", Path(self.tmp.name))
        self.agent = agent_module.Agent(config)
        self.agent.identity.set_node_id("node_test")
        self.agent.enrollment_confirmed = True
        self.agent.enforce_power_guard = lambda: None
        self.agent.remember_network_profile = lambda: None
        self.agent.heartbeat_payload = lambda: {"agent_version": agent_module.VERSION}
        self.agent.probe_lmstudio = self.probe
        self.now = 1000.0
        clock = patch.object(agent_module.time, "monotonic", lambda: self.now)
        clock.start()
        self.addCleanup(clock.stop)
        self.calls = []
        self.error = None
        self.reply = {"ok": True, "node_status": "online", "commands": [], "assignments": []}
        self.agent.api.request = self.request
        self.executed = []
        self.agent.execute_assignment = self.executed.append

    def probe(self):
        self.agent.save_lmstudio_state(installed=True, server_running=True,
                                      loaded_model="test", live_checked_at=str(self.now))
        return self.agent.lmstudio_state()

    def request(self, method, path, body=None, **_kwargs):
        self.calls.append((method, path, body))
        if self.error and path.endswith("/sync"):
            raise RuntimeError(self.error)
        return self.reply

    def test_idle_cycle_has_one_request_and_periodic_ai_refresh(self):
        self.agent.cycle()
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.calls[0][1].endswith("/sync"))
        self.assertIn("heartbeat", self.calls[0][2])
        self.assertIn("ai", self.calls[0][2])
        self.now += 30
        self.agent.cycle()
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn("ai", self.calls[-1][2], "new probe timestamp must not force a write")
        self.now += 270
        self.agent.cycle()
        self.assertIn("ai", self.calls[-1][2], "unchanged AI state needs a five-minute refresh")

    def test_server_budget_hint_controls_idle_wait(self):
        self.reply['idle_poll_seconds'] = 90
        waits=[]
        def stop(seconds):
            waits.append(seconds)
            raise KeyboardInterrupt()
        self.agent.interruptible_sleep = stop
        self.assertEqual(self.agent.run(),0)
        self.assertEqual(waits,[90])
        self.assertEqual(len(self.calls),1)

    def test_ssh_and_hardware_snapshots_retry_until_sync_acknowledges(self):
        self.agent.heartbeat_payload = agent_module.Agent.heartbeat_payload.__get__(self.agent)
        self.error = "controller HTTP 503: unavailable"
        with patch.object(agent_module, "ssh_runtime_snapshot", return_value={"sshd_listening": True}), \
             patch.object(agent_module, "hardware_snapshot", return_value={"memory_total_bytes": 1024}), \
             patch.object(agent_module, "local_network_addresses", return_value={}):
            with self.assertRaises(RuntimeError):
                self.agent.cycle()
            self.assertIn("ssh", self.calls[-1][2]["heartbeat"])
            self.assertEqual(self.agent.last_ssh_report, 0)
            self.assertEqual(self.agent.last_hardware_report, 0)
            self.error = None
            self.agent.cycle()
            self.assertIn("ssh", self.calls[-1][2]["heartbeat"])
            self.assertEqual(self.agent.last_ssh_report, self.now)
            self.assertEqual(self.agent.last_hardware_report, self.now)
            self.now += 30
            self.agent.cycle()
            self.assertNotIn("ssh", self.calls[-1][2]["heartbeat"])
            self.assertNotIn("hardware", self.calls[-1][2]["heartbeat"])

    def test_changed_ai_progress_is_sent_immediately_and_failure_is_retried(self):
        self.agent.cycle()
        self.agent.report_ai_state(progress_phase="loading", progress_current=1)
        self.assertTrue(self.calls[-1][1].endswith("/ai-state"))
        count = len(self.calls)
        self.agent.report_ai_state(progress_phase="loading", progress_current=1)
        self.assertEqual(len(self.calls), count)
        original = self.agent.api.request

        def fail(*_args, **_kwargs):
            raise RuntimeError("controller HTTP 503: unavailable")

        self.agent.api.request = fail
        self.agent.report_ai_state(progress_current=2)
        self.agent.api.request = original
        self.agent.report_ai_state(progress_current=2)
        self.assertEqual(len(self.calls), count + 1)
        self.assertEqual(self.calls[-1][2]["progress_current"], 2)

    def test_long_command_keeps_runtime_lease_fresh_without_30s_duplicates(self):
        self.agent.cycle()
        self.agent._operation_depth = 1
        self.agent.report_ai_state(operation_id="command_test", progress_phase="loading")
        before = len(self.calls)
        self.now += 30
        self.agent.report_ai_state()
        self.assertEqual(len(self.calls), before)
        self.now += 30
        self.agent.report_ai_state()
        self.assertEqual(len(self.calls), before + 1)
        self.assertEqual(self.calls[-1][2]["operation_id"], "command_test")

    def test_only_missing_route_falls_back_and_upgrade_is_retried(self):
        self.error = "controller HTTP 404: not_found"
        self.agent.cycle()
        paths = [path for _, path, _ in self.calls]
        self.assertTrue(paths[0].endswith("/sync"))
        self.assertTrue(any(path.endswith("/commands") for path in paths))
        self.assertTrue(any(path.endswith("/heartbeat") for path in paths))
        self.assertTrue(any(path.endswith("/assignments") for path in paths))
        self.now += 30
        count = len(self.calls)
        self.agent.cycle()
        self.assertFalse(any(path.endswith("/sync") for _, path, _ in self.calls[count:]))
        self.now += 301
        self.error = None
        count = len(self.calls)
        self.agent.cycle()
        self.assertEqual(len(self.calls) - count, 1)
        self.assertTrue(self.calls[-1][1].endswith("/sync"))

    def test_auth_quota_and_transport_failures_never_fall_back(self):
        for error in ["controller HTTP 401: invalid_signature", "controller HTTP 403: node_revoked",
                      "controller HTTP 503: d1_write_limit", "connection failed"]:
            with self.subTest(error=error):
                self.calls.clear()
                self.error = error
                with self.assertRaises(RuntimeError):
                    self.agent.cycle()
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(self.agent.last_heartbeat, 0)
                self.assertIsNone(self.agent.last_ai_fingerprint)

    def test_assignments_pause_and_service_hold(self):
        self.reply["assignments"] = [{"assignment_id": "a1"}]
        self.agent.cycle()
        self.assertEqual(self.executed, [{"assignment_id": "a1"}])
        self.agent.paused_path.write_text("paused")
        self.now += 30
        self.agent.cycle()
        self.assertTrue(self.calls[-1][2]["paused"])
        self.assertEqual(len(self.executed), 1)
        self.agent.paused_path.unlink()
        self.reply["node_status"] = "paused"
        self.now += 30
        self.agent.cycle()
        self.assertEqual(len(self.executed), 1)
        self.agent.service_hold_path = Path(self.tmp.name) / "SERVICE_HOLD"
        self.agent.service_hold_path.write_text("hold")
        self.now += 30
        before = len(self.calls)
        self.agent.cycle()
        self.assertEqual(len(self.calls) - before, 1)
        self.assertTrue(self.calls[-1][1].endswith("/heartbeat"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
