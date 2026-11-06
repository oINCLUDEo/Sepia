'use strict';
// Конкуренты («Ёмкость»): разбор тестовых подписок — на каких хостерах, транспортах и SNI держат серверы другие VPN.
// Подписку скачивает и разбирает node-setup (через node-auth /auth/comp-*): ключи (UUID, пароли, shortId) не сохраняются,
// остаются параметры подключения и чей IP — ASN, хостер, страна по реестру. Ссылка на подписку тоже не хранится.
// Сводка — по всем разобранным сразу; «у нас тоже» — если в том же ASN стоят наши ноды

const comp = {items: null, via: '', ours: {}, err: '', busy: false, at: 0, open: new Set(), adding: false, addErr: ''};
const NET_NAME = {tcp: 'TCP', raw: 'TCP', grpc: 'gRPC', xhttp: 'XHTTP', splithttp: 'XHTTP', ws: 'WS', httpupgrade: 'HTTPUpgrade', h2: 'H2', http: 'H2', kcp: 'mKCP', quic: 'QUIC', udp: 'UDP'};
const PROTO_NAME = {vless: 'VLESS', vmess: 'VMess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', hysteria2: 'Hysteria2', hysteria: 'Hysteria', tuic: 'TUIC', wireguard: 'WireGuard'};
const transportOf = s => [PROTO_NAME[s.proto] || s.proto, s.proto === 'shadowsocks' || s.proto.startsWith('hysteria') || s.proto === 'tuic' ? '' : NET_NAME[s.net] || s.net, s.sec && s.sec !== 'none' && !s.proto.startsWith('hysteria') ? (s.sec === 'reality' ? 'Reality' : s.sec.toUpperCase()) : ''].filter(Boolean).join(' · ');
const hosterOfS = s => s.hoster || s.as_name || (s.asn ? 'AS' + s.asn : s.ip ? 'неизвестный' : 'адрес не найден');

async function loadComp(fresh = false){
  if (comp.busy || (!fresh && comp.items && Date.now() - comp.at < 600000)) return renderComp();
  comp.busy = true; comp.err = ''; renderComp();
  try {
    if (DEMO) { comp.items ||= demoComp(); comp.ours = demoCompOurs(); const ru = Object.values(state.model?.nodes || {}).find(n => n.name === 'RU-Aeza'); comp.via = ru ? ipsOf(ru)[0] || '' : ''; }
    else {
      const r = await auth('comp-list', {});
      if (r.status === 401) throw new Error('Войдите заново — сессия истекла');
      if (r.status === 502) throw new Error('node-setup не отвечает: docker compose up -d setup');
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const j = await r.json(); comp.items = Array.isArray(j) ? j : j.items || []; comp.via = Array.isArray(j) ? '' : j.via || '';
      // наши ноды: в каких ASN — для «у нас тоже»
      const ips = [...new Set(Object.values(state.model?.nodes || {}).flatMap(n => ipsOf(n)))].filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      if (ips.length) { const a = await auth('comp-asn', {ips}); if (a.status === 200) comp.ours = await a.json(); }
    }
    comp.at = Date.now();
  } catch (e) { comp.err = e.message; }
  comp.busy = false; renderComp();
}

async function compAdd(){
  const name = $('#cmp-name').value.trim(), url = $('#cmp-url').value.trim(), text = $('#cmp-text').value, ua = $('#cmp-ua').value;
  if (!name) { comp.addErr = 'Впишите название конкурента'; return renderCompForm(); }
  if (!url && !text.trim()) { comp.addErr = 'Вставьте ссылку на подписку или её содержимое'; return renderCompForm(); }
  comp.adding = true; comp.addErr = ''; renderCompForm();
  try {
    let e;
    if (DEMO) { await new Promise(r => setTimeout(r, 900)); e = {...demoComp()[0], name, at: Date.now() / 1000}; }
    else {
      const r = await auth('comp-add', {name, url, text, ua}), j = await r.json().catch(() => ({}));
      if (r.status !== 200) throw new Error(j.error || (r.status === 502 ? 'node-setup не отвечает' : 'HTTP ' + r.status));
      e = j;
    }
    comp.items = [...(comp.items || []).filter(x => x.name !== e.name), e]; comp.open.add(e.name);
    $('#cmp-url').value = ''; $('#cmp-text').value = '';
  } catch (err) { comp.addErr = err.message; }
  comp.adding = false; renderCompForm(); renderComp();
}

