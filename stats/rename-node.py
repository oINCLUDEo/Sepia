#!/usr/bin/env python3
"""rename-node.py — перенести историю ноды в VictoriaMetrics со старого имени на новое.

Нужно после переименования ноды в node-check (меню -> 6): новые снимки идут под новым именем, а графики и
журнал за прошлые дни остаются под старым, и дашборд их не склеит, если у старых снимков не было метки ip.

  python3 rename-node.py --list                  # имена в базе: последний снимок, IP, сколько точек
  python3 rename-node.py СТАРОЕ НОВОЕ --dry-run  # что будет перенесено, ничего не меняя
  python3 rename-node.py СТАРОЕ НОВОЕ            # перенести и удалить старое имя

Запускать на сервере панели: VictoriaMetrics слушает 127.0.0.1:8428 без пароля. Метки ip, cc, to берутся у нового
имени, чтобы старые и новые точки легли в одни и те же серии.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VM = 'http://127.0.0.1:8428/node-stats'


def call(path, params=None, data=None):
    url = VM + path + ('?' + urllib.parse.urlencode(params, doseq=True) if params else '')
    req = urllib.request.Request(url, data=data, method='POST' if data is not None else 'GET')
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def export(name):
    raw = call('/api/v1/export', {'match[]': '{node=%s}' % json.dumps(name), 'start': 0})
    return [json.loads(line) for line in raw.decode().splitlines() if line.strip()]


def names():
    res = json.loads(call('/api/v1/query', {'query': 'max by (node, ip, cc) (tlast_over_time(node_quick_cpu_us[180d]))'}))['data']['result']
    for s in sorted(res, key=lambda s: -float(s['value'][1])):
        m, ts = s['metric'], float(s['value'][1])
        print(f"  {m.get('node', '?'):24} последний снимок {time.strftime('%d.%m %H:%M', time.localtime(ts)):12} ip={m.get('ip', '—'):16} cc={m.get('cc', '—')}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if '--list' in sys.argv:
        return names()
    if len(args) != 2:
        sys.exit(__doc__)
    old, new, dry = args[0], args[1], '--dry-run' in sys.argv
    if old == new:
        sys.exit('Имена совпадают.')
    rows = export(old)
    if not rows:
        sys.exit(f'Под именем «{old}» в базе ничего нет. Список имён: python3 {sys.argv[0]} --list')
    # метки нового имени: ip, cc, to — у его последних снимков
    keep = {}
    for r in export(new):
        if r['metric'].get('__name__', '').startswith('node_quick'):
            keep = {k: r['metric'][k] for k in ('ip', 'cc', 'to') if k in r['metric']}
            if 'ip' in keep:
                break
    points = sum(len(r['timestamps']) for r in rows)
    first = min(min(r['timestamps']) for r in rows) / 1000
    last = max(max(r['timestamps']) for r in rows) / 1000
    print(f'«{old}» -> «{new}»: {len(rows)} серий, {points} точек, {time.strftime("%d.%m %H:%M", time.localtime(first))} — '
          f'{time.strftime("%d.%m %H:%M", time.localtime(last))}. Метки нового имени: {keep or "нет (новое имя ещё не присылало снимков)"}')
    if dry:
        return print('--dry-run: ничего не изменено.')
    # точки, которые уже лежат под новым именем с тем же временем (повторный запуск), второй раз не пишем —
    # иначе count_over_time удвоится и доступность выйдет завышенной
    key = lambda m: json.dumps(sorted(m.items()))
    have = {}
    for r in export(new):
        have.setdefault(key(r['metric']), set()).update(r['timestamps'])
    out, skipped = [], 0
    for r in rows:
        m = dict(r['metric'], node=new, **keep)
        seen = have.get(key(m), set())
        pairs = [(v, t) for v, t in zip(r['values'], r['timestamps']) if t not in seen]
        skipped += len(r['timestamps']) - len(pairs)
        if pairs:
            out.append(json.dumps({'metric': m, 'values': [v for v, _ in pairs], 'timestamps': [t for _, t in pairs]}))
    if skipped:
        print(f'{skipped} точек уже есть под новым именем — пропускаю.')
    if out:
        call('/api/v1/import', data=('\n'.join(out) + '\n').encode())
    call('/internal/force_flush')
    moved = sum(len(set(r['timestamps'])) for r in export(new))
    if moved < len({(json.dumps(sorted(dict(r['metric'], node=new, **keep).items())), t) for r in rows for t in r['timestamps']}):
        # перестраховка: старое удаляем, только если под новым именем есть все его точки
        sys.exit(f'Под новым именем {moved} точек, ожидалось не меньше {points}. Старое имя не удалено, проверь вручную.')
    call('/api/v1/admin/tsdb/delete_series', data=urllib.parse.urlencode({'match[]': '{node=%s}' % json.dumps(old)}).encode())   # только POST
    print(f'Готово: история перенесена, «{old}» удалено. Дашборд покажет её после обновления страницы.')


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f'VictoriaMetrics ответила HTTP {e.code} на {e.url}: {e.read().decode(errors="replace")[:300]}')
    except urllib.error.URLError as e:
        sys.exit(f'VictoriaMetrics не отвечает на {VM}: {e}. Запускать на сервере панели, контейнер node-stats должен работать.')
