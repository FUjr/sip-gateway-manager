import importlib
import os
import time
import pytest
from fastapi.testclient import TestClient
from backend.models import Ingest, Completion
from backend.routing import resolve
from backend.render import render

@pytest.fixture
def gateway(tmp_path, monkeypatch):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    monkeypatch.setenv('ADMIN_PASSWORD', 'a-secure-test-password')
    import backend.main
    m = importlib.reload(backend.main)
    with TestClient(m.app,base_url='https://testserver') as client:
        response=client.post('/api/v1/register',json={'username':'admin','password':'a-secure-test-password'})
        assert response.status_code==200
        client.headers['X-CSRF-Token']=response.json()['csrf']
        from backend.tenancy import current
        context=current.set(response.json()['id'])
        try: yield m,client
        finally: current.reset(context)

def add(client,kind,value):
    response=client.put('/api/v1/'+kind+'/'+value.get('id','main'),json=value)
    assert response.status_code==200,response.text

def setup(client):
    add(client,'devices',{'id':'router','name':'Router'})
    for identity,kind,extension in [('modem1','device','100'),('modem2','device','101'),('alice','client','200'),('bob','client','201')]:
        add(client,'accounts',{'id':identity,'name':identity,'kind':kind,'extension':extension,'password':'abcdefghijklmnop','device_id':'router' if kind=='device' else ''})
    add(client,'groups',{'id':'team','name':'Team','members':['alice','bob']})
    add(client,'routes',{'id':'in_sms','name':'SMS in','medium':'sms','direction':'inbound','sources':['modem1'],'target_type':'group','target':'team'})
    add(client,'routes',{'id':'out_sms','name':'SMS out','medium':'sms','direction':'outbound','sources':['alice','bob'],'target':'modem1'})

def test_auth_csrf_and_strict_validation(gateway):
    m,client=gateway
    assert TestClient(m.app).get('/api/v1/config').status_code==401
    assert client.put('/api/v1/devices/router',headers={'X-CSRF-Token':''},json={}).status_code==403
    assert client.put('/api/v1/devices/router',json={'id':'router','name':'Router','script':'bad'}).status_code==422
    setup(client)
    assert client.delete('/api/v1/accounts/alice').status_code==409
    assert len(m.store.objects('accounts'))==4

def test_priority_and_internal_routes(gateway):
    m,client=gateway;setup(client)
    add(client,'routes',{'id':'specific','name':'Specific','medium':'sms','direction':'outbound','sources':['alice'],'match':'prefix','number':'123','priority':1,'target':'modem2'})
    assert resolve(m.store.config(),'alice','12345','sms')==['modem2']
    assert resolve(m.store.config(),'alice','888','sms')==['modem1']
    assert resolve(m.store.config(),'alice','201','sms')==['bob']
    assert resolve(m.store.config(),'modem2','888','sms')==[]

def test_durable_fanout_and_stable_dedupe(gateway):
    m,client=gateway;setup(client)
    assert client.post('/api/v1/apply').json()['applied']
    message=Ingest(account='modem1',recipient='123',sender='123',content='中文短信',delivery_id='abc')
    assert m.ingest(message)['accepted']
    assert m.ingest(message)['duplicate']
    with m.store.lock:
        jobs=m.store.db.execute('SELECT * FROM jobs ORDER BY target').fetchall()
    assert len(jobs)==2
    with m.store.transaction() as db:db.execute("UPDATE jobs SET status='sending',attempts=1")
    m.complete(Completion(delivery_id=jobs[0]['id'],code=200))
    m.complete(Completion(delivery_id=jobs[1]['id'],code=408))
    with m.store.lock:
        rows=m.store.db.execute('SELECT target,status FROM jobs ORDER BY target').fetchall()
        assert [r['status'] for r in rows]==['delivered','pending']
        assert m.store.db.execute('SELECT body FROM messages').fetchone()['body']=='中文短信'
    with m.store.transaction() as db:db.execute("UPDATE jobs SET status='sending' WHERE status='pending'")
    m.complete(Completion(delivery_id=jobs[1]['id'],code=202))
    assert m.store.db.execute('SELECT body FROM messages').fetchone()['body'] is None
    # Commit survives reopening storage; retrying an existing accepted ingress adds no jobs.
    from backend.store import Store
    reopened=Store(str(m.DATA/'gateway.sqlite3'))
    assert reopened.db.execute('SELECT count(*) FROM jobs').fetchone()[0]==2

def test_provision_and_generated_dialplan(gateway):
    m,client=gateway;setup(client)
    add(client,'routes',{'id':'call','name':'Call','medium':'voice','direction':'inbound','sources':['modem1'],'target_type':'group','target':'team'})
    value=client.get('/api/v1/accounts/modem1/provision').json()
    assert value['schema_version']==1 and value['transport']=='tls'
    assert not any(k in value for k in ('at_port','pcm_port','adb_serial'))
    files=render(m.store.config())
    assert 'GatewayRoute(modem1)' in files['extensions.conf']
    assert 'GatewayRoute(alice)' in files['extensions.conf']
    assert 'message_context=managed-message' in files['pjsip.conf']
    assert client.post('/api/v1/apply').json()['applied']

