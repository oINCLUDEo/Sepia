'use strict';
// География: где стоят ноды и какие мосты в какие выходы ведут.
// Суша — ровная сетка точек одного тона, море не рисуем. Масштаб — по области, где стоят ноды, а не вся Европа.
// Каждый мост — отдельно, столбиком у своей страны, со своим цветом; линии — только настоящие пути из конфиг-профилей
// панели (rw-sync.py). Выходы — по странам: размер — онлайн, цвет — состояние. Наведение на мост или выход
// подсвечивает его пути, остальные приглушаются. Статично: перерисовка при новых данных, размере окна и наведении.

const KX = Math.cos(53 * Math.PI / 180);   // равнопромежуточная проекция с поправкой на широту Европы
let mapHits = [], mapLayout = null, mapLand = null, mapHover = null;
// у каждого моста свой цвет линий — заметно разные, чтобы пути не путались (первый — фирменный синий)
const BRIDGE_COLORS = ['#7387FF', '#4CC9F0', '#B58CFF', '#4CD69B', '#FFB36B', '#FF7A9A', '#E2E2E2'];

// раскладка: что где стоит — пересчитывается при новых данных и размере окна
function mapBuild(W, H){
  const N = state.model.nodes, links = state.model.links || [], narrow = W < 640;
  const active = Object.values(N).filter(n => state.st[n.key]?.cat !== 'off' && GEO[(n.cc || '').toUpperCase()]);
  const fromSet = new Set(links.map(l => l.from));
  // мосты: у кого есть исходящие связи; связей нет вообще — мостами считаем ноды в РФ (без линий)
  const isBridge = n => links.length ? fromSet.has(n.key) : n.bridge;
  const bridges = active.filter(isBridge).sort((a, b) => a.name.localeCompare(b.name, 'ru', {numeric: true}));
  const exits = active.filter(n => !isBridge(n));
  const byCc = {};
  for (const n of exits) (byCc[n.cc.toUpperCase()] ||= []).push(n);
  const extra = Object.values(N).filter(n => state.st[n.key]?.cat !== 'off' && n.cc && !GEO[n.cc.toUpperCase()]);

  // окно карты: все точки + поля; не уже 24° по долготе и 12° по широте, чтобы страны оставались узнаваемыми
  const pts = [...exits, ...bridges].map(n => GEO[n.cc.toUpperCase()]);
  let lo0 = Math.min(...pts.map(p => p[0])), lo1 = Math.max(...pts.map(p => p[0])), la0 = Math.min(...pts.map(p => p[1])), la1 = Math.max(...pts.map(p => p[1]));
  if (!pts.length) { lo0 = -5; lo1 = 45; la0 = 42; la1 = 64; }
  const cx = (lo0 + lo1) / 2, cy = (la0 + la1) / 2;
  let spanX = Math.max(24, (lo1 - lo0) * 1.5 + 10), spanY = Math.max(12, (la1 - la0) * 1.5 + 6);
  // подгоняем под пропорции холста: лишнее место — поровну по краям
  if (spanX * KX / spanY > W / H) spanY = spanX * KX * H / W; else spanX = spanY * W / H / KX;
  const v = {lon0: cx - spanX / 2, lat1: cy + spanY / 2, s: W / (spanX * KX)};
  const P = (lon, lat) => [(lon - v.lon0) * KX * v.s, (v.lat1 - lat) * v.s];

  const maxU = Math.max(1, ...exits.map(n => n.panel?.users || 0));
  const groups = Object.entries(byCc).map(([cc, list]) => {
    const [x, y] = P(...GEO[cc]), sev = n => ({err: 3, warn: 2, ok: 1}[state.st[n.key].k] || 0), worst = list.reduce((a, n) => sev(n) > sev(a) ? n : a, list[0]);
    const users = list.reduce((a, n) => a + (n.panel?.users || 0), 0);
    return {kind: 'exit', cc, list, x, y, users, k: list.every(n => state.st[n.key].cat === 'silent') ? 'off' : state.st[worst.key].k,
      q: (narrow ? 9 : 11) + (narrow ? 9 : 14) * Math.sqrt(users / maxU)};
  });
  // мосты одной страны — столбиком вокруг её точки
  const gap = narrow ? 30 : 38, byBcc = {};
  for (const n of bridges) (byBcc[n.cc.toUpperCase()] ||= []).push(n);
  const bpts = [];
  for (const [cc, list] of Object.entries(byBcc)) {
    const [x, y] = P(...GEO[cc]);
    list.forEach((n, i) => bpts.push({kind: 'bridge', n, list: [n], x, y: y + (i - (list.length - 1) / 2) * gap, q: narrow ? 9 : 11,
      k: state.st[n.key].cat === 'silent' ? 'off' : state.st[n.key].k, color: BRIDGE_COLORS[bpts.length % BRIDGE_COLORS.length]}));
  }
  // линии: мост -> страна выхода (несколько нод одной страны — одна линия)
  const groupOf = {};
  for (const g of groups) for (const n of g.list) groupOf[n.key] = g;
  const seen = new Set(), lines = [];
  for (const l of links) {
    const b = bpts.find(p => p.n.key === l.from), g = groupOf[l.to], id = l.from + '>' + g?.cc;
    if (b && g && !seen.has(id)) { seen.add(id); lines.push({b, g}); }
  }
  return {W, H, v, P, groups, bpts, lines, extra, narrow, links: links.length};
}

