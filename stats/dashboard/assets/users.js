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
  const D = tar.data, box = ['#u-hero', '#tar', '#flow', '#econ', '#ups'].map(id => $(id));
  if (!box[1]) return;
  if (tar.busy && !D) { box.forEach((b, i) => b && (b.innerHTML = i ? '<div class="skel skel-table"></div>' : '')); return; }
  if (tar.err) { box.forEach((b, i) => b && (b.innerHTML = i ? '' : `<p class="u-err">${icon('circle-alert')}${esc(tar.err)}</p>`)); return; }
  if (!D) return;
  // полосы вырастают только при первом показе: данные обновляются каждые 2 минуты, иначе всё мигает
  if (tar.drawn) document.body.classList.add('u-still'); else setTimeout(() => { tar.drawn = true; }, 1000);
  box[0].innerHTML = heroHtml(D); box[1].innerHTML = tariffsHtml(D); box[2].innerHTML = flowHtml(D); box[3].innerHTML = econHtml(D); box[4].innerHTML = upsHtml(D);
}

const paid = D => D.tariffs.filter(t => t.price);
const sumA = a => a.reduce((x, y) => x + y, 0);
const how = (lines) => `<details class="u-how"><summary>${icon('info')}Как считается</summary>${lines.map(l => `<p>${l}</p>`).join('')}</details>`;
// оттенки Laser Blue для тарифов: дешёвый — тёмный, дорогой — светлый; пробная — только контур
const T_COL = ['#3242B8', '#465DFF', '#8A9BFF', '#C9D0FF', '#E6E9FF'];
const tColor = (D, t) => { const P = paid(D).sort((a, b) => a.price - b.price), i = P.findIndex(x => x.id === t.id);
  return i < 0 ? 'transparent' : T_COL[Math.min(T_COL.length - 1, Math.round(i * (T_COL.length - 2) / Math.max(1, P.length - 1)))]; };

