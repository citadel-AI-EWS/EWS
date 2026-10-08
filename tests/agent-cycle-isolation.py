"""A failed task cannot starve the independent SSH transport or its evidence."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "agent"))
import citadel_node_v1 as v1
import citadel_node_v2 as v2


class IsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.agent = v2.Agent(v1.AgentConfig("https://example.invalid", Path(self.temp.name)))
        self.agent.identity.set_node_id("node_test")
        self.agent._ssh_relay_enabled = True
        self.agent.telemetry.flush = Mock()
        self.ready = threading.Event()
        self.release = threading.Event()
        self.agent._ssh_relay_worker = lambda node_id: (self.ready.set(), self.release.wait(2))

    def tearDown(self):
        self.release.set()
        if self.agent._ssh_relay_thread:
            self.agent._ssh_relay_thread.join(2)
        self.temp.cleanup()

    def test_ssh_and_telemetry_survive_failed_main_cycle(self):
        with patch.object(v1.Agent, "cycle", side_effect=RuntimeError("task failed")):
            with self.assertRaisesRegex(RuntimeError, "task failed"):
                self.agent.cycle()
        self.assertTrue(self.ready.wait(1))
        self.agent.telemetry.flush.assert_called_once()

    def test_telemetry_error_preserves_original_main_cycle_error(self):
        self.agent.telemetry.flush.side_effect = RuntimeError("telemetry failed")
        with patch.object(v1.Agent, "cycle", side_effect=RuntimeError("task failed")):
            with self.assertRaisesRegex(RuntimeError, "task failed"):
                self.agent.cycle()

    def test_quota_backoff_does_not_add_a_telemetry_request(self):
        self.agent.api.retry_delay = lambda: 30
        with patch.object(v1.Agent, "cycle", side_effect=v1.ControllerApiError(503, "quota", 30)):
            with self.assertRaises(v1.ControllerApiError):
                self.agent.cycle()
        self.agent.telemetry.flush.assert_not_called()

    def test_stop_marker_prevents_new_relay(self):
        self.agent.stop_path.write_text("stop")
        self.agent._start_ssh_relay()
        self.assertIsNone(self.agent._ssh_relay_thread)


if __name__ == "__main__":
    unittest.main()
