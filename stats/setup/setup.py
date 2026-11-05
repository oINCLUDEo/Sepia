#!/usr/bin/env python3
"""node-setup — автонастройка новой ноды по SSH для мастера «Новая нода» в дашборде.

Снаружи недоступен: его зовёт только node-auth (docker-сеть), который проверяет вход и пароль администратора.
Пароль SSH используется для одного задания и нигде не сохраняется; ключей на ноду не ставим.

  POST /start   {ip, ssh_port, ssh_user, password, name, mode, domain, site, mask_domain, reality_port, prev_node_ip,
                 admin_ip, admin_ip_backup, compose, price, cur, stats_url} -> {"id"}
  GET  /job/ID?from=N  -> {status, steps, log (строки с N), result}
  POST /cancel/ID      -> 204

Шаги: подключение -> подготовка (пакеты, git clone Sepia) -> ожидание DNS (поддомен указывает на ноду у
авторитетных серверов зоны и у публичных резолверов: Google, Cloudflare, Яндекс) -> provision-node.sh (заглушка,
сертификат, фаервол, ключи Reality; фаервол закрепляется, только если новое SSH-подключение после правил прошло) ->
remnanode по инструкции docs.rw: Docker, /opt/remnanode, docker-compose.yml из панели, docker compose up -d ->
node-check (статистика, сбор каждую минуту, цена).
Окружение: VM_WRITE_PASS (пароль записи статистики), SEPIA_REPO, PORT (8092), DATA (/data — журналы заданий).
"""
import ipaddress
import json
import os
import random
import re
import secrets
import shlex
import socket
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get('PORT', '8092'))
REPO = os.environ.get('SEPIA_REPO', 'https://github.com/oINCLUDEo/Sepia.git')
WRITE_PASS = os.environ.get('VM_WRITE_PASS', '')
DATA = os.environ.get('DATA', '/data')
DNS_WAIT = int(os.environ.get('DNS_WAIT', str(90 * 60)))   # сколько ждать, пока A-запись дойдёт до всех
DNS_EVERY = int(os.environ.get('DNS_EVERY', '20'))
PUBLIC_DNS = [('Google', '8.8.8.8'), ('Cloudflare', '1.1.1.1'), ('Яндекс', '77.88.8.8')]
STEPS = [('connect', 'Подключение по SSH'), ('prepare', 'Подготовка: пакеты и Sepia'), ('dns', 'Ожидание DNS'),
         ('provision', 'Заглушка, сертификат, фаервол, ключи Reality'), ('remnanode', 'remnanode'), ('nodecheck', 'Статистика node-check')]
JOBS, LOCK = {}, threading.Lock()


class Stop(Exception):
    pass


# ---------- DNS: маленький клиент на stdlib — спрашиваем конкретные серверы, а не системный резолвер ----------
def _qname(name):
    return b''.join(bytes([len(p)]) + p.encode('idna') for p in name.rstrip('.').split('.')) + b'\0'


def _rname(msg, off):
    labels, jumped, end = [], False, off
    for _ in range(64):
        n = msg[off]
        if n == 0:
            off += 1
            break
        if n & 0xC0 == 0xC0:   # сжатие: ссылка на имя выше в ответе
            ptr = ((n & 0x3F) << 8) | msg[off + 1]
            if not jumped:
                end = off + 2
            jumped, off = True, ptr
            continue
        labels.append(msg[off + 1:off + 1 + n].decode('ascii', 'replace'))
        off += 1 + n
    return '.'.join(labels), (end if jumped else off)


