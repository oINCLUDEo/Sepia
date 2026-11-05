'use strict';
// Доступ: какие сервисы открываются через каждую ноду (node-check svc_check, раз в 30 минут) и репутация её IP
// (rep_check, раз в 3 часа). Логотипы — плитками в стиле значков приложений: Simple Icons (CC0); Яндекс, Ozon, WB —
// RuIcons (MIT, ruicons-font.ru); Сбер — Arcticons (CC BY-SA 4.0); у Госуслуг открытого логотипа нет — текстом

// g: world — зарубежное (смысл — для выходов), ru — российское (смысл — для мостов в РФ и для прямых подключений к выходам)
const SVC = [
  {id: 'youtube', name: 'YouTube', g: 'world', c: '#FF0000'}, {id: 'instagram', name: 'Instagram', g: 'world', c: '#E1306C'},
  {id: 'chatgpt', name: 'ChatGPT', g: 'world', c: '#10A37F', api: true}, {id: 'claude', name: 'Claude', g: 'world', c: '#D97757', api: true},
  {id: 'telegram', name: 'Telegram', g: 'world', c: '#26A5E4'}, {id: 'whatsapp', name: 'WhatsApp', g: 'world', c: '#25D366'},
  {id: 'discord', name: 'Discord', g: 'world', c: '#5865F2'}, {id: 'x', name: 'X', g: 'world', c: '#111111'},
  {id: 'spotify', name: 'Spotify', g: 'world', c: '#1DB954'}, {id: 'netflix', name: 'Netflix', g: 'world', c: '#E50914'},
  {id: 'gosuslugi', name: 'Госуслуги', g: 'ru', c: '#0D4CD3', txt: 'Гу'}, {id: 'sber', name: 'Сбер', g: 'ru', c: '#21A038'},
  {id: 'yandex', name: 'Яндекс', g: 'ru', c: '#FC3F1D'}, {id: 'vk', name: 'VK', g: 'ru', c: '#0077FF'},
  {id: 'ozon', name: 'Ozon', g: 'ru', c: '#005BFF', wide: true}, {id: 'wb', name: 'Wildberries', g: 'ru', c: '#A61CBC', wide: true},
];
const SVC_BY = Object.fromEntries(SVC.map(s => [s.id, s]));
const SLOW_MS = 3000;
// плитка-логотип; k — состояние: ok, warn, err, exp (ожидаемо закрыто), none
const svcTile = (s, k = 'ok', size = '') => `<span class="svc s-${k}${size ? ' ' + size : ''}${s.wide ? ' wide' : ''}" style="--b:${s.c}" aria-hidden="true">${s.txt ? `<b>${s.txt}</b>` : `<svg><use href="#b-${s.id}"/></svg>`}</span>`;

