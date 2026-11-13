"""Run only on the disposable sip-push-test stack with a local HTTPS push sink.

The sink must resolve as subscribe.linphone.org *inside that test network*;
append its test certificate to that disposable PBX's certifi trust bundle.
No request is sent to the real Linphone service.
"""
import asyncio
import json
import os
from pathlib import Path
import subprocess

import httpx
from protocol import SIP, WEB


async def main():
    container = os.getenv('SIP_PBX_CONTAINER', 'sip-push-test-pbx-1')
    project = subprocess.check_output(['docker', 'inspect', container, '--format',
        '{{index .Config.Labels "com.docker.compose.project"}}'], text=True).strip()
    assert project == 'sip-push-test', 'Refusing to modify a non-test stack'
    capture = Path(os.environ['PUSH_CAPTURE_FILE'])
    # Refuse to use real push credentials in this test.
    config = {'from': 'sip:test@sip.linphone.org', 'api_key': 'test-only-' + 'A' * 40}
    subprocess.run(['docker', 'exec', '-i', container, '/opt/venv/bin/python', '-c',
        'import os,sys;os.umask(0o077);open("/data/linphone-push.json","w").write(sys.stdin.read())'],
        input=json.dumps(config), text=True, check=True)
    env = dict(line.split('=', 1) for line in Path('.env').read_text().splitlines() if '=' in line)
    pn = ';pn-provider=apns;pn-param=TEAM.org.linphone.phone.voip;pn-prid=ABC123'
    async with httpx.AsyncClient(base_url=WEB, verify=False) as web:
        login = await web.post('/api/v1/login', json={'username': 'admin', 'password': env['ADMIN_PASSWORD']})
        login.raise_for_status()
        alice = await SIP('alice').connect()
        old = await SIP('bob', pn).connect()
        fresh = SIP('bob', pn)
        try:
            assert (await alice.request('REGISTER'))[0] == 200
            assert (await old.request('REGISTER'))[0] == 200
            for _ in range(30):
                status = (await web.get('/api/v1/accounts/bob/push')).json()
                if status['device_registered']: break
                await asyncio.sleep(.1)
            assert status['device_registered'], status
            await old.close()  # Simulate the suspended app's old TLS connection disappearing.
            before = len(capture.read_text().splitlines()) if capture.exists() else 0
            call = asyncio.create_task(alice.call('201', media_peer=fresh))
            for _ in range(50):
                requests = capture.read_text().splitlines() if capture.exists() else []
                if len(requests) > before: break
                await asyncio.sleep(.1)
            assert len(requests) > before, 'No HTTPS push request received'
            push = json.loads(requests[-1])
            assert push['type'] == 'call' and push['pn_prid'] == 'ABC123'
            assert not fresh.calls
            await fresh.connect()
            assert (await fresh.request('REGISTER'))[0] == 200
            await asyncio.wait_for(call, 10)
            assert fresh.calls[-1]['call-id'] == push['call_id'], (fresh.calls[-1]['call-id'], push['call_id'])
            status = (await web.get('/api/v1/accounts/bob/push')).json()
            assert status['last_attempt']['status'] == 'accepted', status
            # A desktop registration replacing the phone clears PN state and keeps ordinary calls working.
            fresh.contact_params = ''
            assert (await fresh.request('REGISTER'))[0] == 200
            await asyncio.sleep(.3)
            assert not (await web.get('/api/v1/accounts/bob/push')).json()['device_registered']
            count = len(capture.read_text().splitlines())
            await alice.call('201', media_peer=fresh)
            assert len(capture.read_text().splitlines()) == count
            print('PASS: authenticated PN capture, HTTPS push, fresh TLS registration, matching INVITE Call-ID, two-way RTP, BYE, ordinary-call fallback')
        finally:
            await alice.close()
            if hasattr(fresh, 'writer'): await fresh.close()

if __name__ == '__main__':
    asyncio.run(main())
