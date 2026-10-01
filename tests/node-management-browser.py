"""Run with Python Playwright installed; all nodes and API responses are synthetic."""
from pathlib import Path
import os
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({"executable_path": os.environ["EWS_CHROMIUM_EXECUTABLE"]} if os.environ.get("EWS_CHROMIUM_EXECUTABLE") else {}))
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors, writes = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    nodes = [dict(node_id='n1', hostname='AI machine', status='online', ai_installed=1),
             dict(node_id='n2', hostname='Offline machine', status='offline', ai_installed=0),
             dict(node_id='n3', hostname='Busy machine', status='online', ai_installed=0)]
    groups = []

    def route(r):
        req = r.request
        path = req.url.split('https://ews.test')[-1]
        if not path.startswith('/api/'):
            return r.fulfill(content_type='text/html', body=Path('operations.html').read_text())
        data, status = {'ok': True}, 200
        if path.endswith('/machines'):
            data.update(nodes=nodes, groups=groups, commands=[])
        elif path.endswith('/projects'):
            data['projects'] = []
        elif path.endswith('/node-groups'):
            body = req.post_data_json
            writes.append(('group', body))
            if any(g['name'] == body['name'] for g in groups):
                status, data = 409, {'error': 'group_name_exists'}
            else:
                g = dict(group_id='g'+str(len(groups)+1), name=body['name'], category=body['category'])
                groups.append(g)
                for n in nodes:
                    if n['node_id'] in body['node_ids']:
                        n['group_id'] = g['group_id']
                data['group'] = g
        elif req.method == 'DELETE':
            node_id = path.split('/')[-1]
            writes.append(('delete', node_id, req.post_data_json))
            if node_id == 'n3':
                status, data = 409, {'error': 'node_busy'}
            else:
                nodes[:] = [n for n in nodes if n['node_id'] != node_id]
        r.fulfill(status=status, content_type='application/json', body=json.dumps(data))

    page.route('https://ews.test/**', route)
    page.goto('https://ews.test/')
    page.locator('#token').fill('synthetic-token')
    page.locator('#login button').click()
    page.locator('#nodes h2').first.wait_for()
    assert page.locator('.node-select input').count() == 3  # AI installed and offline are selectable.
    assert page.locator('#deleteSelected').is_disabled()
    page.get_by_role('checkbox', name='Выбрать узел AI machine', exact=True).check()
    page.get_by_role('checkbox', name='Выбрать узел Offline machine', exact=True).check()
    assert page.locator('#selectionCount').inner_text() == 'Выбрано: 2'
    assert page.locator('#installLmSelected').is_disabled()  # Preserve LM eligibility.
    page.locator('#groupSelected').click()
    assert page.locator('.group-choice').count() == 5
    assert page.locator('#groupName').evaluate('(el)=>el===document.activeElement')
    page.locator('#groupName').fill('Europe team')
    page.locator('input[name=groupCategory][value=geography]').check()
    artifacts = Path(os.environ.get('EWS_BROWSER_ARTIFACT_DIR', '/tmp/ews-node-management-browser'))
    artifacts.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(artifacts / 'ews-grouping-desktop.png'), full_page=True)
    page.locator('#saveGroup').click()
    page.wait_for_function("!document.getElementById('groupDialog').open")
    assert writes == [('group', dict(name='Europe team', category='geography', node_ids=['n1', 'n2']))]
    page.reload()
    page.locator('.group-tag').first.wait_for()
    assert page.locator('.group-tag').count() == 2
    page.locator('#groupFilter').select_option('g1')
    assert page.locator('#nodes h2').count() == 2
    assert page.locator('.node-select input').count() == 2
    page.get_by_role('checkbox', name='Выбрать узел Offline machine', exact=True).check()
    page.locator('#deleteSelected').click()
    page.locator('#cancelDelete').click()
    assert len(writes) == 1  # Opening/cancelling the confirmation never deletes anything.
    page.locator('#groupFilter').select_option('')
    assert page.get_by_role('checkbox', name='Выбрать узел Offline machine', exact=True).is_checked()
    page.locator('#clearLmSelection').click()
    page.locator('#selectAllNodes').click()
    assert page.locator('.node-select input:checked').count() == 3
    assert '1' in page.locator('#installLmSelected').inner_text()
    page.locator('#deleteSelected').click()
    assert page.locator('#deleteNodeList li').count() == 3
    page.locator('#confirmDelete').click()
    page.wait_for_function("!document.getElementById('deleteDialog').open")
    assert page.locator('#nodes h2').count() == 1
    assert page.locator('#nodes h2').inner_text() == 'Busy machine'
    assert 'Удалено узлов: 2' in page.locator('#notice').inner_text()
    assert 'Узел занят' in page.locator('#notice').inner_text()
    assert len(writes) == 4
    page.locator('.node-delete').click()
    page.keyboard.press('Escape')
    assert len(writes) == 4
    page.set_viewport_size({'width': 390, 'height': 844})
    page.locator('#groupSelected').click()
    page.locator('#groupName').fill('Mobile group')
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
    page.screenshot(path=str(artifacts / 'ews-grouping-mobile.png'), full_page=True)
    page.locator('#closeGroup').click()
    page.locator('#logout').click()
    assert not page.locator('#machines').is_visible()
    assert not page.locator('#groupDialog').is_visible()
    assert not page.locator('#deleteDialog').is_visible()
    assert not errors, errors
    browser.close()
    print('Node management browser: all-node selection, LM eligibility, group modal, persistence, filter, cancellation, partial deletion, mobile and logout PASS')
