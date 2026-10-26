'use strict';
/**
 * Entrada del servidor (sin dependencias, Node >= 22). Por defecto local: escucha solo en 127.0.0.1. Con PUBLIC_URL, modo remoto.
 * Solo compone las piezas y arranca; la aplicación HTTP está en server/app.js y la configuración en server/config.js.
 * Importar este módulo no tiene efectos (no lee .env ni abre puertos): `createApp` se reexporta para las pruebas.
 */
const path = require('node:path');
const I18n = require('./i18n');
const { createApp } = require('./server/app');
const { loadDotEnv, readConfig, isLoginAllowed, configProblems } = require('./server/config');
const { Tenants } = require('./tenants');
const { StreamerStore } = require('./store');

function main() {
  loadDotEnv(path.join(__dirname, '.env'));
  const cfg = readConfig(process.env, { dataDirDefault: path.join(__dirname, 'data') });
  const tc = (key, params) => I18n.tIn(cfg.consoleLocale, key, params);

  const problems = configProblems(cfg);
  if (problems.length) {
    for (const m of problems) { console.error('[config]', m); }
    process.exit(1);
  }

  const tenants = new Tenants({
    store: new StreamerStore(path.resolve(cfg.dataDir)), local: !cfg.remote, max: cfg.maxStreamers,
    twitchOptions: { ...cfg.twitch, redirectUri: cfg.redirectUri, log: m => console.log('[twitch]', m) },
    allowLogin: login => isLoginAllowed(cfg, login),
  });
  createApp(tenants, { remote: cfg.remote, publicUrl: cfg.publicUrl }).listen(cfg.port, cfg.host, () => {
    console.log('\n' + tc('srv.listening', { url: cfg.publicUrl || `http://localhost:${cfg.port}` }));
    if (!tenants.auth.configured) console.log(tc('srv.missingCreds'));
    if (!cfg.remote) tenants.loadSaved();   // en remoto cada streamer se conecta al iniciar sesión
  });
}

if (require.main === module) main();
module.exports = { createApp };
