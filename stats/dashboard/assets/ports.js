'use strict';
// Порты и фаервол ноды: что разрешает фаервол Sepia (всем / с каких IP / закрыт), кто слушает порт, открыт ли он
// снаружи на самом деле (сервер панели стучится сам). Правка — через node-setup по SSH: пароль root и пароль
// администратора, новые правила применяются с проверкой нового SSH-подключения и порта панели, иначе откат через 2 минуты

const PORTS_Q = {fw_allow: 'last_over_time(node_fw_allow[2d])', fw_listen: 'last_over_time(node_fw_listen[2d])', fw_run: 'last_over_time(node_fw_run[2d])',
  fwm_managed: 'last_over_time(node_fwmeta_managed[2d])', fwm_run: 'last_over_time(node_fwmeta_run[2d])'};
function attachPorts(nodes, keyOf, R){
  const runs = {};
  for (const s of R.fwm_run || []) { const h = s.metric.node, v = +s.value[1]; if (!runs[h] || v > runs[h]) runs[h] = v; }
  const val = (q, s) => (R[q] || []).find(x => x.metric.node === s.metric.node && x.metric.port === s.metric.port && x.metric.proto === s.metric.proto && x.metric.from === s.metric.from)?.value[1];
  for (const [h, run] of Object.entries(runs)) {
    const n = nodes[keyOf[h]]; if (!n || (n.fw && n.fw.at >= run)) continue;
    const managed = (R.fwm_managed || []).find(x => x.metric.node === h);
    n.fw = {at: run, managed: managed ? +managed.value[1] === 1 : null, ports: []};
    for (const s of R.fw_run || []) {
      if (s.metric.node !== h || +s.value[1] !== run) continue;
      const f = s.metric.from;
      n.fw.ports.push({proto: s.metric.proto, port: s.metric.port, from: f === 'all' ? 'all' : f === 'none' ? 'none' : f.split('+'), proc: s.metric.proc === '-' ? '' : s.metric.proc,
        listen: +(val('fw_listen', s) ?? 0) === 1});
    }
    n.fw.ports.sort((a, b) => parseInt(a.port) - parseInt(b.port) || a.proto.localeCompare(b.proto));
  }
}
function demoPorts(nodes){
  const now = Date.now() / 1000, P = ['51.89.110.208', '179.253.100.109'], me = ['95.104.206.188', '92.246.139.162'];
  for (const n of Object.values(nodes)) {
    if (n.seen == null || now - n.seen > 7200) continue;
    const ports = [{proto: 'tcp', port: '22', from: [...me, P[0]], proc: 'sshd', listen: true}, {proto: 'tcp', port: '80', from: 'all', proc: 'nginx', listen: true},
      {proto: 'tcp', port: '443', from: 'all', proc: 'xray', listen: true}, {proto: 'tcp', port: '2222', from: P, proc: 'node', listen: true}];
    if (n.name === 'DE-Aeza-2') ports.push({proto: 'tcp', port: '9100', from: 'none', proc: 'node_exporter', listen: true}, {proto: 'tcp', port: '3000', from: 'all', proc: '', listen: false});
    if (n.bridge) ports.push({proto: 'tcp', port: '8443', from: ['193.233.230.173'], proc: 'xray', listen: true});
    n.fw = {at: now - 3 * 3600, managed: true, ports: ports.sort((a, b) => +a.port - +b.port)};
  }
}
const PROC = {sshd: 'SSH', 'sshd-session': 'SSH', nginx: 'nginx — заглушка', xray: 'Xray', node: 'remnanode', node_exporter: 'node_exporter', 'docker-proxy': 'Docker', 'systemd-resolve': 'DNS'};
const fromText = f => f === 'all' ? 'всем' : f === 'none' ? 'закрыт' : `только ${f.join(', ')}`;
// замечание по порту: открыт всем, а никто не слушает — лишняя дыра; слушает снаружи, а закрыт — норма (так и задумано)
const portNote = p => p.from === 'all' && !p.listen ? {k: 'warn', t: 'открыт всем, но никто не слушает — лучше закрыть'} : p.from === 'none' && p.listen ? {k: 'ok', t: 'слушает, но фаервол не пускает'} : null;