// суша — один раз на размер и вид, дальше берём готовую картинку
function mapLandLayer(L, MUTED, dpr){
  const key = [L.W, L.H, L.v.lon0.toFixed(3), L.v.lat1.toFixed(3), L.v.s.toFixed(3), MUTED, dpr].join('|');
  if (mapLand?.key === key) return mapLand.cv;
  const cv = document.createElement('canvas'); cv.width = L.W * dpr; cv.height = L.H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = MUTED;
  const g = L.narrow ? 5 : 6, cols = Math.ceil(L.W / g), rows = Math.ceil(L.H / g), land = [];
  const inv = (x, y) => [L.v.lon0 + x / (KX * L.v.s), L.v.lat1 - y / L.v.s];
  for (let y = 0; y < rows; y++) { land[y] = []; for (let x = 0; x < cols; x++) land[y][x] = isLand(...inv(x * g + g / 2, y * g + g / 2)); }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (!land[y][x]) continue;
    const coast = !land[y - 1]?.[x] || !land[y + 1]?.[x] || !land[y][x - 1] || !land[y][x + 1], q = coast ? 2 : 1.4;
    ctx.globalAlpha = coast ? .5 : .22; ctx.fillRect(x * g + g / 2 - q / 2, y * g + g / 2 - q / 2, q, q);
  }
  mapLand = {key, cv};
  return cv;
}

function renderMap(rebuild = true){
  const cv = $('#map'); if (!cv || !state.model) return;
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  // новая раскладка — новые объекты точек: старая подсветка ни с чем не совпадёт и затемнит всю карту
  if (rebuild || !mapLayout || mapLayout.W !== W || mapLayout.H !== H) { mapLayout = mapBuild(W, H); mapHover = null; }
  const L = mapLayout, dpr = Math.min(2, devicePixelRatio || 1), ctx = cv.getContext('2d');
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement), col = k => css.getPropertyValue(k).trim();
  const INK = col('--ink'), MUTED = col('--muted'), BG = col('--sheet-2'), ST = {ok: INK, warn: col('--warn'), err: col('--err'), off: MUTED};
  const font = css.getPropertyValue('--f-ui'), light = document.documentElement.dataset.theme === 'light';
  ctx.drawImage(mapLandLayer(L, MUTED, dpr), 0, 0, W, H);

  // что подсвечено: наведённый мост — его линии; наведённый выход — линии в него
  const hot = l => !mapHover || (mapHover.kind === 'bridge' ? l.b === mapHover : l.g === mapHover);
  const lit = p => !mapHover || p === mapHover || L.lines.some(l => hot(l) && (l.b === p || l.g === p));
  const maxTx = Math.max(1, ...L.groups.map(g => g.list.reduce((a, n) => a + (n.tx || 0), 0)));
  L.lines.forEach(({b, g}, i) => {
    // разный изгиб у соседних мостов — линии не сливаются в один жгут
    const bend = .18 + .05 * (i % 4), mx = (b.x + g.x) / 2, my = (b.y + g.y) / 2 - Math.hypot(g.x - b.x, g.y - b.y) * bend;
    const tx = g.list.reduce((a, n) => a + (n.tx || 0), 0);
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.quadraticCurveTo(mx, my, g.x, g.y);
    ctx.strokeStyle = b.color; ctx.lineCap = 'round'; ctx.lineWidth = 1.5 + 3 * Math.sqrt(tx / maxTx);
    ctx.globalAlpha = hot({b, g}) ? (mapHover ? .95 : .7) : .08; ctx.stroke();
  });
  ctx.globalAlpha = 1;

  // точки: выходы — квадрат с ореолом, мосты — квадрат с цветной обводкой (цвет его линий)
  mapHits = [];
  const all = [...L.groups, ...L.bpts];
  for (const p of all) {
    const c = ST[p.k] || INK, a = lit(p) ? 1 : .25;
    ctx.globalAlpha = .16 * a; ctx.fillStyle = c; ctx.fillRect(p.x - p.q / 2 - 5, p.y - p.q / 2 - 5, p.q + 10, p.q + 10);
    ctx.globalAlpha = a; ctx.fillRect(p.x - p.q / 2, p.y - p.q / 2, p.q, p.q);
    if (p.kind === 'bridge' && L.links) { ctx.strokeStyle = p.color; ctx.lineWidth = 2; ctx.strokeRect(p.x - p.q / 2 - 3, p.y - p.q / 2 - 3, p.q + 6, p.q + 6); }
    mapHits.push({x: p.x, y: p.y, r: Math.max(16, p.q), p});
  }

  // подписи: у мостов — имя справа; у выходов — ищем свободное место (справа, слева, снизу, сверху)
  const labels = [], boxes = all.map(p => ({x: p.x - p.q / 2 - 6, y: p.y - p.q / 2 - 6, w: p.q + 12, h: p.q + 12}));
  const F1 = `700 ${L.narrow ? 14 : 16}px ${font}`, F2 = `400 ${L.narrow ? 13 : 14}px ${font}`;
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  const place = (p, t1, t2, prefer) => {
    ctx.font = F1; const w1 = ctx.measureText(t1).width; ctx.font = F2; const w2 = t2 ? ctx.measureText(t2).width : 0;
    const lw = Math.max(w1, w2) + 6, lh = t2 ? (L.narrow ? 34 : 38) : (L.narrow ? 18 : 20), d = p.q / 2 + 10;
    const spots = [[p.x + d, p.y - lh / 2], [p.x - d - lw, p.y - lh / 2], [p.x - lw / 2, p.y + d], [p.x - lw / 2, p.y - d - lh]];
    if (prefer === 'right') spots.splice(1);   // у моста подпись всегда справа — столбик читается как список
    const cost = ([x, y]) => [...labels, ...boxes].filter(b => x < b.x + b.w && x + lw > b.x && y < b.y + b.h && y + lh > b.y).length + (x < 4 || x + lw > L.W - 4 || y < 4 || y + lh > L.H - 4 ? 9 : 0);
    const [lx, ly] = spots.reduce((a, b) => cost(b) < cost(a) ? b : a);
    labels.push({x: lx, y: ly, w: lw, h: lh});
    const a = lit(p) ? 1 : .3;
    ctx.globalAlpha = .8 * a; ctx.fillStyle = BG; ctx.fillRect(lx - 4, ly - 2, lw + 6, lh + 2);   // подложка: подпись поверх линий читается
    ctx.globalAlpha = a; ctx.font = F1; ctx.fillStyle = p.k === 'ok' ? INK : ST[p.k] || INK; ctx.fillText(t1, lx, ly);
    if (t2) { ctx.font = F2; ctx.fillStyle = MUTED; ctx.fillText(t2, lx, ly + (L.narrow ? 17 : 19)); }
  };
  for (const b of L.bpts) place(b, b.n.name, null, 'right');
  for (const g of [...L.groups].sort((a, b) => b.users - a.users)) place(g, `${g.cc} · ${g.list.length}`, `${fmt(g.users)} на связи`);
  ctx.globalAlpha = 1;

  const extra = L.extra.length ? ` Вне карты: ${L.extra.map(n => n.name).join(', ')}.` : '';
  $('#map-note').textContent = (L.links ? 'Линии — какие мосты в какие выходы ведут (из конфиг-профилей панели); толще — больше трафика. Наведите на мост или выход, чтобы выделить его пути.'
    : L.bpts.length ? 'Связи мостов ещё не пришли: обновите rw-sync.py на сервере панели (git pull) — он читает их из конфиг-профилей.' : '') + extra;
}

