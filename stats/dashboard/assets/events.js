'use strict';
// Сутки: полоса состояний каждой ноды за 24 часа и журнал событий.
// Отдельный сервис не нужен: события выводятся из тех же снимков node-check (раз в минуту, у старых — раз в 15 мин),
// справочника панели (раз в 5 мин) и действий, которые ноды сделали сами, с теми же порогами TH, что статусы и алерты.

const SLOT = 900, SLOTS = 96;   // 24 часа по 15 минут
// среднее за 15-минутное окно (минутные снимки), conntrack — максимум. Точки в окне нет, если за эти 15 минут не
// пришло ни одного снимка: так VictoriaMetrics не дорисовывает пропуск последним значением
const aw = m => `avg_over_time(${m}[15m])`;
const EV_EXPR = {
  cpu: `${aw('node_quick_cpu_us')} + ${aw('node_quick_cpu_sy')}`, st: aw('node_quick_cpu_st'), retr: aw('node_quick_retrans_pct'), loss: aw('node_quick_loss_pct'),
  ct: 'max_over_time(node_quick_conntrack_pct[15m])', mem: aw('node_quick_mem_pct'), tx: aw('node_quick_tx_mbps'),
};

async function loadDay(){
  // сутки выровнены по 15 минутам, как точки запросов VictoriaMetrics: окна 12:00–12:15, а не 11:57–12:12
  const end = Math.floor(Date.now() / 1000 / SLOT) * SLOT, start = end - 86400, keys = Object.keys(EV_EXPR);
  const [m, conn, dis, users, usersY, acts, sc, stls, sdays] = await Promise.all([
    Promise.all(keys.map(k => rng(EV_EXPR[k], start, end, SLOT))),
    rng('last_over_time(node_panel_connected[6m])', start, end, 300), rng('last_over_time(node_panel_disabled[6m])', start, end, 300),
    // онлайн по нодам сейчас и в тот же момент сутками раньше — для «похоже, IP заблокирован»
    rng('last_over_time(node_panel_users_online[15m])', start, end, SLOT), rng('last_over_time(node_panel_users_online[15m] offset 1d)', start, end, SLOT),
    // что ноды сделали сами: обновились, увеличили conntrack, перезапустили таймер (сырые точки за сутки)
    inst('node_action_n[24h]'),
    // маскировка: заглушка на 443 проверяется раз в 10 минут — в 15-минутном окне хотя бы одна проверка
    rng('max by (node) (last_over_time(node_site_code[15m]))', start, end, SLOT), rng('min by (node) (last_over_time(node_site_tls_ok[15m]))', start, end, SLOT),
    rng('min by (node) (last_over_time(node_site_cert_days[15m]))', start, end, SLOT),
  ]);
  const byUuid = res => Object.fromEntries(res.map(s => [s.metric.uuid, s.values.map(([t, v]) => [+t, +v])]));
  const actions = acts.flatMap(s => s.values.map(([t]) => ({host: s.metric.node, kind: s.metric.kind, info: s.metric.info || '', t: +t})));
  return {end, m: Object.fromEntries(keys.map((k, i) => [k, seriesBy(m[i])])), conn: byUuid(conn), dis: byUuid(dis), users: byUuid(users), usersY: byUuid(usersY), actions,
    site: {code: seriesBy(sc), tls: seriesBy(stls), days: seriesBy(sdays)}};
}
function demoDay(){
  const end = Math.floor(Date.now() / 1000 / SLOT) * SLOT, m = {};
  for (const k of Object.keys(EV_EXPR)) m[k] = demoSeriesFor(k, '24h', end);
  const pts = f => { const out = []; for (let t = end - 86400; t <= end; t += 300) out.push([t, f(t)]); return out; };
  const pts15 = f => { const out = []; for (let t = end - 86400 + SLOT; t <= end; t += SLOT) out.push([t, f(t)]); return out; };
  const usersY = {}, users = {};
  for (const s of DEMO_NODES.filter(x => x.uuid)) { usersY[s.uuid] = pts15(t => Math.round(s.users * (.4 + .6 * demoLoad(t)))); users[s.uuid] = pts15(t => Math.round(s.users * (.4 + .6 * demoLoad(t)))); }
  // «NL-TurtleGuard» последние 2,5 часа почти без людей, хотя вчера в это время их было ~100: так выглядит блокировка IP
  usersY.p10 = pts15(t => Math.round(102 * (.4 + .6 * demoLoad(t)))); users.p10 = pts15(t => t > end - 2.5 * 3600 ? 4 : Math.round(102 * (.4 + .6 * demoLoad(t))));
  const actions = [{host: 'aeza-de', kind: 'update', info: '3f1c2a9-6360fc6', t: end - 19.2 * 3600}, {host: 'eest', kind: 'conntrack', info: '262144-524288', t: end - 7.6 * 3600},
    {host: 'ruvds', kind: 'update-failed', info: '0ad7bf3', t: end - 19 * 3600}];
  // у EE-INTEZIO заглушка 45 минут отвечала 502, у SE-Aeza сертификат истекает через 11 дней
  const site = {code: {'SE-Ulya': pts15(t => t > end - 4.5 * 3600 && t <= end - 3.75 * 3600 ? 502 : 200)}, tls: {}, days: {shade: pts15(() => 11)}};
  return {end, m, site, conn: {p8: pts(t => t > end - 5 * 3600 ? 0 : 1), p6: pts(t => t > end - 14 * 3600 && t < end - 13.4 * 3600 ? 0 : 1)}, dis: {p9: pts(() => 1)}, users, usersY, actions};
}

