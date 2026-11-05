import asyncio
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import time
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Response
from .models import Account, Device, Group, Route, Settings, Login, Ingest, Completion
from .store import Store
from .routing import resolve, validate
from .render import render
from .experience import ServiceIntent, Rehearsal, describe, compile_service, rehearse

DATA = Path(os.getenv('DATA_DIR', '/data'))
store = Store(str(DATA / 'gateway.sqlite3'))
app = FastAPI(docs_url=None, redoc_url=None)
MODELS = {'devices': Device, 'accounts': Account, 'groups': Group, 'routes': Route, 'settings': Settings}
failures = {}
apply_lock = asyncio.Lock()

from .tenancy import install, current
admin = install(app, store)

@app.get('/api/v1/health')
def health():
    if os.getenv('PBX_MANAGED') == '1':
        try:
            result = subprocess.run(['asterisk','-rx','module show like res_sip_gateway'],capture_output=True,text=True,timeout=3)
            if result.returncode or 'Running' not in result.stdout: raise RuntimeError('PBX not ready')
        except (OSError,subprocess.TimeoutExpired,RuntimeError):
            raise HTTPException(503,'PBX not ready')
    return {'status': 'ok'}

@app.post('/api/v1/logout')
def logout(request: Request, response: Response):
    with store.transaction() as db:
        db.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(request.cookies['session'].encode()).hexdigest(),))
    response.delete_cookie('session', secure=True)
    return {'ok': True}

@app.get('/api/v1/config')
def config():
    return store.config()

@app.get('/api/v1/experience')
def experience():
    return describe(store.config())

@app.post('/api/v1/line-service')
def line_service(body: ServiceIntent):
    try:
        # Optimistic revision check and all generated objects share one transaction.
        with store.transaction() as db:
            updated = compile_service(store.config(), body)
            for kind in ('groups', 'routes'):
                for value in updated[kind]:
                    db.execute('INSERT OR REPLACE INTO objects VALUES(?,?,?)', (store.key(kind), value['id'], json.dumps({k:v for k,v in value.items() if k not in ('tenant_id','timezone')})))
            result = describe(store.config())
        return result
    except ValueError as error:
        raise HTTPException(409, str(error))

@app.post('/api/v1/rehearse')
def rehearsal(body: Rehearsal):
    try:
        conf=store.config()
        if body.applied:
            with store.lock: row=store.db.execute('SELECT data FROM published WHERE tenant_id=?',(current.get(),)).fetchone()
            if not row: raise ValueError('尚未应用配置')
            conf=json.loads(row[0])
        return rehearse(conf, body)
    except ValueError as error:
        raise HTTPException(422, str(error))

@app.post('/api/v1/rule-set')
def rule_set(body: dict):
    from .experience import revision
    try:
        with store.transaction() as db:
            conf=store.config()
            if body.get('revision') != revision(conf): raise HTTPException(409,'配置已更新，请刷新')
            for kind in ('groups','routes'):
                values=[MODELS[kind].model_validate({k:v for k,v in value.items() if k not in ('tenant_id','timezone')}).model_dump() for value in body[kind]]
                for value in values:
                    if not value['id'].startswith(current.get()+'_'): raise ValueError('invalid owned rule ID')
                db.execute('DELETE FROM objects WHERE kind=?',(store.key(kind),))
                for value in values: db.execute('INSERT INTO objects VALUES(?,?,?)',(store.key(kind),value['id'],json.dumps(value)))
            validate(store.config())
        return describe(store.config())
    except (ValueError,KeyError,TypeError) as error: raise HTTPException(422,str(error))

