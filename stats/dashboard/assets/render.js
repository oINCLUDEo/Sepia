'use strict';
// Отрисовка разделов страницы

/* ---------- отрисовка ---------- */
function renderHero(){
  const {nodes, peak, end, hasPanel} = state.model, list = Object.values(nodes), online = list.filter(n => n.seen && end - n.seen < 1800);
  const sum = k => online.reduce((a, n) => a + (n[k] || 0), 0);
  const tx = sum('tx');
  countUp($('#mega'), tx, tx >= 100 ? 0 : 1);
  const pl = list.filter(n => n.panel && n.panel.disabled !== 1), live = pl.filter(n => n.panel.connected === 1);
  $('#hero-sub').textContent = !list.length ? 'Ноды ещё не прислали данных' : hasPanel ? `${live.length} из ${pl.length} нод на связи` : `${online.length} из ${list.length} нод в работе`;
  const withUsers = list.filter(n => n.panel?.users != null);
  if (withUsers.length) {   // онлайн — из панели, соединения — из node-check
    $('#k-conns-l').textContent = 'Пользователей онлайн';
    countUp($('#k-conns'), withUsers.reduce((a, n) => a + n.panel.users, 0), 0);
    $('#k-conns-s').textContent = `соединений ${fmt(sum('conns'))}`;
  } else {
    $('#k-conns-l').textContent = 'Соединений сейчас';
    countUp($('#k-conns'), sum('conns'), 0);
    $('#k-conns-s').textContent = 'по всем нодам';
  }
  $('#k-peak').innerHTML = peak.v != null ? `${fmt(peak.v, peak.v >= 100 ? 0 : 1)}<small>Мбит/с</small>` : '—';
  $('#k-peak-s').textContent = peak.at ? when(peak.at) : '';
  const active = list.filter(n => state.st[n.key].cat !== 'off'), bad = active.filter(n => state.st[n.key].k !== 'ok').sort((a, b) => (state.st[b.key].k === 'err') - (state.st[a.key].k === 'err'));
  $('#k-bad').innerHTML = `${bad.length}<small>из ${active.length}</small>`;
  $('#k-bad-s').textContent = bad.length ? bad.slice(0, 3).map(n => n.name).join(', ') + (bad.length > 3 ? ` и ещё ${bad.length - 3}` : '') : 'все в норме';
  const ut = online.filter(n => n.util != null).sort((a, b) => b.util - a.util)[0];
  $('#k-util').innerHTML = ut ? `${fmt(ut.util)}<small>%</small>` : '—';
  $('#k-util-s').textContent = ut ? `${ut.name}, ${fmt(ut.tx, 0)} из ${fmt(ut.full.ip)} Мбит/с` : 'нужна полная проверка на нодах';
  // строка состояния
  const cnt = Object.fromEntries(CATS.map(([c]) => [c, list.filter(n => state.st[n.key].cat === c).length]));
  if (state.filter && !cnt[state.filter]) state.filter = null;
  $('#chips').innerHTML = '<span class="thumb"></span>' + [['', 'Все', list.length], ...CATS.map(([c, l]) => [c, l, cnt[c]])].map(([c, l, k]) =>
    `<button data-c="${c}" aria-pressed="${(state.filter || '') === c}"${k || !c ? '' : ' disabled'}>${l}<b class="${k && (c === 'err' || c === 'warn') ? c : ''}">${k}</b></button>`).join('');
  moveThumb($('#chips'));
}

