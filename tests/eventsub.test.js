'use strict';
// Sesión EventSub aislada, con reloj simulado y WebSocket falso: reintentos, keepalive, migración, eventos duplicados y carreras.
// Sin esperas reales ni red.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventSubSession } = require('../twitch/eventsub');
const { makeClock } = require('./helpers');

class FakeWS extends EventTarget {
  constructor(url) { super(); this.url = url; this.closed = false; FakeWS.all.push(this); }
  close() { this.closed = true; }
  push(obj) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(obj) })); }
  drop() { this.dispatchEvent(new Event('close')); }          // cierre inesperado del servidor
}
FakeWS.all = [];
let mid = 0;
const meta = (type, extra = {}) => ({ message_id: 'm' + (++mid), message_type: type, ...extra });
const welcome = (id = 'S1', ka = 10) => ({ metadata: meta('session_welcome'), payload: { session: { id, keepalive_timeout_seconds: ka } } });
const chat = (user, id) => ({ metadata: meta('notification', { subscription_type: 'channel.chat.message' }),
  payload: { event: { chatter_user_id: user, chatter_user_login: 'u' + user, message_id: id, message: { text: 'hola' } } } });

function make({ subscribe } = {}) {
  FakeWS.all = [];
  const clock = makeClock(), subs = [], log = [], msgs = [];
  let ensured = 0;
  const s = new EventSubSession({
    WS: FakeWS, url: 'wss://fake/ws', backoffBaseMs: 1000, watchdogMarginMs: 0,
    timers: { setTimeout: clock.setT, clearTimeout: clock.clearT },
    subscribe: subscribe || (async id => { subs.push(id); }),
    ensureToken: async () => { ensured++; },
  });
  s.on('status', (status, reason) => log.push(reason && reason.code ? status + ':' + reason.code : status));
  s.on('message', m => msgs.push(m));
  // Deja resolver las promesas pendientes (subscribe/ensureToken) sin avanzar el reloj.
  const flush = () => new Promise(r => setImmediate(r));
  return { s, clock, subs, log, msgs, flush, get ensured() { return ensured; } };
}

test('welcome → se suscribe una sola vez y pasa a conectado; un welcome repetido (mismo message_id) se ignora', async () => {
  const { s, subs, log, flush } = make();
  s.connect(); const ws = FakeWS.all[0];
  const w = welcome(); ws.push(w); ws.push(w); await flush();
  assert.deepEqual(subs, ['S1']); assert.deepEqual(log, ['reconnecting', 'connected']);
  s.stop();
});

test('keepalive: sin mensajes dentro del plazo se da por perdida y se reintenta con espera exponencial (1 s, 2 s, 4 s) hasta el tope', async () => {
  const { s, clock, log, flush } = make();
  s.connect(); FakeWS.all[0].push(welcome('S1', 10)); await flush();
  clock.advance(9_999); assert.equal(log.at(-1), 'connected', 'aún dentro del plazo');
  clock.advance(1); assert.equal(log.at(-1), 'reconnecting:lost_keepalive');
  assert.equal(FakeWS.all[0].closed, true);
  clock.advance(999); assert.equal(FakeWS.all.length, 1, 'el reintento espera 1 s');
  clock.advance(1); await flush(); assert.equal(FakeWS.all.length, 2);
  FakeWS.all[1].drop();                                       // el siguiente intento cae sin llegar a conectar
  clock.advance(1_999); await flush(); assert.equal(FakeWS.all.length, 2, 'ahora espera 2 s');
  clock.advance(1); await flush(); assert.equal(FakeWS.all.length, 3);
  FakeWS.all[2].drop(); clock.advance(4_000); await flush(); assert.equal(FakeWS.all.length, 4, 'luego 4 s');
  s.stop();
});

test('conectar con éxito reinicia la espera de reintento', async () => {
  const { s, clock, flush } = make();
  s.connect(); FakeWS.all[0].drop(); clock.advance(1_000); await flush();       // 1.er reintento (1 s)
  FakeWS.all[1].drop(); clock.advance(2_000); await flush();                    // 2.º (2 s)
  FakeWS.all[2].push(welcome('S3')); await flush();                             // conecta: retryN = 0
  FakeWS.all[2].drop(); clock.advance(1_000); await flush();
  assert.equal(FakeWS.all.length, 4, 'tras conectar la espera vuelve a ser de 1 s');
  s.stop();
});

