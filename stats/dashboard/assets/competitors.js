'use strict';
// «Рынок»: разбор тестовых подписок других VPN — на каких хостерах, транспортах и SNI они держат серверы.
// Подписку скачивает и разбирает node-setup (через node-auth /auth/comp-*), через ноду из SUB_PROXY: ключи (UUID, пароли,
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
function sniKind(s){
  if (!s.sni) return null;
  if (isDomain(s.addr) && base2(s.sni) === base2(s.addr)) return {k: 'own', t: 'свой домен'};
  return {k: 'foreign', t: s.sni};
}
// вход для белых списков мобильного интернета: сервер в РФ (обычно облако из белого списка)
const RU_CLOUD = /yandex|vk ?cloud|vkontakte|mail\.ru|selectel|timeweb|cloud\.ru|sbercloud|mts|rostelecom|beget|reg\.ru|selectel/i;
const isWhite = s => ccOfS(s) === 'RU' || RU_CLOUD.test(s.hoster || s.as_name || '') || /white|бел/i.test(s.remark || '');
const remarkFlag = r => (r || '').replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}|[A-Z]{2}\b)\s*/u, '');
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
    if (DEMO) { comp.items ||= demoComp(); comp.ours = demoCompOurs(); const ru = Object.values(state.model?.nodes || {}).find(n => n.name === 'RU-Aeza'); comp.via = ru ? ipsOf(ru)[0] || '' : ''; }
    else {
      const r = await auth('comp-list', {});
      if (r.status === 401) throw new Error('Войдите заново — сессия истекла');
      if (r.status === 502) throw new Error('node-setup не отвечает: docker compose up -d setup');
      if (r.status === 404) throw new Error('Сервер панели работает на старой версии: git pull, затем docker compose up -d --force-recreate auth setup');
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const j = await r.json(); comp.items = Array.isArray(j) ? j : j.items || []; comp.via = Array.isArray(j) ? '' : j.via || '';
      const ips = [...new Set(Object.values(state.model?.nodes || {}).flatMap(n => ipsOf(n)))].filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      if (ips.length) { const a = await auth('comp-asn', {ips}); if (a.status === 200) comp.ours = await a.json(); }
    }
    comp.at = Date.now();
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
      const body = refreshName ? {name: refreshName} : {name: $('#cmp-name').value.trim(), url, text, ua: $('#cmp-ua').value, remember: $('#cmp-remember').checked};
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

