'use strict';
// Подозрительные аккаунты (вкладка «Ёмкость»): похоже на перепродажу или утёкшую подписку — много устройств, подписку
// тянут с разных сетей и разными приложениями, трафик в разы выше обычного. Считает node-auth (/auth/suspects) из API
// панели на лету, раз в 10 минут; о пользователях ничего не хранится. «Это нормально» — прячет аккаунт в этом браузере,
// пока у него не появится новый признак

const acc = {data: null, err: '', busy: false, at: 0};
const ACC_KEY = 'sepia-acc-ok';
const accOk = () => { try { return JSON.parse(localStorage.getItem(ACC_KEY) || '{}'); } catch { return {}; } };
const accSig = x => x.reasons.map(r => r.k).sort().join(',');
const ACC_IC = {devices: 'smartphone', ips: 'globe', apps: 'layers', traffic: 'arrow-down-up'};

async function loadAccounts(fresh = false){
  if (acc.busy || (!fresh && acc.data && Date.now() - acc.at < 300000)) return renderAccounts();
  acc.busy = true; acc.err = ''; renderAccounts();
  try {
    if (DEMO) acc.data = demoAccounts();
    else {
      const r = await auth('suspects', fresh ? {fresh: 1} : {});
      if (r.status === 501) throw new Error('Нужен API-токен Remnawave: RW_TOKEN в stats/.env, затем docker compose up -d auth');
      if (r.status === 401) throw new Error('Войдите заново — сессия истекла');
      if (r.status !== 200) throw new Error('Панель не ответила (HTTP ' + r.status + ') — проверьте права токена');
      acc.data = await r.json();
    }
    acc.at = Date.now();
  } catch (e) { acc.err = e.message; }
  acc.busy = false; renderAccounts(); tabBadges();
}

function renderAccounts(){
  const el = $('#accounts'); if (!el) return;
  if (acc.busy && !acc.data) { el.innerHTML = '<div class="skel skel-table"></div>'; return; }
  if (acc.err) { el.innerHTML = `<p class="empty">${esc(acc.err)}</p>`; return; }
  const D = acc.data; if (!D) { el.innerHTML = ''; return; }
  const ok = accOk(), list = D.list.filter(x => ok[x.uuid] !== accSig(x)), hidden = D.list.length - list.length;
  const miss = [!D.src.devices && 'устройств HWID', !D.src.subs && 'истории запросов подписки'].filter(Boolean);
  const head = `<div class="acc-head"><span class="muted">Проверено ${D.src.users} аккаунтов · ${ago(D.at)}${D.median_gb ? ` · обычный трафик ${fmt(D.median_gb, 0)} ГБ` : ''}${hidden ? ` · скрыто как нормальные: ${hidden} <button class="linkbtn" data-acc-reset>показать</button>` : ''}</span>
    <button class="pill" data-acc-refresh${acc.busy ? ' disabled' : ''}>${icon('refresh-cw')}${acc.busy ? 'Проверяю…' : 'Проверить сейчас'}</button></div>
    ${miss.length ? `<p class="note" style="margin:0 0 10px">Панель не отдала ${miss.join(' и ')} — эти признаки не проверяются (старая версия Remnawave или у токена нет прав).</p>` : ''}`;
  if (!list.length) { el.innerHTML = head + `<div class="adv">${icon('shield-check')}<div><b>Подозрительных аккаунтов нет</b><p>Ни у кого нет лишних устройств, подписку не тянут из разных сетей, трафик без выбросов.</p></div></div>`; return; }
  el.innerHTML = head + `<div class="accs">${list.map(x => `<div class="accrow s-${x.score >= 3 ? 'err' : 'warn'}">
    <div class="acc-u"><b>${esc(x.username || x.uuid.slice(0, 8))}</b>${x.status && x.status !== 'ACTIVE' ? `<span class="tag">${esc(String(x.status).toLowerCase())}</span>` : ''}
      <span class="muted">${x.devices ? `${x.devices} устр. · ` : ''}${x.ips ? `${x.ips} адр. · ` : ''}${fmt(x.traffic_gb, 0)} ГБ</span></div>
    <ul class="acc-why">${x.reasons.map(r => `<li class="w${r.w}">${icon(ACC_IC[r.k] || 'circle-alert')}<span>${esc(r.t)}</span></li>`).join('')}</ul>
    <div class="acc-act"><button class="icon-btn" title="Скопировать имя — найти в панели" data-acc-copy="${esc(x.username || x.uuid)}">${icon('copy')}</button>
      <button class="pill" data-acc-ok="${esc(x.uuid)}" data-sig="${esc(accSig(x))}" title="Скрыть, пока не появится новый признак">${icon('check')}Это нормально</button></div></div>`).join('')}</div>`;
}

function demoAccounts(){
  const r = (k, t, w = 1) => ({k, t, w});
  return {at: Date.now() / 1000 - 240, src: {users: 1342, devices: true, subs: true, traffic: true}, median_gb: 38, list: [
    {uuid: 'd1', username: 'ivan_k', status: 'ACTIVE', score: 4, devices: 11, ips: 17, traffic_gb: 1240, reasons: [r('devices', 'устройств 11 при лимите 3: Android, Windows, iOS', 2), r('ips', 'подписку запрашивали с 17 адресов из 9 разных сетей', 2), r('traffic', 'трафик 1240 ГБ — в 33 раза больше обычного (38 ГБ)', 1)]},
    {uuid: 'd2', username: 'shop_reseller', status: 'ACTIVE', score: 3, devices: 4, ips: 9, traffic_gb: 410, reasons: [r('ips', 'подписку запрашивали с 9 адресов из 6 разных сетей', 1), r('apps', '5 разных приложений: Clash, Happ, Hiddify, Streisand, v2rayNG', 1)]},
    {uuid: 'd3', username: 'max2009', status: 'ACTIVE', score: 1, devices: 6, ips: 2, traffic_gb: 96, reasons: [r('devices', 'устройств 6: Android, iOS, Windows, macOS', 1)]},
    {uuid: 'd4', username: 'torrent_fan', status: 'LIMITED', score: 2, devices: 1, ips: 1, traffic_gb: 2900, reasons: [r('traffic', 'трафик 2900 ГБ — в 76 раз больше обычного (38 ГБ)', 2)]},
  ]};
}

$('#accounts')?.addEventListener('click', async e => {
  const t = e.target;
  if (t.closest('[data-acc-refresh]')) return loadAccounts(true);
  if (t.closest('[data-acc-reset]')) { try { localStorage.removeItem(ACC_KEY); } catch {} return renderAccounts(); }
  const ok = t.closest('[data-acc-ok]');
  if (ok) { const o = accOk(); o[ok.dataset.accOk] = ok.dataset.sig; try { localStorage.setItem(ACC_KEY, JSON.stringify(o)); } catch {} renderAccounts(); tabBadges(); return; }
  const c = t.closest('[data-acc-copy]');
  if (c) { try { await navigator.clipboard.writeText(c.dataset.accCopy); c.innerHTML = icon('check'); setTimeout(() => c.innerHTML = icon('copy'), 1400); } catch { toast('Не скопировалось'); } }
});