@app.put('/api/v1/{kind}/{identity}')
def put(kind: str, identity: str, body: dict, request: Request):
    if kind == 'settings': admin(request)
    if kind not in MODELS:
        raise HTTPException(404)
    try:
        value = MODELS[kind].model_validate({k:v for k,v in body.items() if k not in ('tenant_id','timezone')}).model_dump()
        if kind == 'settings':
            identity = 'main'
        elif value['id'] != identity:
            raise ValueError('ID cannot change')
        with store.transaction() as db:
            if kind == 'accounts':
                owner=db.execute('SELECT tenant_id FROM account_registry WHERE id=?',(identity,)).fetchone()
                if owner and owner[0] != current.get(): raise ValueError('account identity belongs to another tenant or is retired')
                db.execute('INSERT OR IGNORE INTO account_registry VALUES(?,?)',(identity,current.get()))
            if kind != 'settings' and db.execute('SELECT 1 FROM objects WHERE id=? AND kind!=? AND kind LIKE ?', (identity,store.key(kind),'%:'+kind)).fetchone():
                raise ValueError('ID already owned by another tenant')
            db.execute('INSERT OR REPLACE INTO objects VALUES(?,?,?)', (store.key(kind), identity, json.dumps(value)))
            validate(store.config())
    except (ValueError, TypeError) as error:
        raise HTTPException(422, str(error))
    return value

@app.delete('/api/v1/{kind}/{identity}')
def delete(kind: str, identity: str, request: Request):
    if kind == 'settings': admin(request)
    if kind not in MODELS:
        raise HTTPException(404)
    try:
        with store.transaction() as db:
            db.execute('DELETE FROM objects WHERE kind=? AND id=?', (store.key(kind), identity))
            validate(store.config())
    except ValueError as error:
        raise HTTPException(409, str(error))
    return {'ok': True}

@app.get('/api/v1/accounts/{identity}/provision')
def provision(identity: str):
    conf = store.config()
    account = next((a for a in conf['accounts'] if a['id'] == identity and a['kind'] == 'device'), None)
    if not account:
        raise HTTPException(404, 'modem account not found')
    s = conf['settings'][0] if conf['settings'] else Settings().model_dump()
    return {'schema_version': 1, 'account_id': account['id'], 'server': s['hostname'],
            'port': s['sip_tls_port'], 'transport': 'tls', 'username': account['id'],
            'password': account['password'], 'realm': s['realm'], 'register_interval': s['register_interval'],
            'sms_enabled': account['sms_enabled'], 'voip_enabled': account['voice_enabled'],
            'sms_ingress_uri': f"sips:sms@{s['hostname']}:{s['sip_tls_port']};transport=tls"}

@app.get('/api/v1/preview')
def preview():
    # Admin only: generated SIP files contain credentials.
    return render(store.config())

@app.post('/api/v1/apply')
async def apply():
    return await publish()

