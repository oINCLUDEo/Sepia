'use strict';
// Общее: утилиты, справочники, пороги, состояние страницы

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (v, d = 0) => (v == null || !isFinite(v)) ? '—' : Number(v).toLocaleString('ru-RU', {minimumFractionDigits: d, maximumFractionDigits: d});
const fu = (v, d, unit) => v == null || !isFinite(v) ? '—' : fmt(v, d) + unit;   // значение с единицей, без «—%»
const store = {
  get(k){ try { return sessionStorage.getItem(k) ?? localStorage.getItem(k); } catch { return null; } },
  set(k, v, keep){ try { (keep ? localStorage : sessionStorage).setItem(k, v); } catch {} },
  del(k){ try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch {} },
};

// API приёмника: страница живёт в <prefix>/dash/, VictoriaMetrics — в <prefix>/api/v1/. С диска — демо.
const API_BASE = (() => { const i = location.pathname.indexOf('/dash'); return /^https?:$/.test(location.protocol) && i > 0 ? location.pathname.slice(0, i) : null; })();
const DEMO = !API_BASE || location.hash === '#demo';
const SNAP = 900;   // node-check шлёт снимок раз в 15 минут

const RANGES = {
  '24h': {sec: 86400,   step: 900,   label: 'за сутки'},
  '7d':  {sec: 604800,  step: 3600,  label: 'за неделю'},
  '30d': {sec: 2592000, step: 10800, label: 'за месяц'},
};
const METRICS = {
  tx:    {label: 'Трафик',      unit: 'Мбит/с', expr: 'node_quick_tx_mbps', dec: 1},
  conns: {label: 'Соединения',  unit: '',       expr: 'node_quick_conns', dec: 0},
  cpu:   {label: 'CPU',         unit: '%',      expr: 'node_quick_cpu_us + node_quick_cpu_sy', dec: 0},
  st:    {label: 'Steal',       unit: '%',      expr: 'node_quick_cpu_st', dec: 0},
  rtt:   {label: 'Пинг',        unit: 'мс',     expr: 'node_quick_rtt_ms', dec: 0},
  loss:  {label: 'Потери',      unit: '%',      expr: 'node_quick_loss_pct', dec: 1},
  retr:  {label: 'Ретрансмиты', unit: '%',      expr: 'node_quick_retrans_pct', dec: 2},
};
// Пороги: [замечание, плохо]. Одна таблица на карточки, статус, таблицы и алерты (stats/alerts.yml — те же «плохо»).
const TH = {
  retr: {w: 2,  b: 5,  label: 'ретрансмиты', unit: '%', dec: 1},
  loss: {w: .5, b: 2,  label: 'потери',      unit: '%', dec: 1},
  st:   {w: 5,  b: 15, label: 'steal',       unit: '%', dec: 0},
  cpu:  {w: 80, b: 90, label: 'CPU',         unit: '%', dec: 0},
  ct:   {w: 70, b: 90, label: 'conntrack',   unit: '%', dec: 0},
  mem:  {w: 80, b: 92, label: 'память',      unit: '%', dec: 0},
  util: {w: 70, b: 90, label: 'канал занят', unit: '%', dec: 0},
};
const lvl = (k, v) => v == null || !isFinite(v) || !TH[k] ? 0 : v > TH[k].b ? 2 : v > TH[k].w ? 1 : 0;
// уровень метрики ноды: ретрансмиты при трафике меньше 1 Мбит/с не считаем — пара потерянных пакетов даёт десятки процентов
const RETR_MIN_TX = 1;
const lvlN = (n, k) => k === 'retr' && !(n.tx >= RETR_MIN_TX) ? 0 : lvl(k, n[k]);
const clsN = (n, k) => ['', 'meh', 'bad'][lvlN(n, k)];
const cls = (k, v) => ['', 'meh', 'bad'][lvl(k, v)];
const COUNTRY = {RU:'Россия', SE:'Швеция', EE:'Эстония', NL:'Нидерланды', DE:'Германия', FI:'Финляндия', AT:'Австрия', KZ:'Казахстан', FR:'Франция', PL:'Польша', LV:'Латвия', LT:'Литва', TR:'Турция', US:'США', GB:'Великобритания', CH:'Швейцария', CZ:'Чехия', MD:'Молдова', AE:'ОАЭ', BG:'Болгария', RO:'Румыния', IT:'Италия', ES:'Испания', NO:'Норвегия', DK:'Дания', HK:'Гонконг', SG:'Сингапур', JP:'Япония', CA:'Канада', GE:'Грузия', AM:'Армения', HU:'Венгрия', IS:'Исландия', IL:'Израиль', PT:'Португалия', BE:'Бельгия', LU:'Люксембург', SK:'Словакия', SI:'Словения', HR:'Хорватия', GR:'Греция', CY:'Кипр', IE:'Ирландия'};
const FLAGS = new Set('ae am at au be bg by ca ch cy cz de dk ee es fi fr gb ge gr hk hr hu ie il in is it jp kr kz lt lu lv md mt nl no pl pt ro ru se sg si sk tr ua us'.split(' '));
const PALETTE = ['#465DFF', '#9AA8FF', '#5FD0FF', '#C9C9CE', '#B58CFF', '#FFB36B', '#4CD69B', '#FF7A9A'];

const state = {range: '24h', metric: 'tx', view: store.get('ulya-stats-view') || 'cards', filter: null, hidden: new Set(), order: [], model: null, series: null,
  authed: false, first: true, open: null, loadedAt: 0};
const colorOf = n => {
  const c = PALETTE[Math.max(0, state.order.indexOf(n)) % PALETTE.length];
  return c === '#C9C9CE' && document.documentElement.dataset.theme === 'light' ? '#6E6E73' : c;   // светлый серый теряется на белом
};
const nm = k => state.model?.nodes[k]?.name || k;   // ключ ноды (uuid панели или h:hostname) -> отображаемое имя