function subLine(n){
  const country = COUNTRY[n.cc] || n.cc || '';   // «Швеция» в имени — страну не повторяем
  return [n.name.includes(country) ? '' : country, n.panel?.users != null ? `${fmt(n.panel.users)} онлайн` : '', state.model.hasPanel && !n.panel ? 'нет в панели' : ''].filter(Boolean).join(', ');
}
function card(key, i){
  const {nodes, end} = state.model, n = nodes[key], s = state.st[key];
  // каждая строка шапки — ровно одна строка: соседние карточки совпадают по высоте, цифры и графики стоят на одном уровне
  const head = `<article class="node${s.stale ? ' stale' : ''}${state.first ? ' rise' : ''}" style="animation-delay:${Math.min(i, 8) * .05}s" data-key="${esc(key)}" tabindex="0" role="button" aria-label="${esc(n.name)}: ${esc(s.t)}, подробнее">
    <div class="node-name" title="${esc(n.name)}">${esc(n.name)}</div>
    <div class="node-sub">${flag(n.cc)}${esc(subLine(n))}</div>
    <div class="state s-${s.k}">${esc(s.t[0].toUpperCase() + s.t.slice(1))}</div>`;
  if (n.seen == null) return head + '<p class="node-hint">Статистика не настроена. На ноде: <code>sudo bash node-check.sh</code>, пункты 6 и 5.</p></article>';
  // график всегда спокойного цвета: состояние уже сказано плашкой, лишний красный только мельтешит
  const ut = n.util != null ? ` · <span class="${cls('util', n.util)}">канал ${fmt(n.util)}%</span>` : '';
  return head + `
    <div class="node-main"><span class="node-num num">${fmt(n.tx, n.tx >= 100 ? 0 : 1)}</span><span class="node-unit">Мбит/с к юзерам${ut}</span></div>
    ${spark(n.spark, s.stale ? 'var(--off)' : 'var(--spark)', 'sp' + i, end)}
    <dl class="node-stats">
      <div><dt>Соединений</dt><dd class="num">${fmt(n.conns)}</dd></div>
      <div><dt>CPU</dt><dd class="num ${cls('cpu', n.cpu)}">${fu(n.cpu, 0, '%')}</dd></div>
      <div><dt>Steal</dt><dd class="num ${cls('st', n.st)}">${fu(n.st, 0, '%')}</dd></div>
      <div><dt>Пинг до ${n.to === 'eu' ? 'ЕС' : 'РФ'}</dt><dd class="num">${fu(n.rtt, 0, ' мс')}</dd></div>
      <div><dt>Потери</dt><dd class="num ${cls('loss', n.loss)}">${fu(n.loss, n.loss % 1 ? 1 : 0, '%')}</dd></div>
      <div><dt>Ретрансмиты</dt><dd class="num ${clsN(n, 'retr')}">${fu(n.retr, 1, '%')}</dd></div>
    </dl></article>`;
}
function renderNodes(){
  const {nodes} = state.model, el = $('#nodes');
  if (!state.order.length) { el.innerHTML = '<p class="empty">Ноды ещё не прислали данных. Включите сбор на ноде: sudo bash node-check.sh, пункт 5.</p>'; return; }
  const shown = state.order.filter(k => !state.filter || state.st[k].cat === state.filter);
  const off = shown.filter(k => state.st[k].cat === 'off'), on = shown.filter(k => state.st[k].cat !== 'off');
  $('#nodes-sub').textContent = state.filter ? `Только: ${CATS.find(c => c[0] === state.filter)[1].toLowerCase()}` : 'Сейчас и за сутки';
  if (state.view === 'table') { el.innerHTML = nodeTable(shown); return; }
  let i = 0, html = '';
  const groups = [['Выходы', 'зарубежные ноды, пинг до РФ', on.filter(k => !nodes[k].bridge)], ['Мосты в РФ', 'пинг до Европы', on.filter(k => nodes[k].bridge)]].filter(g => g[2].length);
  for (const [title, hint, keys] of groups)
    html += `<div class="group">${groups.length > 1 || off.length ? `<div class="group-head"><b>${title}</b>${keys.length} · ${hint}</div>` : ''}<div class="nodes">${keys.map(k => card(k, i++)).join('')}</div></div>`;
  if (off.length) html += `<details class="offlist"${on.length ? '' : ' open'}><summary><b>Отключены и без статистики</b>${off.length}</summary><div class="offrows">${off.map(k => {
    const n = nodes[k];
    return `<button class="offrow" data-key="${esc(k)}">${flag(n.cc)}<span class="nm">${esc(n.name)}</span><span class="why">${esc(state.st[k].t)}${n.panel?.users ? `, ${fmt(n.panel.users)} онлайн` : ''}</span></button>`;
  }).join('')}</div></details>`;
  el.innerHTML = html;
}
function nodeTable(keys){
  const {nodes} = state.model, c = (k, v, d, u = '') => `<td class="n ${cls(k, v)}">${fu(v, d, u)}</td>`;
  return `<div class="table-wrap"><table><thead><tr><th>Нода</th><th>Состояние</th><th class="n">Мбит/с</th><th class="n">Онлайн</th><th class="n">Соед.</th><th class="n">CPU</th><th class="n">Steal</th><th class="n">Пинг</th><th class="n">Потери</th><th class="n">Ретр.</th><th class="n">Канал</th><th class="n">Доступн. 24 ч</th></tr></thead><tbody>` +
    keys.map(k => { const n = nodes[k], s = state.st[k];
      return `<tr class="click${s.stale ? ' stale' : ''}" data-key="${esc(k)}" tabindex="0"><td>${flag(n.cc)}${esc(n.name)}</td><td class="st s-${s.k}">${esc(s.t[0].toUpperCase() + s.t.slice(1))}</td><td class="n">${fmt(n.tx, 1)}</td><td class="n">${fmt(n.panel?.users)}</td><td class="n">${fmt(n.conns)}</td>${c('cpu', n.cpu, 0, '%')}${c('st', n.st, 0, '%')}<td class="n">${fu(n.rtt, 0, ' мс')}</td>${c('loss', n.loss, 1, '%')}<td class="n ${clsN(n, 'retr')}">${fu(n.retr, 1, '%')}</td>${c('util', n.util, 0, '%')}<td class="n">${fu(n.up24, 1, '%')}</td></tr>`;
    }).join('') + '</tbody></table></div>';
}

