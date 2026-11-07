'use strict';
// «Рынок»: разбор тестовых подписок других VPN — на каких хостерах, транспортах и SNI они держат серверы.
// Подписку скачивает и разбирает node-setup (через node-auth /auth/comp-*), через пробник (PROBE_URL): ключи (UUID, пароли,
// shortId) не сохраняются; ссылка — только если попросить (для «Обновить»), в браузер она не возвращается.
// Вид: строка ввода → карточки конкурентов (выбор) → вкладки: сравнение / серверы, где размещаются, память / история

const comp = {items: null, via: '', ours: {}, err: '', busy: false, at: 0, sel: '', tab: '', adding: '', addErr: ''};
const NET_NAME = {tcp: 'TCP', raw: 'TCP', grpc: 'gRPC', xhttp: 'XHTTP', splithttp: 'XHTTP', ws: 'WS', httpupgrade: 'HTTPUpgrade', h2: 'H2', http: 'H2', kcp: 'mKCP', quic: 'QUIC', udp: 'UDP'};
const PROTO_NAME = {vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', hysteria2: 'Hysteria2', hysteria: 'Hysteria', tuic: 'TUIC', wireguard: 'WireGuard'};
const transportOf = s => [PROTO_NAME[s.proto] || s.proto, s.proto === 'shadowsocks' || s.proto.startsWith('hysteria') || s.proto === 'tuic' ? '' : NET_NAME[s.net] || s.net,
  s.sec && s.sec !== 'none' && !s.proto.startsWith('hysteria') ? (s.sec === 'reality' ? 'Reality' : s.sec.toUpperCase()) : ''].filter(Boolean).join(' · ');
// названия хостеров из реестра длинные и капсом: «U1 DIGITAL SERVICES LTD» → «U1 Digital Services»
const hosterName = s => {
  const h = s.hoster || s.as_name || (s.asn ? 'AS' + s.asn : s.ip ? 'неизвестный хостер' : 'адрес не найден');
  return h.replace(/,?\s+(LTD|LLC|L\.L\.C|INC|GMBH|SRL|S\.R\.L|B\.V|BV|OOO|LIMITED|CORP)\.?$/i, '').replace(/\b([A-Z])([A-Z]{3,})\b/g, (m, a, b) => a + b.toLowerCase());
};
const base2 = d => (d || '').toLowerCase().split('.').slice(-2).join('.');
const isDomain = d => /[a-z]/i.test(d || '') && (d || '').includes('.');
// маскировка: свой домен (SNI — их же домен, self-steal) или чужой сайт (ads.x5.ru и т.п.)
// свой домен понятен и когда сервер задан IP: если в подписке на одном домене много разных SNI (n0.x.net, n1.x.net…) —
// это их домен; чужой сайт (ads.x5.ru) обычно один и тот же на всех серверах
const OWN = new WeakMap();
function ownBases(servers){
  if (OWN.has(servers)) return OWN.get(servers);
  const by = {}; for (const s of servers) if (s.sni) (by[base2(s.sni)] ||= new Set()).add(s.sni.toLowerCase());
  const own = new Set([...servers.filter(s => isDomain(s.addr)).map(s => base2(s.addr)), ...Object.keys(by).filter(b => by[b].size >= 3)]);
  OWN.set(servers, own); return own;
}
const SRV_OF = new WeakMap();   // сервер -> массив серверов его подписки (для ownBases)
function sniKind(s){
  if (!s.sni) return null;
  if (isDomain(s.addr) && base2(s.sni) === base2(s.addr)) return {k: 'own', t: 'свой домен'};
  const all = SRV_OF.get(s); if (all && ownBases(all).has(base2(s.sni))) return {k: 'own', t: 'свой домен'};
  return {k: 'foreign', t: s.sni};
}
// вход для белых списков мобильного интернета: сервер в РФ (обычно облако из белого списка)
const RU_CLOUD = /yandex|vk ?cloud|vkontakte|mail\.ru|selectel|timeweb|cloud\.ru|sbercloud|mts|rostelecom|beget|reg\.ru|selectel/i;
// по реальному расположению (страна по реестру, облако РФ) или пометке в названии — страна в названии бывает страной выхода
const isWhite = s => s.cc === 'RU' || RU_CLOUD.test(s.hoster || s.as_name || '') || /white|бел/i.test(s.remark || '');
const remarkFlag = r => (r || '').replace(/^(?:\s*(?:[\u{1F1E6}-\u{1F1FF}]{2}|[A-Z]{2}\b)\s*)+/u, '');   // «🇷🇺 RU Russia» → «Russia»
// страна сервера — из названия (флаг-эмодзи или «FI …»): страна по реестру — это где зарегистрирован хостер, а не где стоит сервер
const EN_CC = {finland: 'FI', netherlands: 'NL', germany: 'DE', russia: 'RU', sweden: 'SE', latvia: 'LV', estonia: 'EE', poland: 'PL', france: 'FR', 'united kingdom': 'GB', uk: 'GB', usa: 'US', 'united states': 'US', turkey: 'TR', kazakhstan: 'KZ', lithuania: 'LT', moldova: 'MD', switzerland: 'CH', austria: 'AT', japan: 'JP', singapore: 'SG', 'hong kong': 'HK',
  'финляндия': 'FI', 'нидерланды': 'NL', 'германия': 'DE', 'россия': 'RU', 'швеция': 'SE', 'латвия': 'LV', 'эстония': 'EE', 'польша': 'PL', 'франция': 'FR', 'турция': 'TR', 'казахстан': 'KZ', 'литва': 'LT', 'молдова': 'MD', 'швейцария': 'CH', 'австрия': 'AT', 'сша': 'US', 'великобритания': 'GB', 'япония': 'JP'};
function ccOfRemark(r){
  r = r || '';
  const em = r.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u); if (em) return [...em[0]].map(ch => String.fromCharCode(ch.codePointAt(0) - 0x1F1E6 + 65)).join('');
  const lc = r.toLowerCase(); for (const [k, v] of Object.entries(EN_CC)) if (lc.includes(k)) return v;
  const m = r.match(/^([A-Z]{2})\b/); return m ? m[1] : '';
}
const ccOfS = s => ccOfRemark(s.remark) || s.cc || '';

async function loadComp(fresh = false){
  if (comp.busy || (!fresh && comp.items && Date.now() - comp.at < 600000)) return renderComp();
  comp.busy = true; comp.err = ''; renderComp();
  try {
    if (DEMO) { comp.items ||= demoComp(); comp.ours = demoCompOurs(); comp.via = '95.163.10.20'; comp.probe = {on: true, ip: '95.163.10.20', cc: 'RU'}; comp.dossiers = Object.fromEntries(compAllIps().map(x => [x.ip, demoDossier(x.ip)])); comp.kb = demoKb(); }
    else {
      const r = await auth('comp-list', {});
      if (r.status === 401) throw new Error('Войдите заново — сессия истекла');
      if (r.status === 502) throw new Error('node-setup не отвечает: docker compose up -d setup');
      if (r.status === 404) throw new Error('Сервер панели работает на старой версии: git pull, затем docker compose up -d --force-recreate auth setup');
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const j = await r.json(); comp.items = Array.isArray(j) ? j : j.items || []; comp.via = Array.isArray(j) ? '' : j.via || ''; comp.probe = j.probe || {}; comp.dossiers = j.dossiers || {}; comp.kb = j.kb || null;
      const ips = [...new Set(Object.values(state.model?.nodes || {}).flatMap(n => ipsOf(n)))].filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      if (ips.length) { const a = await auth('comp-asn', {ips}); if (a.status === 200) comp.ours = await a.json(); }
    }
    comp.at = Date.now();
    clearTimeout(comp.poll); comp.poll = null;
  } catch (e) { comp.err = e.message; }
  comp.busy = false; renderComp();
}

