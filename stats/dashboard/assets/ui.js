'use strict';
// Разделы вкладками и быстрый поиск (Ctrl+K или /). Подключается перед app.js

/* ---------- разделы ---------- */
// страница короткая: видно один раздел, переключение — вкладками в шапке (на телефоне — панелью снизу).
// Адрес: …/dash/#v=day — можно сохранить ссылку на раздел; карточка ноды — по-прежнему #node=Имя
const VIEWS = {overview: 'Обзор', day: 'Сутки', charts: 'Графики', map: 'Карта', capacity: 'Ёмкость', report: 'Отчёт'};
const viewHash = () => state.vw && state.vw !== 'overview' ? '#v=' + state.vw : location.pathname + location.search;
function setView(v, {push = true, scroll = true} = {}){
  if (!VIEWS[v]) v = 'overview';
  const changed = state.vw !== v;
  state.vw = v; document.body.dataset.view = v;
  document.querySelectorAll('main > [data-view]').forEach(s => s.hidden = s.dataset.view !== v);
  document.querySelectorAll('#tabs button').forEach(b => b.dataset.v === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current'));
  if (push && !state.open) history.replaceState(null, '', viewHash());
  store.set('ulya-stats-vw', v);
  if (changed && scroll) scrollTo({top: 0, behavior: 'instant'});
  if (state.model) renderView(v);
  if (v === 'map') mapAnim?.start(); else mapAnim?.stop();
  if (v === 'overview') globe.kick?.();
}
// то, что зависит от ширины (графики, карта, тепловая карта), перерисовываем, когда раздел стал видимым
function renderView(v){
  if (v === 'map') renderMap();
  if (v === 'charts') { renderChart(); renderHeat(); }
  if (v === 'report') renderReport();
  document.querySelectorAll(`main > [data-view="${v}"] .seg`).forEach(moveThumb);
}
// на вкладках — точка, если в разделе есть что посмотреть: плохие ноды на «Обзоре», серьёзные события за сутки, советы по ёмкости
function tabBadges(){
  const dot = (v, k) => { const b = $(`#tabs button[data-v="${v}"]`); if (!b) return; b.querySelector('.dot')?.remove(); if (k) b.insertAdjacentHTML('beforeend', `<i class="dot ${k}"></i>`); };
  const st = Object.values(state.st || {});
  dot('overview', st.some(s => s.k === 'err' && s.cat !== 'off') ? 'err' : st.some(s => s.k === 'warn') ? 'warn' : '');
  const adv = state.capAdvice || [];
  dot('capacity', adv.some(a => a.k === 'err') ? 'err' : adv.some(a => a.k === 'warn') ? 'warn' : '');
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { if (state.open) closeNode(); setView(b.dataset.v); } });
const hashView = () => (location.hash.match(/^#v=(\w+)/) || [])[1];
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
  for (const [v, l] of Object.entries(VIEWS)) if (has(l, 'раздел', v)) out.push({g: 'Разделы', html: `${icon({overview: 'layout-dashboard', day: 'calendar-clock', charts: 'chart-spline', map: 'map', capacity: 'gauge', report: 'file-text'}[v])}<span class="nm">${l}</span>`, run: () => { if (state.open) closeNode(); setView(v); }});
  const acts = [['Добавить заметку на графики', 'sticky-note', () => openNoteForm()], ['Сменить тему', document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', () => $('#theme').click()],
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
  if (e.key === '/') { e.preventDefault(); openPalette(); }
  // 1–6 — разделы по порядку
  const i = '123456'.indexOf(e.key); if (i >= 0 && !state.open && $('#palette').hidden && $('#note-modal').hidden) setView(Object.keys(VIEWS)[i]);
}, true);
