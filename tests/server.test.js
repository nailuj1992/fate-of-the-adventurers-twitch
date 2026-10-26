'use strict';
// Servidor con varios streamers: cada sesión ve y maneja solo lo suyo; sin sesión no se sirve nada (modo remoto).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { createApp } = require('../server');
const { Tenants } = require('../tenants');
const { StreamerStore } = require('../store');

const PUBLIC = 'https://app.example.test';

// Twitch simulado: el "code" del callback es  <id>:<login>  y se acepta tal cual (Tenants usa auth.exchange y luego adopt).
class FakeTwitch extends EventEmitter {
  static last = null;
  constructor(o) { super(); this.o = o; this.status = 'disconnected'; this.user = null; this.configured = true; }
  snapshot() { return { configured: true, authenticated: !!this.user, status: this.status, reason: null, user: this.user && this.user.login, channel: this.user && this.user.login }; }
  authUrl() { return 'https://id.twitch.tv/oauth2/authorize?x=1'; }
  async exchange(q) {
    const [id, login] = String(q.code || '').split(':');
    if (!id) throw new Error('bad code');
    FakeTwitch.last = { user_id: id, login };
    return { tokens: { accessToken: 'AT' + id }, who: FakeTwitch.last };
  }
  async adopt() {
    this.user = { id: String(FakeTwitch.last.user_id), login: FakeTwitch.last.login }; this.emit('identity', this.user);
    this.status = 'connected'; this.emit('status', this.snapshot());
  }
  logout() { this.user = null; this.status = 'disconnected'; this.emit('identity', null); this.emit('status', this.snapshot()); }
}