const portsState = {};   // ключ ноды -> {probe: {"tcp/22": state}, probing, edit: [...rows], job, err}
function drawerPorts(n){
  const f = n.fw; if (!f) return '';
  const st = portsState[n.key] ||= {};
  const pr = st.probe || {}, PS = {open: ['ok', 'доступен'], closed: ['warn', 'закрыт'], filtered: ['err', 'не отвечает'], unknown: ['off', '—']};
  let html = `<div class="dr-sec" id="ports-sec"><h3>Порты и фаервол<span>${ago(f.at)}${f.managed === false ? ' · фаервол не от Sepia' : ''}</span></h3>`;
  if (st.job) return html + portsJobHtml(n) + '</div>';
  if (st.edit) return html + portsEditHtml(n) + '</div>';
  html += `<div class="table-wrap"><table class="ports"><thead><tr><th class="n">Порт</th><th>Кто слушает</th><th>Фаервол пускает</th><th>С сервера панели</th></tr></thead><tbody>` +
    f.ports.map(p => { const k = `${p.proto}/${p.port}`, s = pr[k], note = portNote(p);
      return `<tr><td class="n mono">${esc(p.port)}${p.proto === 'udp' ? ' udp' : ''}</td><td>${p.listen ? esc(PROC[p.proc] || p.proc || 'что-то') : '<span class="muted">никто</span>'}</td>
        <td class="${p.from === 'all' ? 'fw-all' : p.from === 'none' ? 'muted' : ''}">${esc(fromText(p.from))}${note ? `<span class="sub ${note.k === 'warn' ? 'meh' : ''}">${esc(note.t)}</span>` : ''}</td>
        <td>${st.probing ? '<span class="muted">проверяю…</span>' : s ? `<span class="pst ${PS[s][0]}">${PS[s][1]}</span>` : '<span class="muted">—</span>'}</td></tr>`; }).join('') + '</tbody></table></div>';
  html += `<div class="hbtns" style="margin-top:12px"><button class="pill" data-ports-probe="${esc(n.key)}">${icon('activity')}Проверить снаружи</button>
    ${f.managed !== false ? `<button class="pill" data-ports-edit="${esc(n.key)}">${icon('lock')}Изменить правила</button>` : ''}</div>
    <p class="note" style="margin-top:10px">${f.managed === false ? 'На ноде нет фаервола Sepia (таблица inet filter) — правка отсюда недоступна, чтобы не сломать чужие правила.' : 'Порт, открытый только определённым IP, с сервера панели виден как «закрыт» — если панели в списке нет. Вручную на ноде: <code>sudo bash node-check.sh ports</code>.'}</p>`;
  if (st.err) html += `<p class="login-err">${esc(st.err)}</p>`;
  return html + '</div>';
}
function portsEditHtml(n){
  const st = portsState[n.key], ssh = st.sshPort;
  return `<div class="fw-edit">${st.type ? fwTypeHtml(st) : ''}<p class="note" style="margin:0 0 10px">Порт ${esc(ssh)} — SSH: ваш IP и сервер панели останутся в нём всегда, их добавит сам мастер. Удалить правило SSH нельзя.</p>
    <div class="fw-rows">${st.edit.map((r, i) => `<div class="fw-row" data-i="${i}">
      <input class="fw-port mono" value="${esc(r.port)}" placeholder="порт" inputmode="numeric"${r.port === ssh && r.proto === 'tcp' ? ' disabled' : ''}>
      <select class="fw-proto"${r.port === ssh ? ' disabled' : ''}><option${r.proto === 'tcp' ? ' selected' : ''}>tcp</option><option${r.proto === 'udp' ? ' selected' : ''}>udp</option></select>
      <select class="fw-mode"><option value="all"${r.from === 'all' ? ' selected' : ''}>всем</option><option value="ips"${r.from !== 'all' ? ' selected' : ''}>только с IP</option></select>
      <input class="fw-ips mono" value="${esc(r.from === 'all' ? '' : r.from.join(', '))}" placeholder="1.2.3.4, 5.6.7.0/24"${r.from === 'all' ? ' style="visibility:hidden"' : ''}>
      ${r.port === ssh && r.proto === 'tcp' ? '<span class="fw-lock" title="SSH">' + icon('lock') + '</span>' : `<button class="del" data-fw-del="${i}" aria-label="Закрыть порт" title="Закрыть порт">${icon('trash-2')}</button>`}</div>`).join('')}</div>
    <button class="pill" data-fw-add="1" style="margin-top:8px">${icon('plus')}Открыть порт</button>
    <div class="note-row" style="margin-top:14px"><div><label>Пользователь SSH</label><input class="fw-user" value="${esc(store.get('sepia-sshuser') || 'root')}" autocomplete="off" spellcheck="false"></div>
    <div><label>Пароль SSH <span class="muted">(не root — для sudo, если нужен)</span></label><input class="fw-pass" type="password" autocomplete="new-password"></div></div>
    <details class="wz-key"><summary>Вход по ключу SSH</summary><textarea class="fw-key" rows="4" spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></details>
    <div class="note-row"><div><label>Пароль администратора</label><input class="fw-admin" type="password" autocomplete="off"></div><div></div></div>
    <p class="note" style="margin:0 0 10px">Порты, которых нет в списке, будут закрыты. Применение безопасное: новое SSH-подключение и порт панели проверяются, иначе через 2 минуты всё вернётся само.</p>
    <p class="login-err fw-err">${esc(st.err || '')}</p>
    <div class="hbtns"><button class="go" data-fw-apply="${esc(n.key)}">${icon('check')}Применить</button><button class="pill" data-fw-cancel="${esc(n.key)}">Отмена</button></div></div>`;
}
function portsJobHtml(n){
  const J = portsState[n.key].job, ST = {wait: 'circle-dashed', run: 'activity', ok: 'circle-check', err: 'circle-x', skip: 'circle-slash'};
  return `<div class="wrun-head"><span>${J.status === 'run' ? 'Применяю правила…' : J.status === 'ok' ? `<b class="ok-t">${icon('circle-check')} Правила применены</b>` : `<b class="bad">${icon('circle-x')} Не применилось</b> — прежние правила вернутся сами`}</span>
    ${J.status !== 'run' ? `<button class="pill" data-fw-done="${esc(n.key)}">Готово</button>` : ''}</div>
    <ol class="wsteps">${(J.steps || []).map(s => `<li class="w-${s.st}">${icon(ST[s.st] || 'circle-dashed', 'si')}<span>${esc(s.t)}</span></li>`).join('')}</ol>
    <div class="wlogbox">${J.log.map(l => `<div class="l-${l.k || 'n'}">${esc(l.m)}</div>`).join('')}</div>`;
}
function rerenderPorts(key){ const el = $('#ports-sec'); if (el && state.open === key) el.outerHTML = drawerPorts(state.model.nodes[key]); }

