'use strict';
/**
 * Un "tenant" por streamer: su propia conexión a Twitch (tokens y EventSub), su propio motor de sorteo y su propia configuración
 * e historial. Así varios streamers pueden iniciar sesión y usar el panel a la vez sin compartir estado.
 *
 *   - Los tenants se crean al iniciar sesión (clave: ID numérico de Twitch) y viven en memoria; sus tokens están en
 *     data/streamers/<id>/tokens.json.
 *   - El tenant "invitado" (sin cuenta) solo sirve para mostrar el botón de conectar en modo local.
 *   - Modo local (local=true): una sola persona usa el panel; `current` es el tenant que ve (el último que inició sesión).
 *   - Modo remoto: la sesión del panel (cookie) lleva el ID del streamer y el servidor resuelve su tenant con `get(id)`.
 */
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { Twitch, AuthError } = require('./twitch');
const { Game } = require('./game');
const { ID_RE } = require('./store');

class Tenants extends EventEmitter {
  /**
   * allowLogin(login) → boolean; max = tope de streamers en memoria (cada uno abre una conexión a Twitch).
   * TwitchClass: solo para pruebas.
   */
  constructor({ store, twitchOptions = {}, allowLogin = () => true, max = 20, local = false, TwitchClass = Twitch }) {
    super();
    this.store = store; this.twitchOptions = twitchOptions; this.allowLogin = allowLogin; this.max = max; this.local = local;
    this.TwitchClass = TwitchClass;
    this.map = new Map();
    this.auth = new TwitchClass({ ...twitchOptions, tokenFile: undefined });   // solo para el OAuth (authUrl + exchange), nunca se conecta
    this.guest = this.build(null);
    this.current = this.guest;
  }

  /** TWITCH_CHANNEL solo tiene sentido con una persona (modo local); en modo remoto cada streamer lee su propio chat. */
  build(id) {
    const twitch = new this.TwitchClass({
      ...this.twitchOptions, channel: this.local ? this.twitchOptions.channel : '',
      tokenFile: id ? this.store.tokenFile(id) : undefined,
    });
    const tenant = { id, twitch, game: new Game({ twitch, store: this.store }) };
    if (id) this.map.set(id, tenant);
    this.emit('created', tenant);
    return tenant;
  }
  get(id) { return this.map.get(String(id)) || null; }
  all() { return [this.guest, ...this.map.values()]; }
  setCurrent(t) { if (this.current !== t) { this.current = t; this.emit('current', t); } }

  authUrl() { return this.auth.authUrl(); }

  /** Callback de Twitch: valida, comprueba que la cuenta esté permitida y deja conectado el tenant de ese streamer. */
  async login(query) {
    const { tokens, who } = await this.auth.exchange(query);
    if (!this.allowLogin(String(who.login || '').toLowerCase())) throw new AuthError('This Twitch account is not allowed to use the panel');
    const id = String(who.user_id);
    if (!ID_RE.test(id)) throw new Error('Unexpected Twitch user id');
    let t = this.map.get(id);
    if (!t) {
      if (this.map.size >= this.max) throw new Error('Too many streamers connected');
      t = this.build(id);
    }
    await t.twitch.adopt(tokens);
    if (this.local) this.setCurrent(t);
    return t;
  }

  /** Cierra la sesión de Twitch del tenant. Si no tiene un evento en marcha, se libera su conexión y su memoria. */
  logout(t) {
    if (!t || t === this.guest) return;
    t.twitch.logout();
    if (t.game.screen !== 'admin') return;       // con un evento en marcha se conserva hasta que termine
    this.map.delete(t.id);
    if (this.current === t) this.setCurrent(this.guest);
    this.emit('released', t);
  }

  /** Modo local: reconecta a los streamers que ya habían iniciado sesión; ve el más reciente. */
  loadSaved() {
    const dir = path.join(this.store.root, 'streamers');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    let best = null;
    for (const name of names) {
      if (!ID_RE.test(name) || this.map.size >= this.max) continue;
      let st; try { st = fs.statSync(this.store.tokenFile(name)); } catch { continue; }
      const t = this.build(name);
      t.twitch.init().catch(e => console.error('[twitch] init:', String(e.message).replace(/[\u0000-\u001f\u007f]+/g, ' ')));
      if (!best || st.mtimeMs > best.mtime) best = { t, mtime: st.mtimeMs };
    }
    if (best && this.local) this.setCurrent(best.t);
  }
}

module.exports = { Tenants };
