'use strict';
// Пользователи: тарифы, приход и уход, экономика, кому предложить тариф выше. Сводку считает node-auth (/auth/tariffs)
// из API панели раз в 10 минут; тариф узнаётся по лимитам (трафик и устройства), служебные и тестовые аккаунты
// (по имени или бессрочной подписке) не считаются. Раз в час node-auth пишет в VictoriaMetrics суммы по тарифам —
// отсюда настоящий трафик тарифа за 30 дней и платящие по дням. Деньги — по прайсу за месяц: часть пользователей купила
// 3, 6 или 12 месяцев со скидкой, поэтому доход — верхняя оценка.

const tar = {data: null, err: '', busy: false, at: 0, hist: null};
const ECON_KEY = 'sepia-econ';
const econCfg = () => { try { return {EUR: 95, USD: 85, fee: 0, ...JSON.parse(store.get(ECON_KEY) || '{}')}; } catch { return {EUR: 95, USD: 85, fee: 0}; } };
const rub = v => v == null || !isFinite(v) ? '—' : `${fmt(v, 0)} ₽`;
const pctS = (v, d = 0) => v == null || !isFinite(v) ? '—' : `${fmt(v * 100, d)}%`;
const tName = t => t.id === 'other' ? 'Не по тарифу' : t.id === 'fallback' ? 'Запасной' : t.price ? `${fmt(t.price)} ₽` : 'Пробная';
const tDesc = t => `${t.gb ? `${fmt(t.gb)} ГБ` : 'безлимит'} · ${t.dev} ${plural(t.dev, 'устройство', 'устройства', 'устройств')}`;
const gbS = v => v == null ? '—' : `${fmt(v, v < 10 ? 1 : 0)} ГБ`;

async function loadTariffs(fresh = false){
  if (tar.busy || (!fresh && tar.data && Date.now() - tar.at < 300000)) return renderUsers();
  tar.busy = true; tar.err = ''; renderUsers();
  try {
    if (DEMO) { tar.data = demoTariffs(); tar.hist = demoTarHist(tar.data); }
    else {
      const r = await auth('tariffs', fresh ? {fresh: 1} : {});
      if (r.status === 501) throw new Error('Нужен API-токен Remnawave: RW_TOKEN в stats/.env, затем docker compose up -d auth');
      if (r.status === 401) throw new Error('Войдите заново — сессия истекла');
      if (r.status === 404) throw new Error('node-auth старый — обновите: cd /opt/Sepia && git pull && cd stats && docker compose up -d --force-recreate auth dashboard');
      if (r.status !== 200) throw new Error('Панель не ответила (HTTP ' + r.status + ') — проверьте права токена');
      tar.data = await r.json();
      tar.hist = await tarHist().catch(() => null);
    }
    tar.at = Date.now();
  } catch (e) { tar.err = e.message; }
  tar.busy = false; renderUsers();
}

// история из VictoriaMetrics: трафик тарифов за 30 дней (сумма часовых приростов) и платящие по дням
async function tarHist(){
  const end = Math.floor(Date.now() / 1000);
  const [gb, hours, pay] = await Promise.all([
    inst('sum by (tariff) (sum_over_time(sepia_tariff_gb_hour[30d]))'),
    inst('max(count_over_time(sepia_tariff_gb_hour[30d]))'),
    vm('query_range', {query: 'sum by (tariff) (last_over_time(sepia_tariff_paying[1d]))', start: end - 90 * 86400, end, step: 86400})]);
  return {gb: Object.fromEntries(gb.map(s => [s.metric.tariff, +s.value[1]])), hours: hours[0] ? +hours[0].value[1] : 0,
    pay: pay.map(s => ({id: s.metric.tariff, v: s.values.map(([t, v]) => [+t, +v])}))};
}

function renderUsers(){
  const D = tar.data, box = ['#tar', '#flow', '#econ', '#ups'].map(id => $(id));
  if (!box[0]) return;
  if (tar.busy && !D) { box.forEach(b => b.innerHTML = '<div class="skel skel-table"></div>'); return; }
  if (tar.err) { box.forEach(b => b.innerHTML = `<p class="empty">${esc(tar.err)}</p>`); return; }
  if (!D) { box.forEach(b => b.innerHTML = ''); return; }
  box[0].innerHTML = tariffsHtml(D); box[1].innerHTML = flowHtml(D); box[2].innerHTML = econHtml(D); box[3].innerHTML = upsHtml(D);
  cardify();
}

const paid = D => D.tariffs.filter(t => t.price);