// справка: подпись с пунктиром — по нажатию (и на телефоне) всплывает, что это и как считается
const HELP = {
  pay: ['Платят сейчас', 'Подписка на платном тарифе (99–299 ₽) действует и не кончилась. Пробная, запасной лимит 3 ГБ, старые тарифы и служебные аккаунты сюда не входят.'],
  mrr: ['Доход в месяц', 'Цена тарифа за месяц у каждого платящего плюс 100 ₽ за каждое докупленное устройство. Кто купил 3, 6 или 12 месяцев со скидкой, на самом деле платит меньше — поэтому «до».'],
  mix: ['Квадраты', 'Каждый квадрат — платящий пользователь (при большой базе — несколько), окрашен по тарифу: чем светлее, тем дороже тариф. Контуром — те, кто сейчас на пробной. Видно, какой тариф держит базу.'],
  new30: ['Новые за 30 дней', 'Аккаунты, созданные в панели за последние 30 дней. «Купили» — у них сейчас платный тариф или они уже платили и ушли на запасной лимит.'],
  lost: ['Не продлили', 'Купленная подписка кончилась за последние 30 дней и до сих пор не продлена. Пробные, которые кончились без покупки, сюда не входят. «На 3 ГБ» — сколько людей сейчас на запасном лимите всего.'],
  conv: ['Пробная → оплата', 'Берём новых за 30 дней, у кого пятидневная пробная уже кончилась, и смотрим, сколько из них купили подписку.'],
  exp7: ['Кончится за неделю', 'Платные подписки, срок которых истекает в ближайшие 7 дней, — им стоит напомнить о продлении.'],
  st: ['Строка состояния', 'Для тарифа с лимитом трафика — сколько людей уже израсходовали весь трафик в текущем периоде. Для безлимита — сколько заняли все разрешённые устройства: им может понадобиться тариф больше.'],
  num: ['Большая цифра', 'Сколько людей сейчас с действующей подпиской на этом тарифе; рядом — сколько это денег в месяц по прайсу.'],
  on: ['Онлайн', 'Какая доля из них подключалась за последние 24 часа. Полоска над цифрами показывает то же самое.'],
  mo: ['В месяц', 'Обычный расход трафика: весь трафик человека, делённый на число месяцев с регистрации. Половина берёт меньше, половина больше. Аккаунты младше недели не считаются.'],
  trialgb: ['За пробную', 'Сколько обычно успевают израсходовать на пробной: половина меньше, половина больше.'],
  dev: ['Устройства', 'Сколько устройств в среднем подключено у одного человека и какой лимит у тарифа.'],
  exp: ['Кончится', 'У скольких подписка кончится в ближайшие 7 дней.'],
  gone: ['Ушли', 'У скольких подписка на этом тарифе кончилась за последние 30 дней и не продлена.'],
  inc: ['Доход в месяц', 'Сумма цен тарифов всех платящих за месяц по прайсу, минус комиссия, если она задана ниже. Скидки за 3–12 месяцев не учтены — это потолок.'],
  cost: ['Расходы на ноды', 'Цена всех нод в месяц (задаётся на ноде командой price) плюс оплата трафика сверх включённого на нодах с платным трафиком — по замерам за 30 дней. Валюта переводится по курсу ниже.'],
  left: ['Остаётся', 'Доход минус расходы на ноды. Другие расходы (домены, бот, реклама) не учтены.'],
  per: ['Платящий', 'Сколько в среднем приносит один платящий в месяц и сколько на него приходится расходов на ноды.'],
  cmp: ['Доход против трафика', 'Синяя полоса — доля тарифа во всём доходе, серая — доля во всём трафике пользователей. Если серая заметно длиннее синей, тариф берёт ресурсов больше, чем приносит. Справа — сколько остаётся с одного человека после его доли расходов.'],
  bought: ['Купили', 'Новые за 30 дней, которые купили подписку: сейчас на платном тарифе или уже платили и ушли на запасной лимит.'],
  only: ['Только пробная', 'Новые за 30 дней, которые пока ничего не купили: сидят на пробной или она кончилась.'],
  payday: ['Платящих по дням', 'Сколько людей с действующей платной подпиской было в каждый день. node-auth записывает это число раз в час.'],
  up: ['Поднять тариф', 'Платящие, которые израсходовали 80% трафика или заняли все устройства. Сначала — упёршиеся в трафик: им это мешает прямо сейчас.'],
  back: ['Вернуть', 'Раньше платили, подписка кончилась, но за последние 30 дней ещё заходили на запасном лимите 3 ГБ. «Раньше платили» — оценка: за всё время скачали больше, чем дают пробная и запасной лимит вместе.'],
  nodes: ['Ноды и цены', 'Цена ноды в месяц и, если хостер берёт за трафик, сколько ТБ входит и сколько стоит каждый ТБ сверх. Сохраняется для всех, кто открывает дашборд. Цена, заданная здесь, важнее той, что задана на ноде командой price.'],
  never: ['Без входа', 'Оплатили, но ни разу не подключились — возможно, не разобрались с настройкой. Таким стоит написать.'],
};
const hl = (k, label = HELP[k][0]) => `<span class="hl" tabindex="0" role="button" data-help="${k}">${label}</span>`;
document.addEventListener('click', e => {
  const tip = $('#u-tip'), h = e.target.closest('[data-help]');
  if (!h) { if (tip && !e.target.closest('#u-tip')) tip.hidden = true; return; }
  const [t, p] = HELP[h.dataset.help] || [];
  if (!t) return;
  let el = tip; if (!el) { el = document.createElement('div'); el.id = 'u-tip'; el.setAttribute('role', 'tooltip'); document.body.append(el); }
  el.innerHTML = `<b>${t}</b><p>${p}</p>`; el.hidden = false;
  const r = h.getBoundingClientRect(), w = Math.min(340, innerWidth - 24);
  el.style.width = w + 'px'; el.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + 'px';
  const below = r.bottom + 8 + el.offsetHeight < innerHeight; el.style.top = (below ? r.bottom + 8 : r.top - el.offsetHeight - 8) + 'px';
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#u-tip')) $('#u-tip').hidden = true; if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-help]')) { e.preventDefault(); e.target.click(); } });
addEventListener('scroll', () => { const t = $('#u-tip'); if (t) t.hidden = true; }, {passive: true});


// шапка раздела — как «Сеть сейчас» на обзоре: одна большая цифра и четыре плитки
function heroHtml(D){
  const P = paid(D), payN = sumA(P.map(t => t.paying)), mrr = sumA(P.map(t => t.mrr)), c = D.conv, F = D.flow;
  const nP = sumA(F.new_paid), nT = sumA(F.new_trial) + sumA(F.new_other), lost = sumA(F.lost), exp7 = sumA(P.map(t => t.exp7));
  const trialN = sumA(D.tariffs.filter(t => !t.price).map(t => t.paying));
  const kpi = (k, v, s) => `<div class="kpi"><div class="k-label">${hl(k)}</div><div class="k-value num">${v}</div><div class="k-sub">${s}</div></div>`;
  const mix = P.filter(t => t.paying).sort((a, b) => a.price - b.price), trialT = D.tariffs.find(t => !t.price);
  // каждый квадрат — платящий (при большой базе — несколько человек), подряд по тарифам; в конце — пробные контуром
  const all = payN + trialN, per = Math.max(1, Math.ceil(all / 900)), C = all / per > 400 ? 50 : 36, Z = 10, G = 3;
  const sq = [];
  for (const t of mix) for (let i = 0; i < Math.round(t.paying / per); i++) sq.push(tColor(D, t));
  for (let i = 0; i < Math.round(trialN / per); i++) sq.push(null);
  const rows = Math.max(1, Math.ceil(sq.length / C));
  const waffle = `<svg class="u-waf" viewBox="0 0 ${C * (Z + G) - G} ${rows * (Z + G) - G}" role="img" aria-label="Платящие по тарифам">${sq.map((c, i) =>
    `<rect x="${(i % C) * (Z + G)}" y="${Math.floor(i / C) * (Z + G)}" width="${Z}" height="${Z}" rx="2" ${c ? `fill="${c}"` : 'class="tri"'} style="animation-delay:${Math.min(900, i * 2)}ms"/>`).join('')}</svg>`;
  const leg = [...mix.map(t => ({c: tColor(D, t), l: tName(t), n: t.paying, sh: t.paying / payN})), ...(trialN ? [{c: null, l: 'Пробная', n: trialN}] : [])];
  return `<div class="u-hero-top"><h1>Пользователи<span>${fmt(D.users)} в панели · ${ago(D.at)}</span></h1>
      <button class="icon-btn" data-tar-refresh title="Пересчитать сейчас"${tar.busy ? ' disabled' : ''}>${icon('refresh-cw', tar.busy ? 'ic spin' : 'ic')}</button></div>
    <div class="u-hm">
      <div class="mega-wrap"><div class="mega">${fmt(payN)}</div><div class="mega-unit">${hl('pay', 'платят сейчас')}<b class="u-mrr">${hl('mrr', `до ${rub(mrr)} в месяц`)}</b></div></div>
      <div class="u-wf">${waffle}
        <div class="u-wl">${leg.map(x => `<div><i${x.c ? ` style="background:${x.c}"` : ' class="tri"'}></i><span>${x.l}</span><b class="num">${fmt(x.n)}</b>${x.sh != null ? `<em>${fmt(x.sh * 100)}%</em>` : ''}</div>`).join('')}</div>
        <p class="u-wn">${hl('mix', `1 квадрат — ${per === 1 ? 'один человек' : `${per} человека`}`)}</p></div>
    </div>
    <div class="kpis">
      ${kpi('new30', `+${fmt(nP + nT)}`, `из них купили ${fmt(nP)}`)}
      ${kpi('lost', fmt(lost), `за 30 дней${D.fallback ? ` · на 3 ГБ ${fmt(D.fallback.n)}` : ''}`)}
      ${kpi('conv', c?.share != null ? `${fmt(c.share * 100)}<small>%</small>` : '—', c ? `${fmt(c.paid)} из ${fmt(c.paid + c.trial)} купили` : '')}
      ${kpi('exp7', fmt(exp7), 'напомнить о продлении')}</div>`;
}

// тарифы — карточки как у нод: название, лимиты, состояние одной строкой, большая цифра, шесть показателей
function tariffsHtml(D){
  const card = t => {
    const share = t.paying ? (t.gb ? t.at100 : t.dev_full) / t.paying : 0, trial = !t.price;
    const st = !t.paying ? {k: 'off', i: 'circle-dashed', t: 'Никого нет'}
      : t.gb && t.at100 ? {k: share >= .1 ? 'warn' : 'ok', i: share >= .1 ? 'triangle-alert' : 'circle-check', t: `${fmt(t.at100)} ${plural(t.at100, 'упёрся', 'упёрлись', 'упёрлись')} в ${fmt(t.gb)} ГБ`}
      : !t.gb && t.dev_full ? {k: 'ok', i: 'smartphone', t: `${fmt(t.dev_full)} заняли все устройства`}
      : {k: 'ok', i: 'circle-check', t: 'Все в пределах лимита'};
    const on = t.paying ? t.on24 / t.paying : null, few = n => t.paying && n / t.paying >= .05;
    return `<article class="node u-card">
      <div class="node-name">${tName(t)}</div><div class="node-sub">${tDesc(t)}</div>
      <div class="state s-${st.k}">${icon(st.i, 'si')}${hl('st', esc(st.t))}</div>
      <div class="node-main"><span class="node-num num">${fmt(t.paying)}</span><span class="node-unit">${hl('num', trial ? 'сейчас на пробной' : `платят · ${rub(t.mrr)}`)}</span></div>
      <div class="u-meter"><i style="width:${(on || 0) * 100}%"></i></div>
      <dl class="node-stats">
        <div><dt>${hl('on')}</dt><dd class="num">${on == null ? '—' : fmt(on * 100) + '%'}</dd></div>
        ${trial ? `<div><dt>${hl('trialgb')}</dt><dd class="num">${gbS(t.used_med)}</dd></div>` : `<div><dt>${hl('mo')}</dt><dd class="num">${gbS(t.life_mo_med)}</dd></div>`}
        <div><dt>${hl('dev')}</dt><dd class="num">${t.dev_avg != null ? `${fmt(t.dev_avg, 1)}<small> из ${t.dev}</small>` : '—'}</dd></div>
        <div><dt>${hl('exp')}</dt><dd class="num ${!trial && t.paying && t.exp7 / t.paying >= .2 ? 'meh' : ''}">${fmt(t.exp7)}</dd></div>
        <div><dt>${hl('gone', trial ? 'Кончились' : 'Ушли')}</dt><dd class="num">${fmt(t.gone30)}</dd></div>
        <div><dt>${hl('never')}</dt><dd class="num ${few(t.never) ? 'meh' : ''}">${fmt(t.never)}</dd></div>
      </dl></article>`;
  };
  const FB = D.fallback, sk = D.skip || {}, skN = (sk.name || 0) + (sk.forever || 0), oldN = sumA((D.old || []).map(o => o.n)), othN = sumA(D.other.map(o => o.n));
  const chip = (l, n) => n ? `<span class="u-chip">${l} <b>${fmt(n)}</b></span>` : '';
  const out = [
    FB?.n && `<p><b>Запасной ${fmt(FB.gb)} ГБ</b> — не оплатили после конца подписки: раньше платили ≈${fmt(FB.was_paid)}, заходили за неделю ${fmt(FB.on7)}, не заходят 3+ месяца ${fmt(FB.dead)}.</p>`,
    oldN && `<p><b>Старые тарифы и пробные</b>: ${D.old.map(o => `${fmt(o.gb)} ГБ${o.dev ? ` на ${o.dev}` : ''} — ${fmt(o.n)}`).join(', ')}.${sumA(D.old.map(o => o.live)) ? ` С действующей подпиской: ${fmt(sumA(D.old.map(o => o.live)))}.` : ''}</p>`,
    othN && `<p><b>Лимиты не узнаны</b>: ${D.other.map(o => `${o.gb ? fmt(o.gb) + ' ГБ' : 'безлимит'} на ${o.dev || '∞'} — ${fmt(o.n)}`).join(', ')}. Если это тариф — добавьте в TARIFFS.</p>`,
    skN && `<p><b>Служебные</b>: ${(sk.names || []).map(esc).join(', ')}${skN > (sk.names || []).length ? '…' : ''}. Правило — USERS_SKIP.</p>`,
    !D.devices && '<p>Панель не отдала устройства — колонка «Устройства» пустая.</p>'].filter(Boolean);
  return `<div class="nodes u-cards">${D.tariffs.map(card).join('')}</div>
    ${out.length ? `<details class="u-out"><summary>Не в расчёте ${chip('запасной', FB?.n)}${chip('старые', oldN)}${chip('служебные', skN)}${chip('не узнаны', othN)}</summary>${out.join('')}</details>` : ''}
    ${how(['Тариф узнаётся по лимитам трафика и устройств (TARIFFS в stats/.env), пробная — ещё и по сроку подписки.',
      'Доход — по прайсу за месяц: купившие 3, 6 или 12 месяцев со скидкой платят меньше, поэтому это потолок.'])}`;
}

// приход и уход по дням: вверх — новые (купили / только пробная), вниз — не продлили
function flowHtml(D){
  const F = D.flow, N = 30, newP = F.new_paid, newT = F.new_trial.map((v, i) => v + F.new_other[i]), lost = F.lost;
  const up = Math.max(1, ...newP.map((v, i) => v + newT[i])), dn = Math.max(1, ...lost);
  const W = 720, H = 240, sc = (H - 26) / (up + dn), mid = up * sc + 2, bw = W / N;
  const day = i => new Date((D.day0 - (N - 1 - i) * 86400) * 1000).toLocaleDateString('ru-RU', {day: 'numeric', month: 'short'});
  const bars = Array.from({length: N}, (_, i) => {
    const x = i * bw + 3, w = bw - 6, a = newP[i] * sc, b = newT[i] * sc, c = lost[i] * sc;
    return `<g><title>${day(i)}: новых ${newP[i] + newT[i]}, купили ${newP[i]}, не продлили ${lost[i]}</title>
      <rect x="${x}" y="${mid - a}" width="${w}" height="${a}" rx="2" class="fl-p"/><rect x="${x}" y="${mid - a - b}" width="${w}" height="${b}" rx="2" class="fl-t"/>
      <rect x="${x}" y="${mid}" width="${w}" height="${c}" rx="2" class="fl-l"/></g>`;
  }).join('');
  const axis = [0, 7, 14, 21, 29].map(i => `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${day(i)}</text>`).join('');
  let hist = '';
  const ph = tar.hist?.pay || [], ids = new Set(paid(D).map(t => t.id)), byT = {};
  for (const s of ph) if (ids.has(s.id)) for (const [t, v] of s.v) byT[t] = (byT[t] || 0) + v;
  const pts = Object.entries(byT).map(([t, v]) => [+t, v]).sort((a, b) => a[0] - b[0]);
  if (pts.length >= 3) {
    const lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])), t0 = pts[0][0], t1 = pts.at(-1)[0];
    const X = t => (t - t0) / Math.max(1, t1 - t0) * (W - 20) + 10, Y = v => 130 - (v - lo) / Math.max(1, hi - lo) * 110, line = pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ');
    hist = `<div class="u-sub"><b>${hl('payday')}</b><span class="num">${fmt(pts[0][1])} → ${fmt(pts.at(-1)[1])}</span></div>
      <svg class="u-line" viewBox="0 0 ${W} 140" preserveAspectRatio="none" role="img" aria-label="Платящих по дням"><polygon points="${X(t0)},140 ${line} ${X(t1)},140"/><polyline points="${line}"/></svg>`;
  }
  const leg = [['fl-p', hl('bought', 'купили'), sumA(newP)], ['fl-t', hl('only', 'только пробная'), sumA(newT)], ['fl-l', hl('lost', 'не продлили'), sumA(lost)]];
  return `<div class="fl-legend">${leg.map(([c, l, n]) => `<span><i class="${c}"></i>${l} <b class="num">${fmt(n)}</b></span>`).join('')}${F.trial_end ? `<span class="muted">пробных кончилось ${fmt(sumA(F.trial_end))}</span>` : ''}</div>
    <svg class="u-flow" viewBox="0 0 ${W} ${H}" role="img" aria-label="Приход и уход по дням">${bars}<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="fl-0"/>${axis}</svg>${hist}
    ${how(['Новый — по дате создания аккаунта. «Купили» — у него платный тариф или он уже платил и ушёл на запасной лимит.',
      'Не продлил — купленная подписка кончилась в этот день и до сих пор не продлена.', pts.length < 3 ? 'График платящих по дням появится через пару дней после обновления.' : ''].filter(Boolean))}`;
}

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

