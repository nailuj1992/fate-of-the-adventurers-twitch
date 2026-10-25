/*
 * ui/admin.js — Administración: análisis de participantes, panel de configuración e inicio del evento.
 * Archivo COMPARTIDO: idéntico en los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual (lo comprueba tests/shared.test.js).
 * Script clásico (no módulo) para que funcione desde file://; comparte el ámbito global con el resto de ui/*.js.
 */
'use strict';
/* =====================================================================
   ADMINISTRACIÓN: participantes y configuración (se valida aquí y otra vez en el motor)
   ===================================================================== */
const normKey = s => s.normalize('NFC').toLocaleLowerCase(I18n.locale);
const cleanLine = s => { const x = s.replace(/\s+/g,' ').trim(); return ADAPTER.twitchNames ? x.replace(/^@/,'') : x; };
let serverErr = null;                                // resultado fallido al intentar iniciar ({errorKey, errorParams, errors}); se traduce al pintar

function analyze(){
  const lines = namesEl.value.split(/\r?\n/), valid = [], seen = new Map(), bad = []; let empty = 0;
  lines.forEach((raw, i) => {
    const name = cleanLine(raw);
    if (!name){ empty++; return; }
    if (ADAPTER.twitchNames && !Core.LOGIN_RE.test(name)){ bad.push({name, line:i+1}); return; }
    const key = normKey(name);
    if (!seen.has(key)) seen.set(key, {name, lines:[i+1], count:0});
    const e = seen.get(key); e.count++; if (e.lines[e.lines.length-1] !== i+1) e.lines.push(i+1);
    valid.push({name, key});
  });
  return {valid, bad, dups:[...seen.values()].filter(e => e.count > 1), empty};
}

/* ----- panel de configuración ----- */
const CFG_MAIN = ['prizes','confirmSec','countdownSec','rollSec','revealSec','winnerSec','absentSec','transitionSec','introSec'];
const CFG_ADV  = ['lateSec','graceSec'];
let cfgDraft = { ...Core.DEFAULT_CONFIG }, cfgDirty = false, cfgCheck = { ok:true, config:{...Core.DEFAULT_CONFIG}, errors:{} };
const cfgLabel = k => t('cfg.label.' + k);
// Mensaje corto de un error de campo y mensaje completo (con la etiqueta de la opción).
const cfgErrShort = e => t('cfg.err.' + e.code, e);
const cfgErrText = (k, e) => cfgLabel(k) + ': ' + cfgErrShort(e);
// El texto de ayuda puede tener una variante para la versión manual (clave con sufijo _manual).
const cfgHelp = k => {
  const variant = 'cfg.help.' + k + ADAPTER.helpSuffix;
  return t(ADAPTER.helpSuffix && I18n.has(variant) ? variant : 'cfg.help.' + k);
};
function buildCfgFields(){
  const mk = k => {
    const [lo, hi] = Core.LIMITS[k], unit = k === 'prizes' ? '' : ' s';
    const tip = cfgHelp(k).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
    return `<label class="cfg-row"><span>${cfgLabel(k)} <small>(${lo}–${hi}${unit})</small> <i class="help" tabindex="0" role="note" data-tip="${tip}">?</i></span>` +
      `<input type="number" inputmode="numeric" step="1" min="${lo}" max="${hi}" data-k="${k}" id="cfg_${k}"><em data-e="${k}"></em></label>`;
  };
  $('cfgMain').innerHTML = CFG_MAIN.map(mk).join(''); $('cfgAdv').innerHTML = CFG_ADV.map(mk).join('');
  document.querySelectorAll('#paneC input[data-k]').forEach(inp => inp.addEventListener('input', () => {
    cfgDraft[inp.dataset.k] = inp.value; cfgDirty = true; $('cfgMsg').textContent = ''; renderCfg(); renderAdmin();
  }));
}
function syncCfgInputs(){ for (const k of [...CFG_MAIN, ...CFG_ADV]) { const i = $('cfg_' + k); if (i && document.activeElement !== i) i.value = cfgDraft[k]; } }
function syncCfgFromState(){                                 // el estado guardado manda mientras no haya cambios sin guardar
  if (S.screen !== 'admin') { cfgDirty = false; return; }
  if (!cfgDirty){ cfgDraft = { ...S.config }; syncCfgInputs(); }
}
function renderCfg(){
  const count = analyze().valid.length;
  cfgCheck = Core.validateConfig(cfgDraft, count > 0 ? count : undefined);   // sin lista aún no se compara con los participantes
  for (const k of [...CFG_MAIN, ...CFG_ADV]){
    const e = document.querySelector(`#paneC em[data-e="${k}"]`), i = $('cfg_' + k);
    if (e) e.textContent = cfgCheck.errors[k] ? cfgErrShort(cfgCheck.errors[k]) : '';
    if (i) i.classList.toggle('bad', !!cfgCheck.errors[k]);
  }
  const n = cfgCheck.errors.prizes ? null : Number(cfgCheck.config.prizes);
  const ul = $('cfgPreview'); ul.innerHTML = '';
  if (n){
    Core.preview(n).forEach(p => { const li = document.createElement('li'); li.innerHTML = '<b></b><span></span>'; li.firstChild.textContent = t('cfg.preview.prize', { n: p.prize }); li.lastChild.textContent = '— ' + celInfo(p.index).long; ul.appendChild(li); });
    const x = document.createElement('li'); x.className = 'xrow'; x.innerHTML = '<b>Xuen</b><span></span>'; x.lastChild.textContent = t('cfg.preview.xuen'); ul.appendChild(x);
  } else { const li = document.createElement('li'); li.textContent = t('cfg.preview.invalid'); ul.appendChild(li); }
  $('cfgSave').disabled = !cfgCheck.ok || S.screen !== 'admin';
  $('cfgDirty').classList.toggle('hide', !cfgDirty);
}
$('cfgRestore').onclick = () => { cfgDraft = { ...Core.DEFAULT_CONFIG }; cfgDirty = true; syncCfgInputs(); $('cfgMsg').textContent = t('cfg.restored'); renderCfg(); renderAdmin(); };
$('cfgSave').onclick = async () => {
  if (!cfgCheck.ok) return;
  const r = await api('config', { config: cfgCheck.config });
  if (r.ok){ cfgDirty = false; $('cfgMsg').textContent = t('cfg.saved'); } else $('cfgMsg').textContent = errText(r) || t('cfg.saveFailed');
  renderCfg();
};
document.querySelectorAll('.tab').forEach(tb => tb.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === tb));
  $('paneP').classList.toggle('hide', tb.dataset.tab !== 'people'); $('paneC').classList.toggle('hide', tb.dataset.tab !== 'config');
  if (tb.dataset.tab === 'config') renderCfg();
});

