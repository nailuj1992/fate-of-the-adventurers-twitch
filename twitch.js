'use strict';
/**
 * Integración con Twitch de UN streamer: junta el cliente autenticado (twitch/auth.js: tokens, OAuth, Helix) y la sesión EventSub
 * (twitch/eventsub.js: WebSocket, reconexión) y mantiene lo que es de la cuenta: quién es el usuario, qué canal se lee y el estado
 * de conexión que ve el resto de la aplicación. Solo lectura del chat (scope user:read:chat); los tokens viven únicamente en el servidor.
 *
 * Eventos emitidos:
 *   'status'  (snapshot)  → cambió el estado de conexión
 *   'identity' ({id, login} | null)  → cambió la cuenta de Twitch conectada (inicio/cierre de sesión, cambio de cuenta)
 *   'message' ({messageId, chatterId, chatterLogin, text, receivedAt})  → mensaje de chat (sin duplicados)
 */
const EventEmitter = require('node:events');
const { TwitchAuth, AuthError, SCOPES } = require('./twitch/auth');
const { EventSubSession, EVENTSUB_URL } = require('./twitch/eventsub');

const VALIDATE_EVERY_MS = 3600000;           // Twitch exige validar el token cada hora

class Twitch extends EventEmitter {
  constructor(o) {
    super();
    this.channelLogin = (o.channel || '').toLowerCase();
    this.logger = o.log || (() => {});
    this.auth = new TwitchAuth(o);
    this.session = new EventSubSession({
      WS: o.WebSocketImpl, url: o.eventsubUrl, backoffBaseMs: o.backoffBaseMs, watchdogMarginMs: o.watchdogMarginMs, timers: o.timers,
      subscribe: sessionId => this.auth.subscribeChat(this.channelUser.id, this.user.id, sessionId),
      ensureToken: () => this.auth.ensureToken(),
    });
    this.user = null;            // {id, login}  (cuenta autorizada)
    this.channelUser = null;     // {id, login}  (canal cuyo chat se lee)
    this.status = 'disconnected';
    this.reason = null;          // {code, detail?} (la interfaz lo traduce: twitch.reason.<code>)
    this.validateTimer = null;

    this.session.on('status', (status, reason) => this.setStatus(status, reason));
    this.session.on('message', m => this.emit('message', m));
    this.auth.on('invalidated', reason => this.dropSession(reason));   // el refresh token dejó de valer
  }

  get configured() { return this.auth.configured; }
  get tokens() { return this.auth.tokens; }
  snapshot() {
    return { configured: this.configured, authenticated: !!this.tokens, status: this.status, reason: this.reason,
             user: this.user ? this.user.login : null, channel: this.channelUser ? this.channelUser.login : null };
  }
  setStatus(status, reason = null) {
    if (typeof reason === 'string') reason = reason ? { code: reason } : null;
    if (this.status === status && JSON.stringify(this.reason) === JSON.stringify(reason)) return;
    this.status = status; this.reason = reason;
    this.logger(`status: ${status}${reason ? ' · ' + reason.code + (reason.detail ? ' (' + reason.detail + ')' : '') : ''}`);
    this.emit('status', this.snapshot());
  }
  // Único punto que cambia la cuenta conectada: avisa (evento 'identity') solo si realmente cambió.
  setUser(u) {
    const before = this.user ? this.user.id : null, after = u ? u.id : null;
    this.user = u;
    if (before !== after) this.emit('identity', u);
  }
  /** Olvida la cuenta y corta el chat (los tokens ya se borraron o se borran aparte). */
  dropSession(reason) {
    this.channelUser = null; this.setUser(null);
    this.session.stop();
    this.setStatus('disconnected', { code: reason });
  }
  invalidateTokens(reason) { this.auth.clearTokens(); this.dropSession(reason); }

  /* ---------- OAuth (delegado en twitch/auth.js) ---------- */
  authUrl() { return this.auth.authUrl(); }
  exchange(query) { return this.auth.exchange(query); }
  resolveLogins(logins) { return this.auth.resolveLogins(logins); }
  /** Esta instancia pasa a usar esos tokens (se guardan, se valida el scope y se conecta al chat). */
  async adopt(tokens) {
    this.auth.tokens = tokens; this.auth.saveTokens();
    await this.setup();
    this.connect();
  }

  /** Valida el token, comprueba el scope y resuelve usuario y canal. */
  async setup() {
    const v = await this.auth.validate();
    if (!v.scopes?.includes(SCOPES[0])) {
      this.invalidateTokens('auth_scope');
      throw new AuthError('Missing the user:read:chat scope');
    }
    this.setUser({ id: v.user_id, login: v.login });
    if (!this.channelLogin || this.channelLogin === v.login) this.channelUser = { id: v.user_id, login: v.login };
    else {
      const m = await this.resolveLogins([this.channelLogin]);
      const c = m.get(this.channelLogin);
      if (!c) throw new Error(`The channel "${this.channelLogin}" does not exist on Twitch`);
      this.channelUser = { id: c.id, login: c.login };
    }
    clearInterval(this.validateTimer);
    this.validateTimer = setInterval(() => this.auth.validate().catch(e => this.logger('validate: ' + e.message)), VALIDATE_EVERY_MS);
    this.validateTimer.unref?.();
  }
  async init() {
    this.auth.loadTokens();
    if (!this.tokens) return;
    try { await this.setup(); this.connect(); }
    catch (e) { if (e.code !== 'AUTH') { this.setStatus('disconnected', { code: 'error', detail: e.message }); } }
  }
  connect() { this.session.connect(); }
  logout() {
    this.session.stop(); clearInterval(this.validateTimer);
    this.auth.clearTokens(); this.channelUser = null; this.setUser(null);
    this.setStatus('disconnected', 'logged_out');
  }
}

module.exports = { Twitch, AuthError, SCOPES, EVENTSUB_URL };
