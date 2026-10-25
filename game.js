'use strict';
/**
 * Envoltorio de Twitch sobre el motor compartido (core.js). El servidor es la fuente de verdad:
 * la lista, la extracción aleatoria, los temporizadores (incluido el plazo de confirmación), los ganadores y el historial
 * viven aquí. El navegador solo muestra el estado y envía órdenes.
 */
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('./core');
const I18n = require('./i18n');

const LOGIN_RE = /^[A-Za-z0-9_]{1,25}$/;
const ok = () => ({ ok: true });
// Errores como código + parámetros: la interfaz los traduce (err.<código>); `error` lleva el texto en inglés.
const err = (code, params = {}, extra = {}) => ({ ok: false, errorKey: 'err.' + code, errorParams: params, error: I18n.tIn('en', 'err.' + code, params), ...extra });

class Game extends EventEmitter {
  /**
   * config: configuración guardada (en segundos, ver Core.DEFAULT_CONFIG).
   * unsafeConfig / pick: solo para pruebas (duraciones fraccionarias, extracción determinista).
   */
  constructor({ twitch, config = {}, historyFile = null, pick, unsafeConfig = false }) {
    super();
    this.twitch = twitch; this.historyFile = historyFile; this.unsafe = unsafeConfig;
    this.config = Core.validateConfig(config, undefined, unsafeConfig).config;
    this.engine = new Core.Engine({
      pick, connection: () => twitch.status,
      onChange: () => this.emit('change'),
      onLog: (e, eventId) => this.persistLog(e, eventId),
    });
    this.starting = false;
    twitch.on('status', s => this.engine.onConnection(s.status));
    twitch.on('message', m => this.engine.handleChat(m));
  }

  persistLog(e, eventId) {
    if (!this.historyFile) return;
    try {
      fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
      fs.appendFileSync(this.historyFile, JSON.stringify({ event: eventId, ...e }) + '\n');
    } catch (error) { console.error('historial:', error.message); }
  }

  /* ---------- accesores de solo lectura (pruebas y depuración) ---------- */
  get screen() { return this.engine.screen; } get status() { return this.engine.status; } get round() { return this.engine.round; }
  get cur() { return this.engine.cur; } get winners() { return this.engine.winners; } get absent() { return this.engine.absent; }
  get disqualified() { return this.engine.disqualified; } get deserted() { return this.engine.deserted; }
  get history() { return this.engine.history; } get final() { return this.engine.final; } get outcome() { return this.engine.outcome; }
  get prizes() { return this.engine.prizes; }
  eligible(round) { return this.engine.eligible(round); }
  pendingPrizes() { return this.engine.pendingPrizes(); }

  publicState() {
    return { ...this.engine.view(), twitch: this.twitch.snapshot(), config: this.config, defaults: Core.DEFAULT_CONFIG, limits: Core.LIMITS };
  }

  /* ---------- configuración (solo editable antes de iniciar el evento) ---------- */
  saveConfig(raw) {
    if (this.engine.screen !== 'admin') return err('config_locked');
    const v = Core.validateConfig(raw, undefined, this.unsafe);
    if (!v.ok) return err('config_invalid', {}, { errors: v.errors });
    this.config = v.config; this.emit('config', this.config); this.emit('change'); return ok();
  }

  /* ---------- órdenes del presentador ---------- */
  async start(rawNames, rawConfig) {
    if (this.engine.screen !== 'admin' || this.starting) return err('already_running');
    this.starting = true;
    try {
      const seen = new Map(), bad = [], dup = [];
      for (const raw of Array.isArray(rawNames) ? rawNames : []) {
        const n = String(raw).replace(/\s+/g, ' ').trim().replace(/^@/, '');
        if (!n) continue;
        if (!LOGIN_RE.test(n)) { bad.push(n); continue; }
        const k = n.toLowerCase();
        if (seen.has(k)) dup.push(n); else seen.set(k, n);
      }
      if (bad.length) return err('invalid_logins', { list: bad.join(', ') });
      if (dup.length) return err('duplicate_names', { list: dup.join(', ') });
      // La configuración se valida contra el número real de participantes (los premios no pueden superarlo).
      const v = Core.validateConfig(rawConfig === undefined ? this.config : rawConfig, seen.size, this.unsafe);
      if (!v.ok) return err('config_invalid', {}, { errors: v.errors });
      if (this.twitch.status !== 'connected') return err('twitch_not_connected');

      let ids;
      try { ids = await this.twitch.resolveLogins([...seen.keys()]); }
      catch (e) { return err('twitch_lookup_failed', { detail: e.message }); }
      const unknown = [...seen.entries()].filter(([k]) => !ids.has(k)).map(([, n]) => n);
      if (unknown.length) return err('unknown_users', { list: unknown.join(', ') });
      const byId = new Set(); for (const u of ids.values()) { if (byId.has(u.id)) return err('same_account'); byId.add(u.id); }
      if (this.engine.screen !== 'admin') return err('already_running');

      this.config = v.config; this.emit('config', this.config);          // lo que se usa es lo que queda guardado
      const participants = [...seen.keys()].map(k => ({ name: ids.get(k).displayName, key: k, userId: ids.get(k).id }));
      return this.engine.start(participants, v.config);
    } finally { this.starting = false; }
  }

  confirmManual() { return this.engine.confirmManual(); }
  disqualify(reason) { return this.engine.disqualify(reason); }
  pauseToggle() { return this.engine.pauseToggle(); }
  skip() { return this.engine.skip(); }
  cancel() { return this.engine.cancel(); }
  reset() { return this.engine.reset(); }
  back() { return this.engine.back(); }
  handleChat(m) { return this.engine.handleChat(m); }
}

module.exports = { Game, ok, err };
