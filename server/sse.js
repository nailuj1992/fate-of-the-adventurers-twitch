'use strict';
/**
 * Canal SSE del estado: cada cliente recibe solo el estado de SU streamer (en local, el del tenant en pantalla).
 */
const PING_MS = 15000;

function createSseHub(tenants, { remote }) {
  const clients = new Set();   // { res, id }  (en local no importa el id: ve el tenant en pantalla)
  const viewOf = c => remote ? tenants.get(c.id) : tenants.current;
  function send(c) { const t = viewOf(c); if (t) c.res.write(`data: ${JSON.stringify(t.game.publicState())}\n\n`); }
  const sendAll = () => { for (const c of clients) send(c); };
  const ping = setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, PING_MS);
  ping.unref();

  /** Empuja a los clientes de `t` cada vez que cambia su juego o su conexión. Devuelve la función que lo desengancha. */
  function attach(t) {
    const push = () => { for (const c of clients) if (viewOf(c) === t) send(c); };
    t.game.on('change', push); t.twitch.on('status', push);
    return () => { t.game.off('change', push); t.twitch.off('status', push); };
  }
  /** Registra una respuesta SSE abierta para el tenant `id` y le envía el estado actual. */
  function add(res, id) {
    const c = { res, id }; clients.add(c);
    res.on('close', () => clients.delete(c));
    send(c);
  }
  return { attach, add, sendAll, close: () => clearInterval(ping), get size() { return clients.size; } };
}

module.exports = { createSseHub };
