'use strict';
// Шапка: живая планета. Ночная Земля из космоса, суша — точками, по краю — атмосфера, как свет на горизонте.
// На ней — ноды (цвет — состояние) и пути «мост → выход» дугами над поверхностью, по которым бежит свет.
// Планета медленно покачивается вокруг Европы, чтобы ноды всегда были на видимой стороне.
// Рисуется только когда шапка на экране и вкладка открыта; «уменьшить движение» в системе — один статичный кадр.

const D2R = Math.PI / 180;
const unit = (lon, lat) => { const a = lat * D2R, b = lon * D2R; return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)]; };
// точки суши: равные по площади — шаг по долготе растёт к полюсам
const EARTH_DOTS = (() => {
  // лёгкий разброс: ровные ряды у полюса дают кольца-муар
  const out = [], step = 1.05, r = prng(5);
  for (let lat = -58; lat <= 80; lat += step) {
    const dl = step / Math.max(.2, Math.cos(lat * D2R));
    for (let lon = -180; lon < 180; lon += dl) { const lo = lon + (r() - .5) * dl * .6, la = lat + (r() - .5) * step * .6; if (earthLand(lo, la)) out.push(unit(lo, la)); }
  }
  return out;
})();
// звёзды — фиксированные, мерцают
const STARS = (() => { const r = prng(77); return Array.from({length: 170}, () => [r(), r(), .3 + r() * .9, r() * 6.28, .4 + r() * 1.4]); })();

