'use strict';
// «Рынок»: разбор тестовых подписок других VPN — на каких хостерах, транспортах и SNI они держат серверы.
// Подписку скачивает и разбирает node-setup (через node-auth /auth/comp-*), через пробник (PROBE_URL): ключи (UUID, пароли,
// shortId) не сохраняются; ссылка — только если попросить (для «Обновить»), в браузер она не возвращается.
// Вид: строка ввода → короткие выводы обычными фразами → список конкурентов, подробности по клику

const comp = {items: null, via: '', ours: {}, err: '', busy: false, at: 0, open: new Set(), adding: '', addErr: ''};
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
    clearTimeout(comp.poll);
    if ((comp.items || []).some(e => e.probe?.running || e.servers.some(x => x.probing)) && !DEMO) comp.poll = setTimeout(() => { if (state.vw === 'market') loadComp(true); }, 8000);
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
    comp.items = [...(comp.items || []).filter(x => x.name !== e.name), e]; comp.open.add(e.name);
    if (!refreshName) { $('#cmp-url').value = ''; $('#cmp-text').value = ''; $('#cmp-name').value = ''; }
  } catch (err) { if (refreshName) toast('Не обновилось: ' + err.message); else comp.addErr = err.message; }
  comp.adding = ''; renderCompForm(); renderComp();
}

function renderCompForm(){
  const b = $('#cmp-go'); if (!b) return;
  b.disabled = !!comp.adding; b.innerHTML = comp.adding === '+' ? `${icon('loader')}Разбираю…` : `${icon('search')}Разобрать`;
  $('#cmp-err').textContent = comp.addErr;
}

// выводы — плитками: одно крупное значение и короткая подпись
const vview = e => ({...e, servers: e.servers.filter(x => !x.gone_at), goneList: e.servers.filter(x => x.gone_at)});
function compInsights(items){
  const all = items.flatMap(e => e.servers.map(s => { const c = {...s, who: e.name}; SRV_OF.set(c, e.servers); return c; })), n = all.length, many = items.length > 1;
  if (!n) return [];
  const count = (f, key) => { const m = new Map(); for (const s of all.filter(f)) { const k = key(s); const g = m.get(k) || {k, n: 0, who: new Set()}; g.n++; g.who.add(s.who); m.set(k, g); } return [...m.values()].sort((a, b) => b.who.size - a.who.size || b.n - a.n); };
  const share = g => many ? `у ${g.who.size} из ${items.length} конкурентов` : `${g.n} из ${n} серверов`;
  const out = [];
  const tr = count(() => true, transportOf);
  out.push({ic: 'route', l: 'Транспорт', v: tr[0].k.replace(/^VLESS · /, ''), s: share(tr[0]) + (tr[1] ? ` · ещё ${tr.slice(1, 3).map(g => g.k.replace(/^VLESS · /, '')).join(', ')}` : '')});
  const own = all.filter(s => sniKind(s)?.k === 'own'), foreign = count(s => sniKind(s)?.k === 'foreign', s => s.sni);
  const ownG = {n: own.length, who: new Set(own.map(s => s.who))};
  if (own.length >= (foreign[0]?.n || 0)) out.push({ic: 'shield-check', l: 'Маскировка', v: 'Свой домен', s: share(ownG) + (foreign[0] ? ` · чужой: ${foreign[0].k}` : '')});
  else out.push({ic: 'shield-check', l: 'Маскировка', v: foreign[0].k, s: share(foreign[0]) + (own.length ? ` · свой домен у ${own.length}` : '')});
  const known = s => s.ip && (s.hoster || s.as_name || s.asn);
  const ho = count(known, hosterName), oursAsn = new Set(Object.values(comp.ours || {}).map(x => x?.asn).filter(Boolean));
  const shared = [...new Set(all.filter(s => s.asn && oursAsn.has(s.asn)).map(hosterName))];
  if (ho.length) out.push({ic: 'server', l: 'Хостер', v: ho[0].k, s: (ho.length > 1 ? `ещё ${ho.slice(1, 3).map(g => g.k).join(', ')}${ho.length > 3 ? ` и ${ho.length - 3}` : ''}` : share(ho[0])), ours: shared.length ? `у нас тоже: ${shared.join(', ')}` : ''});
  const exs = all.flatMap(s => (s.exits || []).filter(x => x.ip !== s.ip).map(x => ({...x, who: s.who})));
  if (exs.length) { const m = {}; for (const x of exs) { const k = hosterName(x); (m[k] ||= {k, n: 0, who: new Set()}).n++; m[k].who.add(x.who); } const top = Object.values(m).sort((a, b) => b.who.size - a.who.size || b.n - a.n);
    out.push({ic: 'route', l: 'Выходы за мостами', v: top[0].k, s: top.length > 1 ? `ещё ${top.slice(1, 3).map(g => g.k).join(', ')}` : `${top[0].n} ${plural(top[0].n, 'вход ведёт', 'входа ведут', 'входов ведут')} сюда`}); }
  const wl = all.filter(s => isWhite(s) && known(s));
  out.push(wl.length ? {ic: 'smartphone', l: 'Белые списки', v: [...new Set(wl.map(hosterName))].slice(0, 2).join(', '), s: `вход в РФ: ${wl.length} ${plural(wl.length, 'сервер', 'сервера', 'серверов')}${many ? ` у ${new Set(wl.map(s => s.who)).size} из ${items.length}` : ''}`}
    : {ic: 'smartphone', l: 'Белые списки', v: 'Нет входа в РФ', s: 'на мобильном с белыми списками не работают', dim: true});
  const odd = count(s => s.port && s.port !== '443', s => s.port);
  if (odd.length) out.push({ic: 'door-open', l: 'Порты', v: odd.slice(0, 3).map(g => g.k).join(', '), s: 'кроме 443'});
  return out;
}

