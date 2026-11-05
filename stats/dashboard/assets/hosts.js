'use strict';
// Хосты в подписках: у заблокированной ноды их выключают в Remnawave — пользователи перестают получать её в подписке и
// уходят на живые ноды, а сама нода, её профиль и Squad не трогаются. Включить обратно — той же кнопкой.
// Делает node-auth (/auth/hosts, /auth/hosts-toggle) токеном Remnawave из .env; каждое действие — заметкой на графиках.
// Хосты ноды находятся сами: привязаны к ней, адрес — её IP или домен заглушки, домен адреса указывает на её IP (DNS).
// Не нашлись — «выбрать вручную»: все хосты панели с поиском и галочками

const hostsState = {};   // ключ ноды -> {list, all, sel:Set, q, err, busy}
function hostsSection(n, open){
  const st = hostsState[n.key];
  let body;
  if (!st) body = `<button class="pill" data-hosts="${esc(n.key)}">${icon('globe')}Найти хосты ноды в панели</button>`;
  else if (st.busy) body = '<div class="skel skel-line"></div><div class="skel skel-line"></div>';
  else if (st.err) body = `<p class="note" style="margin:0">${esc(st.err)}</p>`;
  else if (st.all) {
    // ручной выбор: найденные автоматически — сверху и отмечены, остальные — по поиску
    const q = (st.q || '').toLowerCase(), list = st.list.filter(h => !q || `${h.remark} ${h.address}`.toLowerCase().includes(q));
    const nOff = st.list.filter(h => st.sel.has(h.uuid) && !h.isDisabled).length, nOn = st.list.filter(h => st.sel.has(h.uuid) && h.isDisabled).length;
    body = `<input class="hsearch" id="hosts-q" type="search" placeholder="Поиск по имени или адресу хоста" value="${esc(st.q || '')}" autocomplete="off">
      <div class="hlist pick">${list.map(h => `<label class="hrow${h.isDisabled ? ' off' : ''}"><input type="checkbox" data-hsel="${esc(h.uuid)}"${st.sel.has(h.uuid) ? ' checked' : ''}>
        <div><b>${esc(h.remark || '—')}</b><span class="mono">${esc(h.address)}:${esc(h.port)}</span>${h.match ? `<span class="why">${esc(h.match)}</span>` : ''}</div>
        <span class="hst">${h.isDisabled ? 'выключен' : 'в подписках'}</span></label>`).join('') || '<p class="note" style="margin:0">Ничего не нашлось.</p>'}</div>
      <div class="hbtns">${nOff ? `<button class="go danger" data-hosts-off="${esc(n.key)}">${icon('ban')}Выключить выбранные (${nOff})</button>` : ''}
        ${nOn ? `<button class="pill" data-hosts-on="${esc(n.key)}">${icon('circle-check')}Включить выбранные (${nOn})</button>` : ''}
        ${!nOff && !nOn ? '<span class="note" style="margin:0">Отметьте хосты этой ноды</span>' : ''}</div>`;
  } else if (!st.list.length) body = `<p class="note" style="margin:0 0 12px">Автоматически хостов не нашлось: ни один не привязан к ноде, и ни один адрес не ведёт на её IP (${esc(ipsOf(n).join(', ') || 'IP неизвестен')}) или домен заглушки.</p>
      <button class="pill" data-hosts-all="${esc(n.key)}">${icon('list-checks')}Выбрать вручную из всех хостов</button>`;
  else body = `<div class="hlist">${st.list.map(h => `<div class="hrow${h.isDisabled ? ' off' : ''}"><div><b>${esc(h.remark || '—')}</b><span class="mono">${esc(h.address)}:${esc(h.port)}</span><span class="why">${esc(h.match)}</span></div>
        <span class="hst">${h.isDisabled ? 'выключен' : 'в подписках'}</span></div>`).join('')}</div>
      <div class="hbtns">${st.list.some(h => !h.isDisabled) ? `<button class="go danger" data-hosts-off="${esc(n.key)}">${icon('ban')}Выключить в подписках</button>` : ''}
        ${st.list.some(h => h.isDisabled) ? `<button class="pill" data-hosts-on="${esc(n.key)}">${icon('circle-check')}Включить обратно</button>` : ''}
        <button class="pill" data-hosts-all="${esc(n.key)}">${icon('list-checks')}Не все? Выбрать вручную</button></div>`;
  return `<div class="dr-sec hosts${open ? ' hot' : ''}" id="hosts-sec"><h3>Хосты в подписках<span>Remnawave</span></h3>
    <p class="note" style="margin:0 0 12px">Если IP заблокирован, выключите хосты ноды: пользователи перестанут её получать и уйдут на живые ноды. Нода, профиль и Squad не меняются.</p>${body}</div>`;
}
async function hostsLoad(key, all = false){
  const n = state.model.nodes[key], prev = hostsState[key];
  hostsState[key] = {busy: true}; rerenderHosts(key);
  try {
    let list;
    if (DEMO) {
      await pause(400);
      const mine = {uuid: 'd-' + key, remark: n.panel?.name || n.name, address: n.site?.domain || (n.name.toLowerCase() + '.ulya.space'), port: 443, isDisabled: false, match: 'домен указывает на IP ноды'};
      const base = prev?.list?.find(h => h.uuid === mine.uuid) || mine;
      list = all ? [base, ...Object.values(state.model.nodes).filter(x => x.key !== key && x.panel).map(x => ({uuid: 'd-' + x.key, remark: x.panel.name, address: x.name.toLowerCase() + '.ulya.space', port: 443, isDisabled: false, match: ''}))] : [base];
    } else {
      const r = await auth('hosts', {node: n.panel?.uuid || '', ips: ipsOf(n), domains: [n.site?.domain].filter(Boolean), all: all ? 1 : 0});
      if (r.status === 501) throw new Error('Не настроено: впишите RW_TOKEN (API-токен Remnawave) в stats/.env и перезапустите: docker compose up -d auth');
      if (r.status !== 200) throw new Error(r.status === 401 ? 'Сессия закончилась — войдите снова' : `Панель не ответила (HTTP ${r.status}). Проверьте RW_API и права токена.`);
      list = await r.json();
    }
    list.sort((a, b) => !!b.match - !!a.match || String(a.remark).localeCompare(String(b.remark), 'ru', {numeric: true}));
    hostsState[key] = {list, all, sel: new Set(list.filter(h => h.match).map(h => h.uuid)), q: ''};
  } catch (e) { hostsState[key] = {err: e.message}; }
  rerenderHosts(key);
}
async function hostsToggle(key, enable){
  const n = state.model.nodes[key], st = hostsState[key];
  const pick = st.list.filter(h => h.isDisabled === enable && (!st.all || st.sel.has(h.uuid)));
  if (!pick.length) return;
  if (!confirm(`${enable ? 'Включить' : 'Выключить'} в подписках ${pick.length} ${pick.length === 1 ? 'хост' : pick.length < 5 ? 'хоста' : 'хостов'} ноды ${n.name}?\n\n${pick.map(h => `${h.remark} — ${h.address}`).join('\n')}`)) return;
  st.busy = true; rerenderHosts(key);
  const note = {id: 'l' + Date.now(), node: key, text: `${enable ? 'Включены' : 'Выключены'} хосты в подписках: ${n.name}`, t: Math.floor(Date.now() / 1000)};
  try {
    if (DEMO) { await pause(500); pick.forEach(h => h.isDisabled = !enable); }
    else {
      const r = await auth('hosts-toggle', {uuids: pick.map(h => h.uuid), enable, node: key, name: n.name});
      if (r.status !== 204) throw new Error(r.status === 400 ? 'панель не приняла список хостов' : `HTTP ${r.status}`);
      pick.forEach(h => h.isDisabled = !enable);   // перечитывать не ждём: панель отвечает сразу, а список уже на экране
    }
    (state.notes ||= []).unshift(note);
    toast(enable ? 'Хосты включены — нода снова в подписках' : 'Хосты выключены — пользователи получат подписку без этой ноды');
  } catch (e) { toast('Не получилось: ' + e.message); }
  st.busy = false; rerenderHosts(key);
}
function rerenderHosts(key){
  const el = $('#hosts-sec'); if (!el || state.open !== key) return;
  const q = document.activeElement?.id === 'hosts-q', pos = q ? document.activeElement.selectionStart : 0;
  el.outerHTML = hostsSection(state.model.nodes[key], el.classList.contains('hot'));
  if (q) { const i = $('#hosts-q'); i?.focus(); i?.setSelectionRange(pos, pos); }
}
// кнопки в панели ноды
$('#drawer').addEventListener('click', e => {
  const a = e.target.closest('[data-hosts]'), all = e.target.closest('[data-hosts-all]'), off = e.target.closest('[data-hosts-off]'), on = e.target.closest('[data-hosts-on]'), go = e.target.closest('[data-hosts-go]');
  if (a) hostsLoad(a.dataset.hosts);
  if (all) hostsLoad(all.dataset.hostsAll, true);
  if (off) hostsToggle(off.dataset.hostsOff, false);
  if (on) hostsToggle(on.dataset.hostsOn, true);
  if (go) {   // из вердикта «похоже, заблокирован»: на вкладку «Справка» к хостам, сразу ищем
    $(`.dr-tabs [data-tab="info"]`)?.click();
    if (!hostsState[go.dataset.hostsGo]) hostsLoad(go.dataset.hostsGo);
    setTimeout(() => $('#hosts-sec')?.scrollIntoView({behavior: 'smooth', block: 'start'}), 50);
  }
});
$('#drawer').addEventListener('change', e => {
  const c = e.target.closest('[data-hsel]'); if (!c || !state.open) return;
  const st = hostsState[state.open]; c.checked ? st.sel.add(c.dataset.hsel) : st.sel.delete(c.dataset.hsel); rerenderHosts(state.open);
});
$('#drawer').addEventListener('input', e => {
  if (e.target.id !== 'hosts-q' || !state.open) return;
  hostsState[state.open].q = e.target.value; rerenderHosts(state.open);
});
