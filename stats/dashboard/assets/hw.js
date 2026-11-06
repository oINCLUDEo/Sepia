'use strict';
// Железо нод (node-check hw_report, раз в 6 часов): модель CPU, ядра, AES-NI, виртуализация, RAM, swap, диск.
// Как учитывается:
//  — «Ёмкость»: сколько Мбит/с нода протянет по CPU — прямая «трафик → CPU» по 15-минутным точкам за 7 дней:
//    фоновая загрузка (соединения, Docker) отделяется, считается только прирост CPU на каждый Мбит/с; если предел
//    меньше канала, прогноз «упрётся» считается по CPU. Мало разброса трафика или точки не ложатся на прямую — не оцениваем; советы — мало памяти, нет swap, нет AES-NI, кончается диск;
//  — одинаковый CPU у разных нод: заметно медленнее остальных (sysbench) — хостер перепродаёт ядра;
//  — карточка ноды («Проверки») и столбец «Железо» в таблице ёмкости

const HW_Q = {
  hw_cores: 'last_over_time(node_hw_cores[2d])', hw_mhz: 'last_over_time(node_hw_mhz[2d])', hw_ram: 'last_over_time(node_hw_ram_mb[2d])',
  hw_swap: 'last_over_time(node_hw_swap_mb[2d])', hw_disk: 'last_over_time(node_hw_disk_gb[2d])', hw_dfree: 'last_over_time(node_hw_disk_free_gb[2d])',
  hw_aes: 'last_over_time(node_hw_aes[2d])', hw_at: 'tlast_over_time(node_hw_cores[2d])',
  hw_mem7: 'max by (node) (max_over_time(node_quick_mem_pct[7d]))',
};
const CPU_MAX = 85;   // «упёрлась в CPU» — 85% всего процессора (дальше растут задержки)
const HIDDEN_CPU = /^(common kvm|qemu virtual|virtual|unknown)/i;   // хостер прячет настоящую модель

function attachHw(nodes, keyOf, R){
  const by = q => { const o = {}; for (const s of R[q] || []) o[s.metric.node] = {v: +s.value[1], m: s.metric}; return o; };
  const at = by('hw_at'), F = Object.fromEntries(['hw_cores', 'hw_mhz', 'hw_ram', 'hw_swap', 'hw_disk', 'hw_dfree', 'hw_aes', 'hw_mem7'].map(q => [q, by(q)]));
  for (const [h, x] of Object.entries(at)) {
    const n = nodes[keyOf[h]]; if (!n || (n.hw && n.hw.at >= x.v)) continue;
    const v = q => F[q][h]?.v ?? null, lab = F.hw_cores[h]?.m || {};
    n.hw = {at: x.v, cpu: (lab.cpu || '').replace(/\\/g, ''), virt: lab.virt || '', cores: v('hw_cores'), mhz: v('hw_mhz'), ram: v('hw_ram'), swap: v('hw_swap'),
      disk: v('hw_disk'), dfree: v('hw_dfree'), aes: v('hw_aes'), mem7: v('hw_mem7')};
  }
  // предел по CPU и пик памяти нужны и нодам без свежего hw_report
  const [cr, tr] = R._cpuTx || [[], []], ser = r => Object.fromEntries((r || []).map(s => [s.metric.node, new Map(s.values.map(([t, v]) => [+t, +v]))]));
  const CS = ser(cr), TS = ser(tr);
  for (const [h, txm] of Object.entries(TS)) {
    const n = nodes[keyOf[h]], cm = CS[h]; if (!n || !cm) continue;
    const fit = cpuFit([...txm].filter(([t]) => cm.has(t)).map(([t, x]) => [x, cm.get(t)]));
    if (fit) (n.hw ||= {}).fit = fit;
  }
  for (const [h, x] of Object.entries(F.hw_mem7)) { const n = nodes[keyOf[h]]; if (n) (n.hw ||= {}).mem7 ??= x.v; }
}