// что значит ответ: на мосту в РФ закрытый зарубежный сервис — ожидаемо (для того VPN и нужен), а не авария
function svcState(n, id){
  const s = SVC_BY[id], r = n.svc?.[id]; if (!r) return {k: 'none', t: 'нет данных'};
  const ru = n.cc === 'RU' || n.bridge, code = r.code, sec = r.ms / 1000;
  const good = s.api ? code === 401 || code === 200 : code >= 200 && code < 400;
  if (good) return sec * 1000 > SLOW_MS ? {k: 'warn', t: `медленно: ${fmt(sec, 1)} с`} : {k: 'ok', t: `работает, ${fmt(sec, 1)} с`};
  if (ru && s.g === 'world') return {k: 'exp', t: code ? `отказ HTTP ${code} — в РФ ожидаемо` : 'не открывается — в РФ ожидаемо'};
  if (s.api && code === 403) return {k: 'err', t: 'регион закрыт: сервис не обслуживает страну IP ноды'};
  if (!code) return {k: s.g === 'ru' && !ru ? 'warn' : 'err', t: s.g === 'ru' && !ru ? 'не открывается с зарубежного IP — нужен direct через мост' : 'нет ответа: блокировка или сбой сети'};
  if (code === 403 || code === 451) return {k: s.g === 'ru' && !ru ? 'warn' : 'err', t: s.g === 'ru' && !ru ? `не пускает зарубежные IP (HTTP ${code})` : `отказ HTTP ${code} — IP в чёрном списке сервиса`};
  // ответил, но не 2xx/3xx (400, 429, 498 у WB — антибот и т.п.): сеть до сервиса есть, он просто не любит автоматические запросы
  return {k: 'ok', t: `доступен (HTTP ${code} — сервис отклонил проверку как бота), ${fmt(sec, 1)} с`};
}
// какие сервисы показывать на карточке: выходу — зарубежные, мосту — российские
const svcFor = n => SVC.filter(s => s.g === (n.cc === 'RU' || n.bridge ? 'ru' : 'world'));
function svcStrip(n){
  if (!n.svc) return '';
  return `<div class="svcs" title="Сервисы через ноду — подробнее в «Доступе»">${svcFor(n).map(s => { const st = svcState(n, s.id); return `<span title="${esc(s.name)}: ${esc(st.t)}">${svcTile(s, st.k, 'sm')}</span>`; }).join('')}</div>`;
}
// репутация: в списке — плохо, капча Google — замечание
const REP = [['spamhaus', 'Spamhaus'], ['barracuda', 'Barracuda'], ['spamcop', 'SpamCop'], ['dronebl', 'DroneBL']];
function repState(n){
  const r = n.rep; if (!r) return null;
  const listed = REP.filter(([k]) => r[k] === 1).map(([, l]) => l);
  return listed.length ? {k: 'err', t: `IP в чёрном списке: ${listed.join(', ')}`} : r.captcha === 1 ? {k: 'warn', t: 'Google показывает капчу — IP на подозрении'} : {k: 'ok', t: 'IP чистый'};
}

/* ---------- данные ---------- */
const ACCESS_Q = {svc_c: 'last_over_time(node_svc_code[90m])', svc_ms: 'last_over_time(node_svc_ms[90m])', svc_at: 'tlast_over_time(node_svc_code[90m])',
  rep_at: 'tlast_over_time(node_rep_spamhaus[6h])', ...Object.fromEntries(['spamhaus', 'barracuda', 'spamcop', 'dronebl', 'captcha'].map(k => ['rep_' + k, `last_over_time(node_rep_${k}[6h])`]))};
// результаты по именам node-check -> ноды дашборда; у переименованной ноды берём самое свежее
function attachAccess(nodes, keyOf, R){
  const by = q => { const o = {}; for (const s of R[q] || []) (o[s.metric.node] ||= {})[s.metric.svc || '_'] = +s.value[1]; return o; };
  const c = by('svc_c'), ms = by('svc_ms'), at = by('svc_at');
  for (const [h, list] of Object.entries(c)) {
    const n = nodes[keyOf[h]]; if (!n) continue;
    for (const [id, code] of Object.entries(list)) { const t = at[h]?.[id] || 0; if (!n.svc?.[id] || n.svc[id].at < t) (n.svc ||= {})[id] = {code, ms: ms[h]?.[id] ?? 0, at: t}; }
  }
  const rat = by('rep_at');
  for (const [h, x] of Object.entries(rat)) {
    const n = nodes[keyOf[h]], t = x._; if (!n || (n.rep && n.rep.at >= t)) continue;
    n.rep = {at: t}; for (const k of ['spamhaus', 'barracuda', 'spamcop', 'dronebl', 'captcha']) { const v = by('rep_' + k)[h]?._; if (v != null) n.rep[k] = v; }
  }
}
function demoAccess(nodes){
  const now = Date.now() / 1000;
  for (const n of Object.values(nodes)) {
    if (n.seen == null || now - n.seen > 7200) continue;
    const ru = n.cc === 'RU' || n.bridge, h = [...n.key].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    n.svc = Object.fromEntries(SVC.map((s, i) => {
      let code = s.api ? 401 : 200, ms = 180 + ((h * (i + 3)) % 400);
      if (ru && s.g === 'world') ({youtube: () => { ms = 4600; }, instagram: () => { code = 0; ms = 8000; }, discord: () => { code = 0; ms = 8000; }, x: () => { code = 0; ms = 8000; },
        chatgpt: () => { code = 403; }, claude: () => { code = 403; }, spotify: () => { code = 0; ms = 8000; }}[s.id] || (() => {}))();
      if (!ru && s.id === 'gosuslugi' && h % 2) { code = 0; ms = 8000; }
      if (!ru && s.id === 'sber' && h % 3 === 0) code = 403;
      if (n.name === 'EE-INTEZIO' && s.id === 'chatgpt') code = 403;
      if (n.name === 'NL-TurtleGuard' && s.id === 'instagram') code = 403;
      return [s.id, {code, ms, at: now - 600}];
    }));
    n.rep = {at: now - 3600, spamhaus: n.name === 'DE-Aeza-2' ? 1 : 0, barracuda: 0, spamcop: 0, dronebl: 0, captcha: n.name === 'SE-Aeza' ? 1 : 0};
  }
}

