'use strict';
// Панель ноды по нажатию на карточку

/* ---------- карточка ноды ---------- */
// Порядок чтения: вердикт → три главные цифры → полоски нагрузки и сети → один график → полная проверка → справка
const DR_METRICS = ['tx', 'conns', 'cpu', 'st', 'retr', 'rtt'];
// шкала полосок: max — правый край; пороги берутся из TH
const BAR = {cpu: 100, st: 30, xcpu: 100, mem: 100, ct: 100, rtt: 150, jit: 30, loss: 5, retr: 10};
const HINT = {
  retr: 'Пакеты теряются по пути к пользователям. Сравните пик и тишину: node-check.sh report, и маршрут: mtr до РФ.',
  loss: 'Пинг теряет пакеты. Посмотрите mtr до РФ, на каком участке начинаются потери.',
  st: 'Соседи по хосту забирают процессор. Напишите хостеру или переезжайте.',
  cpu: 'Процессор на пределе. Снимите часть пользователей или возьмите тариф мощнее.',
  ct: 'Таблица соединений почти полна, новые подключения начнут отбрасываться. Поднимите nf_conntrack_max.',
  mem: 'Память на исходе. Проверьте Xray и swap.',
  util: 'Канал почти забит. Нужна ещё одна нода рядом.',
};
const slug = s => cleanName(s).replace(/\s+/g, '-');
function openNode(key, push = true){
  const n = state.model?.nodes[key]; if (!n) return;
  if (state.open !== key) { state.drSeries = null; state.drMetric ||= 'tx'; }
  state.open = key;
  if (push && location.hash !== '#node=' + encodeURIComponent(slug(n.name))) history.replaceState(null, '', '#node=' + encodeURIComponent(slug(n.name)));
  $('#drawer').hidden = false; document.body.classList.add('locked');
  renderDrawer(); $('#dr-panel').focus({preventScroll: true});
  if (n.seen != null) (DEMO ? Promise.resolve(demoNodeSeries(n)) : loadNodeSeries(n, state.range)).then(s => { if (state.open === key) { state.drSeries = s; renderDrawerChart(); } }).catch(e => toast('Графики ноды не загрузились: ' + e.message));
}
function closeNode(){
  state.open = null; state.drSeries = null; $('#drawer').hidden = true; document.body.classList.remove('locked');
  if (location.hash.startsWith('#node=')) history.replaceState(null, '', location.pathname + location.search);
}
function demoNodeSeries(n){ const end = Math.floor(Date.now() / 1000); return {end, data: Object.fromEntries(DR_METRICS.map(k => [k, remapOne(demoSeriesFor(k, state.range, end, n.hosts), n.hosts)]))}; }

