#!/usr/bin/env python3
"""node-setup — автонастройка новой ноды по SSH для мастера «Новая нода» в дашборде.

Снаружи недоступен: его зовёт только node-auth (docker-сеть), который проверяет вход и пароль администратора.
Пароль SSH используется для одного задания и нигде не сохраняется; ключей на ноду не ставим.

  POST /start   {ip, ssh_port, ssh_user, password, name, mode, domain, site, mask_domain, reality_port, prev_node_ip,
                 admin_ip, admin_ip_backup, compose, price, cur, stats_url} -> {"id"}
  GET  /job/ID?from=N  -> {status, steps, log (строки с N), result}
  POST /cancel/ID      -> 204
  POST /fw      {ip, ssh_port, password, name, admin_ip, rules: [{proto, port, from: "all" | [IP…]}]} -> {"id"}: правка фаервола
  POST /probe   {ip, ports: [{proto, port}]} -> {"tcp/22": "open" | "closed" | "filtered"}: порты ноды снаружи (с панели)

Шаги: подключение -> подготовка (пакеты, git clone Sepia) -> ожидание DNS (поддомен указывает на ноду у
авторитетных серверов зоны и у публичных резолверов: Google, Cloudflare, Яндекс) -> provision-node.sh (заглушка,
сертификат, фаервол, ключи Reality; фаервол закрепляется, только если новое SSH-подключение после правил прошло) ->
remnanode по инструкции docs.rw: Docker, /opt/remnanode, docker-compose.yml из панели, docker compose up -d ->
node-check (статистика, сбор каждую минуту, цена).
Окружение: VM_WRITE_PASS (пароль записи статистики), SEPIA_REPO, PORT (8092), DATA (/data — журналы заданий).
"""
import base64
import hashlib
import hmac
import http.client
import ssl
from html import unescape as html_unescape
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
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
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
    """A (1), NS (2) или TXT (16) записи name у сервера server; None — сервер не ответил"""
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
        elif typ == qtype and qtype in (2, 12):   # NS, PTR
            out.append(_rname(msg, off)[0])
        elif typ == qtype == 16:   # TXT: строки <длина><текст> подряд
            i, txt = off, b''
            while i < off + rdlen:
                ln = msg[i]
                txt += msg[i + 1:i + 1 + ln]
                i += 1 + ln
            out.append(txt.decode('utf-8', 'replace'))
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
FW_STEPS = [('connect', 'Подключение по SSH'), ('apply', 'Новые правила фаервола'), ('verify', 'Проверка: новое SSH-подключение и порт панели')]


def new_job(data, kind='setup'):
    jid = secrets.token_hex(8)
    job = {'id': jid, 'status': 'run', 'steps': [{'id': k, 't': t, 'st': 'wait'} for k, t in (FW_STEPS if kind == 'fw' else STEPS)], 'log': [], 'result': {},
           'cancel': False, 'proc': None, 'data': data, 'started': time.time(), 'name': data['name'], 'kind': kind}
    with LOCK:
        JOBS[jid] = job
        for k in [k for k, j in JOBS.items() if j['status'] != 'run' and time.time() - j['started'] > 86400]:
            JOBS.pop(k, None)
    threading.Thread(target=run_fw if kind == 'fw' else run_job, args=(job,), daemon=True).start()
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
printf 'DPkg::Lock::Timeout "900";\\n' > /etc/apt/apt.conf.d/90-rw-lock-wait   # apt ждёт, пока unattended-upgrades отпустит dpkg, а не падает
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
        if d['skip_prov']:
            step(job, cur, 'skip')
        elif d['mode'] in ('1', '2'):
            step(job, cur, 'run')
            wait_dns(job)
            step(job, cur, 'ok')
        else:
            step(job, cur, 'skip')

        # 4. provision-node.sh
        cur = 'provision'
        if d['skip_prov']:
            step(job, cur, 'skip')
            say(job, 'Нода уже подготовлена — provision-node.sh пропускаю (ключи Reality — в журнале прошлого запуска).')
        else:
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
printf 'DPkg::Lock::Timeout "900";\\n' > /etc/apt/apt.conf.d/90-rw-lock-wait   # установщик Docker зовёт apt-get: пусть ждёт unattended-upgrades
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
            raise RuntimeError('node-check не включился — причина в строке журнала прямо перед этой')
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


# ---------- фаервол: правка по SSH и проверка снаружи ----------
def tcp_state(ip, port, timeout=3):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((ip, int(port)))
        return 'open'
    except ConnectionRefusedError:
        return 'closed'      # фаервол ответил RST (наше «прочий TCP -> RST») или порт никто не слушает
    except OSError:
        return 'filtered'    # тишина: режет фаервол хостера или нода недоступна
    finally:
        s.close()


def probe(ip, ports):
    out, th = {}, []
    def one(p):
        out[f"{p['proto']}/{p['port']}"] = tcp_state(ip, p['port']) if p['proto'] == 'tcp' else 'unknown'   # UDP так не проверить
    tcp = [p for p in ports if p['proto'] == 'tcp'][:128]
    for p in ports:
        if p['proto'] != 'tcp':
            out[f"{p['proto']}/{p['port']}"] = 'unknown'
    for p in tcp:
        t = threading.Thread(target=one, args=(p,), daemon=True); t.start(); th.append(t)
    for t in th:
        t.join(6)
    return out


def connect_step(job):
    d = job['data']
    say(job, f"Подключаюсь к {d['ssh_user']}@{d['ip']}:{d['ssh_port']}…", 'h')
    rc, out = ssh(job, 'echo "SSH_CLIENT=$SSH_CLIENT"; echo "UID=$(id -u)"\n', on_line=lambda l: None, timeout=60)
    kv = dict(line.split('=', 1) for line in out if '=' in line)
    if rc != 0 or 'UID' not in kv:
        raise RuntimeError('не удалось войти по SSH: ' + (' '.join(out[-3:]) or f'код {rc}') + ' — проверьте пароль и порт')
    if kv['UID'] != '0':
        raise RuntimeError('нужен пользователь root')
    job['panel_ip'] = kv.get('SSH_CLIENT', '').split(' ')[0]
    say(job, f"Вошёл. Сервер панели заходит с {job['panel_ip'] or '?'}", 'ok')


def run_fw(job):
    d = job['data']
    fd, job['kh'] = tempfile.mkstemp(prefix='kh-')
    os.close(fd)
    cur = None
    try:
        cur = 'connect'
        step(job, cur, 'run')
        connect_step(job)
        step(job, cur, 'ok')
        cur = 'apply'
        step(job, cur, 'run')
        rules, panel = d['rules'], job.get('panel_ip')
        # SSH должен оставаться открытым вам и серверу панели — иначе следующую правку не сделать; добавляем сами
        ssh_rule = next(r for r in rules if r['proto'] == 'tcp' and r['port'] == str(d['ssh_port']))
        if ssh_rule['from'] != 'all':
            for need, who in ((d['admin_ip'], 'ваш IP'), (panel, 'IP сервера панели')):
                if need and need not in ssh_rule['from']:
                    ssh_rule['from'].append(need)
                    say(job, f'В правило SSH добавлен {who} {need} — иначе потеряется доступ', 'ok')
        spec = '\n'.join(f"{r['proto']} {r['port']} {'all' if r['from'] == 'all' else ','.join(r['from'])}" for r in rules)
        say(job, 'Новые правила:\n' + '\n'.join('  ' + line for line in spec.split('\n')), 'h')
        # порт, открытый серверу панели (кроме SSH), — скорее всего remnanode: после правил проверим, что панель до него достаёт
        panel_ports = [r['port'] for r in rules if r['proto'] == 'tcp' and r['port'] != str(d['ssh_port']) and r['from'] != 'all' and panel in r['from'] and r['port'].isdigit()]
        fw = {'ok': None, 'th': None}

        def on_line(line):
            say(job, line)
            if line.startswith('FW_WAIT_CONFIRM '):
                path = line.split(' ', 1)[1].strip()
                def confirm():
                    time.sleep(2)
                    step(job, 'verify', 'run')
                    rc2, out2 = ssh_side(job, 'echo NEW_SSH_OK\n')
                    good = rc2 == 0 and 'NEW_SSH_OK' in out2
                    say(job, 'Новое SSH-подключение после правил прошло' if good else 'Новое SSH-подключение после правил НЕ прошло', 'ok' if good else 'err')
                    for p in panel_ports:
                        st = tcp_state(d['ip'], p)
                        say(job, f'Порт {p} с сервера панели: ' + {'open': 'доступен', 'closed': 'закрыт (RST)', 'filtered': 'не отвечает'}[st], 'ok' if st == 'open' else 'err')
                        good = good and st == 'open'
                    if good:
                        rc3, _ = ssh_side(job, f'touch {shlex.quote(path)}\n')
                        good = rc3 == 0
                    fw['ok'] = good
                    step(job, 'verify', 'ok' if good else 'err')
                    if not good:
                        say(job, 'Не подтверждаю — нода сама вернёт прежние правила через 2 минуты', 'err')
                fw['th'] = threading.Thread(target=confirm, daemon=True)
                fw['th'].start()
        rc, out = ssh(job, f"""cd /root/Sepia 2>/dev/null || {{ echo 'Нет /root/Sepia — node-check не установлен'; exit 3; }}
git pull -q --ff-only 2>/dev/null || true
grep -q 'fw-apply)' node-check.sh || {{ echo 'node-check на ноде старый, без правки фаервола — обновите: git pull'; exit 3; }}
bash node-check.sh fw-apply <<'RW_RULES_EOF'
{spec}
RW_RULES_EOF
""", on_line=on_line, timeout=300)
        if fw['th']:
            fw['th'].join(90)
        if rc != 0 or fw['ok'] is not True:
            raise RuntimeError('правила не применены — смотрите журнал выше' + (' (откат на ноде через 2 минуты)' if any('FW_WAIT_CONFIRM' in x for x in out) else ''))
        step(job, cur, 'ok')
        job['status'] = 'ok'
        say(job, 'Готово: правила применены и закреплены, отчёт о портах отправлен на дашборд.', 'ok')
    except Stop:
        job['status'] = 'cancel'
        if cur:
            step(job, cur, 'err')
        say(job, 'Отменено.', 'err')
    except Exception as e:   # любой сбой — в журнал и статус
        job['status'] = 'err'
        if cur:
            step(job, cur, 'err')
        say(job, f'Ошибка: {e}', 'err')
    finally:
        job['data']['password'] = ''
        try:
            os.unlink(job['kh'])
        except OSError:
            pass


