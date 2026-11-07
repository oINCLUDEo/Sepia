'use strict';
// Данные из VictoriaMetrics: запросы и сборка нод из node-check и справочника панели

/* ---------- данные: VictoriaMetrics ---------- */
// не больше 8 запросов одновременно: всплеск из 60 разом упирался в Caddy и node-auth и давал 502
const MAX_INFLIGHT = 8, waiting = [];
let inflight = 0;
const acquire = () => inflight < MAX_INFLIGHT ? (inflight++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const next = waiting.shift(); if (next) next(); else inflight--; };   // слот передаётся следующему
const pause = ms => new Promise(r => setTimeout(r, ms));
async function vm(path, params){
  const u = new URL(API_BASE + '/api/v1/' + path, location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let r;
  await acquire();
  try {
    // 502/503/504 и обрыв сети — временное: повторяем до двух раз с паузой
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 15000);
      try {
        // вход — cookie ulya_stats (HttpOnly, её ставит node-auth): браузер отправляет её сам, пароля на странице нет
        r = await fetch(u, {credentials: 'same-origin', cache: 'no-store', signal: ctl.signal});
        if (![502, 503, 504].includes(r.status) || attempt >= 2) break;
      } catch (e) { if (e.name === 'AbortError' || attempt >= 2) throw e; }
      finally { clearTimeout(tm); }
      await pause(400 * (attempt + 1));
    }
  } finally { release(); }
  if (r.status === 401) throw Object.assign(new Error('auth'), {auth: true});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(j.error || 'query failed');
  return j.data.result;
}
const inst = e => vm('query', {query: e});