// наведение — подсветка путей и список нод; нажатие — открыть ноду (у страны — самую проблемную)
(() => {
  const wrap = $('#map-wrap'); if (!wrap) return;
  const tip = $('#map-tip'), cv = $('#map');
  const hitAt = e => { const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; return mapHits.find(h => Math.hypot(h.x - x, h.y - y) < h.r)?.p || null; };
  const linked = p => mapLayout.lines.filter(l => l.b === p || l.g === p).map(l => p.kind === 'bridge' ? `${COUNTRY[l.g.cc] || l.g.cc}` : l.b.n.name);
  cv.addEventListener('pointermove', e => {
    const p = hitAt(e); cv.style.cursor = p ? 'pointer' : '';
    if (p !== mapHover) { mapHover = p; renderMap(false); }
    if (!p) { tip.hidden = true; return; }
    const ln = linked(p);
    tip.innerHTML = (p.kind === 'bridge' ? `<b>${esc(p.n.name)}</b>` : `<b>${esc(COUNTRY[p.cc] || p.cc)}</b>`)
      + p.list.map(n => { const s = state.st[n.key]; return `<div><span>${esc(n.name)}</span><span class="s-${s.k}">${esc(s.t)}</span></div>`; }).join('')
      + (ln.length ? `<p class="map-tip-links">${p.kind === 'bridge' ? 'Ведёт в' : 'Сюда ведут'}: ${ln.map(esc).join(', ')}</p>` : p.kind === 'exit' && mapLayout.links ? '<p class="map-tip-links">Мосты сюда не ведут — пользователи подключаются напрямую</p>' : '');
    tip.hidden = false;
    const r = wrap.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    tip.style.left = Math.max(8, Math.min(x + 16, r.width - tip.offsetWidth - 8)) + 'px'; tip.style.top = Math.max(8, y - tip.offsetHeight - 12) + 'px';
  });
  cv.addEventListener('pointerleave', () => { tip.hidden = true; if (mapHover) { mapHover = null; renderMap(false); } });
  cv.addEventListener('click', e => {
    const p = hitAt(e); if (!p) return;
    const sev = n => ({err: 3, warn: 2, ok: 1}[state.st[n.key].k] || 0);
    openNode(p.list.reduce((a, n) => sev(n) > sev(a) ? n : a).key);
  });
})();