// полоска: длина — значение, фон — зоны «норма / замечание / плохо», цвет заливки — уровень
function bar(label, k, val, dec, unit, max, sub, lv){
  const T = TH[k], l = lv ?? lvl(k, val), pc = v => Math.max(0, Math.min(100, v / max * 100));
  const zones = T ? `<span class="z" style="left:${pc(T.w)}%;width:${pc(T.b) - pc(T.w)}%;--c:var(--warn)"></span><span class="z" style="left:${pc(T.b)}%;right:0;--c:var(--err)"></span>` : '';
  const ok = val != null && isFinite(val);
  return `<div class="brow lv${l}"><span class="bl">${label}${sub ? `<small>${sub}</small>` : ''}</span>
    <span class="bt" aria-hidden="true">${zones}${ok ? `<span class="bf" style="width:${Math.max(1.5, pc(val))}%"></span>` : ''}</span>
    <span class="bv num">${ok ? fmt(val, dec) + `<small>${unit}</small>` : '—'}</span></div>`;
}
// пункт полной проверки: точка-оценка, что проверяли, результат
function check(label, val, unit, good, bad, up = true){
  if (val == null || !isFinite(val)) return '';
  const k = good == null ? 'off' : up ? (val >= good ? 'ok' : val >= bad ? 'warn' : 'err') : (val <= good ? 'ok' : val <= bad ? 'warn' : 'err');
  return `<li class="s-${k}"><span>${label}</span><b class="num">${fmt(val)}${unit ? `<small>${unit}</small>` : ''}</b></li>`;
}
function renderDrawer(){
  const n = state.model.nodes[state.open], s = state.st[state.open], p = n.panel, f = n.full;
  let html = `<div class="dr-head"><div><h2 class="dr-name" id="dr-name">${esc(n.name)}</h2><div class="node-sub">${flag(n.cc)}${esc(subLine(n))}${n.bridge ? ', мост' : ''}</div></div>
    <button class="icon-btn" id="dr-close" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>`;

  // 1. вердикт: что не так и что делать; если всё хорошо — одна зелёная строка
  const issues = Object.keys(TH).map(k => ({k, l: lvlN(n, k)})).filter(x => x.l).sort((a, b) => b.l - a.l);
  const plural = x => x === 1 ? 'проблема' : x < 5 ? 'проблемы' : 'проблем', fromTH = issues.length && ['ok', 'warn', 'err'].includes(s.cat);
  const vk = s.k, head = s.k === 'ok' ? 'Всё в норме' : fromTH ? `${s.k === 'err' ? 'Плохо' : 'Есть замечания'}: ${issues.length} ${plural(issues.length)}` : s.t[0].toUpperCase() + s.t.slice(1);
  html += `<div class="verdict s-${vk}"><div class="vh"><b>${esc(head)}</b><span>${n.seen ? (s.stale ? 'последний снимок ' + ago(n.seen) : 'снимок ' + ago(n.seen)) : ''}</span></div>`;
  if (s.cat === 'silent') html += `<p>Нода не присылает снимки. Значения ниже — на ${when(n.seen)}. Проверьте, жива ли нода и работает ли cron node-check.</p>`;
  else if (p?.connected === 0 && p?.disabled !== 1) html += '<p>remnanode не отвечает панели: нода лежит, забанен IP или закрыт порт панели.</p>';
  else if (n.seen == null && p?.disabled !== 1) html += '<p>Сбор статистики не настроен. На ноде: <code>sudo bash node-check.sh</code>, пункты 6 и 5.</p>';
  if (issues.length && s.cat !== 'silent') html += '<ul>' + issues.map(({k, l}) => { const T = TH[k];
    return `<li class="s-${l === 2 ? 'err' : 'warn'}"><div><b>${T.label[0].toUpperCase() + T.label.slice(1)} ${fmt(n[k], T.dec)}${T.unit}</b> <span class="lim">норма до ${fmt(T.w, T.w % 1 ? 1 : 0)}${T.unit}</span><br>${HINT[k]}</div></li>`; }).join('') + '</ul>';
  html += '</div>';

  if (n.seen != null) {
    // 2. три главные цифры
    const ub = n.util != null ? `<span class="ubar ${cls('util', n.util)}"><span style="width:${Math.min(100, n.util)}%"></span></span><span class="tsub">канал занят на ${fmt(n.util)}% из ${fmt(f.ip)} Мбит/с</span>` : '<span class="tsub">загрузку канала покажет полная проверка</span>';
    html += `<div class="tiles${s.stale ? ' stale' : ''}">
      <div class="tile"><span class="tl">Трафик к юзерам</span><span class="tv num">${fmt(n.tx, n.tx >= 100 ? 0 : 1)}<small>Мбит/с</small></span>${ub}</div>
      <div class="tile"><span class="tl">Онлайн</span><span class="tv num">${p?.users != null ? fmt(p.users) : fmt(n.conns)}<small>${p?.users != null ? 'чел.' : 'соед.'}</small></span><span class="tsub">${p?.users != null ? `соединений ${fmt(n.conns)}` : 'онлайна из панели нет'}</span></div>
      <div class="tile"><span class="tl">Доступность</span><span class="tv num">${fu(n.up24, n.up24 >= 99.95 ? 0 : 1, '')}<small>% за сутки</small></span><span class="tsub">${n.up30 != null ? `за 30 дней ${fmt(n.up30, 1)}%` : ''}</span></div>
    </div>`;
    // 3. полоски: читаются по длине и цвету, цифры — для точности
    const to = n.to === 'eu' ? 'ЕС' : 'РФ';
    html += `<div class="dr-cols${s.stale ? ' stale' : ''}">
      <section><h3>Сервер</h3>${bar('CPU', 'cpu', n.cpu, 0, '%', BAR.cpu)}${bar('Steal', 'st', n.st, 0, '%', BAR.st, 'забирают соседи')}${bar('Xray', 'xcpu', n.xcpu, 0, '%', BAR.xcpu, 'из CPU')}${bar('Память', 'mem', n.mem, 0, '%', BAR.mem)}${bar('Conntrack', 'ct', n.ct, 0, '%', BAR.ct, 'таблица соединений')}</section>
      <section><h3>Сеть</h3>${bar('Пинг до ' + to, 'rtt', n.rtt, 0, 'мс', BAR.rtt)}${bar('Джиттер', 'jit', n.jit, 1, 'мс', BAR.jit, 'разброс пинга')}${bar('Потери', 'loss', n.loss, 1, '%', BAR.loss)}${bar('Ретрансмиты', 'retr', n.retr, 1, '%', BAR.retr, n.tx >= RETR_MIN_TX ? 'повторные пакеты' : 'трафик мал, не считаем', lvlN(n, 'retr'))}</section>
    </div>
    <p class="legend-z"><span class="lz w"></span>замечание <span class="lz b"></span>плохо — те же пороги, что в алертах</p>`;
    // 4. один график, метрика — вкладками
    html += `<div class="dr-sec"><div class="dr-sec-head"><h3>Динамика<span>${RANGES[state.range].label}</span></h3>
      <div class="seg" id="dr-metric" role="group" aria-label="Метрика ноды"><span class="thumb"></span>${DR_METRICS.map(k => `<button data-v="${k}" aria-pressed="${k === state.drMetric}">${METRICS[k].label}</button>`).join('')}</div></div>
      <div class="chart" id="dr-chart"><p class="empty">Загружаю</p></div></div>`;
  }
  // 5. полная проверка: точка — оценка, без таблицы
  if (f) {
    const ru = n.cc === 'RU' || n.bridge;
    html += `<div class="dr-sec"><h3>Полная проверка<span>${ago(f.at)}</span></h3><ul class="checks">
      ${check('Процессор, одно ядро', f.cpu, ' ev/s', 1000, 700)}${check('Все ядра вместе', f.mt, ' ev/s', null)}${check('Ядра реально работают', f.sc, '%', 85, 60)}
      ${check('Steal под нагрузкой', f.st, '%', 5, 15, false)}${check('Канал до РФ (iperf)', f.ip, ' Мбит/с', 200, 80)}
      ${ru ? check('Скачивание из Европы', f.eu, ' Мбит/с', 200, 80) + check('Заморозки TLS на 16–20 КБ', f.fr, '', 0, 0, false) + check('Сайтов режет DPI', f.dpi, '', 0, 2, false) : ''}
      ${check('Замечаний node-check', f.pr, '', 0, 2, false)}
    </ul></div>`;
  }
  // 6. справка — свёрнута
  html += `<details class="dr-sec more"><summary>Справка: IP, имена, хостер</summary><dl class="kv">
    ${p ? `<dt>В панели</dt><dd>${esc(cleanName(p.name))}, ${p.disabled === 1 ? 'отключена' : p.connected === 1 ? 'на связи' : 'панель не видит'}</dd><dt>IP</dt><dd>${[...p.ips].filter(x => x && x !== '-').map(esc).join(', ') || '—'}</dd>` : '<dt>В панели</dt><dd>нет</dd>'}
    ${n.hosts.length ? `<dt>Имя в node-check</dt><dd>${n.hosts.map(esc).join(', ')}</dd>` : ''}
    <dt>Хостер</dt><dd>${esc(hosterOf(n.name))}</dd>
    ${n.rx != null ? `<dt>От пользователей</dt><dd>${fmt(n.rx, 1)} Мбит/с</dd>` : ''}
    ${n.load != null ? `<dt>Load за минуту</dt><dd>${fmt(n.load, 2)}</dd>` : ''}
  </dl></details>`;
  $('#dr-panel').innerHTML = html;
  const seg = $('#dr-metric');
  if (seg) { moveThumb(seg); bindSeg(seg, v => { state.drMetric = v; renderDrawerChart(); }); }
  if (state.drSeries) renderDrawerChart();
}
function renderDrawerChart(){
  const w = $('#dr-chart'); if (!w || !state.drSeries) return;
  const S = state.drSeries, k = state.drMetric, c = SCOL[state.st[state.open].k], data = {x: S.data[k] || []};
  lineChart(w, {data, names: data.x.length ? ['x'] : [], M: METRICS[k], rangeKey: state.range, t1: S.end, color: () => c, label: () => METRICS[k].label, compact: true, th: TH[k]});
}

