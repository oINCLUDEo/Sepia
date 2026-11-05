// Проверка дашборда на демо-данных: страница открывается без ошибок в консоли, есть карточки нод, график, карта и журнал «Сутки».
// Запуск: node .github/ci/smoke.js (нужен пакет playwright с chromium)
const path = require('path');
const {chromium} = require('playwright');
(async () => {
  const errors = [];
  const b = await chromium.launch();
  for (const width of [1260, 390]) {
    const p = await b.newPage({viewport: {width, height: 900}});
    p.on('pageerror', e => errors.push(`${width}px: ${e.message}`));
    p.on('console', m => m.type() === 'error' && errors.push(`${width}px console: ${m.text()}`));
    await p.goto('file://' + path.resolve(__dirname, '../../stats/dashboard/index.html'));
    await p.waitForTimeout(2500);
    const got = await p.evaluate(() => ({
      cards: document.querySelectorAll('#nodes .card, #nodes article').length,
      day: document.querySelectorAll('#day .day-row').length,
      hero: document.querySelector('#k-conns')?.textContent.trim(),
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
    // все разделы открываются без ошибок, в каждом что-то нарисовано
    for (const v of ['day', 'charts', 'map', 'access', 'capacity', 'report']) {
      await p.click(`#tabs button[data-v="${v}"]`); await p.waitForTimeout(700);
      const n = await p.evaluate(v => [...document.querySelectorAll(`main > [data-view="${v}"]`)].reduce((a, s) => a + s.querySelectorAll('canvas, table, .day-row, .adv, .chart svg').length, 0), v);
      got[v] = n; if (!n) errors.push(`${width}px: раздел ${v} пустой`);
      if (v === 'charts') got.chart = await p.$$eval('#chart path', e => e.length);
    }
    await p.keyboard.press('Control+k'); await p.keyboard.type('se');
    got.search = await p.$$eval('.pal-item', e => e.length); if (!got.search) errors.push(`${width}px: поиск ничего не нашёл`);
    console.log(width + 'px', JSON.stringify(got));
    if (!got.cards) errors.push(`${width}px: нет карточек нод`);
    if (!got.chart) errors.push(`${width}px: график пустой`);
    if (!got.day) errors.push(`${width}px: нет полос «Сутки»`);
    if (!got.hero || got.hero === '—') errors.push(`${width}px: в шапке нет онлайна`);
    if (got.overflow > 1) errors.push(`${width}px: страница шире экрана на ${got.overflow}px`);
    await p.close();
  }
  await b.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('дашборд в порядке');
})();
