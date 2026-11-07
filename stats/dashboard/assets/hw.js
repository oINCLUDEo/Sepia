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
  const [cr, tr, kr, sr] = R._cpuTx || [], ser = r => Object.fromEntries((r || []).map(s => [s.metric.node, new Map(s.values.map(([t, v]) => [+t, +v]))]));
  const CS = ser(cr), TS = ser(tr), KS = ser(kr), SS = ser(sr), idle = {};
  for (const [h, txm] of Object.entries(TS)) {
    const n = nodes[keyOf[h]], cm = CS[h]; if (!n || !cm) continue;
    // точки [Мбит/с, CPU %, соединений, steal %]
    // ночь 03:00–05:59 МСК не берём: ночная проверка грузит CPU (sysbench) и канал (iperf3) — это не пользователи
    const pts = [...txm].filter(([t]) => cm.has(t) && new Date(t * 1000).getUTCHours() >= 3).map(([t, x]) => [x, cm.get(t), KS[h]?.get(t), SS[h]?.get(t)]);
    const fit = cpuFit(pts);
    if (fit) (n.hw ||= {}).fit = fit;
    else if (pts.length >= 24) {   // для оценки по похожим: фон CPU и самая нагруженная своя точка (оценка не может быть меньше факта)
      const ok = pts.filter(p => p[1] < CPU_MAX && !(p[3] > STEAL_MAX)), top = ok.reduce((m, p) => p[0] > m[0] ? p : m, [0, 0]);
      idle[n.key] = {a: pts.map(p => p[1]).sort((a, b) => a - b)[Math.floor(pts.length * .1)], top};
    }
  }
  cpuPrior(nodes, idle);
  for (const [h, x] of Object.entries(F.hw_mem7)) { const n = nodes[keyOf[h]]; if (n) (n.hw ||= {}).mem7 ??= x.v; }
}

// CPU = a + b·трафик (+ c·тысяч соединений) по 15-минутным точкам [Мбит/с, CPU %, соединений, steal %]; предел — где
// CPU доходит до CPU_MAX.
//  — точки со steal > 8% выбрасываем: в это время процессор отбирали соседи по хостеру, а не наши пользователи —
//    по ним кажется, что мегабит дороже, и предел занижается;
//  — соединения: процессор тратится и на них (рукопожатия TLS, conntrack), не только на мегабиты. Учитываем, если
//    число соединений менялось не в такт трафику (иначе их вклад от трафика не отделить). В прогнозе соединения
//    растут вместе с трафиком так же, как в часы нагрузки (соединений на Мбит/с у самых нагруженных точек);
//  — не оцениваем, если трафик почти не менялся, точки не ложатся на модель (r² < 0.3) или CPU от трафика не растёт
const STEAL_MAX = 8;
function cpuFit(pts){
  const all = pts.filter(([x, y]) => isFinite(x) && isFinite(y) && x >= 0);
  pts = all.filter(p => !(p[3] > STEAL_MAX));
  const dropped = all.length - pts.length;
  if (pts.length < 48) return null;
  const xs = pts.map(p => p[0]).sort((a, b) => a - b), q = f => xs[Math.floor(f * (xs.length - 1))];
  if (q(.95) < 20 || q(.9) - q(.1) < 10) return null;
  const n = pts.length, mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0; for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (!sxx || !syy) return null;
  let b = sxy / sxx, a = my - b * mx, r2 = sxy * sxy / (sxx * syy), c = 0, kpm = 0;
  // вторая переменная — тысячи соединений
  const pk = pts.filter(p => isFinite(p[2])).map(p => [p[0], p[1], p[2] / 1000]);
  if (pk.length >= 48) {
    const m = pk.length, Mx = pk.reduce((s, p) => s + p[0], 0) / m, My = pk.reduce((s, p) => s + p[1], 0) / m, Mk = pk.reduce((s, p) => s + p[2], 0) / m;
    let xx = 0, kk = 0, xk = 0, xy = 0, ky = 0, yy = 0;
    for (const [x, y, k] of pk) { const dx = x - Mx, dy = y - My, dk = k - Mk; xx += dx * dx; kk += dk * dk; xk += dx * dk; xy += dx * dy; ky += dk * dy; yy += dy * dy; }
    const det = xx * kk - xk * xk, corr = xx && kk ? xk / Math.sqrt(xx * kk) : 1;
    if (det > 0 && Math.abs(corr) < .9) {
      const b2 = (xy * kk - ky * xk) / det, c2 = (ky * xx - xy * xk) / det, a2 = My - b2 * Mx - c2 * Mk;
      const res = pk.reduce((s, [x, y, k]) => s + (y - a2 - b2 * x - c2 * k) ** 2, 0), r22 = yy ? 1 - res / yy : 0;
      if (b2 > 0 && c2 > 0 && r22 >= r2) {
        // соединений на Мбит/с в часы нагрузки (верхняя пятая часть точек по трафику)
        const top = pk.slice().sort((p, q2) => q2[0] - p[0]).slice(0, Math.max(5, Math.floor(m / 5))).filter(p => p[0] > 0);
        kpm = top.map(p => p[2] / p[0]).sort((u, v) => u - v)[Math.floor(top.length / 2)] || 0;
        b = b2; a = a2; c = c2; r2 = r22;
      }
    }
  }
  if (b <= 0 || r2 < .3) return null;
  // прямая не должна спорить с фактом: отдавала X Мбит/с при Y% CPU → до CPU_MAX дотянет X·CPU_MAX/Y
  // (без учёта фоновой загрузки — осторожная оценка, но она уже больше пика)
  const okPts = pts.filter(([, y]) => y < CPU_MAX), top = okPts.reduce((m, p) => p[0] > m[0] ? p : m, [0, 0]);
  const line = (CPU_MAX - Math.max(a, 0)) / (b + c * kpm), prop = top[0] > 0 ? top[0] * CPU_MAX / Math.max(top[1], 5) : 0;
  const cap = Math.max(line, prop);
  return cap > 0 ? {a, b, c, kpm, r2, cap, xmax: xs.at(-1), by: prop > line ? 'point' : 'line', at: top.slice(0, 2), dropped, n} : null;
}

