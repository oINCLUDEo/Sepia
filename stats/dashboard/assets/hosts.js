'use strict';
// Хосты в подписках: у заблокированной ноды их выключают в Remnawave — пользователи перестают получать её в подписке и
// уходят на живые ноды, а сама нода, её профиль и Squad не трогаются. Включить обратно — той же кнопкой.
// Делает node-auth (/auth/hosts, /auth/hosts-toggle) токеном Remnawave из .env; каждое действие — заметкой на графиках

const hostsState = {};   // ключ ноды -> {list, err, busy}
function hostsSection(n, open){
  const st = hostsState[n.key];
  const body = !st ? `<button class="pill" data-hosts="${esc(n.key)}">${icon('globe')}Найти хосты ноды в панели</button>`
    : st.busy ? '<div class="skel skel-line"></div><div class="skel skel-line"></div>'
    : st.err ? `<p class="note" style="margin:0">${esc(st.err)}</p>`
    : !st.list.length ? '<p class="note" style="margin:0">Хостов этой ноды не нашлось: ни один не привязан к ней и не ведёт на её IP или домен заглушки.</p>'
    : `<div class="hlist">${st.list.map(h => `<div class="hrow${h.isDisabled ? ' off' : ''}"><div><b>${esc(h.remark || '—')}</b><span class="mono">${esc(h.address)}:${esc(h.port)}</span></div>
        <span class="hst">${h.isDisabled ? 'выключен' : 'в подписках'}</span></div>`).join('')}</div>
      <div class="hbtns">${st.list.some(h => !h.isDisabled) ? `<button class="go danger" data-hosts-off="${esc(n.key)}">${icon('ban')}Выключить в подписках</button>` : ''}
        ${st.list.some(h => h.isDisabled) ? `<button class="pill" data-hosts-on="${esc(n.key)}">${icon('circle-check')}Включить обратно</button>` : ''}</div>`;
  return `<div class="dr-sec hosts${open ? ' hot' : ''}" id="hosts-sec"><h3>Хосты в подписках<span>Remnawave</span></h3>
    <p class="note" style="margin:0 0 12px">${n.panel ? 'Если IP заблокирован, выключите хосты ноды: пользователи перестанут её получать и уйдут на живые ноды. Нода, профиль и Squad не меняются.' : 'Нода не найдена в панели.'}</p>${n.panel ? body : ''}</div>`;
}
async function hostsLoad(key){
  const n = state.model.nodes[key]; hostsState[key] = {busy: true}; rerenderHosts(key);
  try {
    if (DEMO) { await pause(400); hostsState[key] = {list: hostsState[key]?.list || [{uuid: 'd-1', remark: n.panel?.name || n.name, address: n.site?.domain || (n.name.toLowerCase() + '.ulya.space'), port: 443, isDisabled: false}]}; }
    else {
      const r = await auth('hosts', {node: n.panel?.uuid || '', ips: ipsOf(n), domains: [n.site?.domain].filter(Boolean)});
      if (r.status === 501) throw new Error('Не настроено: впишите RW_TOKEN (API-токен Remnawave) в stats/.env и перезапустите: docker compose up -d auth');
      if (r.status !== 200) throw new Error(r.status === 401 ? 'Сессия закончилась — войдите снова' : `Панель не ответила (HTTP ${r.status}). Проверьте RW_API и права токена.`);
      hostsState[key] = {list: await r.json()};
    }
  } catch (e) { hostsState[key] = {err: e.message}; }
  rerenderHosts(key);
}
async function hostsToggle(key, enable){
  const n = state.model.nodes[key], st = hostsState[key], pick = st.list.filter(h => h.isDisabled === enable);
  if (!confirm(`${enable ? 'Включить' : 'Выключить'} в подписках ${pick.length} ${pick.length === 1 ? 'хост' : 'хоста'} ноды ${n.name}?\n\n${pick.map(h => `${h.remark} — ${h.address}`).join('\n')}`)) return;
  st.busy = true; rerenderHosts(key);
  try {
    if (DEMO) { await pause(500); pick.forEach(h => h.isDisabled = !enable); (state.notes ||= []).unshift({id: 'd' + Date.now(), node: key, text: `${enable ? 'Включены' : 'Выключены'} хосты в подписках: ${n.name}`, t: Math.floor(Date.now() / 1000)}); }
    else {
      const r = await auth('hosts-toggle', {uuids: pick.map(h => h.uuid), enable, node: key, name: n.name});
      if (r.status !== 204) throw new Error(`HTTP ${r.status}`);
      (state.notes ||= []).unshift({id: 'l' + Date.now(), node: key, text: `${enable ? 'Включены' : 'Выключены'} хосты в подписках: ${n.name}`, t: Math.floor(Date.now() / 1000)});
      st.busy = false; await hostsLoad(key);
    }
    toast(enable ? 'Хосты включены — нода снова в подписках' : 'Хосты выключены — пользователи получат подписку без этой ноды');
  } catch (e) { toast('Не получилось: ' + e.message); }
  st.busy = false; rerenderHosts(key);
}
function rerenderHosts(key){
  const el = $('#hosts-sec'); if (!el || state.open !== key) return;
  el.outerHTML = hostsSection(state.model.nodes[key], el.classList.contains('hot'));
}
// кнопки в панели ноды
$('#drawer').addEventListener('click', e => {
  const a = e.target.closest('[data-hosts]'), off = e.target.closest('[data-hosts-off]'), on = e.target.closest('[data-hosts-on]'), go = e.target.closest('[data-hosts-go]');
  if (a) hostsLoad(a.dataset.hosts);
  if (off) hostsToggle(off.dataset.hostsOff, false);
  if (on) hostsToggle(on.dataset.hostsOn, true);
  if (go) {   // из вердикта «похоже, заблокирован»: на вкладку «Справка» к хостам, сразу ищем
    $(`.dr-tabs [data-tab="info"]`)?.click();
    if (!hostsState[go.dataset.hostsGo]) hostsLoad(go.dataset.hostsGo);
    setTimeout(() => $('#hosts-sec')?.scrollIntoView({behavior: 'smooth', block: 'start'}), 50);
  }
});
