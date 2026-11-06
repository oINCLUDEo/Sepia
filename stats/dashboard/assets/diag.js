'use strict';
// Диагностика: автотрассировка (mtr сама при потерях или ретрансмитах — на каком участке пути проблема) и безопасность
// с обновлениями ОС (раз в сутки: обновления, перезагрузка, автообновления, SSH, фаервол, порты)

const DIAG_Q = {
  tr_loss: 'last_over_time(node_trace_loss[1d])', tr_ms: 'last_over_time(node_trace_ms[1d])', tr_run: 'last_over_time(node_trace_run[1d])',
  // ping цели сразу после трассировки: настоящие потери — им отличаем обрыв от узлов, молчащих на трассировку
  trm_loss: 'last_over_time(node_tracemeta_ploss[1d])', trm_ms: 'last_over_time(node_tracemeta_pms[1d])', trm_run: 'last_over_time(node_tracemeta_run[1d])',
  sec_at: 'tlast_over_time(node_sec_reboot[3d])',
  ...Object.fromEntries(['updates', 'sec_updates', 'reboot', 'unattended', 'ssh_password', 'root_login', 'firewall', 'uptime_days'].map(k => ['sec_' + k, `last_over_time(node_sec_${k}[3d])`])),
};
function attachDiag(nodes, keyOf, R){
  // трассировка: у каждой ноды — последний прогон (наибольший run), хопы по порядку
  const runs = {};
  for (const s of R.tr_run || []) { const h = s.metric.node, run = +s.value[1]; if (!runs[h] || run > runs[h]) runs[h] = run; }
  const val = (q, s) => (R[q] || []).find(x => x.metric.node === s.metric.node && x.metric.hop === s.metric.hop && x.metric.hip === s.metric.hip)?.value[1];
  for (const s of R.tr_run || []) {
    const h = s.metric.node, n = nodes[keyOf[h]]; if (!n || +s.value[1] !== runs[h]) continue;
    if (n.trace && n.trace.run > runs[h]) continue;
    if (!n.trace || n.trace.run < runs[h]) n.trace = {run: runs[h], target: s.metric.target, hops: []};
    n.trace.hops.push({hop: +s.metric.hop, ip: s.metric.hip === 'none' ? null : s.metric.hip, loss: +(val('tr_loss', s) ?? 0), ms: +(val('tr_ms', s) ?? 0)});
  }
  for (const n of Object.values(nodes)) n.trace?.hops.sort((a, b) => a.hop - b.hop);
  for (const s of R.trm_run || []) {
    const n = nodes[keyOf[s.metric.node]]; if (!n?.trace || +s.value[1] !== n.trace.run) continue;
    const g = q => { const x = (R[q] || []).find(y => y.metric.node === s.metric.node && y.metric.target === s.metric.target); return x ? +x.value[1] : null; };
    n.trace.ploss = g('trm_loss'); n.trace.pms = g('trm_ms');
  }
  // безопасность: самый свежий отчёт среди имён ноды
  for (const s of R.sec_at || []) {
    const h = s.metric.node, n = nodes[keyOf[h]], at = +s.value[1]; if (!n || (n.sec && n.sec.at >= at)) continue;
    const g = k => { const x = (R['sec_' + k] || []).find(y => y.metric.node === h); return x ? +x.value[1] : null; };
    n.sec = {at, ports: s.metric.ports ? s.metric.ports.split('+') : [], ...Object.fromEntries(['updates', 'sec_updates', 'reboot', 'unattended', 'ssh_password', 'root_login', 'firewall', 'uptime_days'].map(k => [k, g(k)]))};
  }
}
// Вывод по трассировке. Главное — ping цели (ploss): узлы магистрали часто не отвечают на служебные пакеты
// трассировки или отвечают через раз («???», 100% или 40% «потерь» посередине) — это не потери, если до цели доходит.
// Где начинаются настоящие потери: первый отвечающий хоп, с которого они держатся до конца пути
function traceVerdict(t){
  const hops = t.hops, seen = hops.filter(h => h.ip), last = seen.at(-1); if (!last) return null;
  const reached = last.ip === t.target, quiet = hops.some(h => !h.ip || (h.loss >= 2 && h !== last));
  const loss = t.ploss ?? (reached ? last.loss : null);
  const note = quiet ? ' Узлы посередине, которые не отвечают или отвечают через раз, просто не любят трассировку — это не потери.' : '';
  if (loss == null) return {k: 'warn', t: `трассировка не дошла до ${t.target}: дальше узлы не отвечают. Так бывает и без проблем — проверьте на ноде ping ${t.target}`};
  if (loss < 2) return {k: 'ok', t: `до ${t.target} пакеты доходят${t.ploss != null ? `: ping без потерь${t.pms ? `, ${fmt(t.pms, 0)} мс` : ''}` : ' без потерь'} — путь чистый.${note}`};
  if (loss >= 100) return {k: 'err', at: hops.indexOf(last) + 1 < hops.length ? hops.indexOf(last) + 1 : null,
    t: `${t.target} не отвечает даже на ping — путь оборван после ${last.hop}-го хопа (${last.ip})${hops.indexOf(last) <= 5 ? ': сразу за сетью хостера. Если до Яндекса и других российских адресов то же самое, а до Google нет, похоже на блокировку IP со стороны РФ' : ''}`};
  let from = hops.indexOf(last);
  while (from > 0 && (!hops[from - 1].ip || hops[from - 1].loss >= Math.min(2, loss / 2))) from--;
  while (from < hops.length - 1 && !hops[from].ip) from++;
  const h = hops[from];
  return {k: loss >= 10 ? 'err' : 'warn', at: from, t: `потери ${fmt(loss, loss % 1 ? 1 : 0)}% до ${t.target} начинаются на хопе ${h.hop} (${h.ip})${from <= 1 ? ' — сразу у ноды: сеть хостера' : h === last ? ' — у получателя' : ' — по пути, у транзитного провайдера'}`};
}
function drawerTrace(n){
  const t = n.trace; if (!t) return '';
  const v = traceVerdict(t);
  return `<div class="dr-sec"><h3>Трассировка<span>до ${esc(t.target)} · ${ago(t.run)} · нода сделала сама при потерях</span></h3>
    ${v ? `<p class="trv s-${v.k}">${icon(v.k === 'ok' ? 'circle-check' : 'route', 'si')}${esc(v.t)}</p>` : ''}
    <div class="table-wrap"><table class="trace"><thead><tr><th class="n">Хоп</th><th>Адрес</th><th class="n">Потери</th><th class="n">Задержка</th><th></th></tr></thead><tbody>${t.hops.map((h, i) => `<tr class="${v?.at != null && i >= v.at ? 'hot' : ''}"><td class="n">${h.hop}</td><td class="mono">${h.ip ? esc(h.ip) : '<span class="muted">не отвечает</span>'}</td>
      <td class="n ${h.loss >= 2 && h.ip && v?.at != null && i >= v.at ? 'bad' : ''}">${fmt(h.loss, h.loss % 1 ? 1 : 0)}%</td><td class="n">${h.ip ? fmt(h.ms, h.ms < 10 ? 1 : 0) + ' мс' : '—'}</td><td><span class="lbar${h.ip ? "" : " off"}"><i style="width:${Math.min(100, h.loss)}%"></i></span></td></tr>`).join('')}</tbody></table></div>
    <p class="note" style="margin-top:10px">Вручную на ноде: <code>sudo bash node-check.sh trace</code>. «Не отвечает» в середине пути — обычно роутер, который не отвечает на ICMP, а не потери.</p></div>`;
}