async function compAdd(refreshName){
  const url = refreshName ? '' : $('#cmp-url').value.trim(), text = refreshName ? '' : $('#cmp-text').value;
  if (!refreshName && !url && !text.trim()) { comp.addErr = 'Вставьте ссылку на подписку'; return renderCompForm(); }
  comp.adding = refreshName || '+'; comp.addErr = ''; renderCompForm(); if (refreshName) renderComp();
  try {
    let e;
    if (DEMO) { await pause(900); const d = demoComp()[0]; e = refreshName ? {...comp.items.find(x => x.name === refreshName), at: Date.now() / 1000, diff: {prev_at: Date.now() / 1000 - 86400, added: ['🇵🇱 Польша'], removed: [], ip: ['🇩🇪 Германия: 45.88.1.10 → 45.88.1.77']}}
      : {...d, name: $('#cmp-name').value.trim() || 'Новый конкурент', at: Date.now() / 1000, diff: null}; }
    else {
      const body = refreshName ? {name: refreshName} : {name: $('#cmp-name').value.trim(), url, text, ua: $('#cmp-ua').value};
      const r = await auth(refreshName ? 'comp-refresh' : 'comp-add', body), j = await r.json().catch(() => ({}));
      if (r.status !== 200) throw new Error(j.error || (r.status === 502 ? 'node-setup не отвечает' : r.status === 404 ? 'Сервер панели на старой версии: git pull, затем docker compose up -d --force-recreate auth setup' : 'HTTP ' + r.status));
      e = j;
    }
    comp.items = [...(comp.items || []).filter(x => x.name !== e.name), e]; comp.sel = e.name; comp.tab = 'srv';
    if (!refreshName) { $('#cmp-url').value = ''; $('#cmp-text').value = ''; $('#cmp-name').value = ''; }
  } catch (err) { if (refreshName) toast('Не обновилось: ' + err.message); else comp.addErr = err.message; }
  comp.adding = ''; renderCompForm(); renderComp();
}

function renderCompForm(){
  const b = $('#cmp-go'); if (!b) return;
  b.disabled = !!comp.adding; b.innerHTML = comp.adding === '+' ? `${icon('loader')}Разбираю…` : `${icon('search')}Разобрать`;
  $('#cmp-err').textContent = comp.addErr;
}

// Вид страницы: ряд карточек (все / каждый конкурент) → вкладки → содержимое вкладки.
// Карточка: число серверов и полоса состояний (работают / не поднимается VPN / не открываются / не проверяли)
const vview = e => ({...e, servers: e.servers.filter(x => !x.gone_at), goneList: e.servers.filter(x => x.gone_at)});
const andMore = (arr, k = 3) => arr.length > k ? `${arr.slice(0, k).join(', ')} и ещё ${arr.length - k}` : arr.join(', ');
const topOf = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const ST_ORDER = [['ok', 'работают'], ['warn', 'VPN не поднимается'], ['err', 'не открываются'], ['run', 'проверяю'], ['off', 'не проверяли']];
const STAT = new WeakMap();
function compStat(e){
  if (STAT.has(e)) return STAT.get(e);
  for (const x of e.servers) SRV_OF.set(x, e.servers);
  const gs = ipGroups(e), c = {ok: 0, warn: 0, err: 0, off: 0, run: 0};
  for (const g of gs) c[srvState(g, e).k]++;
  const own = e.servers.filter(x => sniKind(x)?.k === 'own').length, foreign = topOf(e.servers.filter(x => sniKind(x)?.k === 'foreign'), x => x.sni);
  const exits = e.servers.flatMap(x => (x.exits || []).filter(y => y.ip !== x.ip));
  const r = {gs, c, n: gs.length, cc: new Set(e.servers.map(ccOfS).filter(Boolean)), tr: topOf(e.servers, x => trShort(transportOf(x))),
    hos: topOf(e.servers.filter(x => x.ip && (x.hoster || x.as_name || x.asn)), hosterName), exits: topOf(exits, hosterName),
    white: [...new Set(e.servers.filter(x => isWhite(x) && x.ip).map(hosterName))], own, foreign, ports: topOf(e.servers.filter(x => x.port && x.port !== '443'), x => x.port)};
  STAT.set(e, r); return r;
}
const stBar = c => { const t = Object.values(c).reduce((a, b) => a + b, 0) || 1;
  return `<span class="mk-bar" role="img" aria-label="${ST_ORDER.filter(([k]) => c[k]).map(([k, l]) => `${c[k]} ${l}`).join(', ')}">${ST_ORDER.filter(([k]) => c[k]).map(([k]) => `<i class="b-${k}" style="flex:${c[k] / t}"></i>`).join('')}</span>`; };
const stLegend = c => ST_ORDER.filter(([k]) => c[k]).map(([k, l]) => `<span class="lg"><i class="b-${k}"></i>${c[k]} ${l}</span>`).join('');
const sumC = list => list.reduce((a, e) => { for (const k in a) a[k] += compStat(e).c[k]; return a; }, {ok: 0, warn: 0, err: 0, off: 0, run: 0});

function compStatus(e){   // одна короткая пометка на карточке: что-то требует внимания
  const d = e.diff, ch = d && (d.added.length + d.removed.length + d.ip.length);
  if (e.probe?.running) return `<span class="mk-note">${icon('loader', 'ic spin')}проверяю${e.probe.total ? ` ${e.probe.progress || 0} из ${e.probe.total}` : ''}</span>`;
  if (e.expired_at) return `<span class="mk-note" title="Сервис отдал заглушку вместо подписки — разбор и история сохранены">${icon('clock-alert')}подписка кончилась</span>`;
  if (e.fail) return `<span class="mk-note warn" title="${esc(e.fail.error)}">${icon('triangle-alert')}не обновилось</span>`;
  if (e.probe?.failed) return `<span class="mk-note warn" title="${esc(e.probe.failed)}">${icon('triangle-alert')}проверка не прошла</span>`;
  if (ch) return `<span class="mk-note acc">${icon('history')}${ch} ${plural(ch, 'изменение', 'изменения', 'изменений')}</span>`;
  return '';
}

function compRail(items){
  const all = sumC(items), n = items.reduce((a, e) => a + compStat(e).n, 0);
  const card = (key, name, big, sub, c, note, at) => `<button class="mk-pick${comp.sel === key ? ' on' : ''}" data-pick="${esc(key)}" aria-pressed="${comp.sel === key}">
      <span class="mk-pk-h"><b>${name}</b>${at ? `<span class="muted">${at}</span>` : ''}</span>
      <span class="mk-pk-n"><span class="num" data-count="${big}">${big}</span><span>${sub}</span></span>
      ${stBar(c)}<span class="mk-pk-f">${note || `<span class="muted">${c.ok} из ${Object.values(c).reduce((a, b) => a + b, 0)} работают</span>`}</span></button>`;
  return `<div class="mk-rail">${items.length > 1 ? card('', 'Все конкуренты', n, `${plural(n, 'сервер', 'сервера', 'серверов')} у ${items.length}`, all, '', '') : ''}
    ${items.map(e => { const st = compStat(e); return card(e.name, esc(e.name), st.n, `${plural(st.n, 'сервер', 'сервера', 'серверов')}${st.tr[0] ? ' · ' + esc(st.tr[0][0]) : ''}`, st.c, compStatus(e), ago(e.at)); }).join('')}</div>`;
}

const TABS = {'': [['cmp', 'Сравнение'], ['host', 'Где размещаются'], ['mem', 'Память']], one: [['srv', 'Серверы'], ['host', 'Где размещаются'], ['hist', 'История']]};
function compTabs(){
  const list = TABS[comp.sel ? 'one' : ''];
  if (!list.some(([k]) => k === comp.tab)) comp.tab = list[0][0];
  return `<div class="seg mk-tabs" role="tablist"><span class="thumb"></span>${list.map(([k, l]) => `<button role="tab" data-mtab="${k}" aria-pressed="${comp.tab === k}">${l}</button>`).join('')}</div>`;
}

