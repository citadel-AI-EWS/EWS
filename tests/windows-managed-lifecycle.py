"""Exercise actual lifecycle methods with mocked transport; no live hub required."""
import ast
import os
from pathlib import Path
import subprocess
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch
from typing import Any

SOURCE = Path(__file__).resolve().parents[1] / 'agent/citadel_node_v1.py'
parsed = ast.parse(SOURCE.read_text(encoding="utf-8"))
agent = next(n for n in parsed.body if isinstance(n, ast.ClassDef) and n.name == 'Agent')
methods = [n for n in agent.body if isinstance(n, ast.FunctionDef) and n.name in
           {'handle_commands', 'cycle', 'interruptible_sleep'}]
namespace = dict(os=os, time=time, Path=Path, subprocess=subprocess, Any=Any,
                 SERVICE_STOP_EXIT_CODE=76, SERVICE_RESTART_EXIT_CODE=75)
exec(compile(ast.Module(body=methods, type_ignores=[]), str(SOURCE), 'exec'), namespace)


class LifecycleTests(unittest.TestCase):
    def test_managed_commands_do_not_spawn_another_agent(self):
        for mode in ('service', 'task'):
            for command, code in [('stop', 76), ('restart', 75), ('update', 75), ('rollback', 75)]:
                with self.subTest(mode=mode, command=command):
                    obj = Mock()
                    obj.api.request.return_value = {'commands': [{
                        'command_id': 'test', 'command_type': command, 'status': 'pending'}]}
                    obj.verify_controller_command.return_value = True
                    env = {'CITADEL_SERVICE_MANAGED': '1'}
                    if mode == 'task':
                        env['CITADEL_TASK_MANAGED'] = '1'
                    with patch.dict(os.environ, env), patch.object(subprocess, 'Popen') as spawn:
                        with self.assertRaises(SystemExit) as result:
                            namespace['handle_commands'](obj)
                        self.assertEqual(result.exception.code, code)
                        spawn.assert_not_called()
                        obj.ack_command.assert_any_call('test', 'completed')

    def test_local_stop_precedes_network_and_interrupts_backoff(self):
        with tempfile.TemporaryDirectory() as root:
            stop = Path(root) / 'STOP'
            stop.write_text('stop')
            obj = types.SimpleNamespace(stop_path=stop, lifecycle_stop_requested=lambda: False,
                                        enroll=Mock(side_effect=RuntimeError('offline')),
                                        enforce_power_guard=Mock())
            for method, args in [('cycle', ()), ('interruptible_sleep', (60,))]:
                with self.subTest(method=method), self.assertRaises(SystemExit) as result:
                    namespace[method](obj, *args)
                self.assertEqual(result.exception.code, 0)
            obj.enroll.assert_not_called()
            obj.enforce_power_guard.assert_not_called()


if __name__ == '__main__':
    unittest.main(verbosity=2)