// состояние ноды в каждом 15-минутном окне: 2 плохо, 1 замечание, 0 норма, 'silent' молчала, 'none' ещё не собиралась,
// 'lost' панель не видела, 'off' отключена в панели
function dayTimeline(n, day){
  // точка запроса на момент t описывает окно, которое заканчивается в t, — относим её к этому окну
  const t0 = day.end - 86400, idx = t => Math.ceil((t - t0) / SLOT) - 1, slots = Array.from({length: SLOTS}, () => ({}));
  for (const k of Object.keys(EV_EXPR)) for (const [t, v] of remapOne(day.m[k], n.hosts)) { const i = idx(t); if (i >= 0 && i < SLOTS) { slots[i][k] = v; slots[i].seen = true; } }
  const p = n.panel?.uuid, panelAt = (src, i, bad) => (src[p] || []).some(([t, v]) => v === bad && idx(t) === i);
  const first = slots.findIndex(s => s.seen);
  const at = (src, i) => { for (const [t, v] of src?.[p] || []) if (idx(t) === i) return v; return null; };
  const site = {}, at2 = (by, i) => { if (!by) return null; const pts = site[by === day.site.code ? 'c' : by === day.site.tls ? 't' : 'd'] ||= remapOne(by, n.hosts);
    let r = null; for (const [t, v] of pts) if (idx(t) === i) r = v; return r; };
  return slots.map((s, i) => {
    if (p && panelAt(day.dis, i, 1)) return {st: 'off'};
    if (p && panelAt(day.conn, i, 0)) return {st: 'lost'};
    if (p && day.users) {   // те же условия, что у статуса «похоже, IP заблокирован»
      const now = at(day.users, i), y = at(day.usersY, i), net = day.net?.[i];
      if (y >= BLOCK.minY && now != null && now / y < BLOCK.drop && net != null && net >= BLOCK.net) return {st: 'block', now, y};
    }
    if (!s.seen) return {st: first < 0 || i < first ? 'none' : 'silent'};
    let worst = {l: 0};
    for (const k of Object.keys(TH)) {
      const l = k === 'retr' && !(s.tx >= RETR_MIN_TX) ? 0 : lvl(k, s[k]);
      if (l > worst.l) worst = {l, k, v: s[k]};
    }
    // маскировка — те же условия, что у алертов NodeDecoyDown / NodeCertInvalid / NodeCertExpiring. Заглушка не отвечает —
    // важнее метрик; «сертификат скоро истечёт» — только если метрики в норме, чтобы не прятать их замечания весь день
    const sc = at2(day.site?.code, i), tls = at2(day.site?.tls, i), days = at2(day.site?.days, i);
    if (sc != null && (sc < 200 || sc >= 400)) worst = {l: 2, k: 'mask', v: sc, why: 'down'};
    else if (tls === 0 && sc > 0) worst = {l: 2, k: 'mask', v: 0, why: 'tls'};
    else if (days != null && days < 10 && !worst.l) worst = {l: 1, k: 'mask', v: days, why: 'days'};
    return {st: worst.l, k: worst.k, v: worst.v, why: worst.why};
  });
}

