import importlib
from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient
from backend.routing import scheduled

@pytest.fixture
def server(tmp_path,monkeypatch):
    monkeypatch.setenv('DATA_DIR',str(tmp_path))
    import backend.main
    m=importlib.reload(backend.main)
    return m

def register(m,name='owner'):
    c=TestClient(m.app,base_url='https://testserver')
    r=c.post('/api/v1/register',json={'username':name,'password':'a sufficiently long password','timezone':'Asia/Shanghai'})
    assert r.status_code==200,r.text
    c.headers['x-csrf-token']=r.json()['csrf']
    return c,r.json()

def test_bootstrap_registration_permissions_and_delete(server):
    m=server
    admin,user=register(m)
    assert user['admin']==1
    assert not admin.get('/api/v1/auth/state').json()['registration_open']
    assert TestClient(m.app).post('/api/v1/register',json={}).status_code==403
    assert admin.put('/api/v1/platform/registration',json={'enabled':True}).status_code==200
    tenant,other=register(m,'second')
    assert other['admin']==0
    assert tenant.get('/api/v1/platform/tenants').status_code==403
    assert tenant.put('/api/v1/settings/main',json={}).status_code==403
    assert admin.delete('/api/v1/platform/tenants/'+user['id']).status_code==409
    assert admin.delete('/api/v1/platform/tenants/'+other['id']).status_code==200
    assert tenant.get('/api/v1/session').status_code==401
    assert not admin.get('/api/v1/auth/state').json()['bootstrap']

def test_resource_isolation_and_independent_publish(server):
    m=server
    a,owner=register(m)
    a.put('/api/v1/platform/registration',json={'enabled':True})
    b,other=register(m,'second')
    def account(c,who):
        identity=who['id']+'_phone'
        result=c.put('/api/v1/accounts/'+identity,json={'id':identity,'name':'Phone','kind':'client','extension':'200','password':'abcdefghijklmnop'})
        assert result.status_code==200,result.text
        return identity
    one=account(a,owner);two=account(b,other)
    assert {x['id'] for x in a.get('/api/v1/config').json()['accounts']}=={one}
    assert b.get('/api/v1/accounts/'+one+'/provision').status_code==404
    assert b.put('/api/v1/groups/forged',json={'id':'forged','name':'forged','members':[one]}).status_code==422
    assert a.post('/api/v1/apply').status_code==200
    assert [x['id'] for x in m.store.aggregate()['accounts']]==[one]
    assert b.get('/api/v1/status').json()['pending_changes']
    assert b.post('/api/v1/apply').status_code==200
    conf=m.store.aggregate()
    from backend.routing import resolve
    assert resolve(conf,one,'200','voice')==[one]
    assert resolve(conf,two,'200','sms')==[two]
    assert len(conf['accounts'])==2

def test_schedule_boundaries_overnight_and_timezone():
    r={'timezone':'Asia/Shanghai','schedule':{'weekdays':[0],'windows':[{'start':'22:00','end':'02:00'}]}}
    def check(iso): return scheduled(r,datetime.fromisoformat(iso))
    assert check('2026-11-02T14:00:00+00:00')
    assert check('2026-11-02T17:59:59+00:00')
    assert not check('2026-11-02T18:00:00+00:00')
    assert not check('2026-11-03T14:00:00+00:00')
    r['timezone']='America/New_York';r['schedule']={'weekdays':[6],'windows':[{'start':'01:00','end':'02:00'}]}
    assert check('2026-11-01T05:30:00+00:00')
    assert check('2026-11-01T06:30:00+00:00')

def test_concurrent_bootstrap_has_only_one_administrator(server):
    from concurrent.futures import ThreadPoolExecutor
    def attempt(name):
        with TestClient(server.app,base_url='https://testserver') as client:
            return client.post('/api/v1/register',json={'username':name,'password':'parallel-registration-password'}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(attempt,['first','second']))
    assert sorted(results)==[200,403]
    assert server.store.db.execute('SELECT count(*) FROM tenants WHERE admin=1').fetchone()[0]==1

def test_password_reset_revokes_sessions_and_retired_identity(server):
    a,owner=register(server)
    result=a.post('/api/v1/platform/tenants',json={'username':'second','password':'a sufficiently long password'})
    other=result.json();b=TestClient(server.app,base_url='https://testserver')
    login=b.post('/api/v1/login',json={'username':'second','password':'a sufficiently long password'})
    b.headers['x-csrf-token']=login.json()['csrf']
    identity=other['id']+'_phone'
    value={'id':identity,'name':'Phone','kind':'client','extension':'200','password':'abcdefghijklmnop'}
    assert b.put('/api/v1/accounts/'+identity,json=value).status_code==200
    assert a.post('/api/v1/platform/tenants/'+other['id']+'/reset-password',json={'password':'another long password'}).status_code==200
    assert b.get('/api/v1/config').status_code==401
    assert a.delete('/api/v1/platform/tenants/'+other['id']).status_code==200
    assert a.put('/api/v1/accounts/'+identity,json=value).status_code==422

def test_caller_rules_and_schedule_use_same_runtime_resolver():
    from backend.routing import resolve
    conf={'accounts':[{'id':'line','kind':'device','enabled':True,'voice_enabled':True,'sms_enabled':True,'extension':'100','tenant_id':'tenant'}, {'id':'phone','kind':'client','enabled':True,'voice_enabled':True,'sms_enabled':True,'extension':'200','tenant_id':'tenant'}], 'groups':[], 'routes':[{'id':'rule','tenant_id':'tenant','timezone':'UTC','medium':'voice','direction':'inbound','enabled':True,'sources':['line'],'match':'exact','number':'10099','priority':0,'target_type':'account','target':'phone','schedule':{'weekdays':[0],'windows':[{'start':'09:00','end':'17:00'}]}}]}
    when=datetime.fromisoformat('2026-11-02T10:00:00+00:00')
    assert resolve(conf,'line','arbitrary','voice',caller='10099',now=when)==['phone']
    assert resolve(conf,'line','10099','voice',caller='12345',now=when)==[]
    assert resolve(conf,'line','arbitrary','voice',caller='10099',now=datetime.fromisoformat('2026-11-02T17:00:00+00:00'))==[]