function renderCompForm(){
  const b = $('#cmp-go'); if (!b) return;
  b.disabled = comp.adding; b.innerHTML = comp.adding ? `${icon('loader')}Разбираю…` : `${icon('search')}Разобрать`;
  $('#cmp-err').textContent = comp.addErr;
}

// сводка по всем конкурентам: хостеры, страны, транспорты, SNI, порты
function compSummary(items){
  const all = items.flatMap(e => e.servers.map(s => ({...s, who: e.name})));
  const group = (key, filter = () => true) => {
    const m = {};
    for (const s of all.filter(filter)) { const k = key(s); if (!k) continue; const g = m[k] ||= {k, n: 0, who: new Set(), ips: new Set(), cc: {}, asn: s.asn}; g.n++; g.who.add(s.who); if (s.ip) g.ips.add(s.ip); if (s.cc) g.cc[s.cc] = (g.cc[s.cc] || 0) + 1; }
    return Object.values(m).sort((a, b) => b.who.size - a.who.size || b.n - a.n);
  };
  const oursAsn = {}; for (const [ip, x] of Object.entries(comp.ours || {})) if (x?.asn) (oursAsn[x.asn] ||= []).push(ip);
  return {all, hosters: group(hosterOfS), cc: group(s => s.cc), tr: group(transportOf), sni: group(s => s.sni, s => s.sni), port: group(s => s.port), fp: group(s => s.fp, s => s.fp), oursAsn};
}

function renderComp(){
  const el = $('#comp'); if (!el) return;
  if (comp.busy && !comp.items) { el.innerHTML = '<div class="skel skel-table"></div>'; return; }
  if (comp.err) { el.innerHTML = `<p class="empty">${esc(comp.err)}</p>`; return; }
  const items = comp.items || [], viaHtml = compVia();
  if (!items.length) { el.innerHTML = viaHtml + '<p class="empty">Пока ни одной подписки. Купите тестовую у конкурента и вставьте ссылку выше — разберу серверы, транспорты и хостеров.</p>'; return; }
  const S = compSummary(items), tot = S.all.length;
  const bar = (g, max, extra = {}) => `<div class="cbar"><span class="cl" title="${esc(g.k)}">${extra.flag || ''}<span class="cn">${esc(g.k)}</span>${extra.tag || ''}</span><span class="cv"><i style="width:${Math.max(4, g.n / max * 100)}%"></i></span><b>${g.n}</b><span class="cw" title="${esc([...g.who].join(', '))}">${g.who.size} из ${items.length}</span></div>`;
  const block = (title, list, fmtExtra = () => ({}), lim = 8) => list.length ? `<div class="cblock"><h3>${title}</h3>${list.slice(0, lim).map(g => bar(g, list[0].n, fmtExtra(g))).join('')}${list.length > lim ? `<p class="note" style="margin:6px 0 0">…и ещё ${list.length - lim}</p>` : ''}</div>` : '';
  const ours = g => g.asn && S.oursAsn[g.asn] ? `<span class="tag ours" title="Наши ноды в этом же ASN: ${esc(S.oursAsn[g.asn].join(', '))}">у нас ${S.oursAsn[g.asn].length}</span>` : '';
  const ccTop = g => { const c = Object.entries(g.cc).sort((a, b) => b[1] - a[1])[0]?.[0]; return c ? flag(c) : ''; };
  el.innerHTML = viaHtml + `<div class="ctot"><div><b>${items.length}</b><span>подписок</span></div><div><b>${tot}</b><span>серверов</span></div><div><b>${new Set(S.all.map(s => s.ip).filter(Boolean)).size}</b><span>разных IP</span></div><div><b>${S.hosters.length}</b><span>хостеров</span></div></div>
    <div class="cgrid">${block('Хостеры', S.hosters, g => ({flag: ccTop(g), tag: ours(g)}), 10)}${block('Транспорты', S.tr)}${block('SNI', S.sni)}${block('Страны IP (по реестру)', S.cc, g => ({flag: flag(g.k)}))}${block('Порты', S.port, () => ({}), 6)}${block('Fingerprint', S.fp, () => ({}), 5)}</div>
    <div class="clist">${[...items].sort((a, b) => b.at - a.at).map(e => compCard(e)).join('')}</div>`;
}

