"""Real TLS SIP test against the isolated Compose project (no modem hardware)."""
import asyncio
import hashlib
import os
from pathlib import Path
import re
import secrets
import ssl
import time
import httpx

PASSWORD='test-protocol-password-123'
HOST=os.getenv('SIP_TEST_HOST','127.0.0.1')
PORT=int(os.getenv('SIP_TEST_PORT','15061'))
WEB=os.getenv('WEB_TEST_URL','https://localhost:28443')

class SIP:
    def __init__(self,username):
        self.username=username;self.cseq=0;self.pending={};self.messages=[];self.calls=[]
    async def connect(self):
        context=ssl.create_default_context(cafile='certs/fullchain.pem')
        self.reader,self.writer=await asyncio.open_connection(HOST,PORT,ssl=context,server_hostname='sip.test')
        self.task=asyncio.create_task(self.read())
        return self
    async def read(self):
        while True:
            try:
                packet=await self.reader.readuntil(b'\r\n\r\n')
                if packet==b'\r\n\r\n':continue
                lines=packet.decode().split('\r\n');headers={}
                for line in lines[1:]:
                    if ':' in line:
                        key,value=line.split(':',1);headers[key.lower()]=value.strip()
                body=await self.reader.readexactly(int(headers.get('content-length','0')))
                if lines[0].startswith('SIP/2.0'):
                    future=self.pending.get(headers.get('cseq'))
                    if future and not future.done() and int(lines[0].split()[1])>=200:future.set_result((int(lines[0].split()[1]),headers,body))
                else:
                    method=lines[0].split()[0]
                    if method=='MESSAGE':self.messages.append((headers,body.decode()))
                    if method=='INVITE':self.calls.append(headers)
                    payload=b''
                    if method=='INVITE':
                        payload=b'v=0\r\no=test 1 1 IN IP4 127.0.0.1\r\ns=test\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 36000 RTP/AVP 8 0\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n'
                        if 'tag=' not in headers['to']:headers['to']+=';tag='+secrets.token_hex(8)
                    response='SIP/2.0 200 OK\r\n'+''.join(f'{name}: {headers[name.lower()]}\r\n' for name in ['Via','From','To','Call-ID','CSeq'])+(f'Contact: <sips:{self.username}@127.0.0.1:{self.writer.get_extra_info("sockname")[1]};transport=tls>\r\nContent-Type: application/sdp\r\n' if payload else '')+f'Content-Length: {len(payload)}\r\n\r\n'
                    self.writer.write(response.encode()+payload);await self.writer.drain()
            except asyncio.CancelledError:return
            except (EOFError,asyncio.IncompleteReadError,ConnectionError):return
    async def request(self,method,recipient=None,body='',delivery=None,extra='',expires=300):
        uri='sips:sip.test' if method=='REGISTER' else f'sips:{recipient}@sip.test'
        identity=secrets.token_hex(12)
        to_uri=f'sips:{self.username}@sip.test' if method=='REGISTER' else uri
        async def transmit(auth=''):
            self.cseq+=1;key=f'{self.cseq} {method}'
            future=asyncio.get_running_loop().create_future();self.pending[key]=future
            port=self.writer.get_extra_info('sockname')[1]
            headers=(f'{method} {uri} SIP/2.0\r\nVia: SIP/2.0/TLS 127.0.0.1:{port};branch=z9hG4bK{secrets.token_hex(10)};rport\r\n'
                     f'Max-Forwards: 70\r\nFrom: <sips:{self.username}@sip.test>;tag={identity}\r\nTo: <{to_uri}>\r\n'
                     f'Call-ID: {identity}\r\nCSeq: {key}\r\nContact: <sips:{self.username}@127.0.0.1:{port};transport=tls>\r\n'
                     f'Expires: {expires}\r\n{auth}{extra}')
            if delivery:headers+=f'X-Gateway-Delivery-ID: {delivery}\r\n'
            if body:headers+='Content-Type: '+('application/sdp' if method=='INVITE' else 'text/plain; charset=utf-8')+'\r\n'
            data=body.encode();headers+=f'Content-Length: {len(data)}\r\n\r\n'
            self.writer.write(headers.encode()+data);await self.writer.drain()
            try:return await asyncio.wait_for(future,10)
            finally:self.pending.pop(key,None)
        result=await transmit()
        if result[0] in (401,407):
            challenge=result[1].get('www-authenticate',result[1].get('proxy-authenticate',''))
            values=dict(re.findall(r'(\w+)="([^"]*)"',challenge))
            realm,nonce=values['realm'],values['nonce'];cnonce=secrets.token_hex(12)
            md5=lambda v:hashlib.md5(v.encode()).hexdigest()
            ha1=md5(f'{self.username}:{realm}:{PASSWORD}');ha2=md5(f'{method}:{uri}')
            qop='auth' if 'qop' in values else None
            response=md5(f'{ha1}:{nonce}:00000001:{cnonce}:auth:{ha2}') if qop else md5(f'{ha1}:{nonce}:{ha2}')
            auth=f'Authorization: Digest username="{self.username}", realm="{realm}", nonce="{nonce}", uri="{uri}", response="{response}", algorithm=MD5'
            if qop:auth+=f', qop=auth, nc=00000001, cnonce="{cnonce}"'
            if 'opaque' in values:auth+=f', opaque="{values["opaque"]}"'
            result=await transmit(auth+'\r\n')
        return result
    async def call(self,recipient):
        sdp='v=0\r\no=test 1 1 IN IP4 127.0.0.1\r\ns=test\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 36002 RTP/AVP 8 0\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n'
        code,headers,body=await self.request('INVITE',recipient,sdp)
        assert code==200,(code,headers,body)
        assert b'm=audio' in body
        uri=re.search(r'<([^>]+)>',headers['contact']).group(1)
        for method in ('ACK','BYE'):
            self.cseq+=1;key=f'{self.cseq} {method}'
            packet=f'{method} {uri} SIP/2.0\r\nVia: SIP/2.0/TLS 127.0.0.1;branch=z9hG4bK{secrets.token_hex(10)};rport\r\nMax-Forwards: 70\r\n'
            packet+=''.join(f'{name}: {headers[name.lower()]}\r\n' for name in ('From','To','Call-ID'))
            packet+=f'CSeq: {key}\r\nContent-Length: 0\r\n\r\n'
            future=asyncio.get_running_loop().create_future();self.pending[key]=future
            self.writer.write(packet.encode());await self.writer.drain()
            if method=='BYE':assert (await asyncio.wait_for(future,10))[0]==200
            self.pending.pop(key,None)
    async def close(self):
        self.task.cancel();self.writer.close()
        try: await asyncio.wait_for(self.writer.wait_closed(),1)
        except (ssl.SSLError, ConnectionError, TimeoutError): self.writer.transport.abort()
        await self.task

