'use strict';
// Шапка: знак из металла, половина фото, половина ASCII

/* ---------- шапка: знак Ulya, отлитый из металла ----------
   Фото шлифованного металла из гайдлайна (слайд 11) залито в форму знака. Правое звено — фото, левое рассыпается в ASCII:
   символ подбирается по яркости металла, на границе — крупные «пиксели», из ASCII влево выходят строки кода.
   Статично: перерисовывается только при смене размера окна. */
const LOGO = new Path2D(document.getElementById('logo-path').getAttribute('d'));
const metal = new Image(); metal.src = METAL_SRC;
// плотность символов: от пустого к самому «тёмному» (на чёрном фоне — самому яркому)
const RAMP = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
const CODE = 'vless reality xtls-rprx-vision fingerprint=chrome network=tcp port=443 route geosite:category-ru direct geoblock proxy bbr cake ';
function art(){
  const cv = $('#art'), top = $('#hero h1').offsetTop, ctx = cv.getContext('2d'), dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight; if (!W || !H || !metal.complete) return;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, W, H);
  const narrow = W < 640;
  // свободное место: справа от текста заголовка и над плитками — знак вписывается туда при любой ширине
  const hr = cv.getBoundingClientRect(), rights = [];
  // правый край именно текста (span заголовка — блок во всю ширину, поэтому меряем текстовые узлы)
  const tw = document.createTreeWalker($('#hero h1'), NodeFilter.SHOW_TEXT);
  for (let t; (t = tw.nextNode());) { const rg = document.createRange(); rg.selectNodeContents(t); rights.push(rg.getBoundingClientRect().right); }
  document.querySelectorAll('#hero .mega-wrap > *').forEach(e => rights.push(e.getBoundingClientRect().right));
  const textR = Math.max(...rights) - hr.left;
  const kpiTop = $('#hero .kpis').getBoundingClientRect().top - hr.top;
  const box = narrow ? {x: W * .05, y: 14, w: W * .9, h: top - 26} : {x: textR + 48, y: 36, w: W - textR - 48 - 44, h: kpiTop - 36 - 28};
  const lw = Math.max(200, Math.min(box.w, box.h * 573 / 334, 820)), lh = lw * 334 / 573;
  const lx = narrow ? (W - lw) / 2 : box.x + (box.w - lw) * .75, ly = box.y + (box.h - lh) / 2;
  // 1) знак из металла с освещением — во внеэкранном холсте
  const off = document.createElement('canvas'), ow = Math.round(lw), oh = Math.round(lh); off.width = ow; off.height = oh;
  const o = off.getContext('2d', {willReadFrequently: true}), k = lw / 573;
  o.save(); o.scale(k, k); o.translate(11, 1); o.clip(LOGO); o.setTransform(1, 0, 0, 1, 0, 0);
  const s = Math.max(ow / metal.naturalWidth, oh / metal.naturalHeight) * 1.15;
  o.filter = 'grayscale(1) contrast(1.35) brightness(1.05)';
  o.drawImage(metal, (ow - metal.naturalWidth * s) / 2, (oh - metal.naturalHeight * s) / 2, metal.naturalWidth * s, metal.naturalHeight * s);
  o.filter = 'none';
  const g = o.createLinearGradient(0, 0, ow, oh); g.addColorStop(0, 'rgba(255,255,255,.22)'); g.addColorStop(.55, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)');
  o.fillStyle = g; o.fillRect(0, 0, ow, oh); o.restore();
  // мягкое свечение Laser Blue за знаком
  const glow = ctx.createRadialGradient(lx + lw * .6, ly + lh * .5, 0, lx + lw * .6, ly + lh * .5, lw * .7);
  glow.addColorStop(0, 'rgba(70,93,255,.22)'); glow.addColorStop(1, 'rgba(70,93,255,0)'); ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
  // 2) сетка символов
  const cw = narrow ? 5.2 : 6.4, ch = cw * 1.7, cols = Math.ceil(lw / cw), rows = Math.ceil(lh / ch);
  const sm = document.createElement('canvas'); sm.width = cols; sm.height = rows; const sx = sm.getContext('2d', {willReadFrequently: true});
  sx.drawImage(off, 0, 0, cols, rows); const px = sx.getImageData(0, 0, cols, rows).data;
  const r = prng(11), split = [];   // где в строке ASCII переходит в фото: рваная граница
  for (let y = 0; y < rows; y++) split[y] = Math.round(cols * (.5 + .07 * Math.sin(y * .31) + .05 * Math.sin(y * .087 + 2) + (r() - .5) * .09));
  // фото — правее границы
  ctx.save(); ctx.beginPath();
  for (let y = 0; y < rows; y++) ctx.rect(lx + (split[y] + 2) * cw, ly + y * ch, lw, ch + .5);
  ctx.clip(); ctx.drawImage(off, lx, ly, lw, lh); ctx.restore();
  ctx.font = `500 ${(ch * .86).toFixed(1)}px ui-monospace, "SFMono-Regular", Consolas, monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  let ti = 0;
  for (let y = 0; y < rows; y++) {
    let first = -1;
    for (let x = 0; x < split[y] + 2; x++) {
      const i = (y * cols + x) * 4, a = px[i + 3] / 255; if (a < .35) continue;
      const L = px[i] / 255, cx = lx + x * cw + cw / 2, cy = ly + y * ch + ch / 2;
      if (first < 0) first = x;
      if (x >= split[y]) {   // две ячейки перед фото — крупные «пиксели»
        ctx.globalAlpha = .95; ctx.fillStyle = `rgb(${px[i]},${px[i + 1]},${px[i + 2]})`; ctx.fillRect(cx - cw / 2, cy - ch / 2, cw, ch); continue;
      }
      const t = Math.min(1, .12 + .95 * Math.pow(L, .75)), c = RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]; if (c === ' ') continue;
      ctx.globalAlpha = .45 + .55 * t; ctx.fillStyle = L > .7 ? '#FFFFFF' : L > .35 ? '#E2E2E2' : '#9AA8FF';
      ctx.fillText(c, cx, cy);
    }
    // 3) из ASCII-части влево выходят строки кода — не в каждой строке, тонко
    if (first >= 0 && r() < .32) {
      const minX = narrow ? cw : textR + 20, end = lx + first * cw - cw, len = Math.min(6 + Math.floor(r() * (narrow ? 12 : 30)), Math.floor((end - minX) / cw));
      const str = CODE.slice(ti % CODE.length) + CODE; ti += len + 3;
      for (let j = 0; j < len; j++) {   // строка читается слева направо и упирается в знак
        const c = str[j]; if (c === ' ') continue;
        ctx.globalAlpha = .6 * Math.pow((j + 1) / len, 1.5); ctx.fillStyle = '#C9C9CE'; ctx.fillText(c, end - (len - j) * cw + cw / 2, ly + y * ch + ch / 2);
      }
    }
  }
  ctx.globalAlpha = 1;
}
metal.complete ? art() : metal.onload = () => art();
document.fonts?.ready.then(() => art());
