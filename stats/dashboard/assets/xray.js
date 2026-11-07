'use strict';
// Xray на нодах (node-check xlog_minute, каждую минуту): версия ядра и счётчики журнала подключений.
//  — версия: разные версии в парке усложняют диагностику; 26.7.11–26.9.8 по умолчанию не пускали в REALITY клиентов
//    старше 26.3.27 (minClientVer, в 26.9.9 убрали) — «на одном телефоне работает, на другом нет»;
//  — «чужой ключ» (invalid request user id): нода не знает ключ клиента — старая подписка, пользователь вне сквада,
//    у моста опечатка в UUID выхода;
//  — «неверный REALITY» (processed invalid connection): не тот SNI / ключ / shortId — у клиентов или у моста к выходу
//    (так выглядела опечатка «ulya.spac»), или сканер; пишется только при loglevel info/debug;
//  — «подмена ответа» (received real certificate): по дороге ответ сервера подменили.

const XRAY_Q = {
  xl_ver: 'last_over_time(node_xlog_lines[30m])', xl_nolog: 'last_over_time(node_xlog_nolog[30m])',
  ...Object.fromEntries(['lines', 'acc', 'rej', 'uid', 'rbad', 'mitm'].map(k => ['xl_' + k, `sum by (node) (sum_over_time(node_xlog_${k}[15m]))`])),
  xl_ips: 'max by (node) (max_over_time(node_xlog_ips[15m]))',
  ...Object.fromEntries(['acc', 'rej', 'uid', 'rbad', 'mitm'].map(k => ['xd_' + k, `sum by (node) (sum_over_time(node_xlog_${k}[24h]))`])),
};
const XRAY_SLOW = ['xd_acc', 'xd_rej', 'xd_uid', 'xd_rbad', 'xd_mitm'];

function attachXray(nodes, keyOf, R){
  const val = (q, h) => { const s = (R[q] || []).find(x => x.metric.node === h); return s ? +s.value[1] : null; };
  const hosts = new Set([...(R.xl_ver || []), ...(R.xl_nolog || [])].map(s => s.metric.node));
  for (const h of hosts) {
    const n = nodes[keyOf[h]]; if (!n) continue;
    const vs = [...(R.xl_ver || []), ...(R.xl_nolog || [])].find(s => s.metric.node === h && s.metric.xver);
    const x = {ver: vs?.metric.xver || n.xr?.ver || '', nolog: val('xl_nolog', h) != null && val('xl_lines', h) == null};
    for (const k of ['lines', 'acc', 'rej', 'uid', 'rbad', 'mitm', 'ips']) x[k] = val('xl_' + k, h);
    for (const k of ['acc', 'rej', 'uid', 'rbad', 'mitm']) x['d_' + k] = val('xd_' + k, h);
    n.xr = x;
  }
}

// версия → число для сравнения: 26.7.28 → 260728
const xvNum = v => { const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/); return m ? +m[1] * 10000 + +m[2] * 100 + +m[3] : null; };
const xvMinClient = v => { const x = xvNum(v); return x != null && x >= 260711 && x < 260909; };

// что не так с Xray у ноды: [{k, t, p}] — для карточки и общей сводки
function xrayIssues(n){
  const x = n.xr, out = []; if (!x) return out;
  if (x.nolog) out.push({k: 'info', t: 'журнал подключений Xray не найден', p: 'Счётчики отказов не работают. Включите журнал в профиле: "log": {"loglevel": "warning"} без "access": "none".'});
  else if (x.lines === 0 && (n.panel?.users || 0) > 0) out.push({k: 'info', t: 'Xray не пишет журнал подключений', p: 'Пользователи онлайн, а строк за 15 минут нет — в профиле, похоже, "access": "none". Без журнала не видно отказов.'});
  if (xvMinClient(x.ver)) out.push({k: 'warn', t: `Xray ${x.ver} не пускает старые приложения`, p: 'В 26.7.11–26.9.8 REALITY по умолчанию отклоняет клиентов старше 26.3.27 — у части пользователей «подключено, но не работает». Обновите ядро до 26.9.9 или новее.'});
  if (x.uid >= 30 && x.uid > .05 * (x.acc || 0)) out.push({k: 'warn', t: `${fmt(x.uid)} подключений с незнакомым ключом за 15 минут`, p: 'Нода не знает ключ: у клиентов старая подписка (лимит устройств, не обновили после перевыпуска), пользователь выпал из сквада, или у моста к этой ноде неверный UUID.'});
  if (x.rbad >= 30) out.push({k: 'warn', t: `${fmt(x.rbad)} неверных REALITY-подключений за 15 минут`, p: 'Не тот SNI, ключ или shortId — у моста к этому выходу (опечатка в адресе) или у клиентов; либо сервер сканируют. Ищите IP в журнале: docker exec remnanode grep "processed invalid" /var/log/xray/current | tail'});
  if (x.mitm > 0) out.push({k: 'warn', t: 'Ответ сервера подменили по дороге', p: 'REALITY получил настоящий сертификат сайта вместо нашего — между клиентом и нодой кто-то перехватывает соединение.'});
  return out;
}

