/*
 * adapter.js — Adaptador de la versión Twitch: el estado llega del servidor por SSE y las órdenes se envían por HTTP.
 * ÚNICO archivo de la interfaz que difiere entre los repositorios fate-of-the-adventurers-twitch y fate-of-the-adventurers-manual.
 * Debe definir: ADAPTER (capacidades), api(nombre, cuerpo) → resultado del motor/servidor y boot() (arranca el flujo de estados).
 * Se carga después de ui/*.js y antes de ui/main.js.
 */
'use strict';
/* ---- Adaptador de la versión integrada con Twitch: el estado llega del servidor por SSE y las órdenes se envían por HTTP ---- */
// Capacidades que el código compartido (ui/*.js) consulta en lugar de preguntar «qué versión soy»:
//   twitchNames: los nombres de la lista son usuarios de Twitch (formato validado, «@» inicial ignorado y conexión obligatoria).
//   helpSuffix: sufijo de la variante del texto de ayuda de la configuración (cfg.help.<k><sufijo>), si existe.
const ADAPTER = { name: 'twitch', twitchNames: true, helpSuffix: '' };
async function api(name, body){
  try {
    const r = await fetch('/api/' + name, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });
    const j = await r.json(); if (!j.ok) toast(errText(j)); return j;
  } catch(e){ toast(t('toast.noServer')); return { ok:false, errorKey:'toast.noServer' }; }
}
function boot(){
  // Esta versión necesita el servidor local: no funciona abriendo el archivo con doble clic.
  if (location.protocol === 'file:'){
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:999;background:#0a1226;color:#f6e2a6;font:22px Georgia,serif;display:grid;place-items:center;text-align:center;padding:2em';
    box.innerHTML = '<div><h1></h1><p></p></div>';
    box.querySelector('h1').textContent = t('boot.needServer.title'); box.querySelector('p').textContent = t('boot.needServer.body');
    document.body.prepend(box);
    return;
  }
  const es = new EventSource('/api/events');
  es.onmessage = e => setState(JSON.parse(e.data));
  es.onerror = () => toast(t('toast.serverLost'));
}
