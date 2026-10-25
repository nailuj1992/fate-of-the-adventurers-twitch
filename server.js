'use strict';
/**
 * Servidor local (sin dependencias, Node >= 22). Escucha solo en 127.0.0.1.
 *   - Sirve public/index.html
 *   - /auth/*   → OAuth con Twitch (el secreto nunca llega al navegador)
 *   - /api/*    → estado en tiempo real (SSE) y órdenes del presentador
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Twitch } = require('./twitch');
const { Game } = require('./game');
const I18n = require('./i18n');

// ---- .env mínimo (sin dotenv) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
const REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const DATA = path.join(__dirname, 'data');
// Idioma de la consola del servidor (inglés por defecto; LANG_UI=es para español). Las páginas web usan el idioma elegido en la interfaz (cookie).
const CONSOLE_LOCALE = I18n.isSupported(process.env.LANG_UI) ? process.env.LANG_UI : 'en';
const tc = (key, params) => I18n.tIn(CONSOLE_LOCALE, key, params);

function createApp(twitch, game) {
// ---- SSE ----
const clients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify(game.publicState())}\n\n`;
  for (const res of clients) res.write(data);
}
game.on('change', broadcast);
twitch.on('status', broadcast);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();

// ---- utilidades HTTP ----
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
// Página de error del servidor (OAuth): en el idioma elegido en la interfaz (cookie celestiales_lang; por defecto inglés).
const page = (req, res, code, titleKey, body) => {
  const loc = I18n.fromCookie(req.headers.cookie), title = I18n.tIn(loc, titleKey);
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="${loc}"><meta charset="utf-8"><title>${title}</title><body style="font:18px Georgia;background:#0a1226;color:#f6e2a6;padding:3em"><h1>${title}</h1><p>${body}</p><p><a style="color:#3fbf9a" href="/">${I18n.tIn(loc, 'srv.back')}</a></p>`);
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Protección frente a DNS rebinding y peticiones de otros orígenes.
function allowed(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  const o = req.headers.origin;
  return !o || o === `http://${host}`;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > 65536) { reject(new Error('Cuerpo demasiado grande')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

const ROUTES = {
  confirm: () => game.confirmManual(), pause: () => game.pauseToggle(), skip: () => game.skip(),
  disqualify: b => game.disqualify(b.reason), cancel: () => game.cancel(),
  reset: () => game.reset(), back: () => game.back(),
  start: b => game.start(b.names, b.config),          // el servidor valida la configuración (premios ≤ participantes) y la guarda
  config: b => game.saveConfig(b.config),             // solo antes de iniciar; se persiste en data/config.json
};

return http.createServer(async (req, res) => {
  try {
    if (!allowed(req)) { res.writeHead(403); return res.end('Forbidden'); }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    // Módulos compartidos con la página (reglas/configuración e i18n con sus catálogos). Lista cerrada: nada más se sirve desde aquí.
    const SHARED = { '/core.js': 'core.js', '/i18n.js': 'i18n.js', '/locales/en.js': 'locales/en.js', '/locales/es.js': 'locales/es.js' };
    if (req.method === 'GET' && SHARED[p]) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, SHARED[p])));
    }
    // Imágenes: solo public/img/<nombre>.(png|webp|jpg|jpeg), sin subcarpetas ni rutas relativas.
    const img = p.match(/^\/img\/([\w-]+\.(png|webp|jpe?g))$/i);
    if (req.method === 'GET' && img) {
      const type = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[img[2].toLowerCase()];
      try { const data = fs.readFileSync(path.join(__dirname, 'public', 'img', img[1])); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=3600' }); return res.end(data); }
      catch { res.writeHead(404); return res.end('Not found'); }
    }
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, game.publicState());
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      clients.add(res); req.on('close', () => clients.delete(res));
      return res.write(`data: ${JSON.stringify(game.publicState())}\n\n`);
    }

    // ---- OAuth ----
    if (req.method === 'GET' && p === '/auth/login') {
      try { res.writeHead(302, { Location: twitch.authUrl() }); return res.end(); }
      catch (e) { return page(req, res, 500, 'srv.notConfigured', esc(e.message) + '. ' + I18n.tIn(I18n.fromCookie(req.headers.cookie), 'srv.checkEnv')); }
    }
    if (req.method === 'GET' && p === '/auth/callback') {
      try { await twitch.handleCallback(Object.fromEntries(url.searchParams)); res.writeHead(302, { Location: '/' }); return res.end(); }
      catch (e) { return page(req, res, 400, 'srv.connectFailed', esc(e.message)); }
    }
    if (req.method === 'POST' && p === '/auth/logout') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'Content-Type debe ser application/json' });
      twitch.logout(); return json(res, 200, { ok: true });
    }

    // ---- órdenes ----
    if (req.method === 'POST' && p.startsWith('/api/')) {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { ok: false, error: 'Content-Type debe ser application/json' });
      const fn = ROUTES[p.slice(5)];
      if (!fn) return json(res, 404, { ok: false, error: 'Orden desconocida' });
      return json(res, 200, await fn(await readBody(req)));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { json(res, 500, { ok: false, error: e.message }); }
});

}

if (require.main === module) {
  const twitch = new Twitch({
    clientId: process.env.TWITCH_CLIENT_ID, clientSecret: process.env.TWITCH_CLIENT_SECRET,
    redirectUri: REDIRECT_URI, channel: process.env.TWITCH_CHANNEL,
    tokenFile: path.join(DATA, 'tokens.json'), log: m => console.log('[twitch]', m),
  });
  // Configuración del sorteo: se guarda en el servidor (no en el navegador) y no contiene credenciales.
  const CONFIG_FILE = path.join(DATA, 'config.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  const game = new Game({ twitch, config: saved, historyFile: path.join(DATA, 'historial.jsonl') });
  game.on('config', cfg => {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
    catch (e) { console.error('config:', e.message); }
  });
  createApp(twitch, game).listen(PORT, '127.0.0.1', () => {
    console.log('\n' + tc('srv.listening', { url: `http://localhost:${PORT}` }));
    if (!twitch.configured) console.log(tc('srv.missingCreds'));
    twitch.init().catch(e => console.error('[twitch] init:', e.message));
  });
}
module.exports = { createApp };