// экономика: три большие цифры, по тарифам — доля дохода против доли трафика, ноды — под катом
function econHtml(D){
  const E = econOf(D), cfg = E.cfg, left = E.net - E.cost;
  const big = (l, v, s, cls = '') => `<div class="u-big"><dt>${l}</dt><dd class="num ${cls}">${v}</dd><span>${s}</span></div>`;
  const top = `<dl class="u-bigs">
    ${big(hl('inc'), rub(E.net), cfg.fee ? `после комиссии ${fmt(cfg.fee, 1)}%` : 'по прайсу, потолок')}
    ${big(hl('cost'), rub(E.cost), E.tcost ? `трафик сверх — ${rub(E.tcost)}` : `${E.rows.length} ${plural(E.rows.length, 'нода', 'ноды', 'нод')} с ценой`)}
    ${big(hl('left'), rub(left), E.net ? `${pctS(left / E.net)} дохода` : '', left < 0 ? 'bad' : '')}
    ${big(hl('per'), E.payN ? rub(E.net / E.payN) : '—', E.payN ? `приносит · стоит ${rub(E.cost / E.payN)}` : '')}</dl>`;
  const tT = D.tariffs.filter(t => t.paying);
  if (E.traf.fallback) tT.push({id: 'fallback', price: 0, gb: D.fallback.gb, dev: D.fallback.dev, paying: D.fallback.n, mrr: 0});
  const rows = tT.map(t => {
    const inc = t.mrr * (1 - cfg.fee / 100), inS = E.net ? inc / E.net : 0, trS = E.trafAll ? E.traf[t.id] / E.trafAll : 0, per = t.paying ? (inc - E.cost * trS) / t.paying : null;
    return `<div class="u-cmp"><div class="u-cn"><b>${tName(t)}</b><span>${fmt(t.paying)}</span></div>
      <div class="u-cb"><div title="Доля в доходе"><i class="inc" style="width:${inS * 100}%"></i><em>${t.price ? pctS(inS) : ''}</em></div>
        <div title="Доля в трафике"><i class="trf${trS > inS * 1.5 && t.price ? ' hot' : ''}" style="width:${trS * 100}%"></i><em>${pctS(trS)}</em></div></div>
      <div class="u-cp num ${per != null && Math.round(per) < 0 ? 'bad' : ''}">${per == null ? '—' : Math.round(per) === 0 ? '0 ₽' : `${per > 0 ? '+' : '−'}${rub(Math.abs(per))}`}</div></div>`;
  }).join('');
  const cmp = `<div class="u-sub"><b>${hl('cmp', 'Тарифы: доход против трафика')}</b><span class="u-key"><i class="inc"></i>доход <i class="trf"></i>трафик · справа — остаётся с одного</span></div><div class="u-cmps">${rows}</div>`;
  const tips = [];
  const worst = tT.filter(t => t.price && E.trafAll && E.net).map(t => ({t, r: (E.traf[t.id] / E.trafAll) / (t.mrr * (1 - cfg.fee / 100) / E.net)})).sort((a, b) => b.r - a.r)[0];
  if (worst && worst.r >= 1.5) tips.push(['triangle-alert', `${tName(worst.t)} берёт трафика в ${fmt(worst.r, 1)} раза больше, чем приносит денег`]);
  const tr = tT.find(t => !t.price && t.id !== 'fallback');
  if (tr && E.trafAll) tips.push(['coins', `Пробная стоит ≈${rub(E.cost * E.traf[tr.id] / E.trafAll)} в месяц`]);
  if (E.payN && E.net && E.cost) tips.push(['trending-up', `Окупаемость — с ${fmt(Math.ceil(E.cost / (E.net / E.payN)))} платящих`]);
  const warn = [E.noPrice.length && `без цены: ${E.noPrice.map(esc).join(', ')}`, E.noRate.length && `нет курса ${E.noRate.map(esc).join(', ')}`].filter(Boolean);
  const inp = (k, l, step) => `<label class="u-in"><span>${l}</span><input type="number" min="0" step="${step}" value="${cfg[k]}" data-econ="${k}"></label>`;
  // ноды и цены — редактируются прямо здесь: цена в месяц и платный трафик; сохраняется в VictoriaMetrics через node-auth
  const ALL = Object.values(state.model?.nodes || {}).filter(n => n.seen != null).sort((a, b) => a.name.localeCompare(b.name));
  const R = Object.fromEntries(E.rows.map(r => [r.n.key, r]));
  const cur = c => ['EUR', 'USD', 'RUB'].map(x => `<option${x === c ? ' selected' : ''}>${x}</option>`).join('');
  const nrow = n => { const p = n.price || {}, r = R[n.key], paidT = !!p.tbp;
    return `<form class="u-np" data-price="${esc(n.host || n.name)}" data-key="${esc(n.key)}">
      <div class="u-npn"><b>${esc(n.name)}</b><span>${r ? `${rub(r.total)} в месяц${r.tcost ? ` · трафик ${rub(r.tcost)}` : ''}` : 'цена не задана'}${p.src && p.src !== 'dash' ? '' : ''}</span></div>
      <label class="u-f"><span>Цена в месяц</span><span class="u-fi"><input name="price" inputmode="decimal" value="${p.v ?? ''}" placeholder="0"><select name="cur">${cur(p.cur || 'EUR')}</select></span></label>
      <label class="u-f"><span>Трафик</span><select name="mode"><option value="free"${paidT ? '' : ' selected'}>безлимитный</option><option value="paid"${paidT ? ' selected' : ''}>платный</option></select></label>
      <label class="u-f u-pt"${paidT ? '' : ' hidden'}><span>Входит, ТБ</span><input name="tb_incl" inputmode="decimal" value="${p.tbi ?? 0}"></label>
      <label class="u-f u-pt"${paidT ? '' : ' hidden'}><span>ТБ сверх</span><input name="tb_price" inputmode="decimal" value="${p.tbp ?? ''}" placeholder="1.5"></label>
      <label class="u-f u-pt"${paidT ? '' : ' hidden'}><span>Считает</span><select name="dir"><option value="out"${p.dir === 'out' ? ' selected' : ''}>исходящий</option><option value="both"${p.dir !== 'out' ? ' selected' : ''}>вход + выход</option></select></label>
      <div class="u-npt">${r?.tb != null ? `<b class="num">${fmt(r.tb, 1)} ТБ</b><span>за 30 дней${r.over > 0 ? ` · сверх ${fmt(r.over, 1)}` : ''}</span>` : r?.tx != null ? `<b class="num">${fmt(r.tx, 1)} ТБ</b><span>отдано за 30 дней</span>` : ''}</div>
      <button class="pill u-save" type="submit" disabled>Сохранить</button></form>`; };
  const nodes = `<div class="u-sub"><b>${hl('nodes', 'Ноды и цены')}</b>${warn.length ? `<span class="u-chip warn">${warn.join(' · ')}</span>` : ''}</div><div class="u-nps">${ALL.map(nrow).join('')}</div>`;
  return top + (tips.length ? `<div class="u-tips">${tips.map(([i, t]) => `<span>${icon(i)}${t}</span>`).join('')}</div>` : '') + cmp +
    `<div class="u-cfg">${inp('EUR', '€, ₽', '0.5')}${inp('USD', '$, ₽', '0.5')}${inp('fee', 'Комиссия, %', '0.5')}</div>` + nodes +
    how([`Расходы — цена нод в месяц плюс трафик сверх включённого за 30 дней. Расход тарифа — его доля трафика во всех расходах.`,
      E.measured ? `Трафик тарифов измерен за ${fmt(Math.min(30, E.hours / 24))} дн.` : 'Трафик тарифов пока оценка по среднему с регистрации — замер появится через 3 дня после обновления.',
      'Курс и комиссия хранятся в этом браузере.']);
}

