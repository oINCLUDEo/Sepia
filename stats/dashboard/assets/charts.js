'use strict';
// Графики: мини-графики карточек и линейные графики

/* ---------- графика ---------- */
function smoothPath(pts){ // монотонная кубическая: без выбросов выше реальных значений
  const n = pts.length;
  if (!n) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}h.1`;
  const dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  const f = v => v.toFixed(1);
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f(pts[i][0] + h)},${f(pts[i][1] + t[i] * h)} ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - t[i + 1] * h)} ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
  }
  return d;
}
const segments = (pts, step) => pts.reduce((acc, p, i) => { if (!i || p[0] - pts[i - 1][0] > step * 2.5) acc.push([]); acc.at(-1).push(p); return acc; }, []);
const niceMax = v => { if (!(v > 0)) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return [1, 2, 4, 5, 6, 8, 10].find(s => n <= s) * p; };
const ago = ts => { if (!ts) return 'нет данных'; const s = Math.max(0, Date.now() / 1000 - ts); if (s < 90) return 'только что'; const m = Math.round(s / 60); if (m < 60) return `${m} мин назад`; const h = Math.round(m / 60); return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`; };
const when = ts => new Date(ts * 1000).toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const hhmm = ts => new Date(ts * 1000).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
const SCOL = {ok: 'var(--spark)', warn: 'var(--warn)', err: 'var(--err)', off: 'var(--off)'};

// мини-график: ось — ровно последние сутки, точки — средние по часу (снимки раз в 15 мин шумят), разрывы не соединяем
function spark(series, color, id, t1){
  const t0 = t1 - 86400, raw = (series || []).filter(p => p[0] >= t0);
  const B = {};
  for (const [t, v] of raw) { const h = Math.floor(t / 3600) * 3600; (B[h] ||= [0, 0]); B[h][0] += v; B[h][1]++; }
  const pts = Object.entries(B).map(([h, [sum, c]]) => [+h + 1800, sum / c]).sort((a, b) => a[0] - b[0]);
  if (pts.length < 3) return `<div class="spark-empty">${raw.length ? `сбор идёт с ${hhmm(raw[0][0])}` : 'нет данных за сутки'}</div>`;
  const W = 300, H = 52, vmax = Math.max(...pts.map(p => p[1])) * 1.1 || 1, X = t => Math.min(W, Math.max(0, (t - t0) / 86400 * W)), Y = v => H - 2 - v / vmax * (H - 6);
  // начало суток без данных — пунктир по низу: видно, что данных нет, а не что трафик был нулевой
  let body = X(pts[0][0]) > 12 ? `<path d="M0,${H - 1}H${(X(pts[0][0]) - 4).toFixed(1)}" style="stroke:var(--muted)" stroke-width="1.5" stroke-dasharray="3 5" opacity=".6" vector-effect="non-scaling-stroke"/>` : '';
  for (const seg of segments(pts, 3600)) {
    if (seg.length < 2) continue;
    const p = seg.map(([t, v]) => [X(t), Y(v)]), d = smoothPath(p);
    body += `<path d="${d}L${p.at(-1)[0].toFixed(1)},${H}L${p[0][0].toFixed(1)},${H}Z" fill="url(#${id})"/><path d="${d}" fill="none" style="stroke:${color}" stroke-width="1.75" vector-effect="non-scaling-stroke"/>`;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${color}" stop-opacity=".28"/><stop offset="1" style="stop-color:${color}" stop-opacity="0"/></linearGradient></defs>${body}</svg>`;
}

// состояние ноды: k — цвет, t — текст, cat — для фильтра, stale — показываем старые значения серым
function status(n, now){
  if (n.panel?.disabled === 1) return {k: 'off', t: 'отключена в панели', cat: 'off', ic: 'circle-slash'};
  if (n.panel?.connected === 0) return {k: 'err', t: 'панель не видит ноду', cat: 'err', ic: 'unplug'};
  const b = blockSuspect(n);
  if (b) return {k: 'err', t: 'похоже, IP заблокирован', cat: 'err', block: b, ic: 'ban'};
  if (n.seen == null) return {k: 'off', t: 'нет статистики', cat: 'off', ic: 'circle-dashed'};
  const age = now - n.seen;
  if (age > staleErr(n)) return {k: 'err', t: `молчит ${ago(n.seen).replace(' назад', '')}`, cat: 'silent', stale: true, ic: 'clock-alert'};
  if (age > staleWarn(n)) return {k: 'warn', t: `снимок ${ago(n.seen)}`, cat: 'silent', stale: true, ic: 'clock-alert'};
  // маскировка: заглушка и сертификат — то, по чему активный пробер вычисляет прокси
  const site = n.site, cert = site?.days;
  if (site && !(site.code >= 200 && site.code < 400)) return {k: 'err', t: site.code ? `заглушка отвечает HTTP ${fmt(site.code)}` : 'заглушка не отвечает', cat: 'err', ic: 'shield-alert'};
  if (site && site.tls === 0) return {k: 'err', t: 'сертификат не проходит проверку', cat: 'err', ic: 'shield-alert'};
  if (cert != null && cert < CERT.b) return {k: 'err', t: `сертификат: осталось ${fmt(cert)} дн`, cat: 'err', ic: 'shield-alert'};
  let worst = null;
  for (const k of Object.keys(TH)) { const l = lvlN(n, k); if (l && (!worst || l > worst.l)) worst = {k, l}; }
  if (cert != null && cert < CERT.w && worst?.l !== 2) return {k: 'warn', t: `сертификат: осталось ${fmt(cert)} дн`, cat: 'warn', ic: 'shield-alert'};
  if (worst) { const T = TH[worst.k]; return {k: worst.l === 2 ? 'err' : 'warn', t: `${T.label} ${fmt(n[worst.k], T.dec)}${T.unit}`, cat: worst.l === 2 ? 'err' : 'warn', ic: worst.l === 2 ? 'circle-x' : 'triangle-alert'}; }
  return {k: 'ok', t: 'в норме', cat: 'ok', ic: 'circle-check'};
}
const CATS = [['err', 'Плохо'], ['warn', 'Замечания'], ['silent', 'Молчат'], ['ok', 'В норме'], ['off', 'Отключены']];

function countUp(el, to, dec){
  if (!state.first || matchMedia('(prefers-reduced-motion: reduce)').matches || !(to > 0)) { el.textContent = fmt(to, dec); return; }
  const t0 = performance.now(), dur = 1500;
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - (1 - k) ** 3; el.textContent = fmt(to * e, dec); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
