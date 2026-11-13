"""Linphone push bridge. Credentials and device tokens never enter public config."""
import asyncio
import json
import os
import re
import secrets
import tempfile
import time
import uuid
from pathlib import Path

import httpx
from fastapi import BackgroundTasks, HTTPException, Request
from pydantic import Field

from .models import Strict
from .routing import resolve


class Registration(Strict):
    active: bool = True
    pn_provider: str = Field(default='', max_length=16)
    pn_param: str = Field(default='', max_length=512)
    pn_prid: str = Field(default='', max_length=2048)


class Wake(Strict):
    source: str = Field(max_length=48)
    target: str = Field(max_length=48)
    number: str = Field(max_length=48)
    caller: str = Field(default='', max_length=128)


class PushConfig(Strict):
    enabled: bool = True
    api_url: str = 'https://subscribe.linphone.org/api'
    from_address: str = ''
    api_key: str = ''
    username: str = ''
    password: str = ''
    clear_credentials: bool = False


def parameters(body):
    """Select the VoIP token/topic from RFC 8599 multi-service APNs values."""
    provider, param, prid = body.pn_provider, body.pn_param, body.pn_prid
    if provider not in ('apns', 'apns.dev', 'fcm'):
        return None
    if provider.startswith('apns'):
        if '&' in prid or prid.endswith(':voip'):
            tokens = [v[:-5] for v in prid.split('&') if v.endswith(':voip')]
            if len(tokens) != 1:
                return None
            prid = tokens[0]
        if '&' in param:
            base, sep, services = param.rpartition('.')
            if not sep or 'voip' not in services.split('&'):
                return None
            param = base + '.voip'
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,512}', param):
        return None
    if not re.fullmatch(r'[A-Za-z0-9_:\-]{1,2048}', prid):
        return None
    return {'pn_provider': provider, 'pn_param': param, 'pn_prid': prid}


