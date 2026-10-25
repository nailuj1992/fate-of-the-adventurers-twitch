'use strict';
// Piezas del servidor aisladas: configuración (función pura del entorno), sesiones (con reloj inyectado) y ausencia de efectos al importar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, configProblems, isLoginAllowed, loadDotEnv } = require('../server/config');
const { createSessions } = require('../server/sessions');

const cfg = (env = {}) => readConfig(env, { dataDirDefault: '/data-default' });

test('config local por defecto: 127.0.0.1:3000, sin sesión obligatoria y cualquier cuenta puede entrar', () => {
  const c = cfg();
  assert.deepEqual([c.remote, c.host, c.port, c.dataDir, c.maxStreamers, c.consoleLocale], [false, '127.0.0.1', 3000, '/data-default', 20, 'en']);
  assert.equal(c.redirectUri, 'http://localhost:3000/auth/callback');
  assert.equal(isLoginAllowed(c, 'cualquiera'), true); assert.deepEqual(configProblems(c), []);
});

test('config remota: PUBLIC_URL normalizada, escucha en 0.0.0.0, lista permitida con TWITCH_CHANNEL como respaldo y "*" para todas', () => {
  const c = cfg({ PUBLIC_URL: 'https://app.example.test//', TWITCH_CHANNEL: 'Canal', PORT: '8080', MAX_STREAMERS: '0', LANG_UI: 'es', DATA_DIR: '/vol' });
  assert.deepEqual([c.remote, c.publicUrl, c.host, c.port, c.dataDir, c.consoleLocale, c.maxStreamers], [true, 'https://app.example.test', '0.0.0.0', 8080, '/vol', 'es', 20]);
  assert.equal(c.redirectUri, 'https://app.example.test/auth/callback');
  assert.deepEqual(c.allowedLogins, ['canal']); assert.equal(isLoginAllowed(c, 'canal'), true); assert.equal(isLoginAllowed(c, 'otra'), false);
  assert.equal(isLoginAllowed(cfg({ PUBLIC_URL: 'https://a.test', ALLOWED_LOGINS: '*' }), 'otra'), true);
  assert.equal(cfg({ LANG_UI: 'fr' }).consoleLocale, 'en');
  assert.equal(cfg({ MAX_STREAMERS: '3' }).maxStreamers, 3);
});

test('config remota insegura: sin https o sin lista de cuentas no se arranca', () => {
  assert.equal(configProblems(cfg({ PUBLIC_URL: 'http://a.test', ALLOWED_LOGINS: 'x' })).length, 1);
  assert.equal(configProblems(cfg({ PUBLIC_URL: 'https://a.test/ruta', ALLOWED_LOGINS: 'x' })).length, 1);
  assert.equal(configProblems(cfg({ PUBLIC_URL: 'https://a.test' })).length, 1);
  assert.equal(configProblems(cfg({ PUBLIC_URL: 'http://a.test' })).length, 2);
  assert.deepEqual(configProblems(cfg({ PUBLIC_URL: 'https://a.test', ALLOWED_LOGINS: 'x' })), []);
});

test('loadDotEnv: lee KEY=valor (con comillas), no pisa el entorno y no falla sin archivo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), file = path.join(dir, '.env');
  fs.writeFileSync(file, '# comentario\nA=1\nB = "dos"\nC=\'tres\'\nYA=nuevo\r\nmala linea\n');
  const env = { YA: 'existente' };
  loadDotEnv(file, env);
  assert.deepEqual(env, { YA: 'existente', A: '1', B: 'dos', C: 'tres' });
  assert.doesNotThrow(() => loadDotEnv(path.join(dir, 'no-existe'), {}));
});

test('forLog: sin saltos de línea ni caracteres de control, con tope de longitud y aceptando cualquier valor', () => {
  const { forLog, MAX_LOG_CHARS } = require('../logging');
  assert.equal(forLog('línea 1\r\nFALSO [twitch] ok\u0000\u007fcierre'), 'línea 1 FALSO [twitch] ok cierre', 'una racha de controles pasa a UN espacio');
  assert.equal(forLog('a'.repeat(MAX_LOG_CHARS + 50)).length, MAX_LOG_CHARS);
  assert.equal(forLog(undefined), 'undefined'); assert.equal(forLog(new Error('x')), 'Error: x');
});

test('importar server.js no tiene efectos: no lee .env ni modifica process.env', () => {
  const before = JSON.stringify(process.env);
  delete require.cache[require.resolve('../server')];
  const m = require('../server');
  assert.equal(typeof m.createApp, 'function'); assert.equal(JSON.stringify(process.env), before);
});

test('sesiones: cookie con la forma exacta, caducidad, cierre por petición y por streamer', () => {
  let now = 1000;
  const s = createSessions({ cookieName: 'sid', ttlMs: 100, now: () => now });
  const req = sid => ({ headers: { cookie: `x=1; sid=${sid}` } });
  const a = s.open(111), b = s.open('222');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(s.lookup(req(a)), '111'); assert.equal(s.lookup(req(b)), '222');
  assert.equal(s.lookup(req('../../etc')), null); assert.equal(s.lookup({ headers: {} }), null); assert.equal(s.lookup(req('a'.repeat(64))), null);
  s.close(req(a)); assert.equal(s.lookup(req(a)), null);
  now += 101; assert.equal(s.lookup(req(b)), null, 'caducada');
  assert.equal(s.size, 0, 'consultar una caducada la elimina');
  const c = s.open('333'), d = s.open('333'); s.dropAll('333');
  assert.equal(s.lookup(req(c)), null); assert.equal(s.lookup(req(d)), null);
});

test('sesiones: las caducadas que nunca se vuelven a consultar se barren al abrir otra (D-3)', () => {
  let now = 0;
  const s = createSessions({ cookieName: 'sid', ttlMs: 100, now: () => now });
  for (let i = 0; i < 50; i++) s.open(String(i));
  assert.equal(s.size, 50);
  now = 200; s.open('nuevo');
  assert.equal(s.size, 1);
});
