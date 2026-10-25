'use strict';
/**
 * Datos por streamer: cada cuenta de Twitch (identificada por su ID numérico, que no cambia aunque cambie el nombre)
 * tiene su propia carpeta  data/streamers/<id>/  con su configuración y su historial. Así dos cuentas nunca comparten
 * ni pisan parámetros. Sin credenciales: los tokens siguen en data/tokens.json (una sola sesión a la vez).
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^\d{1,20}$/;   // ID de usuario de Twitch; validado para que nunca pueda salirse de la carpeta de datos

class StreamerStore {
  constructor(dataDir) { this.root = dataDir; }

  dir(id) {
    if (!ID_RE.test(String(id))) throw new Error('Invalid Twitch user id');
    return path.join(this.root, 'streamers', String(id));
  }
  configFile(id) { return path.join(this.dir(id), 'config.json'); }
  tokenFile(id) { return path.join(this.dir(id), 'tokens.json'); }   // tokens de Twitch de ESA cuenta (0600)
  historyFile(id) { return path.join(this.dir(id), 'historial.jsonl'); }

  /** Configuración guardada del streamer ({} si no tiene o está dañada: se usarán los valores por defecto). */
  loadConfig(id) {
    this.migrateLegacy(id);
    try { return JSON.parse(fs.readFileSync(this.configFile(id), 'utf8')); } catch { return {}; }
  }
  saveConfig(id, cfg) {
    fs.mkdirSync(this.dir(id), { recursive: true });
    fs.writeFileSync(this.configFile(id), JSON.stringify(cfg, null, 2));
  }

  /**
   * Versiones anteriores guardaban una sola config.json / historial.jsonl para todos. El primer streamer que inicie sesión
   * (y solo si todavía no existe ninguna carpeta por streamer) las hereda; los originales se renombran a *.migrated.
   */
  migrateLegacy(id) {
    const legacy = ['config.json', 'historial.jsonl'].map(f => path.join(this.root, f)).filter(f => fs.existsSync(f));
    if (!legacy.length || fs.existsSync(path.join(this.root, 'streamers'))) return;
    fs.mkdirSync(this.dir(id), { recursive: true });
    for (const f of legacy) {
      fs.copyFileSync(f, path.join(this.dir(id), path.basename(f)));
      fs.renameSync(f, f + '.migrated');
    }
  }
}

module.exports = { StreamerStore, ID_RE };
