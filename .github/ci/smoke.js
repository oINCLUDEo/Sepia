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
      chart: document.querySelectorAll('#chart path').length,
      day: document.querySelectorAll('#day .day-row').length,
      hero: document.querySelector('#k-conns')?.textContent.trim(),
      overflow: document.documentElement.scrollWidth - innerWidth,
    }));
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