// через какую ноду node-setup качает подписки: конкурент видит её адрес; напрямую — видит IP панели
const nodeByIp = ip => Object.values(state.model?.nodes || {}).find(n => ipsOf(n).includes(ip))?.name || '';
function compVia(){
  if (comp.via) return `<div class="cvia">${icon('shield-check')}<span>Подписки качаются через ноду <b>${esc(nodeByIp(comp.via) || comp.via)}</b> — сервис конкурента видит её адрес, а не панели. Сменить ноду: на другой <code>sudo bash node-check.sh sub-proxy</code> и новая строка SUB_PROXY в stats/.env.</span></div>`;
  return `<div class="cvia warn">${icon('shield-alert')}<span>Подписки качаются напрямую с сервера панели — конкурент увидит его IP. Чтобы качать через ноду: на ней <code>sudo bash node-check.sh sub-proxy</code>, напечатанную строку SUB_PROXY — в stats/.env и <code>docker compose up -d --force-recreate setup</code>. Или вставляйте подписку текстом.</span></div>`;
}
function compCard(e){
  const open = comp.open.has(e.name), hs = new Set(e.servers.map(hosterOfS));
  const row = s => `<tr><td>${esc(s.remark || '—')}</td><td class="mono">${esc(s.addr)}${s.ip && s.ip !== s.addr ? `<span class="sub">${esc(s.ip)}</span>` : ''}</td>
    <td>${s.cc ? flag(s.cc) : ''}${esc(hosterOfS(s))}${s.asn ? `<span class="sub">AS${esc(s.asn)}${comp.ours && Object.values(comp.ours).some(o => o?.asn === s.asn) ? ' · у нас тоже' : ''}</span>` : ''}</td>
    <td class="n">${esc(s.port)}</td><td>${esc(transportOf(s))}${s.flow ? `<span class="sub">${esc(s.flow)}</span>` : ''}${s.chain ? `<span class="sub">цепочка через ${esc(s.chain)}</span>` : ''}</td>
    <td class="mono">${esc(s.sni || '—')}${s.path ? `<span class="sub">${esc(s.path)}</span>` : ''}${s.host && s.host !== s.sni ? `<span class="sub">host ${esc(s.host)}</span>` : ''}</td><td>${esc(s.fp || s.method || '—')}</td></tr>`;
  return `<div class="ccard${open ? ' open' : ''}"><div class="ccard-h" data-cmp-open="${esc(e.name)}" role="button" tabindex="0">${icon(open ? 'chevron-down' : 'chevron-right')}
      <div><b>${esc(e.name)}</b>${e.title ? `<span class="sub">${esc(e.title)}</span>` : ''}</div>
      <span class="muted">${e.servers.length} серв. · ${hs.size} хост. · ${ago(e.at)}${e.via === 'text' ? ' · вставлено текстом' : e.via ? ` · через ${esc(nodeByIp(e.via) || e.via)}` : ' · напрямую с панели'}</span>
      <button class="icon-btn" title="Удалить разбор" data-cmp-del="${esc(e.name)}">${icon('trash-2')}</button></div>
    ${open ? `<div class="table-wrap"><table class="ctable"><thead><tr><th>Название</th><th>Адрес</th><th>Хостер</th><th class="n">Порт</th><th>Транспорт</th><th>SNI / путь</th><th>Отпечаток</th></tr></thead><tbody>${e.servers.map(row).join('')}</tbody></table></div>` : ''}</div>`;
}