def validate_fw(x):
    g = lambda k, dflt='': str(x.get(k) or dflt).strip()
    d = {'ip': ipv4(g('ip')), 'ssh_port': g('ssh_port', '22'), 'ssh_user': 'root', 'password': str(x.get('password') or ''), 'name': g('name'),
         'admin_ip': ipv4(g('admin_ip')), 'compose': '', 'rules': []}
    errs = []
    if not d['ip']: errs.append('IP ноды')
    if not d['ssh_port'].isdigit(): errs.append('порт SSH')
    if not d['password']: errs.append('пароль root')
    if not re.fullmatch(r'[\w.\-]{1,60}', d['name']): errs.append('имя ноды')
    seen = set()
    for r in (x.get('rules') or [])[:64]:
        proto, port, frm = str(r.get('proto') or ''), str(r.get('port') or '').strip(), r.get('from')
        if proto not in ('tcp', 'udp') or not re.fullmatch(r'\d{1,5}(-\d{1,5})?', port) or any(not 0 < int(p) < 65536 for p in port.split('-')):
            errs.append(f'правило {proto} {port}'); continue
        if (proto, port) in seen:
            errs.append(f'порт {port} дважды'); continue
        seen.add((proto, port))
        if frm != 'all':
            ips = [str(i).strip() for i in (frm or []) if str(i).strip()]
            bad = [i for i in ips if not re.fullmatch(r'\d{1,3}(\.\d{1,3}){3}(/\d{1,2})?', i) or not ipv4(i.split('/')[0])]
            if bad or not ips:
                errs.append(f'IP в правиле порта {port}'); continue
            frm = ips
        d['rules'].append({'proto': proto, 'port': port, 'from': frm})
    if not any(r['proto'] == 'tcp' and r['port'] == d['ssh_port'] for r in d['rules']):
        errs.append(f"правило для SSH (порт {d['ssh_port']}) — без него потеряется доступ")
    return d, errs


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
         'compose': str(x.get('compose') or ''), 'price': g('price').replace(',', '.'), 'cur': g('cur', 'EUR'), 'stats_url': g('stats_url'), 'skip_prov': g('skip_prov') == '1'}
    m = re.search(r'NODE_PORT\s*[=:]\s*["\']?(\d{2,5})', d['compose'])
    d['node_port'] = m.group(1) if m else '2222'
    errs = []
    if not d['ip']: errs.append('IP ноды')
    if not d['ssh_port'].isdigit(): errs.append('порт SSH')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', d['ssh_user']): errs.append('пользователь SSH')
    if not d['password']: errs.append('пароль SSH')
    if not re.fullmatch(r'[\w.\-]{2,60}', d['name']): errs.append('имя ноды (буквы, цифры, точка, дефис)')
    if d['mode'] not in ('1', '2', '3'): errs.append('режим')
    if d['mode'] in ('1', '2') and not d['skip_prov'] and not DOMAIN_RE.match(d['domain']): errs.append('поддомен')
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


# ---------- разбор подписок конкурентов ----------
# Подписку (ссылку или текст) разбираем здесь, на сервере: ключи (UUID, пароли, shortId) не сохраняются и никуда не уходят,
# остаются только параметры подключения и чей это IP — ASN, хостер, страна по реестру (Team Cymru через DNS, без ключей).
COMP_FILE = os.path.join(DATA, 'competitors.json')
COMP_LOCK = threading.Lock()
ASN_CACHE = {}
SUB_UA = {'v2rayn': 'v2rayN/7.10.0', 'happ': 'Happ/2.6.0', 'hiddify': 'HiddifyNext/2.5.7', 'streisand': 'Streisand/1.6', 'clash': 'FlClashX/0.3.0 clash-verge/v2.0.0 mihomo'}
# пробник (probe/setup.sh на отдельном сервере): через него идёт всё, что касается чужих серверов — скачивание подписок,
# подключение через серверы конкурента (узнать выход), проверка доступности. TLS с самоподписанным сертификатом —
# сверяем его отпечаток (PROBE_FP), пускает только с IP панели и с токеном
PROBE_URL = os.environ.get('PROBE_URL', '').strip().rstrip('/')
PROBE_TOKEN = os.environ.get('PROBE_TOKEN', '').strip()
PROBE_FP = re.sub(r'[^0-9a-f]', '', os.environ.get('PROBE_FP', '').lower())
PROBE_HOST = urllib.parse.urlsplit(PROBE_URL).hostname or '' if PROBE_URL else ''
PROBE_INFO = {}
PROBE_PARALLEL = int(os.environ.get('PROBE_PARALLEL', '3'))     # подключений через серверы конкурентов одновременно
PROBE_GAP = float(os.environ.get('PROBE_GAP', '30'))            # пауза между проверками одного адреса, с: за проверку до 2 подключений,
                                                                 # а больше ~3 TLS-подключений к адресу за минуту ТСПУ «замораживает» — пробник мешал бы сам себе
COMP_COOLDOWN = int(os.environ.get('COMP_COOLDOWN', '900'))     # не разбирать одного конкурента чаще, с
SUB_VIA = PROBE_HOST   # с пробником подписки качаются с него, без него — с сервера панели


def probe_call(path, data=None, timeout=40):
    u = urllib.parse.urlsplit(PROBE_URL)
    ctx = ssl.create_default_context()
    ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE   # самоподписанный — проверяем по отпечатку ниже
    conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout, context=ctx)
    try:
        conn.connect()
        fp = hashlib.sha256(conn.sock.getpeercert(True)).hexdigest()
        if PROBE_FP and not hmac.compare_digest(fp, PROBE_FP):
            raise ValueError('сертификат пробника не совпал с PROBE_FP — его перевыпустили (setup.sh --new) или подмена')
        conn.request('POST' if data is not None else 'GET', path, body=json.dumps(data).encode() if data is not None else None,
                     headers={'Authorization': 'Bearer ' + PROBE_TOKEN, 'Content-Type': 'application/json'})
        r = conn.getresponse()
        raw = r.read()
        if r.status == 403:
            raise ValueError('пробник не пустил: проверьте PROBE_TOKEN и что в probe.conf указан IP этой панели')
        if r.status != 200:
            raise ValueError(f'пробник ответил HTTP {r.status}')
        return json.loads(raw)
    except (OSError, http.client.HTTPException) as e:
        raise ValueError(f'пробник {u.hostname} недоступен: {e}')
    finally:
        conn.close()


def probe_info():
    # успешный ответ запоминаем; ошибку — нет: пока пробник недоступен, проверяем при каждом открытии «Рынка»,
    # и прошлая ошибка не висит после того, как порт открыли или поправили токен
    if PROBE_URL and not PROBE_INFO.get('ip'):
        try:
            info = probe_call('/info', timeout=15)
            PROBE_INFO.clear()
            PROBE_INFO.update(info)
        except ValueError as e:
            PROBE_INFO.clear()
            PROBE_INFO['error'] = str(e)
    return PROBE_INFO