// тип ноды → правило порта Reality в строках редактора
function applyType(st){
  let r = st.edit.find(x => x.proto === 'tcp' && x.port === st.rport);
  if (!r) { r = {proto: 'tcp', port: st.rport, from: 'all'}; st.edit.push(r); }
  r.from = st.type === 'normal' ? 'all' : st.entry.split(/[\s,;]+/).filter(Boolean);
}
function fwTypeHtml(st){
  const b = (v, t) => `<button type="button" class="pill${st.type === v ? ' on' : ''}" data-fw-type="${v}">${t}</button>`;
  return `<div class="fw-type"><div class="fw-th"><b>Тип ноды</b>${b('normal', 'Обычная')}${b('bridge', 'Межнодовая')}</div>
    ${st.type === 'normal' ? `<p class="note">Порт Reality ${esc(st.rport)} открыт всем — к ноде подключаются клиенты напрямую.</p>
      ${st.rport !== '443' ? `<label class="remember"><input type="checkbox" class="fw-move443"${st.move443 ? ' checked' : ''}> Перенести Reality на 443: nginx освободит 443 (заглушка останется за Reality), порт ${esc(st.rport)} закроется.
        Затем в профиле Remnawave поставьте порт 443.</label>` : ''}`
    : `<p class="note">Порт Reality открыт только узлу-входу (мосту): клиенты сами к ноде не подключаются.</p>
      <div class="note-row"><div><label>IP узла-входа</label><input class="fw-entry mono" value="${esc(st.entry)}" placeholder="188.225.57.108"></div>
      <div><label>Порт Reality</label><input class="fw-rport mono" value="${esc(st.rport)}" inputmode="numeric"></div></div>`}</div>`;
}

