'use strict';
// Фирменный паттерн из гайдлайна — «прячущиеся квадраты» (bookofshapes.com/patterns/hiding-squares): шум Перлина задаёт
// размер квадрата в клетке сетки — где шум слабый, квадрат почти во всю клетку, где сильный — сжимается и пропадает.
// Как у дизайнера: квадрат до 91% клетки, совсем мелкие не рисуем. Клетка мельче, чем в гайдлайне (там 16), — фон не спорит
// с текстом. Статичный: фон окна входа (#login-art) и полоска над пустыми состояниями (--pattern в app.css)
const hidingSquares = (() => {
  const r = prng(7), p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const perm = [...p, ...p], fade = t => t * t * t * (t * (t * 6 - 15) + 10), lerp = (t, a, b) => a + t * (b - a), grad = (h, x, y) => ((h & 1) ? -x : x) + ((h & 2) ? -y : y);
  const noise = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255; x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y), a = perm[X] + Y, b = perm[X + 1] + Y;
    return lerp(v, lerp(u, grad(perm[a], x, y), grad(perm[b], x - 1, y)), lerp(u, grad(perm[a + 1], x, y - 1), grad(perm[b + 1], x - 1, y - 1)));
  };
  const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // cv — холст (по умолчанию рисуем в его размер на странице), cell — клетка в px, alpha — общая яркость, wave — размер пятен шума в клетках
  return (cv, cell = 9, alpha = .55, W = cv.clientWidth, H = cv.clientHeight, wave = 18) => {
    const d = Math.min(2, devicePixelRatio || 1), ctx = cv.getContext('2d');
    cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0);
    for (let y = 0; y < H; y += cell) for (let x = 0; x < W; x += cell) {
      const cx = x / cell / wave, cy = y / cell / wave, v = (noise(cx, cy) + .5 * noise(cx * 2, cy * 2)) / 1.5 * 1.7 + .5;
      const s = 1 - smooth(.28, .88, v); if (s < .12) continue;
      const q = s * .91 * cell, k = s * s;   // крупные — светлее: от Laser Blue #465DFF к #96A2FF
      ctx.globalAlpha = alpha * (.35 + .5 * s); ctx.fillStyle = `rgb(${Math.round(70 + 80 * k)},${Math.round(93 + 69 * k)},255)`;
      ctx.fillRect(x + (cell - q) / 2, y + (cell - q) / 2, q, q);
    }
  };
})();
// полоска над «нет данных»: одна картинка на всю страницу; пятна мельче, чтобы в узкую полоску попало несколько
{ const cv = document.createElement('canvas'); hidingSquares(cv, 8, 1, 360, 56, 6); document.documentElement.style.setProperty('--pattern', `url(${cv.toDataURL()})`); }
const loginArt = () => { const cv = $('#login-art'); if (cv && !$('#login').hidden) hidingSquares(cv); };
