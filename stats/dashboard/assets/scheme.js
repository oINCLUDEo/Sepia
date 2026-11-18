'use strict';
// Схема потоков — свободный холст: входы → транзит → выходы, отдельно ноды без цепочек. Блоки — ноды, линии — настоящие пути из
// конфиг-профилей панели (те же связи rw-sync, что на карте). Блок можно перетащить, холст — двигать мышью за фон и
// масштабировать (кнопки, Ctrl + колесо); расстановка запоминается в браузере. Нажатие на ноду показывает под холстом,
// что она принимает и по каким правилам куда шлёт (из её конфиг-профиля, без ключей — node-auth /flows).
// Пока только просмотр: правка связей и запись в Remnawave — отдельным шагом.

const SCH_KEY = 'ulya-stats-scheme-2', SB_W = 204, SB_H = 60, SB_GAP_X = 96, SB_GAP_Y = 22;
const sch = {pos: {}, view: null, hide: {}, hidden: 0, blocks: [], links: [], auto: {}, drag: null, sel: null, dns: null};   // hide — ноды, убранные со схемы; dns — открытая правка DNS профиля
try { const s = JSON.parse(localStorage.getItem(SCH_KEY)) || {}; sch.pos = s.pos || {}; sch.view = s.view || null; sch.hide = s.hide || {}; } catch {}
const schSave = () => { try { localStorage.setItem(SCH_KEY, JSON.stringify({pos: sch.pos, view: sch.view, hide: sch.hide})); } catch {} };
const schAt = id => sch.pos[id] || sch.auto[id] || [0, 0];

// что рисовать: блоки и связи между нодами. Клиентов и интернет отдельными блоками не рисуем: линии к ним сходились в одну
// точку и закрывали схему. Куда подключаются клиенты и где трафик выходит в интернет, показано значками на самой ноде
function schBuild(){
  const N = state.model.nodes, links = state.model.links || [], from = new Set(links.map(l => l.from));
  const byName = (a, b) => a.name.localeCompare(b.name, 'ru', {numeric: true});
  // отключённые в панели не показываем; ноды без статистики остаются — трафик через них всё равно идёт
  const all = Object.values(N).filter(n => n.panel ? n.panel.disabled !== 1 : state.st[n.key]?.cat !== 'off'), has = new Set(all.map(n => n.key));
  // роли считаем по всем нодам, а не только по видимым: вход остаётся входом, даже если его выходы убраны со схемы
  const isB = new Set(all.filter(n => links.length ? from.has(n.key) : n.bridge).map(n => n.key)), inc = {};
  for (const l of links) if (has.has(l.from) && has.has(l.to) && l.from !== l.to) (inc[l.to] ||= []).push(l.from);
  // глубина — самая длинная цепочка до ноды: вход, на который ведёт другой вход (транзит), встаёт колонкой правее; петля её не зацикливает
  const lvl = {}, depth = (k, path = []) => lvl[k] ??= path.includes(k) || path.length > 6 ? 0 : Math.max(0, ...(inc[k] || []).map(p => depth(p, [...path, k]) + 1));
  // Нода бывает и входом, и выходом сразу. Это видно не по связям, а по панели (schFlows, приходит чуть позже связей):
  // hosted — на ноду ведёт включённый хост подписки, клиенты подключаются к ней сами, даже если она же чей-то выход;
  // emits — основной поток («всё остальное») она выпускает в интернет сама, хотя часть шлёт на другую ноду
  const F = schFlows.data, hosted = k => F?.nodes[k]?.hosts?.length > 0, emits = k => schEmits(F?.profiles[F.nodes[k]?.profile], F?.nodes[k]?.inbounds);
  const blk = n => {
    const k = n.key, B = isB.has(k), cin = (B ? !depth(k) : !inc[k]) || hosted(k), out = !B || emits(k), tr = B && !!inc[k];
    return {id: k, n, cin, out, tr, role: [cin && 'вход', tr && 'транзит', out && 'выход'].filter(Boolean).join(', ')};
  };
  const vis = all.filter(n => !sch.hide[n.key]).sort(byName);
  sch.hidden = all.length - vis.length;
  const bridges = vis.filter(n => isB.has(n.key)), order = bridges.map(n => n.key);
  // выходы — в порядке входов, которые на них ведут: линии меньше пересекаются
  const firstB = k => { const i = order.findIndex(b => inc[k].includes(b)); return i < 0 ? 1e9 : i; };
  const exits = vis.filter(n => !isB.has(n.key) && inc[n.key]).sort((a, b) => firstB(a.key) - firstB(b.key));
  const solo = vis.filter(n => !isB.has(n.key) && !inc[n.key]);
  const deep = Math.max(0, ...bridges.map(b => depth(b.key)));
  const cols = [...Array.from({length: deep + 1}, (_, d) => bridges.filter(b => depth(b.key) === d)), exits].filter(c => c.length);
  // ноды без цепочек (клиенты → нода → интернет) — отдельной плотной сеткой: на широком холсте справа от цепочек, на узком — под ними
  const stepX = SB_W + SB_GAP_X, stepY = SB_H + SB_GAP_Y, gx = SB_W + SB_GAP_Y, wide = $('#scheme').clientWidth >= 760;
  const chain = Math.max(0, ...cols.map(c => c.length)), per = wide ? Math.max(chain, 4) : 2, rows = wide ? Math.max(chain, Math.min(per, solo.length)) : chain;
  sch.auto = {};
  cols.forEach((c, ci) => c.forEach((n, i) => { sch.auto[n.key] = [ci * stepX, (rows - c.length) * stepY / 2 + i * stepY]; }));
  solo.forEach((n, i) => {
    const c = Math.floor(i / per), cnt = Math.min(per, solo.length - c * per);
    sch.auto[n.key] = wide ? [cols.length * stepX + c * gx, (rows - cnt) * stepY / 2 + (i % per) * stepY]
      : [(i % per) * gx, (chain ? chain * stepY + SB_GAP_Y : 0) + c * stepY];
  });
  sch.blocks = [...cols.flat(), ...solo].map(blk);
  const seen = new Set(vis.map(n => n.key)), L = new Map();
  for (const l of links) if (seen.has(l.from) && seen.has(l.to) && l.from !== l.to) L.set(l.from + '>' + l.to, [l.from, l.to]);
  sch.links = [...L.values()];
  for (const id of Object.keys(sch.pos)) if (!sch.auto[id]) delete sch.pos[id];   // ноды на схеме больше нет — её место не храним
}