// сравнение: строки — вопросы, столбцы — конкуренты; ответ в клетке коротким текстом
function compMatrix(items){
  const oursAsn = new Set(Object.values(comp.ours || {}).map(x => x?.asn).filter(Boolean));
  const oursHos = new Set(items.flatMap(e => e.servers.filter(x => x.asn && oursAsn.has(x.asn)).map(hosterName)));
  const hl = h => oursHos.has(h) ? `<span class="mk-ours" title="Здесь же стоят наши ноды">${esc(h)}</span>` : esc(h);
  const rows = [
    ['Серверов', e => { const st = compStat(e); return `<b class="num">${st.n}</b><span class="sub">в ${st.cc.size} ${plural(st.cc.size, 'стране', 'странах', 'странах')}</span>`; }],
    ['Открываются из РФ', e => { const c = compStat(e).c, t = Object.values(c).reduce((a, b) => a + b, 0), chk = c.ok + c.warn + c.err;
      return chk ? `${stBar(c)}<span class="sub">${c.ok} из ${t} работают${c.err ? `, ${c.err} не ${plural(c.err, 'открывается', 'открываются', 'открываются')}` : ''}</span>` : '<span class="muted">ещё не проверяли</span>'; }],
    ['Протокол', e => { const t = compStat(e).tr; return t.length ? `${esc(t[0][0])}${t.length > 1 ? `<span class="sub">ещё ${esc(t.slice(1, 3).map(x => x[0]).join(', '))}</span>` : ''}` : '—'; }],
    ['Маскировка', e => { const st = compStat(e); return st.own >= (st.foreign[0]?.[1] || 0) ? `свой домен${st.foreign.length ? `<span class="sub">иногда ${esc(st.foreign[0][0])}</span>` : ''}` : `под ${esc(st.foreign[0][0])}${st.own ? '<span class="sub">иногда свой домен</span>' : ''}`; }],
    ['Сервер в России', e => { const w = compStat(e).white; return w.length ? `<span class="ok-t">есть</span><span class="sub">${esc(andMore(w, 2))}</span>` : '<span class="muted">нет — белые списки не обходит</span>'; }],
    ['Главный хостинг', e => { const h = compStat(e).hos; return h.length ? `${hl(h[0][0])}${h.length > 1 ? `<span class="sub">ещё ${h.length - 1}: ${h.slice(1, 3).map(x => hl(x[0])).join(', ')}</span>` : ''}` : '—'; }],
    ['Мосты выводят на', e => { const x = compStat(e).exits; return x.length ? `${hl(x[0][0])}${x.length > 1 ? `<span class="sub">ещё ${esc(x.slice(1, 3).map(y => y[0]).join(', '))}</span>` : ''}` : '<span class="muted">мостов нет</span>'; }],
    ['Порты', e => { const p = compStat(e).ports; return p.length ? `443 и ${esc(andMore(p.map(x => x[0]), 3))}` : '443'; }],
  ];
  const note = oursHos.size ? `<p class="mk-mx-note"><span class="mk-ours">Зелёным</span> — хостинг, где стоят и наши ноды.</p>` : '';
  return `<div class="table-wrap mk-mx-wrap"><table class="mk-mx"><thead><tr><th></th>${items.map(e => `<th><button class="mk-mx-h" data-pick="${esc(e.name)}">${esc(e.name)}${icon('chevron-right')}</button></th>`).join('')}</tr></thead>
    <tbody>${rows.map(([l, f]) => `<tr><th scope="row">${l}</th>${items.map(e => `<td>${f(e)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="mk-mx-cards">${items.map(e => `<div class="mk-mx-card"><button class="mk-mx-h" data-pick="${esc(e.name)}">${esc(e.name)}${icon('chevron-right')}</button><dl>${rows.map(([l, f]) => `<div><dt>${l}</dt><dd>${f(e)}</dd></div>`).join('')}</dl></div>`).join('')}</div>${note}`;
}

function compHead(e){
  const src = [e.title && e.title !== e.name ? `в приложении «${esc(e.title)}»` : '', e.via === 'text' ? 'вставлено текстом' : e.via ? `скачано через ${esc(nodeByIp(e.via) || 'пробник')}` : '', `разобрано ${ago(e.at)}`].filter(Boolean).join(' · ');
  return `<div class="mk-one-h"><div><h3>${esc(e.name)}</h3><span class="sub">${src}</span></div><div class="mk-one-act">
      ${e.refresh ? `<button class="pill" data-cmp-refresh="${esc(e.name)}"${comp.adding ? ' disabled' : ''}>${icon(comp.adding === e.name ? 'loader' : 'refresh-cw')}${comp.adding === e.name ? 'Обновляю…' : 'Обновить'}</button>` : ''}
      <button class="icon-btn" data-cmp-del="${esc(e.name)}" title="Удалить разбор" aria-label="Удалить разбор">${icon('trash-2')}</button></div></div>`;
}
function compOne(e){
  const st = compStat(e), f = comp.f[e.name] ||= {cc: '', q: '', all: false};
  return `${Object.values(st.c).filter(Boolean).length > 1 ? `<div class="mk-legend">${stLegend(st.c)}</div>` : ''}
    ${compCountries(e)}
    ${st.n > 8 ? `<input class="mk-q" type="search" placeholder="Найти: страна, хостер, IP, SNI" value="${esc(f.q)}" data-cmp-q="${esc(e.name)}" autocomplete="off">` : ''}
    <div data-cmp-tbl="${esc(e.name)}">${compTable(e)}</div>`;
}

function compHist(e){
  const H = (comp.kb?.history || []).filter(r => r.name === e.name);
  return `${compDiff(e.diff) || '<p class="muted mk-pad">С прошлого разбора ничего не поменялось.</p>'}
    ${H.length ? `<h4 class="mk-h4">Все разборы</h4><div class="mk-feed">${H.slice(0, 40).map(feedRow).join('')}</div>` : ''}`;
}

// пока идёт проверка — опрашиваем сервер. Раньше опрос включался только при загрузке раздела, а после «Разобрать» и
// «Обновить» — нет: проверка шла, а на экране застывало «проверяю 0 из 30», пока раздел не перезагрузят
function compSchedule(){
  if (DEMO || comp.poll || !(comp.items || []).some(e => e.probe?.running || e.servers.some(x => x.probing))) return;
  comp.poll = setTimeout(() => { comp.poll = null; if (state.vw === 'market') loadComp(true); }, 6000);
}
function renderComp(){
  compSchedule();
  const el = $('#comp'); if (!el) return;
  const via = $('#comp-via');
  if (via) via.innerHTML = comp.items == null ? '' : comp.probe?.on ? (comp.probe.error ? `<span class="mk-probe bad" title="${esc(comp.probe.error)}">${icon('shield-alert')}Пробник недоступен</span>`
      : `<span class="mk-probe" title="Подписки, выходы и доступность проверяются только отсюда">${icon('shield-check')}Пробник ${comp.probe.cc ? flag(comp.probe.cc) : ''}<span class="mono">${esc(comp.probe.ip || comp.via)}</span></span>`)
    : `<span class="mk-probe bad" title="Поставьте пробник: bash probe/setup.sh IP_панели на отдельном сервере">${icon('shield-alert')}Без пробника — конкурент видит IP панели</span>`;
  if (comp.busy && !comp.items) { el.innerHTML = '<div class="skel skel-table"></div>'; return; }
  if (comp.err) { el.innerHTML = `<p class="empty">${esc(comp.err)}</p>`; return; }
  const items = (comp.items || []).map(vview).sort((a, b) => b.servers.length - a.servers.length);
  if (!items.length) { el.innerHTML = '<div class="mk-empty">' + icon('radar') + '<b>Пока пусто</b><span>Купите тестовую подписку у конкурента и вставьте ссылку выше — покажу, где и на чём стоят его серверы.</span></div>'; return; }
  if (comp.sel && !items.some(e => e.name === comp.sel)) comp.sel = '';
  if (items.length === 1) comp.sel = items[0].name;
  const e = items.find(x => x.name === comp.sel), key = `${comp.sel}|${comp.tab}`, fresh = comp.shown !== key;
  const tabs = compTabs();
  const body = !e ? (comp.tab === 'cmp' ? compMatrix(items) : comp.tab === 'host' ? compCandidates(items) || '<p class="muted mk-pad">Досье по адресам ещё собираются.</p>' : compMemory() || '<p class="muted mk-pad">Память пока пустая.</p>')
    : comp.tab === 'srv' ? compOne(e) : comp.tab === 'host' ? compCandidates([e]) || '<p class="muted mk-pad">Досье по адресам ещё собираются.</p>' : compHist(e);
  // полоски «растут» только при первом показе раздела (карточки) и при смене вкладки/конкурента (содержимое) — не при каждом клике и опросе
  el.innerHTML = `<div class="${comp.shownOnce ? '' : 'mk-grow'}">${compRail(items)}</div><div class="mk-panel">${e ? compHead(e) : ''}${tabs}<div class="mk-tab${fresh ? ' mk-in mk-grow' : ''}">${body}</div></div>`;
  if (fresh && !comp.shownOnce) mkCountUp(el);
  comp.shown = key; comp.shownOnce = true;
  // ползунок вкладок едет от прежней вкладки к новой, хотя разметка перерисована
  const sg = el.querySelector('.mk-tabs'), th = sg?.querySelector('.thumb');
  if (th) { if (comp.thumb) { th.style.transition = 'none'; Object.assign(th.style, comp.thumb); th.offsetWidth; th.style.transition = ''; }
    requestAnimationFrame(() => { moveThumb(sg); comp.thumb = {left: th.style.left, width: th.style.width}; }); }
}
// числа на карточках набегают от нуля — один раз, при первом показе раздела
function mkCountUp(root){
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const n of root.querySelectorAll('[data-count]')) {
    const to = +n.dataset.count; if (!(to > 3)) continue;
    const t0 = performance.now(), d = 700;
    const step = t => { const k = Math.min(1, (t - t0) / d), v = Math.round(to * (1 - Math.pow(1 - k, 3))); n.textContent = v; if (k < 1) requestAnimationFrame(step); };
    n.textContent = '0'; requestAnimationFrame(step);
  }
}

// большие подписки (сотни серверов): обзор → страны-фильтры и поиск → таблица, сгруппированная по IP
// (один сервер под разными названиями и портами — «proxy», «bridge», «bridge-2» — одной строкой)
const CC_RU = (() => { try { return new Intl.DisplayNames(['ru'], {type: 'region'}); } catch { return null; } })();
const ccName = cc => { try { return CC_RU?.of(cc) || cc; } catch { return cc; } };
comp.f = {};   // фильтры по конкуренту: {cc, q, all}
const PAGE = 30;
function ipGroups(e, list = e.servers){
  const m = new Map();
  for (const s of list) {
    const k = s.ip || s.addr, g = m.get(k) || {k, list: []};
    g.list.push(s); m.set(k, g);
  }
  return [...m.values()].map(g => {
    const cnt = {}; for (const s of g.list) { const c = ccOfS(s); if (c) cnt[c] = (cnt[c] || 0) + 1; }
    const cc = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const names = [...new Set(g.list.map(s => remarkFlag(s.remark) || s.addr))];
    return {...g, cc, ccs: new Set(Object.keys(cnt)), names, s0: g.list[0], tr: [...new Set(g.list.map(transportOf))], ports: [...new Set(g.list.map(s => s.port))].sort((a, b) => a - b),
      mask: [...new Set(g.list.map(s => { const k = sniKind(s); return k ? (k.k === 'own' ? 'свой домен' : k.t) : ''; }).filter(Boolean))], white: g.list.some(isWhite)};
  });
}
// состояние входа — одной иконкой с подписью: цвет только у иконки, текст обычный
function srvState(g, e, gone){
  const L = g.list, any = k => L.find(x => x[k]);
  if (gone) return {ic: 'circle-slash', k: 'off', t: 'Ушёл из подписки', s: dshort(Math.max(...L.map(x => x.gone_at)))};
  if (L.some(x => x.probing) || (e.probe?.running && !L.some(x => x.exits || x.exit_err))) return {ic: 'loader', k: 'run', t: 'Проверяю'};
  const open = L.find(x => x.reach === 'open'), ms = open?.tcp_ms != null ? `TCP ${open.tcp_ms} мс` : '';
  const okx = L.filter(x => x.exits?.length);
  if (okx.length) {
    // выход узнали, но 256 КБ через туннель не прошли — подключение есть, объём режут («заморозка» 16–20 КБ)
    const cut = okx.filter(x => x.bulk_kb != null && x.bulk_kb < 256);
    if (cut.length === okx.length) return {ic: 'triangle-alert', k: 'warn', t: 'Подключается, но не грузит', s: `из 256 КБ пришло ${Math.min(...cut.map(x => x.bulk_kb))} КБ — похоже на «заморозку»`};
    const alt = okx.find(x => x.fp_alt);
    return {ic: 'circle-check', k: 'ok', t: 'Работает', s: [ms, alt ? `только с отпечатком ${alt.fp_alt}${alt.fp_first ? ` (${alt.fp_first} не пустило)` : ''}` : ''].filter(Boolean).join(' · ')};
  }
  if (any('vpn_fail')) return {ic: 'triangle-alert', k: 'warn', t: 'VPN не поднимается', s: [ms, 'TCP есть — похоже на DPI'].filter(Boolean).join(' · ')};
  const r = any('reach');
  if (r && r.reach !== 'open') {
    return {ic: 'circle-x', k: 'err', t: comp.probe?.cc && comp.probe.cc !== 'RU' ? 'Не открывается из ' + comp.probe.cc : 'Не открывается из РФ', s: 'заблокирован или выключен'};
  }
  const err = L.map(x => x.exit_err).find(Boolean);
  if (err && /UDP/.test(err)) return {ic: 'circle-dashed', k: 'off', t: 'Не проверяли', s: 'UDP'};
  if (err) return {ic: 'circle-x', k: 'err', t: 'Не подключилось', s: err.slice(0, 60)};
  return {ic: 'circle-dashed', k: 'off', t: 'Не проверяли', s: open ? ms : ''};
}
const trShort = t => t.replace(/^VLESS · /, '');
function compTable(e){
  const f = comp.f[e.name] ||= {cc: '', q: '', all: false}, goneMode = f.cc === 'gone', groups = ipGroups(e, goneMode ? e.goneList : e.servers);
  const q = f.q.trim().toLowerCase();
  const shown = groups.filter(g => (!f.cc || goneMode || g.ccs.has(f.cc) || (f.cc === '-' && !g.ccs.size)) && (!q || [g.k, g.names.join(' '), hosterName(g.s0), g.mask.join(' '), g.tr.join(' '), ccName(g.cc)].join(' ').toLowerCase().includes(q)));
  const rows = f.all ? shown : shown.slice(0, PAGE), canProbe = !goneMode && e.refresh && comp.probe?.on;
  const row = g => {
    const multi = g.ccs.size >= 3, sel = f.cc && f.cc !== '-' && !goneMode ? g.list.find(x => ccOfS(x) === f.cc) : null;
    const name = sel ? remarkFlag(sel.remark) || sel.addr : g.names[0], fl = sel ? flag(f.cc) : !multi && g.cc ? flag(g.cc) : `<span class="mk-noflag">${icon('globe')}</span>`;
    const st = srvState(g, e, goneMode);
    const ex = [], seen = new Set(); for (const x of g.list) for (const y of x.exits || []) if (!seen.has(y.ip)) { seen.add(y.ip); ex.push(y); }
    const self = ex.length && ex.every(y => y.ip === g.k);
    const exitHtml = !ex.length ? '<span class="muted">—</span>' : self ? '<span class="muted">тот же сервер</span>'
      : ex.length === 1 ? `${ex[0].cc ? flag(ex[0].cc) : ''}${esc(hosterName(ex[0]))}<span class="sub mono">${esc(ex[0].ip)}</span>`
      : `${ex.length} ${plural(ex.length, 'выход', 'выхода', 'выходов')}<span class="sub">${esc([...new Set(ex.map(hosterName))].slice(0, 2).join(', '))}</span>`;
    const meta = [`<span class="mono">${esc(g.k)}</span>`, g.list.length > 1 ? `${g.list.length} ${plural(g.list.length, 'вход', 'входа', 'входов')}` : '',
      multi ? `выход в ${g.ccs.size} ${plural(g.ccs.size, 'страну', 'страны', 'стран')}` : '', g.white ? 'вход в РФ' : ''].filter(Boolean).join(' · ');
    const proto = g.tr.map(trShort).join(', '), mask = g.mask[0] ? (g.mask[0] === 'свой домен' ? 'свой домен' : `SNI ${g.mask[0]}`) : '';
    const ports = g.ports.filter(x => x !== '443');
    return `<tr class="click${goneMode ? ' mk-gone' : ''}" data-dos-row="${esc(g.k)}" title="${esc(g.list.map(x => remarkFlag(x.remark) + (x.port !== '443' ? ` :${x.port}` : '')).join('\n'))}">
      <td><div class="mk-n">${fl}<b>${esc(name)}</b>${g.names.length > 1 ? `<span class="muted mk-plus">+${g.names.length - 1}</span>` : ''}</div><span class="sub">${meta}</span></td>
      <td data-l="Состояние"><div class="mk-st st-${st.k}">${icon(st.ic)}<div>${st.t}${st.s ? `<span class="sub">${esc(st.s)}</span>` : ''}</div></div>${canProbe && !g.list.some(x => x.probing) ? `<button class="mk-p1" title="Проверить только этот сервер" data-p1="${esc(g.k)}" data-p1-name="${esc(e.name)}">${icon('refresh-cw')}Проверить</button>` : ''}</td>
      <td data-l="Выход">${exitHtml}</td>
      <td data-l="Вход у">${esc(hosterName(g.s0))}<span class="sub">${[g.s0.asn ? 'AS' + g.s0.asn : '', g.s0.cc && g.s0.cc !== g.cc ? 'зарег. ' + g.s0.cc : ''].filter(Boolean).map(esc).join(' · ')}</span></td>
      <td data-l="Протокол">${esc(proto)}<span class="sub">${[mask, ports.length ? 'порт ' + ports.slice(0, 2).join(', ') + (ports.length > 2 ? '…' : '') : ''].filter(Boolean).map(esc).join(' · ')}</span></td></tr>`;
  };
  return shown.length ? `<div class="table-wrap"><table class="mk-tbl"><thead><tr><th>Сервер</th><th>Состояние</th><th>Выход</th><th>Вход у</th><th>Протокол</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>
    ${shown.length > rows.length ? `<button class="pill mk-more-btn" data-cmp-all="${esc(e.name)}">Показать все — ещё ${shown.length - rows.length}</button>` : ''}`
    : '<p class="empty" style="padding:18px 0">Ничего не нашлось.</p>';
}
function compCountries(e){
  const f = comp.f[e.name] ||= {cc: '', q: '', all: false}, groups = ipGroups(e), cnt = {};
  for (const g of groups) for (const c of g.ccs.size ? g.ccs : ['-']) cnt[c] = (cnt[c] || 0) + 1;
  const goneBtn = e.goneList?.length ? `<button class="mk-cc mk-ccgone${f.cc === 'gone' ? ' on' : ''}" data-cmp-cc="gone" data-cmp-name="${esc(e.name)}" title="Пропали из подписки — забанили или сменили; хранятся 90 дней">Ушли<b>${e.goneList.length}</b></button>` : '';
  const list = Object.entries(cnt).sort((a, b) => (a[0] === '-') - (b[0] === '-') || b[1] - a[1]);
  if (list.length < 2) return goneBtn ? `<div class="mk-ccs"><button class="mk-cc${!f.cc ? ' on' : ''}" data-cmp-cc="" data-cmp-name="${esc(e.name)}">Все<b>${groups.length}</b></button>${goneBtn}</div>` : '';
  const LIM = 10, more = list.length > LIM && !f.ccAll && !list.slice(LIM).some(([c]) => c === f.cc);
  return `<div class="mk-ccs"><button class="mk-cc${!f.cc ? ' on' : ''}" data-cmp-cc="" data-cmp-name="${esc(e.name)}">Все<b>${groups.length}</b></button>${list.map(([c, n]) =>
    `<button class="mk-cc${f.cc === c ? ' on' : ''}" data-cmp-cc="${esc(c)}" data-cmp-name="${esc(e.name)}">${c === '-' ? 'Без страны' : `${flag(c)}${esc(ccName(c))}`}<b>${n}</b></button>`).slice(0, more ? LIM : undefined).join('')}${more ? `<button class="mk-cc mk-ccmore" data-cmp-ccall="${esc(e.name)}">ещё ${list.length - LIM} ${plural(list.length - LIM, 'страна', 'страны', 'стран')}</button>` : ''}${goneBtn}</div>`;
}
function compDiff(d){
  if (!d) return '';
  const total = d.added.length + d.removed.length + d.ip.length;
  if (!total) return '';
  const byCc = list => { const m = {}; for (const n of list) { const c = ccOfRemark(n) || '-'; m[c] = (m[c] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const what = list => list.length > 3 ? byCc(list).slice(0, 6).map(([c, n]) => `${c === '-' ? 'без страны' : flag(c) || esc(ccName(c))}<span class="muted">${n}</span>`).join(' ') : list.map(x => esc(remarkFlag(x))).join(', ');
  const line = (ic, cls, n, word, list) => n ? `<li><span class="mk-dic ${cls}">${icon(ic)}</span><b>${n}</b> ${word}<span class="mk-dwhat">${what(list)}</span></li>` : '';
  const full = total > 6 ? `<details class="mk-dfull"><summary>Весь список</summary><div>${d.added.length ? `<p><b>Появились:</b> ${d.added.map(esc).join(' · ')}</p>` : ''}${d.removed.length ? `<p><b>Пропали:</b> ${d.removed.map(esc).join(' · ')}</p>` : ''}${d.ip.length ? `<p><b>Сменили IP:</b> ${d.ip.map(esc).join(' · ')}</p>` : ''}</div></details>` : '';
  return `<div class="mk-diff"><div class="mk-dh">Изменения с прошлого разбора <span class="muted">· ${ago(d.prev_at)}</span></div><ul>
    ${line('plus', 'ok', d.added.length, plural(d.added.length, 'новый сервер', 'новых сервера', 'новых серверов'), d.added)}
    ${line('trash-2', 'err', d.removed.length, plural(d.removed.length, 'пропал', 'пропало', 'пропало'), d.removed)}
    ${line('arrow-right-left', 'warn', d.ip.length, plural(d.ip.length, 'сменил IP', 'сменили IP', 'сменили IP'), d.ip.map(x => x.split(':')[0]))}</ul>${full}</div>`;
}
// --- досье на адрес: кто реально стоит за IP ---
const ip4n = ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.split('.').reduce((a, b) => a * 256 + +b, 0) : null;
const inCidr = (ip, cidr) => { const [b, l] = String(cidr || '').split('/'), x = ip4n(ip), y = ip4n(b); if (x == null || y == null) return false; const m = 2 ** (32 - +l); return Math.floor(x / m) === Math.floor(y / m); };
const net24s = ip => ip.split('.').slice(0, 3).join('.');
function compAllIps(){
  const out = [];
  for (const e of comp.items || []) for (const s of e.servers.filter(x => !x.gone_at)) {
    if (s.ip) out.push({ip: s.ip, who: e.name, kind: 'вход', s});
    for (const x of s.exits || []) if (x.ip !== s.ip) out.push({ip: x.ip, who: e.name, kind: 'выход', s, x});
  }
  return out;
}
async function openDossier(ip, fresh = false){
  const box = $('#dos'), body = $('#dos-body'); if (!box) return;
  box.hidden = false; $('#dos-ip').textContent = ip;
  let d = !fresh && comp.dossiers?.[ip]?.kb !== undefined && comp.dossiers?.[ip];
  if (!d) {
    body.innerHTML = '<div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div>';
    try {
      if (DEMO) d = demoDossier(ip);
      else { const r = await auth('comp-dossier', {ip, fresh: fresh ? 1 : 0}); if (r.status !== 200) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status); d = await r.json(); (comp.dossiers ||= {})[ip] = d; }
    } catch (e) { body.innerHTML = `<p class="empty">Досье не собралось: ${esc(e.message)}</p>`; return; }
  }
  const all = compAllIps(), here = all.filter(x => x.ip === ip), n24 = all.filter(x => x.ip !== ip && net24s(x.ip) === net24s(ip)), npx = d.prefix ? all.filter(x => x.ip !== ip && inCidr(x.ip, d.prefix)) : [];
  const ours = Object.values(state.model?.nodes || {}).filter(n => ipsOf(n).some(x => x === ip || net24s(x) === net24s(ip) || (d.prefix && inCidr(x, d.prefix))));
  const who = list => [...new Set(list.map(x => x.who))];
  const reach = here.map(x => x.s.reach).filter(Boolean);
  const row = (l, v) => v ? `<div class="dos-r"><span>${l}</span><div>${v}</div></div>` : '';
  body.innerHTML = `
    ${d.real ? `<div class="dos-real">${icon('search')}<div><b>${esc(d.real)}</b><span>фактический хостер — блок выделен ему, а сеть принадлежит ${esc(hosterName(d))}${d.asn ? ` (AS${esc(d.asn)})` : ''}</span></div></div>` : ''}
    ${row('Сеть', `${d.cc ? flag(d.cc) : ''}${esc(hosterName(d))}${d.asn ? ` <span class="muted">AS${esc(d.asn)}</span>` : ''}`)}
    ${row('Блок по реестру', d.range ? `${esc(d.range)}${d.netname ? `<span class="sub">${esc(d.netname)}${d.country ? ' · ' + esc(d.country) : ''}</span>` : ''}` : '')}
    ${row('Организация', esc(d.org || d.descr || ''))}
    ${row('Префикс в BGP', d.prefix ? `${esc(d.prefix)}<span class="sub">анонсирует ${(d.announced || []).map(a => `AS${esc(a.asn)} ${esc(a.holder)}`).join(', ') || '—'}</span>` : '')}
    ${row('Обратная запись', d.ptr ? `<span class="mono">${esc(d.ptr)}</span>` : '')}
    ${d.kb ? row('В базе', `впервые ${dshort(d.kb.first)}, последний раз ${dshort(d.kb.last)}${d.kb.gone ? ` · <span class="bad">ушёл ${dshort(d.kb.gone)}</span> — прожил ${days((d.kb.gone - d.kb.first) / 86400)}` : ''}<span class="sub">${Object.entries(d.kb.who).map(([n, w]) => `${esc(n)}: ${w.role}${w.gone ? ', ушёл ' + dshort(w.gone) : ''}`).join(' · ')}${d.kb.remarks?.length ? ' · ' + d.kb.remarks.map(esc).join(', ') : ''}</span>`) : ''}
    ${row('Здесь', here.length ? here.map(x => `${esc(x.who)}: ${x.kind}`).filter((v, i, a) => a.indexOf(v) === i).join(', ') : '<span class="muted">в разобранных подписках нет</span>')}
    ${row('Доступность', reach.length ? (reach.includes('open') ? `<span class="ok-t">доступен с пробника${comp.probe?.cc ? ' (' + esc(comp.probe.cc) + ')' : ''}</span>` : '<span class="bad">с пробника не подключается</span>') : '')}
    ${row('Соседи в /24', n24.length ? `${n24.length} ${plural(n24.length, 'адрес', 'адреса', 'адресов')} — ${who(n24).map(esc).join(', ')}` : '<span class="muted">нет</span>')}
    ${row('В том же префиксе', npx.length ? `${npx.length} — ${who(npx).map(esc).join(', ')}` : '')}
    ${row('Наши ноды рядом', ours.length ? ours.map(n => esc(n.name)).join(', ') : '<span class="muted">нет</span>')}
    <div class="dos-links"><a href="https://stat.ripe.net/${encodeURIComponent(ip)}" target="_blank" rel="noopener">RIPEstat</a><a href="https://bgp.he.net/ip/${encodeURIComponent(ip)}" target="_blank" rel="noopener">bgp.he.net</a>
      <span class="spacer"></span><button class="pill" data-dos-fresh="${esc(ip)}">${icon('refresh-cw')}Обновить досье</button></div>`;
}
// --- локации-кандидаты: где сидят конкуренты, сгруппировано по фактическому хостеру, сети и префиксу ---
function compCandidates(items){
  const names = new Set(items.map(e => e.name)), D = comp.dossiers || {}, all = compAllIps().filter(x => names.has(x.who));
  if (!Object.keys(D).length) return '';
  const groups = new Map();
  for (const x of all) {
    const d = D[x.ip]; if (!d) continue;
    const up = d.announced?.[0] || {asn: d.asn, holder: hosterName(d)}, key = `${d.real || hosterName(d)}|${up.asn}|${d.prefix || net24s(x.ip) + '.0/24'}`;
    const g = groups.get(key) || {key, real: d.real, net: hosterName(d), asn: up.asn, prefix: d.prefix || net24s(x.ip) + '.0/24', ips: new Set(), who: new Set(), entries: 0, exits: 0, open: 0, checked: 0, ip0: x.ip};
    g.ips.add(x.ip); g.who.add(x.who); x.kind === 'вход' ? g.entries++ : g.exits++;
    if (x.kind === 'вход' && x.s.reach) { g.checked++; if (x.s.reach === 'open') g.open++; }
    groups.set(key, g);
  }
  const ourIps = Object.values(state.model?.nodes || {}).flatMap(n => ipsOf(n).map(ip => ({ip, n})));
  const rows = [...groups.values()].map(g => ({...g, ours: ourIps.filter(o => inCidr(o.ip, g.prefix)).map(o => o.n.name)}))
    .sort((a, b) => !!b.real - !!a.real || b.who.size - a.who.size || b.ips.size - a.ips.size);
  const lim = comp.candAll ? rows.length : 15, from = comp.probe?.cc === 'RU' || !comp.probe?.cc ? 'из РФ' : 'из ' + esc(comp.probe.cc);
  const role = g => [g.entries ? `${g.entries} ${plural(g.entries, 'вход', 'входа', 'входов')}` : '', g.exits ? `${g.exits} ${plural(g.exits, 'выход', 'выхода', 'выходов')}` : ''].filter(Boolean).join(', ');
  const reach = g => !g.checked ? (g.exits ? ['circle-check', 'ok', 'выходы работают'] : ['circle-dashed', 'off', 'не проверяли'])
    : g.open === g.checked ? ['circle-check', 'ok', 'открывается'] : !g.open ? ['ban', 'err', 'не открывается'] : ['triangle-alert', 'warn', `открывается ${g.open} из ${g.checked}`];
  if (!rows.length) return '';
  return `<div class="mk-cand"><p class="mk-lead">Хостинги и подсети с их серверами. Сверху — небольшие хостеры, которые арендуют адреса у крупных сетей. Нажмите строку — откроется досье.</p>
    <div class="table-wrap"><table class="mk-tbl"><thead><tr><th>Хостинг</th>${items.length > 1 ? '<th>Конкуренты</th>' : ''}<th>Серверы</th><th>Доступ ${from}</th><th>Наши ноды рядом</th></tr></thead><tbody>
    ${rows.slice(0, lim).map(g => { const [ic, k, t] = reach(g); return `<tr class="click" data-dos-row="${esc(g.ip0)}"><td><b>${esc(g.real || g.net)}</b><span class="sub">${g.real ? `арендует у ${esc(g.net)} · ` : ''}<span class="mono">${esc(g.prefix)}</span></span></td>
      ${items.length > 1 ? `<td data-l="Конкуренты">${esc(andMore([...g.who], 2))}</td>` : ''}
      <td data-l="Серверы">${g.ips.size === g.entries + g.exits ? role(g) : `${g.ips.size} ${plural(g.ips.size, 'адрес', 'адреса', 'адресов')}<span class="sub">${role(g)}</span>`}</td>
      <td data-l="Доступ"><div class="mk-st st-${k}">${icon(ic)}<div>${t}</div></div></td>
      <td data-l="Наши рядом">${g.ours.length ? esc(g.ours.join(', ')) : '<span class="muted">—</span>'}</td></tr>`; }).join('')}</tbody></table></div>
    ${rows.length > lim ? `<button class="pill mk-more-btn" data-cand-all="1">Показать все — ещё ${rows.length - lim}</button>` : ''}</div>`;
}
function demoKb(){
  const now = Date.now() / 1000, d = 86400;
  return {ips: 214, gone: 61, since: now - 41 * d, history: [
      {name: 'Geodema Network', at: now - 120, servers: 95, added: 6, removed: 2, ipchg: 3}, {name: 'Lis VPN', at: now - 2 * 3600, servers: 4, added: 0, removed: 0, ipchg: 0},
      {name: 'Geodema Network', at: now - 3 * d, servers: 91, added: 12, removed: 9, ipchg: 0}, {name: 'FastVPN', at: now - 9 * d, servers: 4, first: true}],
    hosters: [
      {hoster: 'Stark Industries Solutions', asn: '44477', cc: 'GB', ips: 58, gone: 31, entries: 40, exits: 18, life_med: 9.5, age_med: 4, who: ['Geodema Network', 'FastVPN', 'Lis VPN']},
      {hoster: 'SmallHost Ltd', asn: '16276', cc: 'FR', ips: 44, gone: 2, entries: 0, exits: 44, life_med: 38, age_med: 21, who: ['Geodema Network']},
      {hoster: 'Aeza International', asn: '210644', cc: 'DE', ips: 37, gone: 14, entries: 30, exits: 7, life_med: 16, age_med: 11, who: ['Geodema Network', 'FastVPN']},
      {hoster: 'Hetzner Online GmbH', asn: '24940', cc: 'DE', ips: 29, gone: 5, entries: 2, exits: 27, life_med: 40, age_med: 25, who: ['Geodema Network']},
      {hoster: 'Yandex.Cloud', asn: '200350', cc: 'RU', ips: 6, gone: 0, entries: 6, exits: 0, life_med: null, age_med: 30, who: ['Lis VPN', 'Geodema Network']}]};
}
function demoDossier(ip){
  const small = ip.startsWith('51.89.');
  return {ip, asn: small ? '16276' : '219268', hoster: small ? 'OVH' : 'Geodema Group', as_name: small ? 'OVH, FR' : 'GEODEMA, AE', cc: small ? 'FR' : 'AE', prefix: small ? '51.89.0.0/16' : ip.split('.').slice(0, 2).join('.') + '.0.0/16',
    announced: [{asn: small ? '16276' : '219268', holder: small ? 'OVH - OVH SAS' : 'GEODEMA-AS'}], range: ip.split('.').slice(0, 3).join('.') + '.0 - ' + ip.split('.').slice(0, 3).join('.') + '.255',
    netname: small ? 'SMALLHOST-NET' : 'GEODEMA-NET', org: small ? 'SmallHost Ltd' : 'Geodema Group', real: small ? 'SmallHost Ltd' : '', ptr: small ? 'vps-' + ip.replace(/\./g, '-') + '.smallhost.net' : ''};
}

// --- память: база всех адресов, что видели, и лента изменений — живёт дольше тестовых подписок ---
const dshort = t => new Date(t * 1000).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'});
const days = v => v == null ? '—' : v < 1 ? 'меньше дня' : `${fmt(v, v < 10 ? 1 : 0)} ${plural(Math.round(v), 'день', 'дня', 'дней')}`;
const feedRow = r => `<div><span class="muted">${dshort(r.at)}</span><b>${esc(r.name)}</b><span>${r.first ? `первый разбор, ${r.servers} ${plural(r.servers, 'сервер', 'сервера', 'серверов')}` : [`${r.servers} ${plural(r.servers, 'сервер', 'сервера', 'серверов')}`, r.added ? `<span class="ok-t">${r.added} ${plural(r.added, 'новый', 'новых', 'новых')}</span>` : '', r.removed ? `<span class="bad">${r.removed} ${plural(r.removed, 'пропал', 'пропало', 'пропало')}</span>` : '', r.ipchg ? `${r.ipchg} ${plural(r.ipchg, 'сменил', 'сменили', 'сменили')} IP` : '', !r.added && !r.removed && !r.ipchg ? '<span class="muted">без изменений</span>' : ''].filter(Boolean).join(', ')}</span></div>`;
function compMemory(){
  const K = comp.kb; if (!K || !K.ips) return '';
  const rows = K.hosters.filter(h => h.ips), lim = comp.memAll ? rows.length : 12, alive = K.ips - K.gone;
  const life = h => !h.gone ? `<span class="muted">все на месте${h.age_med != null && h.age_med >= 1 ? `, уже ${days(h.age_med)}` : ''}</span>`
    : `<span class="${h.gone / h.ips > .3 ? 'bad' : ''}">${h.gone} из ${h.ips} ${plural(h.ips, 'ушёл', 'ушли', 'ушли')}</span><span class="sub">${h.life_med != null ? `обычно живут ${days(h.life_med)}` : ''}</span>`;
  return `<div class="mk-cand mk-mem"><p class="mk-lead">Все адреса, которые мы видели в подписках, — хранятся и после того, как подписка кончилась. «Ушёл» — адрес пропал из подписки: забанили или заменили.</p>
    <p class="mk-memline">В базе <b>${fmt(K.ips)}</b> ${plural(K.ips, 'адрес', 'адреса', 'адресов')}${K.since ? ` с ${dshort(K.since)}` : ''}: <b>${fmt(alive)}</b> на месте, <b>${fmt(K.gone)}</b> ${plural(K.gone, 'ушёл', 'ушли', 'ушли')}.</p>
    <div class="table-wrap"><table class="mk-tbl"><thead><tr><th>Хостинг</th><th>Адресов</th><th>Сколько живут</th><th>У кого</th></tr></thead><tbody>
    ${rows.slice(0, lim).map(h => `<tr><td><b>${esc(h.hoster)}</b><span class="sub">${[h.entries ? `${h.entries} ${plural(h.entries, 'вход', 'входа', 'входов')}` : '', h.exits ? `${h.exits} ${plural(h.exits, 'выход', 'выхода', 'выходов')}` : ''].filter(Boolean).join(', ')}</span></td>
      <td data-l="Адресов">${h.ips}</td><td data-l="Живут">${life(h)}</td><td data-l="У кого">${esc(andMore(h.who, 2))}</td></tr>`).join('')}</tbody></table></div>
    ${rows.length > lim ? `<button class="pill mk-more-btn" data-mem-all="1">Показать все — ещё ${rows.length - lim}</button>` : ''}
    ${K.history?.length ? `<h4 class="mk-h4">История разборов</h4><div class="mk-feed">${K.history.slice(0, comp.feedAll ? 60 : 8).map(feedRow).join('')}</div>
      ${K.history.length > 8 && !comp.feedAll ? '<button class="pill mk-more-btn" data-feed-all="1">Вся история</button>' : ''}` : ''}</div>`;
}

const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
const nodeByIp = ip => Object.values(state.model?.nodes || {}).find(n => ipsOf(n).includes(ip))?.name || '';

function demoComp(){
  const now = Date.now() / 1000, s = (remark, addr, ip, hoster, asn, cc, port, proto, net, sec, sni, fp, extra = {}) => ({remark, addr, ip, hoster, asn, cc, port, proto, net, sec, sni, fp, ...extra});
  // большая подписка: десятки стран, у каждой proxy / bridge / bridge-2 на одном IP с разными портами
  const CC = ['DE', 'NL', 'PL', 'RU', 'FI', 'LV', 'TR', 'KZ', 'AE', 'US', 'GB', 'FR', 'SE', 'NO', 'CN', 'JP', 'SG', 'IL', 'AR', 'BR', 'IN', 'GE'];
  const big = [];
  CC.forEach((c, i) => ['proxy', 'bridge', 'bridge-2', ...(i < 6 ? ['proxy-2', 'Hysteria 2'] : [])].forEach((role, j) => big.push(s(`${c} ${ccName(c)} - ${role}`, role.startsWith('bridge') ? `94.183.199.${1 + (i % 3)}` : `94.183.${190 + (i % 6)}.${10 + i}`, role.startsWith('bridge') ? `94.183.199.${1 + (i % 3)}` : `94.183.${190 + (i % 6)}.${10 + i}`, i % 4 ? 'Geodema Group' : 'Akenai Products', i % 4 ? '219268' : '219064', 'AE',
    String(role.startsWith('bridge') ? 20000 + i * 3 + j : role === 'Hysteria 2' ? 8443 : 443), role === 'Hysteria 2' ? 'hysteria2' : 'vless', role === 'Hysteria 2' ? 'udp' : 'tcp', role === 'Hysteria 2' ? 'tls' : 'reality', `n${i}.geodema.net`, 'chrome'))));
  for (let k = 1; k <= 17; k++) big.push(s(`EU Авто | Самый быстрый - proxy${k > 1 ? '-' + k : ''}`, `177.3.200.${k}`, `177.3.200.${k}`, 'Geodema Group', '219268', 'US', '443', 'vless', 'tcp', 'reality', 'auto.geodema.net', 'chrome'));
  return [
    {name: 'Geodema Network', title: '', at: now - 120, via: '95.163.10.20', refresh: true, probe: {done: true, at: now - 60}, servers: big.map((x, i) => ({...x, reach: i % 9 === 4 ? 'filtered' : 'open',
      ...(x.remark.includes('bridge') ? {exits: [{ip: `51.89.${100 + (i % 4)}.${20 + i}`, cc: ['DE', 'NL', 'FR', 'PL'][i % 4], hoster: i % 2 ? 'OVH' : 'Hetzner Online GmbH', asn: i % 2 ? '16276' : '24940'}]} : x.proto === 'hysteria2' ? {exit_err: 'UDP-протокол — выход пока не пробиваем'} : {exits: [{ip: x.ip, cc: x.cc}]})})), diff: {prev_at: now - 480, added: big.slice(0, 96).map(x => x.remark), removed: ['GB Великобритания', 'NL Нидерланды [Fragment]'], ip: []}},
    {name: 'Lis VPN', title: '🦊 LiS VPN', at: now - 3600 * 2, via: '', refresh: true, probe: {done: true, at: now - 600}, diff: {prev_at: now - 86400 * 2, added: ['Germany - Frankfurt'], removed: ['Poland - Warsaw'], ip: []}, servers: [
      s('FI Finland - Helsinki', 'fncloud.lis-boost.space', '31.76.88.209', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'fncloud.lis-boost.space', 'firefox', {path: '/api/v1/get_files', reach: 'filtered', exit_err: 'TCP не подключается отсюда'}),
      s('NL Netherlands - Amsterdam', 'fserv.lis-boost.space', '191.217.224.44', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'fserv.lis-boost.space', 'firefox', {path: '/api/v1/get_files', reach: 'open', tcp_ms: 38, exits: [{ip: '191.217.224.44', cc: 'NL'}], bulk_kb: 17}),
      s('DE Germany - Frankfurt', 'ger3cloud.lis-boost.space', '144.31.228.6', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'ger3cloud.lis-boost.space', 'firefox', {path: '/api/v1/get_files', reach: 'open', tcp_ms: 44, vpn_fail: true, exit_err: 'TCP есть, а VPN не подключился — DPI, протокол режут или конфиг устарел'}),
      s('RU Russia - Moscow (White Lists)', '188.72.110.50', '188.72.110.50', 'Yandex.Cloud LLC', '215013', 'RU', '443', 'vless', 'xhttp', 'tls', 'shopex.lis-boost.space', 'qq', {path: '/api/cart/sync'}),
      s('PL Poland - Warsaw', 'pl.lis-boost.space', '45.12.1.9', 'Stark Industries Solutions Ltd', '44477', 'GB', '443', 'vless', 'xhttp', 'reality', 'pl.lis-boost.space', 'firefox', {gone_at: now - 86400 * 2})]},
    {name: 'FastVPN', title: '', at: now - 86400 * 2, via: 'text', servers: [
      s('🇩🇪 Германия', 'de1.fast.example', '45.88.1.10', 'Aeza International Ltd', '210644', 'DE', '443', 'vless', 'tcp', 'reality', 'ads.x5.ru', 'chrome', {flow: 'xtls-rprx-vision'}),
      s('🇳🇱 Нидерланды', '185.10.2.3', '185.10.2.3', 'Stark Industries Solutions Ltd', '44477', 'NL', '443', 'vless', 'tcp', 'reality', 'ads.x5.ru', 'chrome', {flow: 'xtls-rprx-vision'}),
      s('🇫🇮 Финляндия', '95.1.2.3', '95.1.2.3', 'Hetzner Online GmbH', '24940', 'DE', '8443', 'vless', 'grpc', 'reality', 'www.microsoft.com', 'firefox', {path: 'grpc'}),
      s('Hysteria DE', '45.88.2.21', '45.88.2.21', 'Aeza International Ltd', '210644', 'DE', '8443', 'hysteria2', 'udp', 'tls', 'hy.fast.example', '')]},
  ];
}
const demoCompOurs = () => ({'45.88.176.45': {asn: '210644', hoster: 'Aeza International Ltd'}});

$('#comp')?.addEventListener('click', async e => {
  const del = e.target.closest('[data-cmp-del]');
  if (del) {
    const name = del.dataset.cmpDel; if (!confirm(`Удалить разбор «${name}»?`)) return;
    if (!DEMO) { const r = await auth('comp-delete', {name}); if (r.status !== 204) return toast('Не удалилось: HTTP ' + r.status); }
    comp.items = comp.items.filter(x => x.name !== name); return renderComp();
  }
  const rf = e.target.closest('[data-cmp-refresh]'); if (rf) return compAdd(rf.dataset.cmpRefresh);
  const ccb = e.target.closest('[data-cmp-cc]');
  if (ccb) { const n = ccb.dataset.cmpName, f = comp.f[n] ||= {cc: '', q: '', all: false}; f.cc = ccb.dataset.cmpCc; f.all = false; return renderComp(); }
  const dl = e.target.closest('[data-dos]'); if (dl) { e.preventDefault(); e.stopPropagation(); return openDossier(dl.dataset.dos); }
  const p1 = e.target.closest('[data-p1]');
  if (p1) {
    const ent = comp.items.find(x => x.name === p1.dataset.p1Name); if (!ent) return;
    const list = ent.servers.filter(x => !x.gone_at && (x.ip || x.addr) === p1.dataset.p1);
    p1.disabled = true;
    if (DEMO) { list.forEach(x => { x.probing = true; }); renderComp(); setTimeout(() => { list.forEach(x => { delete x.probing; x.exits = [{ip: '51.89.101.77', cc: 'DE', hoster: 'OVH'}]; }); renderComp(); }, 1500); return; }
    const r = await auth('comp-probe-one', {name: ent.name, keys: list.map(x => [x.proto, x.addr, String(x.port), x.net || ''])}), j = await r.json().catch(() => ({}));
    if (r.status !== 200) { p1.disabled = false; return toast('Не пробилось: ' + (j.error || 'HTTP ' + r.status)); }
    list.forEach(x => { x.probing = true; }); renderComp();
    clearTimeout(comp.poll); comp.poll = setTimeout(() => { comp.poll = null; loadComp(true); }, 4000);
    return;
  }
  const dr = e.target.closest('[data-dos-row]'); if (dr) return openDossier(dr.dataset.dosRow);
  if (e.target.closest('[data-cand-all]')) { comp.candAll = true; return renderComp(); }
  if (e.target.closest('[data-mem-all]')) { comp.memAll = true; return renderComp(); }
  if (e.target.closest('[data-feed-all]')) { comp.feedAll = true; return renderComp(); }
  const ca = e.target.closest('[data-cmp-ccall]');
  if (ca) { (comp.f[ca.dataset.cmpCcall] ||= {cc: '', q: '', all: false}).ccAll = true; return renderComp(); }
  const all = e.target.closest('[data-cmp-all]');
  if (all) { (comp.f[all.dataset.cmpAll] ||= {cc: '', q: '', all: false}).all = true; return compTableRender(all.dataset.cmpAll); }
  const pk = e.target.closest('[data-pick]');
  if (pk) { comp.sel = pk.dataset.pick; comp.tab = comp.sel ? 'srv' : 'cmp'; return renderComp(); }
  const mt = e.target.closest('[data-mtab]');
  if (mt) { comp.tab = mt.dataset.mtab; return renderComp(); }
});
// поиск перерисовывает только таблицу — поле ввода не теряет фокус
const compTableRender = name => { const box = [...document.querySelectorAll('[data-cmp-tbl]')].find(x => x.dataset.cmpTbl === name), e = comp.items?.find(x => x.name === name); if (box && e) box.innerHTML = compTable(vview(e)); };
$('#comp')?.addEventListener('input', e => { const q = e.target.closest('[data-cmp-q]'); if (q) { const f = comp.f[q.dataset.cmpQ] ||= {cc: '', q: '', all: false}; f.q = q.value; f.all = false; compTableRender(q.dataset.cmpQ); } });
$('#cmp-go')?.addEventListener('click', () => compAdd());
$('#dos')?.addEventListener('click', e => { if (e.target.id === 'dos' || e.target.closest('#dos-close')) $('#dos').hidden = true; const f = e.target.closest('[data-dos-fresh]'); if (f) openDossier(f.dataset.dosFresh, true); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#dos') && !$('#dos').hidden) $('#dos').hidden = true; });
$('#cmp-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); compAdd(); } });
