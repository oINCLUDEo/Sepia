'use strict';
// Сутки: полоса состояний каждой ноды за 24 часа и журнал событий.
// Отдельный сервис не нужен: события выводятся из тех же снимков node-check (раз в 15 мин) и справочника панели
// (раз в 5 мин), с теми же порогами TH, что статусы карточек и алерты.

const SLOT = 900, SLOTS = 96;   // 24 часа по 15 минут
// last_over_time(...[16m]): точка в окне есть, только если снимок пришёл за последние 16 минут. Иначе VictoriaMetrics
// дорисовывает пропуск последним значением, и простой в журнале выходит короче, чем был
const lw = m => `last_over_time(${m}[16m])`;
const EV_EXPR = {
  cpu: `${lw('node_quick_cpu_us')} + ${lw('node_quick_cpu_sy')}`, st: lw('node_quick_cpu_st'), retr: lw('node_quick_retrans_pct'), loss: lw('node_quick_loss_pct'),
  ct: lw('node_quick_conntrack_pct'), mem: lw('node_quick_mem_pct'), tx: lw('node_quick_tx_mbps'),
};

async function loadDay(){
  // сутки выровнены по 15 минутам, как точки запросов VictoriaMetrics: окна 12:00–12:15, а не 11:57–12:12
  const end = Math.floor(Date.now() / 1000 / SLOT) * SLOT, start = end - 86400, keys = Object.keys(EV_EXPR);
  const [m, conn, dis] = await Promise.all([
    Promise.all(keys.map(k => rng(EV_EXPR[k], start, end, SLOT))),
    rng('last_over_time(node_panel_connected[6m])', start, end, 300), rng('last_over_time(node_panel_disabled[6m])', start, end, 300),
  ]);
  const byUuid = res => Object.fromEntries(res.map(s => [s.metric.uuid, s.values.map(([t, v]) => [+t, +v])]));
  return {end, m: Object.fromEntries(keys.map((k, i) => [k, seriesBy(m[i])])), conn: byUuid(conn), dis: byUuid(dis)};
}
function demoDay(){
  const end = Math.floor(Date.now() / 1000 / SLOT) * SLOT, m = {};
  for (const k of Object.keys(EV_EXPR)) m[k] = demoSeriesFor(k, '24h', end);
  const pts = f => { const out = []; for (let t = end - 86400; t <= end; t += 300) out.push([t, f(t)]); return out; };
  return {end, m, conn: {p8: pts(t => t > end - 5 * 3600 ? 0 : 1), p6: pts(t => t > end - 14 * 3600 && t < end - 13.4 * 3600 ? 0 : 1)}, dis: {p9: pts(() => 1)}};
}

// состояние ноды в каждом 15-минутном окне: 2 плохо, 1 замечание, 0 норма, 'silent' молчала, 'none' ещё не собиралась,
// 'lost' панель не видела, 'off' отключена в панели
function dayTimeline(n, day){
  // точка запроса на момент t описывает окно, которое заканчивается в t, — относим её к этому окну
  const t0 = day.end - 86400, idx = t => Math.ceil((t - t0) / SLOT) - 1, slots = Array.from({length: SLOTS}, () => ({}));
  for (const k of Object.keys(EV_EXPR)) for (const [t, v] of remapOne(day.m[k], n.hosts)) { const i = idx(t); if (i >= 0 && i < SLOTS) { slots[i][k] = v; slots[i].seen = true; } }
  const p = n.panel?.uuid, panelAt = (src, i, bad) => (src[p] || []).some(([t, v]) => v === bad && idx(t) === i);
  const first = slots.findIndex(s => s.seen);
  return slots.map((s, i) => {
    if (p && panelAt(day.dis, i, 1)) return {st: 'off'};
    if (p && panelAt(day.conn, i, 0)) return {st: 'lost'};
    if (!s.seen) return {st: first < 0 || i < first ? 'none' : 'silent'};
    let worst = {l: 0};
    for (const k of Object.keys(TH)) {
      const l = k === 'retr' && !(s.tx >= RETR_MIN_TX) ? 0 : lvl(k, s[k]);
      if (l > worst.l) worst = {l, k, v: s[k]};
    }
    return {st: worst.l, k: worst.k, v: worst.v};
  });
}

// события: подряд идущие окна с проблемой (замечание и «плохо» вместе — одно событие, цвет по худшему), «молчала»,
// «панель не видела». Только замечания — если держались от часа. Одно нормальное окно посреди проблемы её не разрывает.
function dayEvents(key, tl, end){
  const t0 = end - 86400, ev = [], kind = s => s.st === 2 || s.st === 1 ? 'bad' : ['silent', 'lost'].includes(s.st) ? s.st : null;
  let cur = null;
  tl.forEach((s, i) => {
    const k = kind(s);
    if (cur && (k === cur.kind || (!k && tl[i + 1] && kind(tl[i + 1]) === cur.kind && cur.kind !== 'silent'))) {
      cur.to = i; if (s.st === 2) cur.err = true; if (s.k) { (cur.why[s.k] ||= {n: 0, max: -Infinity}); cur.why[s.k].n++; cur.why[s.k].max = Math.max(cur.why[s.k].max, s.v); }
      return;
    }
    if (cur) ev.push(cur);
    cur = k ? {key, kind: k, from: i, to: i, err: s.st === 2, why: s.k ? {[s.k]: {n: 1, max: s.v}} : {}} : null;
  });
  if (cur) ev.push(cur);
  return ev.map(e => e.kind === 'bad' ? {...e, kind: e.err ? 'err' : 'warn'} : e).filter(e => e.kind !== 'warn' || e.to - e.from + 1 >= 4).map(e => {
    const top = Object.entries(e.why).sort((a, b) => b[1].n - a[1].n)[0], T = top && TH[top[0]];
    const text = e.kind === 'silent' ? 'не присылала снимки' : e.kind === 'lost' ? 'панель не видела ноду'
      : `${T.label} до ${fmt(top[1].max, T.dec)}${T.unit}`;
    return {...e, text, start: t0 + e.from * SLOT, stop: t0 + (e.to + 1) * SLOT, live: e.to === SLOTS - 1};
  });
}

