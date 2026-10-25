'use strict';
// Utilidades compartidas por las pruebas de caracterización: reloj simulado y Twitch falso.
const EventEmitter = require('node:events');

/** Reloj simulado: los temporizadores solo avanzan con advance(ms). Misma interfaz que espera Core.Engine ({now, setT, clearT}). */
function makeClock(start = 1_000_000) {
  let t = start, id = 0; const q = new Map();
  return {
    now: () => t,
    setT: (f, ms) => { const i = ++id; q.set(i, { at: t + ms, f }); return i; },
    clearT: i => q.delete(i),
    get active() { return q.size; },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [i, e] of q) if (e.at <= end && (!best || e.at < best.e.at)) best = { i, e };
        if (!best) break;
        q.delete(best.i); t = Math.max(t, best.e.at); best.e.f();
      }
      t = end;
    },
  };
}

/** Twitch falso mínimo para Game: conexión controlable y resolución de logins determinista. */
class FakeTwitch extends EventEmitter {
  constructor() { super(); this.status = 'connected'; this.reason = ''; this.user = null; }
  snapshot() { return { configured: true, authenticated: true, status: this.status, reason: this.reason, user: 'streamer', channel: 'streamer' }; }
  setStatus(s) { this.status = s; this.emit('status', this.snapshot()); }
  async resolveLogins(logins) {
    const m = new Map();
    for (const l of logins) m.set(l.toLowerCase(), { id: 'id_' + l.toLowerCase(), login: l.toLowerCase(), displayName: l[0].toUpperCase() + l.slice(1) });
    return m;
  }
}

/** Claves de un objeto, ordenadas: los contratos se comparan como conjuntos, no por orden de declaración. */
const keys = o => Object.keys(o).sort();

module.exports = { makeClock, FakeTwitch, keys };
