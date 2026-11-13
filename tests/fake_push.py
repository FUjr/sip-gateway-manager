"""HTTPS push sink for the isolated protocol-test network only."""
import http.server
import json
import os
from pathlib import Path
import ssl


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/api/push_notification':
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with open(os.environ['PUSH_CAPTURE_FILE'], 'a') as stream:
            stream.write(json.dumps(body) + '\n')
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    certs = Path(os.getenv('PUSH_TEST_CERTS', '/certs'))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certs / 'fullchain.pem', certs / 'privkey.pem')
    server = http.server.ThreadingHTTPServer(('0.0.0.0', 443), Handler)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()
