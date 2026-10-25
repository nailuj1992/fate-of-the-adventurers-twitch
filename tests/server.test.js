'use strict';
// Modo remoto (Railway): sin sesión no se sirve el panel ni datos; Host/Origin deben ser los de PUBLIC_URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const EventEmitter = require('node:events');
const { createApp } = require('../server');
const { Game } = require('../game');

const PUBLIC = 'https://app.example.test';
class FakeTwitch extends EventEmitter {
  constructor() { super(); this.status = 'disconnected'; this.user = null; }
  snapshot() { return { configured: true, authenticated: false, status: this.status, reason: null, user: null, channel: null }; }
  authUrl() { return 'https://id.twitch.tv/oauth2/authorize?x=1'; }
  async handleCallback() {}
}
async function boot(remote) {
  const tw = new FakeTwitch(), game = new Game({ twitch: tw });
  const server = createApp(tw, game, { remote, publicUrl: remote ? PUBLIC : '' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path, method, headers: { Host: remote ? 'app.example.test' : `localhost:${port}`, ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject); req.end(body);
  });
  return { server, call, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}
const JSON_H = { 'Content-Type': 'application/json' };

test('remoto sin sesión: solo la página de acceso; /api/* responde 401', async () => {
  const { call, close } = await boot(true);
  try {
    const home = await call('/');
    assert.equal(home.status, 200); assert.match(home.body, /\/auth\/login/); assert.ok(!/celestial/i.test(home.body), 'no se sirve el panel');
    for (const p of ['/api/state', '/api/events']) assert.equal((await call(p)).status, 401, p);
    assert.equal((await call('/api/start', { method: 'POST', headers: JSON_H, body: '{}' })).status, 401);
    assert.equal((await call('/auth/logout', { method: 'POST', headers: JSON_H, body: '{}' })).status, 401);
  } finally { await close(); }
});

test('remoto con sesión válida: se sirve el estado; una cookie inventada no vale', async () => {
  const { server, call, close } = await boot(true);
  try {
    const sid = server.openSession();
    assert.equal((await call('/api/state', { headers: { Cookie: `celestiales_sid=${sid}` } })).status, 200);
    assert.equal((await call('/api/state', { headers: { Cookie: 'celestiales_sid=' + 'a'.repeat(64) } })).status, 401);
    assert.equal((await call('/api/state', { headers: { Cookie: 'celestiales_sid=../../etc' } })).status, 401);
  } finally { await close(); }
});

test('remoto: Host y Origin deben coincidir con PUBLIC_URL; /healthz responde siempre y sin datos', async () => {
  const { call, close } = await boot(true);
  try {
    assert.equal((await call('/', { headers: { Host: 'evil.test' } })).status, 403);
    assert.equal((await call('/', { headers: { Origin: 'https://evil.test' } })).status, 403);
    const hz = await call('/healthz', { headers: { Host: 'healthcheck.railway.app' } });
    assert.equal(hz.status, 200); assert.equal(hz.body, 'ok');
  } finally { await close(); }
});

test('remoto: el callback de Twitch abre la sesión con cookie HttpOnly, Secure y SameSite', async () => {
  const { call, close } = await boot(true);
  try {
    const r = await call('/auth/callback?code=c&state=s');
    assert.equal(r.status, 302);
    const c = [].concat(r.headers['set-cookie'])[0];
    assert.match(c, /^celestiales_sid=[0-9a-f]{64};/); assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Lax/);
  } finally { await close(); }
});

test('local: sin cambios (no pide sesión)', async () => {
  const { call, close } = await boot(false);
  try {
    assert.equal((await call('/api/state')).status, 200);
    assert.equal((await call('/', { headers: { Host: 'evil.test' } })).status, 403);
  } finally { await close(); }
});
