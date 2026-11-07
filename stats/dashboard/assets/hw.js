'use strict';
// Железо нод (node-check hw_report, раз в 6 часов): модель CPU, ядра, AES-NI, виртуализация, RAM, swap, диск.
// Как учитывается:
//  — «Ёмкость»: только замер — самые нагруженные 5 минут недели и загрузка процессора в эти же 5 минут.
//    Никаких прямых и продолжений за пределы того, что нода уже делала; советы — мало памяти, нет swap, нет AES-NI, кончается диск;
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
  // пик недели и процессор в тот же момент — data.js busyOf
  const B = R._busy || {};
  state.busyErr = B._err || (Object.keys(nodes).length && !Object.keys(B).length ? 'VictoriaMetrics вернула пустой ответ на запрос пика недели' : '');
  for (const [h, L] of Object.entries(B)) {
    const n = nodes[keyOf[h]]; if (!n || h === '_err' || !(L.pk >= 0)) continue;
    if (!n.busy || n.busy.pk < L.pk) n.busy = L;
  }
  for (const [h, x] of Object.entries(F.hw_mem7)) { const n = nodes[keyOf[h]]; if (n) (n.hw ||= {}).mem7 ??= x.v; }
}

// потолок процессора: 85% от того, что оставляет хостер — при steal S% нашим процессам доступно только (100 − S)%
const cpuLim = L => CPU_MAX * (1 - (L?.st > 5 ? Math.min(L.st, 90) : 0) / 100);
// сколько примерно потянет процессор: в пик P Мбит/с при C% CPU, фон B% (тихие 10% недели) → с трафиком растёт C − B,
// до потолка: P·(потолок − B)/(C − B). Считаем, только если трафик реально нагрузил процессор — C − B ≥ 10% и C ≥ 25%:
// иначе продолжение — уже гадание, честно «запас большой»
const CPU_MIN_FOR_EST = 25;
const cpuCap = n => {
  const L = n.busy; if (!L || !(L.pk > 0) || L.cpu == null || L.cpu < CPU_MIN_FOR_EST) return null;
  const bg = Math.max(0, Math.min(L.bg ?? 0, L.cpu)), lim = cpuLim(L);
  return L.cpu - bg >= 10 && lim > bg ? L.pk * (lim - bg) / (L.cpu - bg) : null;
};
const gb = mb => { if (mb == null) return '—'; if (mb < 1000) return `${fmt(mb)} МБ`; const g = mb / 1024; return `${fmt(g, g < 10 && Math.abs(g - Math.round(g)) > .05 ? 1 : 0)} ГБ`; };
const dtShort = t => new Date(t * 1000).toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
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
    ${n.busy?.cpu != null ? row(n.busy.cpu >= CPU_MAX ? 'err' : n.busy.cpu >= 60 ? 'warn' : 'ok', 'CPU в пик недели', `${fmt(n.busy.cpu)}% при ${fmt(n.busy.pk)} Мбит/с`) : ''}
    ${n.busy?.cpu != null ? row('ok', 'Потянет по CPU', cc ? `≈${fmt(cc)} Мбит/с` : 'запас большой') : ''}
    ${h.virt ? row('off', 'Виртуализация', esc(h.virt)) : ''}
  </ul>${n.busy?.at ? `<p class="dr-foot">Пик недели — ${esc(dtShort(n.busy.at))}: самые нагруженные 5 минут и загрузка процессора в эти же минуты.${n.busy.cpuMax - n.busy.cpu >= 15 ? ` Максимум CPU за неделю — ${fmt(n.busy.cpuMax)}% (${esc(dtShort(n.busy.cpuMaxAt))}), не в пик трафика: процессор грузило что-то ещё.` : ''}${cc ? ' «Потянет» — пик × 85% ÷ CPU в пик: так считается, если процессор растёт вместе с трафиком; фон с трафиком не растёт, так что это скорее нижняя граница.' : ''}</p>` : ''}</div>`;
}

function demoHw(nodes){
  const now = Date.now() / 1000;
  const SPEC = {'DE-Aeza-2': ['AMD Ryzen 9 7950X', 2, 2048, 1024, 30, 21, 1, 1.1], 'SE-Aeza': ['AMD Ryzen 9 7950X', 2, 2048, 1024, 30, 1.4, 1, 1.3],
    'EE-INTEZIO': ['Intel Xeon E5-2680 v4', 1, 1024, 0, 20, 12, 1, 1.9], 'EE-StenCloud': ['Common KVM processor', 2, 4096, 1024, 40, 30, 1, .9],
    'NL-TurtleGuard': ['AMD EPYC 7763', 4, 8192, 2048, 80, 61, 1, .5], 'RU-Aeza': ['Intel Xeon Gold 6248R', 2, 2048, 1024, 25, 17, 1, .6],
    'RU-RuVDS': ['Intel Xeon E5-2650 v2', 2, 768, 0, 15, 9, 0, 1.6]};
  for (const n of Object.values(nodes)) {
    const s = SPEC[n.name]; if (!s || n.seen == null) continue;
    n.hw = {at: now - 3 * 3600, cpu: s[0], virt: 'kvm', cores: s[1], mhz: 2900, ram: s[2], swap: s[3], disk: s[4], dfree: s[5], aes: s[6],
      mem7: n.name === 'EE-INTEZIO' ? 93 : n.name === 'RU-RuVDS' ? 71 : 40 + s[1] * 5};
    const pk = Math.max(0, ...(n.peaks || []).slice(-7).map(p => p[1]));
    if (pk) n.busy = {pk, at: now - 2 * 86400 + 20 * 3600, cpu: Math.min(97, Math.round(6 + pk * s[7] * .35)), st: 1, cpuMax: Math.min(97, Math.round(6 + pk * s[7] * .35)), cpuMaxAt: now - 86400};
  }
}