/* ---------- безопасность и обновления ОС ---------- */
// пункты чек-листа: k — ok / warn / err / off (нет данных)
function secItems(s){
  if (!s) return [];
  const it = (k, l, v) => ({k, l, v});
  return [
    it(s.firewall === 1 ? 'ok' : s.firewall === 0 ? 'err' : 'off', 'Фаервол', s.firewall === 1 ? 'включён, по умолчанию всё закрыто' : s.firewall === 0 ? 'не найден — открыто всё, что слушает' : '—'),
    it(s.ssh_password === 0 ? 'ok' : s.ssh_password === 1 ? 'err' : 'off', 'SSH по паролю', s.ssh_password === 0 ? 'выключен, только ключи' : s.ssh_password === 1 ? 'включён — пароль можно подбирать' : '—'),
    it(s.root_login === 2 ? 'warn' : s.root_login == null ? 'off' : 'ok', 'Вход root по SSH', s.root_login === 2 ? 'разрешён с паролем' : s.root_login === 1 ? 'только по ключу' : s.root_login === 0 ? 'запрещён' : '—'),
    it(s.sec_updates > 0 ? 'warn' : s.sec_updates === 0 ? 'ok' : 'off', 'Обновления безопасности', s.sec_updates == null ? '—' : s.sec_updates ? `ждут ${fmt(s.sec_updates)} (всего ${fmt(s.updates)})` : s.updates ? `нет; обычных ${fmt(s.updates)}` : 'всё установлено'),
    it(s.unattended === 1 ? 'ok' : 'warn', 'Автообновления', s.unattended === 1 ? 'включены' : 'выключены — обновления безопасности не ставятся сами'),
    it(s.reboot === 1 ? 'warn' : 'ok', 'Перезагрузка', s.reboot === 1 ? 'нужна: новое ядро или библиотеки ещё не работают' : `не нужна; работает ${fmt(s.uptime_days)} дн`),
  ];
}
const secWorst = s => { const ks = secItems(s).map(i => i.k); return ks.includes('err') ? 'err' : ks.includes('warn') ? 'warn' : 'ok'; };
const SEC_FIX = {
  'Фаервол': 'sudo DOMAIN=домен ./provision-node.sh — ставит nftables: наружу только 80 и 443',
  'SSH по паролю': 'PasswordAuthentication no в /etc/ssh/sshd_config, затем systemctl reload ssh',
  'Вход root по SSH': 'PermitRootLogin prohibit-password в /etc/ssh/sshd_config, затем systemctl reload ssh',
  'Обновления безопасности': 'apt-get update && apt-get upgrade -y',
  'Автообновления': 'apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive unattended-upgrades',
  'Перезагрузка': 'reboot в тихий час',
};
function drawerSec(n){
  const s = n.sec; if (!s) return '';
  return `<div class="dr-sec"><h3>Безопасность и ОС<span>${ago(s.at)}</span></h3><ul class="checks">${secItems(s).map(i => `<li class="s-${i.k}"><span>${i.l}</span><b>${esc(i.v)}</b></li>`).join('')}
    <li class="s-off"><span>Слушают снаружи</span><b>${s.ports.length ? s.ports.map(esc).join(', ') : '—'}</b></li></ul>
    ${secItems(s).filter(i => i.k === 'err' || i.k === 'warn').map(i => `<p class="fix">${icon('terminal', 'si')}<span><b>${i.l}:</b> <code>${esc(SEC_FIX[i.l])}</code></span></p>`).join('')}</div>`;
}
function renderSecurity(){
  const N = state.model.nodes, rows = state.order.filter(k => N[k].sec), el = $('#sec');
  if (!el) return;
  if (!rows.length) { el.innerHTML = '<p class="empty">Проверок ещё не было — ноды делают её ночью, после обновления node-check. Сейчас вручную: <code>sudo bash node-check.sh security</code></p>'; return; }
  const cell = i => `<td class="c" title="${esc(i.l)}: ${esc(i.v)}"><i class="dotk k-${i.k === 'off' ? 'exp' : i.k}">${{ok: '✓', warn: '!', err: '✕', off: '–'}[i.k]}</i></td>`;
  el.innerHTML = `<table class="acc sec"><thead><tr><th>Нода</th>${secItems(N[rows[0]].sec).map(i => `<th class="c">${i.l.replace(' по SSH', '').replace('Обновления безопасности', 'Обновления')}</th>`).join('')}<th>Порты снаружи</th><th>Проверено</th></tr></thead><tbody>` +
    rows.map(k => { const n = N[k]; return `<tr class="click" data-key="${esc(k)}" tabindex="0"><td>${flag(n.cc)}${esc(n.name)}</td>${secItems(n.sec).map(cell).join('')}<td class="mono">${n.sec.ports.join(', ') || '—'}</td><td class="muted">${ago(n.sec.at)}</td></tr>`; }).join('') + '</tbody></table>';
  for (const k of rows) { const bad = secItems(N[k].sec).filter(i => i.k === 'err' || i.k === 'warn');
    if (bad.length) (state.accessIssues ||= []).push({k: bad.some(i => i.k === 'err') ? 'err' : 'warn', key: k, t: bad.map(i => `${i.l.toLowerCase()} — ${i.v}`).join('; '), sec: true}); }
}
$('#sec').addEventListener('click', e => { const t = e.target.closest('[data-key]'); if (t) openNode(t.dataset.key); });
function demoDiag(nodes){
  const now = Date.now() / 1000;
  for (const n of Object.values(nodes)) {
    if (n.seen == null || now - n.seen > 7200) continue;
    const bad = n.name === 'DE-Aeza-2' || n.name === 'RU-RuVDS';
    n.sec = {at: now - 5 * 3600, ports: ['22', '80', '443', '2222'], updates: bad ? 23 : 2, sec_updates: bad ? 7 : 0, reboot: n.name === 'EE-StenCloud' ? 1 : 0, unattended: bad ? 0 : 1,
      ssh_password: n.name === 'RU-RuVDS' ? 1 : 0, root_login: 1, firewall: 1, uptime_days: 41};
  }
  const de = Object.values(nodes).find(n => n.name === 'DE-Aeza-2');
  if (de) de.trace = {run: now - 40 * 60, target: '77.88.8.8', hops: [[1, '10.0.0.1', 0, .4], [2, '185.12.1.1', 0, 1.2], [3, '80.81.192.1', 0, 3.1], [4, null, 100, 0], [5, '213.248.1.9', 6, 31], [6, '188.254.2.4', 7, 38], [7, '77.88.8.8', 7, 41]]
    .map(([hop, ip, loss, ms]) => ({hop, ip, loss, ms})), ploss: 6, pms: 41};
}