const DAY_CLS = {0: 'ok', 1: 'warn', 2: 'err', silent: 'silent', lost: 'err', none: 'none', off: 'off'};
const DAY_TXT = {0: 'норма', 1: 'замечание', 2: 'плохо', silent: 'молчала', lost: 'панель не видела', none: 'сбор ещё не шёл', off: 'отключена в панели'};
const dur = s => { const m = Math.round(s / 60); return m < 60 ? `${m} мин` : m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`; };

function renderDay(){
  const el = $('#day'), jr = $('#journal'), day = state.day;
  if (!day || !state.model) { el.innerHTML = '<p class="empty">Загружаю</p>'; jr.innerHTML = ''; return; }
  const N = state.model.nodes, rows = [], events = [];
  for (const key of state.order) {
    const n = N[key], tl = dayTimeline(n, day);
    if (tl.every(s => s.st === 'none' || s.st === 'off')) continue;   // ни одного снимка за сутки и не терялась
    rows.push([key, tl]); events.push(...dayEvents(key, tl, day.end));
  }
  if (!rows.length) { el.innerHTML = '<p class="empty">За сутки нет снимков ни от одной ноды.</p>'; jr.innerHTML = ''; return; }
  const t0 = day.end - 86400, hh = t => new Date(t * 1000).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
  // шкала: подписи каждые 3 часа по местному времени
  let ticks = '';
  for (let i = 0; i <= SLOTS; i++) { const t = t0 + i * SLOT, d = new Date(t * 1000); if (d.getMinutes() < 15 && d.getHours() % 3 === 0) ticks += `<span style="left:${(i / SLOTS * 100).toFixed(2)}%">${String(d.getHours()).padStart(2, '0')}:00</span>`; }
  const legend = `<div class="day-legend"><span><i class="day-bar-k" style="background:color-mix(in srgb,var(--spark) 30%,transparent)"></i>норма</span><span><i style="background:var(--warn)"></i>замечание</span><span><i style="background:var(--err)"></i>плохо или панель не видела</span><span><i style="background:repeating-linear-gradient(135deg,var(--off) 0 3px,transparent 3px 7px)"></i>молчала</span></div>`;
  el.innerHTML = `<div class="day-row day-head"><span></span><div class="day-ticks">${ticks}</div></div>` + rows.map(([key, tl]) => {
    // соседние окна с одинаковым состоянием — один отрезок
    const runs = [];
    tl.forEach((s, i) => { const c = DAY_CLS[s.st]; if (runs.length && runs.at(-1).c === c) runs.at(-1).to = i; else runs.push({c, st: s.st, from: i, to: i}); });
    const bar = runs.map(r => `<i class="${r.c}" style="flex:${r.to - r.from + 1}" title="${hh(t0 + r.from * SLOT)}–${hh(t0 + (r.to + 1) * SLOT)}: ${DAY_TXT[r.st]}"></i>`).join('');
    return `<button class="day-row" data-key="${esc(key)}"><span class="day-name">${esc(N[key].name)}</span><span class="day-bar">${bar}</span></button>`;
  }).join('') + legend;
  // журнал: новые сверху, идущие сейчас — первыми
  events.sort((a, b) => (b.live - a.live) || b.start - a.start);
  const bad = events.filter(e => e.kind !== 'warn').length;
  $('#day-sub').textContent = events.length ? `${events.length} ${events.length === 1 ? 'событие' : events.length < 5 ? 'события' : 'событий'} за сутки${bad ? `, из них серьёзных ${bad}` : ''}` : 'За сутки ничего не случилось';
  jr.innerHTML = events.length ? events.map(e => `<button class="ev ev-${e.kind}" data-key="${esc(e.key)}">
      <span class="ev-time num">${e.from === 0 ? (e.live ? 'все сутки' : `до ${hh(e.stop)}`) : e.live ? `с ${hh(e.start)}` : `${hh(e.start)}–${hh(e.stop)}`}</span>
      <span class="ev-node">${esc(N[e.key].name)}</span>
      <span class="ev-what">${esc(e.text)}</span>
      <span class="ev-dur">${e.live ? 'идёт сейчас' : (e.from === 0 ? 'больше ' : '') + dur(e.stop - e.start)}</span></button>`).join('')
    : '<p class="empty">Ни одна нода не уходила в «плохо» и не молчала.</p>';
}