// пик недели и процессор в тот же момент — для «Ёмкости» (assets/hw.js). Считает сама VictoriaMetrics: самые нагруженные
// 5 минут недели и когда они были, максимум CPU и когда; потом по каждой ноде — CPU и steal ровно в эти 5 минут.
// Ответы — по числу на ноду, а не неделя точек. Ночь 03:00–05:59 МСК (00–02 UTC) не берём: там ночная проверка (iperf3, sysbench)
async function busyOf(end){
  const W = q => `(avg_over_time(${q}[5m]) and on() (hour() >= 3))[7d:5m]`, TX = 'node_quick_tx_mbps', CPU = '(node_quick_cpu_us + node_quick_cpu_sy)';
  // + фон процессора: загрузка в самые тихие 10% времени недели — то, что с трафиком не растёт (Docker, система, сбор)
  const [pk, at, cm, cat, bg] = await Promise.all([`max by (node) (max_over_time(${W(TX)}))`, `max by (node) (tmax_over_time(${W(TX)}))`,
    `max by (node) (max_over_time(${W(CPU)}))`, `max by (node) (tmax_over_time(${W(CPU)}))`, `max by (node) (quantile_over_time(0.1, ${W(CPU)}))`].map(q => vm('query', {query: q, time: end})));
  const v = (r, h) => { const s = r.find(x => x.metric.node === h); return s ? +s.value[1] : null; }, out = {};
  await Promise.all(pk.map(async s => {
    const h = s.metric.node, t = v(at, h); if (t == null) return;
    const sel = m => `${m}{node=${JSON.stringify(h)}}`, one = q => vm('query', {query: q, time: Math.round(t)}).then(r => r[0] ? +r[0].value[1] : null).catch(() => null);
    const [cpu, st] = await Promise.all([one(`avg(avg_over_time((${sel('node_quick_cpu_us')} + ${sel('node_quick_cpu_sy')})[5m]))`), one(`avg(avg_over_time(${sel('node_quick_cpu_st')}[5m]))`)]);
    out[h] = {pk: +s.value[1], at: t, cpu, st, bg: v(bg, h), cpuMax: v(cm, h), cpuMaxAt: v(cat, h)};
  }));
  return out;
}
const rng = (e, start, end, step) => vm('query_range', {query: e, start, end, step});
// после обновления node-check у ноды есть серии без метки ip и с ней: берём новую (с ip / самую свежую)
// у ноды бывает несколько серий: до и после обновления node-check (без метки ip и с ней), после смены IP или страны.
// Берём серию, у которой метки ip и cc совпадают с самой свежей (по времени последнего снимка, fresh[node]);
// без fresh — новее по значению (для запросов-времён) или с меткой ip
const byNode = (res, newest, fresh) => {
  const out = {}, score = (m, k) => fresh?.[k] ? (m.ip === fresh[k].ip && m.cc === fresh[k].cc ? 2 : 0) : (m.ip ? 1 : 0);
  for (const s of res) {
    const k = s.metric.node, cur = out[k], e = {m: s.metric, v: +s.value[1], sc: score(s.metric, k)};
    if (!cur || (newest ? e.v > cur.v : e.sc > cur.sc)) out[k] = e;
  }
  return out;
};
const seriesBy = res => {   // старая и новая серии ноды не пересекаются по времени — склеиваем
  const out = {};
  for (const s of res) { const k = s.metric.node, pts = s.values.map(([t, v]) => [+t, +v]); out[k] = out[k] ? [...out[k], ...pts].sort((a, b) => a[0] - b[0]) : pts; }
  return out;
};
const cleanName = s => String(s || '').replace(/^(?:[\u{1F1E6}-\u{1F1FF}]{2}\s*)+/u, '').trim() || String(s || '');   // флаг рисуем сами
const flag = cc => cc && FLAGS.has(cc.toLowerCase()) ? `<img class="flag" src="flags/${cc.toLowerCase()}.svg" alt="" loading="lazy">` : '';
// хостер — из имени: «DE-Aeza-2» -> Aeza, «RU-DLine-FI» -> DLine; страны и номера пропускаем
const hosterOf = name => cleanName(name).split(/[-_\s.]+/).find(t => t && !/^[A-Z]{2}$/.test(t) && !/^\d+$/.test(t) && !/^(мост|bridge|node)$/i.test(t)) || cleanName(name);
// ноды из node-check (по hostname) + справочник панели (по uuid): склеиваем по IP, имя и флаг — из панели
function assemble(hosts, panel, sparkBy, heatBy, peaksBy){
  const nodes = {}, keyOf = {}, plist = Object.values(panel);
  // запасной ключ — имя: если сервер выходит в интернет не с адреса из панели, имя ноды в node-check = имя в панели
  const norm = s => cleanName(s).toLowerCase().replace(/[\s,=_]+/g, ''), byName = Object.fromEntries(plist.map(x => [norm(x.name), x]));
  const pick = (host, h) => (h.ip && plist.find(x => x.ips.has(h.ip))) || byName[norm(host)] || null, viaIp = {};
  for (const [host, h] of Object.entries(hosts)) { const p = pick(host, h); if (p && h.ip) viaIp[h.ip] = p; }   // старое имя той же ноды — по её IP
  for (const p of plist) nodes[p.uuid] = {key: p.uuid, name: cleanName(p.name), cc: p.cc, panel: p, seen: null, hosts: []};
  for (const [host, h] of Object.entries(hosts)) {
    const p = pick(host, h) || (h.ip && viaIp[h.ip]) || null, key = p ? p.uuid : 'h:' + host;
    if (!p && plist.length && !(Date.now() / 1000 - h.seen < 86400)) continue;   // старое имя после переименования: не держим карточку месяц
    keyOf[host] = key;
    const cur = nodes[key] || (nodes[key] = {key, name: host, cc: h.cc, panel: null, seen: null, hosts: []});
    cur.hosts.push(host);
    // счётчики доступности складываем по всем именам ноды
    for (const k of ['c24', 'c30', 'cp24', 'cp30', 'sp24', 'sp30']) cur[k] = (cur[k] || 0) + (h[k] || 0);
    for (const k of ['t24', 't30']) if (h[k] != null) cur[k] = Math.min(cur[k] ?? Infinity, h[k]);
    // полная проверка, заглушка, версия — самые свежие среди всех имён ноды: у нового имени их может ещё не быть
    if (h.full && !(cur.bestFull?.at >= h.full.at)) cur.bestFull = h.full;
    if (h.site && !(cur.bestSite?.at >= h.site.at)) cur.bestSite = h.site;
    if (h.ver && !(cur.bestVer?.verTs >= h.verTs)) cur.bestVer = {ver: h.ver, verTs: h.verTs};
    if (h.price) cur.bestPrice = h.price;
    if (cur.seen == null || (h.seen || 0) > cur.seen) {
      const keep = {c24: cur.c24, c30: cur.c30, cp24: cur.cp24, cp30: cur.cp30, sp24: cur.sp24, sp30: cur.sp30, t24: cur.t24, t30: cur.t30, hosts: cur.hosts,
        bestFull: cur.bestFull, bestSite: cur.bestSite, bestVer: cur.bestVer, bestPrice: cur.bestPrice};
      Object.assign(cur, h, keep, {key, host, name: cur.panel ? cur.name : host, cc: cur.panel ? cur.cc : h.cc});
    }
  }
  for (const n of Object.values(nodes)) {
    n.full = n.bestFull || null; n.site = n.bestSite || null;
    if (n.bestVer) Object.assign(n, n.bestVer);
    n.price = n.bestPrice || null;
    delete n.bestFull; delete n.bestSite; delete n.bestVer; delete n.bestPrice;
    // дневные пики: у переименованной ноды две серии за один день — берём большее
    const pk = {}; for (const [t, v] of remapOne(peaksBy || {}, n.hosts)) pk[t] = Math.max(pk[t] || 0, v);
    n.peaks = Object.entries(pk).map(([t, v]) => [+t, v]).sort((a, b) => a[0] - b[0]);
    n.spark = remapOne(sparkBy, n.hosts); n.heat = hourly(remapOne(heatBy, n.hosts));
    // доля времени, покрытого снимками: старые node-check шлют раз в 15 мин, новые — раз в минуту (поле period).
    // Считаем от первого снимка в окне до последнего (или до «сейчас минус шаг», если нода замолчала)
    const now = Date.now() / 1000, per = n.period || SNAP;
    const up = (c, cp, sp, t, w) => c && t && n.seen ? Math.min(100, ((c - (cp || 0)) * SNAP + (sp || 0)) / (Math.max(0, Math.max(n.seen, now - per) - Math.max(t, now - w)) + per) * 100) : null;
    n.up24 = up(n.c24, n.cp24, n.sp24, n.t24, 86400); n.up30 = up(n.c30, n.cp30, n.sp30, n.t30, 2592000);
    // замер iperf3 меньше уже отданного пика — он занижен (публичный сервер был занят), долю канала по нему не считаем
    // канал — ночной iperf3: сумма по всем серверам разом, иначе лучший одиночный; меньше уже отданного пика — занижен
    n.ch = Math.max(n.full?.is > 0 ? n.full.is : 0, n.full?.ip > 0 ? n.full.ip : 0) || null;
    n.ipLow = !!n.ch && n.peaks.some(p => p[1] > n.ch);
    n.util = n.tx != null && n.ch && !n.ipLow ? n.tx / n.ch * 100 : null;
    n.bridge = n.to === 'eu' || (n.to == null && n.cc === 'RU');
  }
  return {nodes, keyOf};
}
// среднее за шаг графика вместо одной точки: у минутных нод иначе график показывал бы случайную минуту из 15
const avgOver = (expr, step) => expr.replace(/node_quick_\w+(\{[^}]*\})?/g, m => `avg_over_time(${m}[${step}s])`);
// точка запроса на момент t — среднее за окно (t − step, t]. Рисуем её в середине окна, иначе всё на графике сдвинуто
// на шаг позже: на недельном графике — на час, на месячном — на 3 часа, вечерний пик выглядел позже, чем был
const centered = (res, step) => res.map(s => ({...s, values: s.values.map(([t, v]) => [+t - step / 2, v])}));
// онлайн по сети сейчас к тому же часу вчера (только включённые ноды, которые панель видит)
function netRatio(panel){
  let now = 0, y = 0;
  for (const p of Object.values(panel)) if (p.disabled !== 1 && p.connected === 1 && p.usersY > 0) { now += p.users || 0; y += p.usersY; }
  return y >= 50 ? now / y : null;
}
// серии всех имён одной ноды — в одну, по времени
const remapOne = (by, hosts) => (hosts || []).flatMap(h => by[h] || []).sort((a, b) => a[0] - b[0]);
const remap = (by, keyOf) => {
  const out = {};
  for (const [host, pts] of Object.entries(by)) { const k = keyOf[host] || 'h:' + host; out[k] = out[k] ? [...out[k], ...pts].sort((a, b) => a[0] - b[0]) : pts; }
  return out;
};
function hourly(series){
  const s = Array(24).fill(0), c = Array(24).fill(0);
  for (const [t, v] of series || []) { const h = new Date(t * 1000).getHours(); s[h] += v; c[h]++; }
  return s.map((x, i) => c[i] ? x / c[i] : null);
}

