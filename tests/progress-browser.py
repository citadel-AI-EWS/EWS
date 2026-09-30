"""Browser scenarios use synthetic controller responses; no external requests."""
import json
import os
import shutil
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
node={'node_id':'node_test','hostname':'Тестовый Windows-агент','status':'online','agent_version':'0.3.24','latest_agent_version':'0.3.24','update_required':False,'ai_installed':1,'ai_server_running':1,'last_seen_at':'2026-09-30T00:00:00Z'}
ai={'installed':1,'server_running':1,'loaded_model':'test/model','selected_model':'test/model','query_id':'query_old','query_status':'completed','query_answer':'СТАРЫЙ ОТВЕТ','progress_phase':'query_complete','updated_at':'2026-09-29T00:00:00Z'}
held=[];commands=[];details_count=[0];reject=[False];detail_failure=[False];errors=[]

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CITADEL_TEST_CHROMIUM') or shutil.which('chromium'),headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1200,'height':900})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script("sessionStorage.setItem('citadel-architect-token','synthetic-progress-test-token')")
    def route(r):
        path=r.request.url.split('ews.test',1)[-1].split('?',1)[0]
        if not path.startswith('/api/'):
            return r.fulfill(content_type='text/html',body=(ROOT/('hub.html' if path=='/legacy' else 'operations.html')).read_text())
        body={'ok':True}
        if path.endswith('/machines'):body.update(nodes=[node],commands=commands)
        elif path.endswith('/projects'):
            if r.request.method=='POST':
                if reject[0]:return r.fulfill(status=409,content_type='application/json',body=json.dumps({'error':'no_available_nodes'}))
                body.update(project_id='project_test')
            else:body['projects']=[]
        elif path.endswith('/ai-state'):body.update(ai=ai)
        elif path.endswith('/release'):body.update(release={'version':'0.3.24'},lmstudio={})
        elif path.endswith('/details'):
            details_count[0]+=1
            if detail_failure[0]:return r.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'temporarily_unavailable'}))
            body.update(node=node,ai=ai,network={},hardware={})
        elif path.endswith('/commands') and r.request.method=='POST':
            held.append(r);return
        elif path.endswith('/d1-usage'):body.update(status='unavailable')
        else:body.update(logs=[])
        r.fulfill(content_type='application/json',body=json.dumps(body))
    page.route('https://ews.test/**',route)
    page.goto('https://ews.test/')
    page.get_by_role('button',name='Подробнее',exact=True).click()
    expect(page.locator('#nodeDialog')).to_be_visible()
    page.locator('#nodePrompt').fill('Сколько будет 2 + 2?')
    page.locator('#nodeQuery').click()
    expect(page.locator('#nodeQueryStatus')).to_contain_text('Отправляю промпт')
    expect(page.locator('#nodeQuery')).to_be_disabled()
    expect(page.locator('#modelGet')).to_be_disabled()
    assert not page.locator('#nodeQueryStatus [role=progressbar]').get_attribute('aria-valuenow')
    assert held
    command={'command_id':'command_query','node_id':'node_test','command_type':'hybrid_query','query_id':'query_new','status':'pending'}
    commands[:]=[command]
    held.pop().fulfill(status=201,content_type='application/json',body=json.dumps({'ok':True,'command':command}))
    expect(page.locator('#nodeQueryStatus')).to_contain_text('ожидаю агента')
    assert 'СТАРЫЙ ОТВЕТ' not in page.locator('#nodeAnswer').inner_text()
    ai.update(query_id='query_new',query_status='running',query_answer='',operation_id='command_query',progress_phase='query_running')
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#nodeQueryStatus')).to_contain_text('Агент готовит ответ')
    page.screenshot(path='/tmp/ews-query-waiting.png',full_page=True)
    ai.update(query_answer='Начинаю ответ…')
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#nodeQueryStatus')).to_contain_text('Получаю ответ')
    ai.update(query_status='completed',query_answer='4',progress_phase='query_complete')
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#nodeQueryStatus')).to_contain_text('Ответ получен')
    expect(page.locator('#nodeQuery')).to_be_enabled()
    expect(page.locator('#nodeAnswer')).to_have_text('4')
    page.on('dialog',lambda d:d.accept())
    page.locator('#modelId').fill('test/model')
    page.locator('#modelGet').click()
    expect(page.locator('#lmLiveStatus')).to_contain_text('Отправляю команду')
    expect(page.locator('#nodeQuery')).to_be_disabled()
    command={'command_id':'command_download','node_id':'node_test','command_type':'lmstudio_model_get','status':'pending'}
    commands[:]=[command]
    held.pop().fulfill(status=201,content_type='application/json',body=json.dumps({'ok':True,'command':command}))
    expect(page.locator('#lmLiveStatus')).to_contain_text('Ожидаю подтверждение')
    ai.update(operation_id='command_download',progress_phase='model_download',progress_bytes=25*1048576,progress_total_bytes=100*1048576,progress_detail='Загрузка test/model')
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('25%')
    assert page.locator('#lmLiveStatus [role=progressbar]').get_attribute('aria-valuenow')=='25'
    page.screenshot(path='/tmp/ews-model-download.png',full_page=True)
    detail_failure[0]=True
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('Связь прервана')
    detail_failure[0]=False
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('25%')
    expect(page.locator('#lmLiveStatus')).not_to_contain_text('Не удалось')
    page.locator('#closeNode').click()
    page.get_by_role('button',name='Подробнее',exact=True).click()
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('25%')
    ai.update(progress_phase='download_complete',progress_bytes=100*1048576)
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('Модель скачана')
    expect(page.locator('#modelLoad')).to_be_enabled()
    page.locator('#modelLoad').click()
    expect(page.locator('#lmLiveStatus')).to_contain_text('Отправляю команду')
    command={'command_id':'command_load','node_id':'node_test','command_type':'lmstudio_model_load','status':'pending'}
    commands[:]=[command]
    held.pop().fulfill(status=201,content_type='application/json',body=json.dumps({'ok':True,'command':command}))
    ai.update(operation_id='command_load',progress_phase='model_load',progress_bytes=None,progress_total_bytes=None,progress_current=0,progress_total=1)
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('Загрузка модели в память')
    ai.update(progress_phase='failed',progress_detail='Недостаточно памяти для модели')
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('Недостаточно памяти')
    expect(page.locator('#modelLoad')).to_be_enabled()
    # Real installer stages, without pretending stage counts are byte percentages.
    page.locator('#lmUpdate').click()
    expect(page.locator('#lmLiveStatus')).to_contain_text('Отправляю команду')
    page.wait_for_function('document.querySelector("#lmUpdate").disabled')
    page.wait_for_timeout(50)
    command={'command_id':'command_install','node_id':'node_test','command_type':'lmstudio_install','status':'pending'}
    commands[:]=[command]
    held.pop().fulfill(status=201,content_type='application/json',body=json.dumps({'ok':True,'command':command}))
    ai.update(operation_id='command_install',progress_phase='upstream_installer',progress_current=2,progress_total=5,progress_detail='Установка runtime')
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('Шаг 2 из 5')
    expect(page.locator('#lmLiveStatus')).to_contain_text('Официальный установщик')
    expect(page.locator('#lmLiveStatus')).not_to_contain_text('40%')
    ai.update(progress_phase='complete',progress_current=5)
    page.evaluate('loadNodeDetails(currentNode,true)')
    expect(page.locator('#lmLiveStatus')).to_contain_text('Установка завершена')
    expect(page.locator('#lmUpdate')).to_be_enabled()
    page.set_viewport_size({'width':390,'height':844})
    assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
    page.screenshot(path='/tmp/ews-progress-mobile.png',full_page=True)
    page.locator('#closeNode').click()
    reject[0]=True
    page.locator('#prompt').fill('Проверка ошибки отправки')
    page.locator('#submitTask').click()
    expect(page.locator('#taskSubmissionStatus')).to_contain_text('Промпт не отправлен')
    expect(page.locator('#prompt')).to_have_value('Проверка ошибки отправки')
    page.locator('#logout').click()
    assert errors==[],errors
    # The legacy standalone Hub uses the same progress renderer and correlation.
    legacy=browser.new_page(viewport={'width':1200,'height':900})
    legacy.on('pageerror',lambda e:errors.append(str(e)))
    legacy.add_init_script("sessionStorage.setItem('citadel-architect-token','synthetic-progress-test-token')")
    legacy.route('https://ews.test/**',route)
    legacy.goto('https://ews.test/legacy')
    legacy.wait_for_function('lastOverview !== null')
    legacy.evaluate('''()=>{const n={node_id:'node_test',hostname:'Legacy fixture',status:'online',last_seen_at:new Date().toISOString(),agent_version:'0.3.24',lmstudio_installed:1,lmstudio_loaded_model:'test/model',lmstudio_server_running:1,lmstudio_runtime:{}};lastOverview={nodes:[n],commands:[]};releaseVersion='0.3.24';hybridMode='python';openHybrid(n);setHubPanelCollapsed($('hybridPanel'),false,false)}''')
    ai.update(query_id='legacy_old',query_status='completed',query_answer='OLD',progress_phase='query_complete')
    legacy.locator('#hybridPrompt').fill('calc: 2 + 2')
    legacy.locator('#hybridSend').click()
    expect(legacy.locator('#hybridOperation')).to_contain_text('Отправляю промпт')
    command={'command_id':'legacy_command','query_id':'legacy_query','status':'pending'}
    held.pop().fulfill(status=201,content_type='application/json',body=json.dumps({'ok':True,'command':command}))
    expect(legacy.locator('#hybridOperation')).to_contain_text('ожидаю агента')
    legacy.wait_for_function("legacyQueryOperation.status==='queued' && hybridPollTimer!==null")
    ai.update(query_id='legacy_query',operation_id='legacy_command',query_status='completed',query_answer='4',progress_phase='query_complete')
    expect(legacy.locator('#hybridOperation')).to_contain_text('Ответ получен',timeout=6000)
    expect(legacy.locator('#hybridAnswer')).to_have_text('4')
    legacy.evaluate('''()=>{lmstudioNodeId='node_test';$('lmstudioPanel').classList.remove('hidden');lastOverview.nodes[0].lmstudio_runtime={operation_id:'legacy_download',progress_phase:'download_complete',progress_bytes:100,progress_total_bytes:100};legacyLmOperation={nodeId:'node_test',type:'lmstudio_model_get',commandId:'legacy_download',startedAt:Date.now(),status:'queued'};syncLmstudioPanel()}''')
    expect(legacy.locator('#lmstudioOperation')).to_contain_text('Модель скачана')
    legacy.evaluate("lastOverview.nodes[0].lmstudio_runtime.progress_phase='model_load';syncLmstudioPanel()")
    assert legacy.evaluate('legacyLmOperation.status')=='completed'
    legacy.evaluate("$('lmstudioPanel').classList.add('hidden');closeHybrid()")
    legacy.locator('#logoutButton').click()
    assert errors==[],errors
    browser.close()
    print('Browser progress: sending, queued, stale-answer rejection, inference, partial answer, completion, byte progress, reopen, loading, failure, mobile, failed submission and logout PASS')
