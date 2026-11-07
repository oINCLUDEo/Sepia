#!/usr/bin/env python3
"""sepia-probe — пробник для раздела «Рынок»: всё, что касается чужих серверов, делается отсюда, а не с панели.

  POST /fetch {"url", "headers"}         скачать подписку (только публичные адреса, до 3 МБ)
  POST /exit  {"outbound", "tries"}      подключиться через сервер конкурента как обычный клиент (Xray на этом сервере)
                                         и спросить «какой у меня IP» у нескольких сервисов — так видно, где выход
  POST /tcp   {"targets": [[ip, port]]}  доступен ли адрес отсюда (TCP-подключение)
  GET  /info                             адрес и страна пробника, версия Xray

Пускает только с IP панели (PANEL) и с токеном (TOKEN), по HTTPS с самоподписанным сертификатом — панель проверяет его
отпечаток. Ключи из конфигов живут только на время проверки: файл конфига Xray во временной папке, сразу удаляется.
Настройки — /etc/sepia-probe/probe.conf (ставит probe/setup.sh): TOKEN, PANEL, PORT, XRAY.
"""
import base64
import hmac
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF_DIR = os.environ.get('PROBE_DIR', '/etc/sepia-probe')


def read_conf():
    out = {}
    try:
        with open(os.path.join(CONF_DIR, 'probe.conf'), encoding='utf-8') as f:
            for line in f:
                if '=' in line and not line.lstrip().startswith('#'):
                    k, v = line.strip().split('=', 1)
                    out[k] = v.strip('\'"')
    except OSError:
        pass
    return out