class Push:
    def __init__(self, store, data):
        self.store, self.data = store, data
        self.path = Path(os.getenv('LINPHONE_PUSH_CONFIG', str(data / 'linphone-push.json')))
        self.key_lock = asyncio.Lock()
        with store.transaction() as db:
            schema = '''
                CREATE TABLE IF NOT EXISTS push_bindings(account TEXT PRIMARY KEY, data TEXT, registered INTEGER);
                CREATE TABLE IF NOT EXISTS sip_registrations(account TEXT PRIMARY KEY, generation INTEGER);
                CREATE TABLE IF NOT EXISTS push_attempts(account TEXT PRIMARY KEY, at REAL, status TEXT, code INTEGER);
                CREATE TABLE IF NOT EXISTS push_wakes(ticket TEXT PRIMARY KEY, data TEXT, created REAL);
            '''
            for statement in schema.split(';'):
                if statement.strip():
                    db.execute(statement)

    def config(self):
        try:
            config = json.loads(self.path.read_text())
            if config.get('api_url', 'https://subscribe.linphone.org/api') not in (
                'https://subscribe.linphone.org/api', 'https://linphone.pro/api'
            ):
                return {}
            if not re.fullmatch(r'sip:[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+', config.get('from', '')):
                return {}
            return config if config.get('enabled', True) else {}
        except (OSError, ValueError, TypeError):
            return {}

    def available(self):
        c = self.config()
        return bool(c.get('api_key') or (c.get('username') and c.get('password')))

    def save_config(self, config):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix='.linphone-push-', dir=self.path.parent)
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(config, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def config_view(self):
        try:
            c = json.loads(self.path.read_text())
        except (OSError, ValueError):
            c = {}
        return {'enabled': c.get('enabled', False),
                'api_url': c.get('api_url', 'https://subscribe.linphone.org/api'),
                'from_address': c.get('from', ''), 'username': c.get('username', ''),
                'has_api_key': bool(c.get('api_key')), 'has_password': bool(c.get('password'))}

    def update_config(self, body):
        if body.api_url not in ('https://subscribe.linphone.org/api', 'https://linphone.pro/api'):
            raise HTTPException(422, 'Unsupported push service URL')
        if not re.fullmatch(r'sip:[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+', body.from_address):
            raise HTTPException(422, 'Invalid push sender address')
        if body.api_key and not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', body.api_key):
            raise HTTPException(422, 'Invalid push API key')
        if len(body.username) > 128 or len(body.password) > 256:
            raise HTTPException(422, 'Invalid push credentials')
        try:
            old = json.loads(self.path.read_text())
        except (OSError, ValueError):
            old = {}
        changed = (body.api_url != old.get('api_url', 'https://subscribe.linphone.org/api')
                   or body.from_address != old.get('from', ''))
        c = {'enabled': body.enabled, 'api_url': body.api_url, 'from': body.from_address,
             'api_key': body.api_key or ('' if changed else old.get('api_key', ''))}
        if not body.clear_credentials:
            c['username'] = body.username
            c['password'] = body.password or (old.get('password', '') if not changed and body.username == old.get('username', '') else '')
        if bool(c.get('username')) != bool(c.get('password')):
            raise HTTPException(422, 'Push username and password are required together')
        if body.enabled and not (c['api_key'] or c.get('password')):
            raise HTTPException(422, 'Push API key or credentials are required')
        self.save_config(c)
        return self.config_view()

    async def generate_key(self, client, c):
        response = await client.get(c.get('api_url', 'https://subscribe.linphone.org/api') + '/accounts/me/api_key',
            headers={'From': c['from'], 'Accept': 'application/json', 'Content-Type': 'application/json'},
            auth=httpx.DigestAuth(c['username'], c['password']))
        response.raise_for_status()
        try:
            key = response.json()
        except ValueError:
            key = response.text.strip()
        if isinstance(key, dict):
            key = key.get('api_key') or key.get('key')
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', key):
            raise ValueError('Invalid key response')
        return key

    async def service_check(self, generate=False):
        async with self.key_lock:
            c = self.config()
            if not c:
                raise HTTPException(422, 'Enable and save push configuration first')
            try:
                async with httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False) as client:
                    if generate:
                        if not c.get('username') or not c.get('password'):
                            raise HTTPException(422, 'Save push credentials first')
                        c['api_key'] = await self.generate_key(client, c)
                        self.save_config(c)
                    if not c.get('api_key'):
                        raise HTTPException(422, 'Generate or save a push API key first')
                    response = await client.get(c.get('api_url', 'https://subscribe.linphone.org/api') + '/accounts/me',
                        headers={'From': c['from'], 'Accept': 'application/json', 'Content-Type': 'application/json',
                                 'x-api-key': c['api_key']})
                    return {'ok': response.is_success, 'code': response.status_code, **self.config_view()}
            except httpx.HTTPStatusError as error:
                return {'ok': False, 'code': error.response.status_code, **self.config_view()}
            except (httpx.HTTPError, ValueError):
                return {'ok': False, 'code': None, **self.config_view()}

    def active(self, identity):
        with self.store.lock:
            row = self.store.db.execute('''SELECT o.data FROM objects o JOIN tenants t
                ON o.kind=t.id||':accounts' WHERE o.id=? AND t.active=1''', (identity,)).fetchone()
        return bool(row and json.loads(row[0]).get('enabled'))

    def binding(self, identity):
        if not self.available() or not self.active(identity):
            return None
        with self.store.lock:
            row = self.store.db.execute('SELECT data,registered FROM push_bindings WHERE account=?', (identity,)).fetchone()
        if not row or row['registered'] < time.time_ns() - 30 * 86400 * 10**9:
            return None
        return json.loads(row['data'])

    def registered(self, identity, body):
        if not self.active(identity):
            return
        value = parameters(body) if body.active else None
        now = time.time_ns()
        with self.store.transaction() as db:
            if body.active:
                db.execute('INSERT OR REPLACE INTO sip_registrations VALUES(?,?)', (identity, now))
            else:
                db.execute('DELETE FROM sip_registrations WHERE account=?', (identity,))
            if value:
                db.execute('INSERT OR REPLACE INTO push_bindings VALUES(?,?,?)', (identity, json.dumps(value), now))
            else:
                db.execute('DELETE FROM push_bindings WHERE account=?', (identity,))

    def allowed(self, body):
        if not self.active(body.source) or not self.active(body.target):
            return False
        path = self.data / 'applied-config.json'
        conf = json.loads(path.read_text()) if path.exists() else self.store.aggregate()
        return body.target in resolve(conf, body.source, body.number, 'voice', caller=body.caller)

    def begin(self, body):
        if not self.allowed(body):
            raise HTTPException(403)
        binding = self.binding(body.target)
        if not binding:
            return {'ticket': '', 'call_id': ''}
        ticket, call_id = secrets.token_hex(16), str(uuid.uuid4())
        value = {'request': body.model_dump(), 'generation': time.time_ns(), 'call_id': call_id}
        with self.store.transaction() as db:
            db.execute('DELETE FROM push_wakes WHERE created<?', (time.time() - 60,))
            db.execute('INSERT INTO push_wakes VALUES(?,?,?)', (ticket, json.dumps(value), time.time()))
            db.execute('INSERT OR REPLACE INTO push_attempts VALUES(?,?,?,NULL)', (body.target, time.time(), 'sending'))
        return {'ticket': ticket, 'call_id': call_id}

    def ready(self, ticket):
        with self.store.lock:
            row = self.store.db.execute('SELECT * FROM push_wakes WHERE ticket=?', (ticket,)).fetchone()
        if not row or row['created'] < time.time() - 30:
            return {'done': True, 'dial': False}
        value = json.loads(row['data'])
        body = Wake(**value['request'])
        if not self.allowed(body):
            return {'done': True, 'dial': False}
        with self.store.lock:
            reg = self.store.db.execute('SELECT generation FROM sip_registrations WHERE account=?', (body.target,)).fetchone()
        ready = bool(reg and reg[0] > value['generation'])
        # A foreground client can remain reachable without refreshing its registration.
        return {'done': ready, 'dial': True}

    async def send(self, ticket):
        with self.store.lock:
            row = self.store.db.execute('SELECT data FROM push_wakes WHERE ticket=?', (ticket,)).fetchone()
        if not row:
            return
        value = json.loads(row[0])
        body = Wake(**value['request'])
        if not self.allowed(body):
            return
        binding = self.binding(body.target)
        if not binding:
            return
        payload = dict(binding, type='call', call_id=value['call_id'])
        code, status = None, 'failed'
        try:
            c = self.config()
            async with httpx.AsyncClient(timeout=5, follow_redirects=False, trust_env=False) as client:
                headers = {'From': c['from'], 'Accept': 'application/json', 'Content-Type': 'application/json'}
                url = c.get('api_url', 'https://subscribe.linphone.org/api')
                key = c.get('api_key', '')
                response = await client.post(url + '/push_notification', headers=dict(headers, **{'x-api-key': key}), json=payload)
                if response.status_code == 401 and c.get('username') and c.get('password'):
                    async with self.key_lock:
                        latest = self.config()
                        if not latest or latest.get('from') != c.get('from') or latest.get('api_url') != c.get('api_url'):
                            raise ValueError('Push configuration changed')
                        if latest.get('api_key', '') != key:
                            key = latest['api_key']
                        else:
                            if not latest.get('username') or not latest.get('password'):
                                raise ValueError('Push renewal credentials removed')
                            c = latest
                            key = await self.generate_key(client, c)
                            c['api_key'] = key
                            self.save_config(c)
                    response = await client.post(url + '/push_notification', headers=dict(headers, **{'x-api-key': key}), json=payload)
                code = response.status_code
                status = 'accepted' if 200 <= code < 300 else 'failed'
        except (httpx.HTTPError, OSError, ValueError, KeyError):
            pass  # Never log tokens, credentials, or external response bodies.
        with self.store.transaction() as db:
            db.execute('INSERT OR REPLACE INTO push_attempts VALUES(?,?,?,?)', (body.target, time.time(), status, code))

    def status(self, identity):
        with self.store.lock:
            row = self.store.db.execute('SELECT registered FROM push_bindings WHERE account=?', (identity,)).fetchone()
            attempt = self.store.db.execute('SELECT at,status,code FROM push_attempts WHERE account=?', (identity,)).fetchone()
        return {'configured': self.available(), 'device_registered': self.binding(identity) is not None,
                'registered_at': row[0] / 10**9 if row else None, 'last_attempt': dict(attempt) if attempt else None}


def install(app, internal, store, data, admin):
    push = Push(store, data)

    @app.get('/api/v1/platform/linphone-push')
    def config(request: Request):
        admin(request)
        return push.config_view()

    @app.put('/api/v1/platform/linphone-push')
    async def update(body: PushConfig, request: Request):
        admin(request)
        async with push.key_lock:
            return push.update_config(body)

    @app.post('/api/v1/platform/linphone-push/{action}')
    async def check(action: str, request: Request):
        admin(request)
        if action not in ('generate', 'check'):
            raise HTTPException(404)
        return await push.service_check(generate=action == 'generate')

    @app.get('/api/v1/accounts/{identity}/push')
    def status(identity: str):
        if not any(a['id'] == identity and a['kind'] == 'client' for a in store.objects('accounts')):
            raise HTTPException(404)
        return push.status(identity)

    @internal.post('/push/wake')
    def wake(body: Wake, tasks: BackgroundTasks):
        result = push.begin(body)
        if result['ticket']:
            tasks.add_task(push.send, result['ticket'])
        return result

    @internal.post('/push/ready')
    def ready(body: dict):
        return push.ready(str(body.get('ticket', '')))

    return push