def test_status_tracks_saved_changes_across_sessions(gateway):
    m, client = gateway
    assert client.get('/api/v1/status').json()['pending_changes'] is True
    setup(client)
    assert client.post('/api/v1/apply').json()['applied']
    assert client.get('/api/v1/status').json()['pending_changes'] is False
    add(client, 'devices', {'id': 'router', 'name': 'Renamed router'})
    assert client.get('/api/v1/status').json()['pending_changes'] is True
    # Reading status must not expose provision credentials or alter saved state.
    state = client.get('/api/v1/status').json()
    assert 'abcdefghijklmnop' not in str(state)
    assert client.post('/api/v1/apply').json()['applied']
    assert client.get('/api/v1/status').json()['pending_changes'] is False


def test_reload_rollback_and_transport_restart(gateway,tmp_path,monkeypatch):
    import json,shutil
    from types import SimpleNamespace
    m,client=gateway;setup(client)
    assert client.post('/api/v1/apply').json()['applied']
    original=(m.DATA/'applied-config.json').read_bytes()
    root=tmp_path/'pbx';root.mkdir()
    for name in render(m.store.config()):(root/name).write_text('previous '+name)
    saved={p.name:p.read_bytes() for p in root.iterdir()}
    monkeypatch.setenv('PBX_MANAGED','1');monkeypatch.setenv('ASTERISK_CONFIG_DIR',str(root))
    monkeypatch.setattr(shutil,'chown',lambda *args,**kwargs:None)
    monkeypatch.setattr(m.subprocess,'run',lambda *args,**kwargs:SimpleNamespace(returncode=1,stdout='Error'))
    assert client.post('/api/v1/apply').status_code==503
    assert saved=={p.name:p.read_bytes() for p in root.iterdir()}
    assert original==(m.DATA/'applied-config.json').read_bytes()
    settings=m.Settings().model_dump();settings['sip_tls_port']=5062
    add(client,'settings',settings)
    result=client.post('/api/v1/apply').json()
    assert result['restart_required'] and not result['applied']
    assert original==(m.DATA/'applied-config.json').read_bytes()


def test_line_service_atomic_compilation_and_preserved_configuration(gateway):
    m, client = gateway
    setup(client)
    before = m.store.config()
    view = client.get('/api/v1/experience').json()
    assert 'password' not in str(view)
    line = next(l for l in view['lines'] if l['id'] == 'modem1')
    incoming_sms = next(s for s in line['services'] if s['medium'] == 'sms' and s['direction'] == 'inbound')
    assert incoming_sms['people'] == ['alice', 'bob']
    assert incoming_sms['editable']
    payload = {'revision': view['revision'], 'line': 'modem1', 'direction': 'inbound', 'medium': 'voice', 'people': ['alice', 'bob']}
    assert client.post('/api/v1/line-service', json=payload).status_code == 200
    conf = m.store.config()
    assert resolve(conf, 'modem1', '10099', 'voice') == ['alice', 'bob']
    assert resolve(conf, 'modem1', '10099', 'sms') == ['alice', 'bob']
    assert conf['accounts'] == before['accounts']
    assert all(r in conf['routes'] for r in before['routes'])
    assert conf['groups'] == before['groups']  # reused the existing membership
    # Concurrent/stale edit cannot overwrite a more recent purpose.
    assert client.post('/api/v1/line-service', json=payload).status_code == 409
    assert m.store.config() == conf
    assert client.get('/api/v1/status').json()['pending_changes']


def test_outbound_scope_conflicts_and_internal_precedence(gateway):
    m, client = gateway
    setup(client)
    def save(**changes):
        payload = {'revision': client.get('/api/v1/experience').json()['revision'], 'line': 'modem1', 'direction': 'outbound', 'medium': 'voice', 'people': ['alice'], 'scope': 'exact', 'number': '10099'}
        payload.update(changes)
        return client.post('/api/v1/line-service', json=payload)
    assert save().status_code == 200
    before = m.store.config()
    for changes in ({'line': 'modem2'}, {'number': '201'}, {'scope': 'exact', 'number': ''}, {'people': ['modem1']}):
        assert save(**changes).status_code == 409
        assert m.store.config() == before
    def preview(source, number, medium='voice'):
        response = client.post('/api/v1/rehearse', json={'source': source, 'number': number, 'medium': medium})
        assert response.status_code == 200
        return response.json()
    assert preview('alice', '10099')['targets'][0]['id'] == 'modem1'
    assert not preview('alice', '10086')['allowed']
    assert preview('alice', '201')['internal']
    assert preview('alice', '201')['targets'][0]['id'] == 'bob'
    assert not preview('modem2', '10099')['allowed']
    assert save(enabled=False).status_code == 200
    assert not preview('alice', '10099')['allowed']
    assert m.store.db.execute('SELECT count(*) FROM messages').fetchone()[0] == 0


