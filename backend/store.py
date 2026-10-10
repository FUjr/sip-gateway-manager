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
            self.db.execute('BEGIN IMMEDIATE')
            try:
                yield self.db
                self.db.execute('COMMIT')
            except BaseException:
                self.db.execute('ROLLBACK')
                raise

    def objects(self, kind):
        with self.lock:
            return [json.loads(r['data']) for r in self.db.execute('SELECT data FROM objects WHERE kind=? ORDER BY id', (kind,))]

    def config(self):
        return {kind: self.objects(kind) for kind in ('devices', 'accounts', 'groups', 'routes', 'settings')}
