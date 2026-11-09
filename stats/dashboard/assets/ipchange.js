'use strict';
// Смена IP ноды (заблокировали IP — хостер выдал новый). Что дашборд делает сам: находит старый IP в Remnawave
// (адрес ноды, хосты в подписках, исходящие в профилях мостов) и меняет на новый — сначала показывает план.
// Что делается само на нодах: node-check замечает новый IP (раз в 30 минут), выход обновляет правило порта
// Reality под новый IP моста (раз в 10 минут). Руками — только A-запись в reg.ru: доступа к его API нет

const ipc = {key: null, plan: null, busy: false, err: '', done: false};
const ipOk = v => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v);

function openIpChange(key){
  const n = state.model.nodes[key]; if (!n) return;
  Object.assign(ipc, {key, plan: null, busy: false, err: '', done: false, old: ipsOf(n)[0] || '', neu: ''});
  let m = $('#ipc'); if (!m) { m = document.createElement('div'); m.id = 'ipc'; m.className = 'ipc-wrap'; document.body.append(m); }
  m.hidden = false; renderIpc(); setTimeout(() => $('#ipc-new')?.focus(), 30);
}
// ноды, у которых старый IP стоит в фаерволе (обычно выходы, пускающие Reality только с этого моста)
function fwPeersOf(ip){
  return Object.values(state.model.nodes).filter(x => x.fw?.ports?.some(p => Array.isArray(p.from) && p.from.includes(ip) && !/^(22|2222)$/.test(p.port)))
    .map(x => ({n: x, ports: x.fw.ports.filter(p => Array.isArray(p.from) && p.from.includes(ip)).map(p => p.port)}));
}
function fwHtml(){
  const L = fwPeersOf(ipc.old); if (!L.length) return '';
  return `<h4>Фаервол на других нодах</h4><ul class="ipc-l">${L.map(({n, ports}) => `<li>${icon('shield-check')}<div><b>${esc(n.name)} — порт ${esc(ports.join(', '))} открыт старому IP</b>
    <span>обновится сам за 10 минут после смены DNS, если node-check на ${esc(n.name)} свежий (git pull в /root/Sepia). Иначе — «Изменить правила» в карточке ${esc(n.name)}</span></div></li>`).join('')}</ul>`;
}
function renderIpc(){
  const m = $('#ipc'), n = state.model.nodes[ipc.key]; if (!m || !n) return;
  const P = ipc.plan, dom = n.site?.domain, row = (ok, t, sub = '') => `<li class="${ok ? 'ok' : ''}">${icon(ok ? 'circle-check' : 'circle-dashed')}<div><b>${t}</b>${sub ? `<span>${sub}</span>` : ''}</div></li>`;
  const fwLeft = P ? fwPeersOf(ipc.old).length : 0, dnsOk = P && (P.dns || []).every(d => d.ok), nothing = P && !P.nodes.length && !P.hosts.length && !P.profiles.length;
  const doneAll = P && (nothing || ipc.done) && dnsOk && !fwLeft;
  const top = doneAll ? `<div class="ipc-ok">${icon('circle-check')}<div><b>Всё переключено на ${esc(ipc.neu)}</b><span>DNS указывает на новый IP, в панели и фаерволах старого IP не осталось — делать больше ничего не нужно</span></div></div>`
    : P ? `<div class="ipc-todo">${icon('list-checks')}<div><b>Осталось</b><span>${[!nothing && !ipc.done && 'заменить IP в Remnawave (кнопка ниже)', !dnsOk && 'поменять A-запись в reg.ru', fwLeft && `обновить фаервол: ${fwPeersOf(ipc.old).map(x => esc(x.n.name)).join(', ')}`].filter(Boolean).join('; ')}</span></div></div>` : '';
  const plan = P ? top + `<h4>Что поменяется в Remnawave</h4><ul class="ipc-l">
      ${P.nodes.length ? P.nodes.map(x => row(x.done, `Адрес ноды «${esc(x.name || '')}»`, `${esc(ipc.old)} → ${esc(ipc.neu)}`)).join('') : row(true, 'Адрес ноды указан доменом', 'менять не нужно')}
      ${P.hosts.map(x => row(x.done, `Хост «${esc(x.name || '')}»`, 'адрес в подписках')).join('')}
      ${P.profiles.map(x => row(x.done, `Профиль «${esc(x.name || '')}»`, `${x.count} ${plural(x.count, 'замена', 'замены', 'замен')} — исходящее моста на эту ноду`)).join('')}
      ${!P.hosts.length && !P.profiles.length ? row(true, 'Хосты и профили указаны доменом', 'менять не нужно — хватит A-записи') : ''}</ul>
    ${P.errors?.length ? `<p class="login-err">${P.errors.map(esc).join('<br>')}</p>` : ''}
    ${fwHtml()}
    <h4>DNS</h4><ul class="ipc-l">${(P.dns || []).length ? P.dns.map(d => row(d.ok, esc(d.domain), d.ok ? `уже указывает на ${esc(ipc.neu)}` : `сейчас ${d.ips.length ? esc(d.ips.join(', ')) : 'не находится'} — в reg.ru A-запись → ${esc(ipc.neu)}`)).join('') : row(false, 'Доменов на этот IP в панели не нашлось', 'если у ноды есть поддомен — поменяйте его A-запись в reg.ru')}</ul>` : '';
  m.innerHTML = `<div class="ipc" role="dialog" aria-label="Сменить IP ноды"><div class="ipc-h"><h3>Сменить IP — ${esc(n.name)}</h3><button class="icon-btn" data-ipc-close aria-label="Закрыть">${icon('x')}</button></div>
    <div class="note-row"><div><label>Старый IP</label><input id="ipc-old" class="mono" value="${esc(ipc.old)}" inputmode="decimal"></div>
    <div><label>Новый IP</label><input id="ipc-new" class="mono" value="${esc(ipc.neu)}" placeholder="45.132.176.99" inputmode="decimal"></div></div>
    ${plan}
    <p class="login-err">${esc(ipc.err)}</p>
    <div class="hbtns">${ipc.done ? `<button class="go" data-ipc-close>${icon('check')}Готово</button>`
      : !P ? `<button class="go" data-ipc-plan${ipc.busy ? ' disabled' : ''}>${icon(ipc.busy ? 'loader' : 'search', ipc.busy ? 'ic spin' : 'ic')}Показать, что поменяется</button>`
      : `${P.nodes.length || P.hosts.length || P.profiles.length ? `<button class="go" data-ipc-apply${ipc.busy ? ' disabled' : ''}>${icon('check')}Заменить в Remnawave</button>` : ''}<button class="pill" data-ipc-plan>${icon('refresh-cw')}Проверить ещё раз</button>`}</div>
    <details class="u-how"><summary>${icon('info')}Что ещё произойдёт само</summary>
      <p>На ноде node-check заметит новый IP в течение 30 минут — статистика и проверка репутации пойдут уже с ним.</p>
      <p>Если это мост: выходы, которые пускают Reality только с его IP, сами обновят правило фаервола в течение 10 минут после замены в Remnawave.</p>
      <p>Сертификат и ключи Reality не меняются — домен тот же. Клиентам обновлять подписку не нужно, если хосты указаны доменом.</p></details></div>`;
}
async function ipcCall(apply){
  ipc.old = $('#ipc-old').value.trim(); ipc.neu = $('#ipc-new').value.trim();
  if (!ipOk(ipc.old) || !ipOk(ipc.neu) || ipc.old === ipc.neu) { ipc.err = 'Нужны старый и новый IPv4, разные'; return renderIpc(); }
  if (apply && !confirm(`Заменить ${ipc.old} на ${ipc.neu} в Remnawave?`)) return;
  ipc.busy = true; ipc.err = ''; renderIpc();
  const n = state.model.nodes[ipc.key];
  try {
    if (DEMO) { await pause(500); ipc.plan = {nodes: [{name: n.name, done: apply}], hosts: n.bridge ? [] : [{name: n.name + ' — подписка', done: apply}], profiles: n.bridge ? [] : [{name: 'RU-bridge', count: 1, done: apply}], dns: n.site?.domain ? [{domain: n.site.domain, ips: [ipc.old], ok: false}] : [], errors: []}; }
    else {
      const r = await auth('node-ip', {old: ipc.old, new: ipc.neu, domains: n.site?.domain ? [n.site.domain] : [], apply: apply ? 1 : 0});
      if (r.status === 501) throw new Error('Нужен API-токен Remnawave (RW_TOKEN в stats/.env)');
      if (r.status === 404) throw new Error('node-auth старый — обновите: docker compose up -d --force-recreate auth');
      if (r.status !== 200) throw new Error('Панель не ответила (HTTP ' + r.status + ')');
      ipc.plan = await r.json();
    }
    if (apply) { ipc.done = !ipc.plan.errors?.length; toast(ipc.done ? 'IP заменён в Remnawave' : 'Заменено не всё — смотрите ошибки'); }
  } catch (e) { ipc.err = e.message; }
  ipc.busy = false; renderIpc();
}
document.addEventListener('click', e => {
  const o = e.target.closest('[data-ipchg]'); if (o) return openIpChange(o.dataset.ipchg);
  if (!e.target.closest('#ipc')) return;
  if (e.target.closest('[data-ipc-close]') || e.target.id === 'ipc') { $('#ipc').hidden = true; return; }
  if (e.target.closest('[data-ipc-plan]')) { ipc.plan = null; return ipcCall(false); }
  if (e.target.closest('[data-ipc-apply]')) return ipcCall(true);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#ipc') && !$('#ipc').hidden) { e.stopPropagation(); $('#ipc').hidden = true; } }, true);