async def main():
    env=dict(line.split('=',1) for line in Path('.env').read_text().splitlines() if '=' in line)
    async with httpx.AsyncClient(base_url=WEB,verify=False) as web:
        async def api(path,method='GET',body=None):
            r=await web.request(method,'/api/v1/'+path,json=body);r.raise_for_status();return r.json()
        auth=await api('login','POST',{'username':'admin','password':env['ADMIN_PASSWORD']});web.headers['X-CSRF-Token']=auth['csrf']
        await api('devices/router','PUT',{'id':'router','name':'Protocol Router'})
        for name,kind,extension in [('modem1','device','100'),('modem2','device','101'),('alice','client','200'),('bob','client','201')]:
            await api('accounts/'+name,'PUT',{'id':name,'name':name,'kind':kind,'device_id':'router' if kind=='device' else '', 'extension':extension,'password':PASSWORD})
        await api('groups/team','PUT',{'id':'team','name':'Team','members':['alice','bob']})
        for name,medium in [('in_sms','sms'),('in_voice','voice')]:
            await api('routes/'+name,'PUT',{'id':name,'name':name,'medium':medium,'direction':'inbound','sources':['modem1'],'target_type':'group','target':'team'})
        await api('routes/out_sms','PUT',{'id':'out_sms','name':'out_sms','medium':'sms','direction':'outbound','sources':['alice','bob'],'target':'modem1'})
        await api('routes/out_voice','PUT',{'id':'out_voice','name':'out_voice','medium':'voice','direction':'outbound','sources':['alice','bob'],'target':'modem1'})
        for medium in ('voice','sms'):
            await api('routes/bob_'+medium,'PUT',{'id':'bob_'+medium,'name':'bob_'+medium,'medium':medium,'direction':'outbound','sources':['bob'],'target':'modem2','priority':1})
        result=await api('apply','POST');assert result['applied'],result
        modem=await SIP('modem1').connect();modem2=await SIP('modem2').connect();alice=await SIP('alice').connect();bob=await SIP('bob').connect()
        for peer in (modem,modem2,alice,bob):
            result=await peer.request('REGISTER');assert result[0]==200,(peer.username,result[0])
        await alice.call('201')
        assert bob.calls
        await alice.call('123456')
        assert modem.calls
        await bob.call('123456')
        assert modem2.calls
        await modem.call('123456')
        assert len(alice.calls)+len(bob.calls)>=2
        marker=secrets.token_hex(8)
        result=await alice.request('MESSAGE','201','internal '+marker,secrets.token_hex(32));assert result[0]==202,result[0]
        await asyncio.sleep(2)
        assert any(text=='internal '+marker for _,text in bob.messages),bob.messages
        result=await modem.request('MESSAGE','sms','fanout '+marker,secrets.token_hex(32),extra='X-QModem-SMS-From: 123456\r\n');assert result[0]==202,result[0]
        await asyncio.sleep(2)
        assert any(text=='fanout '+marker for _,text in alice.messages)
        assert any(text=='fanout '+marker for _,text in bob.messages)
        result=await modem2.request('MESSAGE','sms','rejected '+marker,secrets.token_hex(32),extra='X-QModem-SMS-From: 123456\r\n');assert result[0]==404
        result=await bob.request('MESSAGE','123456','second modem '+marker,secrets.token_hex(32));assert result[0]==202
        await asyncio.sleep(2)
        assert any(text=='second modem '+marker for _,text in modem2.messages)
        assert not any(text=='second modem '+marker for _,text in modem.messages)
        # Same stable ID in distinct SIP transactions is accepted only once.
        stable=secrets.token_hex(32)
        for _ in range(2):
            result=await alice.request('MESSAGE','123456','dedupe '+marker,stable);assert result[0]==202,result[0]
        await asyncio.sleep(2)
        assert sum(text=='dedupe '+marker for _,text in modem.messages)==1
        # One offline recipient must not prevent delivery to the other.
        assert (await bob.request('REGISTER',expires=0))[0]==200
        result=await modem.request('MESSAGE','sms','offline '+marker,secrets.token_hex(32),extra='X-QModem-SMS-From: 123456\r\n');assert result[0]==202
        await asyncio.sleep(2)
        assert any(text=='offline '+marker for _,text in alice.messages)
        assert not any(text=='offline '+marker for _,text in bob.messages)
        assert (await bob.request('REGISTER'))[0]==200
        await asyncio.sleep(2)
        assert any(text=='offline '+marker for _,text in bob.messages)
        jobs=await api('deliveries')
        assert all(job['status']=='delivered' for job in jobs if job['created']>time.time()-20),jobs
        print('PASS: internal voice and first-answer group call, TLS registration, authenticated MESSAGE, internal extension SMS, fanout, final responses, stable dedupe')
        for peer in (modem,modem2,alice,bob):await peer.close()

if __name__=='__main__':asyncio.run(main())
