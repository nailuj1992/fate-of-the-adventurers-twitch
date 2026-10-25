'use strict';
/**
 * Sesiones del panel (solo modo remoto): id aleatorio en una cookie HttpOnly, ligado al ID de Twitch del streamer. En memoria.
 */
const crypto = require('node:crypto');

const SID_RE = /^[0-9a-f]{64}$/;

function createSessions({ cookieName, ttlMs, now = Date.now }) {
  const sessions = new Map();   // sid → { id, exp }

  // Solo se aceptan ids con la forma exacta que generamos: cualquier otra cosa se trata como «sin cookie».
  function cookieOf(req) {
    for (const part of (req.headers.cookie || '').split(';')) {
      const [k, v] = part.trim().split('=');
      if (k === cookieName && SID_RE.test(v || '')) return v;
    }
    return null;
  }
  /** ID de streamer de la sesión de esta petición, o null (una sesión caducada se elimina al consultarla). */
  function lookup(req) {
    const sid = cookieOf(req), rec = sid && sessions.get(sid);
    if (rec && rec.exp > now()) return rec.id;
    if (sid) sessions.delete(sid);
    return null;
  }
  function open(id) {
    sweep();
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, { id: String(id), exp: now() + ttlMs });
    return sid;
  }
  /** Cierra la sesión de la petición (si la hay). */
  function close(req) { const sid = cookieOf(req); if (sid) sessions.delete(sid); }
  /** Cierra todas las sesiones de un streamer (p. ej. al cerrar su sesión de Twitch). */
  function dropAll(id) { for (const [sid, rec] of sessions) if (rec.id === id) sessions.delete(sid); }
  /** Elimina las caducadas: sin esto, una sesión que nunca vuelve a consultarse se quedaría en memoria hasta reiniciar. */
  function sweep() { const t = now(); for (const [sid, rec] of sessions) if (rec.exp <= t) sessions.delete(sid); }

  return { cookieName, ttlMs, lookup, open, close, dropAll, sweep, get size() { return sessions.size; } };
}

module.exports = { createSessions };
