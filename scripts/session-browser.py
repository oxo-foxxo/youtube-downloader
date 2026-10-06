"""Local, persistent YouTube browser. Control API is internal to Docker only."""
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

from websockets.sync.client import connect

PROFILE = Path('/session/chrome')
TOKEN = Path('/control/token')
LOCK = threading.RLock()
chrome = None


def cdp(method, params=None, target=None):
    with urlopen('http://127.0.0.1:9222/json/version', timeout=5) as response:
        endpoint = json.load(response)['webSocketDebuggerUrl']
    with connect(target or endpoint, open_timeout=5, close_timeout=2) as ws:
        ws.send(json.dumps({'id': 1, 'method': method, 'params': params or {}}))
        while True:
            result = json.loads(ws.recv(timeout=10))
            if result.get('id') == 1:
                if 'error' in result:
                    raise RuntimeError('Browser command failed')
                return result.get('result', {})


def start_chrome():
    global chrome
    PROFILE.mkdir(parents=True, exist_ok=True, mode=0o700)
    # This volume belongs to exactly one browser service. Container hostnames change
    # on rebuild, so Chromium's old singleton locks must not survive recreation.
    for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
        (PROFILE / name).unlink(missing_ok=True)
    # A normal graphical browser: no WebDriver, automation switch or headless mode.
    chrome = subprocess.Popen([
        '/usr/bin/chromium', '--no-sandbox', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--hide-crash-restore-bubble',
        '--password-store=basic', '--remote-debugging-port=9222',
        '--user-data-dir=' + str(PROFILE), '--start-maximized',
        'https://www.youtube.com/',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(60):
        try:
            cdp('Browser.getVersion')
            return
        except Exception:
            if chrome.poll() is not None:
                raise RuntimeError('Browser could not start')
            time.sleep(0.5)
    raise RuntimeError('Browser startup timed out')


def stop_chrome():
    if chrome and chrome.poll() is None:
        os.killpg(chrome.pid, signal.SIGTERM)
        try:
            chrome.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(chrome.pid, signal.SIGKILL)
            chrome.wait()


def snapshot():
    cookies = [c for c in cdp('Storage.getCookies').get('cookies', [])
               if c['domain'].lstrip('.') == 'youtube.com' or c['domain'].endswith('.youtube.com')]
    connected = any(c['name'] in ('SAPISID', '__Secure-3PAPISID') for c in cookies)
    if not connected:
        return {'connected': False}
    rows = ['# Netscape HTTP Cookie File']
    for c in cookies:
        domain = ('#HttpOnly_' if c.get('httpOnly') else '') + c['domain']
        rows.append('\t'.join([domain, 'TRUE' if c['domain'].startswith('.') else 'FALSE',
                              c['path'], 'TRUE' if c['secure'] else 'FALSE',
                              str(max(0, int(c.get('expires', 0)))), c['name'], c['value']]))
    return {'connected': True, 'cookies': '\n'.join(rows) + '\n',
            'userAgent': cdp('Browser.getVersion')['userAgent']}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log browser state, request bodies or credentials.

    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            return self.send_json(200 if chrome and chrome.poll() is None else 503, {'ready': bool(chrome and chrome.poll() is None)})
        self.control()

    def do_POST(self):
        self.control()

    def control(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN.read_text()):
            return self.send_json(403, {'error': 'Forbidden'})
        try:
            with LOCK:
                if self.path == '/status' and self.command == 'GET':
                    return self.send_json(200, {'connected': snapshot()['connected']})
                if self.path == '/snapshot' and self.command == 'POST':
                    return self.send_json(200, snapshot())
                if self.path == '/open' and self.command == 'POST':
                    with urlopen('http://127.0.0.1:9222/json/list', timeout=5) as r:
                        pages = [p for p in json.load(r) if p.get('type') == 'page']
                    if pages:
                        cdp('Page.navigate', {'url': 'https://www.youtube.com/'}, pages[0]['webSocketDebuggerUrl'])
                    else:
                        cdp('Target.createTarget', {'url': 'https://www.youtube.com/'})
                    return self.send_json(200, {'ready': True})
                if self.path == '/logout' and self.command == 'POST':
                    stop_chrome()
                    shutil.rmtree(PROFILE, ignore_errors=True)
                    start_chrome()
                    return self.send_json(200, {'connected': False})
            return self.send_json(404, {'error': 'Not found'})
        except Exception:
            self.send_json(503, {'error': 'Browser unavailable'})


if __name__ == '__main__':
    os.umask(0o077)
    TOKEN.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not TOKEN.exists():
        TOKEN.write_text(secrets.token_hex(32))
    TOKEN.chmod(0o600)
    def shutdown(_signal, _frame):
        stop_chrome()
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    start_chrome()
    server = ThreadingHTTPServer(('0.0.0.0', 8090), Handler)
    try:
        server.serve_forever()
    finally:
        stop_chrome()
