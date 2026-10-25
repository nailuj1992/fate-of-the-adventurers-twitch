/*
 * ui/stage.js — Escenario y pantalla final, historial, modal de confirmación, botones y atajos.
 * Archivo COMPARTIDO: idéntico en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual (lo comprueba tests/shared.test.js).
 * Script clásico (no módulo) para que funcione desde file://; comparte el ámbito global con el resto de ui/*.js.
 */
'use strict';
/* =====================================================================
   RENDER
   ===================================================================== */
function showScreen(id){ ['admin','stage','final'].forEach(s => $(s).classList.toggle('active', s === id)); }
const TIMED = ['reveal','confirming','paused','verifying'];
const VIS = {
  idle:['idle'], intro:['idle'], transition:['trans'], countdown:['count'], rolling:['name'],
  reveal:['name','ask','timer'], confirming:['name','ask','timer'], paused:['name','ask','timer'], verifying:['name','ask','timer'],
  won:['name','win'], absent:['name','gone'], deserted:['name','gone']
};
const BTNS = {
  idle:[], intro:['btnPause','btnSkip'], transition:['btnPause','btnSkip'], countdown:['btnPause'], rolling:['btnPause'],
  reveal:['btnConfirm','btnPause','btnDisq'], confirming:['btnConfirm','btnPause','btnDisq'], paused:['btnConfirm','btnPause','btnDisq'],
  verifying:['btnConfirm','btnDisq'], won:['btnPause','btnSkip'], absent:['btnPause','btnSkip'], deserted:['btnPause','btnSkip']
};
function renderTwitch(){
  const tw = S.twitch, rs = tw.reason ? t('twitch.reason.' + tw.reason.code, { detail: tw.reason.detail || '' }) : '';
  const map = {
    connected:['on', t('twitch.status.connected', { channel: tw.channel, user: tw.user })],
    reconnecting:['wait', t('twitch.status.reconnecting') + (rs ? ' (' + rs + ')' : '')],
    disconnected:['err', t('twitch.status.disconnected') + (rs ? ' — ' + rs : '')]
  };
  const [cls, text] = !tw.configured ? ['err', t('twitch.status.missingEnv')] : map[tw.status];
  [$('twDot'), $('twDotA')].forEach(d => d.className = 'dot ' + cls);
  $('twText').textContent = text; $('twTextA').textContent = text;
  $('btnTwLogin').classList.toggle('hide', tw.authenticated && tw.status !== 'disconnected');
  $('btnTwLogin').disabled = !tw.configured;
  $('btnTwLogout').classList.toggle('hide', !tw.authenticated);
}
function render(){
  renderAdmin(); renderTwitch(); renderHistory();
  if (S.screen !== 'stage') return;
  const cel = S.celestial, info = celInfo(cel.index), xuen = S.xuen.active, s = S.status;
  $('stage').dataset.status = s;
  $('stage').dataset.flow = S.flowPaused ? 'paused' : '';
  $('stage').style.setProperty('--stage-glow', info.glow);
  $('stageNum').textContent = xuen ? t('story.xuen.kicker') : t('stage.prizeOf', { prize: S.prize, prizes: S.prizes });
  $('stageName').textContent = xuen ? t('story.xuen.heading') : info.long;     // nombre completo del Celestial
  $('introName').textContent = xuen ? info.long : '';      // en las rondas principales el nombre completo ya está en la cabecera; Xuen lo muestra aquí
  $('stageTitle').textContent = xuen ? t('story.xuen.subtitle') : '— ' + info.title + ' —';
  const xc = $('xuenCodes'); xc.classList.toggle('hide', !xuen);
  if (xuen) xc.textContent = t('stage.xuenCodes', { remaining: S.xuen.remaining, total: S.xuen.total, recovered: S.xuen.recovered });
  $('quote').textContent = quoted(info.intro);
  $('emblemLg').innerHTML = EMBLEMS[cel.index] || '';
  $('emblemSm').innerHTML = EMBLEMS[cel.index] || '';
  // aviso de transición: qué viene a continuación
  if (S.next){
    const nx = S.next, ni = celInfo(nx.celestial.index);
    $('emblemNext').innerHTML = EMBLEMS[nx.celestial.index] || '';
    $('transMsg').textContent = nx.kind === 'round' ? t('stage.next.round', { prize: nx.prize, prizes: S.prizes, celestial: ni.long })
      : nx.kind === 'xuen' ? t('stage.next.xuen', { heading: t('story.xuen.heading') }) : t('stage.next.xuenNext', { prize: nx.prize });
    $('transSub').textContent = quoted(ni.intro);
  }
  const lastWin = S.winners[S.winners.length - 1], nm = { name: S.candidate || '' };
  $('winMsg').textContent = s === 'won' && lastWin
    ? info.victory.replace('{name}', S.candidate) + ' ' + t(xuen ? 'stage.won.xuen' : 'stage.won.main', { prize: lastWin.prize + 1 }) : '';
  const absentMsg = t(S.outcome === 'disqualified' ? 'stage.disq' : xuen ? 'stage.absentXuen' : 'stage.absent', nm);
  $('goneMsg').textContent = s === 'absent' ? absentMsg
    : s === 'deserted' ? (S.candidate ? absentMsg + ' ' : '') + t(xuen ? 'stage.desertedXuen' : 'stage.deserted') : '';
  const grace = s === 'confirming' && S.timer && S.timer.grace;
  const vm = $('verifyMsg');
  vm.classList.toggle('hide', !(s === 'verifying' || grace));
  vm.textContent = t(s === 'verifying' ? 'stage.verifying' : 'stage.grace');
  const vis = VIS[s] || [];
  document.querySelectorAll('#stage [data-v]').forEach(el => el.classList.toggle('hide', !vis.includes(el.dataset.v)));
  $('emblemSm').classList.toggle('hide', s === 'idle' || s === 'intro' || s === 'countdown' || s === 'transition');
  const btns = BTNS[s] || [];
  ['btnConfirm','btnPause','btnDisq','btnSkip'].forEach(id => $(id).classList.toggle('hide', !btns.includes(id)));
  if (S.timer && S.timer.closing) $('btnPause').classList.add('hide');
  if (!S.skippable) $('btnSkip').classList.add('hide');
  $('btnPause').textContent = t(S.flowPaused ? 'stage.btn.resume' : TIMED.includes(s) ? 'stage.btn.pauseTimer' : 'stage.btn.pauseEvent');
  const n = $('notice'); n.classList.toggle('hide', !S.notice); if (S.notice) n.textContent = t(S.notice.key, S.notice.params);
  const c = S.counts;
  $('cPool').textContent = c.eligible; $('cWin').textContent = `${c.winners}/${S.prizes}`;
  $('cAbs').textContent = c.absentEvents;                       // eventos de ausencia (una persona puede sumar varios)
  $('cAbsP').textContent = t('ops.people', { count: c.absentPeople });
  $('cExtra').textContent = t('ops.extra', { delivered: c.prizesDelivered, recovered: c.prizesRecovered, pending: c.prizesPending, dq: c.disqualified, deserted: c.desertedRounds });
  if (S.timer) drawTimer(Date.now() + offset);
}
function renderHistory(){
  const ul = $('history'); ul.innerHTML = '';
  [...S.history].reverse().forEach(h => {
    const li = document.createElement('li');
    li.className = 't-' + (['conf', 'aus', 'dq', 'des', 'sel', 'xuen'].includes(h.kind) ? h.kind : 'sys');
    const tm = document.createElement('time'); tm.textContent = new Date(h.t).toLocaleTimeString(I18n.locale);
    li.append(tm);
    if (h.prize){ const tag = document.createElement('span'); tag.className = 'htag'; tag.textContent = (h.phase === 'recovery' ? 'Xuen · ' : '') + 'P' + h.prize + (h.phase === 'recovery' ? '' : ' · ' + h.celestial); li.append(tag); }
    li.append(document.createTextNode(h.key ? t('log.' + h.key, h.params) : h.text)); ul.appendChild(li);   // se traduce al idioma activo
  });
}
function renderFinal(){
  const k = S.final, ps = S.prizeStates;
  $('finalTitle').textContent = t(k === 'complete' ? 'final.ok' : k === 'incomplete' ? 'final.incomplete' : 'final.cancelled');
  const open = ps.filter(p => p.state !== 'delivered' && p.state !== 'recovered').map(p => '#' + p.prize).join(', ');
  $('finalSub').textContent = k === 'complete' ? t('final.subOk')
    : k === 'incomplete' ? t('final.subIncomplete', { list: open })
    : t('final.subCancelled') + (open ? ' ' + t('final.subCancelledOpen', { list: open }) : '');
  const box = $('finalWinners'); box.innerHTML = '';
  box.classList.toggle('dense', ps.length > 3);
  ps.forEach(p => {
    const info = celInfo(p.celIndex), got = !!p.winner;
    const card = document.createElement('div'); card.className = 'wcard parchment' + (got ? '' : ' empty');
    card.innerHTML = `<div class="emblem-sm">${EMBLEMS[p.celIndex] || ''}</div><div class="deity"></div><div class="trial"></div>` +
      (p.via === 'xuen' ? '<div class="tag"></div>' : '') + `<div class="wname"></div>`;
    card.querySelector('.deity').textContent = t('final.card.deity', { prize: p.prize, celestial: ps.length > 3 ? p.celestial : info.long });   // en la cuadrícula compacta, nombre corto
    card.querySelector('.trial').textContent = t('final.card.trial', { title: info.title.toLocaleLowerCase(I18n.locale) });
    if (p.via === 'xuen') card.querySelector('.tag').textContent = t('final.card.recovered');
    card.querySelector('.wname').textContent = got ? p.winner : t('final.card.unassigned');
    box.appendChild(card);
  });
}