def test_custom_routes_and_shared_groups_are_not_flattened(gateway):
    m, client = gateway
    setup(client)
    # Shared inbound source: editing just one line must never affect another.
    add(client, 'routes', {'id': 'shared', 'name': 'Shared', 'medium': 'voice', 'direction': 'inbound', 'sources': ['modem1', 'modem2'], 'target': 'alice'})
    before = m.store.config()
    view = client.get('/api/v1/experience').json()
    assert not next(s for s in view['lines'][0]['services'] if s['medium'] == 'voice' and s['direction'] == 'inbound')['editable']
    payload = {'revision': view['revision'], 'line': 'modem1', 'direction': 'inbound', 'medium': 'voice', 'people': ['bob']}
    assert client.post('/api/v1/line-service', json=payload).status_code == 409
    assert m.store.config() == before
    # Reassign one SMS purpose without modifying a group used elsewhere.
    payload.update(medium='sms', people=['alice'])
    assert client.post('/api/v1/line-service', json=payload).status_code == 200
    assert m.store.config()['groups'] == before['groups']
    assert resolve(m.store.config(), 'modem1', '10099', 'sms') == ['alice']


def test_disabled_services_and_conditional_incoming_are_explicit(gateway):
    m, client = gateway
    setup(client)
    add(client, 'routes', {'id': 'conditional', 'name': 'Conditional', 'medium': 'voice', 'direction': 'inbound', 'sources': ['modem2'], 'match': 'exact', 'number': '10099', 'target': 'alice'})
    view = client.get('/api/v1/experience').json()
    second = next(l for l in view['lines'] if l['id'] == 'modem2')
    assert not next(s for s in second['services'] if s['medium'] == 'voice' and s['direction'] == 'inbound')['editable']
    alice = next(a for a in m.store.objects('accounts') if a['id'] == 'alice')
    alice['voice_enabled'] = False
    add(client, 'accounts', alice)
    body = {'revision': client.get('/api/v1/experience').json()['revision'], 'line': 'modem1', 'direction': 'outbound', 'medium': 'voice', 'people': ['alice'], 'scope': 'exact', 'number': '10099'}
    assert client.post('/api/v1/line-service', json=body).status_code == 409
    assert not client.post('/api/v1/rehearse', json={'source': 'alice', 'number': '10099', 'medium': 'voice'}).json()['allowed']
    assert TestClient(m.app).post('/api/v1/line-service', json=body).status_code == 401
    assert client.post('/api/v1/line-service', headers={'X-CSRF-Token': ''}, json=body).status_code == 403


def test_new_multi_receiver_purpose_renders_parallel_calls_and_independent_sms(gateway):
    m, client = gateway
    setup(client)
    add(client, 'accounts', {'id': 'charlie', 'name': 'Charlie', 'kind': 'client', 'extension': '202', 'password': 'abcdefghijklmnop'})
    old_groups = m.store.objects('groups')
    for medium in ('voice', 'sms'):
        body = {'revision': client.get('/api/v1/experience').json()['revision'], 'line': 'modem2', 'direction': 'inbound', 'medium': medium, 'people': ['alice', 'charlie']}
        assert client.post('/api/v1/line-service', json=body).status_code == 200
        assert resolve(m.store.config(), 'modem2', '10099', medium) == ['alice', 'charlie']
    # A generated group is reused for another purpose; pre-existing team is untouched.
    assert len(m.store.objects('groups')) == len(old_groups) + 1
    assert all(g in m.store.objects('groups') for g in old_groups)
    assert 'GatewayRoute(modem2)' in render(m.store.config())['extensions.conf']
    assert client.post('/api/v1/apply').json()['applied']
    m.ingest(Ingest(account='modem2', recipient='10099', sender='10099', content='test', delivery_id='multi'))
    targets = m.store.db.execute('SELECT target FROM jobs ORDER BY target').fetchall()
    assert [r['target'] for r in targets] == ['alice', 'charlie']


def test_cellular_inbound_accepts_registered_account_uri(gateway):
    m,client=gateway;setup(client)
    add(client,'routes',{'id':'in_voice','name':'Voice in','medium':'voice','direction':'inbound',
        'sources':['modem1'],'match':'exact','number':'10086','target_type':'group','target':'team'})
    add(client,'routes',{'id':'out_voice','name':'Voice out','medium':'voice','direction':'outbound',
        'sources':['alice'],'target':'modem1'})
    assert client.post('/api/v1/apply').json()['applied']
    def route(source,number,caller='10086'):
        return m.voice_resolve({'source':source,'number':number,'caller':caller})['dial']
    assert route('modem1','modem1')=='PJSIP/alice&PJSIP/bob'
    assert route('modem1','100')=='PJSIP/alice&PJSIP/bob'
    assert route('modem1','modem1','10010')==''
    assert route('modem1','modem2')==''
    assert route('alice','alice')==''
    assert route('alice','modem1')==''
    assert route('alice','+12345678')=='PJSIP/+12345678@modem1'
    assert route('alice','201')=='PJSIP/bob'
    assert route('alice','123;bad')==''
    assert route('missing','missing')==''