// прямая CPU = a + b·трафик по точкам [Мбит/с, CPU %]; предел — где она доходит до CPU_MAX.
// Не оцениваем, если трафик почти не менялся (прямую не построить), точки не ложатся на прямую (r² < 0.3)
// или CPU от трафика не растёт
function cpuFit(pts){
  pts = pts.filter(([x, y]) => isFinite(x) && isFinite(y) && x >= 0);
  if (pts.length < 48) return null;
  const xs = pts.map(p => p[0]).sort((a, b) => a - b), q = f => xs[Math.floor(f * (xs.length - 1))];
  if (q(.95) < 20 || q(.9) - q(.1) < 10) return null;
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (!sxx || !syy) return null;
  const b = sxy / sxx, a = my - b * mx, r2 = sxy * sxy / (sxx * syy);
  if (b <= 0 || r2 < .3) return null;
  // прямая не должна спорить с фактом. Раньше нижней границей был сам наибольший трафик при CPU < предела —
  // тогда предел совпадал с пиком и «занят в пик» выходил ровно 100%, хотя процессор был загружен, например, на 50%.
  // Теперь граница — пропорция от этой точки: отдавала X Мбит/с при Y% CPU → до CPU_MAX дотянет X·CPU_MAX/Y
  // (без учёта фоновой загрузки — это заниженная, осторожная оценка, но она уже больше пика)
  const okPts = pts.filter(([, y]) => y < CPU_MAX), top = okPts.reduce((m, p) => p[0] > m[0] ? p : m, [0, 0]);
  const line = (CPU_MAX - Math.max(a, 0)) / b, prop = top[0] > 0 ? top[0] * CPU_MAX / Math.max(top[1], 5) : 0;
  const cap = Math.max(line, prop);
  return cap > 0 ? {a, b, r2, cap, xmax: xs.at(-1), by: prop > line ? 'point' : 'line', at: top} : null;
}
// сколько Мбит/с нода протянет, пока CPU не дойдёт до CPU_MAX
const cpuCap = n => n.hw?.fit?.cap ?? null;
const gb = mb => { if (mb == null) return '—'; if (mb < 1000) return `${fmt(mb)} МБ`; const g = mb / 1024; return `${fmt(g, g < 10 && Math.abs(g - Math.round(g)) > .05 ? 1 : 0)} ГБ`; };
const cpuName = h => !h?.cpu ? '' : HIDDEN_CPU.test(h.cpu) ? 'модель скрыта хостером' : h.cpu;
const hwShort = n => { const h = n.hw; if (!h?.cores) return ''; return `${fmt(h.cores)} CPU · ${gb(h.ram)}`; };

// советы по железу для «Ёмкости»
function hwAdvice(){
  const N = state.model.nodes, out = [], live = Object.values(N).filter(n => state.st[n.key]?.cat !== 'off' && n.seen != null && n.hw);
  for (const n of live) {
    const h = n.hw;
    if (h.mem7 != null && h.mem7 >= 90) out.push({k: h.mem7 >= 97 ? 'err' : 'warn', ic: 'memory-stick', key: n.key, t: `${n.name}: память в пик занята на ${fmt(h.mem7)}%${h.ram ? ` из ${gb(h.ram)}` : ''}`,
      p: h.swap ? 'Xray и Docker могут упасть по нехватке памяти — возьмите тариф с RAM побольше.' : 'Swap нет: при нехватке памяти ядро убьёт Xray. Включите swap (tune-kernel.sh делает 1 ГБ) или возьмите тариф с RAM побольше.'});
    else if (h.ram != null && h.ram < 900) out.push({k: 'warn', ic: 'memory-stick', key: n.key, t: `${n.name}: всего ${gb(h.ram)} RAM`, p: 'Для Xray с Docker и тысяч соединений этого впритык — при росте пользователей начнутся падения. Нужен хотя бы 1 ГБ и swap.'});
    else if (h.ram != null && h.ram < 2048 && h.swap === 0) out.push({k: 'info', ic: 'memory-stick', key: n.key, t: `${n.name}: ${gb(h.ram)} RAM и нет swap`, p: 'При всплеске соединений ядро может убить Xray. Включите swap: sudo bash tune-kernel.sh.'});
    if (h.aes === 0) out.push({k: 'warn', ic: 'cpu', key: n.key, t: `${n.name}: у процессора нет AES-NI`, p: 'TLS и Reality шифруются программно — CPU кончится намного раньше канала. Для выхода лучше другой тариф или хостер.'});
    if (h.dfree != null && h.disk && (h.dfree < 2 || h.dfree / h.disk < .08)) out.push({k: h.dfree < 1 ? 'err' : 'warn', ic: 'hard-drive', key: n.key, t: `${n.name}: на диске осталось ${fmt(h.dfree)} ГБ из ${fmt(h.disk)}`,
      p: 'Кончится место — перестанут писаться журналы и обновляться пакеты, Docker не запустит контейнер. Почистите: docker system prune, journalctl --vacuum-size=200M.'});
  }
  // один и тот же CPU: одно ядро заметно медленнее, чем у других нод с ним же — хостер перепродаёт процессор
  const same = {};
  for (const n of live) if (n.hw.cpu && !HIDDEN_CPU.test(n.hw.cpu) && n.full?.cpu > 0) (same[n.hw.cpu] ||= []).push(n);
  for (const [cpu, ns] of Object.entries(same)) {
    if (ns.length < 2) continue;
    const best = Math.max(...ns.map(n => n.full.cpu));
    for (const n of ns) if (n.full.cpu < best * .7) {
      const top = ns.find(x => x.full.cpu === best);
      out.push({k: 'info', ic: 'cpu', key: n.key, t: `${n.name}: ядро на ${fmt(100 - n.full.cpu / best * 100)}% медленнее, чем у ${top.name} на том же ${cpu}`,
        p: 'Процессор одинаковый, значит его делят с соседями: хостер перепродаёт ядра. Смотрите на steal; если он растёт — переезжайте.'});
    }
  }
  return out;
}

