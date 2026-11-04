'use strict';
// Данные из VictoriaMetrics: запросы и сборка нод из node-check и справочника панели

/* ---------- данные: VictoriaMetrics ---------- */
const b64 = s => btoa(unescape(encodeURIComponent(s)));
async function vm(path, params){
  const u = new URL(API_BASE + '/api/v1/' + path, location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 15000);
  let r;
  // X-Ulya-Dash: по нему Caddy убирает WWW-Authenticate из 401, иначе браузер покажет своё окно входа
  try { r = await fetch(u, {headers: {Authorization: 'Basic ' + b64(state.creds || ''), 'X-Ulya-Dash': '1'}, cache: 'no-store', signal: ctl.signal}); }
  finally { clearTimeout(tm); }
  if (r.status === 401) throw Object.assign(new Error('auth'), {auth: true});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(j.error || 'query failed');
  return j.data.result;
}
const inst = e => vm('query', {query: e});
const rng = (e, start, end, step) => vm('query_range', {query: e, start, end, step});
// после обновления node-check у ноды есть серии без метки ip и с ней: берём новую (с ip / самую свежую)
const byNode = (res, newest) => {
  const out = {};
  for (const s of res) {
    const k = s.metric.node, cur = out[k], e = {m: s.metric, v: +s.value[1]};
    if (!cur || (newest ? e.v > cur.v : !!e.m.ip && !cur.m.ip)) out[k] = e;
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
function assemble(hosts, panel, sparkBy, heatBy){
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
    for (const k of ['c24', 'c30']) cur[k] = (cur[k] || 0) + (h[k] || 0);
    for (const k of ['t24', 't30']) if (h[k] != null) cur[k] = Math.min(cur[k] ?? Infinity, h[k]);
    if (cur.seen == null || (h.seen || 0) > cur.seen) {
      const keep = {c24: cur.c24, c30: cur.c30, t24: cur.t24, t30: cur.t30, hosts: cur.hosts};
      Object.assign(cur, h, keep, {key, host, name: cur.panel ? cur.name : host, cc: cur.panel ? cur.cc : h.cc});
    }
  }
  for (const n of Object.values(nodes)) {
    n.spark = remapOne(sparkBy, n.hosts); n.heat = hourly(remapOne(heatBy, n.hosts));
    // доля пришедших снимков: от первого снимка в окне до последнего (или до «сейчас минус 15 мин», если нода замолчала)
    const now = Date.now() / 1000, up = (c, t, w) => c && t && n.seen ? Math.min(100, c * SNAP / (Math.max(0, Math.max(n.seen, now - SNAP) - Math.max(t, now - w)) + SNAP) * 100) : null;
    n.up24 = up(n.c24, n.t24, 86400); n.up30 = up(n.c30, n.t30, 2592000);
    n.util = n.tx != null && n.full?.ip > 0 ? n.tx / n.full.ip * 100 : null;
    n.bridge = n.to === 'eu' || (n.to == null && n.cc === 'RU');
  }
  return {nodes, keyOf};
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
    seen: 'tlast_over_time(node_quick_cpu_us[30d])',
    // доступность: сколько снимков пришло с первого снимка в окне
    c24: 'sum by (node) (count_over_time(node_quick_cpu_us[24h]))', t24: 'min by (node) (tfirst_over_time(node_quick_cpu_us[24h]))',
    c30: 'sum by (node) (count_over_time(node_quick_cpu_us[30d]))', t30: 'min by (node) (tfirst_over_time(node_quick_cpu_us[30d]))',
    a_st: 'avg by (node) (avg_over_time(node_quick_cpu_st[30d]))', a_re: 'avg by (node) (avg_over_time(node_quick_retrans_pct[30d]))', a_lo: 'avg by (node) (avg_over_time(node_quick_loss_pct[30d]))',
    // в каждой точке — последний снимок каждой ноды за 20 мин: ноды шлют раз в 15 мин, голый sum недосчитывает
    peak: 'max_over_time(sum(last_over_time(node_quick_tx_mbps[20m]))[24h:15m])', peakAt: 'tmax_over_time(sum(last_over_time(node_quick_tx_mbps[20m]))[24h:15m])',
    f_cpu: full('sysbench_1t'), f_mt: full('sysbench_mt'), f_sc: full('scaling_pct'), f_st: full('steal_load'), f_ip: full('iperf_best_mbps'), f_eu: full('eu_dl_mbps'),
    f_fr: full('freeze_hosts'), f_dpi: full('dpi_blocked'), f_pr: full('problems'), f_at: 'tlast_over_time(node_full_problems[90d])',
    // справочник панели от rw-sync.py: имя, флаг, IP, связь, онлайн
    p_info: 'last_over_time(node_panel_info[15m])', p_users: 'last_over_time(node_panel_users_online[15m])',
    p_conn: 'last_over_time(node_panel_connected[15m])', p_dis: 'last_over_time(node_panel_disabled[15m])',
  };
  const keys = Object.keys(Q), RAW = new Set(['peak', 'peakAt', 'p_info', 'p_users', 'p_conn', 'p_dis']);
  const [res, spark, heat] = await Promise.all([
    Promise.all(keys.map(k => inst(Q[k]))),
    rng('node_quick_tx_mbps', end - 86400, end, SNAP),
    rng('node_quick_tx_mbps', end - 7 * 86400, end, 3600),
  ]);
  const I = Object.fromEntries(keys.map((k, i) => [k, RAW.has(k) ? res[i] : byNode(res[i], k === 'seen' || k === 'f_at')]));
  const panel = {};
  for (const s of I.p_info) { const m = s.metric; (panel[m.uuid] ||= {uuid: m.uuid, name: m.name, cc: m.cc, ips: new Set(), users: null, connected: null, disabled: null}).ips.add(m.ip); }
  for (const [k, f] of [['p_users', 'users'], ['p_conn', 'connected'], ['p_dis', 'disabled']]) for (const s of I[k]) if (panel[s.metric.uuid]) panel[s.metric.uuid][f] = +s.value[1];
  const hosts = {};
  for (const name of new Set([...Object.keys(I.seen), ...Object.keys(I.tx)])) {
    const lab = (I.seen[name] || I.tx[name]).m, v = k => I[k][name]?.v ?? null;
    hosts[name] = {cc: lab.cc, to: lab.to, ip: lab.ip, seen: v('seen'),
      ...Object.fromEntries(['tx', 'rx', 'conns', 'cpu', 'st', 'rtt', 'jit', 'loss', 'retr', 'mem', 'ct', 'xcpu', 'load', 'c24', 't24', 'c30', 't30', 'a_st', 'a_re', 'a_lo'].map(k => [k, v(k)])),
      full: I.f_at[name] ? {cpu: v('f_cpu'), mt: v('f_mt'), sc: v('f_sc'), st: v('f_st'), ip: v('f_ip'), eu: v('f_eu'), fr: v('f_fr'), dpi: v('f_dpi'), pr: v('f_pr'), at: v('f_at')} : null};
  }
  const {nodes, keyOf} = assemble(hosts, panel, seriesBy(spark), seriesBy(heat));
  const pv = I.peak[0] ? +I.peak[0].value[1] : null, pa = I.peakAt[0] ? +I.peakAt[0].value[1] : null;
  return {end, nodes, keyOf, hasPanel: Object.keys(panel).length > 0, peak: {v: pv, at: pa}};
}
async function loadSeries(metric, rangeKey){
  const R = RANGES[rangeKey], end = Math.floor(Date.now() / 1000);
  return {end, data: remap(seriesBy(await rng(METRICS[metric].expr, end - R.sec, end, R.step)), state.model?.keyOf || {})};
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function loadNodeSeries(n, rangeKey){
  const R = RANGES[rangeKey], end = Math.floor(Date.now() / 1000), sel = `node=~"${n.hosts.map(h => reEsc(h).replace(/\\/g, '\\\\').replace(/"/g, '\\"')).join('|')}"`;
  const out = {};
  await Promise.all(DR_METRICS.map(async k => {
    const e = METRICS[k].expr.replace(/node_quick_(\w+)/g, `node_quick_$1{${sel}}`);
    out[k] = Object.values(seriesBy(await rng(e, end - R.sec, end, R.step))).flat().sort((a, b) => a[0] - b[0]);
  }));
  return {end, data: out};
}
