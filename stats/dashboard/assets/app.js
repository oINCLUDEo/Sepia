'use strict';
// Загрузка, вход, переключатели и старт. Подключается последним

/* ---------- загрузка ---------- */
let busy = false, again = null;   // again: отложенный запрос, пока идёт текущий (полный важнее частичного)
async function refresh(seriesOnly){
  if (busy) { again = again === null ? !!seriesOnly : again && !!seriesOnly; return; }
  busy = true; document.body.classList.add('loading');
  try {
    if (DEMO) {
      if (!seriesOnly) { state.model = demoModel(); state.day = demoDay(); await loadNotes(); }
      const end = Math.floor(Date.now() / 1000); state.series = {end, metric: state.metric, range: state.range, raw: demoSeriesFor(state.metric, state.range, end)};
    } else if (seriesOnly) {
      state.series = await loadSeries(state.metric, state.range);
    } else {
      // по частям: сначала ноды (шапка, карточки, карта) — их ждут первыми, потом журнал за сутки и график
      const dayP = loadDay(), seriesP = loadSeries(state.metric, state.range), notesP = loadNotes().catch(() => {});   // без заметок страница работает
      dayP.catch(() => {}); seriesP.catch(() => {});   // ошибку покажем ниже, без «unhandled rejection»
      state.model = await loadLive(); state.cachedAt = null; state.authed = true; $('#logout').hidden = false;
      renderAll();
      [state.day, state.series] = await Promise.all([dayP, seriesP, notesP]);
      saveCache();
    }
    if (!seriesOnly) { state.loadedAt = Date.now(); state.authed = true; $('#logout').hidden = DEMO; }
    if (seriesOnly) renderChart(); else renderAll();
  } catch (e) {
    if (e.auth) { state.authed = false; dropCache(); showLogin(state.model ? 'Сессия закончилась, войдите снова' : ''); }
    else toast('Не удалось обновить данные: ' + (e.name === 'AbortError' ? 'приёмник не ответил за 15 с' : e.message));
  } finally {
    busy = false; document.body.classList.remove('loading');
    if (again !== null) { const s = again; again = null; refresh(s); }
  }
}

function showLogin(msg){ $('#login').hidden = false; $('#login-err').textContent = msg || ''; $('#logout').hidden = true; setTimeout(() => $('#p').focus(), 50); }
// вход: node-auth проверяет пароль и ставит cookie; сам пароль на странице и в браузере не хранится
const auth = (path, body) => fetch(API_BASE + '/auth/' + path, {method: 'POST', credentials: 'same-origin', cache: 'no-store',
  headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#login-form .go'); btn.disabled = true; $('#login-err').textContent = '';
  try {
    const r = await auth('login', {user: $('#u').value.trim(), pass: $('#p').value, remember: $('#remember').checked});
    if (r.status === 204) { $('#login').hidden = true; $('#p').value = ''; refresh(); return; }
    $('#login-err').textContent = r.status === 401 ? 'Неверный логин или пароль'
      : r.status === 429 ? 'Слишком много попыток. Подождите 15 минут и попробуйте снова.'
      : 'Сервис входа не отвечает (HTTP ' + r.status + '). Проверьте контейнер node-auth.';
  } catch {
    $('#login-err').textContent = 'Нет связи с панелью. Страница должна быть открыта с panel.ulya.space.';
  } finally { btn.disabled = false; }
});
$('#logout').addEventListener('click', async () => { try { await auth('logout'); } catch {} dropCache(); state.authed = false; showLogin(); });

// прошлые данные — чтобы страница открывалась сразу, а не с пустыми разделами, пока идут запросы.
// Показываем их только после проверки, что вход ещё действует; при выходе стираем
const CACHE_KEY = 'ulya-stats-cache';
// series хранит, какая это метрика и период (series.metric/range) — с ними и сверяемся при показе
const saveCache = () => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({at: Date.now(), model: state.model, day: state.day, series: state.series, slow: state.slow, notes: state.notes}, (k, v) => v instanceof Set ? [...v] : v)); } catch {} };
const dropCache = () => { try { localStorage.removeItem(CACHE_KEY); } catch {} };
function paintCache(){
  let c = null; try { c = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch {}
  if (!c?.model || Date.now() - c.at > 6 * 3600e3) return;
  state.model = c.model; state.day = c.day; state.cachedAt = c.at; state.slow = c.slow || null; state.notes = c.notes || null;
  if (c.series?.metric === state.metric && c.series?.range === state.range) state.series = c.series;
  renderAll();
}
async function start(){
  if (DEMO) return refresh();
  let me = 0;
  try { me = (await fetch(API_BASE + '/auth/me', {credentials: 'same-origin', cache: 'no-store'})).status; } catch {}
  if (me === 401) { dropCache(); state.first = false; return showLogin(); }
  if (me === 204) paintCache();
  refresh();
}

let toastT;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 5000); }

