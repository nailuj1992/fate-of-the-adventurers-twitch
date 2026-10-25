/*
 * ui/state.js — Espejo del estado del motor, traducciones, reloj de la interfaz y animación de la selección.
 * Archivo COMPARTIDO: idéntico en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual (lo comprueba tests/shared.test.js).
 * Script clásico (no módulo) para que funcione desde file://; comparte el ámbito global con el resto de ui/*.js.
 */
'use strict';
/* =====================================================================
   ESTADO: espejo del motor del evento (core.js). La interfaz NO decide nada:
   solo muestra el estado que recibe y envía órdenes. El plazo de confirmación es del motor.
   ===================================================================== */
let S = null;                 // último estado recibido
let offset = 0;               // reloj del motor − reloj local (en la versión manual es 0)
let prev = { status: null, candidate: null, round: -1, screen: null, xuen: false };
let serverErr = null;         // resultado fallido al intentar iniciar ({errorKey, errorParams, errors}); se traduce al pintar
const namesEl = $('names');

/* ---------- i18n: todo texto visible pasa por t() ---------- */
const t = (key, params) => I18n.t(key, params);
// Citas con las comillas del idioma: «…» en español, “…” en inglés.
const quoted = x => I18n.locale === 'es' ? '«' + x + '»' : '“' + x + '”';
// Texto de un resultado fallido del motor/servidor (código + parámetros → idioma activo).
function errText(r){
  if (!r) return '';
  if (r.errorKey === 'err.config_invalid' && r.errors){ const k = Object.keys(r.errors)[0]; return cfgErrText(k, r.errors[k]); }
  if (r.errorKey) return t(r.errorKey, r.errorParams || {});
  return r.error || t('err.generic');
}
function applyStatic(){
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-attr]').forEach(el => el.dataset.i18nAttr.split(';').forEach(pair => {
    const [attr, key] = pair.split(':'); if (attr && key) el.setAttribute(attr, t(key));
  }));
  document.title = t('app.title');
  document.querySelectorAll('.langsw button').forEach(b => b.classList.toggle('on', b.dataset.lang === I18n.locale));
}
function refreshLocale(){                                    // al cambiar de idioma se repinta todo lo ya mostrado
  applyStatic(); buildCfgFields(); syncCfgInputs();
  if (S){ render(); if (S.screen === 'final') renderFinal(); renderCfgIfVisible(); }
}
document.querySelectorAll('.langsw button').forEach(b => b.onclick = () => I18n.setLocale(b.dataset.lang, true));
I18n.onChange(refreshLocale);

function toast(msg){
  const el = $('toast'); el.textContent = msg; el.classList.remove('hide');
  clearTimeout(toast.h); toast.h = setTimeout(() => el.classList.add('hide'), 6000);
}
function setState(next){ S = next; offset = S.serverNow - Date.now(); onState(); }

function onState(){
  const xuenNow = S.screen === 'stage' && S.xuen.active;
  $('frame').classList.toggle('xuen', xuenNow);              // tema azul eléctrico solo durante la recuperación de Xuen
  showScreen(S.screen);
  namesEl.disabled = S.screen !== 'admin';
  syncCfgFromState();
  render();
  if (S.screen === 'final') renderFinal();
  if (S.status !== prev.status || S.candidate !== prev.candidate || S.round !== prev.round || S.screen !== prev.screen) transition();
  if (xuenNow && !prev.xuen){                                // entrada de Xuen: destello y energía
    const f = $('xuenFlash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); burst(120); play('reveal');
  }
  prev = { status:S.status, candidate:S.candidate, round:S.round, screen:S.screen, xuen:xuenNow };
}
// Efectos visuales al cambiar de fase (solo estéticos).
function transition(){
  const was = prev.status, rays = $('rays');
  switch (S.status){
    case 'intro': case 'transition': rays.classList.remove('on'); break;
    case 'countdown': $('countNum').textContent = ''; rays.classList.remove('on'); break;
    case 'rolling': rollNextAt = 0; rollIdx = secureIndex(Math.max(1, S.rollNames.length)); rays.classList.remove('on'); break;
    case 'reveal':
      if (S.candidate){ setCand(S.candidate, 'revealed'); if (was === 'rolling'){ burst(40); play('reveal'); } rays.classList.add('on'); }
      break;
    case 'confirming': case 'verifying': case 'paused':
      if (S.candidate && was !== 'reveal' && was !== 'confirming' && was !== 'paused' && was !== 'verifying') setCand(S.candidate, 'revealed', false);
      break;
    case 'won': setCand(S.candidate, 'revealed', was !== 'won'); if (was !== 'won'){ burst(90); play('reveal'); } rays.classList.add('on'); break;
    case 'absent': setCand(S.candidate, 'gone'); rays.classList.remove('on'); play('expire'); break;
    case 'deserted':     // sin candidato si la ronda se declara desierta nada más empezar
      if (S.candidate) setCand(S.candidate, 'gone'); else { $('candName').textContent = ''; }
      rays.classList.remove('on'); play('expire'); break;
    default: rays.classList.remove('on');
  }
  if (S.screen === 'final' && prev.screen !== 'final' && S.final === 'complete') burst(140);
}

/* ---------- Reloj de la interfaz: cuenta atrás, animación de selección y temporizador ---------- */
let rollNextAt = 0, rollIdx = 0;
function phaseRemaining(now){ const p = S.phase; return !p ? 0 : p.paused ? p.remaining : Math.max(0, p.endsAt - now); }
function tickUI(){
  if (!S) return;
  const now = Date.now() + offset;
  if (S.status === 'countdown'){
    const n = Math.max(1, Math.ceil(phaseRemaining(now) / 1000));
    if ($('countNum').textContent !== String(n)){ $('countNum').textContent = n; restartAnim($('countNum')); play('countdown'); }
  }
  if (S.status === 'rolling' && S.rollNames.length && !S.flowPaused && now >= rollNextAt){
    const total = Math.max(1, S.phase ? S.phase.total : 1), tt = Math.min(1, 1 - phaseRemaining(now) / total);
    setCand(S.rollNames[rollIdx++ % S.rollNames.length], 'rolling', false);
    rollNextAt = now + 45 + 280 * tt * tt;     // cada vez más lento (solo estético: el resultado ya lo decidió el motor)
  }
  if (S.timer) drawTimer(now);
}
setInterval(tickUI, 40);

function fmtRemain(ms){ const s = Math.ceil(ms/1000); return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0'); }
function drawTimer(now){
  const tm = S.timer; if (!tm) return;
  const rem = tm.paused ? tm.remaining : (tm.closing || S.status === 'verifying') ? 0 : tm.deadline == null ? tm.remaining : Math.max(0, tm.deadline - now);
  const frac = Math.max(0, Math.min(1, rem / tm.total)), circ = 2*Math.PI*44, fg = $('ringFg');
  fg.style.strokeDasharray = circ; fg.style.strokeDashoffset = circ * (1 - frac);
  $('timeText').textContent = fmtRemain(rem);
  $('timerBox').classList.toggle('low', tm.started && rem <= 20000);
  $('timerNote').classList.toggle('hide', tm.started);        // durante la revelación el plazo aún no corre
}
function setCand(name, cls, animate = true){
  const el = $('candName'); el.textContent = name; el.className = 'cand ' + cls;
  const size = Math.max(3.2, Math.min(10.5, 15 - name.length*0.42));
  el.style.fontSize = `calc(var(--u)*${size})`;
  if (animate && (cls === 'revealed' || cls === 'gone')) restartAnim(el);
}
function restartAnim(el){ el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }

