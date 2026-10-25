'use strict';
/**
 * Aplicación HTTP (sin dependencias): enrutado, protección de origen, OAuth, órdenes del presentador y SSE.
 * Cada petición se atiende SIEMPRE con el tenant de su sesión (ver tenants.js); en local, con el que está en pantalla.
 *   - /auth/*   → OAuth con Twitch (el secreto nunca llega al navegador)
 *   - /api/*    → estado en tiempo real (SSE) y órdenes del presentador
 */
const http = require('node:http');
const Core = require('../core');
const { createSessions } = require('./sessions');
const { createSseHub } = require('./sse');
const pages = require('./pages');

const SESSION_COOKIE = 'celestiales_sid';
const SESSION_MS = 12 * 3600e3;
const MAX_BODY_BYTES = 65536;
const JSON_TYPE = /^application\/json/;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

// Error de la API con código HTTP; viaja como los del motor: {ok:false, errorKey:'err.<code>', errorParams, error en inglés}.
class HttpError extends Error { constructor(status, code, params) { super(code); this.status = status; this.code = code; this.params = params; } }

// Texto para la consola: sin saltos de línea ni caracteres de control (evita inyectar líneas falsas en el registro).
const forLog = s => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const fail = (res, status, code, params) => json(res, status, Core.err(code, params));

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0, tooBig = false; const parts = [];
    req.on('data', c => {
      if (tooBig) return;                                    // se sigue leyendo (y descartando) para poder responder 413; la conexión se cierra después
      n += c.length;
      if (n > MAX_BODY_BYTES) { tooBig = true; parts.length = 0; reject(new HttpError(413, 'body_too_large')); } else parts.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'invalid_json')); }
    });
    req.on('error', reject);
  });
}

// Órdenes del presentador: nombre de la ruta /api/<nombre> → acción sobre el juego del streamer.
const ROUTES = {
  confirm: g => g.confirmManual(), pause: g => g.pauseToggle(), skip: g => g.skip(),
  disqualify: (g, b) => g.disqualify(b.reason), cancel: g => g.cancel(),
  reset: g => g.reset(), back: g => g.back(),
  start: (g, b) => g.start(b.names, b.config),        // el servidor valida la configuración (premios ≤ participantes) y la guarda
  config: (g, b) => g.saveConfig(b.config),           // solo antes de iniciar; se persiste en data/streamers/<id>/config.json
};

/**
 * tenants: instancia de Tenants. remote/publicUrl: modo remoto (sesión obligatoria; Host y Origin deben ser los de publicUrl).
 * Devuelve el http.Server (sin escuchar); `server.openSession(id)` existe para las pruebas.
 */
function createApp(tenants, { remote = false, publicUrl = '' } = {}) {
  const sessions = createSessions({ cookieName: SESSION_COOKIE, ttlMs: SESSION_MS });
  const hub = createSseHub(tenants, { remote });

  // Tenant (streamer) al que pertenece la petición: en remoto, el de su sesión; en local, el que está en pantalla.
  function tenantOf(req) {
    if (!remote) return tenants.current;
    const id = sessions.lookup(req);
    return id === null ? null : tenants.get(id);
  }

  // Protección frente a DNS rebinding y peticiones de otros orígenes.
  function allowed(req) {
    const host = req.headers.host || '', o = req.headers.origin;
    if (remote) { const pub = new URL(publicUrl); return host === pub.host && (!o || o === pub.origin); }
    if (!LOCAL_HOST_RE.test(host)) return false;
    return !o || o === `http://${host}`;
  }

  // Cada tenant empuja su estado a sus clientes SSE; al cerrar sesión en Twitch caen las sesiones de ese streamer y, al liberarlo, se desengancha.
  const detach = new Map();
  function wire(t) {
    const stopPush = hub.attach(t);
    const onIdentity = u => { if (!u && t.id) sessions.dropAll(t.id); };
    t.twitch.on('identity', onIdentity);
    detach.set(t, () => { stopPush(); t.twitch.off('identity', onIdentity); });
  }
  tenants.all().forEach(wire); tenants.on('created', wire);
  tenants.on('released', t => { const off = detach.get(t); if (off) { off(); detach.delete(t); } });
  tenants.on('current', () => hub.sendAll());

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (!allowed(req)) { res.writeHead(403); return res.end('Forbidden'); }
    const tenant = tenantOf(req);

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return tenant ? pages.panel(res) : pages.loginPage(req, res);
    if (req.method === 'GET' && pages.serveStatic(p, res)) return;
    // Todo lo demás del panel (estado, eventos y órdenes) exige sesión en modo remoto.
    if ((p.startsWith('/api/') || p === '/auth/logout') && !tenant) throw new HttpError(401, 'sign_in_required');
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, tenant.game.publicState());
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      return hub.add(res, tenant.id);
    }

    // ---- OAuth ----
    if (req.method === 'GET' && p === '/auth/login') {
      try { res.writeHead(302, { Location: tenants.authUrl() }); return res.end(); }
      catch (e) { console.error('[twitch]', forLog(e.message)); return pages.errorPage(req, res, 500, 'srv.notConfigured', 'srv.checkEnv'); }
    }
    if (req.method === 'GET' && p === '/auth/callback') {
      try {
        const t = await tenants.login(Object.fromEntries(url.searchParams));
        const headers = { Location: '/' };
        if (remote) headers['Set-Cookie'] = `${SESSION_COOKIE}=${sessions.open(t.id)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`;
        res.writeHead(302, headers); return res.end();
      }
      catch (e) { console.error('[twitch] callback:', forLog(e.message)); return pages.errorPage(req, res, 400, 'srv.connectFailed'); }
    }
    if (req.method === 'POST' && p === '/auth/logout') {
      if (!JSON_TYPE.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json_required');
      sessions.close(req);
      tenants.logout(tenant); return json(res, 200, { ok: true });
    }

    // ---- órdenes ----
    if (req.method === 'POST' && p.startsWith('/api/')) {
      if (!JSON_TYPE.test(req.headers['content-type'] || '')) throw new HttpError(415, 'json_required');
      const fn = ROUTES[p.slice(5)];
      if (!fn) throw new HttpError(404, 'unknown_command');
      return json(res, 200, await fn(tenant.game, await readBody(req)));
    }
    res.writeHead(404); res.end('Not found');
  }

  const server = http.createServer(async (req, res) => {
    try { await handle(req, res); }
    catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) {
        if (e.status === 413) { res.setHeader('Connection', 'close'); res.once('finish', () => req.destroy()); }
        return fail(res, e.status, e.code, e.params);
      }
      console.error('[server]', forLog(e.message));        // el detalle va a la consola; al cliente solo un error genérico
      fail(res, 500, 'generic');
    }
  });
  server.on('close', () => hub.close());
  server.openSession = sessions.open;   // para las pruebas (id del streamer → cookie de sesión)
  return server;
}

module.exports = { createApp, MAX_BODY_BYTES };