// C4: нода, для которой своей оценки нет (нагрузка ещё не менялась), — оценка по похожим: сколько «процентов ядра»
// стоит 1 Мбит/с у нод с оценкой (с поправкой на скорость ядра по sysbench), на ядра этой ноды. Берём ноды той же роли
// (мост / выход), если их хотя бы две, иначе все; нужно минимум две ноды с собственной оценкой
function cpuPrior(nodes, idle){
  const all = Object.values(nodes), fitted = all.filter(n => n.hw?.fit && n.hw.fit.by !== 'pool' && n.hw.cores);
  // «процентов CPU на Мбит/с» берём из самого предела: он мог прийти и из прямой, и из самой нагруженной точки
  const work = (n, sp) => { const f = n.hw.fit; return (CPU_MAX - Math.max(f.a, 0)) / f.cap * n.hw.cores * (sp ? n.full.cpu : 1); };
  for (const n of all) {
    if (n.hw?.fit || !n.hw?.cores || n.seen == null) continue;
    const same = fitted.filter(x => !!x.bridge === !!n.bridge), pool = same.length >= 2 ? same : fitted;
    if (pool.length < 2) continue;
    const speed = n.full?.cpu > 0 && pool.every(x => x.full?.cpu > 0);   // поправка на скорость ядра — только если sysbench есть у всех
    const ws = pool.map(x => work(x, speed)).sort((u, v) => u - v), w = ws[Math.floor(ws.length / 2)];
    const own = idle[n.key], slope = w / n.hw.cores / (speed ? n.full.cpu : 1), a = Math.min(own?.a ?? 5, 40);
    if (!(slope > 0)) continue;
    const fact = own?.top[0] > 0 ? own.top[0] * CPU_MAX / Math.max(own.top[1], 5) : 0;
    n.hw.fit = {a, b: slope, c: 0, kpm: 0, r2: null, cap: Math.max((CPU_MAX - a) / slope, fact), by: 'pool', pool: pool.map(x => x.name), speed};
  }
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
    ${cc ? row(n.full?.ip && !n.ipLow && cc < n.full.ip ? 'warn' : 'ok', 'Протянет по CPU', `≈ ${fmt(cc)} Мбит/с${n.hw.fit.by === 'point' ? ` (по точке: ${fmt(n.hw.fit.at[0])} Мбит/с при ${fmt(n.hw.fit.at[1])}% CPU)` : n.hw.fit.by === 'pool' ? ` — оценка по похожим: ${esc(n.hw.fit.pool.join(', '))}` : n.hw.fit.c ? ` (с учётом соединений)` : ''}${n.full?.ip && !n.ipLow ? ` · канал ${fmt(n.full.ip)}` : ''}`) : ''}
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