async def publish(include_draft=True):
    async with apply_lock:
        own = store.config()
        validate(own)
        conf = store.aggregate(own if include_draft else None)
        revision = hashlib.sha256(json.dumps(conf, sort_keys=True).encode()).hexdigest()[:16]
        stage = DATA / 'revisions' / revision
        stage.mkdir(parents=True, exist_ok=True, mode=0o700)
        for filename, content in render(conf).items():
            path = stage / filename
            path.write_text(content)
            path.chmod(0o600)
        applied = DATA / 'applied.json'
        previous = json.loads(applied.read_text()) if applied.exists() else None
        settings = conf['settings'][0] if conf['settings'] else Settings().model_dump()
        restart = bool(previous and any(previous['settings'][key] != settings[key] for key in ('sip_tls_port','rtp_start','rtp_end')))
        if restart:
            return {'revision': revision, 'restart_required': True, 'applied': False,
                    'detail': 'Transport/RTP changes need an explicit PBX restart; staged configuration retained.'}
        if os.getenv('PBX_MANAGED') == '1':
            root = Path(os.getenv('ASTERISK_CONFIG_DIR','/etc/asterisk'))
            backup = {name: (root/name).read_text() if (root/name).exists() else None for name in render(conf)}
            try:
                for filename in render(conf):
                    temp = root / (filename + '.new')
                    temp.write_text((stage/filename).read_text())
                    temp.chmod(0o640)
                    import shutil
                    shutil.chown(temp, user='asterisk', group='asterisk')
                    temp.replace(root/filename)
                result = await asyncio.to_thread(subprocess.run, ['asterisk', '-rx', 'core reload'], capture_output=True, text=True, timeout=15)
                if result.returncode or 'Unable' in result.stdout or 'Error' in result.stdout:
                    raise RuntimeError('PBX reload rejected; previous configuration restored')
                for account in conf['accounts']:
                    if account['enabled']:
                        check = await asyncio.to_thread(subprocess.run, ['asterisk','-rx','pjsip show endpoint '+account['id']], capture_output=True, text=True, timeout=10)
                        if check.returncode or 'Endpoint:' not in check.stdout:
                            raise RuntimeError('Generated endpoint was rejected by PBX')
            except Exception as error:
                for name, content in backup.items():
                    if content is None:
                        (root/name).unlink(missing_ok=True)
                    else:
                        (root/name).write_text(content)
                try:
                    await asyncio.to_thread(subprocess.run, ['asterisk', '-rx', 'core reload'], capture_output=True, timeout=15)
                except (OSError, subprocess.TimeoutExpired):
                    pass
                raise HTTPException(503, str(error))
        if include_draft:
            with store.transaction() as db:
                db.execute('INSERT OR REPLACE INTO published VALUES(?,?)',(current.get(),json.dumps(own)))
                if db.execute('SELECT admin FROM tenants WHERE id=?',(current.get(),)).fetchone()[0]:
                    db.execute("INSERT OR REPLACE INTO platform VALUES('active_settings',?)",(json.dumps(own['settings']),))
        active = DATA / 'applied-config.json.new'
        active.write_text(json.dumps(conf))
        active.chmod(0o600)
        active.replace(DATA / 'applied-config.json')
        applied.write_text(json.dumps({'revision': revision, 'settings': settings}))
        applied.chmod(0o600)
        return {'revision': revision, 'restart_required': False, 'applied': True}

@app.get('/api/v1/status')
async def status():
    with store.lock:
        counts = dict(store.db.execute('SELECT j.status,count(*) FROM jobs j JOIN messages m ON m.id=j.message_id WHERE m.source IN (SELECT id FROM objects WHERE kind=?) GROUP BY j.status',(store.key('accounts'),)).fetchall())
        conf = store.config()
    registrations = None
    if os.getenv('PBX_MANAGED') == '1':
        from .ami import contacts
        try:
            live = await asyncio.wait_for(contacts(), 2)
            registrations = {a['id']: live.get(a['id'], False) for a in conf['accounts']}
        except (OSError, TimeoutError, RuntimeError, asyncio.IncompleteReadError):
            pass
    return {'deliveries': counts,
            'registrations': registrations,
            'pending_changes': store.pending(),
            'applied': json.loads((DATA/'applied.json').read_text()) if (DATA/'applied.json').exists() else None}

@app.get('/api/v1/deliveries')
def deliveries():
    with store.lock:
        return [dict(row) for row in store.db.execute('SELECT j.*,m.source,m.recipient,m.created FROM jobs j JOIN messages m ON m.id=j.message_id WHERE m.source IN (SELECT id FROM objects WHERE kind=?) ORDER BY m.created DESC LIMIT 500',(store.key('accounts'),))]

@app.post('/api/v1/deliveries/{identity}/retry')
def retry(identity: str):
    if identity not in {r['id'] for r in deliveries()}: raise HTTPException(404)
    with store.transaction() as db:
        db.execute("UPDATE jobs SET status='pending',next=?,updated=? WHERE id=? AND status IN ('failed','pending') AND message_id IN (SELECT id FROM messages WHERE expires>? AND body IS NOT NULL)", (time.time(),time.time(),identity,time.time()))
    return {'ok': True}

# Called only by the local Unix socket bridge. Never mounted on the public ASGI app.
internal = FastAPI(docs_url=None, redoc_url=None)