function schPaths(){
  const svg = $('#scheme-links'); if (!svg) return;
  const st = k => state.st[k]?.k;
  svg.innerHTML = sch.links.map(([a, b]) => {
    const [x1, y1] = schAt(a), [x2, y2] = schAt(b), sx = x1 + SB_W, sy = y1 + SB_H / 2, ty = y2 + SB_H / 2, d = Math.max(48, Math.abs(x2 - sx) / 2);
    return `<path data-a="${esc(a)}" data-b="${esc(b)}" class="${st(a) === 'err' || st(b) === 'err' ? 'bad' : ''}" d="M${sx},${sy}C${sx + d},${sy} ${x2 - d},${ty} ${x2},${ty}"/>`;
  }).join('');
}
function schApply(){
  const root = $('#scheme'), v = sch.view; if (!root || !v) return;
  $('#scheme-world').style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
  root.style.backgroundPosition = `${v.x}px ${v.y}px`; root.style.backgroundSize = `${22 * v.k}px ${22 * v.k}px`;   // сетка едет вместе с холстом
}
// вписать всю схему в окно
function schFit(){
  const root = $('#scheme'), W = root.clientWidth, H = root.clientHeight; if (!W || !sch.blocks.length) return;
  const P = sch.blocks.map(b => schAt(b.id)), x0 = Math.min(...P.map(p => p[0])), y0 = Math.min(...P.map(p => p[1]));
  const bw = Math.max(...P.map(p => p[0])) + SB_W - x0, bh = Math.max(...P.map(p => p[1])) + SB_H - y0, k = Math.min(1.15, (W - 48) / bw, (H - 48) / bh);
  sch.view = {k, x: (W - bw * k) / 2 - x0 * k, y: (H - bh * k) / 2 - y0 * k};
  schApply(); schSave();
}
function schZoom(f, cx, cy){
  const root = $('#scheme'), v = sch.view; if (!v) return;
  cx ??= root.clientWidth / 2; cy ??= root.clientHeight / 2;
  const k = Math.min(2, Math.max(.3, v.k * f));
  sch.view = {k, x: cx - (cx - v.x) * k / v.k, y: cy - (cy - v.y) * k / v.k};   // точка под курсором остаётся на месте
  schApply(); schSave();
}

