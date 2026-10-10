import os
from pathlib import Path
import shutil
from backend.render import render
from backend.store import Store
if len(os.environ.get('ADMIN_PASSWORD','')) < 16 or len(os.environ.get('AMI_SECRET','')) < 24:
    raise SystemExit('Configure ADMIN_PASSWORD (16+) and AMI_SECRET (24+) in .env')
for name in ('/data','/run/gateway','/var/run/asterisk','/etc/asterisk'):
    Path(name).mkdir(parents=True,exist_ok=True)
for name in ('/var/run/asterisk','/run/gateway'):
    shutil.chown(name,user='asterisk',group='asterisk')
os.chmod('/run/gateway',0o2770)
tls=Path('/run/gateway/tls')
tls.mkdir(exist_ok=True)
shutil.chown(tls,user='asterisk',group='asterisk')
for name in ('fullchain.pem','privkey.pem'):
    shutil.copyfile(Path('/certs')/name,tls/name)
    shutil.chown(tls/name,user='asterisk',group='asterisk')
    (tls/name).chmod(0o640)
conf=Store('/data/gateway.sqlite3').config()
import json, hashlib
from backend.models import Settings
settings=conf['settings'][0] if conf['settings'] else Settings().model_dump()
Path('/data/applied-config.json').write_text(json.dumps(conf))
Path('/data/applied.json').write_text(json.dumps({'revision':hashlib.sha256(json.dumps(conf,sort_keys=True).encode()).hexdigest()[:16],'settings':settings}))
Path('/data/applied-config.json').chmod(0o600)
Path('/data/applied.json').chmod(0o600)
for name,content in render(conf).items():
    path=Path('/etc/asterisk')/name
    path.write_text(content)
    shutil.chown(path,user='asterisk',group='asterisk')
    path.chmod(0o640)
os.umask(0o007)
os.execvp('supervisord',['supervisord','-c','/etc/supervisor/conf.d/gateway.conf'])