@internal.post('/ingest')
def ingest(message: Ingest):
    now = time.time()
    fingerprint = hashlib.sha256(json.dumps(message.model_dump(exclude={'delivery_id'}), sort_keys=True).encode()).hexdigest()
    identity = hashlib.sha256((message.account + ':' + message.delivery_id).encode()).hexdigest()
    conf = json.loads((DATA/'applied-config.json').read_text()) if os.getenv('PBX_MANAGED') == '1' and (DATA/'applied-config.json').exists() else store.aggregate()
    if not store.live_account(message.account): raise HTTPException(404,'inactive account')
    targets = resolve(conf, message.account, message.recipient, 'sms')
    with store.transaction() as db:
        old = db.execute('SELECT fingerprint FROM messages WHERE id=?', (identity,)).fetchone()
        if old:
            if old['fingerprint'] != fingerprint:
                raise HTTPException(409, 'delivery ID reused with different content')
            return {'accepted': True, 'duplicate': True}
        if not targets:
            raise HTTPException(404, 'no SMS route')
        ttl = conf['settings'][0]['sms_ttl'] if conf['settings'] else 604800
        source = next(a for a in conf['accounts'] if a['id']==message.account)
        sender = source['extension'] if source['kind']=='client' else message.sender
        db.execute('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)', (identity,message.account,message.recipient,sender,message.content,now,now+ttl,fingerprint))
        for target in targets:
            delivery = hashlib.sha256((identity + ':' + target).encode()).hexdigest()
            db.execute('INSERT INTO jobs(id,message_id,target,status,next,updated) VALUES(?,?,?,?,?,?)', (delivery,identity,target,'pending',now,now))
    return {'accepted': True, 'duplicate': False}

@internal.post('/complete')
def complete(completion: Completion):
    now = time.time()
    with store.transaction() as db:
        row = db.execute('SELECT attempts,status FROM jobs WHERE id=?', (completion.delivery_id,)).fetchone()
        if not row or row['status'] != 'sending':
            return {'ok': True}
        status = 'delivered' if 200 <= completion.code < 300 else ('failed' if 400 <= completion.code < 500 and completion.code not in (408,429,480) else 'pending')
        db.execute('UPDATE jobs SET status=?,code=?,next=?,updated=? WHERE id=?', (status,completion.code,now+min(300,30*2**min(row['attempts']-1,4)),now,completion.delivery_id))
        db.execute("UPDATE messages SET body=NULL WHERE id IN (SELECT message_id FROM jobs GROUP BY message_id HAVING sum(status NOT IN ('delivered','failed','expired'))=0)")
    return {'ok': True}

@internal.post('/registered/{account}')
def registered(account: str):
    with store.transaction() as db:
        db.execute("UPDATE jobs SET next=? WHERE target=? AND status='pending'", (time.time(),account))
    return {'ok': True}

async def dispatcher():
    from .ami import send
    # A crash may interrupt sends after the peer accepted: stable DeliveryID supports modem dedupe.
    with store.transaction() as db:
        db.execute("UPDATE jobs SET status='pending' WHERE status='sending'")
    while True:
        now = time.time()
        with store.transaction() as db:
            db.execute("UPDATE jobs SET status='expired',updated=? WHERE status IN ('pending','sending') AND message_id IN (SELECT id FROM messages WHERE expires<=?)", (now,now))
            db.execute("UPDATE jobs SET status='pending',next=? WHERE status='sending' AND updated<?", (now,now-45))
            db.execute('UPDATE messages SET body=NULL WHERE expires<=?', (now,))
            db.execute('DELETE FROM jobs WHERE updated<? AND status IN (\'delivered\',\'failed\',\'expired\')', (now-2592000,))
            db.execute('DELETE FROM messages WHERE created<? AND id NOT IN (SELECT message_id FROM jobs)', (now-2592000,))
            row = db.execute("SELECT j.*,m.body,m.sender,m.recipient,m.source FROM jobs j JOIN messages m ON m.id=j.message_id WHERE j.status='pending' AND j.next<=? AND m.body IS NOT NULL ORDER BY j.next LIMIT 1", (now,)).fetchone()
            if row:
                db.execute("UPDATE jobs SET status='sending',attempts=attempts+1,updated=? WHERE id=?", (now,row['id']))
        if row:
            try:
                job = dict(row)
                conf = json.loads((DATA/'applied-config.json').read_text()) if (DATA/'applied-config.json').exists() else store.aggregate()
                account = next((a for a in conf['accounts'] if a['id'] == job['target']), None)
                if not store.live_account(job['target']) or not store.live_account(job['source']):
                    complete(Completion(delivery_id=row['id'],code=403))
                    continue
                if account and account['kind'] == 'client':
                    job['recipient'] = account['extension']
                await send(job)
            except Exception:
                complete(Completion(delivery_id=row['id'],code=503))
        await asyncio.sleep(0.5)

