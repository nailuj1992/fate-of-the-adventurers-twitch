'use strict';
/**
 * Servidor local (sin dependencias, Node >= 22). Escucha solo en 127.0.0.1.
 *   - Sirve public/index.html
 *   - /auth/*   → OAuth con Twitch (el secreto nunca llega al navegador)
 *   - /api/*    → estado en tiempo real (SSE) y órdenes del presentador
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Twitch } = require('./twitch');
const { Game } = require('./game');
const { StreamerStore } = require('./store');
const I18n = require('./i18n');

// ---- .env mínimo (sin dotenv) ----
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const PORT = Number(process.env.PORT || 3000);
// Modo remoto (p. ej. Railway): PUBLIC_URL = URL pública con HTTPS. Exige sesión del streamer para ver o manejar el panel.
// Sin PUBLIC_URL el servidor es local: escucha solo en 127.0.0.1 y no pide sesión (como siempre).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const REMOTE = !!PUBLIC_URL;
const HOST = process.env.HOST || (REMOTE ? '0.0.0.0' : '127.0.0.1');
const REDIRECT_URI = process.env.TWITCH_REDIRECT_URI || `${PUBLIC_URL || 'http://localhost:' + PORT}/auth/callback`;
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));   // en Railway: la ruta de montaje del volumen
// Cuentas de Twitch que pueden usar el panel en modo remoto (logins en minúsculas, separados por comas). Por defecto, el canal.
const ALLOWED_LOGINS = (process.env.ALLOWED_LOGINS || process.env.TWITCH_CHANNEL || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const SESSION_COOKIE = 'celestiales_sid', SESSION_MS = 12 * 3600e3;
// Idioma de la consola del servidor (inglés por defecto; LANG_UI=es para español). Las páginas web usan el idioma elegido en la interfaz (cookie).
const CONSOLE_LOCALE = I18n.isSupported(process.env.LANG_UI) ? process.env.LANG_UI : 'en';
const tc = (key, params) => I18n.tIn(CONSOLE_LOCALE, key, params);

function createApp(twitch, game, { remote = false, publicUrl = '' } = {}) {
// ---- SSE ----
const clients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify(game.publicState())}\n\n`;
  for (const res of clients) res.write(data);
}
game.on('change', broadcast);
// ---- sesiones del panel (solo modo remoto): id aleatorio en cookie HttpOnly; se guardan en memoria ----
const sessions = new Map();
const cookieOf = (req, name) => {
  for (const part of (req.headers.cookie || '').split(';')) { const [k, v] = part.trim().split('='); if (k === name && /^[0-9a-f]{64}$/.test(v || '')) return v; }
  return null;
};
const authed = req => {
  if (!remote) return true;
  const sid = cookieOf(req, SESSION_COOKIE), exp = sid && sessions.get(sid);
  if (exp && exp > Date.now()) return true;
  if (sid) sessions.delete(sid);
  return false;
};
function openSession() {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, Date.now() + SESSION_MS);
  return sid;
}
twitch.on('identity', u => { if (!u) sessions.clear(); });   // al cerrar sesión en Twitch caen todas las sesiones del panel
twitch.on('status', broadcast);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000).unref();

// ---- utilidades HTTP ----
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
// Sin sesión (modo remoto): solo un enlace para iniciar sesión con Twitch; no se sirve el panel ni ningún dato.
const loginPage = (req, res) => {
  const loc = I18n.fromCookie(req.headers.cookie), label = I18n.tIn(loc, 'twitch.connect');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="${esc(loc)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(label)}</title><body style="font:18px Georgia;background:#0a1226;color:#f6e2a6;padding:3em;text-align:center"><h1>${esc(label)}</h1><p><a style="color:#3fbf9a" href="/auth/login">${esc(label)}</a></p>`);
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Página de error del servidor (OAuth): en el idioma elegido en la interfaz (cookie celestiales_lang; por defecto inglés).
const page = (req, res, code, titleKey, bodyKey) => {
  const loc = I18n.fromCookie(req.headers.cookie), title = I18n.tIn(loc, titleKey), body = bodyKey ? I18n.tIn(loc, bodyKey) : '';
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  // Solo texto fijo de i18n (se escapa igualmente): el mensaje de error nunca se refleja en la página, puede venir de la URL de retorno de Twitch; va a la consola.
  res.end(`<!doctype html><html lang="${esc(loc)}"><meta charset="utf-8"><title>${esc(title)}</title><body style="font:18px Georgia;background:#0a1226;color:#f6e2a6;padding:3em"><h1>${esc(title)}</h1><p>${esc(body)}</p><p><a style="color:#3fbf9a" href="/">${esc(I18n.tIn(loc, 'srv.back'))}</a></p>`);
};
// Texto para la consola: sin saltos de línea ni caracteres de control (evita inyectar líneas falsas en el registro).
const forLog = s => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
// Protección frente a DNS rebinding y peticiones de otros orígenes.
function allowed(req) {
  const host = req.headers.host || '', o = req.headers.origin;
  if (remote) { const pub = new URL(publicUrl); return host === pub.host && (!o || o === pub.origin); }
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (!allowed(req)) { res.writeHead(403); return res.end('Forbidden'); }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      if (!authed(req)) return loginPage(req, res);
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
    // Todo lo demás del panel (estado, eventos y órdenes) exige sesión en modo remoto.
    if ((p.startsWith('/api/') || p === '/auth/logout') && !authed(req)) return json(res, 401, { ok: false, error: 'Sign in with Twitch first' });
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, game.publicState());
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      clients.add(res); req.on('close', () => clients.delete(res));
      return res.write(`data: ${JSON.stringify(game.publicState())}\n\n`);
    }

    // ---- OAuth ----
    if (req.method === 'GET' && p === '/auth/login') {
      try { res.writeHead(302, { Location: twitch.authUrl() }); return res.end(); }
      catch (e) { console.error('[twitch]', forLog(e.message)); return page(req, res, 500, 'srv.notConfigured', 'srv.checkEnv'); }
    }
    if (req.method === 'GET' && p === '/auth/callback') {
      try {
        await twitch.handleCallback(Object.fromEntries(url.searchParams));
        const headers = { Location: '/' };
        if (remote) headers['Set-Cookie'] = `${SESSION_COOKIE}=${openSession()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`;
        res.writeHead(302, headers); return res.end();
      }
      catch (e) { console.error('[twitch] callback:', forLog(e.message)); return page(req, res, 400, 'srv.connectFailed'); }
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
server.openSession = openSession;   // para las pruebas
return server;

}

if (require.main === module) {
  if (REMOTE) {
    // Un panel público sin control de acceso sería un riesgo: no se arranca sin HTTPS ni lista de cuentas permitidas.
    const problems = [];
    if (!/^https:\/\/[^/]+$/.test(PUBLIC_URL)) problems.push('PUBLIC_URL must be an https origin without a path, e.g. https://my-app.up.railway.app');
    if (!ALLOWED_LOGINS.length) problems.push('Set ALLOWED_LOGINS (or TWITCH_CHANNEL): the Twitch accounts allowed to use the panel');
    if (problems.length) { for (const m of problems) console.error('[config]', m); process.exit(1); }
  }
  const twitch = new Twitch({
    clientId: process.env.TWITCH_CLIENT_ID, clientSecret: process.env.TWITCH_CLIENT_SECRET,
    redirectUri: REDIRECT_URI, channel: process.env.TWITCH_CHANNEL,
    tokenFile: path.join(DATA, 'tokens.json'), log: m => console.log('[twitch]', m),
    allowLogin: login => !REMOTE || ALLOWED_LOGINS.includes(login),
  });
  // Configuración e historial: en el servidor (no en el navegador), sin credenciales y separados por cuenta de Twitch (data/streamers/<id>/).
  const game = new Game({ twitch, store: new StreamerStore(DATA) });
  twitch.canChangeAccount = () => game.screen === 'admin';   // con un evento en marcha no se admite iniciar sesión con otra cuenta
  createApp(twitch, game, { remote: REMOTE, publicUrl: PUBLIC_URL }).listen(PORT, HOST, () => {
    console.log('\n' + tc('srv.listening', { url: PUBLIC_URL || `http://localhost:${PORT}` }));
    if (!twitch.configured) console.log(tc('srv.missingCreds'));
    twitch.init().catch(e => console.error('[twitch] init:', e.message));
  });
}
module.exports = { createApp };
