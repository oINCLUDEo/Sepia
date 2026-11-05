'use strict';
// Заметки на графиках: «сменил хостера», «обновил Xray», «акция в канале» — вертикальная метка на всех графиках.
// Пишет и удаляет node-auth (POST /auth/note, /auth/note-delete), хранятся в VictoriaMetrics как node_note_n
// с метками id, node (ключ ноды, пусто — вся сеть) и text; время — время самой точки. Хранение — 180 дней, как у всего

async function loadNotes(){
  if (DEMO) { state.notes ||= demoNotes(); return; }
  const res = await inst('tlast_over_time(node_note_n[180d])');
  // только что добавленные (VictoriaMetrics их ещё не отдаёт) не теряем, удалённые — не возвращаем
  const fresh = (state.notes || []).filter(n => n.t > Date.now() / 1000 - 120 && !res.some(s => s.metric.id === n.id));
  state.notes = fresh.filter(n => !state.notesGone?.has(n.id)).concat(res.filter(s => !state.notesGone?.has(s.metric.id)).map(s => ({id: s.metric.id, node: s.metric.node || '', text: s.metric.text || '', t: +s.value[1]}))).sort((a, b) => b.t - a.t);
}
function demoNotes(){
  const now = Math.floor(Date.now() / 1000);
  return [{id: 'd1', node: '', text: 'Акция в канале: −30% на год', t: now - 26 * 3600}, {id: 'd2', node: 'p4', text: 'Переехала на тариф с каналом 1 Гбит/с', t: now - 4.5 * 86400},
    {id: 'd3', node: '', text: 'Обновил Xray до 25.x на всех нодах', t: now - 15 * 3600}];
}
const noteWho = nt => nt.node ? (state.model?.nodes[nt.node]?.name || 'нода удалена') : 'Вся сеть';
// метки для графика: заметки сети и ноды; для панели ноды — ещё что нода сделала сама (обновилась, увеличила conntrack…)
function chartMarks(t0, t1, key, actions){
  const out = (state.notes || []).filter(nt => nt.t >= t0 && nt.t <= t1 && (!key ? true : !nt.node || nt.node === key))
    .map(nt => ({t: nt.t, text: key || !nt.node ? nt.text : `${noteWho(nt)}: ${nt.text}`}));
  for (const a of actions || []) if (a.t >= t0 && a.t <= t1) out.push({t: a.t, text: actionText(a), act: true});
  return out.sort((a, b) => a.t - b.t);
}

function renderNotes(){
  const el = $('#notes'); if (!el) return;
  const R = RANGES[state.range], t1 = Date.now() / 1000, list = (state.notes || []).filter(nt => nt.t >= t1 - R.sec);
  el.innerHTML = list.length ? list.map(nt => `<div class="nrow">${icon('sticky-note')}<time>${when(nt.t)}</time><span class="who">${esc(noteWho(nt))}</span><span class="txt">${esc(nt.text)}</span>
      <button class="del" data-id="${esc(nt.id)}" aria-label="Удалить заметку" title="Удалить">${icon('trash-2')}</button></div>`).join('')
    : `<p class="note" style="margin-top:0">Заметок ${RANGES[state.range].label} нет. «Заметка» — отметить на графиках, что вы поменяли: через месяц будет понятно, откуда всплеск.</p>`;
}

/* ---------- окно заметки ---------- */
function openNoteForm(key){
  const sel = $('#note-node'), N = state.model?.nodes || {};
  sel.innerHTML = '<option value="">Вся сеть</option>' + (state.order || []).map(k => `<option value="${esc(k)}">${esc(N[k].name)}</option>`).join('');
  sel.value = key && N[key] ? key : '';
  const d = new Date(); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  $('#note-time').value = d.toISOString().slice(0, 16);
  $('#note-text').value = ''; $('#note-err').textContent = '';
  $('#note-modal').hidden = false; setTimeout(() => $('#note-text').focus(), 30);
}
const closeNoteForm = () => { $('#note-modal').hidden = true; };
$('#note-cancel').addEventListener('click', closeNoteForm);
$('#note-modal').addEventListener('click', e => { if (e.target.id === 'note-modal') closeNoteForm(); });
$('#note-modal').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeNoteForm(); } });
$('#note-form').addEventListener('submit', async e => {
  e.preventDefault();
  const text = $('#note-text').value.trim(), node = $('#note-node').value, t = Math.floor(new Date($('#note-time').value).getTime() / 1000) || Math.floor(Date.now() / 1000);
  if (!text) return;
  const btn = $('#note-form .go'); btn.disabled = true;
  try {
    if (DEMO) state.notes.unshift({id: 'd' + Date.now(), node, text, t});
    else {
      const r = await auth('note', {text, node, t});
      if (r.status !== 200) throw new Error(r.status === 401 ? 'войдите заново' : r.status === 400 ? 'проверьте текст и время (не старше 180 дней)' : 'HTTP ' + r.status);
      // VictoriaMetrics показывает свежие точки с задержкой до 30 секунд — добавляем заметку в список сами
      const {id} = await r.json(); (state.notes ||= []).unshift({id, node, text, t}); state.notes.sort((a, b) => b.t - a.t);
    }
    closeNoteForm(); afterNotes(); toast('Заметка сохранена');
  } catch (err) { $('#note-err').textContent = 'Не сохранилось: ' + err.message; }
  finally { btn.disabled = false; }
});
async function deleteNote(id){
  if (!confirm('Удалить заметку?')) return;
  try {
    if (DEMO) state.notes = state.notes.filter(n => n.id !== id);
    else {
      const r = await auth('note-delete', {id});
      if (r.status !== 204) throw new Error(r.status === 501 ? 'node-auth без VM_ADMIN_KEY — добавьте его в docker-compose' : 'HTTP ' + r.status);
      state.notes = state.notes.filter(n => n.id !== id); (state.notesGone ||= new Set()).add(id);
    }
    afterNotes();
  } catch (err) { toast('Заметка не удалена: ' + err.message); }
}
$('#notes').addEventListener('click', e => { const b = e.target.closest('.del'); if (b) deleteNote(b.dataset.id); });
function afterNotes(){ renderChart(); renderNotes(); if (state.day) renderDay(); if (state.open) renderDrawerChart(); }