/* ---------- переключатели и клики ---------- */
function moveThumb(seg){ const on = seg.querySelector('[aria-pressed="true"]'), th = seg.querySelector('.thumb'); if (on && th) { th.style.left = on.offsetLeft + 'px'; th.style.width = on.offsetWidth + 'px'; } }
function bindSeg(seg, onPick){
  seg.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.getAttribute('aria-pressed') === 'true') return;
    seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); moveThumb(seg);
    b.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'smooth'}); onPick(b.dataset.v);
  });
}
$('#metric').insertAdjacentHTML('beforeend', Object.entries(METRICS).map(([k, m], i) => `<button data-v="${k}" aria-pressed="${!i}">${m.label}</button>`).join(''));
document.querySelectorAll('#view button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === state.view));
bindSeg($('#range'), v => { state.range = v; refresh(true); if (state.open) { state.drSeries = null; const k = state.open; state.open = null; openNode(k, false); } });
bindSeg($('#metric'), v => { state.metric = v; refresh(true); });
bindSeg($('#view'), v => { state.view = v; store.set('ulya-stats-view', v, true); renderNodes(); });
$('#legend').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const n = b.dataset.n; state.hidden.has(n) ? state.hidden.delete(n) : state.hidden.add(n); renderChart(); });
$('#chips').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled) return; state.filter = b.dataset.c || null; renderHero(); renderNodes(); if (state.filter) $('#nodes-sheet').scrollIntoView({behavior: 'smooth', block: 'start'}); });
$('#note-add').addEventListener('click', () => openNoteForm());
const openFrom = e => { const t = e.target.closest('[data-key]'); if (t) openNode(t.dataset.key); };
for (const id of ['#nodes', '#full', '#day', '#journal']) {
  $(id).addEventListener('click', openFrom);
  $(id).addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-key]')) { e.preventDefault(); openFrom(e); } });
}
$('#heat').addEventListener('click', e => {
  const c = e.target.closest('.cell'); if (!c) return;
  const was = c.getAttribute('aria-pressed') === 'true';
  document.querySelectorAll('#heat .cell[aria-pressed="true"]').forEach(x => x.setAttribute('aria-pressed', 'false'));
  if (was) { $('#heat-note').innerHTML = state.heatNote; return; }
  c.setAttribute('aria-pressed', 'true');
  const n = c.dataset.n, i = +c.dataset.i, v = state.heatData[n][i], h2 = h => String(h).padStart(2, '0'), B = state.heatB;
  $('#heat-note').innerHTML = `<b>${esc(nm(n))}</b>, ${h2(i * B)}:00${B > 1 ? '–' + h2(i * B + B) + ':00' : ''}: ${v == null ? 'нет данных' : `<b>${fmt(v, 1)} Мбит/с</b> в среднем за неделю`}`;
});
$('#drawer').addEventListener('click', e => {
  if (e.target.id === 'dr-scrim' || e.target.closest('#dr-close')) return closeNode();
  const nb = e.target.closest('[data-note]'); if (nb) return openNoteForm(nb.dataset.note);
  const tb = e.target.closest('.dr-tabs [data-tab]'); if (!tb) return;
  state.drTab = tb.dataset.tab;
  document.querySelectorAll('.dr-tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b === tb));
  document.querySelectorAll('.dr-tab').forEach(p => p.hidden = p.dataset.tab !== state.drTab);
  if (state.drTab === 'charts') { const seg = $('#dr-metric'); if (seg) moveThumb(seg); renderDrawerChart(); }
});
addEventListener('keydown', e => { if (e.key === 'Escape' && state.open && $('#note-modal').hidden) closeNode(); });
addEventListener('hashchange', () => { if (location.hash.startsWith('#node=')) return route(); if (state.open) closeNode(); setView(hashView() || 'overview', {push: false}); });

function setTheme(t){ document.documentElement.dataset.theme = t; store.set('ulya-stats-theme', t, true); $('#theme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); }
setTheme(store.get('ulya-stats-theme') || 'dark');
$('#theme').addEventListener('click', () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); if (state.model) renderAll(); });

let rt, lastW = innerWidth; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => {
  document.querySelectorAll('.seg').forEach(moveThumb);
  if (state.model) { renderView(state.vw); if (state.drSeries) renderDrawerChart(); }
  if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; art(); }
}, 150); });
document.fonts?.ready.then(() => document.querySelectorAll('.seg').forEach(moveThumb));
document.querySelectorAll('.seg').forEach(moveThumb);


/* ---------- старт ---------- */
store.del('ulya-stats-auth');   // старый вход хранил пароль в браузере — стираем, если остался
start();                          // без cookie node-auth ответит 401, и появится окно входа
// данные приходят раз в 15 минут — чаще чем раз в 5 минут обновлять незачем
setInterval(() => { if (!document.hidden && (DEMO || state.authed)) refresh(); }, 120000);   // ноды шлют снимок каждую минуту
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.model && (DEMO || state.authed) && Date.now() - state.loadedAt > 120000) refresh(); });