async function loadLive(){
  const end = Math.floor(Date.now() / 1000), last = m => `last_over_time(${m}[2d])`, full = m => `last_over_time(node_full_${m}[90d])`;
  // значения за 2 суток: у замолчавшей ноды показываем последние известные (серым), а не прочерки
  const Q = {
    tx: last('node_quick_tx_mbps'), rx: last('node_quick_rx_mbps'), conns: last('node_quick_conns'),
    cpu: `${last('node_quick_cpu_us')} + ${last('node_quick_cpu_sy')}`, st: last('node_quick_cpu_st'),
    rtt: last('node_quick_rtt_ms'), jit: last('node_quick_jitter_ms'), loss: last('node_quick_loss_pct'), retr: last('node_quick_retrans_pct'),
    mem: last('node_quick_mem_pct'), ct: last('node_quick_conntrack_pct'), xcpu: last('node_quick_xray_cpu'), load: last('node_quick_load1'),
    period: last('node_quick_period'),   // шаг сбора: 60 у нового node-check, нет — старый (раз в 15 мин)
    seen: 'tlast_over_time(node_quick_cpu_us[30d])',
    // доступность: сколько снимков пришло с первого снимка в окне
    c24: 'sum by (node) (count_over_time(node_quick_cpu_us[24h]))', t24: 'min by (node) (tfirst_over_time(node_quick_cpu_us[24h]))',
    c30: 'sum by (node) (count_over_time(node_quick_cpu_us[30d]))', t30: 'min by (node) (tfirst_over_time(node_quick_cpu_us[30d]))',
    cp24: 'sum by (node) (count_over_time(node_quick_period[24h]))', sp24: 'sum by (node) (sum_over_time(node_quick_period[24h]))',
    cp30: 'sum by (node) (count_over_time(node_quick_period[30d]))', sp30: 'sum by (node) (sum_over_time(node_quick_period[30d]))',
    a_tx: 'avg by (node) (avg_over_time(node_quick_tx_mbps[30d]))',   // для «ТБ за 30 дней» в «Ёмкости»
    a_st: 'avg by (node) (avg_over_time(node_quick_cpu_st[30d]))', a_re: 'avg by (node) (avg_over_time(node_quick_retrans_pct[30d]))', a_lo: 'avg by (node) (avg_over_time(node_quick_loss_pct[30d]))',
    // в каждой точке — последний снимок каждой ноды за 16 мин (старые шлют раз в 15 мин), точки — каждые 5 минут
    // пик сети: сначала одно значение на ноду (max by node) — после смены IP или страны у ноды две серии, и старая
    // ещё 16 минут отдаёт последнее значение; простая сумма считала такую ноду дважды
    peak: 'max_over_time(sum(max by (node) (last_over_time(node_quick_tx_mbps[16m])))[24h:5m])',
    peakAt: 'tmax_over_time(sum(max by (node) (last_over_time(node_quick_tx_mbps[16m])))[24h:5m])',
    f_cpu: full('sysbench_1t'), f_mt: full('sysbench_mt'), f_sc: full('scaling_pct'), f_st: full('steal_load'), f_ip: full('iperf_best_mbps'), f_is: full('iperf_sum_mbps'), f_eu: full('eu_dl_mbps'),
    f_fr: full('freeze_hosts'), f_dpi: full('dpi_blocked'), f_pr: full('problems'), f_at: 'tlast_over_time(node_full_problems[90d])',
    // справочник панели от rw-sync.py: имя, флаг, IP, связь, онлайн
    p_info: 'last_over_time(node_panel_info[15m])', p_users: 'last_over_time(node_panel_users_online[15m])',
    p_conn: 'last_over_time(node_panel_connected[15m])', p_dis: 'last_over_time(node_panel_disabled[15m])',
    p_usersY: 'last_over_time(node_panel_users_online[30m] offset 1d)',   // онлайн в тот же час вчера — для детектора блокировки
    // версия node-check на ноде: коммит (метка ver) и его время — кому нужно обновление
    m_ver: 'last_over_time(node_meta_ver_ts[2d])',
    // связи «мост -> выход» из конфиг-профилей панели (rw-sync.py): карта рисует только настоящие пути
    p_link: 'last_over_time(node_panel_link_n[15m])',
    // сайт-заглушка и сертификат — проверка самой ноды каждые 10 минут, как её видит пробер
    s_code: 'last_over_time(node_site_code[1h])', s_bytes: 'last_over_time(node_site_bytes[1h])', s_tls: 'last_over_time(node_site_tls_ok[1h])',
    s_days: 'last_over_time(node_site_cert_days[1h])', s_renew: 'last_over_time(node_site_renew_ok[1h])', s_at: 'tlast_over_time(node_site_code[1h])',
  };
  // онлайн по всей панели (уникальный, от rw-sync): сумма по нодам завышена — с балансировщиком одно устройство
  // числится онлайн сразу на всех нодах
  Q.ps_now = 'last_over_time(node_panel_stats_online_now[15m])'; Q.ps_day = 'last_over_time(node_panel_stats_online_day[15m])';
  Q.ps_total = 'last_over_time(node_panel_stats_users_total[15m])';
  Q.p_seen = 'max(tlast_over_time(node_panel_connected[1d]))';   // когда rw-sync последний раз обновлял справочник
  Q.seenAll = 'tlast_over_time(node_quick_cpu_us[30d])';
  Q.price = 'last_over_time(node_meta_price_month[2d])';
  Object.assign(Q, ACCESS_Q, DIAG_Q, PORTS_Q, HW_Q, XRAY_Q);   // + Xray: версия и журнал — assets/xray.js;   // + железо — assets/hw.js;   // + порты и фаервол — assets/ports.js   // + трассировка и безопасность ОС — assets/diag.js   // сервисы через ноду и репутация IP — assets/access.js   // цена ноды в месяц из её конфига (NODE_PRICE), валюта — метка cur         // по серии: какая у ноды самая свежая
  // медленные (окно 30–90 дней) пересчитываем раз в 30 минут: за 2 минуты они не меняются, а VictoriaMetrics грузят
  const SLOW = ['c30', 't30', 'cp30', 'sp30', 'a_tx', 'a_st', 'a_re', 'a_lo', 'f_cpu', 'f_mt', 'f_sc', 'f_st', 'f_ip', 'f_is', 'f_eu', 'f_fr', 'f_dpi', 'f_pr', 'f_at', 'hw_mem7', ...XRAY_SLOW];
  const slowFresh = state.slow && Date.now() - state.slow.at < 30 * 60e3;
  const keys = Object.keys(Q).filter(k => !(slowFresh && SLOW.includes(k)));
  const RAW = new Set(['peak', 'peakAt', 'p_info', 'p_users', 'p_conn', 'p_dis', 'p_usersY', 'm_ver', 'p_link', 'ps_now', 'ps_day', 'ps_total', 'p_seen', 'seenAll', 'price', '_busy', ...Object.keys(ACCESS_Q), ...Object.keys(HW_Q), ...Object.keys(XRAY_Q), ...Object.keys(DIAG_Q), ...Object.keys(PORTS_Q)]);
  const endH = Math.floor(end / 3600) * 3600;
  // пик каждого дня за 30 дней (самые нагруженные 5 минут суток) — для прогноза «когда упрётся в канал»; раз в 30 минут.
  // 15-минутное среднее сглаживало всплески: 5 минут в потолке и 10 на трети — выходило «занят на 55%»
  // Ночь 03:00–05:59 МСК (00–02 UTC) не берём: там ночная полная проверка (iperf3, sysbench) — старые node-check
  // засчитывали её трафик в минутный снимок, и «пиком» выходил iperf у ноды без пользователей
  const peaksQ = 'max by (node) (max_over_time((avg_over_time(node_quick_tx_mbps[5m]) and on() (hour() >= 3))[1d:5m]))';
  const [res, spark, heat, peaks, busy] = await Promise.all([
    Promise.all(keys.map(k => inst(Q[k]))),
    rng(avgOver('node_quick_tx_mbps', SNAP), end - 86400, end, SNAP).then(r => centered(r, SNAP)),
    // часы ровные (окна 18:00–19:00), середина окна — внутри своего часа: клетка «18:00» — это нагрузка с 18 до 19
    rng(avgOver('node_quick_tx_mbps', 3600), endH - 7 * 86400, endH, 3600).then(r => centered(r, 3600)),
    slowFresh && state.slow.peaks ? state.slow.peaks : rng(peaksQ, end - 30 * 86400, end, 86400).catch(() => []),
    slowFresh && state.slow.busy ? state.slow.busy : busyOf(end).catch(e => ({_err: e.message || String(e)})),
  ]);
  const R0 = Object.fromEntries(keys.map((k, i) => [k, res[i]]));
  if (slowFresh) Object.assign(R0, state.slow.res); else state.slow = {at: Date.now(), res: Object.fromEntries(SLOW.map(k => [k, R0[k]])), peaks, busy};
  R0._busy = busy;
  // справочник панели устарел (rw-sync не работает больше 15 минут) — берём последние известные данные за сутки
  const pSeen = R0.p_seen[0] ? +R0.p_seen[0].value[1] : null, panelStale = pSeen && end - pSeen > 900 ? pSeen : null;
  if (panelStale) {
    const W = ['p_info', 'p_users', 'p_conn', 'p_dis', 'p_link', 'ps_now', 'ps_day', 'ps_total'];
    const again = await Promise.all(W.map(k => inst(Q[k].replace('[15m]', '[1d]'))));
    W.forEach((k, i) => R0[k] = again[i]);
  }
  const fresh = {};
  for (const s of R0.seenAll) { const k = s.metric.node; if (!fresh[k] || +s.value[1] > fresh[k].t) fresh[k] = {t: +s.value[1], ip: s.metric.ip, cc: s.metric.cc}; }
  const I = Object.fromEntries(Object.keys(R0).map(k => [k, RAW.has(k) ? R0[k] : byNode(R0[k], k === 'seen' || k === 'f_at' || k === 's_at', fresh)]));
  const panel = {};
  for (const s of I.p_info) { const m = s.metric; (panel[m.uuid] ||= {uuid: m.uuid, name: m.name, cc: m.cc, ips: new Set(), users: null, connected: null, disabled: null}).ips.add(m.ip); }
  for (const [k, f] of [['p_users', 'users'], ['p_conn', 'connected'], ['p_dis', 'disabled'], ['p_usersY', 'usersY']]) for (const s of I[k]) if (panel[s.metric.uuid]) panel[s.metric.uuid][f] = +s.value[1];
  const ver = {};
  for (const s of I.m_ver) { const k = s.metric.node, ts = +s.value[1]; if (!ver[k] || ts > ver[k].ts) ver[k] = {v: s.metric.ver, ts}; }
  const price = {};
  for (const s of I.price) price[s.metric.node] = {v: +s.value[1], cur: s.metric.cur || ''};
  const hosts = {};
  for (const name of new Set([...Object.keys(I.seen), ...Object.keys(I.tx)])) {
    const lab = (I.seen[name] || I.tx[name]).m, v = k => I[k][name]?.v ?? null;
    hosts[name] = {cc: lab.cc, to: lab.to, ip: lab.ip, seen: v('seen'), ver: ver[name]?.v || null, verTs: ver[name]?.ts || null,
      ...Object.fromEntries(['tx', 'rx', 'conns', 'cpu', 'st', 'rtt', 'jit', 'loss', 'retr', 'mem', 'ct', 'xcpu', 'load', 'period', 'c24', 't24', 'c30', 't30', 'cp24', 'sp24', 'cp30', 'sp30', 'a_tx', 'a_st', 'a_re', 'a_lo'].map(k => [k, v(k)])),
      price: price[name] || null,
      site: I.s_at[name] ? {domain: I.s_code[name]?.m.domain, code: v('s_code'), bytes: v('s_bytes'), tls: v('s_tls'), days: v('s_days'), renew: v('s_renew'), at: v('s_at')} : null,
      full: I.f_at[name] ? {cpu: v('f_cpu'), mt: v('f_mt'), sc: v('f_sc'), st: v('f_st'), ip: v('f_ip'), is: v('f_is'), eu: v('f_eu'), fr: v('f_fr'), dpi: v('f_dpi'), pr: v('f_pr'), at: v('f_at')} : null};
  }
  const {nodes, keyOf} = assemble(hosts, panel, seriesBy(spark), seriesBy(heat), seriesBy(peaks));
  attachAccess(nodes, keyOf, R0); attachDiag(nodes, keyOf, R0); attachPorts(nodes, keyOf, R0); attachHw(nodes, keyOf, R0); attachXray(nodes, keyOf, R0);
  const pv = I.peak[0] ? +I.peak[0].value[1] : null, pa = I.peakAt[0] ? +I.peakAt[0].value[1] : null;
  const one = k => I[k][0] ? +I[k][0].value[1] : null;
  return {end, nodes, keyOf, hasPanel: Object.keys(panel).length > 0, peak: {v: pv, at: pa}, netRatio: netRatio(panel), links: I.p_link.map(s => ({from: s.metric.from, to: s.metric.to})),
    online: {now: one('ps_now'), day: one('ps_day'), total: one('ps_total')}, panelStale};
}
// серии графика — по именам из node-check, с пометкой, какая это метрика и период. К нодам их привязываем в момент
// отрисовки (chartData): при первой загрузке график приходит раньше справочника нод, и ранняя привязка теряла все линии
async function loadSeries(metric, rangeKey){
  const R = RANGES[rangeKey], end = Math.floor(Date.now() / 1000);
  return {end, metric, range: rangeKey, raw: seriesBy(centered(await rng(avgOver(METRICS[metric].expr, R.step), end - R.sec, end, R.step), R.step))};
}
const chartData = s => s?.raw ? remap(s.raw, state.model?.keyOf || {}) : (s?.data || {});
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function loadNodeSeries(n, rangeKey){
  const R = RANGES[rangeKey], end = Math.floor(Date.now() / 1000), sel = `node=~"${n.hosts.map(h => reEsc(h).replace(/\\/g, '\\\\').replace(/"/g, '\\"')).join('|')}"`;
  const out = {};
  await Promise.all(DR_METRICS.map(async k => {
    const e = avgOver(METRICS[k].expr.replace(/node_quick_(\w+)/g, `node_quick_$1{${sel}}`), R.step);
    out[k] = Object.values(seriesBy(centered(await rng(e, end - R.sec, end, R.step), R.step))).flat().sort((a, b) => a[0] - b[0]);
  }));
  // что нода сделала сама за период — метками на её графике
  const acts = await inst(`node_action_n{${sel}}[${R.sec}s]`).catch(() => []);
  return {end, range: rangeKey, data: out, actions: acts.flatMap(s => s.values.map(([t]) => ({host: s.metric.node, kind: s.metric.kind, info: s.metric.info || '', t: +t})))};
}