function renderScheme(){
  const root = $('#scheme'); if (!root || !state.model || !state.st || sch.drag || !root.clientWidth) return;   // лист скрыт или идёт перетаскивание
  schBuild();
  const N = state.model.nodes, on = state.model.online || {};
  const sub = n => {
    const s = state.st[n.key];
    if (s.k !== 'ok' && s.t !== 'нет статистики') return s.t;
    return [n.panel?.users != null && `${fmt(n.panel.users)} на связи`, n.tx != null && !s.stale && `${fmt(n.tx, n.tx >= 100 ? 0 : 1)} Мбит/с`].filter(Boolean).join(' · ') || s.t;
  };
  $('#scheme-world').innerHTML = '<svg class="sch-links" id="scheme-links" aria-hidden="true"></svg>' + sch.blocks.map(b => {
    const [x, y] = schAt(b.id), n = b.n, s = state.st[n.key];
    const tag = (b.cin ? `<span title="Сюда подключаются клиенты">${icon('users', 'ti ti-in')}</span>` : '') + (b.tr ? 'транзит' : '') + (b.out ? `<span title="Отсюда трафик уходит в интернет">${icon('globe', 'ti')}</span>` : '');
    return `<div class="sb${b.id === sch.sel ? ' sel' : ''}" data-id="${esc(b.id)}" data-k="${s.k}" data-fkey="${esc(n.key)}" tabindex="0" role="button" aria-label="${esc(n.name)}: ${esc(b.role)}, ${esc(s.t)}, показать правила" style="left:${x}px;top:${y}px">
      <div class="sb-t">${flag(n.cc)}<span class="sb-n">${esc(n.name)}</span><i class="sb-tag">${tag}</i></div><div class="sb-s">${esc(sub(n))}</div>
      <button class="sb-x" data-sch-hide="${esc(n.key)}" aria-label="Убрать ${esc(n.name)} со схемы" title="Убрать со схемы">${icon('x')}</button></div>`;
  }).join('');
  schPaths();
  const nodes = sch.blocks.length;
  $('#scheme-count').textContent = [`${nodes} ${plural(nodes, 'нода', 'ноды', 'нод')}`, `${sch.links.length} ${plural(sch.links.length, 'связь', 'связи', 'связей')}`, on.now != null && `${fmt(on.now)} на связи`].filter(Boolean).join(' · ');
  $('#scheme-unhide').hidden = !sch.hidden; $('#scheme-unhide').textContent = `Вернуть скрытые: ${sch.hidden}`;
  $('#scheme-note').textContent = ((state.model.links || []).length ? 'Линии — настоящие пути между нодами из конфиг-профилей панели.' : 'Связи входов с выходами ещё не пришли из панели (их собирает rw-sync.py), поэтому линий нет.')
    + ' Блоки можно перетаскивать, холст — двигать мышью за фон, масштаб — кнопками или Ctrl + колесо. Лишнюю ноду убирает крестик на её блоке. Расстановка и скрытые ноды запоминаются в этом браузере.';
  if (sch.view) schApply(); else schFit();
  if (sch.sel && !N[sch.sel]) sch.sel = null;
  renderSchRules(); whenAuth(loadFlows);
}
// убрать ноду со схемы или вернуть все убранные; оставшееся вписываем в окно заново
function schHide(key){
  if (key) { sch.hide[key] = 1; if (sch.sel === key) { sch.sel = null; sch.dns = null; } } else sch.hide = {};
  sch.view = null; renderScheme();
}
// «Карта» — два листа: география и схема; рисуем тот, что открыт
const renderMapView = () => state.sub?.map === 'scheme' ? renderScheme() : renderMap();

