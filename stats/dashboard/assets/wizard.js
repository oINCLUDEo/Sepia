'use strict';
// Мастер новой ноды.
//  «Автоматически по SSH»: IP, пароль root и тип ноды -> node-setup сам ставит пакеты и Sepia, ждёт, пока поддомен
//   дойдёт до всех DNS, запускает provision-node.sh (заглушка, сертификат, фаервол, ключи Reality), remnanode из
//   docker-compose.yml панели и node-check. На выходе — данные для профиля ноды в Remnawave. Нужен пароль администратора.
//  «Вручную — команды»: то же готовыми командами с кнопкой «Скопировать».
// Потом дашборд сам ждёт первый снимок от ноды и пишет «подключилась»

const REPO = 'https://github.com/oINCLUDEo/Sepia.git';
const wiz = {timer: 0, name: '', how: 'auto', job: null, from: 0, poll: 0};
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;   // безопасно для bash
const wv = id => $('#' + id).value.trim();
function wizFields(){
  const mode = wv('wz-mode');
  document.querySelectorAll('.wz-m12').forEach(e => e.hidden = mode === '3');
  document.querySelectorAll('.wz-m2').forEach(e => e.hidden = mode !== '2');
  document.querySelectorAll('.wz-m3').forEach(e => e.hidden = mode !== '3');
  document.querySelectorAll('.wz-auto').forEach(e => e.hidden = wiz.how !== 'auto');
}
function wizCmds(){
  const name = wv('wz-name').replace(/[ ,=]/g, '_'), mode = wv('wz-mode'), dom = wv('wz-domain'), ip = wv('wz-ip'), price = wv('wz-price').replace(',', '.'), cur = wv('wz-cur');
  const url = `https://${location.hostname || 'panel.ulya.space'}:9443/node-stats/write`, env = [`MODE=${mode}`];
  if (mode !== '3') env.push(`DOMAIN=${shq(dom || 'поддомен')}`, `SITE=${wv('wz-site')}`);
  if (mode === '2') env.push(`REALITY_PORT=${shq(wv('wz-rport') || '8443')}`, `PREV_NODE_IP=${shq(wv('wz-prev') || 'IP_входа')}`);
  if (mode === '3') env.push(`MASK_DOMAIN=${shq(wv('wz-mask') || 'ads.x5.ru')}`);
  const steps = [];
  if (mode !== '3') steps.push({t: 'DNS', d: `A-запись <code>${esc(dom || 'поддомен')}</code> → <code>${esc(ip || 'IP ноды')}</code> в reg.ru. Сертификат выпустится, когда запись разойдётся: проверить — <code>dig +short ${esc(dom || 'поддомен')} @8.8.8.8</code>.`});
  steps.push({t: 'Сервер: заглушка, сертификат, фаервол, ключи Reality', d: 'На свежем Debian/Ubuntu под root. Консоль хостера держите открытой — фаервол применяется с откатом через 2 минуты, если не подтвердить.',
    c: `apt-get update && apt-get install -y git\ngit clone ${REPO} /root/Sepia && cd /root/Sepia\n${env.join(' ')} TUNE=1 bash provision-node.sh`});
  steps.push({t: 'remnanode', d: 'Docker и контейнер — по инструкции docs.rw: docker-compose.yml копируется из панели (Ноды → создать ноду).',
    c: 'curl -fsSL https://get.docker.com | sh\nmkdir -p /opt/remnanode && cd /opt/remnanode\nnano docker-compose.yml   # вставить из панели\ndocker compose up -d && docker compose logs -f -t'});
  steps.push({t: 'Статистика: выгрузка и сбор каждую минуту', d: 'ПАРОЛЬ_ЗАПИСИ — это <code>VM_WRITE_PASS</code> из <code>stats/.env</code> на сервере панели.',
    c: `cd /root/Sepia\nSTATS_URL=${shq(url)} STATS_USER=writer STATS_PASS='ПАРОЛЬ_ЗАПИСИ' NODE_NAME=${shq(name || 'ИМЯ')}${ip ? ` NODE_IP=${shq(ip)}` : ''} \\\n  bash node-check.sh stats </dev/null && bash node-check.sh install${price && +price > 0 ? `\nbash node-check.sh price ${shq(price)} ${cur}` : ''}`});
  steps.push({t: 'Панель Remnawave', d: panelHint(name, dom, mode)});
  return {name, steps};
}
const panelHint = (name, dom, mode) => `Назовите ноду в панели <b>${esc(name || 'так же')}</b> — дашборд склеит её со статистикой. Ключи Reality (privateKey, publicKey, shortIds, serverNames, target) — в Config Profile → Inbound;
  Host (address = ${mode !== '3' && dom ? `<code>${esc(dom)}</code>` : 'домен или IP'}) привязать к ноде и добавить в Squad.`;