function tariffsHtml(D){
  const P = paid(D), payN = P.reduce((a, t) => a + t.paying, 0), mrr = P.reduce((a, t) => a + t.mrr, 0);
  const tri = D.tariffs.filter(t => !t.price), triN = tri.reduce((a, t) => a + t.paying, 0);
  const newN = Object.entries(D.flow).filter(([k]) => k.startsWith('new')).reduce((a, [, v]) => a + v.reduce((x, y) => x + y, 0), 0);
  const lost = D.flow.lost.reduce((a, b) => a + b, 0), c = D.conv;
  const kpi = (l, v, s) => `<div class="u-kpi"><div class="k-label">${l}</div><div class="k-value num">${v}</div><div class="k-sub">${s}</div></div>`;
  const head = `<div class="acc-head"><span class="muted">${fmt(D.users)} аккаунтов в панели · ${ago(D.at)}</span>
    <button class="pill" data-tar-refresh${tar.busy ? ' disabled' : ''}>${icon('refresh-cw', tar.busy ? 'ic spin' : 'ic')}${tar.busy ? 'Считаю…' : 'Пересчитать'}</button></div>`;
  const kpis = `<div class="u-kpis">
    ${kpi('Платят сейчас', fmt(payN), `ещё ${fmt(triN)} на пробной`)}
    ${kpi('Доход в месяц', rub(mrr), 'по прайсу — не больше этого: часть купила 3–12 месяцев со скидкой')}
    ${kpi('За 30 дней', `+${fmt(newN)} <small>/ −${fmt(lost)}</small>`, 'пришло новых / подписка кончилась и не продлена')}
    ${kpi('Пробная → оплата', c?.share != null ? pctS(c.share) : '—', c ? `${fmt(c.paid)} из ${fmt(c.paid + c.trial)} новых старше ${fmt((D.trial_days || 5) + 1)} дней купили подписку` : 'пробной нет в TARIFFS')}</div>`;
  const row = t => {
    const lim = t.gb ? t.at100 : t.dev_full, limS = t.gb ? `${fmt(t.at100)}<span class="sub">ещё ${fmt(Math.max(0, t.at80 - t.at100))} на 80–99%</span>` : `${fmt(t.dev_full)}<span class="sub">все устройства заняты</span>`;
    const share = v => t.paying ? ` <small>${pctS(v / t.paying)}</small>` : '';
    return `<tr><td><b>${tName(t)}</b><span class="sub">${tDesc(t)}</span></td>
      <td class="n">${fmt(t.paying)}<span class="sub">всего ${fmt(t.n)}</span></td>
      <td class="n">${fmt(t.on24)}${share(t.on24)}<span class="sub">не подключались ${fmt(t.never)}</span></td>
      <td class="n">${gbS(t.used_med)}<span class="sub">у 10% больше ${gbS(t.used_p90)}</span></td>
      <td class="n ${t.gb && t.paying && lim / t.paying >= .25 ? 'meh' : ''}">${limS}</td>
      <td class="n">${t.dev_avg != null ? `${fmt(t.dev_avg, 1)} из ${t.dev}` : '—'}${t.extra ? `<span class="sub">+${fmt(t.extra)} докуплено</span>` : ''}</td>
      <td class="n">${gbS(t.life_mo_med)}<span class="sub">у 10% больше ${gbS(t.life_mo_p90)}</span></td>
      <td class="n ${t.paying && t.exp7 / t.paying >= .2 ? 'meh' : ''}">${fmt(t.exp7)}<span class="sub">${t.price ? `не продлили за 30 дней ${fmt(t.gone30)}` : 'пробных'}</span></td></tr>`;
  };
  const table = `<div class="table-wrap"><table class="tar-t"><thead><tr><th>Тариф</th><th class="n">Платят</th><th class="n">Заходили за сутки</th>
    <th class="n" title="Сколько израсходовано с последнего сброса трафика (у безлимита обычно — всё время)">Трафик за период</th><th class="n">Упёрлись в лимит</th>
    <th class="n" title="Сколько устройств подключено в среднем">Устройства</th><th class="n" title="Весь трафик пользователя, делённый на месяцы с регистрации; только аккаунты старше недели">В месяц</th>
    <th class="n" title="Подписка кончится в ближайшие 7 дней; ниже — кончилась за последние 30 дней и не продлена">Кончится за 7 дней</th></tr></thead>
    <tbody>${D.tariffs.map(row).join('')}</tbody></table></div>`;
  const odd = [];
  if (D.other.length) odd.push(`<p><b>Не подошли ни к одному тарифу</b>: ${D.other.map(o => `${o.gb ? `${fmt(o.gb)} ГБ` : 'безлимит'}, ${o.dev ? `${o.dev} ${plural(o.dev, 'устройство', 'устройства', 'устройств')}` : 'устройства без лимита'} — ${fmt(o.n)}`).join('; ')}. В расчёт не взяты; если это тариф — добавьте его в TARIFFS в stats/.env.</p>`);
  const FB = D.fallback;
  if (FB?.n) odd.push(`<p><b>На запасном лимите ${fmt(FB.gb)} ГБ</b> (не оплатили после конца подписки): ${fmt(FB.n)} — раньше платили ≈${fmt(FB.was_paid)}, заходили за неделю ${fmt(FB.on7)}, не заходят 3 месяца и дольше ${fmt(FB.dead)}. В тарифы и доход не входят; кого вернуть — во «Предложить больше».</p>`);
  if (D.old?.length) { const on = D.old.reduce((x, o) => x + o.live, 0);
    odd.push(`<p><b>Старые тарифы и старые пробные</b> не считаются: ${D.old.map(o => `${fmt(o.gb)} ГБ${o.dev ? `, ${o.dev} ${plural(o.dev, 'устройство', 'устройства', 'устройств')}` : ''} — ${fmt(o.n)}`).join('; ')}.${on ? ` <b>${fmt(on)} из них с действующей подпиской</b> — платят по старой цене или лимиты не сменили после покупки.` : ''}</p>`); }
  const sk = D.skip || {}, skN = (sk.name || 0) + (sk.forever || 0);
  if (skN) odd.push(`<p><b>Служебные и тестовые не считаются</b>: ${fmt(skN)} — ${[sk.name && `${fmt(sk.name)} по имени, тегу или описанию`, sk.forever && `${fmt(sk.forever)} с бессрочной подпиской`].filter(Boolean).join(', ')}${sk.names?.length ? ` (${sk.names.map(esc).join(', ')}${skN > sk.names.length ? '…' : ''})` : ''}. Правило — USERS_SKIP и USERS_SKIP_DAYS в stats/.env.</p>`);
  if (!D.devices) odd.push('<p>Панель не отдала устройства HWID — колонка «Устройства» и безлимитные тарифы по устройствам считаются неточно.</p>');
  return head + kpis + table + (odd.length ? `<div class="vernote info">${odd.join('')}</div>` : '');
}