// короткие выводы обычными фразами — вместо стены графиков
function compInsights(items){
  const all = items.flatMap(e => e.servers.map(s => ({...s, who: e.name}))), n = all.length, many = items.length > 1;
  if (!n) return [];
  const count = (f, key) => { const m = new Map(); for (const s of all.filter(f)) { const k = key(s); const g = m.get(k) || {k, n: 0, who: new Set()}; g.n++; g.who.add(s.who); m.set(k, g); } return [...m.values()].sort((a, b) => b.who.size - a.who.size || b.n - a.n); };
  const who = g => many ? ` — у ${g.who.size} из ${items.length}` : '';
  const out = [];
  const tr = count(() => true, transportOf);
  out.push({ic: 'route', t: `Транспорт: чаще всего <b>${esc(tr[0].k)}</b> — ${tr[0].n} из ${n} серверов${who(tr[0])}${tr[1] ? `; ещё ${tr.slice(1, 3).map(g => esc(g.k)).join(', ')}` : ''}.`});
  const own = all.filter(s => sniKind(s)?.k === 'own').length, foreign = count(s => sniKind(s)?.k === 'foreign', s => s.sni);
  out.push({ic: 'shield-check', t: own && !foreign.length ? `Маскировка: везде <b>свой домен</b> — SNI совпадает с адресом сервера (self-steal).`
    : foreign.length ? `Маскировка: ${own ? `свой домен у ${own}, ` : ''}чужой сайт у ${n - own - all.filter(s => !s.sni).length} — чаще всего <b>${esc(foreign[0].k)}</b>${who(foreign[0])}.`
    : 'Маскировка: SNI не указан — сервер без TLS-маскировки.'});
  const ho = count(s => s.ip, hosterName), oursAsn = new Set(Object.values(comp.ours || {}).map(x => x?.asn).filter(Boolean));
  const shared = [...new Set(all.filter(s => s.asn && oursAsn.has(s.asn)).map(hosterName))];
  if (ho.length) out.push({ic: 'server', t: `Хостеры: ${ho.slice(0, 3).map(g => `<b>${esc(g.k)}</b> (${g.n})`).join(', ')}${ho.length > 3 ? ` и ещё ${ho.length - 3}` : ''}.${shared.length ? ` У нас тоже: ${shared.map(esc).join(', ')}.` : ''}`});
  const wl = all.filter(isWhite);
  if (wl.length) out.push({ic: 'smartphone', t: `Для мобильных белых списков — вход в РФ: ${[...new Set(wl.map(hosterName))].map(h => `<b>${esc(h)}</b>`).join(', ')} (${wl.length} серв.${many ? `, у ${new Set(wl.map(s => s.who)).size} из ${items.length}` : ''}).`});
  const odd = count(s => s.port && s.port !== '443', s => s.port);
  if (odd.length) out.push({ic: 'door-open', t: `Нестандартные порты: ${odd.slice(0, 4).map(g => `${esc(g.k)} (${g.n})`).join(', ')}.`});
  return out;
}

function renderComp(){
  const el = $('#comp'); if (!el) return;
  const via = $('#comp-via');
  if (via) via.innerHTML = comp.items == null ? '' : comp.via ? `${icon('shield-check')}через ноду <b>${esc(nodeByIp(comp.via) || comp.via)}</b> — конкурент видит её адрес`
    : `<span class="meh">${icon('shield-alert')}напрямую с сервера панели — конкурент видит его IP</span> · <a href="#" data-cmp-howvia>как качать через ноду</a>`;
  if (comp.busy && !comp.items) { el.innerHTML = '<div class="skel skel-table"></div>'; return; }
  if (comp.err) { el.innerHTML = `<p class="empty">${esc(comp.err)}</p>`; return; }
  const items = [...(comp.items || [])].sort((a, b) => b.at - a.at);
  if (!items.length) { el.innerHTML = '<p class="empty">Пока пусто. Купите тестовую подписку у конкурента и вставьте ссылку выше — разберу, где и на чём стоят его серверы.</p>'; return; }
  const ins = compInsights(items);
  el.innerHTML = `<div class="mk-ins">${items.length > 1 ? `<h3>По ${items.length} конкурентам</h3>` : ''}${ins.map(i => `<p>${icon(i.ic)}<span>${i.t}</span></p>`).join('')}</div>
    <div class="mk-list">${items.map(compCard).join('')}</div>`;
}

