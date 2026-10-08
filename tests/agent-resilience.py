"""Fault injection and real child-process checks for power guards and watchdog."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "agent"))
import citadel_node_v1 as node
import citadel_node_v2 as node_v2


class ResilienceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.agent = node.Agent(node.AgentConfig("https://example.invalid", Path(self.temp.name)))

    def test_windows_api_failure_is_retried_without_crashing(self):
        native = Mock(side_effect=[OSError("API failed"), 1, 1])
        api = SimpleNamespace(kernel32=SimpleNamespace(SetThreadExecutionState=native))
        with patch.object(node.os, "name", "nt"), patch.object(node.ctypes, "windll", api, create=True):
            self.assertFalse(self.agent.enforce_power_guard())
            self.assertFalse(self.agent.power_guard_active)
            self.assertTrue(self.agent.enforce_power_guard())
            self.agent.clear_power_guard()
        self.assertEqual([call.args[0] for call in native.call_args_list],
                         [0x80000001, 0x80000001, 0x80000000])

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux inhibitor")
    def test_unavailable_linux_inhibitor_is_not_advertised(self):
        with patch.object(node.shutil, "which", return_value=None) as find:
            self.assertFalse(self.agent.enforce_power_guard())
            self.assertFalse(self.agent.enforce_power_guard())
            self.assertNotIn("always_on_guard", self.agent.capabilities)
            self.assertEqual(find.call_count, 1, "missing helper must not be retried on every cycle")

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux pipe readiness")
    def test_linux_helper_lifetime_and_reacquisition(self):
        children = []
        def spawn(argv, **kwargs):
            self.assertIn("--what=sleep:idle", argv)
            self.assertFalse(kwargs["shell"])
            child = subprocess.Popen(argv[-3:], **kwargs)
            children.append(child)
            return child
        with patch.object(node.shutil, "which", return_value="/usr/bin/systemd-inhibit"), \
             patch.object(node, "_citadel_subprocess_popen", side_effect=spawn), \
             patch.object(node.time, "monotonic", return_value=1000):
            self.assertTrue(self.agent.enforce_power_guard())
            self.assertTrue(self.agent.enforce_power_guard())
            self.assertEqual(len(children), 1)
            self.assertIn("always_on_guard", self.agent.capabilities)
            children[0].terminate()
            children[0].wait(timeout=3)
        with patch.object(node.shutil, "which", return_value="/usr/bin/systemd-inhibit"), \
             patch.object(node, "_citadel_subprocess_popen", side_effect=spawn), \
             patch.object(node.time, "monotonic", return_value=1061):
            self.assertTrue(self.agent.enforce_power_guard())
            self.agent.clear_power_guard()
        self.assertEqual(len(children), 2)
        self.assertIsNotNone(children[-1].poll())
        self.assertFalse(self.agent.power_guard_active)

    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux pipe readiness")
    def test_inhibitor_denial_does_not_activate_guard(self):
        def spawn(argv, **kwargs):
            return subprocess.Popen([sys.executable, "-c", "raise SystemExit(1)"], **kwargs)
        with patch.object(node.shutil, "which", return_value="/usr/bin/systemd-inhibit"), \
             patch.object(node, "_citadel_subprocess_popen", side_effect=spawn):
            self.assertFalse(self.agent.enforce_power_guard())
            self.assertIsNone(self.agent.power_guard_process)

    def test_real_watchdog_process_exits_when_progress_stops(self):
        code = f"import sys,time; sys.path.insert(0,{str(ROOT / 'agent')!r}); from citadel_node_v1 import LocalWatchdog; w=LocalWatchdog(.25); w.start(); time.sleep(2)"
        result = subprocess.run([sys.executable, "-c", code], timeout=5, capture_output=True)
        self.assertEqual(result.returncode, 1, result.stderr)

    def test_long_operation_progress_prevents_watchdog_exit(self):
        code = f"""import sys,time
sys.path.insert(0,{str(ROOT / 'agent')!r})
from citadel_node_v1 import LocalWatchdog
w=LocalWatchdog(.25); w.start()
for _ in range(12):
    w.touch(); time.sleep(.05)
