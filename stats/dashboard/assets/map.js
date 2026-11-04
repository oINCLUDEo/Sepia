'use strict';
// География: где стоят ноды и куда ведут мосты. Спокойная карта: суша — ровная сетка одинаковых точек одного тона,
// море не рисуем; ноды — квадратики (размер — онлайн, цвет — состояние), от мостов в РФ к странам выходов — тонкие
// линии фирменного синего, толщина — по трафику выходов. Цвета — из темы. Статично: перерисовка при новых данных.

const KX = Math.cos(53 * Math.PI / 180);   // равнопромежуточная проекция с поправкой на широту Европы
let mapHits = [];

function renderMap(){
  const cv = $('#map'); if (!cv || !state.model) return;
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  const dpr = Math.min(2, devicePixelRatio || 1), ctx = cv.getContext('2d');
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
  const INK = col('--ink'), MUTED = col('--muted'), ACC = col('--spark'), ST = {ok: INK, warn: col('--warn'), err: col('--err'), off: MUTED};
  const narrow = W < 640;
  // окно: долготы −11…60, широты 35…70 — Европа и запад России целиком
  const lon0 = -11, lon1 = 60, lat0 = 35, lat1 = 70.5;
  const s = Math.min(W / ((lon1 - lon0) * KX), H / (lat1 - lat0)), ox = (W - (lon1 - lon0) * KX * s) / 2, oy = (H - (lat1 - lat0) * s) / 2;
  const P = (lon, lat) => [ox + (lon - lon0) * KX * s, oy + (lat1 - lat) * s];
  const inv = (x, y) => [lon0 + (x - ox) / (KX * s), lat1 - (y - oy) / s];

  // суша: сетка точек; береговые чуть крупнее и ярче — контур читается без заливки
  const g = narrow ? 5 : 6, cols = Math.ceil(W / g), rows = Math.ceil(H / g), land = [];
  for (let y = 0; y < rows; y++) { land[y] = []; for (let x = 0; x < cols; x++) land[y][x] = isLand(...inv(x * g + g / 2, y * g + g / 2)); }
  ctx.fillStyle = MUTED;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (!land[y][x]) continue;
    const coast = !land[y - 1]?.[x] || !land[y + 1]?.[x] || !land[y][x - 1] || !land[y][x + 1], q = coast ? 2 : 1.4;
    ctx.globalAlpha = coast ? .55 : .26;
    ctx.fillRect(x * g + g / 2 - q / 2, y * g + g / 2 - q / 2, q, q);
  }
  ctx.globalAlpha = 1;

  // ноды по странам
  const by = {}, extra = {};
  for (const n of Object.values(state.model.nodes)) {
    if (state.st[n.key]?.cat === 'off') continue;
    const cc = (n.cc || '').toUpperCase();
    if (GEO[cc]) (by[cc] ||= []).push(n); else if (cc) extra[cc] = (extra[cc] || 0) + 1;
  }
  const sev = n => ({err: 3, warn: 2, ok: 1}[state.st[n.key].k] || 0);
  const groups = Object.entries(by).map(([cc, list]) => {
    const [x, y] = P(...GEO[cc]), worst = list.reduce((a, n) => sev(n) > sev(a) ? n : a, list[0]);
    const silent = list.every(n => state.st[n.key].cat === 'silent');
    return {cc, list, x, y, users: list.reduce((a, n) => a + (n.panel?.users || 0), 0), tx: list.reduce((a, n) => a + (isOnline(n, state.model.end) ? n.tx || 0 : 0), 0),
      k: silent ? 'off' : state.st[worst.key].k, bridge: list.every(n => n.bridge)};
  }).filter(g => g.x > -20 && g.x < W + 20 && g.y > -20 && g.y < H + 20);
  const maxU = Math.max(1, ...groups.map(g => g.users)), maxTx = Math.max(1, ...groups.filter(g => !g.bridge).map(g => g.tx));

  // линии: мосты в РФ -> страны выходов, плавная дуга вверх, толщина — трафик выходов страны
  const hub = groups.find(g => g.bridge);
  if (hub) for (const g of groups) {
    if (g.bridge) continue;
    const mx = (hub.x + g.x) / 2, my = (hub.y + g.y) / 2 - Math.hypot(g.x - hub.x, g.y - hub.y) * .22;
    ctx.beginPath(); ctx.moveTo(hub.x, hub.y); ctx.quadraticCurveTo(mx, my, g.x, g.y);
    ctx.strokeStyle = g.k === 'err' ? ST.err : ACC; ctx.globalAlpha = .55; ctx.lineWidth = 1 + 4 * Math.sqrt(g.tx / maxTx); ctx.lineCap = 'round'; ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // квадратики нод и подписи; подписи ищут свободное место (справа, слева, снизу, сверху)
  mapHits = [];
  const labels = [], font = css.getPropertyValue('--f-ui');
  const size = g => (narrow ? 8 : 10) + (narrow ? 10 : 16) * Math.sqrt(g.users / maxU);
  const boxes = groups.map(g => { const q = size(g); return {x: g.x - q / 2 - 4, y: g.y - q / 2 - 4, w: q + 8, h: q + 8}; });
  groups.forEach((g, gi) => {
    const q = size(g), c = ST[g.k] || INK;
    ctx.globalAlpha = .16; ctx.fillStyle = c; ctx.fillRect(g.x - q / 2 - 5, g.y - q / 2 - 5, q + 10, q + 10);   // мягкий ореол
    ctx.globalAlpha = 1; ctx.fillRect(g.x - q / 2, g.y - q / 2, q, q);
    mapHits.push({x: g.x, y: g.y, r: Math.max(18, q), g});
  });
  groups.sort((a, b) => b.users - a.users).forEach(g => {
    const q = size(g), t1 = `${g.cc} · ${g.list.length}`, t2 = g.bridge ? (g.list.length === 1 ? 'мост' : 'мосты') : `${fmt(g.users)} онлайн`;
    ctx.font = `700 ${narrow ? 14 : 16}px ${font}`; const w1 = ctx.measureText(t1).width;
    ctx.font = `400 ${narrow ? 13 : 14}px ${font}`; const w2 = ctx.measureText(t2).width;
    const lw = Math.max(w1, w2) + 4, lh = narrow ? 34 : 38, d = q / 2 + 10;
    const spots = [[g.x + d, g.y - lh / 2], [g.x - d - lw, g.y - lh / 2], [g.x - lw / 2, g.y + d], [g.x - lw / 2, g.y - d - lh]];
    const cost = ([x, y]) => [...labels, ...boxes].filter(b => x < b.x + b.w && x + lw > b.x && y < b.y + b.h && y + lh > b.y).length + (x < 4 || x + lw > W - 4 || y < 4 || y + lh > H - 4 ? 9 : 0);
    const [lx, ly] = spots.reduce((a, b) => cost(b) < cost(a) ? b : a);
    labels.push({x: lx, y: ly, w: lw, h: lh});
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    ctx.font = `700 ${narrow ? 14 : 16}px ${font}`; ctx.fillStyle = g.k === 'ok' ? INK : ST[g.k] || INK; ctx.fillText(t1, lx, ly);
    ctx.font = `400 ${narrow ? 13 : 14}px ${font}`; ctx.fillStyle = MUTED; ctx.fillText(t2, lx, ly + (narrow ? 17 : 19));
  });
  const rest = Object.entries(extra);
  $('#map-note').textContent = (hub ? 'Линии — путь пользователя: мост в РФ → выход; толще — больше трафика. ' : '') + (rest.length ? `Вне карты: ${rest.map(([c, k]) => `${COUNTRY[c] || c} ${k}`).join(', ')}.` : '');
}