// правка: строки -> правила
function readRows(key){
  const st = portsState[key];
  st.edit = [...document.querySelectorAll('#ports-sec .fw-row')].map((row, i) => {
    const old = st.edit[i], mode = $('.fw-mode', row).value;
    return {proto: $('.fw-proto', row).value, port: $('.fw-port', row).value.trim(), from: mode === 'all' ? 'all' : $('.fw-ips', row).value.split(/[\s,;]+/).filter(Boolean), _ssh: old?._ssh};
  });
}
async function portsApply(key){
  const n = state.model.nodes[key], st = portsState[key];
  readRows(key);
  const pass = $('#ports-sec .fw-pass').value, admin = $('#ports-sec .fw-admin').value, sshKey = ($('#ports-sec .fw-key')?.value || '').trim(), user = ($('#ports-sec .fw-user')?.value || 'root').trim() || 'root';
  const free443 = st.type === 'normal' && st.move443 && st.rport !== '443';
  if (st.type === 'bridge' && !st.entry.trim()) { st.err = 'Впишите IP узла-входа'; return rerenderPorts(key); }
  const rules = st.edit.filter(r => r.port && !(free443 && r.proto === 'tcp' && r.port === st.rport)), bad = rules.find(r => r.from !== 'all' && !r.from.length);
  if (bad) { st.err = `Порт ${bad.port}: впишите IP или выберите «всем»`; return rerenderPorts(key); }
  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2)/.test(sshKey)) { st.err = 'Это открытый ключ (.pub). Нужен закрытый — начинается с -----BEGIN … PRIVATE KEY-----'; return rerenderPorts(key); }
  if (!(pass || sshKey) || !admin) { st.err = 'Нужны пароль или ключ SSH и пароль администратора'; return rerenderPorts(key); }
  store.set('sepia-sshuser', user, true);
  const tchg = st.type && st.type !== st.type0 ? ` Тип ноды: ${st.type === 'normal' ? 'обычная' : 'межнодовая'}.` : '';
  if (!confirm(`Применить ${rules.length} правил на ${n.name}?${tchg}${free443 ? ' nginx освободит порт 443.' : ''} Порты не из списка закроются.`)) return;
  const body = {admin, free443, ip: ipsOf(n)[0], ssh_port: st.sshPort, ssh_user: user, ssh_key: sshKey, password: pass, name: n.name.replace(/[^\w.\-]/g, '_'), rules: rules.map(({proto, port, from}) => ({proto, port, from}))};
  try {
    if (DEMO) { st.job = demoFwJob(n, rules); }
    else {
      const r = await auth('fw', body), j = await r.json().catch(() => ({}));
      if (r.status === 501) throw new Error('Не настроено: ADMIN_PASS в stats/.env и docker compose up -d auth setup');
      if (r.status === 403) throw new Error('Неверный пароль администратора');
      if (r.status === 429) throw new Error('Слишком много попыток — подождите 15 минут');
      if (r.status !== 200) throw new Error(j.error || 'HTTP ' + r.status);
      st.job = {id: j.id, admin, log: [], from: 0, status: 'run', steps: []};
    }
    st.err = ''; rerenderPorts(key); portsPoll(key);
  } catch (e) { st.err = e.message; rerenderPorts(key); }
}
async function portsPoll(key){
  const st = portsState[key], J = st?.job; if (!J) return;
  try {
    const d = J.demo ? J.demo() : await (await auth('setup-status', {id: J.id, from: J.from})).json();
    J.log.push(...d.log); J.from = d.next; J.status = d.status; J.steps = d.steps;
  } catch {}
  rerenderPorts(key);
  if (J.status === 'run') setTimeout(() => portsPoll(key), 2000);
  else if (J.status === 'ok') { if (DEMO) { state.model.nodes[key].fw.ports = st.newPorts; state.model.nodes[key].fw.at = Date.now() / 1000; } else setTimeout(refresh, 3000); }
}
function demoFwJob(n, rules){
  const t0 = Date.now(), L = [[0, 'h', `Подключаюсь к root@${ipsOf(n)[0]}:22…`], [1, 'ok', 'Вошёл. Сервер панели заходит с 51.89.110.208'], [1.5, 'h', 'Новые правила:\n' + rules.map(r => `  ${r.proto} ${r.port} ${r.from === 'all' ? 'all' : r.from.join(',')}`).join('\n')],
    [3, '', 'FW_WAIT_CONFIRM /root/.rw-fw-confirm'], [4, 'ok', 'Новое SSH-подключение после правил прошло'], [4.5, 'ok', 'Порт 2222 с сервера панели: доступен'], [5, '', '[+] Правила применены и закреплены.'], [5.5, 'ok', 'Готово: правила применены и закреплены, отчёт о портах отправлен на дашборд.']];
  const at = [0, 1.5, 3, 5.5], names = [['connect', 'Подключение по SSH'], ['apply', 'Новые правила фаервола'], ['verify', 'Проверка: новое SSH-подключение и порт панели']];
  portsState[n.key].newPorts = rules.map(r => ({...r, proc: (n.fw.ports.find(p => p.port === r.port) || {}).proc || '', listen: !!n.fw.ports.find(p => p.port === r.port && p.listen)}));
  let sent = 0;
  return {log: [], from: 0, status: 'run', steps: [], demo: () => { const s = (Date.now() - t0) / 1000, log = L.filter(l => l[0] <= s).slice(sent).map(([, k, m]) => ({k, m})); sent += log.length;
    return {status: s >= 5.5 ? 'ok' : 'run', steps: names.map(([id, t], i) => ({id, t, st: s >= at[i + 1] ? 'ok' : s >= at[i] ? 'run' : 'wait'})), log, next: sent}; }};
}
async function portsProbe(key){
  const n = state.model.nodes[key], st = portsState[key];
  st.probing = true; rerenderPorts(key);
  try {
    if (DEMO) { await pause(900); st.probe = Object.fromEntries(n.fw.ports.map(p => [`${p.proto}/${p.port}`, p.proto === 'udp' ? 'unknown' : p.from === 'all' && p.listen ? 'open' : p.from === 'all' ? 'closed' : p.from === 'none' ? 'closed' : p.from.includes('51.89.110.208') ? 'open' : 'closed'])); }
    else {
      // снаружи проверяется только TCP (UDP молчит и открытый, и закрытый) — UDP-порты не отправляем, у rw-core их десятки
      const tcp = [...new Map(n.fw.ports.filter(p => p.proto === 'tcp').map(p => [p.port, {proto: 'tcp', port: p.port}])).values()];
      const r = await auth('probe', {ip: ipsOf(n)[0], ports: tcp});
      if (r.status === 501) throw new Error('Проверка снаружи работает через node-setup: ADMIN_PASS в stats/.env и docker compose up -d auth setup');
      if (r.status === 404) throw new Error('Сервер панели работает на старой версии: git pull, затем docker compose up -d --force-recreate auth setup');
      if (r.status !== 200) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      st.probe = await r.json();
    }
    st.err = '';
  } catch (e) { st.err = 'Не проверилось: ' + e.message; }
  st.probing = false; rerenderPorts(key);
}
$('#drawer').addEventListener('click', e => {
  const t = e.target.closest('[data-ports-probe],[data-ports-edit],[data-fw-add],[data-fw-del],[data-fw-apply],[data-fw-cancel],[data-fw-done],[data-fw-type]'); if (!t || !state.open) return;
  const key = state.open, n = state.model.nodes[key], st = portsState[key] ||= {};
  if (t.dataset.portsProbe) return portsProbe(key);
  if (t.dataset.portsEdit) {   // в редактор — только разрешающие правила; закрытые порты (from none) не переносим
    st.sshPort = (n.fw.ports.find(p => /^sshd/.test(p.proc)) || {port: '22'}).port;
    st.edit = n.fw.ports.filter(p => p.from !== 'none').map(p => ({proto: p.proto, port: p.port, from: p.from === 'all' ? 'all' : [...p.from]}));
    if (!st.edit.some(r => r.port === st.sshPort && r.proto === 'tcp')) st.edit.unshift({proto: 'tcp', port: st.sshPort, from: []});
    // тип ноды: межнодовая — порт Reality (его слушает Xray) открыт только IP узла-входа; обычная — всем
    const xr = n.fw.ports.filter(p => p.proto === 'tcp' && /^xray/.test(p.proc));
    st.rport = (xr.find(p => p.port !== '443') || xr[0] || {port: '443'}).port;
    const rr = st.edit.find(r => r.proto === 'tcp' && r.port === st.rport);
    st.type = rr && rr.from !== 'all' ? 'bridge' : 'normal'; st.type0 = st.type;
    st.entry = rr && rr.from !== 'all' ? rr.from.join(', ') : ''; st.move443 = false;
    st.err = ''; return rerenderPorts(key);
  }
  if (t.dataset.fwAdd) { readRows(key); st.edit.push({proto: 'tcp', port: '', from: 'all'}); rerenderPorts(key); setTimeout(() => [...document.querySelectorAll('#ports-sec .fw-port')].at(-1)?.focus(), 30); return; }
  if (t.dataset.fwDel) { readRows(key); st.edit.splice(+t.dataset.fwDel, 1); return rerenderPorts(key); }
  if (t.dataset.fwType) { readRows(key); st.type = t.dataset.fwType; if (st.type === 'bridge') st.move443 = false; applyType(st); return rerenderPorts(key); }
  if (t.dataset.fwApply) return portsApply(key);
  if (t.dataset.fwCancel) { st.edit = null; st.err = ''; return rerenderPorts(key); }
  if (t.dataset.fwDone) { st.job = null; st.edit = null; return rerenderPorts(key); }
});
$('#drawer').addEventListener('change', e => {
  const st = portsState[state.open];
  if (st && e.target.matches('#ports-sec .fw-move443')) { st.move443 = e.target.checked; return; }
  if (st && e.target.matches('#ports-sec .fw-entry, #ports-sec .fw-rport')) {
    readRows(state.open); const old = st.rport;
    if (e.target.matches('.fw-rport')) { const v = e.target.value.trim(); if (/^\d{1,5}$/.test(v)) { const r = st.edit.find(x => x.proto === 'tcp' && x.port === old); if (r) r.port = v; st.rport = v; } }
    else st.entry = e.target.value;
    applyType(st); const k = state.open; setTimeout(() => rerenderPorts(k), 0); return;   // не во время blur: поле ещё в разметке
  }
  const m = e.target.closest('#ports-sec .fw-mode'); if (!m) return;
  const ips = $('.fw-ips', m.closest('.fw-row')); ips.style.visibility = m.value === 'all' ? 'hidden' : ''; if (m.value !== 'all') ips.focus();
});

