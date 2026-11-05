#!/usr/bin/env python3
"""node-auth — вход в статистику нод по cookie вместо Basic-пароля в браузере.

Caddy панели перед каждым запросом к /node-stats/* спрашивает этот сервис (forward_auth -> /node-stats/auth/verify):
пускать или нет. Пускает валидная cookie (её ставит /login) или Basic-авторизация (для curl и скриптов).

  POST /node-stats/auth/login   {"user", "pass", "remember"} -> 204 + Set-Cookie; 401 неверно; 429 слишком много попыток
  POST /node-stats/auth/logout  -> 204, cookie стёрта
  GET  /node-stats/auth/verify  -> 204 пустить; 401 нет; для страниц (Accept: text/html) — 302 на вход в дашборд
  GET  /node-stats/auth/me      -> 204 вошёл / 401 нет
  POST /node-stats/auth/note    {"text", "node", "t"} -> 200 {"id"}: заметка на графиках (пишется в VictoriaMetrics)
  POST /node-stats/auth/note-delete {"id"} -> 204: удалить заметку (нужен VM_ADMIN_KEY)
  POST /node-stats/auth/hosts   {"node", "ips", "domains"} -> 200 [хосты Remnawave этой ноды]
  POST /node-stats/auth/hosts-toggle {"uuids", "enable", "node", "name"} -> 204: выключить/включить хосты в подписках

Cookie: HttpOnly (скрипты страницы её не видят), Secure, SameSite=Strict, Path=/node-stats. Внутри — срок и HMAC,
ключ — AUTH_SECRET и пароль: смена любого из них разлогинивает все устройства. Хранилища нет, только stdlib.
Окружение: VM_USER, VM_PASS, AUTH_SECRET (openssl rand -hex 32), PORT (8090), COOKIE_SECURE (1),
VM_URL (http://node-stats:8428/node-stats — куда писать заметки), VM_ADMIN_KEY (удаление заметок), RW_API (http://remnawave:3000/api) и RW_TOKEN (API-токен Remnawave —
выключать хосты заблокированной ноды).
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import sys
import threading
import time
import re
import urllib.parse
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

USER = os.environ.get('VM_USER', 'node')
PASS = os.environ.get('VM_PASS', '')
SECRET = os.environ.get('AUTH_SECRET', '')
PORT = int(os.environ.get('PORT', '8090'))
SECURE = os.environ.get('COOKIE_SECURE', '1') != '0'
PREFIX = '/node-stats/auth'
COOKIE = 'ulya_stats'
LONG = 30 * 86400      # «запомнить»: 30 дней
SHORT = 12 * 3600      # без галки: cookie до закрытия браузера, но подпись не дольше 12 часов
VM_URL = os.environ.get('VM_URL', 'http://node-stats:8428/node-stats').rstrip('/')
VM_ADMIN_KEY = os.environ.get('VM_ADMIN_KEY', '')
RW_API = os.environ.get('RW_API', 'http://remnawave:3000/api').rstrip('/')
RW_TOKEN = os.environ.get('RW_TOKEN', '')
UUID = re.compile(r'[0-9a-fA-F-]{36}')
TRIES, WINDOW = 10, 15 * 60   # не больше 10 неудачных попыток входа за 15 минут с одного IP

if len(PASS) < 12 or len(SECRET) < 32:
    sys.exit('node-auth: задай VM_PASS (от 12 символов) и AUTH_SECRET (openssl rand -hex 32) в .env')

KEY = hashlib.sha256((SECRET + '\0' + PASS).encode()).digest()
fails, lock = {}, threading.Lock()


def sign(exp, nonce):
    return hmac.new(KEY, f'{exp}.{nonce}'.encode(), hashlib.sha256).hexdigest()


def make_token(ttl):
    exp, nonce = int(time.time()) + ttl, secrets.token_hex(8)
    return f'{exp}.{nonce}.{sign(exp, nonce)}'


def token_ok(tok):
    try:
        exp, nonce, mac = tok.split('.')
        # сравниваем байты: не-ASCII в подделанной cookie у str давал TypeError и обрыв соединения без ответа
        return int(exp) > time.time() and hmac.compare_digest(mac.encode(), sign(int(exp), nonce).encode())
    except (ValueError, AttributeError, TypeError, UnicodeError):
        return False


def creds_ok(user, pw):
    # сравнение за постоянное время, и логин и пароль — чтобы по времени ответа ничего не угадать
    u = hmac.compare_digest(str(user).encode(), USER.encode())
    p = hmac.compare_digest(str(pw).encode(), PASS.encode())
    return u and p


def cookie_of(headers):
    for part in (headers.get('Cookie') or '').split(';'):
        k, _, v = part.strip().partition('=')
        if k == COOKIE:
            return v
    return ''


def basic_ok(headers):
    h = headers.get('Authorization') or ''
    if not h.startswith('Basic '):
        return False
    try:
        user, _, pw = base64.b64decode(h[6:]).decode().partition(':')
    except (ValueError, UnicodeDecodeError):
        return False
    return creds_ok(user, pw)


def client_ip(handler):
    # за Caddy: первый адрес в X-Forwarded-For — клиент (сервис доступен только из docker-сети)
    return (handler.headers.get('X-Forwarded-For') or handler.client_address[0]).split(',')[0].strip()


def too_many(ip):
    now = time.time()
    with lock:
        fails[ip] = [t for t in fails.get(ip, []) if now - t < WINDOW]
        return len(fails[ip]) >= TRIES


def note_fail(ip):
    with lock:
        fails.setdefault(ip, []).append(time.time())
        if len(fails) > 10000:   # не даём словарю расти бесконечно
            for k in list(fails)[:5000]:
                fails.pop(k, None)


def lp_tag(v):
    # значение метки в line protocol: без управляющих символов, запятая, пробел, = и \ — экранируем
    v = re.sub(r'[\x00-\x1f\x7f]', ' ', str(v)).strip()
    return re.sub(r'([\\, =])', r'\\\1', v)


def vm_call(path, data=None):
    req = urllib.request.Request(VM_URL + path, data=data, method='POST' if data is not None else 'GET')
    with urllib.request.urlopen(req, timeout=10) as r:
        return r.status


def add_note(data):
    text = re.sub(r'\s+', ' ', str(data.get('text') or '')).strip()[:200]
    node = str(data.get('node') or '').strip()[:120]
    if not text:
        return 400, None
    now = int(time.time())
    try:
        t = int(data.get('t') or now)
    except (TypeError, ValueError):
        return 400, None
    if not now - 180 * 86400 < t <= now + 3600:   # хранение VictoriaMetrics — 180 дней
        return 400, None
    nid = secrets.token_hex(6)
    tags = f'id={nid}' + (f',node={lp_tag(node)}' if node else '') + f',text={lp_tag(text)}'
    vm_call('/write', f'node_note,{tags} n=1 {t * 10**9}'.encode())
    return 200, nid


def del_note(data):
    nid = str(data.get('id') or '')
    if not re.fullmatch(r'[0-9a-f]{12}', nid):
        return 400
    if not VM_ADMIN_KEY:
        return 501
    q = urllib.parse.urlencode({'match[]': f'node_note_n{{id="{nid}"}}', 'authKey': VM_ADMIN_KEY})
    vm_call('/api/v1/admin/tsdb/delete_series?' + q, b'')
    return 204


def rw(method, path, body=None):
    # прямой запрос к Remnawave мимо Caddy — с заголовками, как их ставит обратный прокси (как в rw-sync.py)
    req = urllib.request.Request(RW_API + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={
        'Authorization': f'Bearer {RW_TOKEN}', 'Accept': 'application/json', 'Content-Type': 'application/json',
        'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https'})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read()
        return json.loads(raw) if raw else {}


def resolve_all(names, wait=6):
    # домены хостов -> их IPv4, параллельно и не дольше wait секунд всего (зависший DNS не держит ответ)
    out, pool = {}, []
    def one(n):
        try:
            out[n] = {a[4][0] for a in socket.getaddrinfo(n, None, socket.AF_INET)}
        except (OSError, UnicodeError):
            out[n] = set()
    for n in names:
        t = threading.Thread(target=one, args=(n,), daemon=True); t.start(); pool.append(t)
    end = time.time() + wait
    for t in pool:
        t.join(max(0, end - time.time()))
    return out


def node_hosts(data):
    # хосты ноды: привязаны к ней (nodes), адрес — её IP или домен заглушки, домен адреса указывает на её IP (DNS), SNI = домен.
    # all=1 — все хосты панели (выбрать вручную), найденные автоматически отмечены match
    node = str(data.get('node') or '')
    ips = {str(x) for x in (data.get('ips') or []) if x}
    doms = {str(x).lower() for x in (data.get('domains') or []) if x}
    hosts = [h for h in rw('GET', '/hosts').get('response') or [] if isinstance(h, dict) and h.get('uuid')]
    names = {str(h.get('address') or '').lower() for h in hosts} - ips - doms
    dns = resolve_all([n for n in names if n and not re.fullmatch(r'[0-9.]+', n)]) if ips else {}
    out = []
    for h in hosts:
        addr, sni = str(h.get('address') or '').lower(), str(h.get('sni') or '').lower()
        why = ('привязан к ноде' if node and node in (h.get('nodes') or []) else 'адрес — IP ноды' if addr in ips
               else 'адрес — домен заглушки' if addr in doms else 'SNI — домен заглушки' if sni and sni in doms
               else 'домен указывает на IP ноды' if dns.get(addr, set()) & ips else '')
        if why or data.get('all'):
            out.append({**{k: h.get(k) for k in ('uuid', 'remark', 'address', 'port', 'isDisabled')}, 'match': why})
    return out


def toggle_hosts(data):
    uuids = [u for u in (data.get('uuids') or []) if isinstance(u, str) and UUID.fullmatch(u)][:50]
    if not uuids:
        return 400
    enable = bool(data.get('enable'))
    try:
        rw('POST', '/hosts/bulk/' + ('enable' if enable else 'disable'), {'uuids': uuids})
    except urllib.error.HTTPError as e:
        if e.code not in (404, 405):
            raise
        for u in uuids:   # панель без массовых операций — по одному
            rw('PATCH', '/hosts', {'uuid': u, 'isDisabled': not enable})
    # в историю: заметка на графиках — кто бы ни нажал, через месяц будет видно, когда ноду выводили из подписок
    try:
        add_note({'text': f"{'Включены' if enable else 'Выключены'} хосты в подписках: {str(data.get('name') or '')[:120]}", 'node': data.get('node') or ''})
    except OSError:
        pass
    return 204


class H(BaseHTTPRequestHandler):
    server_version = 'node-auth'
    sys_version = ''

    def log_message(self, fmt, *args):   # без логов на каждый verify; неудачные входы пишем сами
        pass

    def reply(self, code, headers=(), body=b''):
        self.send_response(code)
        for k, v in headers:
            self.send_header(k, v)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def set_cookie(self, value, max_age):
        attrs = [f'{COOKIE}={value}', 'Path=/node-stats', 'HttpOnly', 'SameSite=Strict']
        if SECURE:
            attrs.append('Secure')
        if max_age is not None:
            attrs.append(f'Max-Age={max_age}')
        return ('Set-Cookie', '; '.join(attrs))

    def authed(self):
        if token_ok(cookie_of(self.headers)):
            return True
        if not (self.headers.get('Authorization') or '').startswith('Basic '):
            return False
        # Basic-вход (curl, vmui) — под тем же лимитом, что форма: иначе пароль можно было перебирать через /verify
        ip = client_ip(self)
        if too_many(ip):
            return False
        if basic_ok(self.headers):
            return True
        note_fail(ip)
        return False

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == PREFIX + '/verify':
            if self.authed():
                return self.reply(204)
            # открыли vmui или API прямо в браузере без входа — отправляем на вход в дашборд
            if 'text/html' in (self.headers.get('Accept') or ''):
                return self.reply(302, [('Location', '/node-stats/dash/')])
            return self.reply(401)
        if path == PREFIX + '/me':
            return self.reply(204 if self.authed() else 401)
        self.reply(404)

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == PREFIX + '/logout':
            return self.reply(204, [self.set_cookie('', 0)])
        if path in (PREFIX + '/note', PREFIX + '/note-delete', PREFIX + '/hosts', PREFIX + '/hosts-toggle'):
            return self.note(path)
        if path != PREFIX + '/login':
            return self.reply(404)
        ip = client_ip(self)
        if too_many(ip):
            return self.reply(429, [('Retry-After', str(WINDOW))])
        if 'application/json' not in (self.headers.get('Content-Type') or ''):   # форма с чужого сайта так не придёт
            return self.reply(415)
        try:
            n = min(int(self.headers.get('Content-Length') or 0), 4096)
            data = json.loads(self.rfile.read(n) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return self.reply(400)
        if not isinstance(data, dict):   # [1], "x", 5 — не объект: 400, а не падение потока
            return self.reply(400)
        if not creds_ok(data.get('user', ''), data.get('pass', '')):
            note_fail(ip)
            print(f'node-auth: неверный вход с {ip}', flush=True)
            return self.reply(401)
        with lock:
            fails.pop(ip, None)
        remember = bool(data.get('remember'))
        self.reply(204, [self.set_cookie(make_token(LONG if remember else SHORT), LONG if remember else None)])


    def note(self, path):
        # заметки на графиках: только для вошедших; JSON-тело — форма с чужого сайта так не придёт (и cookie SameSite=Strict)
        if not self.authed():
            return self.reply(401)
        if 'application/json' not in (self.headers.get('Content-Type') or ''):
            return self.reply(415)
        try:
            n = min(int(self.headers.get('Content-Length') or 0), 4096)
            data = json.loads(self.rfile.read(n) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return self.reply(400)
        if not isinstance(data, dict):
            return self.reply(400)
        if path.endswith(('/hosts', '/hosts-toggle')):
            if not RW_TOKEN:
                return self.reply(501)
            try:
                if path.endswith('/hosts'):
                    body = json.dumps(node_hosts(data), ensure_ascii=False).encode()
                    return self.reply(200, [('Content-Type', 'application/json')], body)
                print(f"node-auth: хосты {'включены' if data.get('enable') else 'выключены'}: {data.get('name')} с {client_ip(self)}", flush=True)
                return self.reply(toggle_hosts(data))
            except (OSError, ValueError, AttributeError) as e:   # панель недоступна, токен без прав, странный ответ
                print(f'node-auth: Remnawave API: {e}', flush=True)
                return self.reply(502)
        try:
            if path.endswith('/note'):
                code, nid = add_note(data)
                body = json.dumps({'id': nid}).encode() if nid else b''
                return self.reply(code, [('Content-Type', 'application/json')] if body else [], body)
            return self.reply(del_note(data))
        except OSError as e:   # VictoriaMetrics недоступна
            print(f'node-auth: заметка не записана: {e}', flush=True)
            return self.reply(502)


class Server(ThreadingHTTPServer):
    # дашборд при обновлении шлёт десятки запросов разом, и Caddy на каждый спрашивает нас (forward_auth).
    # Очередь соединений по умолчанию — 5: лишние отбрасывались, Caddy отвечал 502
    request_queue_size = 256
    daemon_threads = True


if __name__ == '__main__':
    print(f'node-auth: слушаю :{PORT}', flush=True)
    Server(('0.0.0.0', PORT), H).serve_forever()