function renderAdmin(){
  if (!S) return;
  const a = analyze(), tw = S.twitch, locked = S.screen !== 'admin';
  renderCfgIfVisible();
  const need = Math.max(1, cfgCheck.errors.prizes ? 1 : Number(cfgCheck.config.prizes));
  $('stValid').textContent = a.valid.length;
  $('stDup').textContent = a.dups.reduce((n,d) => n + d.count - 1, 0);
  $('stEmpty').textContent = a.empty;
  const box = $('problems'); box.innerHTML = '';
  const add = (txt, ok) => { const d = document.createElement('div'); d.className = 'problem' + (ok ? ' ok' : ''); d.textContent = txt; box.appendChild(d); };
  if (serverErr) add(errText(serverErr));
  a.bad.forEach(b => add(t('admin.problems.badLogin', { line: b.line, name: b.name })));
  a.dups.forEach(d => add(t('admin.problems.dup', { name: d.name, count: d.count, lines: d.lines.join(', ') })));
  if (a.valid.length < need) add(t('admin.problems.need', { need, have: a.valid.length }));
  if (!cfgCheck.ok) add(t('admin.problems.cfgErrors'));
  if (ADAPTER.twitchNames && tw && tw.status !== 'connected') add(t('admin.problems.connect'));
  if (!a.bad.length && !a.dups.length && a.valid.length >= need && cfgCheck.ok && (!ADAPTER.twitchNames || tw?.status === 'connected'))
    add(t('admin.problems.ok', { count: a.valid.length, prizes: cfgCheck.config.prizes }) + (ADAPTER.twitchNames ? ' ' + t('admin.problems.okTwitch') : ''), true);
  const dupKeys = new Set(a.dups.map(d => normKey(d.name)));
  const chips = $('chips'); chips.innerHTML = '';
  a.valid.slice(0,200).forEach(v => { const c = document.createElement('span'); c.className = 'chip' + (dupKeys.has(v.key) ? ' dup' : ''); c.textContent = v.name; chips.appendChild(c); });
  const blocked = locked || a.bad.length > 0 || a.dups.length > 0 || a.valid.length < need || !cfgCheck.ok || (ADAPTER.twitchNames && tw?.status !== 'connected');
  $('btnStart').disabled = blocked; $('btnStart2').disabled = blocked;
}
function renderCfgIfVisible(){ if (!$('paneC').classList.contains('hide')) renderCfg(); else { const c = analyze().valid.length; cfgCheck = Core.validateConfig(cfgDraft, c > 0 ? c : undefined); } }
namesEl.addEventListener('input', () => { serverErr = null; renderAdmin(); });
$('btnClean').onclick = () => { namesEl.value = namesEl.value.split(/\r?\n/).map(cleanLine).filter(Boolean).join('\n'); renderAdmin(); };
$('btnShuffle').onclick = () => { namesEl.value = Core.secureShuffle(namesEl.value.split(/\r?\n/).map(cleanLine).filter(Boolean)).join('\n'); renderAdmin(); };
$('btnDedupe').onclick = () => {
  const seen = new Set(), out = [];
  namesEl.value.split(/\r?\n/).map(cleanLine).filter(Boolean).forEach(n => { const k = normKey(n); if (!seen.has(k)){ seen.add(k); out.push(n); } });
  namesEl.value = out.join('\n'); renderAdmin();
};
async function startEvent(){
  const a = analyze(); serverErr = null;
  cfgCheck = Core.validateConfig(cfgDraft, a.valid.length);
  if (a.bad.length || a.dups.length || !cfgCheck.ok || a.valid.length < cfgCheck.config.prizes) { renderAdmin(); return; }
  if (!await ask(t('modal.start', { count: a.valid.length, prizes: cfgCheck.config.prizes }))) return;
  $('btnStart').disabled = $('btnStart2').disabled = true;
  const r = await api('start', { names: a.valid.map(v => v.name), config: cfgCheck.config });
  if (!r.ok){ serverErr = r; renderAdmin(); } else cfgDirty = false;
}
$('btnStart').onclick = startEvent; $('btnStart2').onclick = startEvent;