(() => {
  const root = $('#scheme'); if (!root) return;
  const blockOf = e => e.target.closest?.('.sb');
  root.addEventListener('pointerdown', e => {
    if (e.button || !sch.view || e.target.closest?.('[data-sch-hide]')) return;   // крестик — обычная кнопка, не начало перетаскивания
    const b = blockOf(e);
    if (b) sch.drag = {el: b, id: b.dataset.id, x: e.clientX, y: e.clientY, at: schAt(b.dataset.id), moved: false};
    else if (e.pointerType === 'mouse') { sch.drag = {x: e.clientX, y: e.clientY, at: [sch.view.x, sch.view.y], moved: false}; root.classList.add('pan'); }   // пальцем по фону — обычная прокрутка страницы
    else return;
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener('pointermove', e => {
    const d = sch.drag; if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 5) return;   // дрожание руки при нажатии — не перетаскивание
    d.moved = true;
    if (d.el) { sch.pos[d.id] = [d.at[0] + dx / sch.view.k, d.at[1] + dy / sch.view.k]; d.el.style.left = sch.pos[d.id][0] + 'px'; d.el.style.top = sch.pos[d.id][1] + 'px'; schPaths(); }
    else { sch.view.x = d.at[0] + dx; sch.view.y = d.at[1] + dy; schApply(); }
  });
  const drop = e => {
    const d = sch.drag; if (!d) return;
    sch.drag = null; root.classList.remove('pan');
    if (d.moved) schSave(); else if (d.el?.dataset.fkey && e.type === 'pointerup') schSelect(d.el.dataset.fkey);
  };
  root.addEventListener('pointerup', drop); root.addEventListener('pointercancel', drop);
  root.addEventListener('click', e => { const x = e.target.closest('[data-sch-hide]'); if (x) schHide(x.dataset.schHide); });
  root.addEventListener('keydown', e => { if (e.target.closest('[data-sch-hide]')) return; const b = blockOf(e); if (b?.dataset.fkey && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); schSelect(b.dataset.fkey); } });
  $('#scheme-rules').addEventListener('click', e => {
    const b = e.target.closest('[data-sch-open]'); if (b) return openNode(b.dataset.schOpen);
    const t = e.target.closest('[data-dns-edit],[data-dns-preset],[data-dns-preview],[data-dns-apply],[data-dns-cancel]'); if (t) dnsClick(t);
  });
  root.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); const r = root.getBoundingClientRect(); schZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top); }, {passive: false});
  // наведение на блок выделяет его пути, остальное приглушается — как на карте
  const hl = id => {
    root.classList.toggle('hl', !!id);
    const near = new Set(id ? [id] : []);
    root.querySelectorAll('.sch-links path').forEach(p => { const on = !!id && (p.dataset.a === id || p.dataset.b === id); p.classList.toggle('on', on); if (on) { near.add(p.dataset.a); near.add(p.dataset.b); } });
    root.querySelectorAll('.sb').forEach(b => b.classList.toggle('on', near.has(b.dataset.id)));
  };
  root.addEventListener('pointerover', e => { if (!sch.drag) hl(blockOf(e)?.dataset.id); });
  root.addEventListener('pointerleave', () => hl(null));
  $('#scheme-tidy').addEventListener('click', () => { sch.pos = {}; sch.view = null; renderScheme(); });
  $('#scheme-unhide').addEventListener('click', () => schHide());
  $('#scheme-fit').addEventListener('click', schFit);
  $('#scheme-zin').addEventListener('click', () => schZoom(1.25));
  $('#scheme-zout').addEventListener('click', () => schZoom(1 / 1.25));
})();

/* ---------- правила ноды: что принимает и куда шлёт ---------- */
const schFlows = {data: null, at: 0, busy: false, err: ''};
async function loadFlows(){
  if (schFlows.busy || Date.now() - schFlows.at < 60000) return;
  schFlows.busy = true; schFlows.err = '';
  try {
    if (DEMO) schFlows.data = demoFlows();
    else {
      const r = await auth('flows');
      if (r.status === 501) throw new Error('Нужен API-токен Remnawave: RW_TOKEN в stats/.env, затем docker compose up -d auth');
      if (r.status === 401) throw new Error('Войдите заново — сессия истекла');
      if (r.status === 404) throw new Error('node-auth старый — обновите: cd /opt/Sepia && git pull && cd stats && docker compose up -d --force-recreate auth dashboard');
      if (r.status !== 200) throw new Error('Панель не ответила (HTTP ' + r.status + ') — проверьте права токена');
      schFlows.data = await r.json();
    }
  } catch (e) { schFlows.err = e.message; }
  schFlows.at = Date.now() - (schFlows.err ? 45000 : 0); schFlows.busy = false;   // после ошибки повтор через 15 с, а не при каждой перерисовке
  renderSchRules(); renderScheme();   // роли на холсте («вход и выход») зависят от хостов и правил — перерисовываем и его
}
// основной поток («всё остальное») профиль выпускает напрямую: по правилу без условий для входов этой ноды или, если такого нет, первым исходящим
function schEmits(P, act = []){
  if (!P || P.error) return false;
  const free = t => P.outbounds.find(o => o.tag === t)?.protocol === 'freedom';
  const any = P.rules.filter(r => ruleAny(r) && (!r.inboundTag?.length || !act.length || r.inboundTag.some(t => act.includes(t))));
  return any.length ? any.some(r => !r.balancer && free(r.to)) : free(P.outbounds[0]?.tag);
}
function schSelect(key){
  sch.sel = sch.sel === key ? null : key; sch.dns = null;
  document.querySelectorAll('#scheme .sb').forEach(b => b.classList.toggle('sel', b.dataset.id === sch.sel));
  renderSchRules(true);
}

