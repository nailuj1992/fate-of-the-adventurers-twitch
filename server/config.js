'use strict';
/**
 * Configuración del servidor a partir del entorno. `readConfig` es una función pura de `env` (se prueba sin tocar process.env);
 * solo `loadDotEnv` lee el disco y solo la entrada (server.js) la llama, nunca al importar el módulo.
 */
const fs = require('node:fs');
const I18n = require('../i18n');

const DEFAULT_PORT = 3000;
const DEFAULT_MAX_STREAMERS = 20;   // cada streamer conectado mantiene una conexión con Twitch

/** .env mínimo (sin dotenv): no pisa variables que ya estén definidas en el entorno. Sin archivo, no hace nada. */
function loadDotEnv(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * Modo remoto (p. ej. Railway): PUBLIC_URL = URL pública con HTTPS; exige sesión del streamer para ver o manejar el panel.
 * Sin PUBLIC_URL el servidor es local: escucha solo en 127.0.0.1 y no pide sesión.
 */
function readConfig(env, { dataDirDefault }) {
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const remote = !!publicUrl;
  const port = Number(env.PORT || DEFAULT_PORT);
  // Cuentas de Twitch que pueden usar el panel en modo remoto (logins en minúsculas, separados por comas). Por defecto, el canal.
  // "*" = cualquier cuenta de Twitch puede iniciar sesión (cada una usa solo lo suyo).
  const allowedLogins = (env.ALLOWED_LOGINS || env.TWITCH_CHANNEL || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const allowAny = allowedLogins.includes('*');
  return {
    port, publicUrl, remote,
    host: env.HOST || (remote ? '0.0.0.0' : '127.0.0.1'),
    redirectUri: env.TWITCH_REDIRECT_URI || `${publicUrl || 'http://localhost:' + port}/auth/callback`,
    dataDir: env.DATA_DIR || dataDirDefault,                                       // en Railway: la ruta de montaje del volumen
    allowedLogins, allowAny,
    maxStreamers: Math.max(1, Number(env.MAX_STREAMERS) || DEFAULT_MAX_STREAMERS),
    // Idioma de la consola del servidor (inglés por defecto; LANG_UI=es). Las páginas web usan el idioma elegido en la interfaz (cookie).
    consoleLocale: I18n.isSupported(env.LANG_UI) ? env.LANG_UI : 'en',
    twitch: { clientId: env.TWITCH_CLIENT_ID, clientSecret: env.TWITCH_CLIENT_SECRET, channel: env.TWITCH_CHANNEL },
  };
}

/** ¿Puede esta cuenta usar el panel? En local, cualquiera; en remoto, la lista permitida (o "*"). */
const isLoginAllowed = (cfg, login) => !cfg.remote || cfg.allowAny || cfg.allowedLogins.includes(login);

/** Un panel público sin control de acceso sería un riesgo: no se arranca sin HTTPS ni lista de cuentas permitidas. */
function configProblems(cfg) {
  const problems = [];
  if (!cfg.remote) return problems;
  if (!/^https:\/\/[^/]+$/.test(cfg.publicUrl)) problems.push('PUBLIC_URL must be an https origin without a path, e.g. https://my-app.up.railway.app');
  if (!cfg.allowedLogins.length) problems.push('Set ALLOWED_LOGINS (or TWITCH_CHANNEL): the Twitch accounts allowed to use the panel, or * for any account');
  return problems;
}

module.exports = { loadDotEnv, readConfig, isLoginAllowed, configProblems };
