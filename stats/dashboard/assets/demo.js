'use strict';
// Демо-данные: страница открыта с диска или с #demo

/* ---------- демо: страница открыта не с панели ---------- */
const DEMO_NODES = [   // node — hostname из node-check, pname — имя в панели
  {node: 'shade', pname: '🇸🇪 SE-Aeza', uuid: 'p1', cc: 'SE', to: 'ru', base: 46, conn: 2300, st: 1.2, users: 410, retr: .5},
  {node: 'SE-Ulya', pname: '🇪🇪 EE-INTEZIO', uuid: 'p2', cc: 'EE', to: 'ru', base: 34, conn: 1700, st: 2.1, users: 300, retr: 1.6},
  {node: 'eest', pname: '🇪🇪 EE-StenCloud', uuid: 'p3', cc: 'EE', to: 'ru', base: 27, conn: 1300, st: 6.5, users: 220, retr: .7},
  {node: 'aeza-de', pname: '🇩🇪 DE-Aeza-2', uuid: 'p4', cc: 'DE', to: 'ru', base: 21, conn: 1500, st: .6, users: 180, retr: 5.4},
  {node: 'superior-emerald', pname: '🇷🇺 RU-Aeza', uuid: 'p5', cc: 'RU', to: 'eu', base: 15, conn: 950, st: .4, users: 150, retr: .5},
  {node: 'ruvds', pname: '🇷🇺 RU-RuVDS', uuid: 'p6', cc: 'RU', to: 'eu', base: 8, conn: 800, st: .2, users: 98, retr: 2.6},
  {node: 'grade', cc: 'NL', to: 'ru', base: 52, conn: 2500, st: 1, stale: true, retr: .4},   // в панели нет, молчит
  {node: 'turtle', pname: '🇳🇱 NL-TurtleGuard', uuid: 'p10', cc: 'NL', to: 'ru', base: 1.2, conn: 60, st: 1, users: 4, usersY: 102, retr: .5},   // похоже, заблокирован
];
const DEMO_PANEL_ONLY = [   // в панели есть, node-check не настроен
  {uuid: 'p7', name: '🇫🇮 FI-Xorek', cc: 'FI', users: 95, connected: 1, disabled: 0},
  {uuid: 'p8', name: '🇵🇱 PL-ExpressHost', cc: 'PL', users: 0, connected: 0, disabled: 0},
  {uuid: 'p9', name: '🇩🇪 DE-Dataforest', cc: 'DE', users: 0, connected: 0, disabled: 1},
];
function prng(a){ return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function demoLoad(t){
  const d = new Date(t * 1000), h = d.getHours() + d.getMinutes() / 60, dist = c => { const x = Math.abs(h - c); return Math.min(x, 24 - x); };   // по кругу суток
  return .16 + .84 * Math.max(Math.exp(-(dist(21.3) ** 2) / 9.7), .5 * Math.exp(-(dist(13.5) ** 2) / 18));
}
function demoValue(s, metric, t, r){
  const L = demoLoad(t);
  switch (metric) {
    case 'tx': return s.base * L * (.88 + .24 * r());
    case 'rx': return s.base * L * (.08 + .05 * r());
    case 'conns': return Math.round(s.conn * (.3 + .7 * L) * (.95 + .1 * r()));
    case 'cpu': return 5 + 42 * L * (s.base / 50) + 4 * r();
    case 'st': return Math.max(0, s.st * (.5 + 1.3 * L) + .8 * r());
    case 'rtt': return (s.to === 'eu' ? 38 : 24) + 14 * L * L + 3 * r();
    case 'jit': return 1 + 4 * L * r();
    case 'loss': return r() < .93 ? 0 : +(r() * 1.4).toFixed(1);
    case 'retr': return s.retr * (.6 + .8 * L) + .3 * r();
    case 'mem': return 30 + 30 * L + 5 * r();
    case 'ct': return 8 + 30 * L * (s.conn / 2500) + 3 * r();
    case 'xcpu': return 3 + 30 * L * (s.base / 50) + 3 * r();
    case 'load': return .2 + 1.6 * L * (s.base / 50) + .2 * r();
  }
}
function demoSeriesFor(metric, rangeKey, end, only){
  const R = RANGES[rangeKey], out = {};
  DEMO_NODES.forEach((s, i) => {
    if (only && !only.includes(s.node)) return;
    const r = prng(i * 977 + metric.length * 31 + R.step), pts = [], stop = s.stale ? end - 3 * 3600 : end;
    for (let t = Math.ceil((end - R.sec) / R.step) * R.step; t <= stop; t += R.step) if (!(i === 1 && t > end - 9 * 3600 && t < end - 7 * 3600)) pts.push([t, demoValue(s, metric, t, r)]);   // у второй ноды — дыра в данных
    out[s.node] = pts;
  });
  return out;
}
function demoModel(){
  const end = Math.floor(Date.now() / 1000), hosts = {}, panel = {};
  DEMO_NODES.forEach((s, i) => {
    const r = prng(i + 7), at = s.stale ? end - 3 * 3600 : end - 240, ip = `10.0.0.${i + 1}`, dv = m => demoValue(s, m, at, r);
    hosts[s.node] = {cc: s.cc, to: s.to, ip, seen: at, ...Object.fromEntries(['tx', 'rx', 'conns', 'cpu', 'st', 'rtt', 'jit', 'retr', 'mem', 'ct', 'xcpu', 'load'].map(m => [m, dv(m)])), loss: i === 2 ? .8 : 0,
      c24: s.stale ? 84 : 95 - (i === 1 ? 8 : 0), t24: end - 86400 + 300, c30: 2860 - i * 40, t30: end - 2592000 + 600, a_st: s.st * 1.1, a_re: s.retr * .9, a_lo: i === 2 ? .3 : .05,
      full: i >= 6 ? null : {cpu: [3800, 1650, 940, 2100, 3600, 1200][i], mt: [7400, 3100, 1700, 7900, 13800, 2300][i], sc: [97, 94, 90, 95, 96, 92][i], st: [0, 2, 9, 1, 0, 3][i], ip: [612, 480, 230, 260, 140, 120][i],
        eu: s.cc === 'RU' ? [0, 0, 0, 0, 310, 180][i] : null, fr: s.cc === 'RU' ? [0, 0, 0, 0, 0, 2][i] : null, dpi: s.cc === 'RU' ? [0, 0, 0, 0, 1, 3][i] : null, pr: [0, 0, 2, 1, 1, 3][i], at: end - (i + 1) * 5400}};
    if (s.uuid) panel[s.uuid] = {uuid: s.uuid, name: s.pname, cc: s.cc, ips: new Set([ip]), users: s.users, usersY: s.usersY ?? Math.round(s.users * (1.02 + .08 * r())), connected: 1, disabled: 0};
    // версии node-check: большинство — актуальная минутная, одна устарела, у «grade» — старый скрипт раз в 15 минут
    Object.assign(hosts[s.node], s.stale ? {} : {period: 60, cp24: hosts[s.node].c24 * 15, sp24: hosts[s.node].c24 * 900, c24: hosts[s.node].c24 * 15,
      ver: i === 3 ? '0ad7bf3' : '6360fc6', verTs: end - (i === 3 ? 3 * 86400 : 3600)});
  });
  DEMO_PANEL_ONLY.forEach(p => panel[p.uuid] = {...p, ips: new Set()});
  const {nodes, keyOf} = assemble(hosts, panel, demoSeriesFor('tx', '24h', end), demoSeriesFor('tx', '7d', end));
  const sum = {}; Object.values(demoSeriesFor('tx', '24h', end)).forEach(p => p.forEach(([t, v]) => sum[t] = (sum[t] || 0) + v));
  const [pt, pv] = Object.entries(sum).reduce((a, b) => b[1] > a[1] ? b : a, [0, 0]);
  return {end, nodes, keyOf, hasPanel: true, peak: {v: pv, at: +pt}, netRatio: netRatio(panel)};
}