PROXY_PROTOS = ('vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'hysteria2', 'tuic', 'wireguard')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def sub_url(raw):
    """ссылку на подписку — к виду https://…, разворачивая обёртки (до 4 слоёв):
    «sub.vless.space/id» без схемы; кнопки приложений (happ://add/…, v2raytun://import/…, hiddify://import/…,
    flclashx://install-config?url=…, clash://…, sing-box://import-remote-profile?url=…); страницы-переадресации
    вида https://…/redir?url=<ссылка> — на них сами не ходим, сразу берём то, что внутри"""
    u = raw.strip().strip('<>"\'')
    for _ in range(4):
        m = re.match(r'^([a-z][a-z0-9+.-]*)://', u, re.I)
        if not m:
            return 'https://' + u.lstrip('/')
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(u).query)
        inner = next((v[0] for v in q.values() if v and re.match(r'^[a-z][a-z0-9+.-]*://', v[0].strip(), re.I)), None)
        if m.group(1).lower() in ('http', 'https'):
            if inner:   # переадресация на другую ссылку
                u = inner.strip()
                continue
            return u
        if not inner:   # happ://add/https://… — ссылка в пути, может быть закодирована
            rest = u[len(m.group(0)):]
            f = re.search(r'https?(?:://|%3A%2F%2F)[^\s#"\'<>]+', rest, re.I)
            inner = urllib.parse.unquote(f.group(0)) if f and '%3A%2F%2F' in f.group(0).upper() else f.group(0) if f else None
        if not inner:
            raise ValueError('это не ссылка на подписку, а ссылка приложения или отдельного сервера — вставьте её в поле «содержимое»')
        u = inner.strip()
    raise ValueError('слишком много вложенных ссылок')


def sub_fetch(url, ua, extra=None):
    """скачать подписку: только http(s) и только на публичные адреса — node-setup сидит в docker-сети рядом с панелью"""
    if PROBE_URL:   # с пробника: конкурент видит его адрес, панель к нему не обращается вовсе
        for _ in range(4):
            r = probe_call('/fetch', {'url': url, 'headers': {'User-Agent': ua, **(extra or {})}})
            if r.get('redirect'):
                url = sub_url(r['redirect'])
                continue
            if r.get('error'):
                raise ValueError(r['error'])
            return base64.b64decode(r['body']), r.get('headers') or {}
        raise ValueError('слишком много перенаправлений')
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(5):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ('http', 'https') or not u.hostname:
            raise ValueError('нужна ссылка http(s)://…')
        try:
            ips = {a[4][0] for a in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == 'https' else 80), proto=socket.IPPROTO_TCP)}
        except OSError:
            raise ValueError(f'домен {u.hostname} не находится в DNS')
        if not ips or any(not ipaddress.ip_address(i.split('%')[0]).is_global for i in ips):
            raise ValueError('адрес подписки не публичный — такие не открываю')
        try:
            r = opener.open(urllib.request.Request(url, headers={'User-Agent': ua, 'Accept': '*/*', **(extra or {})}), timeout=15)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308) and e.headers.get('Location'):
                loc = e.headers['Location'].strip()
                url = sub_url(loc) if re.match(r'^[a-z][a-z0-9+.-]*://', loc, re.I) and not loc.lower().startswith(('http://', 'https://')) else urllib.parse.urljoin(url, loc)
                continue
            raise ValueError(f'сервер подписки ответил HTTP {e.code}')
        except (urllib.error.URLError, OSError) as e:
            raise ValueError(f'не скачалось: {getattr(e, "reason", e)}')
        with r:
            body = r.read(3_000_001)
            if len(body) > 3_000_000:
                raise ValueError('подписка больше 3 МБ')
            return body, {k.lower(): v for k, v in r.headers.items()}
    raise ValueError('слишком много перенаправлений')


def _b64(s):
    s = re.sub(r'\s+', '', s).replace('-', '+').replace('_', '/')
    return base64.b64decode(s + '=' * (-len(s) % 4))


def _srv(proto, remark, addr, port, **kw):
    out = {'proto': proto, 'remark': str(remark or '')[:120], 'addr': str(addr or '').strip('[]')[:255], 'port': str(port or '')[:6]}
    for k, v in kw.items():
        if v not in (None, '', [], {}):
            out[k] = str(v if not isinstance(v, list) else ','.join(map(str, v)))[:200]
    return out if out['addr'] else None


def _stream(net, sec, sni=None, fp=None, pbk=None, sid=None, spx=None, alpn=None, path=None, host=None, mode=None, insecure=False):
    """streamSettings Xray по параметрам ссылки"""
    net = {'raw': 'tcp', 'splithttp': 'xhttp', 'h2': 'http'}.get((net or 'tcp').lower(), (net or 'tcp').lower())
    sec = (sec or 'none').lower()
    st = {'network': net, 'security': sec if sec in ('tls', 'reality') else 'none'}
    if st['security'] == 'reality':
        st['realitySettings'] = {k: v for k, v in {'serverName': sni, 'fingerprint': fp or 'firefox', 'publicKey': pbk, 'shortId': sid or '', 'spiderX': spx}.items() if v is not None}
    elif st['security'] == 'tls':
        st['tlsSettings'] = {k: v for k, v in {'serverName': sni, 'fingerprint': fp, 'allowInsecure': bool(insecure) or None,
                                               'alpn': [a for a in str(alpn).split(',') if a] if alpn else None}.items() if v is not None}
    if net == 'grpc':
        st['grpcSettings'] = {'serviceName': path or '', 'multiMode': mode == 'multi'}
    elif net == 'ws':
        st['wsSettings'] = {'path': path or '/', **({'headers': {'Host': host}} if host else {})}
    elif net == 'httpupgrade':
        st['httpupgradeSettings'] = {'path': path or '/', **({'host': host} if host else {})}
    elif net == 'xhttp':
        st['xhttpSettings'] = {'path': path or '/', 'mode': mode or 'auto', **({'host': host} if host else {})}
    elif net == 'http':
        st['httpSettings'] = {'path': path or '/', **({'host': [host]} if host else {})}
    return st


def _ob(proto, addr, port, user, stream):
    """outbound Xray (с ключами — только для пробника, не сохраняется)"""
    try:
        port = int(port)
    except (TypeError, ValueError):
        return None
    if proto in ('vless', 'vmess'):
        return {'protocol': proto, 'settings': {'vnext': [{'address': addr, 'port': port, 'users': [user]}]}, 'streamSettings': stream}
    if proto in ('trojan', 'shadowsocks'):
        return {'protocol': proto, 'settings': {'servers': [{'address': addr, 'port': port, **user}]}, 'streamSettings': stream}
    return None


def parse_uri(line):
    scheme, rest = line.split('://', 1)
    scheme = scheme.lower()
    if scheme == 'vmess':
        j = json.loads(_b64(rest.split('#')[0]))
        s = _srv('vmess', j.get('ps'), j.get('add'), j.get('port'), net=j.get('net'), sec=j.get('tls') or 'none', sni=j.get('sni') or j.get('host'),
                 host=j.get('host'), path=j.get('path'), fp=j.get('fp'), alpn=j.get('alpn'))
        if s and j.get('id'):
            s['_ob'] = _ob('vmess', j.get('add'), j.get('port'), {'id': j['id'], 'alterId': int(j.get('aid') or 0), 'security': j.get('scy') or 'auto'},
                           _stream(j.get('net'), j.get('tls'), j.get('sni') or j.get('host'), j.get('fp'), alpn=j.get('alpn'), path=j.get('path'), host=j.get('host')))
        return s
    u = urllib.parse.urlsplit(line)
    q = dict(urllib.parse.parse_qsl(u.query))
    remark = urllib.parse.unquote(u.fragment)
    if scheme == 'ss':
        if not u.hostname:   # ss://base64(метод:пароль@адрес:порт)
            inner = _b64(rest.split('#')[0]).decode('utf-8', 'replace')
            u = urllib.parse.urlsplit('ss://' + inner)
        method = urllib.parse.unquote(u.username or '')
        if ':' not in method:
            try:
                method = _b64(method).decode('utf-8', 'replace')
            except ValueError:
                pass
        s = _srv('shadowsocks', remark, u.hostname, u.port, method=method.split(':')[0], net=q.get('type'), plugin=q.get('plugin', '').split(';')[0])
        if s and ':' in method and not q.get('plugin'):
            m, pw = method.split(':', 1)
            if not pw and u.password:
                pw = urllib.parse.unquote(u.password)
            s['_ob'] = _ob('shadowsocks', u.hostname, u.port, {'method': m, 'password': pw}, {'network': 'tcp'})
        elif s and u.password:
            s['_ob'] = _ob('shadowsocks', u.hostname, u.port, {'method': method, 'password': urllib.parse.unquote(u.password)}, {'network': 'tcp'})
        return s
    proto = {'hy2': 'hysteria2', 'hysteria2': 'hysteria2'}.get(scheme, scheme)
    if proto not in PROXY_PROTOS:
        return None
    s = _srv(proto, remark, u.hostname, u.port, net=q.get('type') or ('udp' if proto in ('hysteria2', 'hysteria', 'tuic') else 'tcp'),
             sec=q.get('security') or ('tls' if proto in ('trojan', 'hysteria2', 'hysteria', 'tuic') else 'none'), sni=q.get('sni') or q.get('peer'),
             fp=q.get('fp'), flow=q.get('flow'), path=q.get('path') or q.get('serviceName'), host=q.get('host'), alpn=q.get('alpn'),
             mode=q.get('mode'), obfs=q.get('obfs'), spx=q.get('spx'))
    if s and proto in ('vless', 'trojan') and u.username:
        st = _stream(q.get('type'), q.get('security') or ('tls' if proto == 'trojan' else 'none'), q.get('sni') or q.get('peer') or q.get('host'), q.get('fp'),
                     q.get('pbk'), q.get('sid'), q.get('spx'), q.get('alpn'), q.get('serviceName') or q.get('path'), q.get('host'), q.get('mode'),
                     q.get('allowInsecure') in ('1', 'true'))
        cred = urllib.parse.unquote(u.username)
        user = {'id': cred, 'encryption': q.get('encryption') or 'none', **({'flow': q['flow']} if q.get('flow') else {})} if proto == 'vless' else {'password': cred}
        s['_ob'] = _ob(proto, u.hostname, u.port, user, st)
    return s