function renderAll(){
  const N = state.model.nodes, now = state.model.end;
  state.st = Object.fromEntries(Object.keys(N).map(k => [k, status(N[k], now)]));
  // порядок не зависит от цифр, иначе карточки переставляются при каждом обновлении: по имени; молчащие и отключённые — в конце
  const rank = k => ({off: 2, silent: 1}[state.st[k].cat] || 0);
  state.order = Object.keys(N).sort((a, b) => rank(a) - rank(b) || N[a].name.localeCompare(N[b].name, 'ru', {numeric: true}));
  renderHero(); renderNodes(); renderDay(); renderChart(); renderHeat(); renderFull(); renderHosters();
  if (state.open && N[state.open]) renderDrawer();
  const seen = Object.values(N).filter(n => n.seen && now - n.seen < 1800).map(n => n.seen), next = seen.length ? Math.max(...seen) + SNAP : null;
  $('#updated').innerHTML = DEMO ? '<span class="demo">Демо-данные</span>' : `Обновлено в ${hhmm(Date.now() / 1000)}${next && next > Date.now() / 1000 ? `<span style="opacity:.7"> · следующий снимок около ${hhmm(next)}</span>` : ''}`;
  state.first = false;
  if (!state.routed) { state.routed = true; route(); }
}
function route(){
  const m = location.hash.match(/^#node=(.+)$/); if (!m || !state.model) return;
  const want = decodeURIComponent(m[1]).toLowerCase(), hit = Object.values(state.model.nodes).find(n => slug(n.name).toLowerCase() === want);
  if (hit && state.open !== hit.key) openNode(hit.key, false);
}