// сводка во вкладке «Доступ»: что открыто всем и где есть лишнее
function renderPortsSummary(){
  const el = $('#ports-all'); if (!el) return;
  const N = state.model.nodes, rows = state.order.filter(k => N[k].fw);
  if (!rows.length) { el.innerHTML = '<p class="empty">Ноды ещё не присылали порты — придут после ночного обновления node-check (раз в 6 часов). Сейчас вручную: <code>sudo bash node-check.sh ports</code></p>'; return; }
  const chip = (p, cls) => `<span class="pchip ${cls}" title="${esc(PROC[p.proc] || p.proc || 'никто не слушает')}">${esc(p.port)}${p.proto === 'udp' ? '/udp' : ''}${p.from !== 'all' && p.from !== 'none' ? `<small>${p.from.length} IP</small>` : ''}</span>`;
  el.innerHTML = `<table><thead><tr><th>Нода</th><th>Открыты всем</th><th>Только с IP</th><th>Замечания</th><th>Обновлено</th></tr></thead><tbody>` + rows.map(k => {
    const n = N[k], ps = n.fw.ports, notes = ps.map(p => ({p, x: portNote(p)})).filter(o => o.x?.k === 'warn');
    if (n.fw.managed === false) notes.push({p: {port: ''}, x: {t: 'фаервол не от Sepia'}});
    if (notes.length) (state.accessIssues ||= []).push({k: 'warn', key: k, t: 'порты: ' + notes.map(o => (o.p.port ? o.p.port + ' ' : '') + o.x.t).join('; '), ports: true});
    return `<tr class="click" data-key="${esc(k)}" tabindex="0"><td>${flag(n.cc)}${esc(n.name)}</td><td>${ps.filter(p => p.from === 'all').map(p => chip(p, p.listen ? '' : 'warn')).join('') || '—'}</td>
      <td>${ps.filter(p => Array.isArray(p.from)).map(p => chip(p, 'lim')).join('') || '—'}</td><td class="${notes.length ? 'meh' : 'muted'}" style="white-space:normal">${notes.map(o => esc((o.p.port ? o.p.port + ': ' : '') + o.x.t)).join('; ') || 'нет'}</td><td class="muted">${ago(n.fw.at)}</td></tr>`;
  }).join('') + '</tbody></table>';
}
$('#ports-all').addEventListener('click', e => { const t = e.target.closest('[data-key]'); if (t) { state.drTab = 'checks'; openNode(t.dataset.key); } });
