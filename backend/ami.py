import asyncio
import base64
import os

async def frame(reader):
    raw = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)
    return dict(line.split(': ', 1) for line in raw.decode().split('\r\n') if ': ' in line)

async def send(job):
    reader, writer = await asyncio.open_connection('127.0.0.1', 5038)
    try:
        await reader.readline()  # banner
        writer.write(('Action: Login\r\nUsername: backend\r\nSecret: '+os.environ['AMI_SECRET']+'\r\nEvents: off\r\n\r\n').encode())
        await writer.drain()
        result = await frame(reader)
        if result.get('Response') != 'Success':
            raise RuntimeError('AMI login failed')
        # Base64 body prevents AMI header injection and preserves UTF-8 exactly.
        values = {'Action':'GatewayMessageSend','ActionID':job['id'],'DeliveryID':job['id'],
                  'Endpoint':job['target'],'Recipient':job['recipient'],
                  'SenderBase64':base64.b64encode(job['sender'].encode()).decode(),
                  'BodyBase64':base64.b64encode(job['body'].encode()).decode()}
        writer.write((''.join(k+': '+v+'\r\n' for k,v in values.items())+'\r\n').encode())
        await writer.drain()
        while True:
            result = await frame(reader)
            if result.get('ActionID') == job['id']:
                if result.get('Response') != 'Success':
                    raise RuntimeError('AMI dispatch failed')
                break
    finally:
        writer.close()
        await writer.wait_closed()