const globe = {raf: 0, visible: true, last: 0, t0: performance.now()};
function globeView(W, H){
  const narrow = W < 640;
  // большая планета справа, обрезана краем листа — как горизонт; на телефоне — сверху, за заголовком
  const R = narrow ? W * .78 : Math.max(W * .36, H * .72), cx = narrow ? W * .78 : W * .79, cy = narrow ? R * .98 : H * .74;
  return {R, cx, cy, narrow};
}
function art(now = performance.now()){
  const cv = $('#art'); if (!cv) return;
  const W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = W * dpr; cv.height = H * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const {R, cx, cy, narrow} = globeView(W, H), s = (now - globe.t0) / 1000;

  // космос: почти чёрный, к планете — едва заметный синий
  const bg = ctx.createRadialGradient(cx, cy, R * .6, cx, cy, Math.max(W, H) * 1.3);
  bg.addColorStop(0, '#0b0f24'); bg.addColorStop(.45, '#090a12'); bg.addColorStop(1, '#0a0a0c');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  for (const [x, y, a, ph, sz] of STARS) {
    const px = x * W, py = y * H; if (Math.hypot(px - cx, py - cy) < R * 1.05) continue;
    ctx.globalAlpha = a * (.55 + .45 * Math.sin(s * sz + ph)); ctx.fillStyle = '#DDE3FF'; ctx.fillRect(px, py, sz > 1.3 ? 1.6 : 1, sz > 1.3 ? 1.6 : 1);
  }
  ctx.globalAlpha = 1;

  // поворот: центр вида качается вокруг Европы (долгота 22±16°), наклон — чтобы Европа была в верхней-левой части диска
  const lon0 = (narrow ? 30 : 34) + 16 * Math.sin(s * 2 * Math.PI / 120), lat0 = narrow ? 14 : 24;
  const cl = Math.cos(-lon0 * D2R), sl = Math.sin(-lon0 * D2R), ca = Math.cos(lat0 * D2R), sa = Math.sin(lat0 * D2R);
  const rot = ([x, y, z]) => { const x1 = x * cl + z * sl, z1 = -x * sl + z * cl; return [x1, y * ca - z1 * sa, y * sa + z1 * ca]; };
  const P = (v, k = 1) => [cx + v[0] * R * k, cy - v[1] * R * k];
  const sun = [-.62, .5, .6];   // свет — слева сверху, из-за зрителя
  const lit = v => Math.max(0, v[0] * sun[0] + v[1] * sun[1] + v[2] * sun[2]);

  // внешнее свечение атмосферы
  const halo = ctx.createRadialGradient(cx, cy, R * .96, cx, cy, R * 1.22);
  halo.addColorStop(0, 'rgba(110,130,255,.42)'); halo.addColorStop(.25, 'rgba(70,93,255,.16)'); halo.addColorStop(1, 'rgba(70,93,255,0)');
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.22, 0, 7); ctx.fill();
  // океан: шар с мягким светом
  const sea = ctx.createRadialGradient(cx - R * .45, cy - R * .4, R * .1, cx, cy, R);
  sea.addColorStop(0, '#16205a'); sea.addColorStop(.55, '#0b1030'); sea.addColorStop(1, '#05060f');
  ctx.fillStyle = sea; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();

  // суша точками: яркость — по освещению и по близости к краю (у края точки гаснут в атмосфере)
  const q = narrow ? 1.5 : Math.max(1.4, R / 330), buckets = Array.from({length: 7}, () => new Path2D());
  for (const d of EARTH_DOTS) {
    const v = rot(d); if (v[2] <= .02) continue;
    const b = Math.min(6, Math.floor((.18 + .82 * lit(v)) * Math.min(1, v[2] * 3) * 7));
    const [x, y] = P(v); if (x < -4 || y < -4 || x > W + 4 || y > H + 4) continue;
    buckets[b].rect(x - q / 2, y - q / 2, q, q);
  }
  buckets.forEach((p, i) => { ctx.globalAlpha = .12 + i * .13; ctx.fillStyle = i > 4 ? '#E6EAFF' : '#9AA8FF'; ctx.fill(p); });
  ctx.globalAlpha = 1;

  // терминатор: ночная сторона темнее
  const night = ctx.createLinearGradient(cx - R * .7, cy - R * .6, cx + R * .8, cy + R * .7);
  night.addColorStop(0, 'rgba(5,6,15,0)'); night.addColorStop(.55, 'rgba(5,6,15,.15)'); night.addColorStop(1, 'rgba(5,6,15,.7)');
  ctx.fillStyle = night; ctx.beginPath(); ctx.arc(cx, cy, R + .5, 0, 7); ctx.fill();
  // тонкий светящийся край со стороны света — «рассвет на горизонте»
  const rim = ctx.createLinearGradient(cx - R, cy - R, cx + R * .4, cy + R * .4);
  rim.addColorStop(0, 'rgba(200,210,255,.95)'); rim.addColorStop(.4, 'rgba(110,130,255,.55)'); rim.addColorStop(1, 'rgba(70,93,255,0)');
  ctx.strokeStyle = rim; ctx.lineWidth = narrow ? 1.6 : 2.2; ctx.beginPath(); ctx.arc(cx, cy, R - 1, 0, 7); ctx.stroke();
  const inner = ctx.createRadialGradient(cx, cy, R * .82, cx, cy, R);
  inner.addColorStop(0, 'rgba(110,130,255,0)'); inner.addColorStop(1, 'rgba(140,160,255,.22)');
  ctx.fillStyle = inner; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();

  globeNodes(ctx, rot, P, s, R, narrow);
  // на телефоне текст лежит поверх планеты — снизу затемняем, чтобы цифры читались
  if (narrow) { const sh = ctx.createLinearGradient(0, H * .38, 0, H * .62); sh.addColorStop(0, 'rgba(10,10,12,0)'); sh.addColorStop(1, 'rgba(10,10,12,.82)'); ctx.fillStyle = sh; ctx.fillRect(0, H * .38, W, H * .62); }
}