// события: подряд идущие окна с проблемой (замечание и «плохо» вместе — одно событие, цвет по худшему), «молчала»,
// «панель не видела». Только замечания — если держались от часа. Одно нормальное окно посреди проблемы её не разрывает.
function dayEvents(key, tl, end){
  const t0 = end - 86400, ev = [], kind = s => s.k === 'mask' ? 'mask:' + s.why : s.st === 2 || s.st === 1 ? 'bad' : ['silent', 'lost', 'block'].includes(s.st) ? s.st : null;
  let cur = null;
  tl.forEach((s, i) => {
    const k = kind(s);
    if (cur && (k === cur.kind || (!k && tl[i + 1] && kind(tl[i + 1]) === cur.kind && cur.kind !== 'silent'))) {
      cur.to = i; if (s.st === 2) cur.err = true; if (s.st === 'block' && (!cur.b || s.now / s.y < cur.b.now / cur.b.y)) cur.b = s; if (s.k) { (cur.why[s.k] ||= {n: 0, max: -Infinity}); cur.why[s.k].n++; cur.why[s.k].max = Math.max(cur.why[s.k].max, s.v); }
      return;
    }
    if (cur) ev.push(cur);
    cur = k ? {key, kind: k, from: i, to: i, err: s.st === 2, b: s.st === 'block' ? s : null, why: s.k ? {[s.k]: {n: 1, max: s.v}} : {}} : null;
  });
  if (cur) ev.push(cur);
  // сертификат истекает — состояние на весь день, в журнале достаточно одного события, без требования «от часа»
  // шум не показываем: «молчала» и «панель не видела» короче 30 минут (перезапуск, настройка) и всё в первый час новой
  // ноды — пока её ставят, она то пропадает, то появляется
  const first = tl.findIndex(s => s.st !== 'none' && s.st !== 'off'), quiet = e => (e.kind === 'silent' || e.kind === 'lost') && !e.live && e.to - e.from + 1 < 2;
  return ev.map(e => e.kind === 'bad' ? {...e, kind: e.err ? 'err' : 'warn'} : e).filter(e => (e.kind !== 'warn' || e.to - e.from + 1 >= 4) && !quiet(e) && !(first > 0 && e.from < first + 4 && !e.live)).map(e => {
    const top = Object.entries(e.why).sort((a, b) => b[1].n - a[1].n)[0], T = top && TH[top[0]], mk = e.kind.startsWith('mask:') && e.kind.slice(5);
    if (mk) return {...e, kind: mk === 'days' ? 'warn' : 'err', ic: 'shield-alert', start: t0 + e.from * SLOT, stop: t0 + (e.to + 1) * SLOT, live: e.to === SLOTS - 1,
      text: mk === 'down' ? `заглушка не отвечала как сайт (HTTP ${e.why.mask?.max > 0 ? fmt(e.why.mask.max) : 'нет ответа'}) — маскировка выдаёт ноду`
        : mk === 'tls' ? 'сертификат заглушки не проходил проверку — маскировка выдаёт ноду' : `сертификат заглушки истекает: осталось ${fmt(e.why.mask?.max)} дн`};
    const text = e.kind === 'silent' ? 'не присылала снимки' : e.kind === 'lost' ? 'панель не видела ноду'
      : e.kind === 'block' ? `похоже, IP заблокирован: онлайн ${fmt(e.b.y)} → ${fmt(e.b.now)}`
      : `${T.label} до ${fmt(top[1].max, T.dec)}${T.unit}`;
    return {...e, text, start: t0 + e.from * SLOT, stop: t0 + (e.to + 1) * SLOT, live: e.to === SLOTS - 1};
  });
}