// продажи: кому поднять тариф и кого вернуть — два списка
function upsHtml(D){
  const T = Object.fromEntries(D.tariffs.map(t => [t.id, t])), P = paid(D).sort((a, b) => a.price - b.price);
  const next = t => t.gb ? P.find(x => x.price > t.price && (!x.gb || x.gb > t.gb)) : P.find(x => x.price > t.price && x.dev > t.dev);
  const copy = u => `<button class="icon-btn" title="Скопировать имя" data-acc-copy="${esc(u)}">${icon('copy')}</button>`;
  const lim = 12, more = (k, n) => n > lim && !tar.all?.[k] ? `<button class="pill u-more" data-u-all="${k}">Ещё ${fmt(n - lim)}</button>` : '';
  const U = D.upsell || [], B = D.back || [];
  const up = U.slice(0, tar.all?.up ? 80 : lim).map(x => { const t = T[x.tariff], nx = t && next(t);
    return `<li><div><b>${esc(x.username)}</b><span>${esc(x.why)}${x.online_at ? ` · ${ago(Date.parse(x.online_at) / 1000)}` : ''}</span></div>
      <span class="u-to">${t ? tName(t) : ''} → ${nx ? tName(nx) : `+устройство`}</span>${copy(x.username)}</li>`; }).join('');
  const bk = B.slice(0, tar.all?.back ? 80 : lim).map(x => `<li><div><b>${esc(x.username)}</b><span>${x.since != null ? `ушёл ${x.since < 1 ? 'сегодня' : `${x.since} ${plural(x.since, 'день', 'дня', 'дней')} назад`} · ` : ''}${gbS(x.life_gb)} за всё время</span></div>
      <span class="u-to">${x.online_at ? ago(Date.parse(x.online_at) / 1000) : ''}</span>${copy(x.username)}</li>`).join('');
  const col = (ic, h, n, sub, body, k) => `<div class="u-list"><div class="u-lh">${icon(ic)}<b>${hl(k, h)}</b><span class="num">${fmt(n)}</span></div><p>${sub}</p>
    ${body ? `<ul>${body}</ul>${more(k, Math.min(n, 80))}` : '<p class="u-empty">Пока никого</p>'}</div>`;
  return `<div class="u-lists">${col('trending-up', 'Поднять тариф', D.upsell_n || 0, 'Израсходовали 80% трафика или заняли все устройства', up, 'up')}
    ${col('refresh-cw', 'Вернуть', D.back_n || 0, 'Платили, не продлили, но ещё заходят на запасном лимите', bk, 'back')}</div>`;
}