C = read_conf()
TOKEN = os.environ.get('TOKEN') or C.get('TOKEN', '')
PANEL = {x.strip() for x in (os.environ.get('PANEL') or C.get('PANEL', '')).split(',') if x.strip()}
PORT = int(os.environ.get('PORT') or C.get('PORT', '8898'))
XRAY = os.environ.get('XRAY') or C.get('XRAY') or shutil.which('xray') or '/usr/local/bin/xray'
# сервисы «какой у меня IP»: первый — по голому IP (правила моста по доменам его не поймают), остальные — для сверки
ECHO = [('https://1.1.1.1/cdn-cgi/trace', 'trace'), ('https://api.ipify.org?format=json', 'json'), ('https://checkip.amazonaws.com/', 'plain')]
# первое подключение: «какой у меня IP» и сразу 256 КБ по тому же соединению — рукопожатие и короткий ответ проходят
# и через «заморозку» 16–20 КБ, объём — нет
BULK_N = 262144
TRACE_URL, BULK_URL = 'https://speed.cloudflare.com/cdn-cgi/trace', f'https://speed.cloudflare.com/__down?bytes={BULK_N}'
# отпечаток: chrome в РФ помечают (осень 2026) — если подключиться не вышло, один повтор с другим
FP_ALT = {'firefox': 'edge'}
PROTOS = ('vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'hysteria', 'tuic', 'wireguard', 'socks', 'http')
SLOTS = threading.BoundedSemaphore(8)   # не больше 8 Xray одновременно


def public(host):
    """адрес публичный (для /fetch и /tcp): иначе пробник стал бы ходить в свою локальную сеть"""
    try:
        ips = {a[4][0] for a in socket.getaddrinfo(host, None)}
    except OSError:
        return False
    return bool(ips) and all(ipaddress.ip_address(i.split('%')[0]).is_global for i in ips)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def fetch(url, headers):
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(5):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ('http', 'https') or not u.hostname:
            return {'error': 'нужна ссылка http(s)'}
        if not public(u.hostname):
            return {'error': 'адрес подписки не публичный или не находится в DNS'}
        try:
            r = opener.open(urllib.request.Request(url, headers={'Accept': '*/*', **headers}), timeout=15)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get('Location'):
                loc = e.headers['Location'].strip()
                if not loc.lower().startswith(('http://', 'https://')) and re.match(r'^[a-z][a-z0-9+.-]*://', loc, re.I):
                    return {'redirect': loc}   # на ссылку приложения — пусть развернёт панель
                url = urllib.parse.urljoin(url, loc)
                continue
            return {'error': f'сервер подписки ответил HTTP {e.code}'}
        except (urllib.error.URLError, OSError) as e:
            return {'error': f'не скачалось: {getattr(e, "reason", e)}'}
        with r:
            body = r.read(3_000_001)
        if len(body) > 3_000_000:
            return {'error': 'подписка больше 3 МБ'}
        return {'body': base64.b64encode(body).decode(), 'headers': {k.lower(): v for k, v in r.headers.items()}, 'url': url}
    return {'error': 'слишком много перенаправлений'}


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def ask_ip(port, url, kind):
    """один запрос через SOCKS Xray (новое соединение — балансировщик моста может выбрать другой выход)"""
    try:
        out = subprocess.run(['curl', '-s', '--max-time', '12', '--socks5-hostname', f'127.0.0.1:{port}', '-H', 'Cache-Control: no-cache', url],
                             capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    if kind == 'trace':
        kv = dict(line.split('=', 1) for line in out.splitlines() if '=' in line)
        return {'ip': kv['ip'], 'cc': kv.get('loc', ''), 'colo': kv.get('colo', '')} if kv.get('ip') else None
    if kind == 'json':
        try:
            return {'ip': json.loads(out)['ip']}
        except (ValueError, KeyError, TypeError):
            return None
    ip = out.strip()
    return {'ip': ip} if re.fullmatch(r'[0-9a-fA-F.:]{3,45}', ip) else None


def first_conn(port):
    """одно соединение через туннель: trace (IP выхода) и 256 КБ на нём же (curl переиспользует соединение)"""
    fd, tr = tempfile.mkstemp(suffix='.txt')
    os.close(fd)
    try:
        out = subprocess.run(['curl', '-s', '--max-time', '25', '--socks5-hostname', f'127.0.0.1:{port}', '-H', 'Cache-Control: no-cache',
                              '-w', '%{size_download} %{time_total}\n', TRACE_URL, '-o', tr, BULK_URL, '-o', '/dev/null'],
                             capture_output=True, text=True, timeout=30).stdout.split('\n')
        with open(tr) as f:
            kv = dict(line.split('=', 1) for line in f.read().splitlines() if '=' in line)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None, None
    finally:
        os.remove(tr)
    ex = {'ip': kv['ip'], 'cc': kv.get('loc', ''), 'colo': kv.get('colo', ''), 'via': 'speed.cloudflare.com'} if kv.get('ip') else None
    bulk = None
    if ex and len(out) > 1 and out[1].strip():
        try:
            n, t = out[1].split()
            bulk = {'bytes': int(float(n)), 'ms': round(float(t) * 1000)}
        except ValueError:
            pass
    return ex, bulk


def with_fp(ob, fp):
    """копия сервера с другим отпечатком TLS (только REALITY/TLS)"""
    ob = json.loads(json.dumps(ob))
    st = ob.get('streamSettings') or {}
    for k in ('realitySettings', 'tlsSettings'):
        if isinstance(st.get(k), dict):
            st[k]['fingerprint'] = fp
            return ob
    return None


def fp_of(ob):
    st = ob.get('streamSettings') or {}
    for k in ('realitySettings', 'tlsSettings'):
        if isinstance(st.get(k), dict):
            return st[k].get('fingerprint') or 'chrome'
    return None


def attempt(ob, extra=False):
    """Xray с одним выходом — сервером конкурента: первое подключение (IP + 256 КБ) и, если extra, второе —
    «какой IP» у другого сервиса (мост с балансировщиком может вывести в другой выход). Конфиг с ключами — во
    временном файле, удаляется сразу после проверки"""
    ob = dict(ob, tag='out')
    st = ob.get('streamSettings') or {}
    if isinstance(st.get('sockopt'), dict):
        st['sockopt'].pop('dialerProxy', None)
    port = free_port()
    cfg = {'log': {'loglevel': 'none'}, 'inbounds': [{'tag': 'in', 'listen': '127.0.0.1', 'port': port, 'protocol': 'socks', 'settings': {'udp': False}}],
           'outbounds': [ob], 'routing': {'rules': [{'type': 'field', 'inboundTag': ['in'], 'outboundTag': 'out'}]}}
    with SLOTS:
        fd, path = tempfile.mkstemp(suffix='.json')
        proc = None
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump(cfg, f)
            proc = subprocess.Popen([XRAY, 'run', '-c', path], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)   # ошибки конфига Xray пишет в stdout
            for _ in range(30):   # ждём, пока Xray откроет порт
                time.sleep(0.1)
                if proc.poll() is not None:
                    err = (proc.stdout.read() or b'').decode('utf-8', 'replace').strip().splitlines()
                    msg = err[-1].split(' > ')[-1] if err else ''
                    return {'error': 'Xray не принял конфиг: ' + msg[:200], 'config': True}
                try:
                    socket.create_connection(('127.0.0.1', port), timeout=0.2).close()
                    break
                except OSError:
                    pass
            ex, bulk = first_conn(port)
            if not ex:
                return {}
            res = [ex]
            if extra:
                url, kind = ECHO[1]
                r = ask_ip(port, url, kind)
                if r:
                    r['via'] = urllib.parse.urlsplit(url).hostname
                    res.append(r)
            return {'exits': res, 'bulk': bulk}
        finally:
            if proc and proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            try:
                os.remove(path)
            except OSError:
                pass


def exit_of(outbound, tries=2):
    """подключиться через сервер конкурента как обычный клиент. Не больше двух подключений к входу за проверку:
    удачно — второе узнаёт, нет ли другого выхода; неудачно — второе с другим отпечатком (вдруг режут отпечаток пробника)"""
    if not isinstance(outbound, dict) or outbound.get('protocol') not in PROTOS:
        return {'error': 'неподдерживаемый сервер'}
    ob = {k: v for k, v in outbound.items() if k not in ('proxySettings',)}
    host, port_ = target_of(ob)
    tcp = tcp_ping(host, port_) if host and str(port_).isdigit() and public(host) else None
    if tcp and tcp['st'] != 'open':   # до сервера не достучаться даже TCP — Xray не запускаем
        return {'error': 'TCP не подключается отсюда' + (' (отказ)' if tcp['st'] == 'closed' else ''), 'tcp': tcp}
    if not os.path.exists(XRAY):
        return {'error': 'на пробнике нет Xray — перезапустите probe/setup.sh', 'tcp': tcp}
    fp = fp_of(ob)
    r = attempt(ob, extra=int(tries) >= 2)
    if r.get('config'):
        return {'error': r['error'], 'tcp': tcp}
    alt = FP_ALT.get(fp, 'firefox') if fp else None
    if not r.get('exits') and alt:
        ob2 = with_fp(ob, alt)
        r2 = attempt(ob2) if ob2 else {}
        if r2.get('exits'):
            return {**r2, 'tcp': tcp, 'fp': alt, 'fp_alt': alt, 'fp_first': fp}
    if r.get('exits'):
        return {**r, 'tcp': tcp, 'fp': fp}
    return {'error': 'TCP есть, а VPN не подключился — DPI, протокол режут или конфиг устарел' + (f' (пробовали отпечатки {fp} и {alt})' if alt else ''),
            'tcp': tcp, 'vpn_fail': True, 'fp': fp}


def tcp_ping(host, port, timeout=4):
    """TCP-пинг: открылось ли соединение и за сколько мс (без данных — только рукопожатие TCP)"""
    t0 = time.monotonic()
    try:
        socket.create_connection((host, int(port)), timeout=timeout).close()
        return {'st': 'open', 'ms': round((time.monotonic() - t0) * 1000)}
    except ConnectionRefusedError:
        return {'st': 'closed'}   # ответили отказом: порт закрыт, но адрес жив
    except (OSError, ValueError):
        return {'st': 'filtered'}   # тишина: адрес заблокирован по пути или сервер лежит


def target_of(ob):
    se = ob.get('settings') or {}
    v = se.get('vnext') or se.get('servers') or [se]
    v = v[0] if isinstance(v, list) and v else {}
    return str(v.get('address') or ''), v.get('port')


def info():
    me = {}
    try:
        with urllib.request.urlopen('https://1.1.1.1/cdn-cgi/trace', timeout=8) as r:
            kv = dict(line.split('=', 1) for line in r.read().decode().splitlines() if '=' in line)
        me = {'ip': kv.get('ip', ''), 'cc': kv.get('loc', '')}
    except OSError:
        pass
    try:
        ver = subprocess.run([XRAY, 'version'], capture_output=True, text=True, timeout=5).stdout.split('\n')[0]
    except OSError:
        ver = ''
    return {**me, 'xray': ver}


class H(BaseHTTPRequestHandler):
    server_version = 'sepia-probe'
    sys_version = ''

    def log_message(self, fmt, *args):
        pass

    def reply(self, code, obj=None):
        body = json.dumps(obj, ensure_ascii=False).encode() if obj is not None else b''
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        ip = self.client_address[0]
        tok = (self.headers.get('Authorization') or '').removeprefix('Bearer ').strip()
        return bool(TOKEN) and (not PANEL or ip in PANEL) and hmac.compare_digest(tok.encode(), TOKEN.encode())

    def do_GET(self):
        if not self.allowed():
            return self.reply(403)
        if self.path == '/info':
            return self.reply(200, info())
        self.reply(404)

    def do_POST(self):
        if not self.allowed():
            return self.reply(403)
        try:
            n = min(int(self.headers.get('Content-Length') or 0), 1_000_000)
            x = json.loads(self.rfile.read(n) or b'{}')
            assert isinstance(x, dict)
        except (ValueError, AssertionError):
            return self.reply(400, {'error': 'не JSON'})
        if self.path == '/fetch':
            hdr = {str(k)[:40]: str(v)[:300] for k, v in (x.get('headers') or {}).items() if re.fullmatch(r'[A-Za-z0-9-]{1,40}', str(k))}
            return self.reply(200, fetch(str(x.get('url') or ''), hdr))
        if self.path == '/exit':
            return self.reply(200, exit_of(x.get('outbound'), x.get('tries') or 2))
        if self.path == '/tcp':
            t = [(str(h), p) for h, p in (x.get('targets') or [])[:400] if str(p).isdigit() and public(str(h))]
            with ThreadPoolExecutor(32) as ex:
                st = list(ex.map(lambda hp: tcp_ping(*hp), t))
            return self.reply(200, {f'{h}:{p}': s for (h, p), s in zip(t, st)})
        self.reply(404)


class Server(ThreadingHTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    if not TOKEN:
        raise SystemExit('sepia-probe: нет TOKEN в /etc/sepia-probe/probe.conf — запустите probe/setup.sh')
    srv = Server(('0.0.0.0', PORT), H)
    cred = os.environ.get('CREDENTIALS_DIRECTORY') or CONF_DIR
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.path.join(cred, 'cert.pem'), os.path.join(cred, 'key.pem'))
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print(f'sepia-probe: слушаю :{PORT} (HTTPS), пускаю {", ".join(sorted(PANEL)) or "всех с токеном"}', flush=True)
    srv.serve_forever()
