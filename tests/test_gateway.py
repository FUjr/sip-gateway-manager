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
        response=client.post('/api/v1/login',json={'username':'admin','password':'a-secure-test-password'})
        assert response.status_code==200
        client.headers['X-CSRF-Token']=response.json()['csrf']
        yield m,client

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
    assert 'Dial(PJSIP/alice&PJSIP/bob,45)' in files['extensions.conf']
    assert 'exten => 201,1,Dial(PJSIP/bob,45)' in files['extensions.conf']
    assert 'message_context=managed-message' in files['pjsip.conf']
    assert client.post('/api/v1/apply').json()['applied']


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
