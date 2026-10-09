"""Real HTTP verifies report retry hints, SSH evidence and control isolation."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
import citadel_node_v1 as v1
import citadel_node_v2 as v2


class ReportIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.fail_reports = True
        self.archive_status = None
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or '{}')
                owner.calls.append((self.path, payload))
                blocked = self.path.endswith('/logs') and owner.fail_reports
                self.send_response(503 if blocked else 200)
                self.send_header('Content-Type', 'application/json')
                if blocked: self.send_header('Retry-After', '300')
                self.end_headers()
                reply = {'error': 'node_report_queue_full'} if blocked else {'ok': True}
                if owner.archive_status is not None: reply['drive_archive'] = {'status': owner.archive_status}
                self.wfile.write(json.dumps(reply).encode())
            def log_message(self, *_): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.agent = v2.Agent(v1.AgentConfig(f'http://127.0.0.1:{self.server.server_port}', Path(self.temp.name)))
        self.agent.identity.set_node_id('node_fixture')
        self.agent._start_ssh_relay = Mock()

    def test_retry_after_is_real_and_does_not_block_control(self):
        self.agent.log.write('ssh_relay_error', error='synthetic connection failure')
        def healthy_core(agent): agent.api.request('POST', '/sync', {})
        with patch.object(v1.time, 'monotonic', return_value=1000):
            with patch.object(v1.Agent, 'cycle', healthy_core):
                self.agent.cycle()
                self.agent.cycle()
        self.assertEqual([path for path, _ in self.calls], ['/sync', '/api/v1/nodes/node_fixture/logs', '/sync'])
        self.assertFalse(self.agent.telemetry.cursor_path.exists())
        self.assertEqual(self.agent._telemetry_retry_at, 1300)
        self.assertEqual(self.agent.api.retry_delay(), 0)
        self.fail_reports = False
        with patch.object(v1.time, 'monotonic', return_value=1301):
            self.agent.flush_telemetry()
        self.assertTrue(self.agent.telemetry.cursor_path.exists())
        self.assertEqual(self.calls[-1][1]['events'][0]['event_type'], 'ssh_relay_error')

    def test_all_ssh_events_reach_a_batch(self):
        events = ['ssh_relay_connected', 'ssh_relay_disconnected', 'ssh_relay_error', 'ssh_relay_local_ready']
        for event in events: self.agent.log.write(event, reason='fixture')
        self.fail_reports = False
        self.agent.flush_telemetry()
        self.assertEqual([e['event_type'] for e in self.calls[-1][1]['events']], events)

    def test_unverified_archive_keeps_original_local_history(self):
        self.agent.log.write('ssh_relay_local_ready', reason='historical event')
        old_cursor = Path(self.temp.name) / 'telemetry-cursor.json'
        old_cursor.write_text(json.dumps({'offset': (Path(self.temp.name) / 'agent.jsonl').stat().st_size}))
        self.fail_reports = False
        self.archive_status = 'awaiting_write_test'
        with patch.object(v1.time, 'monotonic', return_value=1000): self.agent.flush_telemetry()
        original_events = self.calls[-1][1]['events']
        self.assertFalse(self.agent.telemetry.cursor_path.exists())
        self.assertEqual(self.agent._telemetry_retry_at,1900)
        self.archive_status = 'queued'
        with patch.object(v1.time, 'monotonic', return_value=1901): self.agent.flush_telemetry()
        self.assertEqual(self.calls[-1][1]['events'],original_events)
        self.assertTrue(self.agent.telemetry.cursor_path.exists())

    def test_reporting_error_never_turns_healthy_run_into_cycle_error(self):
        self.agent.telemetry.flush = Mock(side_effect=v1.ControllerApiError(503, 'node_report_queue_full', 300))
        with patch.object(v1.Agent, 'cycle', return_value=None):
            self.assertEqual(self.agent.run(once=True), 0)
        self.assertNotIn('cycle_error', (Path(self.temp.name) / 'agent.jsonl').read_text())


if __name__ == '__main__': unittest.main(verbosity=2)