// приход и уход по дням: столбик вверх — новые (сейчас платят / на пробной), вниз — не продлили
function flowHtml(D){
  const F = D.flow, N = 30, newP = F.new_paid, newT = F.new_trial.map((v, i) => v + F.new_other[i]), lost = F.lost;
  const sum = a => a.reduce((x, y) => x + y, 0), up = Math.max(1, ...newP.map((v, i) => v + newT[i])), dn = Math.max(1, ...lost);
  const W = 720, H = 220, sc = (H - 26) / (up + dn), mid = up * sc + 2, bw = W / N;
  const day = i => new Date((D.day0 - (N - 1 - i) * 86400) * 1000).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'});
  const bars = Array.from({length: N}, (_, i) => {
    const x = i * bw + 2, w = bw - 4, a = newP[i] * sc, b = newT[i] * sc, c = lost[i] * sc;
    return `<g><title>${day(i)}: новых ${newP[i] + newT[i]} (купили ${newP[i]}, только пробная ${newT[i]}), не продлили ${lost[i]}</title>
      <rect x="${x}" y="${mid - a}" width="${w}" height="${a}" class="fl-p"/><rect x="${x}" y="${mid - a - b}" width="${w}" height="${b}" class="fl-t"/>
      <rect x="${x}" y="${mid}" width="${w}" height="${c}" class="fl-l"/></g>`;
  }).join('');
  const axis = [0, 7, 14, 21, 29].map(i => `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${day(i)}</text>`).join('');
  const nP = sum(newP), nT = sum(newT), nL = sum(lost), exp7 = paid(D).reduce((a, t) => a + t.exp7, 0);
  const net = nP - nL;
  let hist = '';
  const ph = tar.hist?.pay || [];
  if (ph.length) {
    const ids = new Set(paid(D).map(t => t.id)), byT = {};
    for (const s of ph) if (ids.has(s.id)) for (const [t, v] of s.v) byT[t] = (byT[t] || 0) + v;
    const pts = Object.entries(byT).map(([t, v]) => [+t, v]).sort((a, b) => a[0] - b[0]);
    if (pts.length >= 3) {
      const lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])), t0 = pts[0][0], t1 = pts.at(-1)[0];
      const X = t => (t - t0) / Math.max(1, t1 - t0) * (W - 20) + 10, Y = v => 150 - (v - lo) / Math.max(1, hi - lo) * 120;
      hist = `<h3 class="u-h3">Платящих по дням<span>${fmt(pts[0][1])} → ${fmt(pts.at(-1)[1])} за ${pts.length} ${plural(pts.length, 'день', 'дня', 'дней')}</span></h3>
        <svg class="u-line" viewBox="0 0 ${W} 170" preserveAspectRatio="none" role="img" aria-label="Платящих по дням"><polyline points="${pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}"/></svg>`;
    }
  }
  if (!hist) hist = '<p class="note">«Платящих по дням» появится через пару дней: node-auth пишет число платящих раз в час с момента обновления.</p>';
  return `<div class="u-kpis">
      <div class="u-kpi"><div class="k-label">Пришли за 30 дней</div><div class="k-value num">${fmt(nP + nT)}</div><div class="k-sub">купили подписку ${fmt(nP)}, только пробная ${fmt(nT)}</div></div>
      <div class="u-kpi"><div class="k-label">Не продлили за 30 дней</div><div class="k-value num">${fmt(nL)}</div><div class="k-sub">купленная подписка кончилась и не продлена${F.trial_end ? `; ещё ${fmt(sum(F.trial_end))} пробных кончились без покупки` : ''}</div></div>
      <div class="u-kpi"><div class="k-label">Платящих прибавилось</div><div class="k-value num ${net < 0 ? 'bad' : ''}">${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</div><div class="k-sub">новые платящие минус не продлившие</div></div>
      <div class="u-kpi"><div class="k-label">Кончится за 7 дней</div><div class="k-value num">${fmt(exp7)}</div><div class="k-sub">${D.fallback ? `на запасном ${fmt(D.fallback.gb)} ГБ ${fmt(D.fallback.n)}, из них заходили за неделю ${fmt(D.fallback.on7)} · ` : ''}платных подписок — напомнить о продлении</div></div></div>
    <div class="fl-legend"><span><i class="fl-p"></i>новые, купили</span><span><i class="fl-t"></i>новые, только пробная</span><span><i class="fl-l"></i>не продлили</span></div>
    <svg class="u-flow" viewBox="0 0 ${W} ${H}" role="img" aria-label="Приход и уход по дням">${bars}<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="fl-0"/>${axis}</svg>${hist}`;
}