w.stop()
time.sleep(.3)
"""
        result = subprocess.run([sys.executable, "-c", code], timeout=5, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_once_and_unsupervised_runs_do_not_start_watchdog(self):
        self.agent.config.prevent_automatic_sleep = False
        self.agent.cycle = Mock(side_effect=KeyboardInterrupt)
        with patch.dict(os.environ, {}, clear=True), patch.object(node, "LocalWatchdog") as watchdog:
            self.assertEqual(self.agent.run(once=True), 0)
            self.assertEqual(self.agent.run(), 0)
            watchdog.assert_not_called()

    def test_supervised_run_starts_and_cleans_up_watchdog(self):
        self.agent.config.prevent_automatic_sleep = False
        self.agent.cycle = Mock(side_effect=KeyboardInterrupt)
        with patch.dict(os.environ, {"CITADEL_SUPERVISED": "1"}, clear=True), \
             patch.object(node, "LocalWatchdog") as watchdog:
            self.assertEqual(self.agent.run(), 0)
            watchdog.return_value.start.assert_called_once()
            watchdog.return_value.stop.assert_called_once()

    def test_long_operation_keeps_watchdog_live_during_hub_errors(self):
        self.agent.identity.set_node_id("node_test")
        self.agent.config.heartbeat_seconds = .02
        self.agent.heartbeat = Mock(side_effect=node.ControllerApiError(503, "quota"))
        exit_process = Mock()
        self.agent.watchdog = node.LocalWatchdog(.25, exit_process)
        self.agent.watchdog.start()
        try:
            with self.agent.long_operation():
                time.sleep(.5)
            exit_process.assert_not_called()
        finally:
            self.agent.watchdog.stop()

    def test_legacy_bridge_probe_uses_local_identity_without_network(self):
        config_path = Path(self.temp.name) / "config.json"
        config_path.write_text(
            '{"controller_url":"https://example.invalid","data_dir":'
            + __import__("json").dumps(self.temp.name) + "}",
            encoding="utf-8",
        )
        self.agent.identity.set_node_id("node_test")
        with patch.object(node_v2.Agent, "enroll", side_effect=AssertionError("network enroll")), \
             patch.object(node_v2.Agent, "heartbeat", side_effect=AssertionError("network heartbeat")):
            self.assertEqual(node_v2.controller_probe(config_path), 0)

    def test_legacy_bridge_probe_rejects_missing_identity(self):
        config_path = Path(self.temp.name) / "config.json"
        config_path.write_text(
            '{"controller_url":"https://example.invalid","data_dir":'
            + __import__("json").dumps(self.temp.name) + "}",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(RuntimeError, "not enrolled"):
            node_v2.controller_probe(config_path)

    def test_fresh_install_probe_enrolls_and_verifies_heartbeat_without_work(self):
        config_path = Path(self.temp.name) / "config.json"
        config_path.write_text(
            '{"controller_url":"https://example.invalid","data_dir":'
            + __import__("json").dumps(self.temp.name) + "}",
            encoding="utf-8",
        )
        self.assertIsNone(self.agent.identity.node_id)
        with patch.object(node_v2.Agent, "enroll", return_value="node_fresh") as enroll, \
             patch.object(node_v2.Agent, "heartbeat") as heartbeat, \
             patch.object(node_v2.Agent, "handle_commands", side_effect=AssertionError("consumed work")):
            self.assertEqual(node_v2.main(["enroll-probe", "--config", str(config_path)]), 0)
        enroll.assert_called_once_with()
        heartbeat.assert_called_once_with()

    def test_fresh_install_probe_propagates_controller_failure(self):
        config_path = Path(self.temp.name) / "config.json"
        config_path.write_text(
            '{"controller_url":"https://example.invalid","data_dir":'
            + __import__("json").dumps(self.temp.name) + "}",
            encoding="utf-8",
        )
        with patch.object(node_v2.Agent, "enroll", return_value="node_fresh"), \
             patch.object(node_v2.Agent, "heartbeat", side_effect=RuntimeError("controller unavailable")):
            with self.assertRaisesRegex(RuntimeError, "controller unavailable"):
                node_v2.main(["enroll-probe", "--config", str(config_path)])

    def test_supervised_update_delegates_restart_without_duplicate_process(self):
        self.agent.identity.set_node_id("node_test")
        self.agent.verify_controller_command = Mock(return_value=True)
        self.agent.ack_command = Mock()
        self.agent.apply_update = Mock()
        self.agent.heartbeat = Mock()
        response = {"commands": [{"command_id": "c1", "command_type": "update", "status": "pending"}]}
        with patch.dict(os.environ, {"CITADEL_SUPERVISED": "1"}, clear=True), \
             patch.object(node, "_citadel_subprocess_popen") as spawn:
            with self.assertRaises(SystemExit) as result:
                self.agent.handle_commands(response)
            self.assertEqual(result.exception.code, 75)
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
