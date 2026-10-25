'use strict';
/**
 * Integración con Twitch: OAuth (authorization code) + EventSub por WebSocket.
 * Solo lectura del chat (scope user:read:chat). Los tokens viven únicamente en el servidor.
 *
 * Eventos emitidos:
 *   'status'  (snapshot)  → cambió el estado de conexión
 *   'message' ({messageId, chatterId, chatterLogin, text, receivedAt})  → mensaje de chat (sin duplicados)
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const OAUTH = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const SCOPES = ['user:read:chat'];           // único permiso solicitado
const WATCHDOG_MARGIN_MS = 2000;             // margen sobre keepalive_timeout_seconds
const SEEN_MAX = 2000;                       // ids de mensaje recordados para idempotencia

class AuthError extends Error { constructor(m){ super(m); this.code = 'AUTH'; } }

class Twitch extends EventEmitter {
  constructor(o) {
    super();
    this.clientId = o.clientId || '';
    this.clientSecret = o.clientSecret || '';
    this.redirectUri = o.redirectUri;
    this.channelLogin = (o.channel || '').toLowerCase();
    this.tokenFile = o.tokenFile;
    this.fetch = o.fetchImpl || fetch;
    this.WS = o.WebSocketImpl || WebSocket;
    this.eventsubUrl = o.eventsubUrl || EVENTSUB_URL;
    this.backoffBaseMs = o.backoffBaseMs ?? 1000;
    this.logger = o.log || (() => {});
    this.wdMargin = o.watchdogMarginMs ?? WATCHDOG_MARGIN_MS;

    this.tokens = null;          // {accessToken, refreshToken, expiresAt}
    this.user = null;            // {id, login}  (cuenta autorizada)
    this.channelUser = null;     // {id, login}  (canal cuyo chat se lee)
    this.status = 'disconnected';
    this.reason = null;            // {code, detail?} (la interfaz lo traduce: twitch.reason.<code>)
    this.wanted = false;
    this.active = null;          // socket con sesión activa
    this.pending = null;         // socket de migración (session_reconnect)
    this.retryTimer = null; this.retryN = 0;
    this.refreshing = null;
    this.oauthStates = new Map();
    this.seen = new Set(); this.seenQueue = [];
    this.validateTimer = null;
  }

  get configured() { return !!(this.clientId && this.clientSecret); }
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

  /* ---------- tokens ---------- */
  loadTokens() {
    try { this.tokens = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')); } catch { this.tokens = null; }
  }
  saveTokens() {
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens), { mode: 0o600 });
  }
  static toTokens(j) {
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 0) * 1000 };
  }
  invalidateTokens(reason) {
    this.tokens = null; this.user = null; this.channelUser = null;
    try { fs.unlinkSync(this.tokenFile); } catch {}
    this.shutdownSockets(); this.wanted = false;
    this.setStatus('disconnected', { code: reason });
  }
  async tokenRequest(params) {
    const res = await this.fetch(`${OAUTH}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const j = await res.json().catch(() => ({}));
    return { res, j };
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      if (!this.tokens) throw new AuthError('Not authenticated');
      const { res, j } = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken });
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
          this.invalidateTokens('auth_expired');
          throw new AuthError(j.message || 'invalid refresh token');
        }
        throw new Error(`Token refresh: HTTP ${res.status}`);
      }
      this.tokens = Twitch.toTokens(j);   // el refresh token puede rotar: se guarda siempre el nuevo
      this.saveTokens();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async ensureToken() {
    if (!this.tokens) throw new AuthError('Not authenticated');
    if (Date.now() >= this.tokens.expiresAt - 120000) await this.refresh();
  }
  async api(method, url, body, retried = false) {
    await this.ensureToken();
    const res = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.tokens.accessToken}`, 'Client-Id': this.clientId, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) { await this.refresh(); return this.api(method, url, body, true); }
    return res;
  }

  /* ---------- OAuth (authorization code, secreto solo en el servidor) ---------- */
  authUrl() {
    if (!this.configured) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are missing');
    const state = crypto.randomBytes(16).toString('hex');
    this.oauthStates.set(state, Date.now() + 10 * 60000);
    const u = new URL(`${OAUTH}/authorize`);
    u.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code',
      scope: SCOPES.join(' '), state }).toString();
    return u.toString();
  }
  async handleCallback(query) {
    if (query.error) throw new Error(`Twitch denied access: ${query.error_description || query.error}`);
    const exp = this.oauthStates.get(query.state);
    this.oauthStates.delete(query.state);
    if (!exp || exp < Date.now()) throw new Error('Invalid or expired state parameter (possible CSRF)');
    const { res, j } = await this.tokenRequest({ grant_type: 'authorization_code', code: query.code, redirect_uri: this.redirectUri });
    if (!res.ok) throw new Error(`Code exchange: ${j.message || 'HTTP ' + res.status}`);
    this.tokens = Twitch.toTokens(j); this.saveTokens();
    await this.setup();
    this.connect();
  }
  async validate(retried = false) {
    if (!this.tokens) throw new AuthError('Not authenticated');
    const res = await this.fetch(`${OAUTH}/validate`, { headers: { Authorization: `OAuth ${this.tokens.accessToken}` } });
    if (res.status === 401 && !retried) { await this.refresh(); return this.validate(true); }
    if (!res.ok) throw new Error(`Token validation: HTTP ${res.status}`);
    return res.json();
  }
  /** Valida el token, comprueba el scope y resuelve usuario y canal. */
  async setup() {
    const v = await this.validate();
    if (!v.scopes || !v.scopes.includes('user:read:chat')) {
      this.invalidateTokens('auth_scope');
      throw new AuthError('Missing the user:read:chat scope');
    }
    this.user = { id: v.user_id, login: v.login };
    if (!this.channelLogin || this.channelLogin === v.login) this.channelUser = { id: v.user_id, login: v.login };
    else {
      const m = await this.resolveLogins([this.channelLogin]);
      const c = m.get(this.channelLogin);
      if (!c) throw new Error(`The channel "${this.channelLogin}" does not exist on Twitch`);
      this.channelUser = { id: c.id, login: c.login };
    }
    clearInterval(this.validateTimer);   // Twitch exige validar el token cada hora
    this.validateTimer = setInterval(() => this.validate().catch(e => this.logger('validate: ' + e.message)), 3600000);
    this.validateTimer.unref && this.validateTimer.unref();
  }
  async init() {
    this.loadTokens();
    if (!this.tokens) return;
    try { await this.setup(); this.connect(); }
    catch (e) { if (e.code !== 'AUTH') { this.setStatus('disconnected', { code: 'error', detail: e.message }); } }
  }
  logout() {
    this.wanted = false; this.shutdownSockets(); clearInterval(this.validateTimer);
    this.tokens = null; this.user = null; this.channelUser = null;
    try { fs.unlinkSync(this.tokenFile); } catch {}
    this.setStatus('disconnected', 'logged_out');
  }

  /** logins → Map(login en minúsculas → {id, login, displayName}). Los inexistentes no aparecen. */
  async resolveLogins(logins) {
    const out = new Map();
    for (let i = 0; i < logins.length; i += 100) {
      const q = new URLSearchParams(); logins.slice(i, i + 100).forEach(l => q.append('login', l));
      const res = await this.api('GET', `${HELIX}/users?${q}`);
      if (!res.ok) throw new Error(`Helix /users: HTTP ${res.status}`);
      for (const u of (await res.json()).data || []) out.set(u.login.toLowerCase(), { id: u.id, login: u.login, displayName: u.display_name });
    }
    return out;
  }

  /* ---------- EventSub WebSocket ---------- */
  connect() {
    this.wanted = true; clearTimeout(this.retryTimer);
    this.setStatus('reconnecting', 'connecting');
    this.openSocket(this.eventsubUrl, false);
  }
  openSocket(url, migrating) {
    if (!migrating) this.shutdownSockets();
    const ws = new this.WS(url);
    const rec = { ws, migrating, sessionId: null, keepalive: 10, wd: null, dead: false };
    if (migrating) this.pending = rec; else this.active = rec;
    ws.addEventListener('message', ev => this.onMessage(rec, typeof ev.data === 'string' ? ev.data : String(ev.data)));
    ws.addEventListener('close', () => this.onClose(rec));
    ws.addEventListener('error', () => {});   // siempre va seguido de 'close'
  }
  shutdownSockets() {
    for (const k of ['active', 'pending']) {
      const r = this[k]; this[k] = null;
      if (r) { r.dead = true; clearTimeout(r.wd); try { r.ws.close(1000); } catch {} }
    }
  }
  armWatchdog(rec) {
    clearTimeout(rec.wd);
    rec.wd = setTimeout(() => this.onLost(rec, { code: 'lost_keepalive' }), rec.keepalive * 1000 + this.wdMargin);
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
      case 'session_welcome': {
        rec.sessionId = msg.payload.session.id;
        rec.keepalive = msg.payload.session.keepalive_timeout_seconds || 10;
        this.armWatchdog(rec);
        if (rec.migrating) {   // la nueva conexión hereda las suscripciones: se cierra la vieja sin perder el estado
          const old = this.active; this.active = rec; this.pending = null; rec.migrating = false;
          if (old) { old.dead = true; clearTimeout(old.wd); try { old.ws.close(1000); } catch {} }
          return;
        }
        this.subscribe(rec).then(() => {
          if (rec.dead) return;
          this.retryN = 0; this.setStatus('connected');
        }).catch(e => {
          if (rec.dead) return;
          if (e.code === 'AUTH') return;                 // ya notificado por invalidateTokens
          this.onLost(rec, { code: 'lost_subscribe', detail: e.message });
        });
        return;
      }
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
          text: (e.message && e.message.text) || '', receivedAt: Date.now() });
        return;
      }
      case 'revocation': {
        const st = msg.payload.subscription && msg.payload.subscription.status;
        this.wanted = false; this.shutdownSockets();
        this.setStatus('disconnected', { code: 'revoked', detail: st });
        return;
      }
      default: return;
    }
  }
  async subscribe(rec) {
    const res = await this.api('POST', `${HELIX}/eventsub/subscriptions`, {
      type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: this.channelUser.id, user_id: this.user.id },
      transport: { method: 'websocket', session_id: rec.sessionId },
    });
    if (res.status !== 202) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status} ${j.message || ''}`.trim());
    }
  }
  onClose(rec) {
    clearTimeout(rec.wd);
    if (rec.dead) return;
    if (rec === this.pending) { this.pending = null; return; }   // falló la migración: la vieja sigue viva
    if (rec === this.active) this.onLost(rec, { code: 'lost_closed' });
  }
  onLost(rec, why) {
    if (rec.dead) return;
    rec.dead = true; clearTimeout(rec.wd); try { rec.ws.close(); } catch {}
    if (this.active === rec) this.active = null;
    if (!this.wanted) return;
    this.setStatus('reconnecting', why);
    this.scheduleRetry();
  }
  scheduleRetry() {
    clearTimeout(this.retryTimer);
    const delay = Math.min(30000, this.backoffBaseMs * 2 ** this.retryN++);
    this.retryTimer = setTimeout(async () => {
      if (!this.wanted) return;
      try { await this.ensureToken(); if (this.wanted) this.openSocket(this.eventsubUrl, false); }
      catch (e) { if (e.code !== 'AUTH' && this.wanted) this.scheduleRetry(); }
    }, delay);
    this.retryTimer.unref && this.retryTimer.unref();
  }
}

module.exports = { Twitch, AuthError, SCOPES, EVENTSUB_URL };