// наведение — ноды страны с состояниями; нажатие — открыть самую проблемную
(() => {
  const wrap = $('#map-wrap'); if (!wrap) return;
  const tip = $('#map-tip'), cv = $('#map');
  const hitAt = e => { const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return mapHits.find(h => Math.hypot(h.x - x, h.y - y) < h.r); };
  cv.addEventListener('pointermove', e => {
    const h = hitAt(e); cv.style.cursor = h ? 'pointer' : '';
    if (!h) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${esc(COUNTRY[h.g.cc] || h.g.cc)}</b>` + h.g.list.map(n => { const s = state.st[n.key]; return `<div><span>${esc(n.name)}</span><span class="s-${s.k}">${esc(s.t)}</span></div>`; }).join('');
    tip.hidden = false;
    const r = wrap.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    tip.style.left = Math.max(8, Math.min(x + 16, r.width - tip.offsetWidth - 8)) + 'px'; tip.style.top = Math.max(8, y - tip.offsetHeight - 12) + 'px';
  });
  cv.addEventListener('pointerleave', () => { tip.hidden = true; });
  cv.addEventListener('click', e => {
    const h = hitAt(e); if (!h) return;
    const sev = n => ({err: 3, warn: 2, ok: 1}[state.st[n.key].k] || 0);
    openNode(h.g.list.reduce((a, n) => sev(n) > sev(a) ? n : a).key);
  });
})();