/* =====================================================================
   MODAL DE CONFIRMACIÓN
   ===================================================================== */
let modalResolve = null, modalReason = false;
function ask(text, reason = false){
  return new Promise(res => {
    if (modalResolve) modalResolve(false);
    modalResolve = res; modalReason = reason;
    $('modalText').textContent = text;
    const inp = $('modalInput'); inp.value = ''; inp.style.outline = ''; inp.classList.toggle('hide', !reason);
    $('modal').classList.add('on'); if (reason) inp.focus();
  });
}
// Pide confirmación y un motivo obligatorio (mín. 3 caracteres). Devuelve el motivo, o null si se cancela.
async function askReason(text){ return await ask(text, true) ? $('modalInput').value.trim() : null; }
function closeModal(v){
  if (v && modalReason && $('modalInput').value.trim().length < 3){ $('modalInput').style.outline = '2px solid var(--danger)'; $('modalInput').focus(); return; }
  $('modal').classList.remove('on'); const r = modalResolve; modalResolve = null; if (r) r(v);
}
$('modalYes').onclick = () => closeModal(true);
$('modalNo').onclick  = () => closeModal(false);

/* =====================================================================
   BOTONES Y ATAJOS (solo envían órdenes)
   ===================================================================== */
$('btnConfirm').onclick  = () => api('confirm');       // respaldo manual: en Twitch el chat confirma solo
$('btnPause').onclick    = () => api('pause');
$('btnSkip').onclick     = () => api('skip');
// Descalificación GLOBAL: confirmación + motivo obligatorio. (La ausencia por tiempo es automática y solo afecta a la ronda actual.)
$('btnDisq').onclick     = async () => {
  if (!S || !S.candidate) return;
  const reason = await askReason(t('modal.dq', { name: S.candidate }));
  if (reason) api('disqualify', { reason });
};
$('btnCancel').onclick   = async () => { if (await ask(t('modal.cancel'))) api('cancel'); };
$('btnReset').onclick    = async () => { if (await ask(t('modal.reset'))) api('reset'); };
$('btnBack').onclick     = () => api('back');          // solo se permite al terminar el evento
$('btnTwLogin').onclick  = () => { location.href = '/auth/login'; };
$('btnTwLogout').onclick = async () => { if (await ask(t('modal.logout'))) fetch('/auth/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' }); };

function setPres(on){ document.body.classList.toggle('pres', on); }
$('btnPres').onclick = () => setPres(true);
$('btnPresExit').onclick = () => setPres(false);
// Para OBS: añade ?view=presentation a la URL de la fuente de navegador (y ?lang=es para forzar el idioma).
if (new URLSearchParams(location.search).get('view') === 'presentation') setPres(true);
document.addEventListener('keydown', e => {
  if (e.target === namesEl || e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') setPres(false);
  if (e.key === 'p' || e.key === 'P') setPres(!document.body.classList.contains('pres'));
});