$('#u-hero')?.addEventListener('click', e => { if (e.target.closest('[data-tar-refresh]')) loadTariffs(true); });
for (const id of ['#econ', '#tar', '#ups']) $(id)?.addEventListener('click', async e => {
  const a = e.target.closest('[data-u-all]'); if (a) { (tar.all ||= {})[a.dataset.uAll] = true; return renderUsers(); }
  const c = e.target.closest('[data-acc-copy]');
  if (c) { try { await navigator.clipboard.writeText(c.dataset.accCopy); c.innerHTML = icon('check'); setTimeout(() => c.innerHTML = icon('copy'), 1400); } catch { toast('Не скопировалось'); } }
});
$('#econ')?.addEventListener('input', e => { const f = e.target.closest('form[data-price]'); if (f) f.querySelector('.u-save').disabled = false; });
$('#econ')?.addEventListener('submit', async e => {
  const f = e.target.closest('form[data-price]'); if (!f) return; e.preventDefault();
  const v = k => f.elements[k]?.value, num = k => +String(v(k) || '0').replace(',', '.') || 0, paidT = v('mode') === 'paid';
  const body = {node: f.dataset.price, price: num('price'), cur: v('cur'), tb_incl: paidT ? num('tb_incl') : 0, tb_price: paidT ? num('tb_price') : 0, dir: v('dir')};
  const b = f.querySelector('.u-save'); b.disabled = true; b.textContent = 'Сохраняю…';
  try {
    if (!DEMO) { const r = await auth('price', body); if (r.status === 401) throw new Error('войдите заново'); if (r.status !== 204) throw new Error('HTTP ' + r.status + (r.status === 404 ? ' — обновите node-auth' : '')); }
    const n = state.model.nodes[f.dataset.key];
    n.price = body.price > 0 ? {v: body.price, cur: body.cur, src: 'dash', ...(body.tb_price > 0 ? {tbp: body.tb_price, tbi: body.tb_incl, dir: body.dir} : {})} : null;
    toast(body.price > 0 ? `Цена ${n.name} сохранена` : `Цена ${n.name} убрана`); renderUsers();
  } catch (err) { b.disabled = false; b.textContent = 'Сохранить'; toast('Не сохранилось: ' + err.message); }
});
$('#econ')?.addEventListener('change', e => {
  const m = e.target.closest('select[name="mode"]'); if (m) { m.form.querySelectorAll('.u-pt').forEach(x => x.hidden = m.value !== 'paid'); return; }
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
      t('trial', 0, 8, 1, {n: 610, paying: 94, on24: 61, never: 12, at80: 31, at100: 22, exp7: 94, gone30: 0, new30: 402, used_med: 1.8, used_p90: 5, used_max: 5.1, life_mo_med: 7.5, life_mo_p90: 18, life_mo_avg: 9, dev_avg: 1}),
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
