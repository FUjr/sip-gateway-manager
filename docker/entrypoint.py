import os
from pathlib import Path
import shutil
from backend.render import render
from backend.store import Store
if len(os.environ.get('AMI_SECRET','')) < 24:
    raise SystemExit('Configure AMI_SECRET (24+ characters) in .env')
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
store=Store('/data/gateway.sqlite3')
from backend.tenancy import install
from fastapi import FastAPI
install(FastAPI(),store)
if store.db.execute("SELECT 1 FROM objects WHERE instr(kind,':')=0 AND kind!='settings' LIMIT 1").fetchone():
    raise SystemExit('Legacy data detected. Use a new volume; existing data was not modified.')
conf=store.aggregate()
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
