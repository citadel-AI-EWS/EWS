"""Behavioral regression checks for LM progress, cancellation and updater staging."""
import hashlib
import io
import json
import re
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'agent'))
import citadel_node_v1 as node


class FakeConnection:
    def __init__(self, events):
        self.response = io.BytesIO(events)
        self.response.status = 200
        self.request = Mock()
        self.close = Mock()

    def getresponse(self):
        return self.response


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps({'controller_url':'https://example.invalid','data_dir':str(self.root/'state')}))
        self.agent = node.Agent(node.AgentConfig('https://example.invalid',self.root/'state'),self.config)

    def tearDown(self):
        self.temp.cleanup()

    def test_successful_stream_requires_completion(self):
        events=b'data: {"type":"message.delta","content":"Answer"}\n\nevent: chat.end\ndata: {"type":"chat.end"}\n\n'
        self.agent.ensure_lmstudio_ready_for_inference=Mock(return_value='test/model')
        with patch.object(node.http.client,'HTTPConnection',return_value=FakeConnection(events)):
            self.assertEqual(self.agent.stream_lmstudio_answer('task',{},'query_12345678'),'Answer')
        self.agent.ensure_lmstudio_ready_for_inference.assert_called_once()

    def test_truncated_answer_is_failed_and_partial_text_retained(self):
        self.agent.ensure_lmstudio_ready_for_inference=Mock(return_value='test/model')
        with patch.object(node.http.client,'HTTPConnection',return_value=FakeConnection(b'data: {"type":"message.delta","content":"partial"}\n\n')):
            with self.assertRaisesRegex(RuntimeError,'lmstudio_stream_incomplete'):
                self.agent.run_hybrid_query({'mode':'lmstudio','prompt':'task','request_id':'query_12345678'})
        state=self.agent.lmstudio_state()
        self.assertEqual(state['query_status'],'failed')
        self.assertEqual(state['query_answer'],'partial')

    def test_inference_recovery_failure_is_reported(self):
        self.agent.ensure_lmstudio_ready_for_inference=Mock(side_effect=RuntimeError('lmstudio_model_not_loaded'))
        with self.assertRaises(RuntimeError):
            self.agent.run_hybrid_query({'mode':'lmstudio','prompt':'task','request_id':'query_12345678'})
        self.assertEqual(self.agent.lmstudio_state()['query_status'],'failed')

    def test_stop_prevents_download_poll(self):
        self.agent.stop_path.write_text('stop')
        self.agent.run_lms=Mock()
        self.agent.lmstudio_http_json=Mock(return_value={'status':'downloading','job_id':'test'})
        with self.assertRaises(SystemExit):
            self.agent.download_lmstudio_model({'model':'test/model'})
        self.assertEqual(self.agent.lmstudio_http_json.call_count,1)

    def test_download_has_overall_deadline(self):
        self.agent.run_lms=Mock()
        self.agent.lmstudio_http_json=Mock(return_value={'status':'downloading','job_id':'test'})
        with patch.object(node.time,'monotonic',side_effect=[0,3601]):
            with self.assertRaisesRegex(RuntimeError,'lmstudio_download_timeout'):
                self.agent.download_lmstudio_model({'model':'test/model'})

    def test_command_reports_failure_and_correlation(self):
        self.agent.require_node_id=Mock(return_value='node_test')
        self.agent.verify_controller_command=Mock(return_value=True)
        self.agent.api.request=Mock(return_value={'commands':[{'command_id':'command_test','command_type':'lmstudio_model_get','status':'pending','payload':{'model':'test/model'}}]})
        self.agent.ack_command=Mock()
        self.agent.download_lmstudio_model=Mock(side_effect=RuntimeError('download_broken'))
        self.agent.handle_commands()
        state=self.agent.lmstudio_state()
        self.assertEqual(state['operation_id'],'command_test')
        self.assertEqual(state['progress_phase'],'failed')
        self.agent.ack_command.assert_any_call('command_test','failed')

    def test_heartbeats_continue_during_blocking_operation(self):
        self.agent.identity.set_node_id('node_test')
        self.agent.api.request=Mock(return_value={})
        self.agent.config.heartbeat_seconds=0.01
        ready=threading.Event()
        calls=[]
        def heartbeat():
            calls.append(True)
            if len(calls)>=2: ready.set()
        self.agent.heartbeat=heartbeat
        with self.agent.long_operation('command_test'):
            self.assertTrue(ready.wait(1),'background heartbeat stalled')
        count=len(calls)
        self.assertEqual(self.agent._operation_depth,0)
        self.assertGreaterEqual(count,2)

    def test_external_runtime_is_preserved(self):
        user=self.root/'user';runtime=user/'.lmstudio'
        (runtime/'bin').mkdir(parents=True)
        (runtime/'bin'/'lms').write_text('external runtime')
        with patch.object(Path,'home',return_value=user),patch.object(node.shutil,'which',return_value=None):
            with self.assertRaisesRegex(RuntimeError,'lmstudio_external_runtime_not_managed'):
                self.agent.uninstall_lmstudio({'purge_data':True})
        self.assertTrue((runtime/'bin'/'lms').exists())

    def update(self,name,data):
        install=self.root/'install';install.mkdir()
        for core in ['citadel_node_v1.py','citadel_node_v2.py']:
            (install/core).write_bytes((ROOT/'agent'/core).read_bytes())
        original=(install/name).read_bytes()
        self.agent.validate_update_payload=Mock(return_value=True)
        self.agent.download_update_file=Mock(return_value=data)
        with patch.object(node,'__file__',str(install/'citadel_node_v1.py')):
            self.agent.apply_update({'version':'test','files':[{'path':name,'url':'test','sha256':hashlib.sha256(data).hexdigest()}]})
        return install,original

    def test_v1_only_invalid_update_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'updated agent self-test failed'):
            self.update('citadel_node_v1.py',b'invalid syntax !!!')
        self.assertEqual((self.root/'install'/'citadel_node_v1.py').read_bytes(),(ROOT/'agent'/'citadel_node_v1.py').read_bytes())

    def test_v2_only_valid_update_has_companion_and_activates(self):
        data=(ROOT/'agent'/'citadel_node_v2.py').read_bytes()+b'\n# harmless version change\n'
        install,_=self.update('citadel_node_v2.py',data)
        self.assertEqual((install/'citadel_node_v2.py').read_bytes(),data)

    def test_expiry_lease_requires_fresh_matching_operation_and_is_bounded(self):
        source=(ROOT/'src/index.js').read_text()
        block=source[source.index('async function expireStaleCommands'):source.index('async function expireStaleNodeCommands')]
        sql=re.findall(r'prepare\(`([\s\S]*?)`\)',block)[1]
        db=sqlite3.connect(':memory:')
        db.execute('CREATE TABLE commands(command_id,node_id,command_type,status,created_at)')
        db.execute('CREATE TABLE node_ai_runtime_state(node_id,state_json,updated_at)')
        scenarios=[('live','accepted','-20 minutes','live','+0 seconds'),('old','accepted','-20 minutes','old','-3 minutes'),('wrong','accepted','-20 minutes','other','+0 seconds'),('queued','pending','-20 minutes','queued','+0 seconds'),('bounded','accepted','-3 hours','bounded','+0 seconds')]
        for command,status,age,op,stamp in scenarios:
            db.execute("INSERT INTO commands VALUES (?,?,?, ?, datetime('now',?))",(command,command,'lmstudio_model_get',status,age))
            db.execute("INSERT INTO node_ai_runtime_state VALUES (?,?,datetime('now',?))",(command,json.dumps({'operation_id':op}),stamp))
        rows=db.execute(sql,(db.execute("SELECT datetime('now','-15 minutes')").fetchone()[0],)).fetchall()
        self.assertEqual({row[0] for row in rows},{'old','wrong','queued','bounded'})


if __name__=='__main__':
    unittest.main(verbosity=2)