// карточка ноды, вкладка «Проверки»
function drawerHw(n){
  const h = n.hw; if (!h?.cores) return '';
  const cc = cpuCap(n), row = (k, l, v) => `<li class="s-${k}"><span>${l}</span><b>${v}</b></li>`;
  return `<div class="dr-sec"><h3>Железо<span>${ago(h.at)}</span></h3><ul class="checks">
    ${row(HIDDEN_CPU.test(h.cpu || '') ? 'off' : 'ok', 'Процессор', `${esc(cpuName(h) || '—')}${h.mhz ? `, ${fmt(h.mhz / 1000, 1)} ГГц` : ''}`)}
    ${row(h.cores >= 2 ? 'ok' : 'warn', 'Ядер', fmt(h.cores))}
    ${row(h.aes === 0 ? 'warn' : 'ok', 'AES-NI', h.aes === 0 ? 'нет — шифрование медленное' : 'есть')}
    ${row(h.ram != null && h.ram < 900 ? 'warn' : 'ok', 'Память', `${gb(h.ram)}${h.mem7 != null ? `, в пик за неделю ${fmt(h.mem7)}%` : ''}`)}
    ${row(h.swap ? 'ok' : h.ram != null && h.ram < 2048 ? 'warn' : 'off', 'Swap', h.swap ? gb(h.swap) : 'нет')}
    ${h.disk ? row(h.dfree != null && h.dfree < 2 ? 'err' : 'ok', 'Диск', `${fmt(h.dfree)} ГБ свободно из ${fmt(h.disk)}`) : ''}
    ${cc ? row(n.full?.ip && !n.ipLow && cc < n.full.ip ? 'warn' : 'ok', 'Протянет по CPU', `≈ ${fmt(cc)} Мбит/с${n.hw.fit.by === 'point' ? ` (по точке: ${fmt(n.hw.fit.at[0])} Мбит/с при ${fmt(n.hw.fit.at[1])}% CPU)` : ''}${n.full?.ip && !n.ipLow ? ` · канал ${fmt(n.full.ip)}` : ''}`) : ''}
    ${h.virt ? row('off', 'Виртуализация', esc(h.virt)) : ''}
  </ul></div>`;
}

function demoHw(nodes){
  const now = Date.now() / 1000;
  const SPEC = {'DE-Aeza-2': ['AMD Ryzen 9 7950X', 2, 2048, 1024, 30, 21, 1, 1.1], 'SE-Aeza': ['AMD Ryzen 9 7950X', 2, 2048, 1024, 30, 1.4, 1, 1.3],
    'EE-INTEZIO': ['Intel Xeon E5-2680 v4', 1, 1024, 0, 20, 12, 1, 1.9], 'EE-StenCloud': ['Common KVM processor', 2, 4096, 1024, 40, 30, 1, .9],
    'NL-TurtleGuard': ['AMD EPYC 7763', 4, 8192, 2048, 80, 61, 1, .5], 'RU-Aeza': ['Intel Xeon Gold 6248R', 2, 2048, 1024, 25, 17, 1, .6],
    'RU-RuVDS': ['Intel Xeon E5-2650 v2', 2, 768, 0, 15, 9, 0, 1.6]};
  for (const n of Object.values(nodes)) {
    const s = SPEC[n.name]; if (!s || n.seen == null) continue;
    n.hw = {at: now - 3 * 3600, cpu: s[0], virt: 'kvm', cores: s[1], mhz: 2900, ram: s[2], swap: s[3], disk: s[4], dfree: s[5], aes: s[6], fit: {a: 8, b: s[7], r2: .8, cap: (CPU_MAX - 8) / s[7]},
      mem7: n.name === 'EE-INTEZIO' ? 93 : n.name === 'RU-RuVDS' ? 71 : 40 + s[1] * 5};
  }
}
