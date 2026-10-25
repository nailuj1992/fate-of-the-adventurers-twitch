'use strict';
/**
 * Cliente autenticado de Twitch: tokens en disco, OAuth (authorization code, el secreto solo vive en el servidor),
 * renovación, validación y llamadas a Helix. No conoce EventSub ni la sesión del streamer.
 *
 * Eventos:
 *   'invalidated' (reason)  → el refresh token ya no sirve: se borraron los tokens y quien use este cliente debe cerrar su sesión.
 */
const EventEmitter = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OAUTH = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const SCOPES = ['user:read:chat'];           // único permiso solicitado
const TOKEN_REFRESH_MARGIN_MS = 120000;      // se renueva con 2 min de antelación
const OAUTH_STATE_TTL_MS = 10 * 60000;       // vigencia del parámetro state de una autorización en curso
const HELIX_USERS_PAGE = 100;                // máximo de logins por consulta a /users

class AuthError extends Error { constructor(m){ super(m); this.code = 'AUTH'; } }

class TwitchAuth extends EventEmitter {
  constructor(o) {
    super();
    this.clientId = o.clientId || '';
    this.clientSecret = o.clientSecret || '';
    this.redirectUri = o.redirectUri;
    this.tokenFile = o.tokenFile;
    this.fetch = o.fetchImpl || fetch;
    this.tokens = null;          // {accessToken, refreshToken, expiresAt}
    this.refreshing = null;
    this.oauthStates = new Map();
  }

  get configured() { return !!(this.clientId && this.clientSecret); }

  /* ---------- tokens ---------- */
  loadTokens() {
    try { this.tokens = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')); } catch { this.tokens = null; }
  }
  saveTokens() {
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify(this.tokens), { mode: 0o600 });
  }
  /** Olvida los tokens (memoria y disco). */
  clearTokens() {
    this.tokens = null;
    try { fs.unlinkSync(this.tokenFile); } catch {}
  }
  static toTokens(j) {
    return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 0) * 1000 };
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
          this.clearTokens();
          this.emit('invalidated', 'auth_expired');
          throw new AuthError(j.message || 'invalid refresh token');
        }
        throw new Error(`Token refresh: HTTP ${res.status}`);
      }
      this.tokens = TwitchAuth.toTokens(j);   // el refresh token puede rotar: se guarda siempre el nuevo
      this.saveTokens();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async ensureToken() {
    if (!this.tokens) throw new AuthError('Not authenticated');
    if (Date.now() >= this.tokens.expiresAt - TOKEN_REFRESH_MARGIN_MS) await this.refresh();
  }
  /** Llamada a Helix con el token del usuario; ante un 401 renueva una vez y reintenta. */
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

  /* ---------- OAuth ---------- */
  authUrl() {
    if (!this.configured) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are missing');
    const state = crypto.randomBytes(16).toString('hex');
    this.oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    const u = new URL(`${OAUTH}/authorize`);
    u.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri, response_type: 'code',
      scope: SCOPES.join(' '), state }).toString();
    return u.toString();
  }
  /**
   * Primera mitad del callback, sin efectos sobre ninguna sesión: valida el state, canjea el código e identifica la cuenta.
   * Devuelve { tokens, who } (who = respuesta de /oauth2/validate: user_id, login…).
   */
  async exchange(query) {
    if (query.error) throw new Error(`Twitch denied access: ${query.error_description || query.error}`);
    const exp = this.oauthStates.get(query.state);
    this.oauthStates.delete(query.state);
    if (!exp || exp < Date.now()) throw new Error('Invalid or expired state parameter (possible CSRF)');
    const { res, j } = await this.tokenRequest({ grant_type: 'authorization_code', code: query.code, redirect_uri: this.redirectUri });
    if (!res.ok) throw new Error(`Code exchange: ${j.message || 'HTTP ' + res.status}`);
    const tokens = TwitchAuth.toTokens(j);
    return { tokens, who: await this.identify(tokens.accessToken) };
  }
  /** Quién es el dueño de un token (endpoint validate), sin efectos secundarios. */
  async identify(accessToken) {
    const res = await this.fetch(`${OAUTH}/validate`, { headers: { Authorization: `OAuth ${accessToken}` } });
    if (!res.ok) throw new Error(`Token validation: HTTP ${res.status}`);
    return res.json();
  }
  /** Valida los tokens actuales (Twitch lo exige cada hora); ante un 401 renueva una vez. */
  async validate(retried = false) {
    if (!this.tokens) throw new AuthError('Not authenticated');
    const res = await this.fetch(`${OAUTH}/validate`, { headers: { Authorization: `OAuth ${this.tokens.accessToken}` } });
    if (res.status === 401 && !retried) { await this.refresh(); return this.validate(true); }
    if (!res.ok) throw new Error(`Token validation: HTTP ${res.status}`);
    return res.json();
  }

  /* ---------- Helix ---------- */
  /** logins → Map(login en minúsculas → {id, login, displayName}). Los inexistentes no aparecen. */
  async resolveLogins(logins) {
    const pages = [];                                       // Helix admite hasta 100 logins por consulta: las páginas van en paralelo
    for (let i = 0; i < logins.length; i += HELIX_USERS_PAGE) pages.push(logins.slice(i, i + HELIX_USERS_PAGE));
    const results = await Promise.all(pages.map(page => this.fetchUsers(page)));
    const out = new Map();
    for (const users of results) {
      for (const u of users) out.set(u.login.toLowerCase(), { id: u.id, login: u.login, displayName: u.display_name });
    }
    return out;
  }
  /** Una consulta a /users (≤ 100 logins): devuelve la lista de usuarios existentes. */
  async fetchUsers(page) {
    const q = new URLSearchParams();
    page.forEach(l => q.append('login', l));
    const res = await this.api('GET', `${HELIX}/users?${q}`);
    if (!res.ok) throw new Error(`Helix /users: HTTP ${res.status}`);
    return (await res.json()).data || [];
  }
  /** Suscripción al chat del canal para una sesión EventSub. Lanza si Twitch no responde 202. */
  async subscribeChat(broadcasterId, userId, sessionId) {
    const res = await this.api('POST', `${HELIX}/eventsub/subscriptions`, {
      type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: broadcasterId, user_id: userId },
      transport: { method: 'websocket', session_id: sessionId },
    });
    if (res.status !== 202) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status} ${j.message || ''}`.trim());
    }
  }
}

module.exports = { TwitchAuth, AuthError, SCOPES };