function compCard(e){
  const open = comp.open.has(e.name), cc = [...new Set(e.servers.map(ccOfS).filter(Boolean))];
  const tr = Object.entries(e.servers.reduce((m, s) => (m[transportOf(s)] = (m[transportOf(s)] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const d = e.diff, changes = d && (d.added.length || d.removed.length || d.ip.length);
  const row = s => { const sk = sniKind(s), wl = isWhite(s);
    return `<div class="mk-srv"><div class="mk-n">${ccOfS(s) ? flag(ccOfS(s)) : ''}<b>${esc(remarkFlag(s.remark) || s.addr)}</b>${wl ? '<span class="chip">РФ-вход</span>' : ''}</div>
      <div class="mk-w">${esc(hosterName(s))}<span class="sub">${esc(s.ip || s.addr)}${s.asn ? ` · AS${esc(s.asn)}` : ''}${s.cc && s.cc !== ccOfS(s) ? ` · хостер из ${esc(s.cc)}` : ''}</span></div>
      <div class="mk-t">${esc(transportOf(s))}${s.port && s.port !== '443' ? ` · порт ${esc(s.port)}` : ''}<span class="sub">${[s.path, s.fp, s.flow].filter(Boolean).map(esc).join(' · ')}</span></div>
      <div class="mk-s">${sk ? (sk.k === 'own' ? '<span class="chip ok">свой домен</span>' : `<span class="chip">${esc(sk.t)}</span>`) : '<span class="muted">—</span>'}</div></div>`; };
  return `<div class="mk-card${open ? ' open' : ''}">
    <div class="mk-h" data-cmp-open="${esc(e.name)}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="mk-title"><b>${esc(e.name)}</b><span class="sub">${e.servers.length} ${plural(e.servers.length, 'сервер', 'сервера', 'серверов')} · ${esc(tr)}</span></div>
      <div class="mk-flags">${cc.slice(0, 8).map(flag).join('')}</div>
      <span class="muted mk-at">${changes ? `<span class="chip warn">изменения</span> ` : ''}${ago(e.at)}</span>
      ${icon(open ? 'chevron-down' : 'chevron-right')}</div>
    ${open ? `<div class="mk-body">
      ${changes ? `<div class="mk-diff">${icon('history')}<div><b>С прошлого разбора (${ago(d.prev_at)})</b>${d.added.length ? `<p>Появились: ${d.added.map(esc).join(', ')}</p>` : ''}${d.removed.length ? `<p>Пропали: ${d.removed.map(esc).join(', ')}</p>` : ''}${d.ip.length ? `<p>Сменили IP: ${d.ip.map(esc).join('; ')}</p>` : ''}</div></div>`
        : d ? `<p class="note" style="margin:0 0 10px">С прошлого разбора (${ago(d.prev_at)}) ничего не изменилось.</p>` : ''}
      <div class="mk-srvs">${e.servers.map(row).join('')}</div>
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
  return [
    {name: 'Lis VPN', title: '🦊 LiS VPN', at: now - 3600 * 2, via: '', refresh: true, diff: {prev_at: now - 86400 * 2, added: ['Germany - Frankfurt'], removed: ['Poland - Warsaw'], ip: []}, servers: [
      s('FI Finland - Helsinki', 'fncloud.lis-boost.space', '31.76.88.209', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'fncloud.lis-boost.space', 'firefox', {path: '/api/v1/get_files'}),
      s('NL Netherlands - Amsterdam', 'fserv.lis-boost.space', '191.217.224.44', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'fserv.lis-boost.space', 'firefox', {path: '/api/v1/get_files'}),
      s('DE Germany - Frankfurt', 'ger3cloud.lis-boost.space', '144.31.228.6', 'U1 DIGITAL SERVICES LTD', '213877', 'US', '443', 'vless', 'xhttp', 'reality', 'ger3cloud.lis-boost.space', 'firefox', {path: '/api/v1/get_files'}),
      s('RU Russia - Moscow (White Lists)', '188.72.110.50', '188.72.110.50', 'Yandex.Cloud LLC', '215013', 'RU', '443', 'vless', 'xhttp', 'tls', 'shopex.lis-boost.space', 'qq', {path: '/api/cart/sync'})]},
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
  const o = e.target.closest('[data-cmp-open]');
  if (o) { const n = o.dataset.cmpOpen; comp.open.has(n) ? comp.open.delete(n) : comp.open.add(n); renderComp(); }
});
$('#comp')?.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-cmp-open]')) { e.preventDefault(); e.target.click(); } });
$('#comp-via')?.addEventListener('click', e => { if (e.target.closest('[data-cmp-howvia]')) { e.preventDefault(); $('#cmp-how').hidden = !$('#cmp-how').hidden; } });
$('#cmp-go')?.addEventListener('click', () => compAdd());
$('#cmp-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); compAdd(); } });
