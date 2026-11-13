"""Short-lived Linphone configuration exports for published client accounts."""
import hashlib
import json
import logging
import re
import secrets
import time
from xml.etree import ElementTree as ET
from fastapi import HTTPException, Response

PREFIX = '/api/v1/linphone/'
TTL = 600

class RedactProvisioning(logging.Filter):
    def filter(self, record):
        if isinstance(record.args, tuple) and len(record.args) == 5:
            args = list(record.args)
            args[2] = re.sub(r'/api/v1/linphone/[^ ?]+', PREFIX + '[redacted]', str(args[2]))
            record.args = tuple(args)
        return True

def install(app, store, data):
    from .models import Settings
    from .tenancy import current
    store.db.execute('''CREATE TABLE IF NOT EXISTS linphone_tokens(
        digest TEXT PRIMARY KEY, tenant_id TEXT, account_id TEXT, expires REAL, fingerprint TEXT)''')
    logger = logging.getLogger('uvicorn.access')
    if not any(isinstance(f, RedactProvisioning) for f in logger.filters):
        logger.addFilter(RedactProvisioning())

    def published(identity, tenant):
        path = data / 'applied-config.json'
        if not path.exists(): raise HTTPException(409, '请先应用账户配置')
        conf = json.loads(path.read_text())
        account = next((a for a in conf['accounts'] if a['id'] == identity and
                        a.get('tenant_id') == tenant and a['kind'] == 'client' and a['enabled']), None)
        if not account or not store.live_account(identity): raise HTTPException(404)
        settings = conf['settings'][0] if conf['settings'] else Settings().model_dump()
        return account, settings

    def fingerprint(account, settings):
        return hashlib.sha256(json.dumps([account, settings], sort_keys=True).encode()).hexdigest()

    def owned(identity):
        if not any(a['id'] == identity and a['kind'] == 'client' and a['enabled']
                   for a in store.objects('accounts')): raise HTTPException(404)

    @app.post('/api/v1/accounts/{identity}/linphone')
    def issue(identity: str):
        owned(identity)
        tenant = current.get()
        account, settings = published(identity, tenant)
        token = secrets.token_urlsafe(32)
        expires = time.time() + TTL
        with store.transaction() as db:
            db.execute('DELETE FROM linphone_tokens WHERE expires<? OR (tenant_id=? AND account_id=?)',
                       (time.time(), tenant, identity))
            db.execute('INSERT INTO linphone_tokens VALUES(?,?,?,?,?)',
                       (hashlib.sha256(token.encode()).hexdigest(), tenant, identity, expires,
                        fingerprint(account, settings)))
        return {'path': PREFIX + token + '.xml', 'expires': expires}

    @app.delete('/api/v1/accounts/{identity}/linphone')
    def revoke(identity: str):
        owned(identity)
        with store.transaction() as db:
            db.execute('DELETE FROM linphone_tokens WHERE tenant_id=? AND account_id=?', (current.get(), identity))
        return {'ok': True}

    @app.api_route('/api/v1/linphone/{token}.xml', methods=['GET', 'HEAD'])
    def configuration(token: str):
        with store.lock:
            row = store.db.execute('SELECT * FROM linphone_tokens WHERE digest=? AND expires>?',
                (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
            if not row: raise HTTPException(404)
            # Check current ownership and enablement as well as the applied snapshot.
            live = store.db.execute('''SELECT o.data FROM objects o JOIN tenants t ON o.kind=t.id||':accounts'
                WHERE t.id=? AND t.active=1 AND o.id=?''', (row['tenant_id'], row['account_id'])).fetchone()
            if not live or not json.loads(live[0])['enabled'] or json.loads(live[0])['kind'] != 'client':
                raise HTTPException(404)
            account, settings = published(row['account_id'], row['tenant_id'])
            if fingerprint(account, settings) != row['fingerprint']: raise HTTPException(404)
        ns = 'http://www.linphone.org/xsds/lpconfig.xsd'
        ET.register_namespace('', ns)
        root = ET.Element('{' + ns + '}config')
        host = settings['hostname']
        server = f"sip:{host}:{settings['sip_tls_port']};transport=tls"
        sections = {
            'misc': {'transient_provisioning': '1'},
            'sip': {'default_proxy': '0'},
            'net': {'push_notification': '1'},
            'auth_info_0': {'username': account['id'], 'userid': account['id'],
                            'passwd': account['password'], 'realm': settings['realm'], 'domain': host},
            'proxy_0': {'reg_identity': f"sip:{account['id']}@{host}", 'reg_proxy': server,
                        'reg_route': server, 'reg_sendregister': '1',
                        'push_notification_allowed': '1', 'remote_push_notification_allowed': '1',
                        'force_register_on_push': '1',
                        'reg_expires': str(settings['register_interval']), 'publish': '0'},
        }
        for name, entries in sections.items():
            section = ET.SubElement(root, 'section', name=name)
            for key, value in entries.items():
                ET.SubElement(section, 'entry', name=key, overwrite='true').text = value
        return Response(ET.tostring(root, encoding='utf-8', xml_declaration=True), media_type='application/xml',
                        headers={'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'})