function wizRender(){
  wizFields();
  if (wiz.how === 'auto') { $('#wiz-steps').innerHTML = ''; return; }
  const {name, steps} = wizCmds();
  $('#wiz-steps').innerHTML = steps.map((s, i) => `<div class="wstep"><div class="wnum">${i + 1}</div><div class="wbody"><b>${esc(s.t)}</b><p>${s.d}</p>${s.c ? `<div class="wcode"><pre>${esc(s.c)}</pre><button class="pill wcopy" data-i="${i}">${icon('copy')}Скопировать</button></div>` : ''}</div></div>`).join('')
    + `<div class="wstep wwait"><div class="wnum">${icon('rocket')}</div><div class="wbody" id="wiz-wait">${name ? `Жду первый снимок от <b>${esc(name)}</b>…` : 'Впишите имя — и я буду ждать первый снимок от ноды.'}</div></div>`;
  wiz.cmds = steps.map(s => s.c || ''); wiz.name = name; wizPoll(true);
}
// ждём первую точку: каждые 10 секунд спрашиваем, был ли снимок от ноды с таким именем за 10 минут
async function wizPoll(reset){
  clearTimeout(wiz.timer); if ($('#wiz').hidden || !wiz.name) return;
  if (reset) wiz.since = Date.now();
  let seen = null;
  try {
    if (DEMO) seen = Date.now() - wiz.since > 6000 ? Date.now() / 1000 : null;
    else { const r = await inst(`max(tlast_over_time(node_quick_cpu_us{node="${wiz.name.replace(/["\\]/g, '')}"}[10m]))`); seen = r[0] ? +r[0].value[1] : null; }
  } catch {}
  const el = $('#wiz-wait'); if (!el) return;
  if (seen) {
    el.innerHTML = `<b class="ok-t">${icon('check')} ${esc(wiz.name)} подключилась</b> — первый снимок ${ago(seen)}. Через минуту она появится в «Обзоре».`;
    el.closest('.wwait')?.classList.add('done'); if (!DEMO) refresh();
    return;
  }
  wiz.timer = setTimeout(wizPoll, DEMO ? 2000 : 10000);
}

