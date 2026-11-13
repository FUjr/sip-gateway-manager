import asyncio
import json
import stat

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.push import Registration, Wake, parameters
from test_gateway import gateway, setup, add


def test_admin_configuration_secrets_preservation_and_permissions(gateway):
    m, c = gateway
    url = '/api/v1/platform/linphone-push'
    body = {'enabled': True, 'from_address': 'sip:test@sip.linphone.org',
            'api_key': 'test-key-with-at-least-20-characters', 'username': 'test',
            'password': 'private-test-password'}
    assert TestClient(m.app).get(url).status_code == 401
    assert c.put(url, json=body, headers={'X-CSRF-Token': ''}).status_code == 403
    assert c.put(url, json=body).status_code == 200
    view = c.get(url)
    assert view.json()['has_api_key'] and view.json()['has_password']
    assert body['api_key'] not in view.text and body['password'] not in view.text
    assert stat.S_IMODE(m.push.path.stat().st_mode) == 0o600
    body['api_key'] = body['password'] = ''
    assert c.put(url, json=body).status_code == 200
    assert m.push.config()['password'] == 'private-test-password'
    assert m.push.config()['api_key'] == 'test-key-with-at-least-20-characters'
    previous = m.push.path.read_bytes()
    assert c.put(url, json={**body, 'api_url': 'http://localhost/private'}).status_code == 422
    assert c.put(url, json={**body, 'from_address': 'sip:other@sip.linphone.org'}).status_code == 422
    assert m.push.path.read_bytes() == previous
    assert c.put(url, json={**body, 'clear_credentials': True}).status_code == 200
    assert not c.get(url).json()['has_password']
    assert c.put(url, json={**body, 'enabled': False, 'clear_credentials': True}).status_code == 200
    assert not m.push.available()
    assert c.put('/api/v1/platform/registration', json={'enabled': True}).status_code == 200
    tenant = TestClient(m.app, base_url='https://testserver')
    registered = tenant.post('/api/v1/register', json={'username': 'ordinary', 'password': 'ordinary-test-password'})
    tenant.headers['X-CSRF-Token'] = registered.json()['csrf']
    for method, path, data in [('GET', url, None), ('PUT', url, body), ('POST', url + '/generate', {}), ('POST', url + '/check', {})]:
        assert tenant.request(method, path, json=data).status_code == 403


def test_server_key_generation_and_validation_do_not_send_push(gateway, monkeypatch):
    m, c = gateway
    url = '/api/v1/platform/linphone-push'
    assert c.put(url, json={'from_address': 'sip:test@sip.linphone.org', 'username': 'test',
                            'password': 'private-test-password'}).status_code == 200
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path.endswith('/api_key'):
            return httpx.Response(200, json='generated-key-with-20-characters')
        assert request.url.path == '/api/accounts/me'
        assert request.headers['x-api-key'] == 'generated-key-with-20-characters'
        return httpx.Response(200, json={'private_account_data': 'must-not-return'})
    original = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    response = c.post(url + '/generate')
    assert response.status_code == 200 and response.json()['ok']
    assert 'generated-key' not in response.text and 'must-not-return' not in response.text
    assert m.push.config()['api_key'] == 'generated-key-with-20-characters'
    assert c.post(url + '/check').json()['code'] == 200
    assert len(requests) == 3 and all(r.method == 'GET' for r in requests)
    def failure(request):
        return httpx.Response(403, text='sensitive upstream body')
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(failure), **kwargs))
    failed = c.post(url + '/generate')
    assert failed.json()['code'] == 403 and not failed.json()['ok']
    assert 'sensitive' not in failed.text
    assert m.push.config()['api_key'] == 'generated-key-with-20-characters'


def enable(m):
    m.push.path.write_text(json.dumps({'from': 'sip:test@sip.linphone.org', 'api_key': 'old-key',
                                     'username': 'test', 'password': 'test-only-password'}))


def binding():
    return Registration(pn_provider='apns', pn_param='TEAM.org.linphone.phone.voip&remote',
                        pn_prid='ABC123:voip&DEF456:remote')