@app.on_event('startup')
async def startup():
    if os.getenv('PBX_MANAGED') == '1':
        app.state.dispatcher = asyncio.create_task(dispatcher())

@app.on_event('shutdown')
async def shutdown():
    if hasattr(app.state, 'dispatcher'):
        app.state.dispatcher.cancel()


@app.delete('/api/v1/platform/tenants/{identity}')
async def remove_tenant(identity: str,request: Request):
    admin(request)
    if identity == current.get(): raise HTTPException(409,'不能删除当前管理员')
    with store.transaction() as db:
        if not db.execute('UPDATE tenants SET active=0 WHERE id=?',(identity,)).rowcount: raise HTTPException(404)
        db.execute('DELETE FROM sessions WHERE token IN (SELECT token FROM identities WHERE tenant_id=?)',(identity,))
        db.execute('DELETE FROM jobs WHERE message_id IN (SELECT id FROM messages WHERE source IN (SELECT id FROM objects WHERE kind=?))',(identity+':accounts',))
        db.execute('DELETE FROM messages WHERE source IN (SELECT id FROM objects WHERE kind=?)',(identity+':accounts',))
        db.execute('DELETE FROM objects WHERE substr(kind,1,?)=?',(len(identity)+1,identity+':'))
        db.execute('DELETE FROM published WHERE tenant_id=?',(identity,))
    await publish(False)
    import shutil
    revisions=DATA/'revisions'
    if revisions.exists():
        for directory in revisions.iterdir():
            if directory.is_dir() and directory.name != json.loads((DATA/'applied.json').read_text())['revision']:
                shutil.rmtree(directory)
    with store.transaction() as db:
        db.execute('DELETE FROM identities WHERE tenant_id=?',(identity,))
        db.execute('DELETE FROM tenants WHERE id=?',(identity,))
    return {'ok':True}

@internal.post('/resolve')
def voice_resolve(body: dict):
    source=body.get('source','')
    if not store.live_account(source): return {'dial':''}
    conf=json.loads((DATA/'applied-config.json').read_text()) if (DATA/'applied-config.json').exists() else store.aggregate()
    accounts={a['id']:a for a in conf['accounts']}
    account=accounts.get(source)
    if not account: return {'dial':''}
    number=body.get('number','')
    import re
    # Cellular gateways address inbound INVITEs to their own registered AoR.
    # Only client-originated calls need a numeric dialled destination.
    numeric=isinstance(number,str) and re.fullmatch(r'\+?[0-9]{1,24}',number)
    if not numeric and not (account['kind']=='device' and number==source):
        return {'dial':''}
    targets=resolve(conf,source,number,'voice',caller=body.get('caller',''))
    targets=[t for t in targets if store.live_account(t)]
    return {'dial':'&'.join('PJSIP/'+t if account['kind']=='device' or accounts[t]['kind']=='client' else 'PJSIP/'+number+'@'+t for t in targets)}