/* ---------- автоматически по SSH ---------- */
const ST_IC = {wait: 'circle-dashed', run: 'activity', ok: 'circle-check', err: 'circle-x', skip: 'circle-slash'};
async function wizStart(){
  const err = m => { $('#wz-err').textContent = m; };
  const body = {name: wv('wz-name').replace(/[ ,=]/g, '_'), ip: wv('wz-ip'), mode: wv('wz-mode'), domain: wv('wz-domain'), mask_domain: wv('wz-mask'), reality_port: wv('wz-rport'),
    prev_node_ip: wv('wz-prev'), site: wv('wz-site'), price: wv('wz-price'), cur: wv('wz-cur'), password: $('#wz-sshpass').value, ssh_port: wv('wz-sshport') || '22', ssh_user: 'root',
    admin_ip: wv('wz-admin-ip'), admin_ip_backup: wv('wz-admin-ip2'), compose: $('#wz-compose').value, admin: $('#wz-admin').value};
  if (!body.name || !body.ip || !body.password) return err('Нужны имя, IP и пароль root.');
  if (body.mode !== '3' && !body.domain) return err('Нужен поддомен заглушки — для сертификата.');
  if (!body.admin) return err('Нужен пароль администратора.');
  err(''); $('#wz-start').disabled = true;
  try {
    let r, j;
    if (DEMO) j = {id: 'demo'};
    else {
      r = await auth('setup', body); j = await r.json().catch(() => ({}));
      if (r.status === 501) throw new Error('Автонастройка выключена: впишите ADMIN_PASS в stats/.env и выполните docker compose up -d auth setup');
      if (r.status === 403) throw new Error('Неверный пароль администратора');
      if (r.status === 429) throw new Error('Слишком много попыток — подождите 15 минут');
      if (r.status === 502) throw new Error('node-setup не отвечает: docker compose up -d setup');
      if (r.status !== 200) throw new Error(j.error || 'HTTP ' + r.status);
    }
    $('#wz-sshpass').value = ''; $('#wz-admin').value = '';   // пароли в форме больше не держим
    wiz.job = {id: j.id, admin: body.admin, name: body.name, domain: body.domain, mode: body.mode, log: [], from: 0, demo: DEMO ? demoSetup(body) : null};
    wiz.name = body.name; $('#wiz-form').hidden = true; $('.wiz-mode').hidden = true; $('#wiz-run').hidden = false; wizTick();
  } catch (e) { err(e.message); }
  finally { $('#wz-start').disabled = false; }
}
async function wizTick(){
  clearTimeout(wiz.poll); const J = wiz.job; if (!J || $('#wiz').hidden) return;
  let d;
  try {
    if (J.demo) d = J.demo();
    else { const r = await auth('setup-status', {id: J.id, from: J.from}); if (r.status !== 200) throw new Error('HTTP ' + r.status); d = await r.json(); }
  } catch (e) { wiz.poll = setTimeout(wizTick, 5000); return; }
  J.log.push(...d.log); J.from = d.next; J.status = d.status; J.steps = d.steps; J.result = d.result;
  wizRunRender();
  if (d.status === 'run') wiz.poll = setTimeout(wizTick, 2000);
  else if (d.status === 'ok') wizPoll(true);
}
function wizRunRender(){
  const J = wiz.job, R = J.result || {}, box = $('#wiz-log'), stick = !box || box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const keys = [['port', 'port'], ['target', 'target'], ['serverNames', 'serverNames'], ['privateKey', 'privateKey'], ['publicKey', 'publicKey (клиентам)'], ['shortIds', 'shortIds']].filter(([k]) => R[k]);
  const head = J.status === 'run' ? `Настраиваю <b>${esc(J.name)}</b>…` : J.status === 'ok' ? `<b class="ok-t">${icon('circle-check')} ${esc(J.name)} настроена</b>` : `<b class="bad">${icon('circle-x')} ${J.status === 'cancel' ? 'Отменено' : 'Остановилось с ошибкой'}</b> — что случилось, в журнале ниже`;
  $('#wiz-run').innerHTML = `<div class="wrun-head"><span>${head}</span>${J.status === 'run' ? `<button class="pill" id="wz-cancel">${icon('x')}Отменить</button>` : `<button class="pill" id="wz-again">${icon('plus')}Ещё одну</button>`}</div>
    <ol class="wsteps">${(J.steps || []).map(s => `<li class="w-${s.st}">${icon(ST_IC[s.st] || 'circle-dashed', 'si')}<span>${esc(s.t)}</span><em>${{wait: '', run: 'идёт…', ok: 'готово', err: 'ошибка', skip: 'пропущено'}[s.st]}</em></li>`).join('')}</ol>
    ${keys.length ? `<div class="wres"><b>Данные для профиля ноды в Remnawave</b><span class="note" style="display:block;margin:0 0 8px">Config Profile → Inbound: security reality, flow xtls-rprx-vision</span>
      <div class="wcode"><pre id="wz-keys">${keys.map(([k, l]) => `${l.padEnd(22)}: ${esc(R[k])}`).join('\n')}</pre><button class="pill wcopy" data-keys="1">${icon('copy')}Скопировать</button></div>
      <p class="note" style="margin:8px 0 0">${panelHint(J.name, J.domain, J.mode)}</p></div>` : ''}
    ${J.status === 'ok' ? `<div class="wstep wwait"><div class="wnum">${icon('rocket')}</div><div class="wbody" id="wiz-wait">Жду первый снимок от <b>${esc(J.name)}</b>…</div></div>` : ''}
    <details class="wlog"${J.status === 'run' || J.status === 'err' ? ' open' : ''}><summary>Журнал</summary><div class="wlogbox" id="wiz-log">${J.log.map(l => `<div class="l-${l.k || 'n'}">${esc(l.m)}</div>`).join('')}</div></details>`;
  const nb = $('#wiz-log'); if (nb && stick) nb.scrollTop = nb.scrollHeight;
}
// демо: правдоподобный ход настройки без сервера
function demoSetup(b){
  const t0 = Date.now(), ST = [['connect', 'Подключение по SSH'], ['prepare', 'Подготовка: пакеты и Sepia'], ['dns', 'Ожидание DNS'], ['provision', 'Заглушка, сертификат, фаервол, ключи Reality'], ['remnanode', 'remnanode'], ['nodecheck', 'Статистика node-check']];
  const L = [[0, 'h', `Подключаюсь к root@${b.ip}:22…`], [1, 'ok', 'Вошёл: debian 12, root. Адрес сервера панели для фаервола: 179.253.100.109'], [1.5, 'h', 'Ставлю git и curl, забираю Sepia…'], [3, '', 'Sepia: 0224702 от 2026-11-05'],
    [3.2, 'h', `Жду, пока ${b.domain} начнёт указывать на ${b.ip} у всех: ns1.reg.ru (зона), ns2.reg.ru (зона), Google 8.8.8.8, Cloudflare 1.1.1.1, Яндекс 77.88.8.8.`],
    [3.4, '', 'ns1.reg.ru (зона): ✓ · ns2.reg.ru (зона): ✓ · Google 8.8.8.8: нет записи · Cloudflare 1.1.1.1: ✓ · Яндекс 77.88.8.8: нет записи'],
    [6, 'ok', 'ns1.reg.ru (зона): ✓ · ns2.reg.ru (зона): ✓ · Google 8.8.8.8: ✓ · Cloudflare 1.1.1.1: ✓ · Яндекс 77.88.8.8: ✓'], [6.1, 'h', 'Запускаю provision-node.sh…'],
    [7, '', '[*] Выпускаю серт Let\'s Encrypt …'], [8, '', '[+] Серт выпущен.'], [9, 'ok', 'Новое SSH-подключение после фаервола прошло — закрепляю правила'], [9.5, '', '[+] Фаервол закреплён.'],
    [10, 'h', 'Ставлю Docker и remnanode (docker-compose.yml из панели)…'], [12, '', 'remnanode  Up 8 seconds'], [12.5, 'h', 'Включаю статистику node-check…'], [13.5, '', '[+] Сбор включён'], [14, 'ok', 'Готово. Данные для профиля ноды в Remnawave — ниже.']];
  const at = [0, 1.5, 3.2, 6.1, 10, 12.5, 14];
  let sent = 0;
  return () => {
    const s = (Date.now() - t0) / 1000, done = s >= 14, log = L.filter(l => l[0] <= s).slice(sent).map(([, k, m]) => ({k, m})); sent += log.length;
    const steps = ST.map(([id, t], i) => ({id, t, st: s >= at[i + 1] ? 'ok' : s >= at[i] ? 'run' : 'wait'}));
    return {status: done ? 'ok' : 'run', steps, log, next: sent, result: s >= 9 ? {port: '443', target: '127.0.0.1:8081', serverNames: `["${b.domain}"]`, privateKey: 'kQ3m…демо…Xw', publicKey: 'Zp7v…демо…a0', shortIds: '["3f9c1a2b7d4e5f60"]'} : {}};
  };
}

