#!/usr/bin/env python3
"""rw-sync.py — ноды из панели Remnawave -> доступ к статистике + справочник для дашборда.

Запускается на сервере ПАНЕЛИ, по cron раз в 5 минут:
  1) берёт список нод из API Remnawave (GET /api/nodes): имя, страна, адрес, IP, статус, онлайн;
  2) пускает IP всех нод на 443 в DOCKER-USER (правила с пометкой rw-node-sync; лишние убирает);
     с FIREWALL=0 в конфиге правила не нужны (ноды пишут через шлюз :9443) — скрипт их снимает;
  3) пишет справочник нод в VictoriaMetrics — дашборд берёт оттуда имена, флаги и «онлайн»;
  4) находит связи «мост -> выход»: адреса в исходящих (outbounds) конфиг-профиля ноды, совпавшие с другой нодой
     из панели — карта на дашборде рисует только настоящие пути.

  python3 rw-sync.py --install   # спросить API-токен, сохранить /etc/rw-node-sync.conf (600), поставить cron
  python3 rw-sync.py --dry-run   # показать, что изменится, ничего не меняя
  python3 rw-sync.py             # синхронизировать

Логин/пароль VictoriaMetrics — из .env рядом со скриптом (VM_USER, VM_PASS).
"""
import base64
import fcntl
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