/* ---------- DNS профиля: показать, поправить, записать в Remnawave ---------- */
// Запись — в два шага: «Что изменится» показывает было/станет, «Записать» требует пароль администратора (ADMIN_PASS).
// Правится только простой DNS (список адресов); с правилами по доменам node-auth откажет, чтобы их не потерять
const DNS_PRESETS = [['Cloudflare', '1.1.1.1'], ['Google', '8.8.8.8'], ['Яндекс', '77.88.8.8'], ['Quad9', '9.9.9.9']];
const dnsList = t => t.split(/[\s,;]+/).filter(Boolean);
const dnsShow = x => `${(x.servers || []).map(esc).join(', ') || 'не задан'}${x.queryStrategy ? ` · ${esc(x.queryStrategy)}` : ''}`;
function dnsForm(users){
  const d = sch.dns, pv = d.preview, opts = [['UseIP', 'IPv4 и IPv6'], ['UseIPv4', 'только IPv4'], ['UseIPv6', 'только IPv6']];
  if (!opts.some(o => o[0] === d.strategy)) opts.push([d.strategy, 'как сейчас']);
  return `<div class="sr-dns-form">
    <label for="sr-dns-s">Серверы DNS — по одному в строке</label><textarea id="sr-dns-s" rows="3" spellcheck="false" autocomplete="off">${esc(d.text)}</textarea>
    <div class="sr-dns-row">${DNS_PRESETS.map(([n, a]) => `<button class="pill" data-dns-preset="${a}">${n} · ${a}</button>`).join('')}</div>
    <label for="sr-dns-q">Какие адреса спрашивать</label><select id="sr-dns-q">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === d.strategy ? ' selected' : ''}>${l} (${esc(v)})</option>`).join('')}</select>
    <p class="sr-dns-warn">Этот профиль используют: ${esc(users)}. После записи Remnawave перезапустит на них Xray — соединения оборвутся на несколько секунд.</p>
    ${pv ? `<div class="sr-dns-pv">${pv.same ? 'Изменений нет — записывать нечего.' : `<div><span>Было</span>${dnsShow(pv.old)}</div><div><span>Станет</span>${dnsShow(pv.new)}</div>`}</div>` : ''}
    ${d.err ? `<p class="login-err">${esc(d.err)}</p>` : ''}
    <div class="sr-dns-row"><button class="pill" data-dns-preview>Что изменится</button>
      ${pv && !pv.same ? `<input id="sr-dns-p" type="password" autocomplete="off" placeholder="Пароль администратора" aria-label="Пароль администратора"><button class="pill on" data-dns-apply>Записать в панель</button>` : ''}
      <button class="pill" data-dns-cancel>Отмена</button></div></div>`;
}
async function dnsCall(apply, admin){
  const d = sch.dns, servers = dnsList(d.text);
  if (DEMO) {   // демо: меняем подставной профиль в памяти страницы
    const P = schFlows.data.profiles[d.profile], old = {servers: P.dns.servers, queryStrategy: P.dns.strategy}, same = old.servers.join() === servers.join() && old.queryStrategy === d.strategy;
    if (apply && !same) P.dns = {...P.dns, set: true, servers, strategy: d.strategy};
    return {name: P.name, old, new: {servers, queryStrategy: d.strategy}, same, done: !!apply && !same};
  }
  const r = await auth('profile-dns', {profile: d.profile, servers, strategy: d.strategy, ...(apply ? {apply: 1, admin} : {})});
  let j = {}; try { j = await r.json(); } catch {}
  if (r.status === 429) throw new Error('Слишком много попыток. Подождите 15 минут и попробуйте снова.');
  if (r.status === 404 && !j.err) throw new Error('node-auth старый — обновите его на сервере панели (git pull и docker compose up -d --force-recreate auth)');
  if (r.status !== 200) throw new Error((j.err || 'Ошибка HTTP ' + r.status) + (j.detail ? ': ' + j.detail : ''));
  return j;
}
async function dnsClick(t){
  const ref = schFlows.data?.nodes[sch.sel], P = ref && schFlows.data.profiles[ref.profile]; if (!P) return;
  const d = sch.dns, read = () => { if ($('#sr-dns-s')) { d.text = $('#sr-dns-s').value; d.strategy = $('#sr-dns-q').value; } };
  if ('dnsEdit' in t.dataset) sch.dns = {profile: ref.profile, text: P.dns.servers.join('\n'), strategy: P.dns.strategy || 'UseIP', preview: null, err: ''};
  else if (!d) return;
  else if ('dnsCancel' in t.dataset) sch.dns = null;
  else if ('dnsPreset' in t.dataset) { read(); if (!dnsList(d.text).includes(t.dataset.dnsPreset)) d.text = [...dnsList(d.text), t.dataset.dnsPreset].join('\n'); d.preview = null; }
  else {
    read(); d.err = '';
    const apply = 'dnsApply' in t.dataset, admin = apply ? $('#sr-dns-p').value : '';
    // записываем ровно то, что показали: поля поменяли после просмотра — сначала показать заново
    if (apply && (dnsList(d.text).join() !== d.preview.new.servers.join() || d.strategy !== d.preview.new.queryStrategy)) d.err = 'Поля изменились после просмотра — нажмите «Что изменится» ещё раз.';
    else if (apply && !admin) d.err = 'Введите пароль администратора.';
    else if (!dnsList(d.text).length) d.err = 'Укажите хотя бы один сервер DNS.';
    else {
      t.disabled = true;
      try {
        const res = await dnsCall(apply, admin);
        if (res.done) { sch.dns = null; schFlows.at = 0; toast(`DNS профиля «${res.name}» записан в панель`); renderSchRules(true); return DEMO ? undefined : loadFlows(); }
        d.preview = res;
      } catch (e) { d.err = e.message; }
    }
  }
  renderSchRules(true);
}
// условие правила — словами: известные категории по-русски, остальное как в конфиге
const RULE_WORD = {'geoip:private': 'локальные адреса', 'geosite:private': 'локальные имена', 'bittorrent': 'торренты', 'geoip:ru': 'адреса России', 'geosite:category-ru': 'сайты России',
  'domain:ru': '.ru', 'domain:su': '.su', 'domain:xn--p1ai': '.рф'};
const ruleWord = x => RULE_WORD[x] || (/^geosite:category-ads/.test(x) ? 'реклама' : String(x).replace(/^geosite:/, 'категория ').replace(/^geoip:/, 'адреса ').replace(/^(domain|full):/, ''));
const ruleAny = r => !['domain', 'ip', 'protocol', 'port', 'network', 'source'].some(k => r[k]?.length);   // без условий — «всё остальное»
function renderSchRules(force){
  const el = $('#scheme-rules'); if (!el) return;
  if (!force && sch.dns && el.querySelector('.sr-dns-form')) return;   // идёт правка DNS — обновление данных не должно стереть введённое
  const N = state.model?.nodes || {}, n = sch.sel && N[sch.sel];
  if (!n) { el.innerHTML = '<p class="note sr-hint">Нажмите на ноду — покажу, что она принимает и по каким правилам куда отправляет трафик.</p>'; return; }
  const head = `<div class="sr-h"><b>${flag(n.cc)}${esc(n.name)}</b><button class="pill" data-sch-open="${esc(n.key)}">Карточка ноды</button></div>`;
  const msg = t => { el.innerHTML = `<div class="sr">${head}<p class="note sr-hint">${esc(t)}</p></div>`; };
  if (schFlows.err) return msg(schFlows.err);
  if (!schFlows.data) return msg('Загружаю правила из панели…');
  const ref = schFlows.data.nodes[n.key], P = ref && schFlows.data.profiles[ref.profile];
  if (!P) return msg(n.panel ? 'У этой ноды в панели не выбран конфиг-профиль.' : 'Этой ноды нет в панели — правил для неё нет.');
  if (P.error) return msg(`Профиль «${P.name}» не удалось разобрать.`);
  const outs = Object.fromEntries(P.outbounds.map(o => [o.tag, o])), ips = x => [...(x.panel?.ips || [])];
  const nodeAt = a => a && Object.values(N).find(x => ips(x).includes(a) || (x.hosts || []).includes(a) || x.site?.domain === a);
  const warn = [];
  const where = (tag, bal) => {
    if (bal) { const b = P.balancers.find(x => x.tag === bal); return [icon('arrow-down-up', 'si'), b ? `балансир ${esc(bal)}: ${b.selector.map(esc).join(', ') || 'пусто'}${b.strategy ? ` · ${esc(b.strategy)}` : ''}` : `балансир ${esc(bal)} — в профиле его нет`]; }
    const o = outs[tag];
    if (!o) { warn.push(`Правило ссылается на исходящий «${tag}», которого нет в профиле`); return [icon('triangle-alert', 'si'), `${esc(tag)} — такого исходящего нет`]; }
    if (o.protocol === 'freedom') return [icon('door-open', 'si'), 'напрямую с этой ноды'];
    if (o.protocol === 'blackhole') return [icon('ban', 'si'), 'блокировка'];
    const t = nodeAt(o.address); if (!t) warn.push(`Выход ${tag} (${o.address}) не найден среди нод панели`);
    return [icon('route', 'si'), `на ${esc(t ? t.name : tag)} <span class="sr-m">${esc(o.address || '')}:${esc(o.port ?? '')}${o.serverName ? ` · ${esc(o.serverName)}` : ''}</span>`];
  };
  const mine = P.inbounds.filter(i => !ref.inbounds.length || ref.inbounds.includes(i.tag));
  const ins = mine.map(i => {
    const names = i.serverNames.map(x => x === '' ? 'без SNI' : x).join(', '), own = /^(127\.|localhost|\/|unix:)/.test(i.target || '');
    return `<li>${icon('server', 'si')}порт ${esc(i.port)} · ${esc([i.security, i.network].filter(Boolean).join(' + '))}${i.target ? ` · ${own ? 'своя заглушка' : 'маска ' + esc(i.target)}` : ''}${names ? ` <span class="sr-m">${esc(names)}</span>` : ''}</li>`;
  }).join('') + (!ref.hosts ? '' : `<li>${icon('users', 'si')}${ref.hosts.length ? `клиенты подключаются напрямую · хосты подписки: ${ref.hosts.map(esc).join(', ')}` : 'включённых хостов подписки с адресом этой ноды нет'}</li>`);
  const what = r => {
    const xs = ['domain', 'ip', 'protocol'].flatMap(k => r[k] || []).map(ruleWord).concat((r.port || []).map(x => 'порт ' + x), (r.network || []).map(x => 'сеть ' + x), (r.source || []).map(x => 'от ' + x));
    return ruleAny(r) ? 'всё остальное' + (r.inboundTag?.length && P.inbounds.length > 1 ? ` с входа ${r.inboundTag.join(', ')}` : '') : xs.slice(0, 6).join(', ') + (xs.length > 6 ? ` и ещё ${xs.length - 6}` : '');
  };
  const row = (w, [ic, t]) => `<li><span class="sr-w">${esc(w)}</span><span class="sr-t">${ic}${t}</span></li>`;
  let rules = P.rules.map(r => row(what(r), where(r.to, r.balancer))).join('');
  // сводка «что с трафиком»: те же правила, собранные по исходу, — видно сразу, что блокируется и что куда идёт
  const kindOf = (tag, bal) => bal ? 'exit' : outs[tag]?.protocol === 'blackhole' ? 'block' : outs[tag]?.protocol === 'freedom' ? 'direct' : 'exit', G = {block: [], direct: [], exit: []};
  const dest = (tag, bal) => bal ? 'балансир ' + bal : nodeAt(outs[tag]?.address)?.name || tag;   // выходов бывает несколько — в сводке называем, на какой
  for (const r of P.rules) { const k = kindOf(r.to, r.balancer); G[k].push(what(r) + (k === 'exit' ? ' → ' + dest(r.to, r.balancer) : '')); }
  // трафик, не попавший ни под одно правило, Xray отдаёт первому исходящему — показываем это последней строкой
  if (!P.rules.some(ruleAny) && P.outbounds[0]) {
    const k = kindOf(P.outbounds[0].tag);
    rules += row('всё, что не попало под правила', where(P.outbounds[0].tag)); G[k].push('всё остальное' + (k === 'exit' ? ' → ' + dest(P.outbounds[0].tag) : ''));
    if (P.outbounds[0].protocol === 'freedom' && P.outbounds.some(o => !['freedom', 'blackhole', 'dns'].includes(o.protocol))) warn.push('Нет правила для остального трафика: он уйдёт напрямую с этой ноды, мимо выхода');
  }
  const sum = [['block', 'ban', 'Блокируется'], ['direct', 'door-open', 'Напрямую с ноды'], ['exit', 'route', 'Через выход']].filter(([k]) => G[k].length)
    .map(([k, ic, l]) => `<li class="sr-g-${k}">${icon(ic, 'si')}<b>${l}</b><span>${esc(G[k].join(' · '))}</span></li>`).join('');
  // DNS профиля; профиль бывает общим для нескольких нод — правка заденет их все
  const D = P.dns, users = Object.entries(schFlows.data.nodes).filter(([, r]) => r.profile === ref.profile).map(([k]) => N[k]?.name).filter(Boolean);
  // блок dns Xray берёт не всегда: только для правил по адресам (IPIfNonMatch/IPOnDemand) и для исходящих с domainStrategy UseIP/ForceIP — иначе имена разрешает система
  const by = [...(/^IP(IfNonMatch|OnDemand)$/.test(P.domainStrategy || '') && P.rules.some(r => r.ip?.length) ? [`правил по адресам (${P.domainStrategy})`] : []),
    ...P.outbounds.filter(o => o.resolve && o.resolve !== 'AsIs').map(o => `выхода ${o.tag} (${o.resolve})`)];
  const dns = !D ? `<p class="sr-dns">${icon('globe', 'si')}нет данных — пересоздайте node-auth: docker compose up -d --force-recreate auth</p>`
    : sch.dns?.profile === ref.profile ? dnsForm(users.join(', ') || n.name)
    : `<p class="sr-dns">${icon('globe', 'si')}${D.servers.length ? `${D.servers.map(esc).join(', ')}${D.strategy ? ` <span class="sr-m">${esc(D.strategy)}</span>` : ''}` : 'не задан'}
       ${D.simple ? '<button class="linkish" data-dns-edit>Изменить</button>' : '<span class="sr-m">с правилами по доменам — правится в панели</span>'}</p>
       <p class="sr-dns-use${by.length ? '' : ' off'}">${by.length ? `Работает для ${esc(by.join(' · '))}.` : 'Сейчас не используется: имена разрешает системный DNS ноды. Чтобы включить, задайте в профиле у прямого выхода sockopt.domainStrategy: UseIP.'}</p>`;
  const open = el.querySelector('.sr-det')?.open;   // обновление данных не должно захлопнуть раскрытый список
  el.innerHTML = `<div class="sr">${head}<div class="sr-cols"><div><p class="sr-l">Принимает</p><ul class="sr-list">${ins || '<li>входов нет</li>'}</ul><p class="sr-l sr-l2">DNS</p>${dns}</div>
    <div><p class="sr-l">Что с трафиком</p><ul class="sr-list sr-sum">${sum}</ul>
      <details class="sr-det"${open ? ' open' : ''}><summary>Правила по порядку · ${P.rules.length} · профиль «${esc(P.name || '')}»</summary><ol class="sr-list sr-rules">${rules}</ol></details></div></div>
    ${warn.length ? `<ul class="sr-list sr-warn">${[...new Set(warn)].map(w => `<li>${icon('triangle-alert', 'si')}${esc(w)}</li>`).join('')}</ul>` : ''}</div>`;
}
// демо: у входов — правила как в боевом профиле (блокировки, Россия напрямую, остальное на выходы), у выходов — всё напрямую
function demoFlows(){
  const N = state.model.nodes, links = state.model.links || [], profiles = {}, nodes = {}, ip = k => [...(N[k]?.panel?.ips || [])][0] || '203.0.113.1';
  const block = [{ip: ['geoip:private'], to: 'BLOCK'}, {protocol: ['bittorrent'], to: 'BLOCK'}, {domain: ['geosite:category-ads'], to: 'BLOCK'}];
  for (const n of Object.values(N)) {
    if (!n.panel) continue;
    const to = links.filter(l => l.from === n.key).map(l => l.to), tag = k => N[k].name.replace(/\W+/g, '_').toUpperCase(), inTag = tag(n.key);
    const base = [{tag: 'DIRECT', protocol: 'freedom', resolve: 'UseIP'}, {tag: 'BLOCK', protocol: 'blackhole'}], dns ={set: true, servers: ['1.1.1.1', '8.8.8.8'], strategy: 'UseIP', simple: true};
    profiles[n.key] = to.length
      ? {name: n.name, dns, inbounds: [{tag: inTag, port: 443, protocol: 'vless', network: 'grpc', security: 'reality', target: 'ads.x5.ru:443', serverNames: ['ads.x5.ru', '']}],
         outbounds: base.concat(to.map(k => ({tag: tag(k), protocol: 'vless', address: ip(k), port: 8443, network: 'raw', serverName: 'cdn.example.com'}))),
         balancers: to.length > 1 ? [{tag: 'EXITS', selector: to.map(tag), strategy: 'leastPing'}] : [],
         rules: block.concat([{domain: ['domain:ru', 'domain:su', 'domain:xn--p1ai', 'geosite:category-ru'], to: 'DIRECT'}, {ip: ['geoip:ru'], to: 'DIRECT'},
           to.length > 1 ? {inboundTag: [inTag], balancer: 'EXITS'} : {inboundTag: [inTag], to: tag(to[0])}])}
      : {name: n.name, dns, inbounds: [{tag: inTag, port: 443, protocol: 'vless', network: 'raw', security: 'reality', target: '127.0.0.1:8081', serverNames: ['node.example.com']}],
         outbounds: base, balancers: [], rules: block};
    // хосты подписки: у входов и у выходов без входа; плюс один выход, к которому ходят и через вход, и напрямую, — «вход и выход»
    nodes[n.key] = {profile: n.key, inbounds: [inTag], hosts: !links.some(l => l.to === n.key) || n.key === links[0]?.to ? [n.name] : []};
  }
  return {at: Date.now() / 1000, profiles, nodes};
}
