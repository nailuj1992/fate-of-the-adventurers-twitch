'use strict';
/**
 * Sesión EventSub por WebSocket: conexión, migración (session_reconnect), vigilancia de keepalive, reintentos con espera
 * exponencial y deduplicación de mensajes. No sabe de tokens ni de cuentas: quien la usa le da `subscribe` y `ensureToken`.
 *
 * Eventos:
 *   'status'  (status, reason)  → 'reconnecting' | 'connected' | 'disconnected'; reason = texto corto u objeto {code, detail?}
 *   'message' ({messageId, chatterId, chatterLogin, text, receivedAt})  → mensaje de chat (sin duplicados)
 */
const EventEmitter = require('node:events');

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const WATCHDOG_MARGIN_MS = 2000;             // margen sobre keepalive_timeout_seconds
const DEFAULT_KEEPALIVE_S = 10;              // si el welcome no indica keepalive_timeout_seconds
const SEEN_MAX = 2000;                       // ids de mensaje recordados para idempotencia
const RETRY_BASE_MS = 1000, RETRY_MAX_MS = 30000;
const CLOSE_NORMAL = 1000;

class EventSubSession extends EventEmitter {
  /**
   * o.WS: constructor de WebSocket. o.url: punto de conexión. o.subscribe(sessionId): Promise que suscribe al chat.
   * o.ensureToken(): Promise que garantiza un token vigente antes de reintentar. o.timers: {setTimeout, clearTimeout} (pruebas).
   */
  constructor(o) {
    super();
    this.WS = o.WS || WebSocket;
    this.url = o.url || EVENTSUB_URL;
    this.subscribe = o.subscribe;
    this.ensureToken = o.ensureToken;
    this.backoffBaseMs = o.backoffBaseMs ?? RETRY_BASE_MS;
    this.wdMargin = o.watchdogMarginMs ?? WATCHDOG_MARGIN_MS;
    this.timers = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: t => clearTimeout(t) };
    this.wanted = false;
    this.active = null;          // socket con sesión activa
    this.pending = null;         // socket de migración (session_reconnect)
    this.retryTimer = null; this.retryN = 0;
    this.seen = new Set(); this.seenQueue = [];
  }

  connect() {
    this.wanted = true; this.timers.clearTimeout(this.retryTimer);
    this.emit('status', 'reconnecting', 'connecting');
    this.openSocket(this.url, false);
  }
  /** Deja de querer la conexión y cierra todo (cierre de sesión o revocación). */
  stop() {
    this.wanted = false; this.timers.clearTimeout(this.retryTimer);
    this.shutdownSockets();
  }
  openSocket(url, migrating) {
    if (!migrating) this.shutdownSockets();
    const ws = new this.WS(url);
    const rec = { ws, migrating, sessionId: null, keepalive: DEFAULT_KEEPALIVE_S, wd: null, dead: false };
    if (migrating) this.pending = rec; else this.active = rec;
    ws.addEventListener('message', ev => this.onMessage(rec, typeof ev.data === 'string' ? ev.data : String(ev.data)));
    ws.addEventListener('close', () => this.onClose(rec));
    ws.addEventListener('error', () => {});   // siempre va seguido de 'close'
  }
  shutdownSockets() {
    for (const k of ['active', 'pending']) {
      const r = this[k]; this[k] = null;
      if (r) this.kill(r, CLOSE_NORMAL);
    }
  }
  /** Marca el socket como muerto (sus eventos pendientes se ignoran), detiene su vigilante y lo cierra. */
  kill(rec, code) {
    rec.dead = true; this.timers.clearTimeout(rec.wd);
    try { rec.ws.close(code); } catch {}
  }
  armWatchdog(rec) {
    this.timers.clearTimeout(rec.wd);
    rec.wd = this.timers.setTimeout(() => this.onLost(rec, { code: 'lost_keepalive' }), rec.keepalive * 1000 + this.wdMargin);
  }
  dedupe(id) {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.seen.add(id); this.seenQueue.push(id);
    if (this.seenQueue.length > SEEN_MAX) this.seen.delete(this.seenQueue.shift());
    return false;
  }
  onMessage(rec, data) {
    if (rec.dead) return;
    let msg; try { msg = JSON.parse(data); } catch { return; }
    const meta = msg.metadata || {};
    if (this.dedupe(meta.message_id)) return;           // Twitch puede reenviar: se ignora el repetido
    switch (meta.message_type) {
      case 'session_welcome': return this.onWelcome(rec, msg.payload.session);
      case 'session_keepalive': this.armWatchdog(rec); return;
      case 'session_reconnect':
        this.armWatchdog(rec);
        if (!this.pending) this.openSocket(msg.payload.session.reconnect_url, true);   // URL tal cual, sin modificarla
        return;
      case 'notification': {
        this.armWatchdog(rec);
        if (meta.subscription_type !== 'channel.chat.message') return;
        const e = msg.payload.event || {};
        this.emit('message', { messageId: e.message_id, chatterId: e.chatter_user_id, chatterLogin: e.chatter_user_login,
          text: e.message?.text || '', receivedAt: Date.now() });
        return;
      }
      case 'revocation': {
        const st = msg.payload.subscription?.status;
        this.stop();
        this.emit('status', 'disconnected', { code: 'revoked', detail: st });
        return;
      }
      default: return;
    }
  }
  onWelcome(rec, session) {
    rec.sessionId = session.id;
    rec.keepalive = session.keepalive_timeout_seconds || DEFAULT_KEEPALIVE_S;
    this.armWatchdog(rec);
    if (rec.migrating) {   // la nueva conexión hereda las suscripciones: se cierra la vieja sin perder el estado
      const old = this.active; this.active = rec; this.pending = null; rec.migrating = false;
      if (old) this.kill(old, CLOSE_NORMAL);
      return;
    }
    this.subscribe(rec.sessionId).then(() => {
      if (rec.dead) return;
      this.retryN = 0; this.emit('status', 'connected', null);
    }).catch(e => {
      if (rec.dead) return;
      if (e.code === 'AUTH') return;                 // ya notificado por quien invalidó los tokens
      this.onLost(rec, { code: 'lost_subscribe', detail: e.message });
    });
  }
  onClose(rec) {
    this.timers.clearTimeout(rec.wd);
    if (rec.dead) return;
    if (rec === this.pending) { this.pending = null; return; }   // falló la migración: la vieja sigue viva
    if (rec === this.active) this.onLost(rec, { code: 'lost_closed' });
  }
  onLost(rec, why) {
    if (rec.dead) return;
    this.kill(rec);
    if (this.active === rec) this.active = null;
    if (!this.wanted) return;
    this.emit('status', 'reconnecting', why);
    this.scheduleRetry();
  }
  scheduleRetry() {
    this.timers.clearTimeout(this.retryTimer);
    const delay = Math.min(RETRY_MAX_MS, this.backoffBaseMs * 2 ** this.retryN++);
    this.retryTimer = this.timers.setTimeout(async () => {
      if (!this.wanted) return;
      try { await this.ensureToken(); if (this.wanted) this.openSocket(this.url, false); }
      catch (e) { if (e.code !== 'AUTH' && this.wanted) this.scheduleRetry(); }
    }, delay);
    this.retryTimer?.unref?.();       // el reintento no debe impedir que el proceso termine
  }
}

module.exports = { EventSubSession, EVENTSUB_URL };