def parse_xray(cfg):
    """полный конфиг Xray (так отдают подписку Happ и др.): прокси-выходы с параметрами транспорта"""
    out, title = [], cfg.get('remarks') or ''
    obs = [o for o in cfg.get('outbounds') or [] if isinstance(o, dict) and o.get('protocol') in PROXY_PROTOS]
    for o in obs:
        st, se = o.get('streamSettings') or {}, o.get('settings') or {}
        vn = (se.get('vnext') or se.get('servers') or [{}])[0] if isinstance(se.get('vnext') or se.get('servers'), list) else se
        user = (vn.get('users') or [{}])[0] if isinstance(vn.get('users'), list) else {}
        sec = st.get('security') or 'none'
        ts = st.get('realitySettings') or st.get('tlsSettings') or {}
        net = st.get('network') or 'tcp'
        ns = st.get(f'{net}Settings') or st.get({'h2': 'httpSettings', 'splithttp': 'xhttpSettings'}.get(net, ''), {}) or {}
        hdr = (ns.get('headers') or {}) if isinstance(ns, dict) else {}
        chain = (st.get('sockopt') or {}).get('dialerProxy') or (o.get('proxySettings') or {}).get('tag')
        out.append(_srv(o['protocol'], title + (f" · {o.get('tag')}" if len(obs) > 1 and o.get('tag') else ''), vn.get('address'), vn.get('port'),
                        net=net, sec=sec, sni=ts.get('serverName'), fp=ts.get('fingerprint'), alpn=ts.get('alpn'), flow=user.get('flow'),
                        path=ns.get('path') or ns.get('serviceName') if isinstance(ns, dict) else None, host=ns.get('host') or hdr.get('Host') if isinstance(ns, dict) else None,
                        mode=ns.get('mode') if isinstance(ns, dict) else None, chain=chain, mux=1 if (o.get('mux') or {}).get('enabled') else None))
        if out[-1] and o['protocol'] in ('vless', 'vmess', 'trojan', 'shadowsocks'):
            out[-1]['_ob'] = json.loads(json.dumps(o))   # копия с ключами — только для пробника
    return out


def _yaml_scalar(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
        return v[1:-1]
    return {'true': True, 'false': False, 'null': None, '~': None}.get(v.lower(), v)


def _yaml_flow(t):
    """{a: 1, b: {c: x}, d: [p, q]} — встроенные словари и списки Clash"""
    i = 0
    def val():
        nonlocal i
        while i < len(t) and t[i] in ' \t':
            i += 1
        if i < len(t) and t[i] == '{':
            i += 1
            d = {}
            while i < len(t):
                while i < len(t) and t[i] in ' \t,':
                    i += 1
                if i < len(t) and t[i] == '}':
                    i += 1
                    return d
                k = scalar(':')
                i += 1
                d[k] = val()
            return d
        if i < len(t) and t[i] == '[':
            i += 1
            out = []
            while i < len(t):
                while i < len(t) and t[i] in ' \t,':
                    i += 1
                if i < len(t) and t[i] == ']':
                    i += 1
                    return out
                out.append(val())
            return out
        return _yaml_scalar(scalar(',}]'))
    def scalar(stops):
        nonlocal i
        while i < len(t) and t[i] in ' \t':
            i += 1
        if i < len(t) and t[i] in '"\'':
            qch, j = t[i], t.index(t[i], i + 1)
            r, i = t[i + 1:j], j + 1
            return r
        j = i
        while i < len(t) and t[i] not in stops:
            i += 1
        return t[j:i].strip()
    return val()


def _yaml_block(lines):
    """блочный словарь по отступам (то, что под «- » одного прокси): ключ: значение, вложенные словари"""
    root, stack = {}, [(-1, None)]
    stack[0] = (-1, root)
    for ind, line in lines:
        while stack and ind <= stack[-1][0]:
            stack.pop()
        cur = stack[-1][1] if stack else root
        if ':' not in line or not isinstance(cur, dict):
            continue
        k, v = line.split(':', 1)
        k, v = _yaml_scalar(k), v.strip()
        if v == '':
            cur[k] = {}
            stack.append((ind, cur[k]))
        elif v[:1] in '{[':
            cur[k] = _yaml_flow(v)
        else:
            cur[k] = _yaml_scalar(re.sub(r'\s+#.*$', '', v))
    return root


def clash_proxies(text):
    """прокси из конфига Clash/mihomo (FlClash, Clash Verge и т.п.) — без PyYAML: секция proxies, элементы списка
    в строку ({name: …}) или блоком"""
    lines = text.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if re.match(r'^proxies:\s*$', l))
    except StopIteration:
        return []
    items, cur = [], None
    for raw in lines[start + 1:]:
        if not raw.strip() or raw.lstrip().startswith('#'):
            continue
        if not raw[:1].isspace() and not raw.startswith('-'):
            break   # следующая секция верхнего уровня
        ind = len(raw) - len(raw.lstrip())
        body = raw.strip()
        if body.startswith('- '):
            if cur is not None:
                items.append(cur)
            rest = body[2:].strip()
            if rest.startswith('{'):
                items.append(_yaml_flow(rest))
                cur = None
            else:
                cur = [(ind + 2, rest)]
        elif cur is not None:
            cur.append((ind, body))
    if cur is not None:
        items.append(cur)
    out = []
    for it in items:
        d = it if isinstance(it, dict) else _yaml_block(it)
        if not isinstance(d, dict) or not d.get('server'):
            continue
        t = str(d.get('type') or '').lower()
        proto = {'ss': 'shadowsocks', 'hy2': 'hysteria2'}.get(t, t)
        if proto not in PROXY_PROTOS:
            continue
        net = str(d.get('network') or ('udp' if proto in ('hysteria2', 'hysteria', 'tuic') else 'tcp'))
        ro = d.get('reality-opts') if isinstance(d.get('reality-opts'), dict) else None
        sec = 'reality' if ro else 'tls' if d.get('tls') is True or proto in ('trojan', 'hysteria2', 'hysteria', 'tuic') else 'none'
        opts = {k: v for k, v in d.items() if k.endswith('-opts') and isinstance(v, dict)}
        path = (opts.get('grpc-opts') or {}).get('grpc-service-name') or (opts.get('ws-opts') or {}).get('path') or (opts.get('xhttp-opts') or {}).get('path') \
            or (opts.get('h2-opts') or {}).get('path') or (opts.get('http-opts') or {}).get('path')
        hdr = (opts.get('ws-opts') or {}).get('headers') or {}
        s = _srv(proto, d.get('name'), d.get('server'), d.get('port'), net=net, sec=sec, sni=d.get('servername') or d.get('sni'),
                 fp=d.get('client-fingerprint'), flow=d.get('flow'), path=path if not isinstance(path, list) else ','.join(map(str, path)),
                 host=hdr.get('Host') if isinstance(hdr, dict) else None, alpn=d.get('alpn'), method=d.get('cipher') if proto == 'shadowsocks' else None)
        if s:
            st = _stream(net, sec, d.get('servername') or d.get('sni'), d.get('client-fingerprint'), (ro or {}).get('public-key'), (ro or {}).get('short-id'),
                         alpn=','.join(d['alpn']) if isinstance(d.get('alpn'), list) else d.get('alpn'), path=s.get('path'), host=s.get('host'),
                         insecure=d.get('skip-cert-verify') is True)
            user = ({'id': d.get('uuid'), 'encryption': 'none', **({'flow': d['flow']} if d.get('flow') else {})} if proto == 'vless'
                    else {'id': d.get('uuid'), 'alterId': int(d.get('alterId') or 0), 'security': d.get('cipher') or 'auto'} if proto == 'vmess'
                    else {'password': d.get('password')} if proto == 'trojan' else {'method': d.get('cipher'), 'password': d.get('password')})
            if all(v not in (None, '') for v in user.values()):
                s['_ob'] = _ob(proto, d.get('server'), d.get('port'), user, st if proto != 'shadowsocks' else {'network': 'tcp'})
        out.append(s)
    return [x for x in out if x]


