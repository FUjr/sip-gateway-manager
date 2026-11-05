"""Tenant accounts, scoped storage, and control-plane authorization."""
import contextvars
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from zoneinfo import ZoneInfo
from fastapi import HTTPException, Request, Response

current = contextvars.ContextVar('tenant', default=None)

def password(value, salt=None):
    if not isinstance(value,str) or not 12 <= len(value) <= 128:
        raise HTTPException(422,'密码需要 12–128 个字符')
    salt=salt or secrets.token_hex(16)
    return salt+':'+hashlib.scrypt(value.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()

def view(row):
    return {k:row[k] for k in ('id','username','admin','timezone','active')}

def install(app,store):
    store.db.executescript('''
    CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,username TEXT UNIQUE COLLATE NOCASE,password TEXT NOT NULL,admin INTEGER,timezone TEXT,active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS identities(token TEXT PRIMARY KEY,tenant_id TEXT);
    CREATE TABLE IF NOT EXISTS platform(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS account_registry(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS published(tenant_id TEXT PRIMARY KEY,data TEXT);
    ''')
    def admin(request):
        if not request.state.user['admin']: raise HTTPException(403,'需要平台管理员权限')
    def create(body,first=False):
        name=body.get('username','').strip()
        if not name or len(name)>80: raise HTTPException(422,'无效用户名')
        zone=body.get('timezone','UTC')
        try: ZoneInfo(zone)
        except (ValueError,KeyError,TypeError): raise HTTPException(422,'无效时区')
        row=dict(id='t'+secrets.token_hex(6),username=name,password=password(body.get('password')),admin=int(first),timezone=zone,active=1)
        try: store.db.execute('INSERT INTO tenants VALUES(:id,:username,:password,:admin,:timezone,:active)',row)
        except sqlite3.IntegrityError: raise HTTPException(409,'用户名已存在')
        return row
    def issue(row,response):
        token,csrf=secrets.token_urlsafe(48),secrets.token_urlsafe(32)
        key=hashlib.sha256(token.encode()).hexdigest()
        with store.transaction() as db:
            db.execute('INSERT INTO sessions VALUES(?,?,?)',(key,csrf,time.time()+43200))
            db.execute('INSERT INTO identities VALUES(?,?)',(key,row['id']))
        response.set_cookie('session',token,secure=True,httponly=True,samesite='strict',max_age=43200)
        return dict(csrf=csrf,**view(row))
    @app.get('/api/v1/auth/state')
    def state():
        with store.lock:
            first=not store.db.execute('SELECT 1 FROM tenants LIMIT 1').fetchone()
            row=store.db.execute("SELECT value FROM platform WHERE key='registration'").fetchone()
        return dict(bootstrap=first,registration_open=first or bool(row and row[0]=='1'))
    @app.post('/api/v1/register')
    def register(body:dict,response:Response):
        with store.transaction():
            status=state()
            if not status['registration_open']: raise HTTPException(403,'注册已关闭')
            row=create(body,status['bootstrap'])
        return issue(row,response)
    @app.post('/api/v1/login')
    def login(body:dict,request:Request,response:Response):
        now=time.time(); peer=request.client.host
        attempts=app.state.attempts.setdefault(peer,[])
        attempts[:]=[t for t in attempts if now-t<300]
        if len(attempts)>=10: raise HTTPException(429,'请五分钟后重试')
        with store.lock: row=store.db.execute('SELECT * FROM tenants WHERE username=? COLLATE NOCASE AND active=1',(body.get('username',''),)).fetchone()
        try: valid=row and hmac.compare_digest(password(body.get('password'),row['password'].split(':')[0]),row['password'])
        except HTTPException: valid=False
        if not valid:
            attempts.append(now)
            raise HTTPException(401,'invalid credentials')
        return issue(row,response)
    @app.get('/api/v1/session')
    def session(request:Request): return dict(csrf=request.state.user['csrf'],**view(request.state.user))
    @app.get('/api/v1/platform/tenants')
    def tenants(request:Request):
        admin(request)
        with store.lock: return [view(r) for r in store.db.execute('SELECT * FROM tenants ORDER BY username')]
    @app.post('/api/v1/platform/tenants')
    def add(body:dict,request:Request):
        admin(request)
        with store.transaction(): return view(create(body))
    @app.put('/api/v1/platform/registration')
    def registration(body:dict,request:Request):
        admin(request)
        if type(body.get('enabled')) is not bool: raise HTTPException(422)
        with store.transaction() as db: db.execute("INSERT OR REPLACE INTO platform VALUES('registration',?)",('1' if body['enabled'] else '0',))
        return state()
    @app.put('/api/v1/me/timezone')
    def timezone(body:dict):
        try: ZoneInfo(body['timezone'])
        except (KeyError,TypeError,ValueError): raise HTTPException(422,'无效时区')
        with store.transaction() as db: db.execute('UPDATE tenants SET timezone=? WHERE id=?',(body['timezone'],current.get()))
        return {'ok':True}
    @app.post('/api/v1/platform/tenants/{identity}/reset-password')
    def reset(identity:str,body:dict,request:Request):
        admin(request)
        return update_password(identity,body)
    def update_password(identity,body):
        hashed=password(body.get('password'))
        with store.transaction() as db:
            if not db.execute('UPDATE tenants SET password=? WHERE id=?',(hashed,identity)).rowcount: raise HTTPException(404)
            db.execute('DELETE FROM sessions WHERE token IN (SELECT token FROM identities WHERE tenant_id=?)',(identity,))
        return {'ok':True}
    @app.put('/api/v1/me/password')
    def change(body:dict,request:Request):
        row=request.state.user
        if not hmac.compare_digest(password(body.get('current_password'),row['password'].split(':')[0]),row['password']): raise HTTPException(403)
        return update_password(row['id'],body)
    app.state.attempts={}
    @app.middleware('http')
    async def authenticate(request,call_next):
        context=None
        public_provision = request.method in ('GET', 'HEAD') and re.fullmatch(r'/api/v1/linphone/[A-Za-z0-9_-]{43}\.xml', request.url.path)
        if not public_provision and request.url.path not in ('/api/v1/login','/api/v1/register','/api/v1/auth/state','/api/v1/health'):
            key=hashlib.sha256(request.cookies.get('session','').encode()).hexdigest()
            with store.lock:
                row=store.db.execute('SELECT t.*,s.csrf FROM sessions s JOIN identities i ON i.token=s.token JOIN tenants t ON t.id=i.tenant_id WHERE s.token=? AND s.expires>? AND t.active=1',(key,time.time())).fetchone()
            if not row: return Response('authentication required',401)
            if request.method not in ('GET','HEAD') and not hmac.compare_digest(request.headers.get('x-csrf-token',''),row['csrf']): return Response('invalid CSRF token',403)
            request.state.user=dict(row)
            context=current.set(row['id'])
        try:
            result=await call_next(request)
            result.headers['Cache-Control']='no-store'
            result.headers['X-Content-Type-Options']='nosniff'
            return result
        finally:
            if context is not None: current.reset(context)
    return admin