// экономика: расходы на ноды (цена в месяц + платный трафик сверх включённого) против дохода по прайсу
function econOf(D){
  const cfg = econCfg(), toRub = (v, cur) => v == null ? null : !cur || cur === 'RUB' ? v : cfg[cur] ? v * cfg[cur] : null;
  const nodes = Object.values(state.model?.nodes || {}).filter(n => state.st?.[n.key]?.cat !== 'off' || n.price);
  const rows = [], noPrice = [], noRate = new Set();
  for (const n of nodes) {
    if (!n.price) { if (n.seen != null) noPrice.push(n.name); continue; }
    const p = n.price, fixed = toRub(p.v, p.cur);
    if (fixed == null) { noRate.add(p.cur); continue; }
    const tx = tbOf(n), rx = tx != null && n.a_tx ? tx * (n.a_rx || 0) / n.a_tx : null;
    let tb = null, over = 0, tcost = 0;
    if (p.tbp) { tb = p.dir === 'out' ? tx : tx != null ? tx + (rx || 0) : null; over = tb != null ? Math.max(0, tb - (p.tbi || 0)) : 0; tcost = toRub(over * p.tbp, p.cur) || 0; }
    rows.push({n, p, fixed, tb, tx, over, tcost, total: fixed + tcost, perTb: p.tbp ? toRub(p.tbp, p.cur) : null});
  }
  const cost = rows.reduce((a, r) => a + r.total, 0), tcost = rows.reduce((a, r) => a + r.tcost, 0);
  const P = paid(D), payN = P.reduce((a, t) => a + t.paying, 0), mrr = P.reduce((a, t) => a + t.mrr, 0), net = mrr * (1 - cfg.fee / 100);
  // трафик тарифов за 30 дней: измеренный (часовые приросты в VictoriaMetrics), если накопилось 3+ суток, иначе оценка
  const H = tar.hist, measured = H && H.hours >= 72;
  const traf = {};
  for (const t of D.tariffs) traf[t.id] = measured ? (H.gb[t.id] || 0) * 720 / Math.min(720, H.hours) : (t.life_mo_avg || 0) * t.paying;
  if (measured && D.fallback && H.gb.fallback) traf.fallback = H.gb.fallback * 720 / Math.min(720, H.hours);
  const trafAll = Object.values(traf).reduce((a, b) => a + b, 0);
  return {cfg, rows, noPrice, noRate: [...noRate], cost, tcost, payN, mrr, net, traf, trafAll, measured, hours: H?.hours || 0};
}