def parse_sub(body):
    text = body.decode('utf-8', 'replace').strip().lstrip('﻿')
    if text[:1] in '[{':
        try:
            j = json.loads(text)
            cfgs = j if isinstance(j, list) else [j]
            return [s for c in cfgs if isinstance(c, dict) for s in parse_xray(c) if s]
        except ValueError:
            pass
    if '://' not in text[:300]:
        try:
            text = _b64(text).decode('utf-8', 'replace')
        except ValueError:
            pass
    if re.search(r'^proxies:\s*$', text, re.M):   # конфиг Clash/mihomo (FlClash, Clash Verge…)
        out = clash_proxies(text)
        if not out:
            raise ValueError('конфиг Clash без серверов, которые я умею разбирать — попробуйте другой клиент в «Ещё → приложение»')
        return out
    out = []
    if re.search(r'<html|<!doctype', text[:2000], re.I):   # веб-страница подписки: ссылки серверов бывают прямо в ней
        text = '\n'.join(urllib.parse.unquote(m) if '%3A%2F%2F' in m.upper() else m
                          for m in re.findall(r'(?:vless|vmess|trojan|ss|hy2|hysteria2|tuic)://[^\s"\'<>]+', html_unescape(text)))
        if not text:
            raise ValueError('по ссылке веб-страница, а не подписка — выберите другой клиент в «Как представиться» (сервис отдаёт подписку только приложениям)')
    for line in text.splitlines():
        line = line.strip()
        if '://' in line:
            try:
                s = parse_uri(line)
            except (ValueError, KeyError, IndexError, UnicodeError):
                s = None
            if s:
                out.append(s)
    return out


def _resolver():
    try:
        with open('/etc/resolv.conf', encoding='utf-8') as f:
            for line in f:
                if line.startswith('nameserver'):
                    return line.split()[1]
    except OSError:
        pass
    return '1.1.1.1'


def asn_of(ip):
    """ASN, хостер и страна по реестру — Team Cymru через DNS TXT; кэш на время жизни сервиса"""
    if ip in ASN_CACHE:
        return ASN_CACHE[ip]
    info = {}
    try:
        a = ipaddress.ip_address(ip)
        if a.version == 4 and a.is_global:
            srv = _resolver()
            txt = dns_query('.'.join(reversed(ip.split('.'))) + '.origin.asn.cymru.com', srv, 16) or dns_query('.'.join(reversed(ip.split('.'))) + '.origin.asn.cymru.com', '1.1.1.1', 16) or []
            if txt:
                f = [x.strip() for x in txt[0].split('|')]
                asn = f[0].split()[0]
                info = {'asn': asn, 'prefix': f[1] if len(f) > 1 else '', 'cc': f[2] if len(f) > 2 else ''}
                nm = dns_query(f'AS{asn}.asn.cymru.com', srv, 16) or dns_query(f'AS{asn}.asn.cymru.com', '1.1.1.1', 16) or []
                if nm:
                    name = nm[0].split('|')[-1].strip()
                    info['as_name'] = name
                    org = name.split(' - ', 1)[1] if ' - ' in name else name
                    info['hoster'] = re.sub(r',\s*[A-Z]{2}$', '', org).strip()[:80]
    except (ValueError, OSError, IndexError):
        pass
    if info:
        ASN_CACHE[ip] = info
    return info


def enrich(servers):
    def one(s):
        ip = s['addr'] if re.fullmatch(r'[0-9.]+', s['addr']) else ''
        if not ip:
            try:
                ip = sorted({a[4][0] for a in socket.getaddrinfo(s['addr'], None, socket.AF_INET)})[0]
            except (OSError, IndexError, UnicodeError):
                ip = ''
        s['ip'] = ip
        if ip:
            s.update(asn_of(ip))
        return s
    with ThreadPoolExecutor(16) as ex:
        return list(ex.map(one, servers))


def comp_load():
    try:
        with open(COMP_FILE, encoding='utf-8') as f:
            items = json.load(f)
    except (OSError, ValueError):
        return []
    for e in items:   # пробив дольше 15 минут прервался (node-setup перезапускали) — не «пробиваю…» навсегда
        p = e.get('probe') or {}
        if p.get('running') and time.time() - p.get('started', 0) > 900:
            e['probe'] = {'at': p.get('started', 0), 'done': True, 'failed': 'пробив прервался (node-setup перезапускали?) — нажмите «Обновить»'}
    return items


def comp_save(items):
    tmp = COMP_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(items, f, ensure_ascii=False)
    os.replace(tmp, COMP_FILE)


def hwid_for(url, name):
    """как настоящее приложение: идентификатор устройства постоянный для ссылки — не занимаем новые устройства подписки"""
    return {'x-hwid': hashlib.sha256(('sepia-comp:' + (sub_url(url) if url else name)).encode()).hexdigest()[:16],
            'x-device-os': 'Android', 'x-ver-os': '14', 'x-device-model': 'Pixel 7'}


def comp_probe_one(x):
    """пробить выбранные серверы одного конкурента: заново берём подписку (ключи — только в памяти), пробиваем только их.
    Остальной разбор, история и «изменения» не трогаются"""
    if not PROBE_URL:
        raise ValueError('нужен пробник (probe/setup.sh)')
    name = str(x.get('name') or '')
    keys = {tuple(map(str, k)) for k in (x.get('keys') or [])[:40] if isinstance(k, list) and len(k) == 4}
    e = next((it for it in comp_load() if it.get('name') == name), None)
    if not e:
        raise ValueError('нет такого разбора')
    if not e.get('url'):
        raise ValueError('ссылка этого конкурента не запоминалась — вставьте её заново с «Запомнить ссылку»')
    k4 = lambda sv: (str(sv['proto']), str(sv['addr']), str(sv['port']), str(sv.get('net') or ''))
    idx = [i for i, sv in enumerate(e['servers']) if not sv.get('gone_at') and k4(sv) in keys]
    if not idx:
        raise ValueError('этих серверов нет в разборе — нажмите «Обновить»')
    if any(time.time() - e['servers'][i].get('probe1_at', 0) < 60 for i in idx):
        raise ValueError('этот сервер только что пробивали — подождите минуту')
    body, _ = sub_fetch(e['url'], SUB_UA.get(e.get('ua') or 'v2rayn', SUB_UA['v2rayn']), hwid_for(e['url'], name))
    fresh = {k4(sv): sv.get('_ob') for sv in parse_sub(body)}
    obs = [(i, fresh.get(k4(e['servers'][i]))) for i in idx]
    with COMP_LOCK:
        items = comp_load()
        ent = next((it for it in items if it.get('name') == name and it.get('at') == e['at']), None)
        if ent:
            for i, o in obs:
                sv = ent['servers'][i]
                sv['probe1_at'] = int(time.time())
                if o:
                    sv['probing'] = True
                else:
                    sv['exit_err'] = 'в подписке этого сервера больше нет или его не пробить (UDP)'
            comp_save(items)
    threading.Thread(target=probe_one_job, args=(name, e['at'], [(i, o) for i, o in obs if o]), daemon=True).start()
    return {'started': len([1 for _, o in obs if o])}


def probe_extra(sv, r):
    """что ещё принёс пробник: сколько КБ прошло через туннель (меньше 256 — обрыв, похоже на «заморозку»)
    и подключился ли сервер только с другим отпечатком"""
    b = (r or {}).get('bulk')
    if r and r.get('exits') and isinstance(b, dict) and b.get('bytes') is not None:
        sv['bulk_kb'] = int(b['bytes']) // 1024
    elif r and r.get('exits'):
        sv.pop('bulk_kb', None)
    if r and r.get('fp_alt'):
        sv['fp_alt'], sv['fp_first'] = r['fp_alt'], r.get('fp_first') or ''
    elif r:
        sv.pop('fp_alt', None); sv.pop('fp_first', None)


def probe_one_job(name, at, obs):
    res = {}
    try:
        for n, (i, o) in enumerate(obs):
            if n:
                time.sleep(PROBE_GAP)
            try:
                res[i] = probe_call('/exit', {'outbound': o, 'tries': 2}, timeout=90)
            except ValueError as e:
                res[i] = {'error': str(e)}
    finally:
        del obs
        with COMP_LOCK:
            items = comp_load()
            ent = next((it for it in items if it.get('name') == name and it.get('at') == at), None)
            if not ent:
                return
            ips = {x['ip'] for r in res.values() for x in r.get('exits', [])}
            reg = {ip: asn_of(ip) for ip in ips}
            done = []
            for i, sv in enumerate(ent['servers']):
                if not sv.pop('probing', None):
                    continue
                r = res.get(i)
                if r and r.get('exits'):
                    sv['exits'] = [{'ip': x['ip'], 'cc': x.get('cc') or reg.get(x['ip'], {}).get('cc', ''),
                                    **{k: reg[x['ip']][k] for k in ('asn', 'hoster', 'as_name') if reg.get(x['ip'], {}).get(k)}} for x in r['exits']]
                    sv.pop('exit_err', None)
                else:
                    sv['exit_err'] = str((r or {}).get('error') or 'пробив прервался')[:200]
                probe_extra(sv, r)
                sv.pop('vpn_fail', None)
                if (r or {}).get('vpn_fail'):
                    sv['vpn_fail'] = True
                if (r or {}).get('tcp'):
                    set_reach(sv, r['tcp'])
                sv['probe1_done'] = int(time.time())
                done.append(sv)
            comp_save(items)
        if done:
            kb_update(name, done, int(time.time()), ())


