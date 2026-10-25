'use strict';
/**
 * Datos por streamer: cada cuenta de Twitch (identificada por su ID numérico, que no cambia aunque cambie el nombre)
 * tiene su propia carpeta  data/streamers/<id>/  con su configuración y su historial. Así dos cuentas nunca comparten
 * ni pisan parámetros. Los tokens de Twitch de cada cuenta viven en su misma carpeta (tokens.json, modo 0600); este módulo
 * solo da su ruta y su fecha: leerlos y escribirlos es cosa de twitch/auth.js.
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

  /** IDs de los streamers que tienen carpeta (nombres que no son un ID de Twitch se ignoran). */
  savedStreamerIds() {
    try { return fs.readdirSync(path.join(this.root, 'streamers')).filter(name => ID_RE.test(name)); } catch { return []; }
  }
  /** Hora de modificación (ms) de los tokens guardados del streamer, o null si no tiene. */
  tokenMtime(id) {
    try { return fs.statSync(this.tokenFile(id)).mtimeMs; } catch { return null; }
  }
  /** Añade una línea (JSON) al historial del streamer. Lanza si no puede escribir: quien llama decide qué hacer. */
  appendHistory(id, record) {
    fs.mkdirSync(this.dir(id), { recursive: true });
    fs.appendFileSync(this.historyFile(id), JSON.stringify(record) + '\n');
  }

  /** Configuración guardada del streamer ({} si no tiene o está dañada: se usarán los valores por defecto). */
  loadConfig(id) {
    try { return JSON.parse(fs.readFileSync(this.configFile(id), 'utf8')); } catch { return {}; }
  }
  saveConfig(id, cfg) {
    fs.mkdirSync(this.dir(id), { recursive: true });
    fs.writeFileSync(this.configFile(id), JSON.stringify(cfg, null, 2));
  }

  /**
   * Versiones anteriores guardaban una sola config.json / historial.jsonl para todos. El primer streamer que inicie sesión
   * (y solo si todavía no existe ninguna carpeta por streamer) las hereda; los originales se renombran a *.migrated.
   * Es un paso EXPLÍCITO: lo llama Game.setOwner justo antes de cargar la configuración (loadConfig ya no lo hace a escondidas).
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