const DAY_CLS = {0: 'ok', 1: 'warn', 2: 'err', silent: 'silent', lost: 'err', block: 'block', none: 'none', off: 'off'};
const DAY_TXT = {0: 'норма', 1: 'замечание', 2: 'плохо', silent: 'молчала', lost: 'панель не видела', block: 'похоже, IP заблокирован', none: 'сбор ещё не шёл', off: 'отключена в панели'};
// что нода сделала сама — человеческим языком
function actionText(a){
  const [x, y] = a.info.split('-');
  switch (a.kind) {
    case 'conntrack': return `сама увеличила таблицу соединений: ${fmt(+x)} → ${fmt(+y)}`;
    case 'update': return `node-check обновился: ${x} → ${y}`;
    case 'update-failed': return 'node-check не смог обновиться: на ноде правки в файлах, git status в /root/Sepia';
    case 'trace': return `потери на пути — сама сделала трассировку до ${a.info}: смотрите «Проверки» в карточке ноды`;
    case 'update-blocked': return `не стала обновляться на ${x}: проверка кода не прошла — осталась на прежней версии`;
    case 'update-rollback': return `новая версия node-check ${x} не прошла самопроверку — нода осталась на ${y}. Причина — в /var/log/rw-node-check-actions.log на ноде`;
    case 'nginx-reload': return 'сама перезагрузила nginx: сертификат продлён, а отдавался старый';
    case 'nginx-restart': return 'nginx был остановлен — запустила снова';
    case 'cert-renew': return 'сама продлила сертификат заглушки';
    case 'cert-renew-failed': return 'не смогла продлить сертификат заглушки — нужен порт 80 и A-запись на ноду';
    case 'timer-fixed': return 'таймер сбора был остановлен — запущен снова';
    default: return `${a.kind} ${a.info}`;
  }
}
// онлайн по сети в каждом окне к тому же окну вчера — общий знаменатель для детектора блокировки
function dayNet(day){
  if (!day.users) return null;
  const sum = src => { const out = Array(SLOTS).fill(0); for (const pts of Object.values(src)) for (const [t, v] of pts) { const i = Math.ceil((t - (day.end - 86400)) / SLOT) - 1; if (i >= 0 && i < SLOTS) out[i] += v; } return out; };
  const now = sum(day.users), y = sum(day.usersY);
  return now.map((v, i) => y[i] >= 50 ? v / y[i] : null);
}
const dur = s => { const m = Math.round(s / 60); return m < 60 ? `${m} мин` : m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`; };

// все события суток: проблемы по полосам, что ноды сделали сами, заметки. rows — полосы для «Суток»
function dayAll(){
  const day = state.day, N = state.model.nodes, rows = [], events = [];
  day.net ||= dayNet(day);
  for (const key of state.order) {
    const n = N[key], tl = dayTimeline(n, day);
    if (tl.every(s => s.st === 'none' || s.st === 'off')) continue;   // ни одного снимка за сутки и не терялась
    rows.push([key, tl]); events.push(...dayEvents(key, tl, day.end));
  }
  for (const a of day.actions || []) {   // что ноды сделали сами — в тот же журнал, нейтральным цветом
    const key = state.model.keyOf[a.host] || 'h:' + a.host;
    if (N[key]) events.push({key, kind: 'info', text: actionText(a), start: a.t, stop: a.t, live: false, from: -1, action: true});
  }
  for (const nt of state.notes || []) if (nt.t > day.end - 86400 && (!nt.node || N[nt.node]))
    events.push({key: nt.node || '', kind: 'note', text: nt.text, start: nt.t, stop: nt.t, live: false, from: -1, action: true});
  events.sort((a, b) => (b.live - a.live) || b.start - a.start);
  return {rows, events};
}
const EV_IC = {err: 'circle-x', warn: 'triangle-alert', silent: 'clock-alert', lost: 'unplug', block: 'ban', info: 'activity', note: 'sticky-note'};
const evIc = e => icon(e.ic || EV_IC[e.kind] || 'info', 'si');
const evTime = (e, hh) => e.action ? hh(e.start) : e.from === 0 ? (e.live ? 'все сутки' : `до ${hh(e.stop)}`) : e.live ? `с ${hh(e.start)}` : `${hh(e.start)}–${hh(e.stop)}`;
const evDur = e => e.kind === 'note' ? 'заметка' : e.action ? 'сама' : e.live ? 'идёт сейчас' : (e.from === 0 ? 'больше ' : '') + dur(e.stop - e.start);

// полоса «Сейчас» в шапке: что не так прямо сейчас — самое серьёзное первым, без прокрутки; нажатие открывает ноду.
// Всё хорошо — одна строка «всё в норме» и последнее событие суток
function renderTicker(){
  const el = $('#ticker'); if (!el || !state.model || !state.st) return;
  const N = state.model.nodes, hh = t => new Date(t * 1000).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
  const rank = s => (s.k === 'err' ? 2 : 1) + (s.block ? 1 : 0);
  const bad = state.order.filter(k => ['err', 'warn'].includes(state.st[k]?.k) && state.st[k].cat !== 'off').sort((a, b) => rank(state.st[b]) - rank(state.st[a]));
  const max = innerWidth < 640 ? 1 : innerWidth < 1100 ? 2 : 3, shown = bad.slice(0, max);
  let html;
  if (bad.length) {
    html = `<span class="tk-label">Сейчас</span>` + shown.map(k => { const s = state.st[k]; return `<button class="tk-item s-${s.k}" data-key="${esc(k)}">${stIc(s)}<b>${esc(N[k].name)}</b><span>${esc(s.t)}</span></button>`; }).join('')
      + (bad.length > max ? `<button class="tk-more" data-filter="${bad.some(k => state.st[k].k === 'err') ? 'err' : 'warn'}">ещё ${bad.length - max}</button>` : '');
  } else {
    const last = state.day ? dayAll().events.find(e => !e.live) : null;
    html = `<span class="tk-label">Сейчас</span><span class="tk-item s-ok">${icon('circle-check', 'si')}<b>Все ноды в норме</b></span>`
      + (last ? `<button class="tk-item tk-last"${last.key ? ` data-key="${esc(last.key)}"` : ''}><span class="tk-t">последнее · ${hh(last.start)}</span><b>${esc(last.key ? N[last.key].name : 'Вся сеть')}</b><span>${esc(last.text)}</span></button>` : '');
  }
  el.innerHTML = html; el.hidden = false;
}
$('#ticker').addEventListener('click', e => {
  const b = e.target.closest('[data-key]'); if (b) return openNode(b.dataset.key);
  const m = e.target.closest('[data-filter]'); if (m) { state.filter = m.dataset.filter; renderHero(); renderNodes(); $('#nodes-sheet').scrollIntoView({behavior: 'smooth', block: 'start'}); }
});

function renderDay(){
  const el = $('#day'), jr = $('#journal'), day = state.day;
  if (!day || !state.model) { el.innerHTML = '<div class="skel skel-bar"></div>'.repeat(6); jr.innerHTML = ''; return; }
  const N = state.model.nodes, {rows, events} = dayAll();
  if (!rows.length) { el.innerHTML = '<p class="empty">За сутки нет снимков ни от одной ноды.</p>'; jr.innerHTML = ''; return; }
  const t0 = day.end - 86400, hh = t => new Date(t * 1000).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
  // шкала: подписи каждые 3 часа по местному времени
  let ticks = '';
  for (let i = 0; i <= SLOTS; i++) { const t = t0 + i * SLOT, d = new Date(t * 1000); if (d.getMinutes() < 15 && d.getHours() % 3 === 0) ticks += `<span style="left:${(i / SLOTS * 100).toFixed(2)}%">${String(d.getHours()).padStart(2, '0')}:00</span>`; }
  const legend = `<div class="day-legend"><span><i class="day-bar-k" style="background:color-mix(in srgb,var(--spark) 30%,transparent)"></i>норма</span><span><i style="background:var(--warn)"></i>замечание</span><span><i style="background:var(--err)"></i>плохо или панель не видела</span><span><i style="background:repeating-linear-gradient(135deg,var(--off) 0 3px,transparent 3px 7px)"></i>молчала</span><span><i style="background:repeating-linear-gradient(135deg,var(--err) 0 4px,color-mix(in srgb,var(--err) 45%,transparent) 4px 8px)"></i>похоже, IP заблокирован</span></div>`;
  el.innerHTML = `<div class="day-row day-head"><span></span><div class="day-ticks">${ticks}</div></div>` + rows.map(([key, tl]) => {
    // соседние окна с одинаковым состоянием — один отрезок
    const runs = [];
    tl.forEach((s, i) => { const c = DAY_CLS[s.st]; if (runs.length && runs.at(-1).c === c) runs.at(-1).to = i; else runs.push({c, st: s.st, from: i, to: i}); });
    const bar = runs.map(r => `<i class="${r.c}" style="flex:${r.to - r.from + 1}" title="${hh(t0 + r.from * SLOT)}–${hh(t0 + (r.to + 1) * SLOT)}: ${DAY_TXT[r.st]}"></i>`).join('');
    return `<button class="day-row" data-key="${esc(key)}"><span class="day-name">${esc(N[key].name)}</span><span class="day-bar">${bar}</span></button>`;
  }).join('') + legend;
  // журнал: новые сверху, идущие сейчас — первыми
  const bad = events.filter(e => !['warn', 'info', 'note'].includes(e.kind)).length;
  $('#day-sub').textContent = events.length ? `${events.length} ${events.length === 1 ? 'событие' : events.length < 5 ? 'события' : 'событий'} за сутки${bad ? `, из них серьёзных ${bad}` : ''}` : 'За сутки ничего не случилось';
  jr.innerHTML = events.length ? events.map(e => `<button class="ev ev-${e.kind}"${e.key ? ` data-key="${esc(e.key)}"` : ''}>
      <span class="ev-time num">${evTime(e, hh)}</span>
      <span class="ev-node">${e.key ? esc(N[e.key].name) : 'Вся сеть'}</span>
      <span class="ev-what">${evIc(e)}${esc(e.text)}</span>
      <span class="ev-dur">${evDur(e)}</span></button>`).join('')
    : '<p class="empty">Ни одна нода не уходила в «плохо» и не молчала.</p>';
}
