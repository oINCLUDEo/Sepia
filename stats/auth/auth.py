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
  POST /node-stats/auth/comp-add {"name"?, "url"|"text", "ua", "remember"?} | comp-refresh {"name"} | comp-probe-one {"name", "keys"} | comp-list | comp-delete {"name"} | comp-asn {"ips"} | comp-dossier {"ip"}: разбор подписок конкурентов (node-setup)
  POST /node-stats/auth/suspects {"fresh"?} -> 200 подозрительные аккаунты (много устройств/адресов/приложений, трафик) из API панели
  POST /node-stats/auth/tariffs  {"fresh"?} -> 200 сводка по тарифам (тариф — по лимитам трафика и устройств) из API панели
  GET  /node-stats/auth/ip      -> {"ip"}: адрес, с которого открыт дашборд (подставить «ваш IP для SSH» в мастер)
  POST /node-stats/auth/setup   {"admin", ...} -> {"id"}: автонастройка ноды по SSH (node-setup); нужен ADMIN_PASS
  POST /node-stats/auth/setup-status {"id", "from"} -> ход настройки; /setup-cancel {"id", "admin"} — отменить
  POST /node-stats/auth/fw      {"admin", ip, ssh_port, password, name, rules} -> {"id"}: правка фаервола ноды (node-setup)
  POST /node-stats/auth/probe   {ip, ports} -> открыт ли порт снаружи, проверка с сервера панели

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
from datetime import datetime
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
ADMIN_PASS = os.environ.get('ADMIN_PASS', '')     # второй пароль: настройка нод по SSH (даёт root на новых серверах)
SETUP_URL = os.environ.get('SETUP_URL', 'http://node-setup:8092').rstrip('/')
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


# Подозрительные аккаунты: перепродажа и утёкшие подписки. Считается на лету из API панели (раз в 10 минут, в памяти) —
# в VictoriaMetrics ничего о пользователях не пишем. Признаки:
#  devices — устройств HWID больше лимита пользователя (или SUSP_DEVICES, если лимита нет);
#  ips     — подписку запрашивали с SUSP_IPS+ разных адресов из 3+ разных сетей /16 (по истории запросов подписки);
#  apps    — разными клиентами (User-Agent) — SUSP_APPS+;
#  traffic — трафик за период в SUSP_TRAFFIC_X раз выше медианы активных и не меньше SUSP_TRAFFIC_GB.
# Каждый источник необязателен: старая панель без HWID или истории подписок — просто без этого признака.
SUSP_DEVICES = int(os.environ.get('SUSP_DEVICES', '5'))
SUSP_IPS = int(os.environ.get('SUSP_IPS', '6'))
SUSP_APPS = int(os.environ.get('SUSP_APPS', '4'))
SUSP_TRAFFIC_X = float(os.environ.get('SUSP_TRAFFIC_X', '8'))
SUSP_TRAFFIC_GB = float(os.environ.get('SUSP_TRAFFIC_GB', '150'))
_susp = {'at': 0, 'data': None}
_susp_lock = threading.Lock()


