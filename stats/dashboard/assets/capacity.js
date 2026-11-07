'use strict';
// Ёмкость: когда нода упрётся в канал, как разложить нагрузку по выходам, сколько это стоит; риск блокировки соседей

/* ---------- прогноз: прямая по дневным пикам ---------- */
const CAP_LIMIT = .9;   // «упёрлась» — пик дошёл до 90% канала (тот же порог «плохо», что у «канал занят»)
// МНК по точкам [t, v]: наклон в Мбит/с за сутки и значение прямой «сейчас»
function trend(pts, now){
  if (pts.length < 7) return null;
  const xs = pts.map(p => (p[0] - now) / 86400), ys = pts.map(p => p[1]), n = xs.length;
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const slope = sxx ? sxy / sxx : 0;
  return {slope, now: my - slope * mx};
}
function capOf(n){
  // предел — меньшее из канала (iperf) и того, что протянет процессор (assets/hw.js): слабый CPU упирается раньше канала
  const pk = n.peaks || [], cc = cpuCap(n), now = state.model.end;
  const pk7 = pk.filter(p => p[0] > now - 7 * 86400).reduce((a, p) => Math.max(a, p[1]), 0) || null;
  // iperf3 до публичного сервера в РФ меряет меньшее из нашего канала и того сервера (их часто грузят другие) —
  // это нижняя граница. Если нода уже отдавала больше, замер точно занижен: каналом его не считаем
  const ip0 = n.full?.ip > 0 ? n.full.ip : null, ipLow = ip0 && pk7 && pk7 > ip0, ip = ipLow ? null : ip0;
  const cap = ip && cc ? Math.min(ip, cc) : ip || cc || null, by = cc && (!ip || cc < ip) ? 'cpu' : 'net';
  const tr = trend(pk, now), r = {pk7, cap, ip, ip0, ipLow, by, cpuKnown: cc != null, tr, util: cap && pk7 != null ? pk7 / cap * 100 : null, days: null, when: '', pts: pk.length};
  if (!cap || !tr) return r;
  const lim = cap * CAP_LIMIT;
  if (Math.max(tr.now, pk7 || 0) >= lim) { r.days = 0; r.when = 'уже упирается'; }
  else if (tr.slope <= cap * .001) r.when = tr.slope < -cap * .001 ? 'пик снижается' : 'пик не растёт';
  else { r.days = (lim - tr.now) / tr.slope; r.when = r.days > 365 ? 'больше чем через год' : `через ${fmt(r.days)} дн, около ${new Date((now + r.days * 86400) * 1000).toLocaleDateString('ru-RU', {day: 'numeric', month: 'long'})}`; }
  return r;
}
// откуда взялся предел — коротко, чтобы не принимать догадку за замер
function capWhy(n, c){
  const f = n.hw?.fit, cpu = !c.cpuKnown ? 'CPU не оценён — нагрузка ещё не менялась' : f?.by === 'pool' ? `CPU — оценка по похожим нодам (${f.pool.length})`
    : f?.by === 'point' ? `по CPU: ${fmt(f.at[0])} Мбит/с при ${fmt(f.at[1])}%` : 'по CPU';
  if (c.ipLow) return `iperf показал ${fmt(c.ip0)} — меньше пика, замер занижен · ${cpu}`;
  if (!c.ip0) return c.cpuKnown ? `${cpu} · iperf не было` : 'нужна полная проверка';
  return c.by === 'cpu' ? `${cpu}, канал ${fmt(c.ip)}` : c.cpuKnown ? 'канал (iperf)' : `канал (iperf) · ${cpu}`;
}
// мини-график пиков за 30 дней и линия канала
function miniPeaks(pk, cap){
  if (pk.length < 2) return '';
  const W = 120, H = 30, t0 = pk[0][0], t1 = pk.at(-1)[0], vmax = Math.max(cap || 0, ...pk.map(p => p[1])) * 1.05 || 1;
  const X = t => (t - t0) / ((t1 - t0) || 1) * W, Y = v => H - v / vmax * H;
  const d = pk.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  return `<svg class="mini" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${cap ? `<path class="cap" d="M0,${Y(cap).toFixed(1)}H${W}"/>` : ''}<path d="${d}"/></svg>`;
}

