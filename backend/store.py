import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

class Store:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd=os.open(path,os.O_CREAT | os.O_RDWR,0o600)
        os.close(fd)
        os.chmod(path,0o600)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS objects(kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, csrf TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, source TEXT, recipient TEXT, sender TEXT, body TEXT, created REAL, expires REAL, fingerprint TEXT);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, message_id TEXT, target TEXT, status TEXT, attempts INTEGER DEFAULT 0, next REAL, code INTEGER, updated REAL, UNIQUE(message_id,target));
        ''')
        os.chmod(path, 0o600)

    @contextmanager
    def transaction(self):
        with self.lock:
            from .tenancy import current
            if current.get():
                from fastapi import HTTPException
                row=self.db.execute('SELECT active FROM tenants WHERE id=?',(current.get(),)).fetchone()
                if not row or not row[0]: raise HTTPException(403,'租户已停用')
            self.db.execute('BEGIN IMMEDIATE')
            try:
                yield self.db
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK')
                raise

    def key(self,kind):
        from .tenancy import current
        return current.get()+':'+kind if current.get() and kind!='settings' else kind

    def objects(self, kind):
        with self.lock:
            from .tenancy import current
            if kind=='settings' and current.get():
                admin=self.db.execute('SELECT admin FROM tenants WHERE id=?',(current.get(),)).fetchone()
                if not admin or not admin[0]:
                    active=self.db.execute("SELECT value FROM platform WHERE key='active_settings'").fetchone()
                    return json.loads(active[0]) if active else []
            return [json.loads(r['data']) for r in self.db.execute('SELECT data FROM objects WHERE kind=? ORDER BY id', (self.key(kind),))]

    def config(self):
        with self.lock:
            return self._config()

    def _config(self):
        conf={kind:self.objects(kind) for kind in ('devices','accounts','groups','routes','settings')}
        from .tenancy import current
        if current.get():
            row=self.db.execute('SELECT timezone FROM tenants WHERE id=?',(current.get(),)).fetchone()
            conf['timezone']=row[0] if row else 'UTC'
            for kind in ('accounts','groups','routes'):
                for obj in conf[kind]:
                    obj['tenant_id']=current.get()
                    if kind=='routes': obj['timezone']=conf['timezone']
        return conf

    def live_account(self,identity):
        with self.lock:
            return bool(self.db.execute("SELECT 1 FROM objects o JOIN tenants t ON o.kind=t.id||':accounts' WHERE o.id=? AND t.active=1",(identity,)).fetchone())

    def pending(self):
        from .tenancy import current
        with self.lock:
            row=self.db.execute('SELECT data FROM published WHERE tenant_id=?',(current.get(),)).fetchone()
            return not row or json.loads(row[0])!=self.config()

    def aggregate(self,own=None):
        from .tenancy import current
        result={k:[] for k in ('devices','accounts','groups','routes','settings')}
        with self.lock:
            rows=self.db.execute('SELECT p.* FROM published p JOIN tenants t ON t.id=p.tenant_id WHERE t.active=1').fetchall()
            configs=[json.loads(r['data']) for r in rows if own is None or r['tenant_id']!=current.get()]
            if own is not None: configs.append(own)
            for conf in configs:
                for kind in result:
                    if kind!='settings': result[kind].extend(conf[kind])
            active=self.db.execute("SELECT value FROM platform WHERE key='active_settings'").fetchone()
            result['settings']=json.loads(active[0]) if active else []
            if own is not None:
                admin=self.db.execute('SELECT admin FROM tenants WHERE id=?',(current.get(),)).fetchone()
                if admin and admin[0]: result['settings']=own['settings']
        return result
