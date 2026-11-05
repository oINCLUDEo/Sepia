'use strict';
// Отчёт за месяц: доступность и простой нод, пики, отдано ТБ, steal/ретрансмиты/потери, что ноды делали сами, заметки.
// Считается запросами к VictoriaMetrics «на конец месяца» с окном во весь месяц. Хранение — 180 дней: доступно 6 месяцев

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthRange = k => { const [y, m] = k.split('-').map(Number), a = new Date(y, m, 1) / 1000, b = new Date(y, m + 1, 1) / 1000; return {start: a, end: Math.min(b, Math.floor(Date.now() / 1000)), full: b}; };
const monthKeys = () => { const d = new Date(), out = []; for (let i = 0; i < 6; i++) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${x.getMonth()}`); } return out; };
const monthName = k => { const [y, m] = k.split('-').map(Number); return `${MONTHS[m]} ${y}`; };
state.repMonth = monthKeys()[0]; state.reports = {};

const instAt = (e, time) => vm('query', {query: e, time});
async function loadReport(k){
  const {start, end} = monthRange(k), W = `${Math.max(60, end - start)}s`, at = e => instAt(e, end);
  const by = res => Object.fromEntries(res.map(s => [s.metric.node, +s.value[1]]));
  const Q = {
    c: `sum by (node) (count_over_time(node_quick_cpu_us[${W}]))`, t: `min by (node) (tfirst_over_time(node_quick_cpu_us[${W}]))`,
    last: `max by (node) (tlast_over_time(node_quick_cpu_us[${W}]))`,
    cp: `sum by (node) (count_over_time(node_quick_period[${W}]))`, sp: `sum by (node) (sum_over_time(node_quick_period[${W}]))`,
    pk: `max by (node) (max_over_time(avg_over_time(node_quick_tx_mbps[15m])[${W}:15m]))`, atx: `avg by (node) (avg_over_time(node_quick_tx_mbps[${W}]))`,
    st: `avg by (node) (avg_over_time(node_quick_cpu_st[${W}]))`, re: `avg by (node) (avg_over_time(node_quick_retrans_pct[${W}]))`, lo: `avg by (node) (avg_over_time(node_quick_loss_pct[${W}]))`,
  };
  const keys = Object.keys(Q), [res, acts, np, npAt, on, onDay] = await Promise.all([
    Promise.all(keys.map(q => at(Q[q]))), at(`sum by (node, kind) (count_over_time(node_action_n[${W}]))`),
    at(`max_over_time(sum(max by (node) (last_over_time(node_quick_tx_mbps[16m])))[${W}:15m])`), at(`tmax_over_time(sum(max by (node) (last_over_time(node_quick_tx_mbps[16m])))[${W}:15m])`),
    at(`max(max_over_time(node_panel_stats_online_now[${W}]))`), at(`max(max_over_time(node_panel_stats_online_day[${W}]))`),
  ]);
  const R = Object.fromEntries(keys.map((q, i) => [q, by(res[i])])), hosts = {};
  for (const h of Object.keys(R.c)) hosts[h] = Object.fromEntries(keys.map(q => [q, R[q][h] ?? null]));
  const actions = acts.map(s => ({host: s.metric.node, kind: s.metric.kind, n: +s.value[1]}));
  return reportBuild(k, hosts, actions, {peak: +(np[0]?.value[1] ?? NaN), peakAt: +(npAt[0]?.value[1] ?? NaN), online: +(on[0]?.value[1] ?? NaN), onlineDay: +(onDay[0]?.value[1] ?? NaN)});
}
// снимки по именам node-check -> ноды дашборда (переименованные складываются)
function reportBuild(k, hosts, actions, net){
  const {start, end} = monthRange(k), N = state.model.nodes, keyOf = state.model.keyOf, rows = {};
  for (const [h, x] of Object.entries(hosts)) {
    const key = keyOf[h] || 'h:' + h, r = (rows[key] ||= {key, name: N[key]?.name || h, cc: N[key]?.cc, c: 0, cp: 0, sp: 0, t: Infinity, last: 0, pk: 0, txs: 0, w: 0, st: [], re: [], lo: [], acts: {}});
    r.c += x.c || 0; r.cp += x.cp || 0; r.sp += x.sp || 0; r.t = Math.min(r.t, x.t ?? Infinity); r.last = Math.max(r.last, x.last || 0); r.pk = Math.max(r.pk, x.pk || 0);
    if (x.atx != null) { r.txs += x.atx * (x.c || 1); r.w += x.c || 1; }
    for (const q of ['st', 're', 'lo']) if (x[q] != null) r[q].push(x[q]);
  }
  for (const a of actions) { const key = keyOf[a.host] || 'h:' + a.host; if (rows[key]) rows[key].acts[a.kind] = (rows[key].acts[a.kind] || 0) + a.n; }
  const avg = a => a.length ? a.reduce((x, y) => x + y) / a.length : null, out = [];
  for (const r of Object.values(rows)) {
    // доступность: время, покрытое снимками, к времени от первого снимка в месяце до конца месяца (или до последнего снимка, если нода снята)
    const covered = (r.c - r.cp) * SNAP + r.sp, per = r.cp ? 60 : SNAP, alive = (N[r.key]?.seen || 0) >= end - 3600;
    const span = Math.max(per, (alive ? end : r.last + per) - Math.max(r.t, start));
    const up = Math.min(100, covered / span * 100), atx = r.w ? r.txs / r.w : null;
    out.push({key: r.key, name: r.name, cc: r.cc, up, down: Math.max(0, span - covered), pk: r.pk || null, tb: atx != null ? atx * covered / 8 / 1e6 : null,
      st: avg(r.st), re: avg(r.re), lo: avg(r.lo), acts: r.acts, price: N[r.key]?.price || null});
  }
  out.sort((a, b) => a.up - b.up || a.name.localeCompare(b.name, 'ru', {numeric: true}));
  const notes = (state.notes || []).filter(nt => nt.t >= start && nt.t < end).sort((a, b) => a.t - b.t);
  return {k, start, end, rows: out, net, notes, at: Date.now()};
}
// демо: правдоподобный месяц из демо-нод
function demoReport(k){
  const {start, end} = monthRange(k), N = state.model.nodes, hosts = {};
  let i = 0;
  for (const n of Object.values(N)) for (const h of n.hosts) {
    const r = prng(++i * 13), dur = end - start, up = n.up30 ?? 99;
    hosts[h] = {c: Math.round(dur / 60 * up / 100), cp: Math.round(dur / 60 * up / 100), sp: Math.round(dur * up / 100), t: start, last: end - 120,
      pk: (n.tx || 20) * (1.6 + .5 * r()), atx: (n.tx || 20) * .55, st: n.a_st ?? 1, re: n.a_re ?? .5, lo: n.a_lo ?? .05};
  }
  const actions = Object.keys(hosts).slice(0, 4).map((h, j) => ({host: h, kind: ['update', 'conntrack', 'cert-renew', 'update-rollback'][j], n: [4, 1, 1, 1][j]}));
  const tot = Object.values(hosts).reduce((a, x) => a + x.pk, 0) * .8;
  return reportBuild(k, hosts, actions, {peak: tot, peakAt: start + (end - start) * .7, online: 1180, onlineDay: 2950});
}

const ACT_NAME = {update: 'обновлений', 'update-failed': 'неудачных обновлений', 'update-rollback': 'откатов обновления', 'update-blocked': 'обновлений не взято (CI)', conntrack: 'увеличений conntrack',
  'cert-renew': 'продлений сертификата', 'cert-renew-failed': 'неудачных продлений', 'nginx-reload': 'перезагрузок nginx', 'nginx-restart': 'запусков nginx', 'timer-fixed': 'перезапусков сбора', 'minute-failing': 'сбоев сбора'};
const durH = s => s < 3600 ? `${fmt(s / 60)} мин` : s < 86400 * 2 ? `${fmt(s / 3600, 1)} ч` : `${fmt(s / 86400, 1)} дн`;

async function renderReport(){
  const seg = $('#report-month');
  if (!seg.dataset.ready) {
    seg.dataset.ready = 1;
    seg.insertAdjacentHTML('beforeend', monthKeys().map((k, i) => `<button data-v="${k}" aria-pressed="${!i}">${i ? MONTHS[+k.split('-')[1]].slice(0, 3) : 'Этот месяц'}</button>`).join(''));
    bindSeg(seg, v => { state.repMonth = v; renderReport(); });
  }
  moveThumb(seg);
  const k = state.repMonth, el = $('#report');
  $('#report-sub').textContent = monthName(k)[0].toUpperCase() + monthName(k).slice(1) + (k === monthKeys()[0] ? ', по сегодняшний день' : '');
  let rep = state.reports[k];
  if (!rep || Date.now() - rep.at > 10 * 60e3) {
    el.innerHTML = '<div class="skel skel-table"></div>';
    try { rep = state.reports[k] = DEMO ? demoReport(k) : await loadReport(k); }
    catch (e) { el.innerHTML = `<p class="empty">Отчёт не собрался: ${esc(e.message)}</p>`; return; }
    if (state.repMonth !== k) return;   // пока считали, выбрали другой месяц
  }
  const rows = rep.rows, live = rows.filter(r => r.up != null), tb = rows.reduce((a, r) => a + (r.tb || 0), 0);
  const avgUp = live.length ? live.reduce((a, r) => a + r.up, 0) / live.length : null, down = rows.reduce((a, r) => a + r.down, 0);
  const kpi = (l, v, sub) => `<div class="rep-kpi"><span>${l}</span><b class="num">${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  let html = `<div class="rep-kpis">
    ${kpi('Доступность нод', avgUp != null ? fmt(avgUp, avgUp >= 99.95 ? 0 : 2) + '%' : '—', `в среднем; простой всего ${durH(down)}`)}
    ${kpi('Пик сети', isFinite(rep.net.peak) ? fmt(rep.net.peak) + ' <small>Мбит/с</small>' : '—', isFinite(rep.net.peakAt) ? when(rep.net.peakAt) : '')}
    ${kpi('Отдано пользователям', fmt(tb, tb < 10 ? 1 : 0) + ' <small>ТБ</small>', `${rows.length} нод`)}
    ${kpi('Онлайн в пик', isFinite(rep.net.online) ? fmt(rep.net.online) : '—', isFinite(rep.net.onlineDay) ? `за сутки — до ${fmt(rep.net.onlineDay)}` : 'нужна статистика панели (rw-sync)')}
  </div>`;
  const cu = v => v == null ? '' : v < 97 ? 'bad' : v < 99.5 ? 'meh' : '';
  html += `<div class="table-wrap"><table><thead><tr><th>Нода</th><th class="n">Доступность</th><th class="n">Простой</th><th class="n">Пик, Мбит/с</th><th class="n">Отдано, ТБ</th><th class="n">Steal</th><th class="n">Ретр.</th><th class="n">Потери</th><th>Сама делала</th></tr></thead><tbody>` +
    rows.map(r => `<tr class="click" data-key="${esc(r.key)}" tabindex="0"><td>${flag(r.cc)}${esc(r.name)}</td><td class="n ${cu(r.up)}">${fmt(r.up, r.up >= 99.95 ? 0 : 2)}%</td><td class="n">${r.down >= 60 ? durH(r.down) : '—'}</td>
      <td class="n">${fu(r.pk, 0, '')}</td><td class="n">${r.tb != null ? fmt(r.tb, r.tb < 10 ? 1 : 0) : '—'}</td><td class="n ${cls('st', r.st)}">${fu(r.st, 1, '%')}</td><td class="n ${cls('retr', r.re)}">${fu(r.re, 1, '%')}</td><td class="n ${cls('loss', r.lo)}">${fu(r.lo, 2, '%')}</td>
      <td style="white-space:normal;color:var(--muted);font-weight:400;font-size:15px">${Object.entries(r.acts).map(([kind, n]) => `${ACT_NAME[kind] || kind}: ${fmt(n)}`).join(', ') || '—'}</td></tr>`).join('') + '</tbody></table></div>';
  html += `<h3 class="rep-h">Заметки за месяц</h3>` + (rep.notes.length ? `<div class="notes">${rep.notes.map(nt => `<div class="nrow">${icon('sticky-note')}<time>${when(nt.t)}</time><span class="who">${esc(noteWho(nt))}</span><span class="txt">${esc(nt.text)}</span></div>`).join('')}</div>`
    : '<p class="note" style="margin-top:0">Заметок нет — их можно добавить в «Графиках».</p>');
  el.innerHTML = html;
}
$('#report').addEventListener('click', e => { const t = e.target.closest('[data-key]'); if (t && state.model.nodes[t.dataset.key]) openNode(t.dataset.key); });

// CSV для Excel: разделитель «;», десятичная запятая, BOM — чтобы кириллица открылась без танцев
$('#report-csv').addEventListener('click', () => {
  const rep = state.reports[state.repMonth]; if (!rep) return toast('Отчёт ещё считается');
  const n = (v, d) => v == null || !isFinite(v) ? '' : v.toFixed(d).replace('.', ','), q = s => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [['Нода', 'Доступность, %', 'Простой, мин', 'Пик, Мбит/с', 'Отдано, ТБ', 'Steal, %', 'Ретрансмиты, %', 'Потери, %', 'Цена в месяц', 'Валюта', 'Сама делала'].map(q).join(';'),
    ...rep.rows.map(r => [q(r.name), n(r.up, 3), n(r.down / 60, 0), n(r.pk, 1), n(r.tb, 2), n(r.st, 2), n(r.re, 2), n(r.lo, 3), n(r.price?.v, 2), q(r.price?.cur || ''),
      q(Object.entries(r.acts).map(([k, v]) => `${ACT_NAME[k] || k}: ${v}`).join(', '))].join(';'))];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], {type: 'text/csv;charset=utf-8'}));
  a.download = `ulya-nodes-${state.repMonth.replace(/-(\d+)$/, (m, x) => '-' + String(+x + 1).padStart(2, '0'))}.csv`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#report-print').addEventListener('click', () => print());