def get_system_stats(api, token):
    # общая статистика панели: response.onlineStats.onlineNow — онлайн по всей панели, без задвоения по нодам
    # (у клиентов с балансировщиком одно устройство числится онлайн сразу на всех нодах, сумма по нодам завышена)
    req = urllib.request.Request(api.rstrip('/') + '/system/stats', headers={
        'Authorization': f'Bearer {token}', 'Accept': 'application/json',
        'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)['response']


def get_profiles(api, token):
    # конфиг-профили панели: response.configProfiles[] с полями uuid, name, config (JSON Xray)
    req = urllib.request.Request(api.rstrip('/') + '/config-profiles', headers={
        'Authorization': f'Bearer {token}', 'Accept': 'application/json',
        'X-Forwarded-For': '127.0.0.1', 'X-Forwarded-Proto': 'https'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)['response']['configProfiles']


PROXY_OUT = {'vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'hysteria2', 'wireguard'}


def outbound_addresses(cfg):
    """адреса серверов из исходящих подключений Xray (vnext[].address, servers[].address, settings.address)"""
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except ValueError:
            return set()
    out = set()
    for ob in (cfg.get('outbounds') if isinstance(cfg, dict) else None) or []:
        if not isinstance(ob, dict) or ob.get('protocol') not in PROXY_OUT:
            continue
        stack = [ob.get('settings')]
        while stack:
            x = stack.pop()
            if isinstance(x, dict):
                for k, v in x.items():
                    if k in ('address', 'server') and isinstance(v, str):
                        out.add(v.strip().lower())
                    else:
                        stack.append(v)
            elif isinstance(x, list):
                stack.extend(x)
    return out


def bridge_links(api, token, nodes, node_ips):
    """-> [(from_node, to_node)]: нода, в чьём профиле есть исходящее на адрес другой ноды из панели"""
    profiles = {p['uuid']: outbound_addresses(p.get('config')) for p in get_profiles(api, token) if isinstance(p, dict) and p.get('uuid')}
    by_addr = {str(n.get('address') or '').strip().lower(): n for n in nodes}
    by_ip = {ip: n for n in nodes for ip in node_ips[n['uuid']]}
    resolved, links, unknown = {}, [], set()
    for n in nodes:
        cp = n.get('configProfile')
        prof = cp.get('activeConfigProfileUuid') if isinstance(cp, dict) else None
        for a in sorted(profiles.get(prof, ())):
            t = by_addr.get(a) or by_ip.get(a)
            if t is None and not a.replace('.', '').isdigit():
                if a not in resolved:
                    try:
                        resolved[a] = {ai[4][0] for ai in socket.getaddrinfo(a, None, socket.AF_INET)}
                    except (OSError, UnicodeError, ValueError):   # не резолвится, кривое имя (a..b, метка > 63) — пропускаем адрес
                        resolved[a] = set()
                t = next((by_ip[ip] for ip in resolved[a] if ip in by_ip), None)
            if t is None:
                unknown.add(a)
            elif t['uuid'] != n['uuid']:
                links.append((n, t))
    return links, unknown


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
    # один запуск за раз: cron каждые 5 минут, а медленный DNS или API (до 20 с на запрос) может растянуть прогон —
    # два параллельных добавили бы одинаковые правила iptables
    lock = open('/run/rw-node-sync.lock' if os.access('/run', os.W_OK) else os.path.join(HERE, '.rw-sync.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        sys.exit('rw-sync уже работает (предыдущий запуск ещё не закончился) — пропускаю.')
    dry = '--dry-run' in args
    conf, env = read_kv(CONF), read_kv(os.path.join(HERE, '.env'))
    if not conf.get('RW_TOKEN'):
        sys.exit(f'Нет RW_TOKEN в {CONF}. Сначала: python3 {os.path.abspath(__file__)} --install')
    nodes = get_nodes(conf.get('RW_API', 'http://127.0.0.1:3000/api'), conf['RW_TOKEN'])
    if not nodes:   # сбой панели или токен без прав не должен закрыть доступ всем нодам
        sys.exit('Панель вернула пустой список нод — правила не трогаю.')

    want, lines, node_ips = {}, [], {}
    for n in nodes:
        ips = node_ips[n['uuid']] = ipv4s(n)
        for ip in ips:
            want[ip] = n['name']
        base = f"uuid={tag(n['uuid'])},name={tag(n['name'])},cc={tag(n.get('countryCode') or 'XX')}"
        for ip in sorted(ips) or ['-']:
            lines.append(f'node_panel,{base},ip={tag(ip)} info=1')
        fields = [f"connected={int(bool(n.get('isConnected')))}", f"disabled={int(bool(n.get('isDisabled')))}"]
        if isinstance(n.get('usersOnline'), (int, float)):
            fields.append(f"users_online={n['usersOnline']}")
        lines.append(f"node_panel,{base} {','.join(fields)}")

    # онлайн по всей панели (уникальный) и сколько пользователей всего; не вышло — дашборд считает по нодам, как раньше
    try:
        st = get_system_stats(conf.get('RW_API', 'http://127.0.0.1:3000/api'), conf['RW_TOKEN'])
        on, us, nd = st.get('onlineStats') or {}, st.get('users') or {}, st.get('nodes') or {}
        vals = {'online_now': on.get('onlineNow'), 'online_day': on.get('lastDay'), 'online_week': on.get('lastWeek'),
                'users_total': us.get('totalUsers'), 'nodes_online': nd.get('totalOnline')}
        fields = ','.join(f'{k}={v}' for k, v in vals.items() if isinstance(v, (int, float)) and not isinstance(v, bool))
        if fields:
            lines.append(f'node_panel_stats {fields}')
        print(f"Панель: онлайн сейчас {vals['online_now']}, за сутки {vals['online_day']}, всего пользователей {vals['users_total']}"
              f" (сумма онлайна по нодам: {sum(n['usersOnline'] for n in nodes if isinstance(n.get('usersOnline'), (int, float)))})")
    except (urllib.error.URLError, OSError, KeyError, ValueError, TypeError, AttributeError) as e:
        print(f'Общая статистика панели не получена ({e}) — онлайн на дашборде будет суммой по нодам.')

    # связи «мост -> выход» из конфиг-профилей; не вышло (старая панель, права токена) — карта просто без линий
    try:
        links, unknown = bridge_links(conf.get('RW_API', 'http://127.0.0.1:3000/api'), conf['RW_TOKEN'], nodes, node_ips)
        for a, b in links:
            lines.append(f"node_panel_link,from={tag(a['uuid'])},to={tag(b['uuid'])} n=1")
        by_from = {}
        for a, b in links:
            by_from.setdefault(a['name'], []).append(b['name'])
        print(f'Связи мостов: {len(links)}' + ''.join(f'\n  {k} -> {", ".join(sorted(v))}' for k, v in sorted(by_from.items())))
        if unknown and dry:
            print('В исходящих профилей есть адреса, не совпавшие ни с одной нодой (это нормально для внешних сервисов): ' + ', '.join(sorted(unknown)))
    except (urllib.error.URLError, OSError, KeyError, ValueError, TypeError, AttributeError) as e:
        print(f'Связи мостов не получены ({e}) — карта будет без линий.')

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