async function boot({ remote = true, allow = () => true, max = 20 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const tenants = new Tenants({ store: new StreamerStore(root), local: !remote, max, allowLogin: allow, TwitchClass: FakeTwitch });
  const server = createApp(tenants, { remote, publicUrl: remote ? PUBLIC : '' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const host = remote ? 'app.example.test' : `localhost:${port}`;
    const origin = remote ? PUBLIC : `http://localhost:${port}`;
    const req = http.request({ port, host: '127.0.0.1', path: p, method, headers: { Host: host, ...(method === 'POST' ? { Origin: origin } : {}), ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject); req.end(body);
  });
  // inicia sesión como ese streamer y devuelve su cookie
  const signIn = async (id, login) => {
    const r = await call(`/auth/callback?code=${id}:${login}&state=s`);
    const c = r.headers['set-cookie'] && [].concat(r.headers['set-cookie'])[0];
    return { status: r.status, cookie: c ? c.split(';')[0] : null, raw: c };
  };
  const as = cookie => ({ Cookie: cookie });
  const state = async cookie => JSON.parse((await call('/api/state', { headers: as(cookie) })).body);
  const post = (p, cookie, obj) => call(p, { method: 'POST', headers: { ...as(cookie), 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
  return { root, tenants, server, call, signIn, state, post, as, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}
const JSON_H = { 'Content-Type': 'application/json' };

test('remoto sin sesión: solo la página de acceso; /api/* responde 401', async () => {
  const { call, close } = await boot();
  try {
    const home = await call('/');
    assert.equal(home.status, 200); assert.match(home.body, /\/auth\/login/); assert.ok(!/celestial/i.test(home.body), 'no se sirve el panel');
    for (const p of ['/api/state', '/api/events']) assert.equal((await call(p)).status, 401, p);
    assert.equal((await call('/api/start', { method: 'POST', headers: { ...JSON_H, Origin: PUBLIC }, body: '{}' })).status, 401);
    assert.equal((await call('/auth/logout', { method: 'POST', headers: { ...JSON_H, Origin: PUBLIC }, body: '{}' })).status, 401);
  } finally { await close(); }
});

test('la cookie es de HttpOnly, Secure y SameSite; una inventada o manipulada no vale', async () => {
  const { signIn, call, as, close } = await boot();
  try {
    const a = await signIn('111', 'ana');
    assert.equal(a.status, 302);
    assert.match(a.raw, /^celestiales_sid=[0-9a-f]{64};/); assert.match(a.raw, /HttpOnly/); assert.match(a.raw, /Secure/); assert.match(a.raw, /SameSite=Lax/);
    assert.equal((await call('/api/state', { headers: as(a.cookie) })).status, 200);
    assert.equal((await call('/api/state', { headers: as('celestiales_sid=' + 'a'.repeat(64)) })).status, 401);
    assert.equal((await call('/api/state', { headers: as('celestiales_sid=../../etc') })).status, 401);
  } finally { await close(); }
});

test('dos streamers a la vez: cada sesión ve su cuenta y su configuración, sin mezclarse', async () => {
  const { signIn, state, post, root, close } = await boot();
  try {
    const a = await signIn('111', 'ana'), b = await signIn('222', 'bob');
    assert.notEqual(a.cookie, b.cookie);
    assert.equal((await state(a.cookie)).twitch.user, 'ana');
    assert.equal((await state(b.cookie)).twitch.user, 'bob');
    const before = (await state(b.cookie)).config.prizes;
    const r = await (await post('/api/config', a.cookie, { config: { prizes: 2 } })).body;
    assert.equal(JSON.parse(r).ok, true, r);
    assert.equal((await state(a.cookie)).config.prizes, 2);
    assert.equal((await state(b.cookie)).config.prizes, before, 'bob no ve ni hereda la configuración de ana');
    assert.ok(fs.existsSync(path.join(root, 'streamers', '111', 'config.json')));
    assert.ok(!fs.existsSync(path.join(root, 'streamers', '222', 'config.json')));
  } finally { await close(); }
});

test('cerrar sesión de un streamer no afecta al otro; su cookie deja de valer', async () => {
  const { signIn, state, post, call, as, close } = await boot();
  try {
    const a = await signIn('111', 'ana'), b = await signIn('222', 'bob');
    assert.equal((await post('/auth/logout', a.cookie)).status, 200);
    assert.equal((await call('/api/state', { headers: as(a.cookie) })).status, 401);
    assert.equal((await state(b.cookie)).twitch.user, 'bob');
  } finally { await close(); }
});

test('lista de cuentas permitidas: otra cuenta no inicia sesión y no recibe cookie; "*" las admite todas', async () => {
  const closed = await boot({ allow: l => l === 'ana' });
  try {
    const bad = await closed.signIn('222', 'intruso');
    assert.equal(bad.status, 400); assert.equal(bad.cookie, null);
    assert.equal((await closed.signIn('111', 'ana')).status, 302);
    assert.equal(closed.tenants.map.has('222'), false, 'no se crea nada para una cuenta rechazada');
  } finally { await closed.close(); }
});

test('tope de streamers: al llegar al máximo se rechaza uno nuevo, pero uno existente puede volver a entrar', async () => {
  const { signIn, close } = await boot({ max: 2 });
  try {
    assert.equal((await signIn('1', 'a')).status, 302); assert.equal((await signIn('2', 'b')).status, 302);
    assert.equal((await signIn('3', 'c')).status, 400);
    assert.equal((await signIn('1', 'a')).status, 302);
  } finally { await close(); }
});

test('remoto: Host y Origin deben coincidir con PUBLIC_URL; /healthz responde siempre y sin datos', async () => {
  const { call, close } = await boot();
  try {
    assert.equal((await call('/', { headers: { Host: 'evil.test' } })).status, 403);
    assert.equal((await call('/', { headers: { Origin: 'https://evil.test' } })).status, 403);
    const hz = await call('/healthz', { headers: { Host: 'healthcheck.railway.app' } });
    assert.equal(hz.status, 200); assert.equal(hz.body, 'ok');
  } finally { await close(); }
});

test('local: no pide sesión y muestra al último streamer que inició sesión', async () => {
  const { call, state, close } = await boot({ remote: false });
  try {
    assert.equal(JSON.parse((await call('/api/state')).body).twitch.authenticated, false, 'al principio nadie ha iniciado sesión');
    assert.equal((await call('/', { headers: { Host: 'evil.test' } })).status, 403);
    assert.equal((await call('/auth/callback?code=111:ana&state=s')).status, 302);
    assert.equal(JSON.parse((await call('/api/state')).body).twitch.user, 'ana');
    assert.equal((await call('/auth/callback?code=222:bob&state=s')).status, 302);
    assert.equal(JSON.parse((await call('/api/state')).body).twitch.user, 'bob');
  } finally { await close(); }
});

/* ---------- CARACTERIZACIÓN de la tabla de rutas y códigos de estado actuales (refactor/0) ---------- */
test('estáticos: solo la lista cerrada de módulos compartidos e imágenes; nada más se sirve', async () => {
  const { signIn, call, as, close } = await boot();
  try {
    const { cookie } = await signIn('111', 'ana');
    const home = await call('/', { headers: as(cookie) });
    assert.equal(home.status, 200); assert.match(home.headers['content-type'], /^text\/html/); assert.equal(home.headers['cache-control'], 'no-store');
    for (const p of ['/core.js', '/i18n.js', '/locales/en.js', '/locales/es.js']) {
      const r = await call(p);
      assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], /^application\/javascript/);
    }
    for (const n of ['util', 'state', 'admin', 'stage', 'fx', 'main']) {
      const r = await call(`/ui/${n}.js`);
      assert.equal(r.status, 200, n); assert.match(r.headers['content-type'], /^application\/javascript/);
    }
    const ad = await call('/adapter.js');
    assert.equal(ad.status, 200); assert.match(ad.headers['content-type'], /^application\/javascript/); assert.match(ad.body, /const ADAPTER = \{ name: 'twitch'/);
    assert.match(home.body, /<script src="adapter\.js"><\/script>/, 'la página carga el adaptador');
    assert.equal((await call('/ui/nada.js')).status, 404); assert.equal((await call('/ui/../server.js')).status, 404);
    assert.match(home.body, /<script src="ui\/main\.js"><\/script>/, 'la página carga los scripts compartidos');
    const css = await call('/css/app.css');
    assert.equal(css.status, 200); assert.match(css.headers['content-type'], /^text\/css/); assert.match(css.body, /--gold:#e3b956/);
    assert.match(home.body, /<link rel="stylesheet" href="css\/app\.css">/, 'la página enlaza la hoja de estilos compartida');
    for (const [name, type] of [['niuzao.png', 'image/png'], ['yulon.webp', 'image/webp'], ['chiji.png', 'image/png'], ['xuen.webp', 'image/webp']]) {
      const r = await call('/img/' + name); assert.equal(r.status, 200, name); assert.equal(r.headers['content-type'], type);
    }
    for (const p of ['/server.js', '/.env', '/data/tokens.json', '/locales/fr.js', '/img/nope.png', '/img/../server.js', '/nada', '/public/index.html'])
      assert.equal((await call(p, { headers: as(cookie) })).status, 404, p);
  } finally { await close(); }
});

test('órdenes: errores de la API con código HTTP y forma {ok, errorKey, errorParams, error} traducible (D-1, D-2)', async () => {
  const { signIn, call, post, as, close } = await boot();
  const shape = (r, status, errorKey) => {
    assert.equal(r.status, status); const b = JSON.parse(r.body);
    assert.deepEqual(Object.keys(b).sort(), ['error', 'errorKey', 'errorParams', 'ok']); assert.equal(b.ok, false); assert.equal(b.errorKey, errorKey);
    assert.ok(b.error && !/[áéíóúñ]/i.test(b.error), 'el texto de respaldo va en inglés');
  };
  try {
    shape(await call('/api/state'), 401, 'err.sign_in_required');
    const { cookie } = await signIn('111', 'ana');
    shape(await call('/api/confirm', { method: 'POST', headers: as(cookie), body: '{}' }), 415, 'err.json_required');
    shape(await post('/api/nope', cookie, {}), 404, 'err.unknown_command');
    for (const inherited of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])    // nombres heredados de Object no son órdenes
      shape(await post('/api/' + inherited, cookie, {}), 404, 'err.unknown_command');
    const known = await post('/api/confirm', cookie, {});
    assert.equal(known.status, 200); assert.equal(JSON.parse(known.body).errorKey, 'err.no_active_confirm');
    // D-2: un JSON inválido ya no es un 500 sino un 400 con su clave.
    shape(await call('/api/confirm', { method: 'POST', headers: { ...as(cookie), ...JSON_H }, body: '{no es json' }), 400, 'err.invalid_json');
    shape(await call('/api/confirm', { method: 'POST', headers: { ...as(cookie), ...JSON_H }, body: JSON.stringify({ x: 'a'.repeat(70000) }) }), 413, 'err.body_too_large');
    assert.equal((await call('/api/state', { method: 'POST', headers: { ...as(cookie), ...JSON_H }, body: '{}' })).status, 404);
    assert.equal(JSON.parse((await call('/api/state', { headers: as(cookie) })).body).screen, 'admin', 'el servidor sigue sirviendo tras un cuerpo rechazado');
  } finally { await close(); }
});

test('un error inesperado responde 500 genérico sin filtrar el mensaje interno', async () => {
  const { signIn, post, tenants, close } = await boot();
  const log = console.error; console.error = () => {};
  try {
    const { cookie } = await signIn('111', 'ana');
    tenants.get('111').game.pauseToggle = () => { throw new Error('detalle interno secreto'); };
    const r = await post('/api/pause', cookie, {});
    assert.equal(r.status, 500); assert.equal(JSON.parse(r.body).errorKey, 'err.generic'); assert.ok(!r.body.includes('secreto'));
  } finally { console.error = log; await close(); }
});

test('liberar un tenant desengancha sus oyentes del servidor (D-4)', async () => {
  const { signIn, tenants, close } = await boot({ remote: false });
  try {
    await signIn('111', 'ana');                                   // local: el último que inicia sesión queda en pantalla
    const t = tenants.get('111'), changes = t.game.listenerCount('change'), identities = t.twitch.listenerCount('identity');
    assert.ok(changes >= 1 && identities >= 2, 'el servidor escucha el juego y la identidad (además del propio Game)');
    tenants.logout(t);
    assert.equal(t.game.listenerCount('change'), changes - 1);
    assert.equal(t.twitch.listenerCount('identity'), identities - 1);
  } finally { await close(); }
});

test('SSE: /api/events entrega primero el estado completo del streamer de la sesión', async () => {
  const { signIn, server, close } = await boot();
  try {
    const { cookie } = await signIn('111', 'ana');
    const port = server.address().port;
    const first = await new Promise((resolve, reject) => {
      const req = http.request({ port, host: '127.0.0.1', path: '/api/events', headers: { Host: 'app.example.test', Cookie: cookie } }, res => {
        assert.equal(res.statusCode, 200); assert.equal(res.headers['content-type'], 'text/event-stream');
        res.once('data', c => { req.destroy(); resolve(String(c)); });
      });
      req.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e))); req.end();
    });
    assert.match(first, /^data: \{/);
    const st = JSON.parse(first.slice(6));
    assert.equal(st.twitch.user, 'ana'); assert.equal(st.screen, 'admin');
    assert.deepEqual(Object.keys(st).filter(k => ['config', 'defaults', 'limits', 'twitch'].includes(k)).sort(), ['config', 'defaults', 'limits', 'twitch']);
  } finally { await close(); }
});
