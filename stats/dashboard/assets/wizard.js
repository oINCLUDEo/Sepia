'use strict';
// Мастер новой ноды: имя, роль, поддомен, IP, цена -> готовые команды по шагам с кнопкой «Скопировать»,
// потом дашборд сам ждёт первый снимок от ноды и говорит «подключилась». Пароль записи в браузер не попадает:
// в команде — заглушка ПАРОЛЬ_ЗАПИСИ (это VM_WRITE_PASS из stats/.env на сервере панели)

const REPO = 'https://github.com/oINCLUDEo/Sepia.git';
const wiz = {timer: 0, name: ''};
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;   // безопасно для bash
function wizCmds(){
  const v = id => $('#' + id).value.trim();
  const name = v('wz-name').replace(/[ ,=]/g, '_'), role = v('wz-role'), dom = v('wz-domain'), ip = v('wz-ip'), price = v('wz-price').replace(',', '.'), cur = v('wz-cur');
  const url = `https://${location.hostname || 'panel.ulya.space'}:9443/node-stats/write`;
  const steps = [];
  if (dom) steps.push({t: 'DNS', d: `A-запись <code>${esc(dom)}</code> → <code>${esc(ip || 'IP ноды')}</code>, без прокси Cloudflare (DNS-only). Сертификат выпустится, только когда запись разойдётся.`});
  steps.push({t: 'Сервер: заглушка, сертификат, фаервол, ключи Reality', d: 'На свежем Debian/Ubuntu под root. Консоль хостера держите открытой — фаервол применяется с откатом через 2 минуты, если не подтвердить.',
    c: `git clone ${REPO} /root/Sepia && cd /root/Sepia\n${dom ? `DOMAIN=${shq(dom)} ./provision-node.sh` : '# без поддомена: provision-node.sh нужен DOMAIN — заглушка и Reality без него не настроятся'}\nbash tune-kernel.sh`});
  steps.push({t: 'Статистика: выгрузка и сбор каждую минуту', d: 'ПАРОЛЬ_ЗАПИСИ — это <code>VM_WRITE_PASS</code> из <code>stats/.env</code> на сервере панели.',
    c: `cd /root/Sepia\nSTATS_URL=${shq(url)} STATS_USER=writer STATS_PASS='ПАРОЛЬ_ЗАПИСИ' NODE_NAME=${shq(name || 'ИМЯ')}${ip ? ` NODE_IP=${shq(ip)}` : ''} \\\n  bash node-check.sh stats </dev/null && bash node-check.sh install${price && +price > 0 ? `\nbash node-check.sh price ${shq(price)} ${cur}` : ''}`});
  steps.push({t: 'Панель Remnawave', d: `Поставьте remnanode (порт и SECRET_KEY — из панели), назовите ноду <b>${esc(name || 'так же')}</b> — тогда дашборд сам склеит её со статистикой.
    Ключи, которые напечатал provision-node.sh, — в Config Profile → Inbound; Host (address = ${dom ? `<code>${esc(dom)}</code>` : 'домен'}) привязать к ноде и добавить в Squad.${role === 'bridge' ? ' Для моста — исходящие на выходы в его профиле: так дашборд нарисует пути на карте.' : ''}`});
  return {name, steps};
}
function wizRender(){
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
    $('.wwait').classList.add('done'); if (!DEMO) refresh();
    return;
  }
  wiz.timer = setTimeout(wizPoll, DEMO ? 2000 : 10000);
}
function openWizard(){ $('#wiz').hidden = false; wizRender(); setTimeout(() => $('#wz-name').focus(), 30); }
const closeWizard = () => { $('#wiz').hidden = true; clearTimeout(wiz.timer); };
$('#wiz-open').addEventListener('click', openWizard);
$('#wiz-close').addEventListener('click', closeWizard);
$('#wiz').addEventListener('click', e => { if (e.target.id === 'wiz') closeWizard(); });
$('#wiz').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeWizard(); } });
let wizT; $('#wiz-form').addEventListener('input', () => { clearTimeout(wizT); wizT = setTimeout(wizRender, 250); });
$('#wiz-form').addEventListener('submit', e => e.preventDefault());
$('#wiz-steps').addEventListener('click', async e => {
  const b = e.target.closest('.wcopy'); if (!b) return;
  try { await navigator.clipboard.writeText(wiz.cmds[+b.dataset.i]); b.innerHTML = icon('check') + 'Скопировано'; setTimeout(() => b.innerHTML = icon('copy') + 'Скопировать', 1600); }
  catch { toast('Не скопировалось — выделите текст вручную'); }
});
