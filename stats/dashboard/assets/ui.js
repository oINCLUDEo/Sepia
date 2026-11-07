'use strict';
// Разделы вкладками и быстрый поиск (Ctrl+K или /). Подключается перед app.js

/* ---------- разделы ---------- */
// страница короткая: видно один раздел, переключение — вкладками в шапке (на телефоне — панелью снизу).
// Адрес: …/dash/#v=day — можно сохранить ссылку на раздел; карточка ноды — по-прежнему #node=Имя
const VIEWS = {overview: 'Обзор', day: 'Сутки', charts: 'Графики', map: 'Карта', access: 'Доступ', capacity: 'Ёмкость', market: 'Рынок', report: 'Отчёт'};
const viewHash = () => state.vw && state.vw !== 'overview' ? '#v=' + state.vw + (state.sub?.[state.vw] && subsOf(state.vw).length ? '&s=' + state.sub[state.vw] : '') : location.pathname + location.search;

/* ---------- подвкладки ---------- */
// у длинных разделов («Доступ», «Ёмкость») листы — подвкладками: виден один, остальные — переключателем сверху.
// Выбор запоминается и попадает в адрес (#v=access&s=ports)
const subsOf = v => [...document.querySelectorAll(`main > [data-view="${v}"][data-sub]`)];
state.sub = (() => { try { return JSON.parse(store.get('ulya-stats-sub') || '{}') || {}; } catch { return {}; } })();
const PROBLEM = '.k-err,.k-warn,.bad,.meh,.warn,.s-err';
function subBar(v){
  const list = subsOf(v); document.querySelectorAll('.subnav-wrap').forEach(x => x.hidden = x.dataset.view !== v);
  if (!list.length) return;
  if (!list.some(s => s.dataset.sub === state.sub[v])) state.sub[v] = list[0].dataset.sub;
  let bar = document.querySelector(`.subnav-wrap[data-view="${v}"]`);
  if (!bar) {
    bar = document.createElement('div'); bar.className = 'subnav-wrap'; bar.dataset.view = v;
    list[0].before(bar);
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-subk]'); if (b) { state.sub[v] = b.dataset.subk; store.set('ulya-stats-sub', JSON.stringify(state.sub), true); applySub(v); history.replaceState(null, '', viewHash()); return; }
      const o = e.target.closest('[data-only]'); if (o) { state.onlyBad = !state.onlyBad; store.set('ulya-stats-onlybad', state.onlyBad ? '1' : '0', true); applySub(v); }
    });
  }
  bar.hidden = false;
  const nBad = s => s.querySelectorAll('tbody tr').length ? [...s.querySelectorAll('tbody tr')].filter(r => r.querySelector(PROBLEM)).length : 0;
  bar.innerHTML = `<div class="seg subnav" role="tablist"><span class="thumb"></span>${list.map(s => { const n = v === 'access' ? nBad(s) : 0;
    return `<button role="tab" data-subk="${s.dataset.sub}" aria-pressed="${s.dataset.sub === state.sub[v]}">${s.dataset.subLabel}${n ? `<b class="subn">${n}</b>` : ''}</button>`; }).join('')}</div>
    ${v === 'access' ? `<button class="pill only-bad${state.onlyBad ? ' on' : ''}" data-only aria-pressed="${!!state.onlyBad}">${icon(state.onlyBad ? 'circle-alert' : 'list-checks')}${state.onlyBad ? 'Только с проблемами' : 'Все ноды'}</button>` : ''}`;
  requestAnimationFrame(() => moveThumb(bar.querySelector('.seg')));
}
// показать выбранный лист; в «Доступе» — по желанию только строки с проблемами
function applySub(v){
  const list = subsOf(v); if (!list.length) return;
  subBar(v);
  for (const s of list) s.hidden = s.dataset.sub !== state.sub[v];
  // переключатель — внутри видимого листа, под заголовком: по одной линии с содержимым
  const act = list.find(s => !s.hidden), bar = document.querySelector(`.subnav-wrap[data-view="${v}"]`), h2 = act?.querySelector(':scope > h2');
  if (act && bar && bar.parentNode !== act) h2 ? h2.after(bar) : act.prepend(bar);
  else if (act && bar && h2 && bar.previousElementSibling !== h2) h2.after(bar);
  if (v === 'access') for (const s of list) onlyBad(s);
}
function onlyBad(s){
  s.querySelectorAll('.okrow-more').forEach(x => x.remove());
  const rows = [...s.querySelectorAll('tbody tr')]; let hidden = 0;
  for (const r of rows) { const ok = !r.querySelector(PROBLEM); r.classList.toggle('okrow', !!state.onlyBad && ok); if (state.onlyBad && ok) hidden++; }
  const tb = s.querySelector('tbody');
  if (hidden && tb) tb.insertAdjacentHTML('beforeend', `<tr class="okrow-more"><td colspan="40"><button class="linkish" data-only>${icon('circle-check')}ещё ${hidden} ${plural(hidden, 'нода', 'ноды', 'нод')} без замечаний — показать все</button></td></tr>`);
  s.querySelector('.okrow-more [data-only]')?.addEventListener('click', () => { state.onlyBad = false; store.set('ulya-stats-onlybad', '0', true); applySub('access'); });
}
state.onlyBad = store.get('ulya-stats-onlybad') !== '0';   // по умолчанию — только строки с проблемами
// смена раздела — плавно: View Transitions там, где браузер умеет, иначе — короткое появление раздела
function setView(v, opts = {}){
  if (!VIEWS[v]) v = 'overview';
  const go = () => applyView(v, opts), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (state.vw && state.vw !== v && !reduce && document.startViewTransition) document.startViewTransition(go);
  else { go(); if (!reduce) document.querySelectorAll(`main > [data-view="${v}"]`).forEach(s => { s.classList.remove('enter'); void s.offsetWidth; s.classList.add('enter'); }); }
}
const whenAuth = (f, n = 0) => typeof auth === 'function' ? f() : n < 100 && setTimeout(() => whenAuth(f, n + 1), 50);
function applyView(v, {push = true, scroll = true} = {}){
  const changed = state.vw !== v;
  state.vw = v; document.body.dataset.view = v;
  document.querySelectorAll('main > [data-view]').forEach(s => s.hidden = s.dataset.view !== v);
  applySub(v);
  document.querySelectorAll('#tabs button').forEach(b => b.dataset.v === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (push && !state.open) history.replaceState(null, '', viewHash());
  store.set('ulya-stats-vw', v);
  if (changed && scroll) scrollTo({top: 0, behavior: 'instant'});
  if (state.model) renderView(v);
  if (v === 'map') mapAnim?.start(); else mapAnim?.stop();
  if (v === 'overview') globe.kick?.();
  // аккаунты и конкуренты — по запросу к серверу, только когда раздел открыт. После F5 раздел открывается раньше, чем
  // загрузился app.js с auth(), — ждём его
  if (v === 'capacity') whenAuth(loadAccounts);
  if (v === 'market') whenAuth(loadComp);
}
// то, что зависит от ширины (графики, карта, тепловая карта), перерисовываем, когда раздел стал видимым
function renderView(v){
  if (v === 'map') renderMap();
  if (v === 'charts') { renderChart(); renderHeat(); }
  if (v === 'report') renderReport();
  document.querySelectorAll(`main > [data-view="${v}"] .seg`).forEach(moveThumb);
  applySub(v);
}
// на вкладках — точка, если в разделе есть что посмотреть: плохие ноды на «Обзоре», серьёзные события за сутки, советы по ёмкости
// точка на вкладке — там есть что посмотреть: красная — плохо, жёлтая — замечания; при наведении — список, за что именно
function tabBadges(){
  const N = state.model?.nodes || {}, nm2 = k => N[k]?.name || k;
  const dot = (v, list) => {
    const b = $(`#tabs button[data-v="${v}"]`); if (!b) return; b.querySelector('.dot')?.remove();
    const k = list.some(x => x.k === 'err') ? 'err' : list.some(x => x.k === 'warn') ? 'warn' : '';
    b.title = list.length ? [...list].sort((a, c) => (c.k === 'err') - (a.k === 'err')).slice(0, 12).map(x => `${x.k === 'err' ? '●' : '○'} ${x.t}`).join('\n') + (list.length > 12 ? `\n…и ещё ${list.length - 12}` : '') : '';
    if (k) b.insertAdjacentHTML('beforeend', `<i class="dot ${k}" aria-label="${k === 'err' ? 'есть проблемы' : 'есть замечания'}"></i>`);
  };
  dot('overview', Object.entries(state.st || {}).filter(([, s]) => (s.k === 'err' || s.k === 'warn') && s.cat !== 'off').map(([k, s]) => ({k: s.k, t: `${nm2(k)}: ${s.t}`})));
  const okAcc = accOk();
  dot('capacity', [...(state.capAdvice || []).filter(a => a.k === 'err' || a.k === 'warn').map(a => ({k: a.k, t: a.t})),
    ...(acc.data?.list || []).filter(x => x.score >= 3 && okAcc[x.uuid] !== accSig(x)).map(x => ({k: 'warn', t: `Аккаунт ${x.username}: ${x.reasons.map(r => r.t).join('; ')}`}))]);
  dot('access', (state.accessIssues || []).map(a => ({k: a.k, t: `${nm2(a.key)}: ${a.s ? a.s.name + ' — ' : ''}${a.t}`})));
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { if (state.open) closeNode(); setView(b.dataset.v); } });
const hashView = () => (location.hash.match(/^#v=(\w+)/) || [])[1];
{ const m = location.hash.match(/[#&]s=(\w+)/), v = hashView(); if (m && v) state.sub[v] = m[1]; }
setView(hashView() || 'overview', {push: false, scroll: false});

/* ---------- быстрый поиск ---------- */
// ноды (по имени, стране, хостеру, IP), разделы и действия. Стрелки — выбор, Enter — открыть
const pal = {items: [], sel: 0};
function palItems(q){
  q = q.trim().toLowerCase();
  const out = [], N = state.model?.nodes || {}, has = (...xs) => !q || xs.some(x => x && String(x).toLowerCase().includes(q));
  for (const key of state.order || []) {
    const n = N[key], s = state.st?.[key]; if (!n || !s) continue;
    const ips = n.panel ? [...n.panel.ips] : [n.ip];
    if (has(n.name, n.cc, COUNTRY[n.cc], hosterOf(n.name), ...ips, ...n.hosts)) out.push({g: 'Ноды', html: `${flag(n.cc)}<span class="nm">${esc(n.name)}</span><span class="why s-${s.k}">${stIc(s)}${esc(s.t)}</span>`, run: () => { setView(state.vw, {push: false}); openNode(key); }});
  }
  for (const [v, l] of Object.entries(VIEWS)) if (has(l, 'раздел', v)) out.push({g: 'Разделы', html: `${icon({overview: 'layout-dashboard', day: 'calendar-clock', charts: 'chart-spline', map: 'map', access: 'globe', capacity: 'gauge', market: 'radar', report: 'file-text'}[v])}<span class="nm">${l}</span>`, run: () => { if (state.open) closeNode(); setView(v); }});
  // подвкладки длинных разделов: «Доступ → Порты»
  for (const sec of document.querySelectorAll('main > [data-sub]')) { const v = sec.dataset.view, l = `${VIEWS[v]} → ${sec.dataset.subLabel}`;
    if (q && has(l, sec.dataset.subLabel)) out.push({g: 'Разделы', html: `${icon('chevron-right')}<span class="nm">${esc(l)}</span>`, run: () => { if (state.open) closeNode(); state.sub[v] = sec.dataset.sub; store.set('ulya-stats-sub', JSON.stringify(state.sub), true); setView(v); applySub(v); }}); }
  // конкуренты из «Рынка» (если раздел уже открывали)
  for (const e of (typeof comp !== 'undefined' && comp.items) || []) if (q && has(e.name, e.title, 'рынок', 'конкурент'))
    out.push({g: 'Конкуренты', html: `${icon('radar')}<span class="nm">${esc(e.name)}</span><span class="why">${e.servers.filter(x => !x.gone_at).length} серв.</span>`, run: () => { if (state.open) closeNode(); comp.sel = e.name; comp.tab = 'srv'; setView('market'); }});
  const acts = [['Новая нода: команды установки', 'rocket', () => openWizard()],
    ['Разобрать подписку конкурента', 'radar', () => { setView('market'); setTimeout(() => $('#cmp-url')?.focus(), 300); }],
    ['Ноды: по важности / по имени', 'list-checks', () => { setView('overview'); $(`#sort button[data-v="${state.sort === 'name' ? 'imp' : 'name'}"]`)?.click(); }],
    ['Ноды: плотные карточки вкл/выкл', 'layout-dashboard', () => { setView('overview'); $('#dense').click(); }],
    ['Доступ: только с проблемами вкл/выкл', 'circle-alert', () => { setView('access'); setTimeout(() => $('.only-bad')?.click(), 100); }],
    ['Горячие клавиши', 'info', () => openKeys()], ['Добавить заметку на графики', 'sticky-note', () => openNoteForm()], ['Сменить тему', document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', () => $('#theme').click()],
    ['Отчёт за месяц: скачать CSV', 'download', () => { setView('report'); setTimeout(() => $('#report-csv').click(), 300); }]];
  for (const [l, ic, run] of acts) if (has(l, 'действие')) out.push({g: 'Действия', html: `${icon(ic)}<span class="nm">${l}</span>`, run});
  return out.slice(0, 40);
}
function palRender(){
  const list = $('#pal-list'); let g = '', html = '';
  pal.items.forEach((it, i) => { if (it.g !== g) { g = it.g; html += `<div class="pal-grp">${g}</div>`; } html += `<button class="pal-item" role="option" data-i="${i}" aria-selected="${i === pal.sel}">${it.html}</button>`; });
  list.innerHTML = html || '<p class="empty" style="padding:28px 0">Ничего не нашлось</p>';
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest'});
}
function openPalette(){
  $('#palette').hidden = false; const q = $('#pal-q'); q.value = ''; pal.sel = 0; pal.items = palItems(''); palRender(); q.focus();
}
const closePalette = () => { $('#palette').hidden = true; };
const palRun = i => { const it = pal.items[i]; if (!it) return; closePalette(); it.run(); };
$('#pal-q').addEventListener('input', e => { pal.items = palItems(e.target.value); pal.sel = 0; palRender(); });
$('#pal-q').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = pal.items.length; if (n) { pal.sel = (pal.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; palRender(); } }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(pal.sel); }
});
$('#pal-list').addEventListener('click', e => { const b = e.target.closest('.pal-item'); if (b) palRun(+b.dataset.i); });
$('#palette').addEventListener('click', e => { if (e.target.id === 'palette') closePalette(); });
$('#search-btn').addEventListener('click', openPalette);
addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if ((e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#palette').hidden ? openPalette() : closePalette(); return; }
  if (e.key === 'Escape' && !$('#palette').hidden) { e.stopImmediatePropagation(); closePalette(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !$('#login').hidden) return;
  // карточка ноды открыта: j / → — следующая, k / ← — предыдущая
  if (state.open && ['j', 'k', 'о', 'л', 'ArrowRight', 'ArrowLeft'].includes(e.key) && $('#palette').hidden) {
    const o = state.order || [], i = o.indexOf(state.open); if (i < 0 || o.length < 2) return;
    e.preventDefault(); openNode(o[(i + (['j', 'о', 'ArrowRight'].includes(e.key) ? 1 : -1) + o.length) % o.length]); return;
  }
  if (e.key === '/') { e.preventDefault(); openPalette(); }
  if (e.key === '?') { e.preventDefault(); openKeys(); return; }
  // 1–7 — разделы по порядку
  const i = '12345678'.indexOf(e.key); if (i >= 0 && !state.open && $('#palette').hidden && $('#note-modal').hidden) setView(Object.keys(VIEWS)[i]);
}, true);

/* ---------- горячие клавиши: «?» ---------- */
const HOTKEYS = [['Ctrl K или /', 'поиск: ноды, разделы, конкуренты, действия'], ['1 … 8', 'разделы по порядку'], ['j / →', 'следующая нода (в карточке ноды)'],
  ['k / ←', 'предыдущая нода'], ['Esc', 'закрыть карточку или окно'], ['?', 'этот список']];
function openKeys(){
  let m = $('#keys');
  if (!m) {
    document.body.insertAdjacentHTML('beforeend', `<div class="modal" id="keys" hidden><div class="modal-box keys-box" role="dialog" aria-modal="true" aria-label="Горячие клавиши">
      <div class="keys-h"><b>Горячие клавиши</b><button class="icon-btn" data-keys-close aria-label="Закрыть">${icon('x')}</button></div>
      <dl class="keys-list">${HOTKEYS.map(([k, t]) => `<div><dt>${k.split(' ').map(x => /^[a-zа-я0-9/?→←–]|Ctrl|Esc/i.test(x) && x !== 'или' && x !== '/' ? `<kbd>${esc(x)}</kbd>` : esc(x)).join(' ')}</dt><dd>${esc(t)}</dd></div>`).join('')}</dl>
      <p class="muted">Ссылки на разделы и ноды можно копировать из адресной строки: …#v=access&amp;s=ports, …#node=RU-Aeza-2.</p></div></div>`);
    m = $('#keys');
    m.addEventListener('click', e => { if (e.target.id === 'keys' || e.target.closest('[data-keys-close]')) m.hidden = true; });
    addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) { e.stopImmediatePropagation(); m.hidden = true; } }, true);
  }
  m.hidden = false;
}