function econHtml(D){
  const E = econOf(D), cfg = E.cfg;
  const inp = (k, l, step) => `<label class="u-in"><span>${l}</span><input type="number" min="0" step="${step}" value="${cfg[k]}" data-econ="${k}"></label>`;
  const set = `<div class="u-cfg">${inp('EUR', 'Евро, ₽', '0.5')}${inp('USD', 'Доллар, ₽', '0.5')}${inp('fee', 'Комиссия оплаты и налог, %', '0.5')}
    <span class="muted">Курс и комиссия хранятся в этом браузере.</span></div>`;
  const left = E.net - E.cost;
  const kpi = (l, v, s, cls = '') => `<div class="u-kpi"><div class="k-label">${l}</div><div class="k-value num ${cls}">${v}</div><div class="k-sub">${s}</div></div>`;
  const kpis = `<div class="u-kpis">
    ${kpi('Расходы на ноды', rub(E.cost), E.tcost ? `из них платный трафик ${rub(E.tcost)}` : `${E.rows.length} ${plural(E.rows.length, 'нода', 'ноды', 'нод')} с ценой`)}
    ${kpi('Доход за вычетом комиссии', rub(E.net), 'по прайсу, верхняя оценка')}
    ${kpi('Остаётся в месяц', rub(left), E.net ? `${pctS(left / E.net)} дохода` : '', left < 0 ? 'bad' : '')}
    ${kpi('Один платящий', E.payN ? `${rub(E.net / E.payN)} <small>/ ${rub(E.cost / E.payN)}</small>` : '—', 'приносит / стоит в среднем')}</div>`;
  const warn = [];
  if (E.noPrice.length) warn.push(`<p><b>Без цены</b>: ${E.noPrice.map(esc).join(', ')} — в расходы не вошли. На ноде: <code>sudo bash node-check.sh price 6.5 EUR</code>.</p>`);
  if (E.noRate.length) warn.push(`<p><b>Нет курса</b> для ${E.noRate.map(esc).join(', ')} — такие ноды не посчитаны.</p>`);
  const paidT = E.rows.filter(r => r.p.tbp);
  const nodeT = `<h3 class="u-h3">Ноды<span>цена в месяц и платный трафик за 30 дней</span></h3><div class="table-wrap"><table class="econ-t"><thead><tr><th>Нода</th><th class="n">В месяц</th>
    <th class="n">Трафик за 30 дней</th><th class="n">Входит</th><th class="n">Сверх</th><th class="n">За трафик</th><th class="n">Итого</th></tr></thead><tbody>
    ${E.rows.sort((a, b) => b.total - a.total).map(r => `<tr><td>${esc(r.n.name)}</td><td class="n">${fmt(r.p.v, r.p.v % 1 ? 2 : 0)} ${esc(r.p.cur)}</td>
      <td class="n">${r.p.tbp ? `${r.tb != null ? fmt(r.tb, 1) + ' ТБ' : '—'}<span class="sub">${r.p.dir === 'out' ? 'считается исходящий' : 'вход + выход'}</span>` : r.tx != null ? `${fmt(r.tx, 1)} ТБ<span class="sub">не тарифицируется</span>` : '—'}</td>
      <td class="n">${r.p.tbp ? (r.p.tbi ? `${fmt(r.p.tbi)} ТБ` : 'ничего') : 'безлимит'}</td>
      <td class="n ${r.over > 0 ? 'meh' : ''}">${r.p.tbp ? `${fmt(r.over, 1)} ТБ` : '—'}</td><td class="n">${r.p.tbp ? rub(r.tcost) : '—'}</td><td class="n"><b>${rub(r.total)}</b></td></tr>`).join('')}</tbody></table></div>
    ${paidT.length ? '' : '<p class="note">Нод с платным трафиком не указано. Если хостер берёт за трафик: <code>sudo bash node-check.sh price 6.5 EUR 20 1.5 out</code> — 20 ТБ входит, сверх 1.5 EUR за ТБ, считается только исходящий (both — оба направления).</p>'}`;
  // по тарифам: доход против доли трафика. Расход делим по доле трафика — постоянную цену нод тоже, это упрощение
  const tT = D.tariffs.filter(t => t.paying);
  if (E.traf.fallback) tT.push({id: 'fallback', price: 0, gb: D.fallback.gb, dev: D.fallback.dev, paying: D.fallback.n, mrr: 0, fb: true});
  const tarT = `<h3 class="u-h3">Тарифы<span>${E.measured ? `трафик измерен за ${fmt(Math.min(30, E.hours / 24), 0)} ${plural(Math.round(Math.min(30, E.hours / 24)), 'день', 'дня', 'дней')}` : 'трафик — оценка по среднему с регистрации, точный появится через 3 дня после обновления'}</span></h3>
    <div class="table-wrap"><table class="econ-t"><thead><tr><th>Тариф</th><th class="n">Платят</th><th class="n">Доход</th><th class="n">Трафик в месяц</th>
    <th class="n" title="Доля в доходе / доля в трафике">Доход / трафик</th><th class="n" title="Расходы на ноды, разделённые по доле трафика">Расход</th><th class="n">Остаётся</th><th class="n">На одного</th></tr></thead><tbody>
    ${tT.map(t => { const inc = t.mrr * (1 - E.cfg.fee / 100), sh = E.trafAll ? E.traf[t.id] / E.trafAll : 0, c = E.cost * sh, m = inc - c, inS = E.net ? inc / E.net : 0;
      return `<tr><td><b>${tName(t)}</b><span class="sub">${tDesc(t)}</span></td><td class="n">${fmt(t.paying)}</td><td class="n">${t.price ? rub(inc) : '—'}</td>
        <td class="n">${E.traf[t.id] >= 1000 ? fmt(E.traf[t.id] / 1000, 1) + ' ТБ' : gbS(E.traf[t.id])}<span class="sub">${gbS(t.paying ? E.traf[t.id] / t.paying : null)} на одного</span></td>
        <td class="n ${t.price && sh > inS * 1.5 ? 'meh' : ''}">${t.price ? pctS(inS) : '—'} / ${pctS(sh)}</td><td class="n">${rub(c)}</td>
        <td class="n ${m < 0 ? 'bad' : ''}">${rub(m)}</td><td class="n">${t.paying ? `${rub(m / t.paying)}` : '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
  // выводы
  const tips = [];
  const worst = tT.filter(t => t.price && E.trafAll && E.net).map(t => ({t, r: (E.traf[t.id] / E.trafAll) / ((t.mrr * (1 - E.cfg.fee / 100)) / E.net)})).sort((a, b) => b.r - a.r)[0];
  if (worst && worst.r >= 1.5) tips.push(`<b>${tName(worst.t)}</b> берёт трафика в ${fmt(worst.r, 1)} раза больше, чем приносит денег относительно остальных тарифов.`);
  const tr = tT.find(t => !t.price);
  if (tr && E.trafAll) tips.push(`Пробная стоит ≈${rub(E.cost * E.traf[tr.id] / E.trafAll)} в месяц (${pctS(E.traf[tr.id] / E.trafAll)} трафика)${D.conv?.share != null ? `, в оплату переходит ${pctS(D.conv.share)}` : ''}.`);
  const cheap = paidT.filter(r => r.perTb).sort((a, b) => b.perTb - a.perTb)[0];
  if (cheap) tips.push(`Каждый ТБ сверх включённого на ${esc(cheap.n.name)} стоит ${rub(cheap.perTb)}${E.payN && E.trafAll ? ` — это трафик ≈${fmt(1000 / (E.trafAll / E.payN), 1)} платящих в месяц` : ''}.`);
  if (E.payN && E.net && E.cost) tips.push(`Расходы окупаются с ${fmt(Math.ceil(E.cost / (E.net / E.payN)))} платящих при нынешнем среднем чеке ${rub(E.net / E.payN)}.`);
  return set + kpis + (warn.length ? `<div class="vernote">${warn.join('')}</div>` : '') + (tips.length ? `<div class="adv">${icon('coins')}<div>${tips.map(t => `<p>${t}</p>`).join('')}</div></div>` : '') + tarT + nodeT;
}

function upsHtml(D){
  const L = D.upsell || [], by = {};
  for (const x of L) by[x.tariff] = (by[x.tariff] || 0) + 1;
  const T = Object.fromEntries(D.tariffs.map(t => [t.id, t])), P = paid(D).sort((a, b) => a.price - b.price);
  const next = t => t.gb ? P.find(x => x.price > t.price && (!x.gb || x.gb > t.gb)) : P.find(x => x.price > t.price && x.dev > t.dev);
  const B = D.back || [], back = B.length ? `<h3 class="u-h3">Вернуть<span>раньше платили, подписка кончилась, но ещё заходят на запасном лимите — ${fmt(D.back_n)}</span></h3>
    <div class="table-wrap"><table class="ups-t"><thead><tr><th>Пользователь</th><th class="n">Весь трафик</th><th class="n">Подписка кончилась</th><th class="n">Заходил</th><th></th></tr></thead><tbody>
    ${B.map(x => `<tr><td><b>${esc(x.username)}</b></td><td class="n">${gbS(x.life_gb)}</td><td class="n">${x.since == null ? '—' : x.since < 1 ? 'сегодня' : `${x.since} ${plural(x.since, 'день', 'дня', 'дней')} назад`}</td>
      <td class="n">${x.online_at ? ago(Date.parse(x.online_at) / 1000) : '—'}</td><td><button class="icon-btn" title="Скопировать имя — найти в панели" data-acc-copy="${esc(x.username)}">${icon('copy')}</button></td></tr>`).join('')}</tbody></table></div>
    <p class="note">«Раньше платили» — оценка: весь трафик больше, чем дают пробная и запасной лимит вместе.</p>` : '';
  if (!L.length) return back + `<div class="adv">${icon('shield-check')}<div><b>Пока некому</b><p>Никто из платящих не подошёл к лимиту трафика или устройств.</p></div></div>`;
  const sum = Object.entries(by).map(([id, n]) => { const t = T[id], nx = t && next(t); return t ? `<span class="tag">${tName(t)} → ${nx ? tName(nx) : `+устройство за ${fmt(D.extra_device)} ₽`}: ${fmt(n)}</span>` : ''; }).join(' ');
  return `<div class="acc-head"><span class="muted">${fmt(D.upsell_n)} ${plural(D.upsell_n, 'пользователь', 'пользователя', 'пользователей')} у лимита${D.upsell_n > L.length ? `, показаны первые ${L.length}` : ''}</span><div>${sum}</div></div>
    <div class="table-wrap"><table class="ups-t"><thead><tr><th>Пользователь</th><th>Тариф</th><th>Что случилось</th><th>Предложить</th><th class="n">Подписка кончится</th><th class="n">Заходил</th><th></th></tr></thead><tbody>
    ${L.map(x => { const t = T[x.tariff], nx = t && next(t);
      return `<tr><td><b>${esc(x.username)}</b></td><td>${t ? tName(t) : esc(x.tariff)}</td><td>${esc(x.why)}</td>
        <td>${nx ? `${tName(nx)} <span class="sub">${tDesc(nx)}</span>` : `ещё устройство за ${fmt(D.extra_device)} ₽`}</td>
        <td class="n">${x.days_left == null ? '—' : x.days_left <= 0 ? 'уже' : `через ${x.days_left} ${plural(x.days_left, 'день', 'дня', 'дней')}`}</td>
        <td class="n">${x.online_at ? ago(Date.parse(x.online_at) / 1000) : 'никогда'}</td>
        <td><button class="icon-btn" title="Скопировать имя — найти в панели" data-acc-copy="${esc(x.username)}">${icon('copy')}</button></td></tr>`; }).join('')}</tbody></table></div>` + back;
}

for (const id of ['#econ', '#tar', '#ups']) $(id)?.addEventListener('click', async e => {
  if (e.target.closest('[data-tar-refresh]')) return loadTariffs(true);
  const c = e.target.closest('[data-acc-copy]');
  if (c) { try { await navigator.clipboard.writeText(c.dataset.accCopy); c.innerHTML = icon('check'); setTimeout(() => c.innerHTML = icon('copy'), 1400); } catch { toast('Не скопировалось'); } }
});
$('#econ')?.addEventListener('change', e => {
  const i = e.target.closest('[data-econ]'); if (!i) return;
  const c = econCfg(); c[i.dataset.econ] = Math.max(0, +String(i.value).replace(',', '.') || 0);
  store.set(ECON_KEY, JSON.stringify(c), true); renderUsers();
});

function demoTariffs(){
  const now = Math.floor(Date.now() / 1000), day0 = Math.floor(now / 86400) * 86400;
  const t = (id, price, gb, dev, o) => ({id, price, gb, dev, n: 0, paying: 0, limited: 0, expired: 0, disabled: 0, on24: 0, on7: 0, never: 0, mrr: 0, extra: 0, at80: 0, at100: 0, dev_full: 0,
    exp7: 0, gone30: 0, new30: 0, used_med: null, used_p90: null, used_max: null, used_sum: 0, life_mo_med: null, life_mo_p90: null, life_mo_n: 0, life_mo_avg: null, dev_avg: null, ...o});
  const r = prng(41), arr = f => Array.from({length: 30}, (_, i) => Math.round(f(i) * (.6 + r() * .8)));
  return {at: now - 180, users: 1386, devices: true, extra_device: 100, trial_days: 5, day0,
    skip: {name: 6, forever: 3, names: ['test_ivan', 'bridge-msk', 'probe', 'admin', 'test2', 'monitor']},
    tariffs: [
      t('trial', 0, 8, 1, {n: 610, paying: 94, on24: 61, never: 12, at80: 31, at100: 22, exp7: 94, gone30: 0, new30: 402, used_med: 1.8, used_p90: 5, used_max: 5.1, life_mo_med: 7.5, life_mo_p90: 18, life_mo_avg: 9, dev_avg: 1.6}),
      t('99', 99, 20, 1, {n: 268, paying: 171, on24: 118, never: 3, mrr: 16929, at80: 38, at100: 19, dev_full: 171, exp7: 22, gone30: 31, used_med: 9.4, used_p90: 19.2, used_max: 20.1, life_mo_med: 11, life_mo_p90: 21, life_mo_avg: 12, dev_avg: 1}),
      t('149', 149, 50, 2, {n: 205, paying: 142, on24: 101, never: 2, mrr: 21158, at80: 21, at100: 7, dev_full: 66, exp7: 17, gone30: 18, used_med: 21, used_p90: 46, used_max: 50.3, life_mo_med: 24, life_mo_p90: 49, life_mo_avg: 26, dev_avg: 1.6}),
      t('199', 199, 0, 2, {n: 196, paying: 151, on24: 117, never: 1, mrr: 30049, dev_full: 83, exp7: 19, gone30: 14, used_med: 61, used_p90: 190, used_max: 840, life_mo_med: 48, life_mo_p90: 160, life_mo_avg: 74, dev_avg: 1.7}),
      t('299', 299, 0, 5, {n: 98, paying: 81, on24: 69, mrr: 27919, extra: 14, dev_full: 22, exp7: 8, gone30: 6, used_med: 120, used_p90: 410, used_max: 1900, life_mo_med: 95, life_mo_p90: 300, life_mo_avg: 130, dev_avg: 3.4})],
    other: [{gb: 0, dev: 3, n: 4}, {gb: 10, dev: 1, n: 2}],
    upsell: [
      {username: 'tg_5528104', tariff: '99', why: 'израсходовал 100% из 20 ГБ', share: 1, days_left: 12, online_at: new Date((now - 600) * 1000).toISOString()},
      {username: 'katya_m', tariff: '99', why: 'израсходовал 96% из 20 ГБ', share: .96, days_left: 3, online_at: new Date((now - 7200) * 1000).toISOString()},
      {username: 'tg_9917332', tariff: '149', why: 'израсходовал 88% из 50 ГБ', share: .88, days_left: 20, online_at: new Date((now - 3e4) * 1000).toISOString()},
      {username: 'dmitry_v', tariff: '199', why: 'занял все устройства: 2 из 2', share: null, days_left: 45, online_at: new Date((now - 120) * 1000).toISOString()},
      {username: 'family_k', tariff: '299', why: 'занял все устройства: 5 из 5', share: null, days_left: 160, online_at: new Date((now - 900) * 1000).toISOString()}],
    upsell_n: 5,
    fallback: {n: 412, was_paid: 96, on7: 58, on30: 87, dead: 270, new30: 40, gb: 3, dev: 1},
    old: [{id: 'old_trial5', gb: 5, dev: 0, n: 746, live: 0, on30: 3}, {id: 'old15', gb: 15, dev: 0, n: 131, live: 2, on30: 9}, {id: 'old_trial3', gb: 3, dev: 2, n: 55, live: 0, on30: 0}],
    back: [{username: 'tg_4418210', life_gb: 212, online_at: new Date((now - 3600) * 1000).toISOString(), since: 4}, {username: 'oleg_p', life_gb: 96, online_at: new Date((now - 86400) * 1000).toISOString(), since: 11}],
    back_n: 2,
    conv: {paid: 118, trial: 196, share: .376},
    flow: {new_paid: arr(i => 3 + i / 10), new_trial: arr(i => 9 + i / 6), new_other: arr(() => 0), lost: arr(() => 2.4), trial_end: arr(() => 6)}};
}
function demoTarHist(D){
  const end = Math.floor(Date.now() / 1000), base = {99: 150, 149: 120, 199: 125, 299: 70};
  return {gb: {trial: 840, fallback: 300, 99: 1990, 149: 3600, 199: 11800, 299: 10200}, hours: 400,
    pay: Object.entries(base).map(([id, b]) => ({id, v: Array.from({length: 40}, (_, i) => [end - (39 - i) * 86400, Math.round(b + i * (D.tariffs.find(t => t.id === id).paying - b) / 39)])}))};
}