def rw_list(path, keys, size=500, cap=20000):
    # постраничная выгрузка: ответ {response: {<один из keys>: [...], total}} или {response: [...]}
    out, start = [], 0
    while start < cap:
        sep = '&' if '?' in path else '?'
        r = rw('GET', f'{path}{sep}start={start}&size={size}').get('response')
        items = r if isinstance(r, list) else next((r[k] for k in keys if isinstance(r, dict) and isinstance(r.get(k), list)), [])
        out += [x for x in items if isinstance(x, dict)]
        total = r.get('total') if isinstance(r, dict) else None
        if isinstance(r, list) or not items or len(items) < size or (isinstance(total, int) and start + size >= total):
            break
        start += size
    return out


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def suspects():
    users = rw_list('/users', ('users',))
    by = {u.get('uuid'): u for u in users if u.get('uuid')}
    src = {'users': len(by), 'devices': False, 'subs': False, 'traffic': False}
    flags = {}

    def flag(uid, k, t, w):
        if uid in by:
            flags.setdefault(uid, []).append({'k': k, 't': t, 'w': w})

    # трафик: в новых версиях панели — в userTraffic, в старых — прямо у пользователя
    ut = {uid: (u['userTraffic'] if isinstance(u.get('userTraffic'), dict) else u) for uid, u in by.items()}
    tr = {uid: num(t.get('usedTrafficBytes')) / 1e9 for uid, t in ut.items()}
    act = sorted(v for v in tr.values() if v > 0.5)
    med = act[len(act) // 2] if act else 0
    if act:
        src['traffic'] = True
        for uid, gb in tr.items():
            if gb >= SUSP_TRAFFIC_GB and gb >= SUSP_TRAFFIC_X * med:
                flag(uid, 'traffic', f'трафик {gb:.0f} ГБ — в {gb / med:.0f} раз больше обычного ({med:.0f} ГБ)', 2 if gb >= 3 * SUSP_TRAFFIC_X * med else 1)
    # устройства HWID
    dev = {}
    try:
        for d in rw_list('/hwid/devices', ('devices',)):
            dev.setdefault(d.get('userUuid'), []).append(d)
        src['devices'] = True
    except (OSError, ValueError, AttributeError):
        pass
    for uid, ds in dev.items():
        lim = int(num((by.get(uid) or {}).get('hwidDeviceLimit')))
        if (lim and len(ds) > lim) or (not lim and len(ds) >= SUSP_DEVICES):
            plats = sorted({str(d.get('platform') or d.get('deviceModel') or '?') for d in ds})
            flag(uid, 'devices', f"устройств {len(ds)}{f' при лимите {lim}' if lim else ''}: {', '.join(plats[:5])}", 2 if len(ds) >= 2 * max(lim, SUSP_DEVICES) else 1)
    # история запросов подписки: разные адреса и клиенты
    ips, apps = {}, {}
    try:
        for x in rw_list('/subscription-request-history', ('records', 'history'), cap=5000):
            uid = x.get('userUuid')
            if x.get('requestIp'):
                ips.setdefault(uid, set()).add(str(x['requestIp']))
            if x.get('userAgent'):
                apps.setdefault(uid, set()).add(re.split(r'[/ ]', str(x['userAgent']))[0][:30])
        src['subs'] = True
    except (OSError, ValueError, AttributeError):
        pass
    for uid, s in ips.items():
        nets = {'.'.join(a.split('.')[:2]) if '.' in a else ':'.join(a.split(':')[:2]) for a in s}
        if len(s) >= SUSP_IPS and len(nets) >= 3:
            flag(uid, 'ips', f'подписку запрашивали с {len(s)} адресов из {len(nets)} разных сетей', 2 if len(s) >= 2 * SUSP_IPS else 1)
    for uid, s in apps.items():
        if len(s) >= SUSP_APPS:
            flag(uid, 'apps', f"{len(s)} разных приложений: {', '.join(sorted(s)[:5])}", 1)

    out = []
    for uid, fl in flags.items():
        u = by[uid]
        out.append({'uuid': uid, 'username': str(u.get('username') or '')[:64], 'status': u.get('status'),
                    'score': sum(f['w'] for f in fl) + len(fl) - 1, 'reasons': fl, 'devices': len(dev.get(uid, [])),
                    'ips': len(ips.get(uid, ())), 'traffic_gb': round(tr.get(uid, 0), 1), 'online_at': ut[uid].get('onlineAt')})
    out.sort(key=lambda x: (-x['score'], -x['traffic_gb']))
    return {'at': int(time.time()), 'src': src, 'median_gb': round(med, 1), 'list': out[:60],
            'limits': {'devices': SUSP_DEVICES, 'ips': SUSP_IPS, 'apps': SUSP_APPS, 'traffic_x': SUSP_TRAFFIC_X, 'traffic_gb': SUSP_TRAFFIC_GB}}


def suspects_cached(fresh=False):
    with _susp_lock:
        if fresh or not _susp['data'] or time.time() - _susp['at'] > 600:
            _susp['data'], _susp['at'] = suspects(), time.time()
        return _susp['data']


# Тарифы: кто на каком тарифе и как его использует. Тариф узнаём по лимитам пользователя в панели (трафик и устройства) —
# названий тарифов Remnawave не хранит. TARIFFS в .env: «id:цена:ГБ:устройств», через запятую; 0 ГБ — безлимит.
# Пробная — тариф с ценой 0. Сверх лимита устройств у самого дорогого безлимита — EXTRA_DEVICE ₽ за каждое.
# Раз в час node-auth пишет в VictoriaMetrics только суммы по тарифам (сколько пользователей, сколько ГБ за час) —
# по пользователям ничего не пишется; так видно, сколько тариф реально берёт трафика за 30 дней.
TARIFFS = []
for _t in (os.environ.get('TARIFFS') or 'trial:0:5:5,99:99:20:1,149:149:50:2,199:199:0:2,299:299:0:5').split(','):
    try:
        _id, _p, _gb, _dev = _t.strip().split(':')
        TARIFFS.append({'id': _id, 'price': float(_p), 'gb': float(_gb), 'dev': int(_dev)})
    except ValueError:
        print(f'node-auth: TARIFFS — не понял «{_t}», нужно id:цена:ГБ:устройств', flush=True)
EXTRA_DEVICE = float(os.environ.get('EXTRA_DEVICE', '100'))
TRIAL_DAYS = float(os.environ.get('TRIAL_DAYS', '5'))
# служебные и тестовые аккаунты в расчёт не берём: имя, тег или описание похожи на USERS_SKIP (регулярное выражение),
# или подписка бессрочная — дольше USERS_SKIP_DAYS вперёд (самый долгий тариф — 12 месяцев)
try:
    USERS_SKIP = re.compile(os.environ.get('USERS_SKIP') or r'test|тест|system|служеб|admin|bridge|мост|probe|monitor|internal|demo', re.I)
except re.error:
    print('node-auth: USERS_SKIP — неверное регулярное выражение, служебных по имени не отсеиваю', flush=True)
    USERS_SKIP = None
USERS_SKIP_DAYS = float(os.environ.get('USERS_SKIP_DAYS', '400'))
_tar = {'at': 0, 'data': None}
_tar_lock = threading.Lock()
_life = {'at': 0, 'by': {}}   # прошлый час: uuid → весь трафик пользователя, байт (только в памяти)


def iso_ts(v):
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00')).timestamp() if v else None
    except ValueError:
        return None


def gb_is(b, gb):
    # лимит в панели ставят и в ГБ, и в ГиБ: 20 ГБ = 20·10⁹ или 20·2³⁰ байт
    return any(abs(b / u - gb) <= gb * .03 for u in (1e9, 2 ** 30))


def tariff_of(lim_b, dev):
    # → (тариф или None, лишних устройств)
    if lim_b > 0:
        t = next((t for t in TARIFFS if t['gb'] and gb_is(lim_b, t['gb'])), None)
        return t, 0
    unl = sorted((t for t in TARIFFS if not t['gb']), key=lambda t: t['dev'])
    if not unl or not dev:
        return None, 0
    top = unl[-1]
    if dev >= top['dev']:
        return top, dev - top['dev']
    return next((t for t in unl if t['dev'] == dev), None), 0


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None


def tariffs():
    now = time.time()
    users = [u for u in rw_list('/users', ('users',)) if u.get('uuid')]
    dev = {}
    try:
        for d in rw_list('/hwid/devices', ('devices',)):
            dev[d.get('userUuid')] = dev.get(d.get('userUuid'), 0) + 1
        has_dev = True
    except (OSError, ValueError, AttributeError):
        has_dev = False
    T = {t['id']: {**t, 'n': 0, 'paying': 0, 'limited': 0, 'expired': 0, 'disabled': 0, 'on24': 0, 'on7': 0, 'never': 0,
                   'mrr': 0.0, 'extra': 0, 'used': [], 'life_mo': [], 'at80': 0, 'at100': 0, 'dev_used': [], 'dev_full': 0,
                   'exp7': 0, 'gone30': 0, 'new30': 0} for t in TARIFFS}
    other, ups, life, trial = {}, [], {}, [t['id'] for t in TARIFFS if not t['price']]
    new_paid = new_trial_done = 0
    skip = {'name': 0, 'forever': 0, 'names': []}
    day0 = int(now // 86400) * 86400   # полночь UTC сегодня
    flow = {'new_trial': [0] * 30, 'new_paid': [0] * 30, 'new_other': [0] * 30, 'lost': [0] * 30, 'trial_end': [0] * 30}
    for u in users:
        ut = u['userTraffic'] if isinstance(u.get('userTraffic'), dict) else u
        lim_b, dl = num(u.get('trafficLimitBytes')), int(num(u.get('hwidDeviceLimit')))
        lt = num(ut.get('lifetimeUsedTrafficBytes'))
        created, exp, on = iso_ts(u.get('createdAt')), iso_ts(u.get('expireAt')), iso_ts(ut.get('onlineAt'))
        label = ' '.join(str(u.get(k) or '') for k in ('username', 'tag', 'description'))
        why_skip = 'name' if USERS_SKIP and USERS_SKIP.search(label) else 'forever' if exp and exp - now > USERS_SKIP_DAYS * 86400 else None
        if why_skip:
            skip[why_skip] += 1
            if len(skip['names']) < 12:
                skip['names'].append(str(u.get('username') or '')[:40] + (' — бессрочная' if why_skip == 'forever' else ''))
            life[u['uuid']] = ('skip', lt)
            continue
        t, extra = tariff_of(lim_b, dl)
        # пробную узнаём ещё и по сроку: подписка не длиннее пробной (создан → кончается через TRIAL_DAYS) — её ни разу
        # не продлевали и не покупали. Так пробная находится, даже если её лимиты не совпали с TARIFFS, а уход и конверсия
        # не зависят от того, что бот делает с лимитами после окончания подписки
        short = bool(created and exp and exp - created <= (TRIAL_DAYS + 1) * 86400)
        if short and trial and not (t and t['price']):
            t, extra = next(x for x in TARIFFS if x['id'] == trial[0]), 0
        life[u['uuid']] = (t['id'] if t else 'other', lt)
        st0 = str(u.get('status') or '').upper()
        # приход по дням: новый — по дате создания; «платит» — подписку купили или продлили (она длиннее пробной)
        if created and now - created < 30 * 86400:
            i = 29 - int((day0 - int(created // 86400) * 86400) // 86400)
            if 0 <= i < 30:
                flow['new_trial' if short else 'new_paid'][i] += 1
        # уход: подписка кончилась за 30 дней и не продлена; пробные, которые просто закончились, — отдельно
        if exp and exp <= now and now - exp < 30 * 86400 and st0 != 'DISABLED':
            i = 29 - int((day0 - int(exp // 86400) * 86400) // 86400)
            if 0 <= i < 30:
                flow['trial_end' if short else 'lost'][i] += 1
        # конверсия: новые за 30 дней, у кого пробная уже должна была кончиться, — продлили или нет
        if created and now - created <= 30 * 86400 and now - created >= (TRIAL_DAYS + 1) * 86400:
            if short:
                new_trial_done += 1
            else:
                new_paid += 1
        if not t:
            g = lim_b / 2 ** 30 if lim_b and abs(lim_b / 2 ** 30 - round(lim_b / 2 ** 30)) < abs(lim_b / 1e9 - round(lim_b / 1e9)) else lim_b / 1e9
            k = f"{round(g)}:{dl}"
            other[k] = other.get(k, 0) + 1
            continue
        a = T[t['id']]
        st = str(u.get('status') or '').upper()
        live = st in ('ACTIVE', 'LIMITED') and (not exp or exp > now)
        a['n'] += 1
        a['disabled'] += st == 'DISABLED'
        if st == 'EXPIRED' or (exp and exp <= now and st != 'DISABLED'):
            a['expired'] += 1
            a['gone30'] += bool(exp and now - exp <= 30 * 86400)
        if created and now - created <= 30 * 86400:
            a['new30'] += 1
        if not live:
            continue
        a['paying'] += 1
        a['limited'] += st == 'LIMITED'
        a['mrr'] += t['price'] + extra * EXTRA_DEVICE
        a['extra'] += extra
        a['exp7'] += bool(exp and exp - now <= 7 * 86400)
        a['on24'] += bool(on and now - on <= 86400)
        a['on7'] += bool(on and now - on <= 7 * 86400)
        a['never'] += not ut.get('firstConnectedAt') and not lt
        used = num(ut.get('usedTrafficBytes')) / 1e9
        a['used'].append(used)
        if created and now - created >= 7 * 86400:
            a['life_mo'].append(lt / 1e9 / ((now - created) / 86400) * 30)
        share = None
        if lim_b:
            share = num(ut.get('usedTrafficBytes')) / lim_b
            a['at80'] += share >= .8
            a['at100'] += share >= 1 or st == 'LIMITED'
        nd = dev.get(u['uuid'], 0)
        if has_dev and dl:
            a['dev_used'].append(nd)
            a['dev_full'] += nd >= dl
        # кому предложить тариф выше
        why = None
        if lim_b and share is not None and share >= .8:
            why = f"израсходовал {share * 100:.0f}% из {t['gb']:.0f} ГБ"
        elif not lim_b and has_dev and dl and nd >= dl:
            why = f"занял все устройства: {nd} из {dl}"
        if why and t['price']:
            ups.append({'username': str(u.get('username') or '')[:64], 'tariff': t['id'], 'why': why, 'share': share,
                        'days_left': round((exp - now) / 86400) if exp else None, 'online_at': ut.get('onlineAt')})
    out = []
    for a in T.values():
        used, lm, du = a.pop('used'), a.pop('life_mo'), a.pop('dev_used')
        a.update({'mrr': round(a['mrr']), 'used_med': pct(used, .5), 'used_p90': pct(used, .9), 'used_max': max(used) if used else None,
                  'used_sum': round(sum(used), 1), 'life_mo_med': pct(lm, .5), 'life_mo_p90': pct(lm, .9), 'life_mo_n': len(lm),
                  'life_mo_avg': round(sum(lm) / len(lm), 1) if lm else None,
                  'dev_avg': round(sum(du) / len(du), 2) if du else None})
        out.append(a)
    # сначала упёршиеся в трафик (это прямо мешает пользоваться), потом занявшие все устройства
    ups.sort(key=lambda x: (x['share'] is None, -(x['share'] or 0), x['days_left'] if x['days_left'] is not None else 999))
    done = new_paid + new_trial_done
    _tar['life'] = life
    return {'at': int(now), 'users': len(users), 'skip': skip, 'flow': flow, 'day0': day0, 'devices': has_dev, 'extra_device': EXTRA_DEVICE, 'trial_days': TRIAL_DAYS,
            'tariffs': out, 'other': sorted(({'gb': int(k.split(':')[0]), 'dev': int(k.split(':')[1]), 'n': v} for k, v in other.items()), key=lambda x: -x['n'])[:12],
            'upsell': ups[:80], 'upsell_n': len(ups), 'conv': {'paid': new_paid, 'trial': new_trial_done, 'share': round(new_paid / done, 3) if done else None} if trial else None}


def tariffs_cached(fresh=False):
    with _tar_lock:
        if fresh or not _tar['data'] or time.time() - _tar['at'] > 600:
            _tar['data'], _tar['at'] = tariffs(), time.time()
        return _tar['data']


def tariffs_hourly():
    # раз в час: суммы по тарифам в VictoriaMetrics — пользователи по состояниям и трафик за час (разница «всего трафика»
    # пользователей с прошлого раза; после перезапуска node-auth первый час пропускается)
    while True:
        try:
            D = tariffs_cached(True)
            now, life, prev = int(time.time()), _tar.get('life') or {}, _life['by']
            gb = {}
            if prev and now - _life['at'] < 3 * 3600:
                for uid, (tid, lt) in life.items():
                    d = lt - prev.get(uid, lt)
                    if d > 0:
                        gb[tid] = gb.get(tid, 0) + d / 1e9
            _life.update(at=now, by={uid: lt for uid, (tid, lt) in life.items()})
            lines = []
            for a in D['tariffs']:
                tag = f"tariff={lp_tag(a['id'])}"
                lines.append(f"sepia_tariff,{tag} users={a['n']},paying={a['paying']},on24={a['on24']},mrr={a['mrr']}" + (f",gb_hour={gb.get(a['id'], 0):.3f}" if prev else '') + f" {now * 10**9}")
            if prev and gb.get('other'):
                lines.append(f"sepia_tariff,tariff=other gb_hour={gb['other']:.3f} {now * 10**9}")
            vm_call('/write', '\n'.join(lines).encode())
        except (OSError, ValueError, AttributeError, TypeError) as e:
            print(f'node-auth: тарифы раз в час: {e}', flush=True)
        time.sleep(3600)


def setup_call(path, data=None, timeout=15):
    req = urllib.request.Request(SETUP_URL + path, data=json.dumps(data).encode() if data is not None else None,
                                 method='POST' if data is not None else 'GET', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


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
        if path == PREFIX + '/ip':
            if not self.authed():
                return self.reply(401)
            return self.reply(200, [('Content-Type', 'application/json')], json.dumps({'ip': client_ip(self), 'setup': bool(ADMIN_PASS)}).encode())
        self.reply(404)

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == PREFIX + '/logout':
            return self.reply(204, [self.set_cookie('', 0)])
        if path in (PREFIX + '/note', PREFIX + '/note-delete', PREFIX + '/hosts', PREFIX + '/hosts-toggle',
                    PREFIX + '/setup', PREFIX + '/setup-status', PREFIX + '/setup-cancel', PREFIX + '/fw', PREFIX + '/probe', PREFIX + '/suspects', PREFIX + '/tariffs',
                    PREFIX + '/comp-add', PREFIX + '/comp-refresh', PREFIX + '/comp-probe-one', PREFIX + '/comp-list', PREFIX + '/comp-delete', PREFIX + '/comp-asn', PREFIX + '/comp-dossier'):
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
            n = min(int(self.headers.get('Content-Length') or 0), 2_000_000 if path.endswith('/comp-add') else 65536 if path.endswith('/probe') else 4096)   # подписка текстом и список портов бывают большими
            data = json.loads(self.rfile.read(n) or b'{}')
        except (ValueError, json.JSONDecodeError):
            return self.reply(400)
        if not isinstance(data, dict):
            return self.reply(400)
        if '/setup' in path or path.endswith(('/fw', '/probe')):
            return self.setup_job(path, data)
        if '/comp-' in path:   # разбор подписок конкурентов — в node-setup (там хранилище); ключи из подписок туда же и не дальше
            try:
                code, body = setup_call('/comp/' + path.rsplit('/comp-', 1)[1], data, timeout=90)
            except (OSError, ValueError) as e:
                print(f'node-auth: node-setup недоступен: {e}', flush=True)
                return self.reply(502)
            return self.reply(code, [('Content-Type', 'application/json')] if body else [], body)
        if path.endswith(('/suspects', '/tariffs')):
            if not RW_TOKEN:
                return self.reply(501)
            try:
                f = suspects_cached if path.endswith('/suspects') else tariffs_cached
                body = json.dumps(f(bool(data.get('fresh'))), ensure_ascii=False).encode()
                return self.reply(200, [('Content-Type', 'application/json')], body)
            except (OSError, ValueError, AttributeError, TypeError) as e:
                print(f'node-auth: Remnawave API (аккаунты): {e}', flush=True)
                return self.reply(502)
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


    def setup_job(self, path, data):
        # настройка ноды: только с паролем администратора (он же под тем же лимитом попыток, что вход)
        if not ADMIN_PASS:
            return self.reply(501)
        ip = client_ip(self)
        if not path.endswith(('/setup-status', '/probe')):   # смотреть ход и стучаться на порты — без пароля администратора
            if too_many(ip):
                return self.reply(429, [('Retry-After', str(WINDOW))])
            if not hmac.compare_digest(str(data.get('admin') or '').encode(), ADMIN_PASS.encode()):
                note_fail(ip)
                print(f'node-auth: неверный пароль администратора с {ip}', flush=True)
                return self.reply(403)
        jid = str(data.get('id') or '')
        try:
            if path.endswith('/setup'):
                job = {k: v for k, v in data.items() if k != 'admin'}
                host = (self.headers.get('X-Forwarded-Host') or self.headers.get('Host') or '').split(',')[0].strip().split(':')[0]
                job['stats_url'] = f'https://{host}:9443/node-stats/write'   # приёмник записи — на том же сервере, порт 9443
                print(f"node-auth: настройка ноды {job.get('name')} ({job.get('ip')}) с {ip}", flush=True)
                code, body = setup_call('/start', job)
            elif path.endswith('/fw'):
                job = {k: v for k, v in data.items() if k != 'admin'}
                job['admin_ip'] = ip   # ваш IP останется в правиле SSH — node-setup добавит его, если забыли
                print(f"node-auth: правка фаервола {job.get('name')} ({job.get('ip')}) с {ip}", flush=True)
                code, body = setup_call('/fw', job)
            elif path.endswith('/probe'):
                code, body = setup_call('/probe', {'ip': data.get('ip'), 'ports': data.get('ports')})
            elif not re.fullmatch(r'[0-9a-f]{16}', jid):
                return self.reply(400)
            elif path.endswith('/setup-status'):
                code, body = setup_call(f"/job/{jid}?from={int(data.get('from') or 0)}")
            else:
                code, body = setup_call(f'/cancel/{jid}', {})
        except (OSError, ValueError) as e:
            print(f'node-auth: node-setup недоступен: {e}', flush=True)
            return self.reply(502)
        return self.reply(code, [('Content-Type', 'application/json')] if body else [], body)


class Server(ThreadingHTTPServer):
    # дашборд при обновлении шлёт десятки запросов разом, и Caddy на каждый спрашивает нас (forward_auth).
    # Очередь соединений по умолчанию — 5: лишние отбрасывались, Caddy отвечал 502
    request_queue_size = 256
    daemon_threads = True


if __name__ == '__main__':
    print(f'node-auth: слушаю :{PORT}', flush=True)
    if RW_TOKEN:
        threading.Thread(target=tariffs_hourly, daemon=True).start()
    Server(('0.0.0.0', PORT), H).serve_forever()
