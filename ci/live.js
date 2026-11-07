// Дашборд в боевом режиме (не демо): страница открывается как /node-stats/dash/, ответы VictoriaMetrics и node-auth
// подставные. Демо-проверка (smoke.js) не проходит путь «запросы → разбор → ноды», и ошибка в нём ломала живую панель,
// а проверки оставались зелёными. Здесь: модель собирается без ошибок, у нод есть пик недели и CPU в пик, ёмкость рисуется
const {chromium} = require('playwright'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../stats/dashboard');
const TYPES = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
(async () => {
  const b = await chromium.launch(), p = await b.newPage({viewport: {width: 1300, height: 900}}), errors = [];
  p.on('pageerror', e => errors.push('страница: ' + e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 3).join(' / ')));
  const now = Math.floor(Date.now() / 1000), NODES = ['RU-Aeza-4', 'DE-Aeza'];
  await p.route('**/*', async r => {
    const u = new URL(r.request().url());
    if (u.pathname.startsWith('/node-stats/dash/')) {
      let f = path.join(ROOT, u.pathname.slice('/node-stats/dash/'.length)); if (f.endsWith('/') || f === ROOT) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) return r.fulfill({status: 404, body: ''});
      return r.fulfill({status: 200, body: fs.readFileSync(f), contentType: TYPES[path.extname(f)] || 'application/octet-stream'});
    }
    if (u.pathname === '/node-stats/auth/me') return r.fulfill({status: 204, body: ''});
    if (u.pathname.startsWith('/node-stats/auth/')) return r.fulfill({status: 501, body: '{}', contentType: 'application/json'});   // как сервер без RW_TOKEN и node-setup
    if (!u.pathname.startsWith('/node-stats/api/v1/')) return r.fulfill({status: 404, body: ''});
    const q = u.searchParams.get('query') || '', t = +(u.searchParams.get('time') || now), range = u.pathname.endsWith('query_range');
    let val = 5;
    if (q.includes('tmax_over_time') && q.includes('tx_mbps')) val = now - 2 * 86400;
    else if (q.includes('tmax_over_time')) val = now - 3 * 86400;
    else if (q.includes('[7d:5m]') && q.includes('tx_mbps')) val = 313;
    else if (q.includes('cpu_us{node=')) val = 41;
    else if (q.includes('tlast_over_time')) val = now - 30;
    const labels = n => ({node: n, cc: 'RU', ip: '10.0.0.' + n.length, from: 'all', proto: 'tcp', port: '443', proc: '-', uuid: 'u' + n, name: n, ver: 'abc', hop: '1', hip: 'none', target: 't', xver: '26.10.31'});
    const one = n => ({metric: labels(n), ...(range ? {values: Array.from({length: 5}, (_, i) => [now - (4 - i) * 86400, String(val)])} : {value: [t, String(val)]})});
    const result = q.includes('{node=') ? NODES.filter(n => q.includes(n)).map(one) : NODES.map(one);
    return r.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({status: 'success', data: {resultType: range ? 'matrix' : 'vector', result}})});
  });
  await p.goto('http://panel.test/node-stats/dash/');
  const got = await p.evaluate(async () => {
    try {
      const m = await loadLive();
      return {nodes: Object.values(m.nodes).map(n => ({name: n.name, busy: n.busy || null}))};
    } catch (e) { return {err: e.message + ' @ ' + (e.stack || '').split('\n')[1]}; }
  });
  if (got.err) errors.push('сборка данных: ' + got.err);
  else {
    if (got.nodes.length !== NODES.length) errors.push(`нод ${got.nodes.length}, ждали ${NODES.length}`);
    for (const n of got.nodes) if (!n.busy || n.busy.pk !== 313 || n.busy.cpu !== 41) errors.push(`${n.name}: нет пика недели или CPU в пик (${JSON.stringify(n.busy)})`);
  }
  await p.waitForTimeout(1500);
  await p.click('#tabs button[data-v="capacity"]').catch(() => errors.push('нет вкладки «Ёмкость»'));
  await p.waitForTimeout(500);
  const cap = await p.$eval('#cap', e => e.innerText).catch(() => '');
  if (!/41%/.test(cap)) errors.push('в «Ёмкости» нет CPU в пик');
  await b.close();
  if (errors.length) { for (const e of errors) console.log('  ' + e); process.exit(1); }
  console.log('боевой режим: данные собираются, пик недели и CPU в пик на месте');
})();