test('migración: la conexión vieja sigue viva hasta el welcome de la nueva; si la migración falla, la vieja se conserva', async () => {
  const { s, log, msgs, flush } = make();
  s.connect(); const old = FakeWS.all[0]; old.push(welcome()); await flush();
  old.push({ metadata: meta('session_reconnect'), payload: { session: { reconnect_url: 'wss://fake/new?token=abc' } } });
  old.push({ metadata: meta('session_reconnect'), payload: { session: { reconnect_url: 'wss://fake/otra' } } });
  assert.equal(FakeWS.all.length, 2, 'un segundo session_reconnect no abre otra conexión mientras hay una migración en curso');
  FakeWS.all[1].drop();                                                           // falla la migración
  assert.equal(old.closed, false); assert.equal(log.at(-1), 'connected');
  old.push(chat('1', 'a')); assert.equal(msgs.length, 1, 'la vieja sigue entregando');
  old.push({ metadata: meta('session_reconnect'), payload: { session: { reconnect_url: 'wss://fake/new2' } } });
  FakeWS.all[2].push(welcome('S2'));
  assert.equal(old.closed, true);
  old.push(chat('1', 'b')); assert.equal(msgs.length, 1, 'los mensajes de la conexión cerrada se ignoran');
  FakeWS.all[2].push(chat('2', 'c')); assert.equal(msgs.length, 2);
  old.drop(); assert.equal(log.includes('reconnecting:lost_closed'), false, 'el cierre de la vieja migrada no provoca reconexión');
  s.stop();
});

test('mensajes de chat: se normalizan, se deduplican por message_id de EventSub y se ignoran otros tipos de suscripción', async () => {
  const { s, msgs, flush } = make();
  s.connect(); const ws = FakeWS.all[0]; ws.push(welcome()); await flush();
  const dup = chat('5', 'c1'); ws.push(dup); ws.push(dup); ws.push(chat('6', 'c2'));
  ws.push({ metadata: meta('notification', { subscription_type: 'channel.follow' }), payload: { event: {} } });
  assert.deepEqual(msgs.map(m => [m.chatterId, m.messageId, m.text]), [['5', 'c1', 'hola'], ['6', 'c2', 'hola']]);
  s.stop();
});

test('carrera: si el socket se pierde mientras se suscribe, el éxito tardío de la suscripción no marca "conectado"', async () => {
  let release; const { s, log, flush } = make({ subscribe: () => new Promise(r => { release = r; }) });
  s.connect(); const ws = FakeWS.all[0]; ws.push(welcome());
  ws.drop(); release(); await flush();
  assert.equal(log.includes('connected'), false); assert.equal(log.at(-1), 'reconnecting:lost_closed');
  s.stop();
});

test('fallo al suscribirse: reconecta con motivo lost_subscribe; un fallo de autenticación no reintenta por su cuenta', async () => {
  let n = 0;
  const { s, log, clock, flush } = make({ subscribe: async () => { n++; const e = new Error(n === 1 ? 'HTTP 400' : 'auth'); if (n === 2) e.code = 'AUTH'; throw e; } });
  s.connect(); FakeWS.all[0].push(welcome()); await flush();
  assert.equal(log.at(-1), 'reconnecting:lost_subscribe');
  clock.advance(1_000); await flush(); FakeWS.all[1].push(welcome('S2')); await flush();
  assert.equal(log.at(-1), 'reconnecting:lost_subscribe', 'AUTH: lo notifica quien invalidó los tokens, no se reintenta aquí');
  clock.advance(5_000); await flush(); assert.equal(FakeWS.all.length, 2, 'sin reintento propio; el vigilante de keepalive sigue siendo la red de seguridad');
  s.stop();
});

test('stop() con un reintento pendiente: no se abre ningún socket nuevo; la revocación también detiene todo', async () => {
  const a = make();
  a.s.connect(); FakeWS.all[0].drop(); a.s.stop();
  a.clock.advance(60_000); await a.flush(); assert.equal(FakeWS.all.length, 1);
  const b = make();
  b.s.connect(); FakeWS.all[0].push(welcome()); await b.flush();
  FakeWS.all[0].push({ metadata: meta('revocation'), payload: { subscription: { status: 'authorization_revoked' } } });
  assert.equal(b.log.at(-1), 'disconnected:revoked'); b.clock.advance(60_000); await b.flush();
  assert.equal(FakeWS.all.length, 1); assert.equal(b.clock.active, 0, 'sin temporizadores pendientes');
});

test('un error al renovar el token en el reintento reprograma (salvo AUTH); con AUTH no se reintenta', async () => {
  FakeWS.all = [];
  const clock = makeClock(); let fail = 'net';
  const s = new EventSubSession({ WS: FakeWS, url: 'wss://fake/ws', backoffBaseMs: 1000, watchdogMarginMs: 0,
    timers: { setTimeout: clock.setT, clearTimeout: clock.clearT }, subscribe: async () => {},
    ensureToken: async () => { if (fail === 'net') throw new Error('red'); if (fail === 'auth') { const e = new Error('x'); e.code = 'AUTH'; throw e; } } });
  const flush = () => new Promise(r => setImmediate(r));
  s.connect(); FakeWS.all[0].drop();
  clock.advance(1_000); await flush(); assert.equal(FakeWS.all.length, 1, 'ensureToken falló: sin socket nuevo');
  clock.advance(2_000); await flush(); assert.equal(FakeWS.all.length, 1);
  fail = 'ok'; clock.advance(4_000); await flush(); assert.equal(FakeWS.all.length, 2, 'cuando el token vuelve a servir, reconecta');
  fail = 'auth'; FakeWS.all[1].drop(); clock.advance(60_000); await flush();
  assert.equal(FakeWS.all.length, 2); assert.equal(clock.active, 0, 'AUTH: no se reprograma');
  s.stop();
});