def dns_query(name, server, qtype=1, timeout=3):
    """A (1) или NS (2) записи name у сервера server; None — сервер не ответил"""
    tid = random.randint(0, 0xFFFF)
    pkt = struct.pack('>HHHHHH', tid, 0x0100, 1, 0, 0, 0) + _qname(name) + struct.pack('>HH', qtype, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(pkt, (server, 53))
        msg, _ = s.recvfrom(4096)
    except OSError:
        return None
    finally:
        s.close()
    if len(msg) < 12 or struct.unpack('>H', msg[:2])[0] != tid:
        return None
    qd, an, ns_, _ = struct.unpack('>HHHH', msg[4:12])
    off = 12
    for _ in range(qd):
        off = _rname(msg, off)[1] + 4
    out = []
    for _ in range(an + ns_):
        _, off = _rname(msg, off)
        typ, _, _, rdlen = struct.unpack('>HHIH', msg[off:off + 10])
        off += 10
        if typ == qtype == 1 and rdlen == 4:
            out.append(socket.inet_ntoa(msg[off:off + 4]))
        elif typ == qtype == 2:
            out.append(_rname(msg, off)[0])
        off += rdlen
    return out


def dns_servers(domain):
    """авторитетные серверы зоны (у reg.ru — ns1/ns2.reg.ru) + публичные резолверы"""
    parts = domain.rstrip('.').split('.')
    out = []
    for i in range(len(parts) - 1):   # NS ищем от самой длинной зоны к короткой: studio.ulya.space -> ulya.space
        zone = '.'.join(parts[i:])
        names = []
        for _, srv in PUBLIC_DNS:
            names = dns_query(zone, srv, 2) or []
            if names:
                break
        if names:
            for nsn in names[:4]:
                ips = None
                for _, srv in PUBLIC_DNS:
                    ips = dns_query(nsn, srv, 1)
                    if ips:
                        break
                if ips:
                    out.append((nsn + ' (зона)', ips[0], True))
            break
    return out + [(f'{n} {ip}', ip, False) for n, ip in PUBLIC_DNS]


# ---------- задания ----------
def new_job(data):
    jid = secrets.token_hex(8)
    job = {'id': jid, 'status': 'run', 'steps': [{'id': k, 't': t, 'st': 'wait'} for k, t in STEPS], 'log': [], 'result': {},
           'cancel': False, 'proc': None, 'data': data, 'started': time.time(), 'name': data['name']}
    with LOCK:
        JOBS[jid] = job
        for k in [k for k, j in JOBS.items() if j['status'] != 'run' and time.time() - j['started'] > 86400]:
            JOBS.pop(k, None)
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return jid


def secrets_of(job):
    d = job['data']
    out = [d.get('password'), WRITE_PASS]
    m = re.search(r'SECRET_KEY\s*[=:]\s*["\']?([^"\'\s]+)', d.get('compose') or '')
    if m:
        out.append(m.group(1))
    return [s for s in out if s and len(s) >= 4]


def say(job, line, kind=''):
    for s in secrets_of(job):
        line = line.replace(s, '•••')
    entry = {'t': round(time.time()), 'm': line.rstrip()[:2000], 'k': kind}
    with LOCK:
        job['log'].append(entry)
    try:
        with open(os.path.join(DATA, job['id'] + '.log'), 'a', encoding='utf-8') as f:
            f.write(time.strftime('%F %T ') + entry['m'] + '\n')
    except OSError:
        pass


def step(job, sid, st):
    for s in job['steps']:
        if s['id'] == sid:
            s['st'] = st


def ssh(job, script, on_line=None, timeout=1800):
    """скрипт bash на ноде через stdin (секреты не попадают в командную строку); строки вывода — в журнал"""
    d = job['data']
    if job['cancel']:
        raise Stop('отменено')
    cmd = ['sshpass', '-e', 'ssh', '-p', str(d['ssh_port']), '-o', 'StrictHostKeyChecking=accept-new', '-o', f"UserKnownHostsFile={job['kh']}",
           '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8', '-o', 'PubkeyAuthentication=no',
           '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'LogLevel=ERROR', f"{d['ssh_user']}@{d['ip']}", 'bash -s']
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors='replace',
                         env={**os.environ, 'SSHPASS': d['password'], 'LC_ALL': 'C.UTF-8'})
    job['proc'] = p
    timer = threading.Timer(timeout, p.kill)
    timer.start()
    try:
        p.stdin.write(script)
        p.stdin.close()
        out = []
        for line in p.stdout:
            line = re.sub(r'\x1b\[[0-9;]*m', '', line).rstrip('\n')   # без цветов терминала
            out.append(line)
            if on_line:
                on_line(line)
            else:
                say(job, line)
        rc = p.wait()
    finally:
        timer.cancel()
        job['proc'] = None
    if job['cancel']:
        raise Stop('отменено')
    return rc, out


def run_job(job):
    d = job['data']
    fd, job['kh'] = tempfile.mkstemp(prefix='kh-')   # свои known_hosts на задание: доверяем ключу ноды с первого подключения
    os.close(fd)
    cur = None
    try:
        # 1. подключение
        cur = 'connect'
        step(job, cur, 'run')
        say(job, f"Подключаюсь к {d['ssh_user']}@{d['ip']}:{d['ssh_port']}…", 'h')
        rc, out = ssh(job, 'echo "SSH_CLIENT=$SSH_CLIENT"; echo "UID=$(id -u)"; . /etc/os-release 2>/dev/null; echo "OS=$ID $VERSION_ID"\n', on_line=lambda l: None, timeout=60)
        kv = dict(line.split('=', 1) for line in out if '=' in line)
        if rc != 0 or 'UID' not in kv:
            raise RuntimeError('не удалось войти по SSH: ' + (' '.join(out[-3:]) or f'код {rc}') + ' — проверьте IP, порт и пароль')
        if kv['UID'] != '0':
            raise RuntimeError('нужен пользователь root (или вход под root)')
        if not re.match(r'(debian|ubuntu)\b', kv.get('OS', '')):
            raise RuntimeError(f"нужен Debian или Ubuntu, а тут: {kv.get('OS') or 'неизвестно'}")
        job['panel_ip'] = kv.get('SSH_CLIENT', '').split(' ')[0]   # с этого адреса мы пришли — его пускаем в фаерволе
        say(job, f"Вошёл: {kv['OS']}, root. Адрес сервера панели для фаервола: {job['panel_ip'] or '?'}", 'ok')
        step(job, cur, 'ok')

        # 2. подготовка
        cur = 'prepare'
        step(job, cur, 'run')
        say(job, 'Ставлю git и curl, забираю Sepia…', 'h')
        rc, _ = ssh(job, f"""set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
if [ -d /root/Sepia/.git ]; then git -C /root/Sepia pull -q --ff-only; else git clone -q {shlex.quote(REPO)} /root/Sepia; fi
echo "Sepia: $(git -C /root/Sepia log -1 --format='%h от %cs')"
""", timeout=900)
        if rc != 0:
            raise RuntimeError('подготовка не удалась — смотрите журнал выше')
        step(job, cur, 'ok')

        # 3. DNS: поддомен должен указывать на ноду у всех — иначе Let's Encrypt не выпустит сертификат
        cur = 'dns'
        if d['mode'] in ('1', '2'):
            step(job, cur, 'run')
            wait_dns(job)
            step(job, cur, 'ok')
        else:
            step(job, cur, 'skip')

        # 4. provision-node.sh
        cur = 'provision'
        step(job, cur, 'run')
        say(job, 'Запускаю provision-node.sh…', 'h')
        env = {'MODE': d['mode'], 'ADMIN_IP': d['admin_ip'], 'ADMIN_IP_BACKUP': d['admin_ip_backup'] or '-', 'TUNE': '1',
               'NODE_PORT': d['node_port'], 'FW_CONFIRM_FILE': '/root/.rw-fw-confirm'}
        if job.get('panel_ip'):
            env['SSH_EXTRA'] = env['PANEL_IP_EXTRA'] = job['panel_ip']
        if d['mode'] in ('1', '2'):
            env.update(DOMAIN=d['domain'], SITE=d['site'] or 'arclayer')
        if d['mode'] == '2':
            env.update(REALITY_PORT=d['reality_port'] or '8443', PREV_NODE_IP=d['prev_node_ip'])
        if d['mode'] == '3':
            env['MASK_DOMAIN'] = d['mask_domain'] or 'ads.x5.ru'
        exports = ''.join(f'export {k}={shlex.quote(str(v))}\n' for k, v in env.items())
        res, fw = {}, {'ok': None, 'th': None}

        def on_prov(line):
            say(job, line)
            m = re.match(r'\s+(port|target|serverNames|privateKey|publicKey|shortIds)\s*:\s*(.+)$', line)
            if m:
                res[m.group(1)] = m.group(2).strip()
            if line.startswith('FW_WAIT_CONFIRM '):
                # фаервол применён: проверяем НОВЫМ подключением, что SSH жив, — и только тогда закрепляем
                path = line.split(' ', 1)[1].strip()
                def confirm():
                    time.sleep(2)
                    rc2, out2 = ssh_side(job, f'touch {shlex.quote(path)} && echo FW_CONFIRMED\n')
                    fw['ok'] = rc2 == 0 and 'FW_CONFIRMED' in out2
                    say(job, 'Новое SSH-подключение после фаервола прошло — закрепляю правила' if fw['ok']
                        else 'Новое SSH-подключение после фаервола не прошло — правила откатятся сами через 2 минуты', 'ok' if fw['ok'] else 'err')
                fw['th'] = threading.Thread(target=confirm, daemon=True)
                fw['th'].start()
        rc, out = ssh(job, exports + 'cd /root/Sepia && bash provision-node.sh </dev/null\n', on_line=on_prov, timeout=2400)
        if fw['th']:
            fw['th'].join(70)   # проверка фаервола идёт параллельно — дожидаемся её вывода
        if rc != 0:
            raise RuntimeError('provision-node.sh завершился с ошибкой — смотрите журнал выше' + (' (часто — сертификат: A-запись, порт 80)' if any('certbot' in x for x in out) else ''))
        if fw['ok'] is not True:
            raise RuntimeError('фаервол не закреплён: проверка нового SSH-подключения не прошла')
        job['result'].update(res)
        step(job, cur, 'ok')

        # 5. remnanode — по инструкции docs.rw
        cur = 'remnanode'
        if d['compose'].strip():
            step(job, cur, 'run')
            say(job, 'Ставлю Docker и remnanode (docker-compose.yml из панели)…', 'h')
            delim = 'RW_COMPOSE_' + secrets.token_hex(6)
            rc, out = ssh(job, f"""set -e
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
mkdir -p /opt/remnanode && cd /opt/remnanode
cat > docker-compose.yml <<'{delim}'
{d['compose'].rstrip()}
{delim}
docker compose up -d
sleep 8
echo "--- docker compose ps"; docker compose ps
echo "--- последние строки журнала"; docker compose logs --tail 25 -t
docker compose ps --status running --quiet | grep -q . && echo REMNANODE_RUNNING
""", timeout=1200)
            if rc != 0 or not any('REMNANODE_RUNNING' in x for x in out):
                raise RuntimeError('remnanode не запустился — смотрите журнал контейнера выше')
            step(job, cur, 'ok')
        else:
            step(job, cur, 'skip')
            say(job, 'docker-compose.yml не вставлен — remnanode пропускаю (можно поставить потом вручную).')

        # 6. node-check
        cur = 'nodecheck'
        step(job, cur, 'run')
        say(job, 'Включаю статистику node-check…', 'h')
        nc = {'STATS_URL': d['stats_url'], 'STATS_USER': 'writer', 'STATS_PASS': WRITE_PASS, 'NODE_NAME': d['name'], 'NODE_IP': d['ip']}
        price = f"\nbash node-check.sh price {shlex.quote(d['price'])} {shlex.quote(d['cur'] or 'EUR')}" if d.get('price') else ''
        rc, _ = ssh(job, ''.join(f'export {k}={shlex.quote(v)}\n' for k, v in nc.items()) +
                    f'set -e\ncd /root/Sepia\nbash node-check.sh stats </dev/null\nbash node-check.sh install </dev/null{price}\n', timeout=900)
        if rc != 0:
            raise RuntimeError('node-check не включился — смотрите журнал выше (часто — пароль записи VM_WRITE_PASS)')
        step(job, cur, 'ok')
        job['status'] = 'ok'
        say(job, 'Готово. Данные для профиля ноды в Remnawave — ниже.', 'ok')
    except Stop:
        job['status'] = 'cancel'
        if cur:
            step(job, cur, 'err')
        say(job, 'Отменено.', 'err')
    except Exception as e:   # любой сбой — в журнал и статус, сервис продолжает работать
        job['status'] = 'err'
        if cur:
            step(job, cur, 'err')
        say(job, f'Ошибка: {e}', 'err')
    finally:
        job['data']['password'] = ''   # пароль SSH дальше не нужен
        try:
            os.unlink(job['kh'])
        except OSError:
            pass


def ssh_side(job, script):
    """отдельное подключение параллельно основному (проверка SSH после фаервола)"""
    d = job['data']
    cmd = ['sshpass', '-e', 'ssh', '-p', str(d['ssh_port']), '-o', 'StrictHostKeyChecking=accept-new', '-o', f"UserKnownHostsFile={job['kh']}",
           '-o', 'ConnectTimeout=15', '-o', 'PubkeyAuthentication=no', '-o', 'LogLevel=ERROR', f"{d['ssh_user']}@{d['ip']}", 'bash -s']
    try:
        p = subprocess.run(cmd, input=script, capture_output=True, text=True, timeout=60, env={**os.environ, 'SSHPASS': d['password']})
        return p.returncode, p.stdout
    except subprocess.TimeoutExpired:
        return 1, ''


def wait_dns(job):
    d, dom, ip = job['data'], job['data']['domain'], job['data']['ip']
    servers = dns_servers(dom)
    auth = [s for s in servers if s[2]]
    say(job, f"Жду, пока {dom} начнёт указывать на {ip} у всех: " + ', '.join(s[0] for s in servers) +
        '. Запись вы делаете сами в reg.ru; обычно расходится за 5–30 минут.', 'h')
    end, last = time.time() + DNS_WAIT, None
    while True:
        if job['cancel']:
            raise Stop()
        state = []
        for name, srv, is_auth in servers:
            a = dns_query(dom, srv, 1)
            state.append((name, is_auth, None if a is None else (ip in a), a))
        answered = [s for s in state if s[2] is not None]
        good = (all(s[2] for s in state if s[1]) and (auth or answered) and all(s[2] for s in answered)
                and any(not s[1] for s in answered))
        line = ' · '.join(f"{n}: {'✓' if ok else '—' if ok is None else ('нет записи' if not a else 'указывает на ' + ', '.join(a))}" for n, _, ok, a in state)
        if line != last:
            say(job, line, 'ok' if good else '')
            last = line
        if good:
            say(job, f'{dom} указывает на ноду у всех — можно выпускать сертификат.', 'ok')
            return
        if time.time() > end:
            raise RuntimeError(f'за {DNS_WAIT // 60} минут {dom} так и не стал указывать на {ip} у всех серверов — проверьте A-запись в reg.ru')
        for _ in range(DNS_EVERY):
            if job['cancel']:
                raise Stop()
            time.sleep(1)


# ---------- проверка заявки ----------
def ipv4(v):
    try:
        return str(ipaddress.IPv4Address(str(v).strip()))
    except ValueError:
        return None


DOMAIN_RE = re.compile(r'^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')


def validate(x):
    g = lambda k, dflt='': str(x.get(k) or dflt).strip()
    d = {'ip': ipv4(g('ip')), 'ssh_port': g('ssh_port', '22'), 'ssh_user': g('ssh_user', 'root'), 'password': str(x.get('password') or ''),
         'name': g('name'), 'mode': g('mode', '1'), 'domain': g('domain').lower(), 'site': g('site', 'arclayer'), 'mask_domain': g('mask_domain').lower(),
         'reality_port': g('reality_port'), 'prev_node_ip': g('prev_node_ip'), 'admin_ip': ipv4(g('admin_ip')), 'admin_ip_backup': g('admin_ip_backup'),
         'compose': str(x.get('compose') or ''), 'price': g('price').replace(',', '.'), 'cur': g('cur', 'EUR'), 'stats_url': g('stats_url')}
    m = re.search(r'NODE_PORT\s*[=:]\s*["\']?(\d{2,5})', d['compose'])
    d['node_port'] = m.group(1) if m else '2222'
    errs = []
    if not d['ip']: errs.append('IP ноды')
    if not d['ssh_port'].isdigit(): errs.append('порт SSH')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', d['ssh_user']): errs.append('пользователь SSH')
    if not d['password']: errs.append('пароль SSH')
    if not re.fullmatch(r'[\w.\-]{2,60}', d['name']): errs.append('имя ноды (буквы, цифры, точка, дефис)')
    if d['mode'] not in ('1', '2', '3'): errs.append('режим')
    if d['mode'] in ('1', '2') and not DOMAIN_RE.match(d['domain']): errs.append('поддомен')
    if d['mode'] == '3' and d['mask_domain'] and not DOMAIN_RE.match(d['mask_domain']): errs.append('домен-маска')
    if d['mode'] == '2' and not ipv4(d['prev_node_ip']): errs.append('IP предыдущего узла')
    if d['mode'] == '2' and d['reality_port'] and not d['reality_port'].isdigit(): errs.append('порт Reality')
    if d['site'] not in ('arclayer', 'sepia', 'racelive'): errs.append('сайт')
    if not d['admin_ip']: errs.append('ваш IP для SSH')
    if d['admin_ip_backup'] not in ('', '-') and not ipv4(d['admin_ip_backup']): errs.append('запасной IP')
    if d['compose'].strip() and not re.search(r'remnawave/node', d['compose']): errs.append('docker-compose.yml (нет образа remnawave/node)')
    if d['price'] and not re.fullmatch(r'\d+(\.\d+)?', d['price']): errs.append('цена')
    if not d['cur'].isalpha(): errs.append('валюта')
    if not re.match(r'https://[\w.\-]+(:\d+)?/', d['stats_url']): errs.append('адрес приёмника статистики')
    if not WRITE_PASS: errs.append('VM_WRITE_PASS в окружении node-setup')
    return d, errs


class H(BaseHTTPRequestHandler):
    server_version = 'node-setup'
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

    def do_GET(self):
        m = re.fullmatch(r'/job/([0-9a-f]{16})(?:\?from=(\d+))?', self.path)
        job = JOBS.get(m.group(1)) if m else None
        if not job:
            return self.reply(404)
        frm = int(m.group(2) or 0)
        with LOCK:
            self.reply(200, {'id': job['id'], 'status': job['status'], 'steps': job['steps'], 'log': job['log'][frm:], 'next': len(job['log']),
                             'result': job['result'], 'name': job['name']})

    def do_POST(self):
        n = min(int(self.headers.get('Content-Length') or 0), 65536)
        raw = self.rfile.read(n)
        if self.path == '/start':
            try:
                x = json.loads(raw or b'{}')
            except ValueError:
                return self.reply(400, {'error': 'не JSON'})
            if not isinstance(x, dict):
                return self.reply(400, {'error': 'не JSON'})
            d, errs = validate(x)
            if errs:
                return self.reply(400, {'error': 'Проверьте: ' + ', '.join(errs)})
            if any(j['status'] == 'run' and j['data']['ip'] == d['ip'] for j in JOBS.values()):
                return self.reply(409, {'error': 'эта нода уже настраивается'})
            return self.reply(200, {'id': new_job(d)})
        m = re.fullmatch(r'/cancel/([0-9a-f]{16})', self.path)
        job = JOBS.get(m.group(1)) if m else None
        if not job:
            return self.reply(404)
        job['cancel'] = True
        if job.get('proc'):
            job['proc'].kill()
        self.reply(204)


class Server(ThreadingHTTPServer):
    daemon_threads = True


if __name__ == '__main__':
    os.makedirs(DATA, exist_ok=True)
    print(f'node-setup: слушаю :{PORT}', flush=True)
    Server(('0.0.0.0', PORT), H).serve_forever()
