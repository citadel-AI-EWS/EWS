import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'agent'))
import citadel_node_v1 as node
with tempfile.TemporaryDirectory() as temp:
    agent=node.Agent(node.AgentConfig('https://example.invalid',Path(temp)))
    agent.save_lmstudio_state(loaded_model='test/model')
    calls=[]
    def answer(*args,**kwargs):
        calls.append(kwargs)
        return 'Controlled protocol response', {'prompt_tokens':11,'completion_tokens':3,'total_tokens':14}
    with patch.object(node.psutil,'virtual_memory',return_value=SimpleNamespace(total=32*1024**3)):
        agent._project_llm_chat=answer
        for length,count in [(20,1),(900,2),(1900,3)]:
            calls.clear()
            result=agent.execute_project_text({'task_text':'x'*length,'role_name':'reviewer'})
            assert result['mini_agent_count']==count
            assert len(calls)==count+(count>1)
            assert result['token_usage']['total_tokens']==14*len(calls)
            assert agent.lmstudio_state()['progress_phase']=='completed'
        calls.clear()
        def partial(*args,**kwargs):
            calls.append(kwargs)
            if len(calls)==2: raise RuntimeError('lmstudio_empty_response')
            return 'Controlled response',None
        agent._project_llm_chat=partial
        result=agent.execute_project_text({'task_text':'x'*900})
        assert result['mini_agent_count']==1
        assert result['mini_agent_requested_count']==2
        assert result['mini_agent_failures'][0]['error_code']=='lmstudio_empty_response'
        assert result['token_usage']['unmeasured_calls']==1
        assert result['token_usage']['unmeasured_failed_calls']==1
        assert agent.lmstudio_state()['progress_phase']=='completed_partial'
    scenarios=json.loads((ROOT/'tests/fixtures/acceptance-prompts.json').read_text())
    for scenario in scenarios:
        if scenario['mode']!='python': continue
        result=agent.execute_project_python({'task_text':scenario['prompt']})
        assert scenario['expected'] in result['content'], result
        assert result['engine']=='python'
        print(json.dumps({'id':scenario['id'],'engine':'python','mini_agents':result['mini_agent_count'],'answer':result['content']},ensure_ascii=False))
print('Mini-agent scheduling, synthesis metering, partial failures and real local Python tasks: PASS')