def comp_add(x):
    name = re.sub(r'\s+', ' ', str(x.get('name') or '')).strip()[:60]
    prev = next((e for e in comp_load() if e.get('name') == name), None) if name else None
    pp = (prev or {}).get('probe') or {}
    if prev and time.time() - prev.get('at', 0) < COMP_COOLDOWN and prev.get('via') != 'text' and not pp.get('failed') and not pp.get('running'):
        left = int((COMP_COOLDOWN - (time.time() - prev['at'])) // 60) + 1
        raise ValueError(f'«{name}» разбирали только что — следующий раз через {left} мин (чтобы не нагружать их серверы)')
    if x.get('refresh'):   # «Обновить»: та же ссылка и тот же клиент, что запомнили при разборе
        if not prev or not prev.get('url'):
            raise ValueError('ссылка не запоминалась — вставьте её заново')
        x = {**x, 'url': prev['url'], 'ua': prev.get('ua'), 'remember': True}
    ua = SUB_UA.get(str(x.get('ua') or 'v2rayn'), SUB_UA['v2rayn'])
    url, text, title = str(x.get('url') or '').strip(), str(x.get('text') or ''), ''
    if url and re.match(r'^(vless|vmess|trojan|ss|hy2|hysteria2?|tuic)://', url, re.I):   # вставили один сервер, а не подписку
        url, text = '', url + '\n' + text
    # как настоящее приложение: с лимитом устройств (HWID) Remnawave без x-hwid отдаёт пустую подписку или заглушку.
    # Идентификатор постоянный для ссылки (или названия) — повторный разбор не занимает у тестовой подписки новое устройство
    hwid = hwid_for(url, name)
    if url:
        url = sub_url(url)
        try:
            body, hdr = sub_fetch(url, ua, hwid)
        except ValueError:
            if not url.startswith('https://') or x.get('url', '').strip().lower().startswith('https://'):
                raise
            url = 'http://' + url[8:]   # без схемы и https не открылся — пробуем http (и запоминаем рабочую)
            body, hdr = sub_fetch(url, ua, hwid)
        t = hdr.get('profile-title', '')
        if t.startswith('base64:'):
            try:
                t = _b64(t[7:]).decode('utf-8', 'replace')
            except ValueError:
                t = ''
        title = t[:80]
    elif text.strip():
        body = text.encode('utf-8')
    else:
        raise ValueError('вставьте ссылку на подписку или её содержимое')
    head = body[:300].decode('utf-8', 'replace')
    if re.search(r'happ://crypt', head):
        raise ValueError('подписка зашифрована под Happ (happ://crypt…) — её расшифровывает только само приложение')
    servers = parse_sub(body)
    seen, uniq = set(), []
    for s in servers:
        k = (s['proto'], s['addr'], s['port'], s.get('net'), s.get('sni'))
        if k not in seen:
            seen.add(k)
            uniq.append(s)
    real = [sv for sv in uniq if not is_junk(sv)]   # «продлите подписку», 0.0.0.0 и т.п. — не серверы
    if prev and not real:
        with COMP_LOCK:
            items = comp_load()
            for e in items:
                if e.get('name') == name:
                    e['expired_at'] = int(time.time())
            comp_save(items)
        raise ValueError('подписка, похоже, закончилась — сервис отдал заглушку. Прошлый разбор и вся история сохранены')
    if uniq and not real:
        raise ValueError('в подписке одни заглушки («продлите», «истекла», 0.0.0.0) — похоже, она уже закончилась')
    uniq = real
    if not uniq:
        raise ValueError('серверов не нашлось — попробуйте другой клиент в «Как представиться» или вставьте содержимое подписки')
    if not name:   # название не вписали — из подписки (profile-title) или по домену ссылки
        name = (title or (urllib.parse.urlsplit(url).hostname if url else '') or 'Без названия').strip()[:60]
        prev = next((e for e in comp_load() if e.get('name') == name), None)
    uniq = uniq[:300]
    obs = [(i, sv.pop('_ob', None)) for i, sv in enumerate(uniq)]   # рабочие конфиги с ключами — только в память, до пробника
    for sv in servers:
        sv.pop('_ob', None)
    entry = {'name': name, 'title': title, 'at': int(time.time()), 'ua': str(x.get('ua') or 'v2rayn'), 'via': (SUB_VIA if url else 'text'),
             'servers': enrich(uniq)}
    if PROBE_URL and prev and prev.get('probe', {}).get('done') and time.time() - prev['probe'].get('at', 0) < 86400:
        pk = lambda sv: (sv['proto'], sv['addr'], sv['port'], sv.get('net'), sv.get('sni'), sv.get('path'))
        old = {pk(sv): sv for sv in prev.get('servers', []) if sv.get('exits') or sv.get('exit_err')}
        for i, sv in enumerate(entry['servers']):
            o = old.get(pk(sv))
            if o:
                sv.update({k: o[k] for k in ('exits', 'exit_err', 'bulk_kb', 'fp_alt', 'fp_first') if o.get(k) is not None and o.get(k) != ''})
                obs[i] = (i, None)   # уже знаем — не подключаемся снова
    if PROBE_URL:   # пробить выходы и доступность — в фоне, результат допишется в этот же разбор
        entry['probe'] = {'running': True, 'total': sum(1 for _, o in obs if o), 'started': int(time.time())}
    if url:   # ссылку храним всегда — для «Обновить» и точечного пробива; в браузер она не уходит
        entry['url'] = url
    if prev:   # что изменилось с прошлого разбора: серверы и их IP
        key = lambda s: (s['proto'], s['addr'], s['port'], s.get('net'))
        old, new = {key(s): s for s in prev.get('servers', []) if not s.get('gone_at')}, {key(s): s for s in entry['servers']}
        entry['diff'] = {'prev_at': prev.get('at'), 'added': [new[k]['remark'] or new[k]['addr'] for k in new if k not in old],
                         'removed': [old[k]['remark'] or old[k]['addr'] for k in old if k not in new],
                         'ip': [f"{new[k]['remark'] or new[k]['addr']}: {old[k].get('ip')} → {new[k].get('ip')}" for k in new
                                if k in old and old[k].get('ip') and new[k].get('ip') and old[k]['ip'] != new[k]['ip']]}
    current = list(entry['servers'])
    if prev:   # «Обновить» ничего не стирает: пропавшие серверы остаются в карточке серыми, «ушёл <дата>», 90 дней
        nk = {(sv['proto'], sv['addr'], sv['port'], sv.get('net')) for sv in current}
        for p in prev.get('servers', []):
            if (p['proto'], p['addr'], p['port'], p.get('net')) in nk:
                continue
            ga = p.get('gone_at') or entry['at']
            if entry['at'] - ga < 90 * 86400:
                entry['servers'].append({**p, 'gone_at': ga})
    with COMP_LOCK:
        items = [e for e in comp_load() if e.get('name') != name] + [entry]
        comp_save(items)
    kb_update(name, current, entry['at'], ('вход',))   # выходы сверим после пробива
    d = entry.get('diff') or {}
    hist_add({'name': name, 'at': entry['at'], 'servers': len(current), 'ips': len({sv.get('ip') for sv in current if sv.get('ip')}),
              'added': len(d.get('added', [])), 'removed': len(d.get('removed', [])), 'ipchg': len(d.get('ip', [])), 'first': not prev})
    if PROBE_URL:
        threading.Thread(target=probe_job, args=(name, entry['at'], obs), daemon=True).start()
    return entry


# ---------- пробив выходов и досье на адреса ----------
def probe_job(name, at, obs):
    """фоновое задание: при любой ошибке отмечаем пробив как неудачный — иначе в разборе навсегда «пробиваю…»"""
    try:
        _probe_job(name, at, obs)
    except Exception as e:   # noqa: BLE001 — поток в фоне: ошибку некому показать, кроме самого разбора
        print(f'node-setup: пробив «{name}» упал: {e!r}', flush=True)
        with COMP_LOCK:
            items = comp_load()
            ent = next((x for x in items if x.get('name') == name and x.get('at') == at), None)
            if ent and not ent.get('probe', {}).get('done'):
                ent['probe'] = {'at': int(time.time()), 'done': True, 'failed': f'{type(e).__name__}: {e}'[:200]}
                comp_save(items)


def set_reach(sv, r):
    """доступность входа — только с пробника: панель к чужим серверам сама не подключается"""
    if r is None:
        return
    r = r if isinstance(r, dict) else {'st': r}   # старый агент отвечал строкой
    sv['reach'] = r.get('st')
    if r.get('ms') is not None:
        sv['tcp_ms'] = r['ms']
    else:
        sv.pop('tcp_ms', None)
    sv.pop('reach_out', None)   # из прошлых версий, где панель проверяла сама


def _probe_job(name, at, obs):
    """через пробник: каждый сервер конкурента — как клиент, «какой у меня IP» → выход; плюс доступность входов с пробника.
    Ключи (obs) живут только здесь, в памяти потока"""
    info = probe_info()
    todo = [(i, o) for i, o in obs if o]
    res = {}

    locks, last, guard = {}, {}, threading.Lock()

    def host(o):
        se = o.get('settings') or {}
        v = se.get('vnext') or se.get('servers') or [se]
        return str((v[0] if isinstance(v, list) and v else {}).get('address', ''))

    def one(io):
        i, o = io
        h = host(o)
        with guard:
            lk = locks.setdefault(h, threading.Lock())
        with lk:   # один вход — одно подключение за раз, с паузой: мост не получает пачку соединений сразу
            wait = last.get(h, 0) + PROBE_GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            try:
                r = probe_call('/exit', {'outbound': o, 'tries': 2}, timeout=90)
            except ValueError as e:
                r = {'error': str(e)}
            last[h] = time.time()
        save_one(i, r)
        return i, r

    def save_one(i, r):   # сразу в разбор: видно, что пробив идёт, и сделанное не теряется, если его прервут
        with COMP_LOCK:
            items = comp_load()
            ent = next((x for x in items if x.get('name') == name and x.get('at') == at), None)
            if not ent or i >= len(ent['servers']):
                return
            sv = ent['servers'][i]
            if r.get('exits'):
                sv['exits'] = [{'ip': x['ip'], 'cc': x.get('cc', '')} for x in r['exits']]
                sv.pop('exit_err', None)
            else:
                sv['exit_err'] = str(r.get('error') or 'не подключилось')[:200]
            probe_extra(sv, r)
            pr = ent.get('probe') or {}
            pr['progress'] = pr.get('progress', 0) + 1
            ent['probe'] = pr
            comp_save(items)
    # вперемешку по адресам: параллельно идут разные входы, а не один и тот же
    by = {}
    for io in todo:
        by.setdefault(host(io[1]), []).append(io)
    qs, mixed = list(by.values()), []
    while any(qs):
        for q in qs:
            if q:
                mixed.append(q.pop(0))
    with ThreadPoolExecutor(PROBE_PARALLEL) as ex:
        for i, r in ex.map(one, mixed):
            res[i] = r
    del obs, todo   # ключи больше не нужны
    with COMP_LOCK:
        cur = next((e for e in comp_load() if e.get('name') == name and e.get('at') == at), None)
    if not cur:
        return
    ips = {x['ip'] for r in res.values() for x in r.get('exits', []) if x.get('ip')}
    with ThreadPoolExecutor(16) as ex:
        reg = dict(zip(ips, ex.map(asn_of, ips)))
    tcp_t = [[sv['ip'], sv['port']] for sv in cur['servers'] if sv.get('ip') and not sv.get('gone_at') and str(sv.get('port', '')).isdigit() and sv.get('net') != 'udp'
             and not sv['proto'].startswith(('hysteria', 'tuic'))]
    try:
        reach = probe_call('/tcp', {'targets': tcp_t[:400]}, timeout=60) if tcp_t else {}
    except ValueError:
        reach = {}
    with COMP_LOCK:
        items = comp_load()
        e = next((x for x in items if x.get('name') == name and x.get('at') == at), None)
        if not e:
            return
        for i, sv in enumerate(e['servers']):
            if sv.get('gone_at'):
                continue
            r = res.get(i)
            if r is None:
                if sv['proto'].startswith(('hysteria', 'tuic')) or sv.get('net') == 'udp':
                    sv['exit_err'] = 'UDP-протокол — выход пока не пробиваем'
            elif r.get('exits'):
                seen, out = set(), []
                for x in r['exits']:
                    if x['ip'] in seen:
                        continue
                    seen.add(x['ip'])
                    g = reg.get(x['ip'], {})
                    out.append({'ip': x['ip'], 'cc': x.get('cc') or g.get('cc', ''), **{k: g[k] for k in ('asn', 'hoster', 'as_name') if g.get(k)}})
                sv['exits'] = out
            else:
                sv['exit_err'] = str(r.get('error') or 'не подключилось')[:200]
                if r.get('vpn_fail'):
                    sv['vpn_fail'] = True
            probe_extra(sv, r)
            if r and r.get('tcp'):
                reach.setdefault(f"{sv.get('ip')}:{sv.get('port')}", r['tcp'])
            set_reach(sv, reach.get(f"{sv.get('ip')}:{sv.get('port')}"))
        e['probe'] = {'at': int(time.time()), 'done': True, 'total': len(res), 'from': {'ip': info.get('ip', ''), 'cc': info.get('cc', '')}}
        comp_save(items)
        servers_now = [sv for sv in e['servers'] if not sv.get('gone_at')]
    kb_update(name, servers_now, at, ('выход',) if res else ())
    # досье на все адреса (входы и выходы) — для «Локаций-кандидатов»; кэш на неделю, без спешки
    all_ips = sorted({sv['ip'] for sv in cur['servers'] if sv.get('ip')} | ips)[:250]
    with ThreadPoolExecutor(2) as ex:   # RIPEstat просит не больше 8 одновременно — держим 2 и паузу
        list(ex.map(lambda ip: (time.sleep(0.3), dossier_safe(ip))[1], all_ips))


DOSSIER_FILE = os.path.join(DATA, 'dossier.json')
DOSSIER_LOCK = threading.Lock()


def ripe(kind, ip):
    """RIPEstat (публичный, без ключей): whois, prefix-overview — о любом адресе, не только из зоны RIPE"""
    req = urllib.request.Request(f'https://stat.ripe.net/data/{kind}/data.json?resource={urllib.parse.quote(ip)}&sourceapp=sepia-dashboard',
                                 headers={'User-Agent': 'sepia-dashboard'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get('data') or {}


def _dossier_cache():
    try:
        with open(DOSSIER_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def real_hoster(d):
    """фактический хостер: организация или описание блока, если это не владелец сети (маленький хостер на сети OVH и т.п.)"""
    holder = ' '.join([d.get('as_name') or '', d.get('hoster') or ''] + [a.get('holder', '') for a in d.get('announced') or []]).lower()
    hw = set(re.findall(r'[a-z0-9]{2,}', holder))
    for cand in (d.get('org'), d.get('descr'), d.get('netname')):
        if not cand:
            continue
        # описание блока бывает адресом («450028 Russia Ufa, …») или городом («Helsinki, Finland») — это не хостер
        if ',' in cand or re.search(r'\d{4,}', cand):
            continue
        first = (re.findall(r'[a-z0-9]{2,}', cand.lower()) or [''])[0]
        if not first:
            continue
        # блок самой сети, если название начинается так же: «hetzner-fsn» у Hetzner (4 буквы), «u1host-fra» у U1 Digital
        # (u1ds: 2 знака с цифрой)
        same = (first in hw or first in holder.replace(' ', '')
                or any(len(first) >= 4 and len(w) >= 4 and w[:4] == first[:4] for w in hw)
                or any(w[:2] == first[:2] and re.search(r'\d', first[:2]) for w in hw))
        if not same:
            return cand[:80]
    return ''


def dossier(ip, fresh=False):
    """кто реально стоит за адресом: блок по реестру (диапазон, netname, организация), кем анонсирован префикс, PTR"""
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        raise ValueError('нужен IP-адрес')
    with DOSSIER_LOCK:
        c = _dossier_cache().get(ip)
    if c and not fresh and time.time() - c.get('at', 0) < 7 * 86400:
        c['real'] = real_hoster(c)
        return c
    d = {'ip': ip, 'at': int(time.time()), **asn_of(ip)}
    try:
        po = ripe('prefix-overview', ip)
        d['prefix'] = po.get('resource') or ''
        d['announced'] = [{'asn': str(a.get('asn')), 'holder': a.get('holder', '')} for a in po.get('asns') or []][:4]
    except (OSError, ValueError):
        pass
    try:
        recs = ripe('whois', ip).get('records') or []
        inet, org = {}, ''
        for rec in recs:
            kv = {}
            for f in rec:
                kv.setdefault(str(f.get('key', '')).lower(), []).append(str(f.get('value', '')))
            if not inet and any(k in kv for k in ('inetnum', 'netrange', 'inet6num', 'cidr')):
                inet = kv
            for k in ('org-name', 'orgname', 'owner'):
                if kv.get(k) and not org:
                    org = kv[k][0]
        if inet:
            d['range'] = (inet.get('inetnum') or inet.get('netrange') or inet.get('inet6num') or inet.get('cidr') or [''])[0]
            d['netname'] = (inet.get('netname') or [''])[0]
            d['descr'] = ' / '.join(inet.get('descr', [])[:2])
            d['country'] = (inet.get('country') or [''])[0]
        if org:
            d['org'] = org
    except (OSError, ValueError):
        pass
    try:
        if ipaddress.ip_address(ip).version == 4:
            ptr = dns_query('.'.join(reversed(ip.split('.'))) + '.in-addr.arpa', _resolver(), 12)
            if ptr:
                d['ptr'] = ptr[0].rstrip('.')
    except (OSError, ValueError):
        pass
    d['real'] = real_hoster(d)
    with DOSSIER_LOCK:
        cache = _dossier_cache()
        cache[ip] = d
        tmp = DOSSIER_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, DOSSIER_FILE)
    return d


def dossier_safe(ip):
    try:
        return dossier(ip)
    except (ValueError, OSError):
        return {}


def dossiers_of(ips):
    cache = _dossier_cache()
    out = {ip: cache[ip] for ip in ips if ip in cache}
    for d in out.values():
        d['real'] = real_hoster(d)   # правило могло уточниться — пересчитываем и у старых записей
    return out

# ---------- память: база адресов и история разборов ----------
# Тестовые подписки кончаются, а знания нужны дальше: каждый IP, который мы видели, хранится навсегда — когда впервые и
# последний раз видели, у кого, вход или выход, хостер, доступность; пропал из подписки — «ушёл» (забанили или сменили).
# Из этого — срок жизни адресов по хостерам. Ключей здесь нет — только адреса.
KB_FILE = os.path.join(DATA, 'comp_ips.json')
HIST_FILE = os.path.join(DATA, 'comp_history.json')
KB_LOCK = threading.Lock()


def _jload(path, default):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _jsave(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def kb_update(name, servers, at, reconcile):
    """записать адреса разбора; reconcile — какие роли сверять: чего из них больше нет у этого конкурента — «ушёл»"""
    with KB_LOCK:
        kb = _jload(KB_FILE, {})
        now = set()
        for sv in servers:
            pairs = [(sv.get('ip'), 'вход', sv)] + [(x.get('ip'), 'выход', x) for x in sv.get('exits') or [] if x.get('ip') != sv.get('ip')]
            for ip, role, src in pairs:
                if not ip:
                    continue
                r = kb.setdefault(ip, {'first': at, 'who': {}})
                w = r['who'].setdefault(name, {'first': at, 'role': role})
                w['last'] = at
                w.pop('gone', None)
                if role == 'вход':
                    w['role'] = 'вход'
                r['last'] = at
                r.pop('gone', None)
                for k in ('hoster', 'as_name', 'asn', 'cc'):
                    if src.get(k):
                        r[k] = src[k]
                rm = remark_clean(sv.get('remark', ''))
                if rm and rm not in r.setdefault('remarks', []) and len(r['remarks']) < 6:
                    r['remarks'].append(rm)
                if role == 'вход' and sv.get('reach'):
                    r['reach'], r['reach_at'] = sv['reach'], at
                now.add((ip, role))
        for ip, r in kb.items():
            w = r['who'].get(name)
            if w and w.get('role') in reconcile and (ip, w['role']) not in now and not w.get('gone'):
                w['gone'] = at
            if r['who'] and all(x.get('gone') for x in r['who'].values()):
                r['gone'] = max(x['gone'] for x in r['who'].values())
        _jsave(KB_FILE, kb)


def remark_clean(r):
    return re.sub(r'^(?:\s*(?:[\U0001F1E6-\U0001F1FF]{2}|[A-Z]{2}\b)\s*)+', '', str(r or '')).strip()[:60]


def hist_add(row):
    with KB_LOCK:
        h = _jload(HIST_FILE, [])
        h.append(row)
        _jsave(HIST_FILE, h[-3000:])


def kb_summary():
    """срок жизни адресов по хостерам и лента изменений — для «Рынка»"""
    kb, now = _jload(KB_FILE, {}), time.time()
    dos = _dossier_cache()
    by = {}
    for ip, r in kb.items():
        d = dos.get(ip) or {}
        h = real_hoster(d) or r.get('hoster') or d.get('hoster') or r.get('as_name') or ('AS' + r['asn'] if r.get('asn') else 'неизвестный хостер')
        g = by.setdefault(h, {'hoster': h, 'asn': r.get('asn') or d.get('asn', ''), 'cc': r.get('cc') or d.get('cc', ''), 'ips': 0, 'gone': 0, 'alive': 0,
                              'life': [], 'age': [], 'who': set(), 'entries': 0, 'exits': 0})
        g['ips'] += 1
        g['who'].update(r['who'].keys())
        if any(w.get('role') == 'вход' for w in r['who'].values()):
            g['entries'] += 1
        else:
            g['exits'] += 1
        if r.get('gone'):
            g['gone'] += 1
            g['life'].append((r['gone'] - r['first']) / 86400)
        else:
            g['alive'] += 1
            g['age'].append((now - r['first']) / 86400)
    med = lambda v: round(sorted(v)[len(v) // 2], 1) if v else None
    rows = [{**{k: v for k, v in g.items() if k not in ('life', 'age', 'who')}, 'who': sorted(g['who']), 'life_med': med(g['life']), 'age_med': med(g['age'])}
            for g in by.values()]
    rows.sort(key=lambda g: (-len(g['who']), -g['ips']))
    firsts = [r['first'] for r in kb.values()]
    return {'ips': len(kb), 'gone': sum(1 for r in kb.values() if r.get('gone')), 'since': min(firsts) if firsts else None,
            'hosters': rows[:60], 'history': _jload(HIST_FILE, [])[-60:][::-1]}


def is_junk(sv):
    """не сервер, а заглушка: подписка кончилась или скоро кончится — «Продлите подписку», «Истекла», адрес 0.0.0.0 и т.п."""
    return bool(re.match(r'^(0\.|127\.|10\.|192\.168\.|169\.254\.|localhost$)', sv.get('addr', ''))
                or re.search(r'истек|истёк|законч|expired|продл|оплат|renew|не\s*актив|inactive|осталось\s*\d|дн(я|ей)\s*до|subscription', sv.get('remark', ''), re.I))



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
        n = min(int(self.headers.get('Content-Length') or 0), 2_000_000 if self.path == '/comp/add' else 65536)
        raw = self.rfile.read(n)
        if self.path.startswith('/comp/'):
            try:
                x = json.loads(raw or b'{}')
                assert isinstance(x, dict)
            except (ValueError, AssertionError):
                return self.reply(400, {'error': 'не JSON'})
            try:
                if self.path in ('/comp/add', '/comp/refresh'):
                    try:
                        e = comp_add({**x, 'refresh': self.path == '/comp/refresh'})
                    except ValueError as err:
                        if self.path == '/comp/refresh' and 'разбирали только что' not in str(err):
                            with COMP_LOCK:
                                items = comp_load()
                                for it in items:
                                    if it.get('name') == x.get('name'):
                                        it['fail'] = {'at': int(time.time()), 'error': str(err)[:200]}
                                comp_save(items)
                        raise
                    return self.reply(200, {k: v for k, v in e.items() if k != 'url'} | {'refresh': bool(e.get('url'))})
                if self.path == '/comp/list':   # via — через какую ноду сейчас качаются подписки ('' — напрямую с панели)
                    items = comp_load()
                    ips = {sv.get('ip') for e in items for sv in e.get('servers', []) if sv.get('ip')} | \
                          {x['ip'] for e in items for sv in e.get('servers', []) for x in sv.get('exits', [])}
                    return self.reply(200, {'items': [{k: v for k, v in e.items() if k != 'url'} | {'refresh': bool(e.get('url'))} for e in items],
                                            'via': SUB_VIA, 'probe': {'on': bool(PROBE_URL), **{k: v for k, v in probe_info().items() if k in ('ip', 'cc', 'error')}},
                                            'dossiers': dossiers_of(ips), 'kb': kb_summary()})
                if self.path == '/comp/dossier':
                    ip = str(x.get('ip') or '').strip()
                    return self.reply(200, {**dossier(ip, bool(x.get('fresh'))), 'kb': _jload(KB_FILE, {}).get(ip)})
                if self.path == '/comp/probe-one':
                    return self.reply(200, comp_probe_one(x))
                if self.path == '/comp/delete':
                    with COMP_LOCK:
                        comp_save([e for e in comp_load() if e.get('name') != str(x.get('name') or '')])
                    return self.reply(204)
                if self.path == '/comp/asn':   # наши ноды — для сравнения «у нас тоже этот хостер»
                    ips = [i for i in (x.get('ips') or []) if isinstance(i, str) and re.fullmatch(r'[0-9.]{7,15}', i)][:200]
                    with ThreadPoolExecutor(16) as ex:
                        return self.reply(200, dict(zip(ips, ex.map(asn_of, ips))))
            except ValueError as e:
                return self.reply(400, {'error': str(e)})
            return self.reply(404)
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
        if self.path in ('/fw', '/probe'):
            try:
                x = json.loads(raw or b'{}')
                assert isinstance(x, dict)
            except (ValueError, AssertionError):
                return self.reply(400, {'error': 'не JSON'})
            if self.path == '/probe':
                ip = ipv4(x.get('ip'))
                ports = [{'proto': str(p.get('proto')), 'port': str(p.get('port'))} for p in (x.get('ports') or []) if isinstance(p, dict) and str(p.get('port', '')).isdigit()]
                return self.reply(200, probe(ip, ports)) if ip else self.reply(400, {'error': 'IP'})
            d, errs = validate_fw(x)
            if errs:
                return self.reply(400, {'error': 'Проверьте: ' + ', '.join(errs)})
            if any(j['status'] == 'run' and j['data']['ip'] == d['ip'] for j in JOBS.values()):
                return self.reply(409, {'error': 'с этой нодой уже идёт работа'})
            return self.reply(200, {'id': new_job(d, 'fw')})
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