def test_apns_voip_selection_and_invalid_parameters():
    assert parameters(binding()) == {'pn_provider': 'apns', 'pn_param': 'TEAM.org.linphone.phone.voip', 'pn_prid': 'ABC123'}
    assert parameters(Registration(pn_provider='other', pn_param='topic', pn_prid='token')) is None
    assert parameters(Registration(pn_provider='apns', pn_param='topic', pn_prid='BAD\r\nTOKEN')) is None
    assert parameters(Registration(pn_provider='apns', pn_param='topic', pn_prid='ABC:remote&DEF:remote')) is None


def test_registration_wake_and_route_revocation(gateway):
    m, c = gateway; setup(c); enable(m)
    assert c.post('/api/v1/apply').status_code == 200
    m.push.registered('bob', binding())
    wake = Wake(source='alice', target='bob', number='201')
    result = m.push.begin(wake)
    assert result['ticket'] and result['call_id']
    assert m.push.ready(result['ticket']) == {'done': False, 'dial': True}
    assert m.voice_resolve({'source': 'alice', 'number': '201'})['dial'] == 'Local/bob@gateway-wake/n'
    m.push.registered('bob', binding())
    assert m.push.ready(result['ticket']) == {'done': True, 'dial': True}
    # Tokens remain private; public endpoint is both authenticated and tenant scoped.
    status = c.get('/api/v1/accounts/bob/push')
    assert status.status_code == 200 and status.json()['device_registered']
    assert 'ABC123' not in status.text and 'old-key' not in status.text
    assert TestClient(m.app).get('/api/v1/accounts/bob/push').status_code == 401
    assert c.post('/push/wake', json=wake.model_dump()).status_code in (404, 405)
    with pytest.raises(HTTPException):
        m.push.begin(Wake(source='modem2', target='bob', number='123'))
    bob = next(a for a in m.store.objects('accounts') if a['id'] == 'bob')
    bob.pop('tenant_id', None); bob['enabled'] = False
    add(c, 'accounts', bob)
    assert m.push.ready(result['ticket']) == {'done': True, 'dial': False}
    assert not m.push.binding('bob')


def test_registration_removal_and_unconfigured_fallback(gateway):
    m, c = gateway; setup(c); enable(m)
    assert c.post('/api/v1/apply').status_code == 200
    m.push.registered('bob', binding())
    assert m.push.binding('bob')
    # A new registration with no PN details removes stale tokens (e.g. desktop replaces phone).
    m.push.registered('bob', Registration())
    assert not m.push.binding('bob')
    m.push.registered('bob', binding())
    m.push.registered('bob', Registration(active=False))
    assert not m.push.binding('bob')
    m.push.registered('bob', binding())
    m.push.path.unlink()
    assert m.voice_resolve({'source': 'alice', 'number': '201'})['dial'] == 'PJSIP/bob'


def test_api_refresh_payload_and_failure_are_observable(gateway, monkeypatch):
    m, c = gateway; setup(c); enable(m)
    assert c.post('/api/v1/apply').status_code == 200
    m.push.registered('bob', binding())
    result = m.push.begin(Wake(source='alice', target='bob', number='201'))
    requests = []
    def handler(request):
        requests.append(request)
        if request.url.path.endswith('/accounts/me/api_key'):
            return httpx.Response(200, text='A' * 40)
        if request.headers['x-api-key'] == 'old-key':
            return httpx.Response(401)
        assert json.loads(request.content) == {'pn_provider': 'apns', 'pn_param': 'TEAM.org.linphone.phone.voip',
                                              'pn_prid': 'ABC123', 'type': 'call', 'call_id': result['call_id']}
        return httpx.Response(204)
    original = httpx.AsyncClient
    monkeypatch.setattr('backend.push.httpx.AsyncClient', lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    asyncio.run(m.push.send(result['ticket']))
    assert len(requests) == 3
    assert json.loads(m.push.path.read_text())['api_key'] == 'A' * 40
    assert stat.S_IMODE(m.push.path.stat().st_mode) == 0o600
    assert m.push.status('bob')['last_attempt']['status'] == 'accepted'
    monkeypatch.setattr('backend.push.httpx.AsyncClient', lambda **kw: original(transport=httpx.MockTransport(lambda r: httpx.Response(403)), **kw))
    asyncio.run(m.push.send(result['ticket']))
    assert m.push.status('bob')['last_attempt']['code'] == 403
    assert m.push.status('bob')['last_attempt']['status'] == 'failed'