// ноды и пути на планете
function globeNodes(ctx, rot, P, s, R, narrow){
  const m = state.model; if (!m || !state.st) return;
  const css = getComputedStyle(document.documentElement), col = {ok: '#C9D0FF', warn: css.getPropertyValue('--warn').trim() || '#F0B44C', err: css.getPropertyValue('--err').trim() || '#FF6B5E', off: '#6E6E75'};
  const N = m.nodes, at = {}, jit = k => { let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) | 0; return [((h & 255) / 255 - .5) * 2.4, (((h >> 8) & 255) / 255 - .5) * 1.6]; };
  for (const n of Object.values(N)) {
    const g = GEO[(n.cc || '').toUpperCase()]; if (!g || state.st[n.key]?.cat === 'off') continue;
    const [dx, dy] = jit(n.key); at[n.key] = unit(g[0] + dx, g[1] + dy);
  }
  // пути: дуга по большому кругу, приподнятая над поверхностью; по ней бежит отрезок света
  const slerp = (a, b, u) => { const d = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) || 1e-6, k1 = Math.sin((1 - u) * d) / Math.sin(d), k2 = Math.sin(u * d) / Math.sin(d); return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2]; };
  (m.links || []).forEach((l, li) => {
    const a = at[l.from], b = at[l.to]; if (!a || !b) return;
    const pts = [], n = 40;
    for (let i = 0; i <= n; i++) { const u = i / n, v = rot(slerp(a, b, u)), k = 1 + .09 * Math.sin(Math.PI * u); pts.push({v, k, p: P(v, k)}); }
    const vis = p => p.v[2] > -.15;
    const bad = state.st[l.from]?.k === 'err' || state.st[l.to]?.k === 'err';
    ctx.lineWidth = narrow ? 1 : 1.3; ctx.strokeStyle = bad ? col.err : '#7387FF'; ctx.globalAlpha = .45;
    ctx.beginPath(); pts.forEach((p, i) => { if (!vis(p)) return; i && vis(pts[i - 1]) ? ctx.lineTo(...p.p) : ctx.moveTo(...p.p); }); ctx.stroke();
    const head = ((s * .22 + li * .37) % 1.3) * n;   // бегущий свет, с паузой между пробегами
    for (let i = Math.max(1, Math.floor(head - 8)); i <= Math.min(n, Math.floor(head)); i++) {
      const p = pts[i], o = pts[i - 1]; if (!vis(p) || !vis(o)) continue;
      ctx.globalAlpha = .95 * (1 - (head - i) / 8); ctx.strokeStyle = bad ? col.err : '#E6EAFF'; ctx.lineWidth = narrow ? 1.6 : 2.2;
      ctx.beginPath(); ctx.moveTo(...o.p); ctx.lineTo(...p.p); ctx.stroke();
    }
  });
  // точки нод: свечение, ядро; у проблемных — расходящееся кольцо
  for (const [key, u] of Object.entries(at)) {
    const v = rot(u); if (v[2] < .05) continue;
    const st = state.st[key], c = col[st?.k] || col.ok, [x, y] = P(v), r = narrow ? 2.2 : 2.8, fade = Math.min(1, v[2] * 4);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 5); g.addColorStop(0, c); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = .35 * fade; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 5, 0, 7); ctx.fill();
    ctx.globalAlpha = fade; ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    if (st?.k === 'err') { const k = (s * .8 + (u[0] + 1) % 1) % 1; ctx.globalAlpha = .7 * (1 - k) * fade; ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, r + 3 + 16 * k, 0, 7); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
}

// анимация ~30 кадров в секунду и только когда видно: шапка на экране, раздел «Обзор», вкладка браузера активна
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const tick = now => {
    globe.raf = 0;
    if (!globe.visible || document.hidden || state.vw !== 'overview') return;
    if (now - globe.last > 33) { globe.last = now; art(now); }
    if (!reduce.matches) globe.raf = requestAnimationFrame(tick);
  };
  globe.kick = () => { if (!globe.raf) globe.raf = requestAnimationFrame(tick); };
  const hero = $('#hero');
  if (hero && 'IntersectionObserver' in window) new IntersectionObserver(es => { globe.visible = es[0].isIntersecting; globe.kick(); }).observe(hero);
  document.addEventListener('visibilitychange', globe.kick);
  globe.kick();
})();