/* ---------- раздел «Доступ» ---------- */
function renderAccess(){
  const N = state.model.nodes, rows = state.order.filter(k => N[k].svc), issues = state.accessIssues = [];
  for (const k of rows) {
    const n = N[k];
    for (const s of SVC) { const st = svcState(n, s.id); if (st.k === 'err' || (st.k === 'warn' && s.g === (n.cc === 'RU' || n.bridge ? 'ru' : 'world'))) issues.push({k: st.k, key: k, s, t: st.t}); }
    const rp = repState(n); if (rp && rp.k !== 'ok') issues.push({k: rp.k, key: k, t: rp.t, rep: true});
  }
  // сводка: по сервису — через какие ноды не открывается
  // нода, через которую не открывается половина сервисов, — одна карточка «проблемы с сетью», а не десяток по сервисам
  const errs = {}; for (const i of issues) if (i.s && i.k === 'err') (errs[i.key] ||= []).push(i.s.name);
  const broken = Object.keys(errs).filter(k => errs[k].length >= 5), byS = {};
  for (const i of issues.filter(i => i.s && i.k === 'err' && !broken.includes(i.key))) (byS[i.s.id] ||= []).push(N[i.key].name);
  const repBad = issues.filter(i => i.rep);
  $('#access-sum').innerHTML = !rows.length ? '' : (Object.keys(byS).length || repBad.length || broken.length)
    ? broken.map(k => `<div class="adv err" data-key="${esc(k)}" role="button" tabindex="0">${icon('globe')}<div><b>Через ${esc(N[k].name)} почти ничего не открывается: ${errs[k].length} из ${SVC.length}</b><p>${esc(errs[k].join(', '))}. Похоже на проблемы с сетью или DNS на самой ноде, а не на блокировки сервисов.</p></div></div>`).join('')
      + Object.entries(byS).map(([id, names]) => `<div class="adv err">${svcTile(SVC_BY[id], 'ok')}<div><b>${esc(SVC_BY[id].name)} не открывается через ${names.length === 1 ? 'ноду' : 'ноды'} ${esc(names.join(', '))}</b><p>${esc(svcState(N[issues.find(i => i.s?.id === id && i.k === 'err').key], id).t)}. ${names.length === 1 ? 'Пользователи этой ноды его не откроют' : 'Пользователи этих нод его не откроют'} — проверьте маршрутизацию или смените IP.</p></div></div>`).join('')
      + repBad.map(i => `<div class="adv ${i.k}" data-key="${esc(i.key)}" role="button" tabindex="0">${icon('shield-alert')}<div><b>${esc(N[i.key].name)}: ${esc(i.t)}</b><p>Сайты и банки начнут мешать пользователям. Проверьте IP на сайте списка и попросите хостера заменить адрес.</p></div></div>`).join('')
    : `<div class="adv">${icon('shield-check')}<div><b>Всё открывается</b><p>Через выходы доступны все зарубежные сервисы, мосты открывают российское напрямую, IP нод чистые.</p></div></div>`;
  if (!rows.length) { $('#access').innerHTML = '<p class="empty">Ноды ещё не присылали проверку сервисов — она появится после ночного обновления node-check (раз в 30 минут).</p>'; $('#rep').innerHTML = ''; return; }
  const head = g => SVC.filter(s => s.g === g).map(s => `<th class="c" title="${esc(s.name)}">${svcTile(s, 'ok')}</th>`).join('');
  const cell = (n, s) => { const st = svcState(n, s.id); return `<td class="c" title="${esc(s.name)}: ${esc(st.t)}"><i class="dotk k-${st.k}">${{ok: '✓', warn: '!', err: '✕', exp: '–', none: ''}[st.k]}</i></td>`; };
  $('#access').innerHTML = `<table class="acc"><thead><tr><th>Нода</th>${head('world')}<th class="sep"></th>${head('ru')}</tr></thead><tbody>` +
    rows.map(k => { const n = N[k]; return `<tr class="click" data-key="${esc(k)}" tabindex="0"><td>${flag(n.cc)}${esc(n.name)}<span class="sub">${n.bridge || n.cc === 'RU' ? 'мост в РФ' : 'выход'} · ${ago(Math.max(...Object.values(n.svc).map(r => r.at)))}</span></td>${SVC.filter(s => s.g === 'world').map(s => cell(n, s)).join('')}<td class="sep"></td>${SVC.filter(s => s.g === 'ru').map(s => cell(n, s)).join('')}</tr>`; }).join('') +
    '</tbody></table><p class="acc-legend"><i class="dotk k-ok">✓</i>работает <i class="dotk k-warn">!</i>медленно или не пускает зарубежные IP <i class="dotk k-err">✕</i>не открывается <i class="dotk k-exp">–</i>в РФ закрыто — ожидаемо</p>';
  const rr = state.order.filter(k => N[k].rep), mark = v => v === 1 ? '<span class="bad">в списке</span>' : v === 0 ? '<span class="muted">чисто</span>' : '—';
  $('#rep').innerHTML = rr.length ? `<table><thead><tr><th>Нода</th><th>IP</th>${REP.map(([, l]) => `<th>${l}</th>`).join('')}<th>Капча Google</th><th>Проверено</th></tr></thead><tbody>` +
    rr.map(k => { const n = N[k], r = n.rep; return `<tr class="click" data-key="${esc(k)}" tabindex="0"><td>${flag(n.cc)}${esc(n.name)}</td><td class="mono">${esc(ipsOf(n)[0] || '—')}</td>${REP.map(([x]) => `<td>${mark(r[x])}</td>`).join('')}<td>${r.captcha === 1 ? '<span class="meh">капча</span>' : r.captcha === 0 ? '<span class="muted">нет</span>' : '—'}</td><td class="muted">${ago(r.at)}</td></tr>`; }).join('') + '</tbody></table>'
    : '<p class="empty">Проверок репутации ещё не было.</p>';
}
for (const id of ['#access', '#rep', '#access-sum']) $(id).addEventListener('click', e => { const t = e.target.closest('[data-key]'); if (t) openNode(t.dataset.key); });