function xTicks(t0, t1, key, W){
  const out = [];
  if (key === '24h') {
    const d = new Date(t0 * 1000), every = W < 420 ? 6 : 3; d.setMinutes(0, 0, 0);
    for (let t = d / 1000; t <= t1; t += 3600) { const h = new Date(t * 1000).getHours(); if (t >= t0 && h % every === 0) out.push([t, String(h).padStart(2, '0') + ':00']); }
  } else {
    const d = new Date(t0 * 1000); d.setHours(0, 0, 0, 0);
    const every = key === '7d' ? (W < 420 ? 2 : 1) : (W < 420 ? 10 : 5);
    for (let t = d / 1000 + 86400, i = 0; t <= t1; t += 86400, i++) if (i % every === 0) out.push([t, new Date(t * 1000).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'})]);
  }
  return out;
}

// общий линейный график: data — {ключ: [[t, v]]}, names — что рисовать, color/label — по ключу
function lineChart(wrap, {data, names, M, rangeKey, t1, color, label, compact, th}){
  const R = RANGES[rangeKey], t0 = t1 - R.sec;
  const W = Math.max(280, wrap.clientWidth), H = compact ? 160 : W < 600 ? 260 : 360, P = {l: 44, r: 10, t: 12, b: 28}, iw = W - P.l - P.r, ih = H - P.t - P.b;
  let vmax = 0; names.forEach(n => data[n].forEach(([, v]) => { if (v > vmax) vmax = v; }));
  if (th && names.length) vmax = Math.max(vmax, th.w * 1.15);   // линия нормы всегда в кадре
  vmax = niceMax(vmax * 1.08 || (M.dec ? 1 : 10));
  const X = t => P.l + (t - t0) / (t1 - t0) * iw, Y = v => P.t + (1 - v / vmax) * ih, yd = vmax < 5 && M.dec ? 1 : 0, gid = 'g' + Math.random().toString(36).slice(2, 8);
  let g = '', paths = '', defs = '';
  const rows = compact ? 2 : 4;
  for (let i = 0; i <= rows; i++) { const v = vmax * i / rows, y = Y(v).toFixed(1); g += `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/><text class="ylab" x="${P.l - 8}" y="${+y + 4}" text-anchor="end">${fmt(v, yd)}</text>`; }
  if (th && names.length) { const y = Y(th.w).toFixed(1); g += `<line class="thline" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/><text class="thlab" x="${W - P.r}" y="${+y - 5}" text-anchor="end">норма до ${fmt(th.w, th.w % 1 ? 1 : 0)}${th.unit}</text>`; }
  xTicks(t0, t1, rangeKey, W).forEach(([t, l]) => { g += `<text class="xlab" x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${l}</text>`; });
  names.forEach(n => {
    const c = color(n);
    for (const seg of segments(data[n], R.step)) {
      const pts = seg.map(([t, v]) => [X(t), Y(v)]), d = smoothPath(pts);
      if (names.length === 1) {
        defs = `<linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${c}" stop-opacity=".32"/><stop offset="1" style="stop-color:${c}" stop-opacity="0"/></linearGradient>`;
        paths += `<path d="${d}L${pts.at(-1)[0].toFixed(1)},${Y(0)}L${pts[0][0].toFixed(1)},${Y(0)}Z" fill="url(#${gid})"/>`;
      }
      paths += `<path d="${d}" fill="none" style="stroke:${c}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(M.label)}"><defs>${defs}</defs>${g}${paths}<line class="cross" visibility="hidden" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}"/><rect class="hit" x="${P.l}" y="${P.t}" width="${iw}" height="${ih}" fill="transparent"/></svg><div class="tip" hidden></div>`;
  if (!names.length) { wrap.insertAdjacentHTML('beforeend', '<p class="empty">Нет данных за этот период</p>'); return; }
  const svg = wrap.querySelector('svg'), tip = wrap.querySelector('.tip'), cross = svg.querySelector('.cross');
  const times = [...new Set(names.flatMap(n => data[n].map(p => p[0])))].sort((a, b) => a - b), look = Object.fromEntries(names.map(n => [n, new Map(data[n])]));
  const hit = svg.querySelector('.hit');
  const move = e => {
    if (!times.length) return;
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) * (W / r.width), t = t0 + (x - P.l) / iw * (t1 - t0);
    let best = times[0];
    for (const tt of times) if (Math.abs(tt - t) < Math.abs(best - t)) best = tt;
    const cx = X(best).toFixed(1); cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    const rows = names.map(n => [n, look[n].get(best)]).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]);
    tip.innerHTML = `<b>${when(best)}</b>` + rows.map(([n, v]) => `<div><i style="background:${color(n)}"></i>${esc(label(n))}<span>${fmt(v, M.dec)}${M.unit ? ' ' + M.unit : ''}</span></div>`).join('');
    tip.hidden = false;
    const px = cx / W * r.width;
    tip.style.left = (px + tip.offsetWidth + 24 > r.width ? Math.max(0, px - tip.offsetWidth - 14) : px + 14) + 'px';
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
}
function renderChart(){
  const S = state.series?.data || {}, names = state.order.filter(n => S[n]?.length && !state.hidden.has(n));
  $('#chart-sub').textContent = 'Нагрузка ' + RANGES[state.range].label;
  lineChart($('#chart'), {data: S, names, M: METRICS[state.metric], rangeKey: state.range, t1: state.series?.end || Date.now() / 1000, color: colorOf, label: nm});
  $('#legend').innerHTML = state.order.filter(n => S[n]?.length).map(n => `<button data-n="${esc(n)}" aria-pressed="${!state.hidden.has(n)}"><i style="background:${colorOf(n)}"></i>${esc(nm(n))}</button>`).join('');
}

function renderHeat(){
  const {nodes} = state.model, rows = state.order.filter(n => nodes[n].heat.some(v => v != null)), el = $('#heat');
  if (!rows.length) { el.innerHTML = '<p class="empty">Пока мало данных: нужен хотя бы день сбора.</p>'; $('#heat-note').textContent = ''; return; }
  const B = el.clientWidth < 560 ? 3 : 1, cols = 24 / B, h2 = h => String(h).padStart(2, '0');   // на телефоне — по 3 часа
  const bucket = hv => Array.from({length: cols}, (_, i) => { const xs = hv.slice(i * B, i * B + B).filter(v => v != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; });
  const data = Object.fromEntries(rows.map(n => [n, bucket(nodes[n].heat)]));
  let max = 0; rows.forEach(n => data[n].forEach(v => { if (v > max) max = v; }));
  el.style.setProperty('--cols', cols);
  let html = '<div class="heat-row head"><span></span>' + Array.from({length: cols}, (_, i) => `<span>${B > 1 || i % 3 === 0 ? h2(i * B) : ''}</span>`).join('') + '</div>';
  for (const n of rows) {
    const hv = data[n], pk = hv.indexOf(Math.max(...hv.map(v => v ?? -1)));
    html += `<div class="heat-row"><span class="heat-name">${esc(nm(n))}</span>` + hv.map((v, i) => `<button class="cell${i === pk ? ' peak' : ''}" data-n="${esc(n)}" data-i="${i}" aria-pressed="false" aria-label="${esc(nm(n))}, ${h2(i * B)}:00 — ${v == null ? 'нет данных' : fmt(v, 1) + ' Мбит/с'}" title="${h2(i * B)}:00 — ${v == null ? 'нет данных' : fmt(v, 1) + ' Мбит/с'}"><i style="--k:${v == null ? 0 : (v / (max || 1)).toFixed(3)}"></i></button>`).join('') + '</div>';
  }
  el.innerHTML = html;
  const total = Array.from({length: 24}, (_, h) => rows.reduce((a, n) => a + (nodes[n].heat[h] || 0), 0));
  const hi = total.indexOf(Math.max(...total)), lo = total.indexOf(Math.min(...total));
  state.heatNote = `Больше всего нагрузки около <b>${h2(hi)}:00</b>, меньше всего около <b>${h2(lo)}:00</b> по вашему времени.`;
  state.heatB = B; state.heatData = data;
  $('#heat-note').innerHTML = state.heatNote;
}

function renderFull(){
  const {nodes} = state.model, rows = state.order.filter(n => nodes[n].full), el = $('#full');
  if (!rows.length) { el.innerHTML = '<p class="empty">Полных проверок ещё не было. Запустите на ноде: sudo bash node-check.sh, пункт 1.</p>'; return; }
  const c = (v, good, bad, up = true, unit = '') => v == null ? '—' : `<span class="${up ? (v >= good ? 'g' : v >= bad ? 'y' : 'r') : (v <= good ? 'g' : v <= bad ? 'y' : 'r')}">${fmt(v)}${unit}</span>`;
  el.innerHTML = `<table><thead><tr><th>Нода</th><th>CPU, 1 поток</th><th>CPU, все ядра</th><th>Ядра работают</th><th>Steal под нагрузкой</th><th>Канал до РФ, Мбит/с</th><th>Из Европы, Мбит/с</th><th>Заморозки 16–20 КБ</th><th>Режет DPI</th><th>Замечаний</th><th>Когда</th></tr></thead><tbody>` +
    rows.map(n => { const f = nodes[n].full; return `<tr class="click" data-key="${esc(n)}" tabindex="0"><td>${esc(nm(n))}</td><td>${c(f.cpu, 1000, 700)}</td><td>${fmt(f.mt)}</td><td>${c(f.sc, 85, 60, true, '%')}</td><td>${c(f.st, 5, 15, false, '%')}</td><td>${c(f.ip, 200, 80)}</td><td>${c(f.eu, 200, 80)}</td><td>${c(f.fr, 0, 0, false)}</td><td>${c(f.dpi, 0, 2, false)}</td><td>${c(f.pr, 0, 2, false)}</td><td>${ago(f.at)}</td></tr>`; }).join('') + '</tbody></table>';
}

function renderHosters(){
  const {nodes} = state.model, el = $('#hosters'), H = {};
  for (const n of Object.values(nodes)) {
    if (n.seen == null) continue;
    const k = hosterOf(n.name).toLowerCase(), h = (H[k] ||= {name: hosterOf(n.name), nodes: [], st: [], re: [], lo: [], up: []});
    h.nodes.push(n.name);
    for (const [a, b] of [['st', 'a_st'], ['re', 'a_re'], ['lo', 'a_lo'], ['up', 'up30']]) if (n[b] != null) h[a].push(n[b]);
  }
  const list = Object.values(H).sort((a, b) => b.nodes.length - a.nodes.length || a.name.localeCompare(b.name));
  if (!list.length) { el.innerHTML = '<p class="empty">Пока нет данных.</p>'; return; }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null, cu = v => v == null ? '' : v < 97 ? 'bad' : v < 99.5 ? 'meh' : '';
  el.innerHTML = `<table><thead><tr><th>Хостер</th><th>Ноды</th><th class="n">Steal</th><th class="n">Ретрансмиты</th><th class="n">Потери</th><th class="n">Доступность</th></tr></thead><tbody>` +
    list.map(h => { const st = avg(h.st), re = avg(h.re), lo = avg(h.lo), up = h.up.length ? Math.min(...h.up) : null;
      return `<tr><td>${esc(h.name)}</td><td style="white-space:normal;color:var(--muted)">${h.nodes.map(esc).join(', ')}</td><td class="n ${cls('st', st)}">${fu(st, 1, '%')}</td><td class="n ${cls('retr', re)}">${fu(re, 1, '%')}</td><td class="n ${cls('loss', lo)}">${fu(lo, 2, '%')}</td><td class="n ${cu(up)}" title="худшая нода хостера">${fu(up, 1, '%')}</td></tr>`;
    }).join('') + '</tbody></table>';
}