function demoComp(){
  const now = Date.now() / 1000, s = (remark, addr, ip, hoster, asn, cc, port, proto, net, sec, sni, fp, extra = {}) => ({remark, addr, ip, hoster, asn, cc, port, proto, net, sec, sni, fp, ...extra});
  return [
    {name: 'Конкурент A', title: 'FastVPN', at: now - 3600 * 5, servers: [
      s('🇩🇪 Германия', 'de1.fast.example', '45.88.1.10', 'Aeza International Ltd', '210644', 'DE', '443', 'vless', 'tcp', 'reality', 'ads.x5.ru', 'chrome', {flow: 'xtls-rprx-vision'}),
      s('🇳🇱 Нидерланды', '185.10.2.3', '185.10.2.3', 'Stark Industries Solutions Ltd', '44477', 'NL', '443', 'vless', 'tcp', 'reality', 'ads.x5.ru', 'chrome', {flow: 'xtls-rprx-vision'}),
      s('🇫🇮 Финляндия', '95.1.2.3', '95.1.2.3', 'Hetzner Online GmbH', '24940', 'DE', '8443', 'vless', 'grpc', 'reality', 'www.microsoft.com', 'firefox', {path: 'grpc'}),
      s('📱 Мобильный', 'ru1.fast.example', '212.1.1.1', 'Yandex.Cloud LLC', '200350', 'RU', '443', 'vless', 'xhttp', 'reality', 'yandex.ru', 'chrome', {path: '/api'})]},
    {name: 'Конкурент B', title: '', at: now - 86400 * 2, servers: [
      s('Latvia', 'lv.b.example', '5.6.7.8', 'Veesp', '43513', 'LV', '443', 'vless', 'tcp', 'reality', 'ads.x5.ru', 'chrome', {flow: 'xtls-rprx-vision'}),
      s('Germany', 'de.b.example', '45.88.2.20', 'Aeza International Ltd', '210644', 'DE', '443', 'vless', 'tcp', 'reality', 'gosuslugi.ru', 'chrome', {flow: 'xtls-rprx-vision'}),
      s('Hysteria DE', '45.88.2.21', '45.88.2.21', 'Aeza International Ltd', '210644', 'DE', '8443', 'hysteria2', 'udp', 'tls', 'hy.b.example', ''),
      s('Sweden', 'se.b.example', '31.1.1.1', 'AlexHost SRL', '200019', 'MD', '443', 'vless', 'tcp', 'reality', 'ads.x5.ru', 'chrome', {flow: 'xtls-rprx-vision'})]},
  ];
}
const demoCompOurs = () => ({'45.88.176.45': {asn: '210644', hoster: 'Aeza International Ltd'}, '31.1.1.2': {asn: '200019', hoster: 'AlexHost SRL'}});

$('#comp')?.addEventListener('click', async e => {
  const del = e.target.closest('[data-cmp-del]');
  if (del) {
    e.stopPropagation(); const name = del.dataset.cmpDel; if (!confirm(`Удалить разбор «${name}»?`)) return;
    if (!DEMO) { const r = await auth('comp-delete', {name}); if (r.status !== 204) return toast('Не удалилось: HTTP ' + r.status); }
    comp.items = comp.items.filter(x => x.name !== name); return renderComp();
  }
  const o = e.target.closest('[data-cmp-open]');
  if (o) { const n = o.dataset.cmpOpen; comp.open.has(n) ? comp.open.delete(n) : comp.open.add(n); renderComp(); }
});
$('#comp')?.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-cmp-open]')) { e.preventDefault(); e.target.click(); } });
$('#cmp-go')?.addEventListener('click', compAdd);