/* ---------- советы: балансировщик и прогноз ---------- */
// выходы за одним мостом балансируются вместе; без связей мостов — все выходы одной группой
function capAdvice(){
  const N = state.model.nodes, out = [], live = Object.values(N).filter(n => state.st[n.key]?.cat !== 'off' && n.seen != null);
  const C = Object.fromEntries(live.map(n => [n.key, capOf(n)]));
  const exits = live.filter(n => !n.bridge && C[n.key].util != null), bridges = live.filter(n => n.bridge && C[n.key].util != null);
  const pct = n => `${fmt(C[n.key].util)}% (${fmt(C[n.key].pk7)} из ${fmt(C[n.key].cap)} Мбит/с)`;
  const links = state.model.links || [], behind = {};
  for (const l of links) (behind[l.from] ||= new Set()).add(l.to);
  const groupOf = n => { const bs = links.filter(l => l.to === n.key).map(l => l.from); return bs.length ? bs : ['*']; };
  for (const hot of exits.filter(n => C[n.key].util >= 70).sort((a, b) => C[b.key].util - C[a.key].util)) {
    // свободнее всего — выход за тем же мостом; нет такого — любой выход, лучше в той же стране
    const gs = groupOf(hot), peers = exits.filter(n => n !== hot && C[n.key].util <= 45 && (gs[0] === '*' || groupOf(n).some(g => gs.includes(g))));
    const cool = peers.sort((a, b) => (b.cc === hot.cc) - (a.cc === hot.cc) || C[a.key].util - C[b.key].util)[0];
    out.push(cool
      ? {k: C[hot.key].util >= 90 ? 'err' : 'warn', ic: 'arrow-right-left', key: hot.key, t: `Разгрузите ${hot.name}: в пик занят на ${pct(hot)}`,
        p: `Свободнее всего ${cool.name} — ${pct(cool)}. Поднимите ему вес в балансировщике (или переведите часть пользователей), а ${hot.name} — опустите.`}
      : {k: C[hot.key].util >= 90 ? 'err' : 'warn', ic: 'server', key: hot.key, t: `${hot.name} в пик занят на ${pct(hot)}`,
        p: 'Свободных выходов рядом нет — пора добавить ноду или взять тариф с каналом шире.'});
  }
  for (const b of bridges.filter(n => C[n.key].util >= 70))
    out.push({k: C[b.key].util >= 90 ? 'err' : 'warn', ic: 'route', key: b.key, t: `Мост ${b.name} в пик занят на ${pct(b)}`, p: 'Через мост идёт весь трафик его выходов: добавьте второй мост или канал шире.'});
  for (const n of live) { const c = C[n.key]; if (c.days != null && c.days > 0 && c.days <= 45)
    out.push({k: c.days <= 14 ? 'err' : 'warn', ic: 'trending-up', key: n.key, t: `${n.name} упрётся в ${c.by === 'cpu' ? 'процессор' : 'канал'} ${c.when.replace('через', 'примерно через')}`, p: `Пик растёт на ${fmt(c.tr.slope * 7)} Мбит/с в неделю, канал ${fmt(c.cap)} Мбит/с. Время подготовить замену или соседнюю ноду.`}); }
  // перекос без перегруза: в одной группе один выход занят втрое больше другого
  if (!out.some(a => a.ic === 'arrow-right-left') && exits.length > 1) {
    const s = [...exits].sort((a, b) => C[b.key].util - C[a.key].util), hi = s[0], lo = s.at(-1);
    if (C[hi.key].util >= 40 && C[hi.key].util > 3 * C[lo.key].util)
      out.push({k: 'info', ic: 'arrow-right-left', key: hi.key, t: `Нагрузка неравномерная: ${hi.name} ${fmt(C[hi.key].util)}%, ${lo.name} ${fmt(C[lo.key].util)}%`, p: 'Запас пока есть, но вес в балансировщике можно выровнять заранее.'});
  }
  out.push(...hwAdvice());
  state.capCache = C;
  return out;
}