// сводка над нодами: версии ядра в парке и ноды с проблемами Xray
function xrayNote(){
  const live = Object.values(state.model.nodes).filter(n => state.st[n.key]?.cat !== 'off' && n.xr);
  if (!live.length) return '';
  const byVer = {}; for (const n of live) if (n.xr.ver) (byVer[n.xr.ver] ||= []).push(n);
  const vers = Object.keys(byVer).sort((a, b) => xvNum(b) - xvNum(a)), main = vers.slice().sort((a, b) => byVer[b].length - byVer[a].length)[0];
  const names = l => l.map(n => esc(n.name)).join(', '), lines = [];
  const old = vers.filter(v => xvMinClient(v));
  if (old.length) lines.push(`<p><b>Xray ${old.map(esc).join(', ')}</b> не пускает старые приложения: ${names(old.flatMap(v => byVer[v]))}. Обновите ядро до 26.9.9 или новее.</p>`);
  if (vers.length > 1) lines.push(`<p><b>Разные версии Xray</b>: ${vers.map(v => `${esc(v)} — ${v === main ? `${byVer[v].length} ${plural(byVer[v].length, 'нода', 'ноды', 'нод')}` : names(byVer[v])}`).join('; ')}.</p>`);
  const bad = live.filter(n => xrayIssues(n).some(i => i.k === 'warn' && !/^Xray /.test(i.t)));
  if (bad.length) lines.push(`<p><b>Отказы в журнале Xray</b>: ${bad.map(n => `${esc(n.name)} — ${esc(xrayIssues(n).find(i => i.k === 'warn' && !/^Xray /.test(i.t)).t)}`).join('; ')}. Подробности в карточке ноды.</p>`);
  return lines.length ? `<div class="vernote">${lines.join('')}</div>` : '';
}

// карточка ноды, вкладка «Проверки»
function drawerXray(n){
  const x = n.xr; if (!x) return '';
  const row = (k, l, v) => `<li class="s-${k}"><span>${l}</span><b>${v}</b></li>`, iss = xrayIssues(n);
  const q = v => v == null ? '—' : `${fmt(v)} <small>за 15 мин</small>`;
  const day = [x.d_acc != null && `${fmt(x.d_acc)} ${plural(Math.round(x.d_acc), 'подключение', 'подключения', 'подключений')}`, x.d_uid && `${fmt(x.d_uid)} с незнакомым ключом`,
    x.d_rbad && `${fmt(x.d_rbad)} неверных REALITY`, x.d_rej && `${fmt(x.d_rej)} отклонено`, x.d_mitm && `${fmt(x.d_mitm)} подмен`].filter(Boolean);
  return `<div class="dr-sec"><h3>Xray<span>журнал подключений, каждую минуту</span></h3><ul class="checks">
    ${row(xvMinClient(x.ver) ? 'warn' : x.ver ? 'ok' : 'off', 'Версия ядра', x.ver ? esc(x.ver) : 'не определена')}
    ${x.nolog ? row('off', 'Журнал', 'не найден') : `
    ${row('ok', 'Подключений', q(x.acc))}
    ${x.ips ? row('ok', 'Разных адресов', `${fmt(x.ips)} <small>в минуту</small>`) : ''}
    ${row(x.uid >= 30 && x.uid > .05 * (x.acc || 0) ? 'warn' : 'ok', 'Незнакомый ключ', q(x.uid))}
    ${row(x.rbad >= 30 ? 'warn' : x.rbad || x.d_rbad ? 'ok' : 'off', 'Неверный REALITY', q(x.rbad))}
    ${x.mitm || x.d_mitm ? row('err', 'Подмена ответа', q(x.mitm)) : ''}`}
  </ul>${day.length ? `<p class="dr-foot">За сутки: ${day.join(', ')}.${!x.rbad && !x.d_rbad ? ' «Неверный REALITY» Xray пишет только при loglevel info.' : ''}</p>` : ''}${iss.map(i => `<div class="risk${i.k === 'info' ? ' info' : ''}">${icon(i.k === 'info' ? 'info' : 'shield-alert', 'si')}<div><b>${esc(i.t)}</b><p>${esc(i.p)}</p></div></div>`).join('')}</div>`;
}

function demoXray(nodes){
  let i = 0;
  for (const n of Object.values(nodes)) {
    if (n.seen == null) continue;
    const ver = n.name === 'RU-Aeza-3' || n.name === 'RU-Aeza' ? '26.7.28' : '26.10.31', acc = 400 + (i * 137) % 2600;
    n.xr = {ver, lines: acc + 20, acc, rej: n.name === 'EE-INTEZIO' ? 64 : 3, uid: n.name === 'EE-INTEZIO' ? 58 : i % 3, rbad: 0, mitm: 0, ips: 40 + (i * 29) % 300,
      d_acc: acc * 96, d_rej: 210, d_uid: n.name === 'EE-INTEZIO' ? 980 : 12, d_rbad: 0, d_mitm: 0};
    i++;
  }
}