// для панели ноды: сервисы плитками с подписью и репутация
function drawerAccess(n){
  if (!n.svc && !n.rep) return '';
  const rp = repState(n);
  const tile = s => { const st = svcState(n, s.id); return `<div class="svcrow k-${st.k}">${svcTile(s, st.k)}<div><b>${esc(s.name)}</b><span>${esc(st.t)}</span></div></div>`; };
  const mine = svcFor(n), other = SVC.filter(s => !mine.includes(s));
  return (n.svc ? `<div class="dr-sec"><h3>Сервисы<span>${n.cc === 'RU' || n.bridge ? 'российское напрямую' : 'через этот выход'} · ${ago(Math.max(...Object.values(n.svc).map(r => r.at)))}</span></h3><div class="svcgrid">${mine.map(tile).join('')}</div>
    <details class="more" style="margin-top:12px"><summary>${n.cc === 'RU' || n.bridge ? 'Зарубежные' : 'Российские'} сервисы</summary><div class="svcgrid" style="margin-top:12px">${other.map(tile).join('')}</div></details></div>` : '')
    + (rp ? `<div class="dr-sec"><h3>Репутация IP<span>${ago(n.rep.at)}</span></h3><ul class="checks">${REP.map(([k, l]) => `<li class="s-${n.rep[k] === 1 ? 'err' : n.rep[k] === 0 ? 'ok' : 'off'}"><span>${l}</span><b>${n.rep[k] === 1 ? 'в списке' : n.rep[k] === 0 ? 'чисто' : '—'}</b></li>`).join('')}
      <li class="s-${n.rep.captcha === 1 ? 'warn' : 'ok'}"><span>Капча Google</span><b>${n.rep.captcha === 1 ? 'есть' : n.rep.captcha === 0 ? 'нет' : '—'}</b></li></ul></div>` : '');
}