/* ---------- риск: соседи заблокированной ноды ---------- */
// блокируют часто подсетью (/24) или всем хостером: предупреждаем остальных в той же подсети и у того же хостера
const net24 = ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip || '') ? ip.split('.').slice(0, 3).join('.') : null;
const ipsOf = n => [...new Set([...(n.panel ? [...n.panel.ips] : []), n.ip].filter(x => x && x !== '-'))];
function computeRisk(){
  const N = state.model.nodes, out = {};
  const blocked = new Set(Object.keys(N).filter(k => state.st[k]?.block));
  // и те, у кого блокировка была за сутки — в «Сутках» есть такое событие
  if (state.day) for (const e of dayAll().events) if (e.kind === 'block' && e.key) blocked.add(e.key);
  for (const bk of blocked) {
    const b = N[bk], nets = new Set(ipsOf(b).map(net24).filter(Boolean)), ho = hosterOf(b.name).toLowerCase();
    for (const n of Object.values(N)) {
      if (n.key === bk || blocked.has(n.key) || state.st[n.key]?.cat === 'off') continue;
      if (ipsOf(n).some(ip => nets.has(net24(ip)))) out[n.key] = {k: 'warn', t: `в одной подсети /24 с ${b.name}, у которой похоже заблокирован IP — могут заблокировать и эту`};
      else if (!out[n.key] && !n.bridge && hosterOf(n.name).toLowerCase() === ho) out[n.key] = {k: 'info', t: `тот же хостер, что у ${b.name} (похоже, блокировка) — следите за онлайном`};
    }
  }
  return out;
}
const riskLine = key => { const r = state.risk?.[key]; return r ? `<div class="risk${r.k === 'info' ? ' info' : ''}">${icon('shield-alert', 'si')}<span>${esc(r.t[0].toUpperCase() + r.t.slice(1))}</span></div>` : ''; };

/* ---------- раздел «Ёмкость» ---------- */
function renderCapacity(){
  const N = state.model.nodes, adv = state.capAdvice = capAdvice(), C = state.capCache;
  $('#advice').innerHTML = adv.length ? adv.map(a => `<div class="adv ${a.k}" data-key="${esc(a.key)}" role="button" tabindex="0">${icon(a.ic)}<div><b>${esc(a.t)}</b><p>${esc(a.p)}</p></div></div>`).join('')
    : `<div class="adv">${icon('circle-check')}<div><b>Запас по каналам есть</b><p>Ни один выход в пик не занят больше чем на 70%, и никто не упрётся в канал в ближайшие полтора месяца.</p></div></div>`;
  const rows = state.order.filter(k => N[k].seen != null && state.st[k].cat !== 'off').sort((a, b) => (C[a].days ?? 1e9) - (C[b].days ?? 1e9) || (C[b].util ?? -1) - (C[a].util ?? -1));
  if (!rows.length) { $('#cap').innerHTML = '<p class="empty">Пока нет данных.</p>'; return; }
  $('#cap').innerHTML = `<table><thead><tr><th>Нода</th><th class="n">Пик за 7 дн</th><th class="n">Канал</th><th class="n">Занят в пик</th><th class="n">Тренд пика</th><th>Упрётся</th><th>30 дней</th><th class="n">ТБ за 30 дн</th></tr></thead><tbody>` +
    rows.map(k => { const n = N[k], c = C[k], tb = tbOf(n);
      return `<tr class="click" data-key="${esc(k)}" tabindex="0"><td title="${esc(cpuName(n.hw))}">${flag(n.cc)}${esc(n.name)}<span class="sub">${n.bridge ? 'мост' : 'выход'}${hwShort(n) ? ' · ' + hwShort(n) : ''}</span></td>
        <td class="n">${fu(c.pk7, 0, ' Мбит/с')}</td><td class="n">${c.cap ? fmt(c.cap) + ' Мбит/с' : '—'}<span class="sub">${capWhy(n, c)}</span></td>
        <td class="n ${cls('util', c.util)}">${fu(c.util, 0, '%')}</td>
        <td class="n">${c.tr ? `${c.tr.slope >= 0 ? '+' : '−'}${fmt(Math.abs(c.tr.slope * 7), 1)} Мбит/с в нед` : `<span class="sub" title="Прямой по дневным пикам нужно хотя бы 7 дней">мало данных: ${c.pts} из 7 дн</span>`}</td>
        <td class="${c.days === 0 ? 'bad' : c.days != null && c.days <= 45 ? 'meh' : ''}">${esc(c.when || (c.cap ? '' : 'нужна полная проверка'))}</td>
        <td>${miniPeaks(n.peaks || [], c.cap)}</td><td class="n">${tb != null ? fmt(tb, tb < 10 ? 1 : 0) : '—'}</td></tr>`; }).join('') + '</tbody></table>';
}
// отдано пользователям за 30 дней, ТБ: средняя скорость по снимкам × время, покрытое снимками
function tbOf(n){
  if (n.a_tx == null || n.up30 == null || !n.t30) return null;
  const sec = Math.min(2592000, Date.now() / 1000 - n.t30) * n.up30 / 100;
  return n.a_tx * sec / 8 / 1e6;
}
for (const id of ['#cap', '#advice']) {
  $(id).addEventListener('click', e => { const t = e.target.closest('[data-key]'); if (t) openNode(t.dataset.key); });
  $(id).addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-key]')) { e.preventDefault(); openNode(e.target.dataset.key); } });
}