function renderComp(){
  const el = $('#comp'); if (!el) return;
  for (const e of comp.items || []) for (const x of e.servers) SRV_OF.set(x, e.servers);
  const via = $('#comp-via');
  if (via) via.innerHTML = comp.items == null ? '' : comp.probe?.on ? (comp.probe.error ? `<span class="meh">${icon('shield-alert')}пробник недоступен: ${esc(comp.probe.error)}</span>`
      : `${icon('shield-check')}через пробник <b>${comp.probe.cc ? flag(comp.probe.cc) : ''}${esc(comp.probe.ip || comp.via)}</b> — подписки, выходы и доступность проверяются оттуда`)
    : `<span class="meh">${icon('shield-alert')}напрямую с сервера панели — конкурент видит его IP</span> · пробник: <code>bash probe/setup.sh IP_панели</code> на отдельном сервере`;
  if (comp.busy && !comp.items) { el.innerHTML = '<div class="skel skel-table"></div>'; return; }
  if (comp.err) { el.innerHTML = `<p class="empty">${esc(comp.err)}</p>`; return; }
  const items = (comp.items || []).map(vview).sort((a, b) => b.at - a.at);
  if (!items.length) { el.innerHTML = '<p class="empty">Пока пусто. Купите тестовую подписку у конкурента и вставьте ссылку выше — разберу, где и на чём стоят его серверы.</p>'; return; }
  const ins = compInsights(items);
  el.innerHTML = `${items.length > 1 ? `<h3 class="mk-cap">По ${items.length} конкурентам</h3>` : ''}<div class="mk-tiles">${ins.map(i => `<div class="mk-tile${i.dim ? ' dim' : ''}"><span class="mk-l">${icon(i.ic)}${i.l}</span><b title="${esc(i.v)}">${esc(i.v)}</b><span class="mk-s">${esc(i.s)}</span>${i.ours ? `<span class="chip ok">${esc(i.ours)}</span>` : ''}</div>`).join('')}</div>
    <div class="mk-list">${items.map(compCard).join('')}</div>${compCandidates(items)}${compMemory()}`;
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
function compTable(e){
  const f = comp.f[e.name] ||= {cc: '', q: '', all: false}, goneMode = f.cc === 'gone', groups = ipGroups(e, goneMode ? e.goneList : e.servers);
  const q = f.q.trim().toLowerCase();
  const shown = groups.filter(g => (!f.cc || goneMode || g.ccs.has(f.cc) || (f.cc === '-' && !g.ccs.size)) && (!q || [g.k, g.names.join(' '), hosterName(g.s0), g.mask.join(' '), g.tr.join(' '), ccName(g.cc)].join(' ').toLowerCase().includes(q)));
  const rows = f.all ? shown : shown.slice(0, PAGE);
  const row = g => { const multi = g.ccs.size >= 3, sel = f.cc && f.cc !== '-' ? g.list.find(x => ccOfS(x) === f.cc) : null, first = sel ? remarkFlag(sel.remark) || sel.addr : g.names[0];
    return `<tr${goneMode ? ' class="mk-gone"' : ''}${g.list.length > 1 ? ` title="${esc(g.list.map(s => remarkFlag(s.remark) + (s.port !== '443' ? ` :${s.port}` : '')).join('\n'))}"` : ''}>
    <td><div class="mk-n">${sel ? flag(f.cc) : !multi && g.cc ? flag(g.cc) : ''}<b>${esc(first)}</b>${g.names.length > 1 ? `<span class="chip">+${g.names.length - 1}</span>` : ''}${multi ? `<span class="chip" title="Один IP — вход, через который выходят в разные страны (мост или балансировщик)">вход для ${g.ccs.size} ${plural(g.ccs.size, 'страны', 'стран', 'стран')}</span>` : ''}${g.white ? '<span class="chip warn">РФ-вход</span>' : ''}</div>
      <span class="sub"><a href="#" class="ipl" data-dos="${esc(g.k)}">${esc(g.k)}</a>${g.list.length > 1 ? ` · ${g.list.length} ${plural(g.list.length, 'вход', 'входа', 'входов')}` : ''}${goneMode ? ` · <span class="bad">ушёл ${dshort(Math.max(...g.list.map(x => x.gone_at)))}</span>` : reachTag(g)}</span></td>
    <td data-l="Выход"><div class="mk-exit"><div>${exitCell(g, goneMode ? {} : e)}</div>${!goneMode && e.refresh && comp.probe?.on && !g.list.some(x => x.probing) ? `<button class="icon-btn mk-p1" title="Пробить только этот сервер" data-p1="${esc(g.k)}" data-p1-name="${esc(e.name)}">${icon('refresh-cw')}</button>` : ''}</div></td>
    <td data-l="Хостер">${esc(hosterName(g.s0))}<span class="sub">${g.s0.asn ? `AS${esc(g.s0.asn)}` : ''}${g.s0.cc && g.s0.cc !== g.cc ? ` · хостер из ${esc(g.s0.cc)}` : ''}</span></td>
    <td data-l="Транспорт"><div class="mk-chips">${g.tr.map(t => `<span class="chip">${esc(t)}</span>`).join('')}${g.mask.slice(0, 2).map(m => m === 'свой домен' ? '<span class="chip ok">свой домен</span>' : `<span class="chip" title="SNI — чужой сайт">${esc(m)}</span>`).join('')}</div></td>
    <td class="mono" data-l="Порт">${esc(g.ports.slice(0, 2).join(', '))}${g.ports.length > 2 ? ` +${g.ports.length - 2}` : ''}</td>
</tr>`; };
  return shown.length ? `<div class="table-wrap"><table class="mk-tbl"><thead><tr><th>Сервер</th><th>Выход</th><th>Хостер входа</th><th>Транспорт и маскировка</th><th>Порт</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>
    ${shown.length > rows.length ? `<button class="pill mk-more-btn" data-cmp-all="${esc(e.name)}">Показать все — ещё ${shown.length - rows.length}</button>` : ''}`
    : '<p class="empty" style="padding:18px 0">Ничего не нашлось.</p>';
}
function compCountries(e){
  const f = comp.f[e.name] ||= {cc: '', q: '', all: false}, groups = ipGroups(e), cnt = {};
  for (const s of e.servers) { const c = ccOfS(s) || '-'; cnt[c] = (cnt[c] || 0) + 1; }
  const goneBtn = e.goneList?.length ? `<button class="mk-cc mk-ccgone${f.cc === 'gone' ? ' on' : ''}" data-cmp-cc="gone" data-cmp-name="${esc(e.name)}" title="Пропали из подписки — забанили или сменили; хранятся 90 дней">Ушли<b>${e.goneList.length}</b></button>` : '';
  const list = Object.entries(cnt).sort((a, b) => (a[0] === '-') - (b[0] === '-') || b[1] - a[1]);
  if (list.length < 2) return goneBtn ? `<div class="mk-ccs"><button class="mk-cc${!f.cc ? ' on' : ''}" data-cmp-cc="" data-cmp-name="${esc(e.name)}">Все<b>${e.servers.length}</b></button>${goneBtn}</div>` : '';
  const LIM = 10, more = list.length > LIM && !f.ccAll && !list.slice(LIM).some(([c]) => c === f.cc);
  return `<div class="mk-ccs"><button class="mk-cc${!f.cc ? ' on' : ''}" data-cmp-cc="" data-cmp-name="${esc(e.name)}">Все<b>${e.servers.length}</b></button>${list.map(([c, n]) =>
    `<button class="mk-cc${f.cc === c ? ' on' : ''}" data-cmp-cc="${esc(c)}" data-cmp-name="${esc(e.name)}">${c === '-' ? 'Без страны' : `${flag(c)}${esc(ccName(c))}`}<b>${n}</b></button>`).slice(0, more ? LIM : undefined).join('')}${more ? `<button class="mk-cc mk-ccmore" data-cmp-ccall="${esc(e.name)}">ещё ${list.length - LIM} ${plural(list.length - LIM, 'страна', 'страны', 'стран')}</button>` : ''}${goneBtn}</div>`;
}
function compDiff(d){
  if (!d) return '';
  const total = d.added.length + d.removed.length + d.ip.length;
  if (!total) return `<p class="mk-nochg">${icon('circle-check')}С прошлого разбора (${ago(d.prev_at)}) ничего не изменилось.</p>`;
  const byCc = list => { const m = {}; for (const n of list) { const c = ccOfRemark(n) || '-'; m[c] = (m[c] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const ccTag = (c, n) => `<span class="mk-dcc">${c === '-' ? 'без страны' : flag(c) || esc(ccName(c))}<i>${n}</i></span>`;
  const sum = (list, word) => list.length ? `<div class="mk-dsum"><b>${word} ${list.length}</b>${list.length > 3 ? byCc(list).slice(0, 8).map(([c, n]) => ccTag(c, n)).join('') : `<span>${list.map(esc).join(', ')}</span>`}</div>` : '';
  const full = total > 6 ? `<details class="mk-dfull"><summary>Весь список</summary><div>${d.added.length ? `<p><b>Появились:</b> ${d.added.map(esc).join(' · ')}</p>` : ''}${d.removed.length ? `<p><b>Пропали:</b> ${d.removed.map(esc).join(' · ')}</p>` : ''}${d.ip.length ? `<p><b>Сменили IP:</b> ${d.ip.map(esc).join(' · ')}</p>` : ''}</div></details>` : '';
  return `<div class="mk-diff">${icon('history')}<div><b>С прошлого разбора (${ago(d.prev_at)})</b><div class="mk-dsums">${sum(d.added, '＋ появилось')}${sum(d.removed, '− пропало')}${sum(d.ip, '↻ сменили IP')}</div>${full}</div></div>`;
}
// выход сервера (пробник подключился через него как клиент и спросил свой IP)
function exitCell(g, e){
  if (g.list.some(x => x.probing)) return '<span class="meh">пробиваю…</span>';
  const ex = [], seen = new Set();
  for (const s of g.list) for (const x of s.exits || []) if (!seen.has(x.ip)) { seen.add(x.ip); ex.push(x); }
  if (ex.length) {
    if (ex.every(x => x.ip === g.k)) return '<span class="muted" title="Выход — тот же адрес: это не мост, а сам выход">сам выход</span>';
    const one = x => `<a href="#" class="ipl" data-dos="${esc(x.ip)}">${x.cc ? flag(x.cc) : ''}${esc(hosterName(x))}</a>`;
    return `${ex.slice(0, 2).map(one).join('<br>')}${ex.length > 2 ? `<span class="sub">ещё ${ex.length - 2} ${plural(ex.length - 2, 'выход', 'выхода', 'выходов')}</span>` : `<span class="sub">${ex.map(x => esc(x.ip)).join(', ')}</span>`}`;
  }
  if (e.probe?.running) return '<span class="muted">пробиваю…</span>';
  if (e.probe?.failed) return `<span class="muted" title="${esc(e.probe.failed)}">не пробит</span>`;
  const err = g.list.map(s => s.exit_err).find(Boolean);
  if (!err) return '<span class="muted">—</span>';
  const vpn = g.list.some(x => x.vpn_fail), noTcp = /^TCP не подключается/.test(err);
  return `<span class="muted" title="${esc(err)}">${/UDP/.test(err) ? 'UDP — не пробиваем' : vpn ? 'TCP есть, VPN нет' : noTcp ? 'нет TCP-соединения' : 'не подключилось'}</span>`;
}
// доступность входа: TCP-пинг с пробника (обычно из РФ); если оттуда нет — вторая проверка с сервера панели (не из РФ)
function reachTag(g){
  const sv = g.list.find(x => x.reach === 'open') || g.list.find(x => x.reach); if (!sv) return '';
  const from = comp.probe?.cc || '';
  if (sv.reach === 'open') return sv.tcp_ms != null ? ` · <span class="muted" title="TCP-пинг с пробника${from ? ' (' + from + ')' : ''}">TCP ${sv.tcp_ms} мс</span>` : '';
  if (sv.reach_out === 'open') return ` · <span class="bad" title="С пробника${from ? ' (' + from + ')' : ''} TCP не проходит, а с сервера панели — проходит: адрес заблокирован${from === 'RU' ? ' в России' : ' в стране пробника'}">заблокирован${from === 'RU' ? ' в РФ' : ' у пробника'}</span>`;
  if (sv.reach_out) return ` · <span class="meh" title="TCP не проходит ни с пробника, ни с сервера панели — сервер выключен, сменил порт или режет всех">не отвечает отовсюду</span>`;
  return ` · <span class="bad" title="С пробника${from ? ' (' + from + ')' : ''} TCP не проходит">недоступен</span>`;
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
  const D = comp.dossiers || {}, all = compAllIps();
  if (!Object.keys(D).length) return '';
  const groups = new Map();
  for (const x of all) {
    const d = D[x.ip]; if (!d) continue;
    const up = d.announced?.[0] || {asn: d.asn, holder: hosterName(d)}, key = `${d.real || hosterName(d)}|${up.asn}|${d.prefix || net24s(x.ip) + '.0/24'}`;
    const g = groups.get(key) || {key, real: d.real, net: hosterName(d), asn: up.asn, prefix: d.prefix || net24s(x.ip) + '.0/24', cc: d.cc || d.country, ips: new Set(), who: new Set(), entries: 0, exits: 0, open: 0, checked: 0, ip0: x.ip};
    g.ips.add(x.ip); g.who.add(x.who); x.kind === 'вход' ? g.entries++ : g.exits++;
    if (x.kind === 'вход' && x.s.reach) { g.checked++; if (x.s.reach === 'open') g.open++; }
    groups.set(key, g);
  }
  const ourIps = Object.values(state.model?.nodes || {}).flatMap(n => ipsOf(n).map(ip => ({ip, n})));
  const rows = [...groups.values()].map(g => ({...g, ours: ourIps.filter(o => inCidr(o.ip, g.prefix)).map(o => o.n.name)}))
    .sort((a, b) => !!b.real - !!a.real || b.who.size - a.who.size || b.ips.size - a.ips.size);
  const lim = comp.candAll ? rows.length : 15;
  return `<div class="mk-cand"><h3>Локации-кандидаты<span>где сидят конкуренты — по фактическому хостеру, сети и префиксу; сверху — маленькие хостеры на чужих сетях</span></h3>
    <div class="table-wrap"><table class="mk-tbl"><thead><tr><th>Хостер</th><th>Префикс</th><th class="n">Конкурентов</th><th class="n">Адресов</th><th>Доступны${comp.probe?.cc ? ' из ' + esc(comp.probe.cc) : ''}</th><th>Наши ноды</th></tr></thead><tbody>
    ${rows.slice(0, lim).map(g => `<tr class="click" data-dos-row="${esc(g.ip0)}"><td>${g.cc ? flag(g.cc) : ''}<b>${esc(g.real || g.net)}</b><span class="sub">${g.real ? `на сети ${esc(g.net)}` : 'сам владелец сети'}${g.asn ? ` · AS${esc(g.asn)}` : ''}</span></td>
      <td class="mono">${esc(g.prefix)}</td><td class="n" title="${esc([...g.who].join(', '))}">${g.who.size}</td>
      <td class="n">${g.ips.size}<span class="sub">${g.entries ? `${g.entries} вх.` : ''}${g.entries && g.exits ? ' · ' : ''}${g.exits ? `${g.exits} вых.` : ''}</span></td>
      <td>${g.checked ? `<span class="${g.open === g.checked ? 'ok-t' : g.open ? 'meh' : 'bad'}">${Math.round(g.open / g.checked * 100)}%</span><span class="sub">${g.open} из ${g.checked}</span>` : g.exits ? '<span class="muted">выходы работают</span>' : '<span class="muted">—</span>'}</td>
      <td>${g.ours.length ? esc(g.ours.join(', ')) : '<span class="muted">нет</span>'}</td></tr>`).join('')}</tbody></table></div>
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
function compMemory(){
  const K = comp.kb; if (!K || !K.ips) return '';
  const rows = K.hosters.filter(h => h.ips), lim = comp.memAll ? rows.length : 12;
  return `<div class="mk-cand mk-mem"><h3>Память<span>все адреса, что видели в подписках, — хранятся и после того, как подписка кончится; «ушёл» — пропал из подписки (забанили или сменили)</span></h3>
    <div class="mk-stats"><div><b>${fmt(K.ips)}</b><span>адресов в базе${K.since ? ` с ${dshort(K.since)}` : ''}</span></div><div><b>${fmt(K.gone)}</b><span>ушли</span></div><div><b>${fmt(K.ips - K.gone)}</b><span>живы сейчас</span></div></div>
    <div class="table-wrap"><table class="mk-tbl"><thead><tr><th>Хостер</th><th class="n">Адресов</th><th class="n">Ушли</th><th>Сколько жили ушедшие</th><th>Живым сейчас</th><th>У кого</th></tr></thead><tbody>
    ${rows.slice(0, lim).map(h => `<tr><td>${h.cc ? flag(h.cc) : ''}<b>${esc(h.hoster)}</b><span class="sub">${h.asn ? `AS${esc(h.asn)} · ` : ''}${h.entries ? `${h.entries} вх.` : ''}${h.entries && h.exits ? ' · ' : ''}${h.exits ? `${h.exits} вых.` : ''}</span></td>
      <td class="n">${h.ips}</td><td class="n">${h.gone ? `<span class="${h.gone / h.ips > .3 ? 'bad' : 'meh'}">${h.gone}</span>` : '<span class="muted">0</span>'}</td>
      <td>${h.gone ? `обычно ${days(h.life_med)}` : '<span class="muted">пока никто не ушёл</span>'}</td><td>${h.ips - h.gone ? `уже ${days(h.age_med)}` : '<span class="muted">—</span>'}</td>
      <td title="${esc(h.who.join(', '))}">${esc(h.who.slice(0, 2).join(', '))}${h.who.length > 2 ? ` +${h.who.length - 2}` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${rows.length > lim ? `<button class="pill mk-more-btn" data-mem-all="1">Показать все — ещё ${rows.length - lim}</button>` : ''}
    ${K.history?.length ? `<h4 class="mk-h4">Лента разборов</h4><div class="mk-feed">${K.history.slice(0, comp.feedAll ? 60 : 8).map(r => `<div><span class="muted">${dshort(r.at)}</span><b>${esc(r.name)}</b><span>${r.first ? `первый разбор: ${r.servers} ${plural(r.servers, 'сервер', 'сервера', 'серверов')}` : `${r.servers} серв.${r.added ? ` · <span class="ok-t">＋${r.added}</span>` : ''}${r.removed ? ` · <span class="bad">−${r.removed}</span>` : ''}${r.ipchg ? ` · сменили IP: ${r.ipchg}` : ''}${!r.added && !r.removed && !r.ipchg ? ' · без изменений' : ''}`}</span></div>`).join('')}</div>
      ${K.history.length > 8 && !comp.feedAll ? '<button class="pill mk-more-btn" data-feed-all="1">Вся лента</button>' : ''}` : ''}</div>`;
}

function compCard(e){
  const open = comp.open.has(e.name), cc = [...new Set(e.servers.map(ccOfS).filter(Boolean))];
  const tr = Object.entries(e.servers.reduce((m, s) => (m[transportOf(s)] = (m[transportOf(s)] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const d = e.diff, changes = d && (d.added.length || d.removed.length || d.ip.length);
  const groups = open ? ipGroups(e) : [], hosters = open ? new Set(e.servers.map(hosterName)).size : 0, f = comp.f[e.name] ||= {cc: '', q: '', all: false};
  return `<div class="mk-card${open ? ' open' : ''}">
    <div class="mk-h" data-cmp-open="${esc(e.name)}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="mk-title"><b>${esc(e.name)}</b><span class="sub">${e.servers.length} ${plural(e.servers.length, 'сервер', 'сервера', 'серверов')} · ${esc(tr)}${e.probe?.running ? ` · <span class="meh">пробиваю выходы${e.probe.total ? `: ${e.probe.progress || 0} из ${e.probe.total}` : '…'}</span>` : e.probe?.failed ? ` · <span class="bad" title="${esc(e.probe.failed)}">пробив не удался</span>` : e.probe?.done ? ` · выходы пробиты ${ago(e.probe.at)}` : ''}</span></div>
      <div class="mk-flags">${cc.slice(0, 8).map(flag).join('')}${cc.length > 8 ? `<span class="muted">+${cc.length - 8}</span>` : ''}</div>
      <span class="mk-at">${e.expired_at ? `<span class="chip" title="Сервис отдал заглушку вместо подписки — разбор и история сохранены">подписка закончилась</span> ` : e.fail ? `<span class="chip warn" title="${esc(e.fail.error)}">не обновилось ${ago(e.fail.at)}</span> ` : changes ? '<span class="chip warn">изменения</span> ' : ''}${ago(e.at)}</span>
      ${icon(open ? 'chevron-down' : 'chevron-right')}</div>
    ${open ? `<div class="mk-body">
      ${compDiff(d)}
      <div class="mk-stats"><div><b>${e.servers.length}</b><span>${plural(e.servers.length, 'сервер', 'сервера', 'серверов')} в подписке</span></div><div><b>${groups.length}</b><span>разных IP${groups.filter(g => g.ccs.size >= 3).length ? `, из них ${groups.filter(g => g.ccs.size >= 3).length} — входы для многих стран` : ''}</span></div>
        ${(() => { const ex = new Set(e.servers.flatMap(x => (x.exits || []).map(y => y.ip))); return ex.size ? `<div><b>${ex.size}</b><span>${plural(ex.size, 'выход', 'выхода', 'выходов')} за ними</span></div>` : ''; })()}
        <div><b>${cc.length}</b><span>${plural(cc.length, 'страна', 'страны', 'стран')}</span></div><div><b>${hosters}</b><span>${plural(hosters, 'хостер', 'хостера', 'хостеров')}</span></div></div>
      ${compCountries(e)}
      ${groups.length > 8 ? `<input class="mk-q" type="search" placeholder="Найти: страна, хостер, IP, SNI" value="${esc(f.q)}" data-cmp-q="${esc(e.name)}" autocomplete="off">` : ''}
      <div data-cmp-tbl="${esc(e.name)}">${compTable(e)}</div>
      <div class="mk-act"><span class="muted">${e.title && e.title !== e.name ? `в приложении: ${esc(e.title)} · ` : ''}${e.via === 'text' ? 'вставлено текстом' : e.via ? `скачано через ${esc(nodeByIp(e.via) || e.via)}` : 'скачано напрямую с панели'}</span>
        <span class="spacer"></span>
        ${e.refresh ? `<button class="pill" data-cmp-refresh="${esc(e.name)}"${comp.adding ? ' disabled' : ''}>${icon(comp.adding === e.name ? 'loader' : 'refresh-cw')}${comp.adding === e.name ? 'Обновляю…' : 'Обновить'}</button>` : '<span class="muted" title="Ссылка не запоминалась — вставьте её заново, чтобы обновить">обновить — вставить ссылку заново</span>'}
        <button class="pill" data-cmp-del="${esc(e.name)}">${icon('trash-2')}Удалить</button></div>
    </div>` : ''}</div>`;
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
      s('FI Finland - Helsinki', 'fncloud.lis-boost.space', '31.76.88.209', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'fncloud.lis-boost.space', 'firefox', {path: '/api/v1/get_files', reach: 'filtered', reach_out: 'open', exit_err: 'TCP не подключается отсюда'}),
      s('NL Netherlands - Amsterdam', 'fserv.lis-boost.space', '191.217.224.44', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'fserv.lis-boost.space', 'firefox', {path: '/api/v1/get_files', reach: 'open', tcp_ms: 38, exits: [{ip: '191.217.224.44', cc: 'NL'}]}),
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
  const p1 = e.target.closest('[data-p1]');
  if (p1) {
    const ent = comp.items.find(x => x.name === p1.dataset.p1Name); if (!ent) return;
    const list = ent.servers.filter(x => !x.gone_at && (x.ip || x.addr) === p1.dataset.p1);
    p1.disabled = true;
    if (DEMO) { list.forEach(x => { x.probing = true; }); renderComp(); setTimeout(() => { list.forEach(x => { delete x.probing; x.exits = [{ip: '51.89.101.77', cc: 'DE', hoster: 'OVH'}]; }); renderComp(); }, 1500); return; }
    const r = await auth('comp-probe-one', {name: ent.name, keys: list.map(x => [x.proto, x.addr, String(x.port), x.net || ''])}), j = await r.json().catch(() => ({}));
    if (r.status !== 200) { p1.disabled = false; return toast('Не пробилось: ' + (j.error || 'HTTP ' + r.status)); }
    list.forEach(x => { x.probing = true; }); renderComp();
    clearTimeout(comp.poll); comp.poll = setTimeout(() => loadComp(true), 4000);
    return;
  }
  const ccb = e.target.closest('[data-cmp-cc]');
  if (ccb) { const n = ccb.dataset.cmpName, f = comp.f[n] ||= {cc: '', q: '', all: false}; f.cc = ccb.dataset.cmpCc; f.all = false; return renderComp(); }
  const dl = e.target.closest('[data-dos]'); if (dl) { e.preventDefault(); e.stopPropagation(); return openDossier(dl.dataset.dos); }
  const dr = e.target.closest('[data-dos-row]'); if (dr) return openDossier(dr.dataset.dosRow);
  if (e.target.closest('[data-cand-all]')) { comp.candAll = true; return renderComp(); }
  if (e.target.closest('[data-mem-all]')) { comp.memAll = true; return renderComp(); }
  if (e.target.closest('[data-feed-all]')) { comp.feedAll = true; return renderComp(); }
  const ca = e.target.closest('[data-cmp-ccall]');
  if (ca) { (comp.f[ca.dataset.cmpCcall] ||= {cc: '', q: '', all: false}).ccAll = true; return renderComp(); }
  const all = e.target.closest('[data-cmp-all]');
  if (all) { (comp.f[all.dataset.cmpAll] ||= {cc: '', q: '', all: false}).all = true; return compTableRender(all.dataset.cmpAll); }
  const o = e.target.closest('[data-cmp-open]');
  if (o) { const n = o.dataset.cmpOpen; comp.open.has(n) ? comp.open.delete(n) : comp.open.add(n); renderComp(); }
});
// поиск перерисовывает только таблицу — поле ввода не теряет фокус
const compTableRender = name => { const box = [...document.querySelectorAll('[data-cmp-tbl]')].find(x => x.dataset.cmpTbl === name), e = comp.items?.find(x => x.name === name); if (box && e) box.innerHTML = compTable(vview(e)); };
$('#comp')?.addEventListener('input', e => { const q = e.target.closest('[data-cmp-q]'); if (q) { const f = comp.f[q.dataset.cmpQ] ||= {cc: '', q: '', all: false}; f.q = q.value; f.all = false; compTableRender(q.dataset.cmpQ); } });
$('#comp')?.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-cmp-open]')) { e.preventDefault(); e.target.click(); } });
$('#cmp-go')?.addEventListener('click', () => compAdd());
$('#dos')?.addEventListener('click', e => { if (e.target.id === 'dos' || e.target.closest('#dos-close')) $('#dos').hidden = true; const f = e.target.closest('[data-dos-fresh]'); if (f) openDossier(f.dataset.dosFresh, true); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#dos') && !$('#dos').hidden) $('#dos').hidden = true; });
$('#cmp-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); compAdd(); } });