/* ---------- окно ---------- */
async function openWizard(){
  $('#wiz').hidden = false; $('#wiz-form').hidden = false; $('.wiz-mode').hidden = false; $('#wiz-run').hidden = true; wiz.job = null;
  if (!wiz.bound) { wiz.bound = true; bindSeg($('#wz-how'), v => { wiz.how = v; wizRender(); }); }   // bindSeg — из app.js, он грузится позже
  moveThumb($('#wz-how'));
  if (!wv('wz-admin-ip')) {   // ваш IP — тот, с которого открыт дашборд: SSH на новой ноде будет открыт ему
    try { if (!DEMO) { const r = await fetch(API_BASE + '/auth/ip', {credentials: 'same-origin', cache: 'no-store'}); if (r.ok) $('#wz-admin-ip').value = (await r.json()).ip || ''; } else $('#wz-admin-ip').value = '95.104.206.188'; } catch {}
  }
  wizRender(); setTimeout(() => $('#wz-name').focus(), 30);
}
const closeWizard = () => { $('#wiz').hidden = true; clearTimeout(wiz.timer); clearTimeout(wiz.poll); };
$('#wiz-open').addEventListener('click', openWizard);
$('#wiz-close').addEventListener('click', closeWizard);
$('#wiz').addEventListener('click', e => { if (e.target.id === 'wiz') closeWizard(); });
$('#wiz').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeWizard(); } });
let wizT; $('#wiz-form').addEventListener('input', () => { clearTimeout(wizT); wizT = setTimeout(wizRender, 250); });
$('#wiz-form').addEventListener('change', wizFields);
$('#wiz-form').addEventListener('submit', e => e.preventDefault());
$('#wz-start').addEventListener('click', wizStart);
$('#wiz-run').addEventListener('click', async e => {
  if (e.target.closest('#wz-cancel') && wiz.job && confirm('Отменить настройку? Уже сделанное на ноде останется.')) {
    if (!wiz.job.demo) await auth('setup-cancel', {id: wiz.job.id, admin: wiz.job.admin}).catch(() => {});
    else wiz.job.demo = () => ({status: 'cancel', steps: wiz.job.steps, log: [{k: 'err', m: 'Отменено.'}], next: 0, result: wiz.job.result});
  }
  if (e.target.closest('#wz-again')) { wiz.job = null; openWizard(); }
  const kb = e.target.closest('[data-keys]');
  if (kb) { try { await navigator.clipboard.writeText($('#wz-keys').textContent); kb.innerHTML = icon('check') + 'Скопировано'; } catch { toast('Не скопировалось — выделите текст вручную'); } }
});
$('#wiz-steps').addEventListener('click', async e => {
  const b = e.target.closest('.wcopy'); if (!b) return;
  try { await navigator.clipboard.writeText(wiz.cmds[+b.dataset.i]); b.innerHTML = icon('check') + 'Скопировано'; setTimeout(() => b.innerHTML = icon('copy') + 'Скопировать', 1600); }
  catch { toast('Не скопировалось — выделите текст вручную'); }
});
