#!/usr/bin/env python3
"""rw-sync.py — ноды из панели Remnawave -> доступ к статистике + справочник для дашборда.

Запускается на сервере ПАНЕЛИ, по cron раз в 5 минут:
  1) берёт список нод из API Remnawave (GET /api/nodes): имя, страна, адрес, IP, статус, онлайн;
  2) пускает IP всех нод на 443 в DOCKER-USER (правила с пометкой rw-node-sync; лишние убирает);
     с FIREWALL=0 в конфиге правила не нужны (ноды пишут через шлюз :9443) — скрипт их снимает;
  3) пишет справочник нод в VictoriaMetrics — дашборд берёт оттуда имена, флаги и «онлайн».

  python3 rw-sync.py --install   # спросить API-токен, сохранить /etc/rw-node-sync.conf (600), поставить cron
  python3 rw-sync.py --dry-run   # показать, что изменится, ничего не меняя
  python3 rw-sync.py             # синхронизировать

Логин/пароль VictoriaMetrics — из .env рядом со скриптом (VM_USER, VM_PASS).
"""
import base64
import getpass
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONF = '/etc/rw-node-sync.conf'
CRON = '/etc/cron.d/rw-node-sync'
TAG = 'rw-node-sync'   # пометка наших правил в DOCKER-USER: чужие правила не трогаем
VM_WRITE = 'http://127.0.0.1:8428/node-stats/write'
os.environ['PATH'] += ':/usr/sbin:/sbin'   # cron даёт PATH без sbin, а iptables живёт там


def read_kv(path):
    out = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    out[k.strip()] = v.strip().strip('\'"')
    except FileNotFoundError:
        pass
    return out


def get_nodes(api, token):
    # прямой запрос на :3000 мимо Caddy — передаём заголовки, как их ставит обратный прокси
    req = urllib.request.Request(api.rstrip('/') + '/nodes', headers={
        'Authorization': f'Bearer {token}', 'Accept': 'application/json',
        'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)['response']


def ipv4s(node):
    ips = set()
    for item in node.get('ips') or []:   # IP, которые видит сама панель (есть в новых версиях Remnawave)
        try:
            if ipaddress.ip_address(item['ip']).version == 4:
                ips.add(item['ip'])
        except (KeyError, TypeError, ValueError):
            pass
    try:
        ips.update(ai[4][0] for ai in socket.getaddrinfo(node['address'], None, socket.AF_INET))
    except (socket.gaierror, KeyError):
        pass
    return ips


def current_rules():
    out = subprocess.run(['iptables', '-S', 'DOCKER-USER'], capture_output=True, text=True, check=True).stdout
    found = set()
    for line in out.splitlines():
        m = re.search(r'-s (\d+\.\d+\.\d+\.\d+)/32', line)
        if TAG in line and m:
            found.add(m.group(1))
    return found


def rule(op, ip):
    return ['iptables', op, 'DOCKER-USER', '-s', f'{ip}/32', '-p', 'tcp', '--dport', '443',
            '-m', 'comment', '--comment', TAG, '-j', 'ACCEPT']


def tag(v):   # значение тега в line protocol: экранируем пробел, запятую и =
    return re.sub(r'([ ,=])', r'\\\1', str(v)) or '-'


def push(lines, env):
    auth = base64.b64encode(f"{env.get('VM_USER', 'node')}:{env.get('VM_PASS', '')}".encode()).decode()
    req = urllib.request.Request(VM_WRITE, data='\n'.join(lines).encode(), headers={'Authorization': f'Basic {auth}'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


def install():
    if os.geteuid() != 0:
        sys.exit('Запусти от root.')
    conf = read_kv(CONF)
    api = conf.get('RW_API', 'http://127.0.0.1:3000/api')
    token = conf.get('RW_TOKEN') or getpass.getpass('API-токен Remnawave (панель -> API Tokens, ввод не виден): ').strip()
    try:
        nodes = get_nodes(api, token)
    except (urllib.error.URLError, KeyError, ValueError) as e:
        sys.exit(f'Панель не приняла токен или недоступна ({api}): {e}')
    old = os.umask(0o077)
    try:
        with open(CONF, 'w', encoding='utf-8') as f:
            f.write(f'# rw-sync.py: доступ к API Remnawave\nRW_API={api}\nRW_TOKEN={token}\n')
    finally:
        os.umask(old)
    os.chmod(CONF, 0o600)
    with open(CRON, 'w', encoding='utf-8') as f:
        f.write(f'*/5 * * * * root /usr/bin/env python3 {os.path.abspath(__file__)} >/dev/null 2>&1\n')
    print(f'Токен принят, нод в панели: {len(nodes)}. Конфиг: {CONF} (600). Cron: {CRON}, каждые 5 минут.')
    print(f'Проверить без изменений: python3 {os.path.abspath(__file__)} --dry-run')


def main():
    args = set(sys.argv[1:])
    if '--install' in args:
        return install()
    dry = '--dry-run' in args
    conf, env = read_kv(CONF), read_kv(os.path.join(HERE, '.env'))
    if not conf.get('RW_TOKEN'):
        sys.exit(f'Нет RW_TOKEN в {CONF}. Сначала: python3 {os.path.abspath(__file__)} --install')
    nodes = get_nodes(conf.get('RW_API', 'http://127.0.0.1:3000/api'), conf['RW_TOKEN'])
    if not nodes:   # сбой панели или токен без прав не должен закрыть доступ всем нодам
        sys.exit('Панель вернула пустой список нод — правила не трогаю.')

    want, lines = {}, []
    for n in nodes:
        ips = ipv4s(n)
        for ip in ips:
            want[ip] = n['name']
        base = f"uuid={tag(n['uuid'])},name={tag(n['name'])},cc={tag(n.get('countryCode') or 'XX')}"
        for ip in sorted(ips) or ['-']:
            lines.append(f'node_panel,{base},ip={tag(ip)} info=1')
        fields = [f"connected={int(bool(n.get('isConnected')))}", f"disabled={int(bool(n.get('isDisabled')))}"]
        if isinstance(n.get('usersOnline'), (int, float)):
            fields.append(f"users_online={n['usersOnline']}")
        lines.append(f"node_panel,{base} {','.join(fields)}")

    # FIREWALL=0 в конфиге: ноды шлют статистику через шлюз :9443, белый список на 443 им не нужен — снимаем свои правила
    target = set(want) if conf.get('FIREWALL', '1') != '0' else set()
    have = current_rules()
    add, drop = sorted(target - have), sorted(have - target)
    print(f'Нод в панели: {len(nodes)}, IP: {len(want)}. Открыть на 443: {add or "—"}. Закрыть: {drop or "—"}.')
    for ip in add:
        print(f'  + {ip}  ({want[ip]})')
    if dry:
        print('\n'.join(['Справочник для VictoriaMetrics:'] + ['  ' + l for l in lines]))
        return

    for ip in add:
        subprocess.run(rule('-I', ip), check=True)
    for ip in drop:
        subprocess.run(rule('-D', ip), check=True)
    if (add or drop) and shutil.which('netfilter-persistent'):
        subprocess.run(['netfilter-persistent', 'save'], capture_output=True)   # правила переживут перезагрузку
    print(f'Справочник в VictoriaMetrics: HTTP {push(lines, env)}')


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f'HTTP {e.code} от {e.url}: проверь токен Remnawave (--install) или пароль VictoriaMetrics в .env')
    except urllib.error.URLError as e:
        sys.exit(f'Нет связи: {e.reason}')
