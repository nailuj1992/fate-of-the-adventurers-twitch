'use strict';
// Pruebas del protocolo EventSub/OAuth con un WebSocket y un fetch simulados (sin red).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Twitch } = require('../twitch');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 2000) { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(2); } }

class FakeWS extends EventTarget {
  static all = [];
  constructor(url) { super(); this.url = url; this.closed = false; FakeWS.all.push(this); }
  close() { if (this.closed) return; this.closed = true; setTimeout(() => this.dispatchEvent(new Event('close')), 0); }
  push(obj) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(obj) })); }
}
let mid = 0;
const meta = (type, extra = {}) => ({ message_id: 'mid' + (++mid), message_type: type, message_timestamp: new Date().toISOString(), ...extra });
const welcome = (id = 'SESSION1', ka = 10) => ({ metadata: meta('session_welcome'), payload: { session: { id, status: 'connected', keepalive_timeout_seconds: ka } } });
const chatMsg = (user, id, text = 'hola', metaId) => ({
  metadata: { ...meta('notification', { subscription_type: 'channel.chat.message' }), ...(metaId ? { message_id: metaId } : {}) },
  payload: { subscription: { type: 'channel.chat.message' }, event: { chatter_user_id: user, chatter_user_login: 'u' + user, message_id: id, message: { text } } },
});

function make(overrides = {}) {
  FakeWS.all = [];
  const calls = [];
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tw-')), 'tokens.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3600e3 }));
  const state = { scopes: ['user:read:chat'], subStatus: 202 };
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const u = String(url), json = (code, body) => ({ ok: code < 300, status: code, json: async () => body });
    if (u.endsWith('/oauth2/validate')) return json(200, { client_id: 'cid', login: 'streamer', user_id: '100', scopes: state.scopes, expires_in: 3000 });
    if (u.endsWith('/oauth2/token')) return json(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
    if (u.includes('/helix/users')) return json(200, { data: [{ id: '7', login: 'ana', display_name: 'Ana' }] });
    if (u.endsWith('/eventsub/subscriptions')) return json(state.subStatus, { message: 'x' });
    return json(404, {});
  };
  const tw = new Twitch({ clientId: 'cid', clientSecret: 'sec', redirectUri: 'http://localhost:3000/auth/callback', tokenFile,
    fetchImpl, WebSocketImpl: FakeWS, eventsubUrl: 'wss://fake/ws', backoffBaseMs: 5, watchdogMarginMs: 0, ...overrides });
  return { tw, calls, state, tokenFile };
}
const statuses = tw => { const l = []; tw.on('status', s => l.push(s.status)); return l; };

test('conecta, se suscribe a channel.chat.message v1 con los IDs correctos y pasa a conectado', async () => {
  const { tw, calls } = make();
  await tw.init();
  assert.equal(FakeWS.all.length, 1); assert.equal(FakeWS.all[0].url, 'wss://fake/ws');
  assert.equal(tw.status, 'reconnecting');
  FakeWS.all[0].push(welcome());
  await until(() => tw.status === 'connected');
  const sub = calls.find(c => c.url.endsWith('/eventsub/subscriptions'));
  const body = JSON.parse(sub.opts.body);
  assert.equal(body.type, 'channel.chat.message'); assert.equal(body.version, '1');
  assert.deepEqual(body.condition, { broadcaster_user_id: '100', user_id: '100' });
  assert.deepEqual(body.transport, { method: 'websocket', session_id: 'SESSION1' });
  assert.equal(sub.opts.headers.Authorization, 'Bearer AT'); assert.equal(sub.opts.headers['Client-Id'], 'cid');
  tw.logout();
});

test('mensajes de chat: se emiten con el ID del autor y los reenvíos del mismo message_id se descartan', async () => {
  const { tw } = make(); await tw.init();
  const ws = FakeWS.all[0]; ws.push(welcome()); await until(() => tw.status === 'connected');
  const got = []; tw.on('message', m => got.push(m));
  ws.push(chatMsg('55', 'c1', 'hola', 'DUP')); ws.push(chatMsg('55', 'c1', 'hola', 'DUP')); ws.push(chatMsg('66', 'c2'));
  assert.equal(got.length, 2);
  assert.equal(got[0].chatterId, '55'); assert.equal(got[0].messageId, 'c1'); assert.equal(got[1].chatterId, '66');
  tw.logout();
});

test('session_reconnect: migra sin perder el estado "conectado" y cierra la conexión vieja', async () => {
  const { tw } = make(); const st = statuses(tw); await tw.init();
  const old = FakeWS.all[0]; old.push(welcome()); await until(() => tw.status === 'connected');
  old.push({ metadata: meta('session_reconnect'), payload: { session: { id: 'S1', reconnect_url: 'wss://fake/new?token=abc' } } });
  assert.equal(FakeWS.all.length, 2); assert.equal(FakeWS.all[1].url, 'wss://fake/new?token=abc');
  assert.equal(old.closed, false, 'la vieja sigue abierta hasta el welcome de la nueva');
  FakeWS.all[1].push(welcome('SESSION2'));
  await until(() => old.closed); await sleep(10);
  assert.equal(tw.status, 'connected');
  assert.ok(!st.slice(st.indexOf('connected') + 1).includes('reconnecting'), 'no hubo hueco: ' + st.join(','));
  const got = []; tw.on('message', m => got.push(m)); FakeWS.all[1].push(chatMsg('1', 'x'));
  assert.equal(got.length, 1);
  tw.logout();
});

test('caída inesperada: pasa a reconectando, reintenta y vuelve a conectado', async () => {
  const { tw } = make(); await tw.init();
  const ws = FakeWS.all[0]; ws.push(welcome()); await until(() => tw.status === 'connected');
  ws.close(); await until(() => tw.status === 'reconnecting');
  await until(() => FakeWS.all.length === 2);
  FakeWS.all[1].push(welcome('S2')); await until(() => tw.status === 'connected');
  tw.logout();
});

test('sin keepalive ni mensajes: se considera perdida y se reconecta', async () => {
  const { tw } = make(); await tw.init();
  FakeWS.all[0].push(welcome('S1', 1)); await until(() => tw.status === 'connected');
  await until(() => tw.status === 'reconnecting', 3000);
  await until(() => FakeWS.all.length === 2, 3000);
  tw.logout();
});

test('revocation: queda desconectado y no reintenta', async () => {
  const { tw } = make(); await tw.init();
  const ws = FakeWS.all[0]; ws.push(welcome()); await until(() => tw.status === 'connected');
  ws.push({ metadata: meta('revocation'), payload: { subscription: { status: 'authorization_revoked' } } });
  assert.equal(tw.status, 'disconnected'); await sleep(40); assert.equal(FakeWS.all.length, 1);
});

test('si el token no tiene user:read:chat se rechaza y se borran los tokens', async () => {
  const { tw, state, tokenFile } = make(); state.scopes = ['chat:read'];
  await tw.init();
  assert.equal(tw.status, 'disconnected'); assert.equal(fs.existsSync(tokenFile), false); assert.equal(FakeWS.all.length, 0);
});

test('fallo al suscribirse: reintenta en lugar de quedar conectado', async () => {
  const { tw, state } = make(); state.subStatus = 400; await tw.init();
  FakeWS.all[0].push(welcome());
  await until(() => FakeWS.all.length >= 2);
  assert.notEqual(tw.status, 'connected');
  tw.logout();
});

test('OAuth: URL con scope mínimo y state; el callback valida state y guarda tokens', async () => {
  const { tw, calls, tokenFile } = make();
  const u = new URL(tw.authUrl());
  assert.equal(u.origin + u.pathname, 'https://id.twitch.tv/oauth2/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code'); assert.equal(u.searchParams.get('scope'), 'user:read:chat');
  assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/callback');
  assert.equal(u.searchParams.get('client_secret'), null, 'el secreto nunca va en la URL');
  await assert.rejects(tw.handleCallback({ code: 'c', state: 'falso' }), /state/);
  fs.unlinkSync(tokenFile);
  await tw.handleCallback({ code: 'CODE', state: u.searchParams.get('state') });
  const tokenCall = calls.find(c => c.url.endsWith('/oauth2/token'));
  assert.match(String(tokenCall.opts.body), /grant_type=authorization_code/);
  assert.equal(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).refreshToken, 'RT2');
  await assert.rejects(tw.handleCallback({ code: 'CODE', state: u.searchParams.get('state') }), /state/, 'el state es de un solo uso');
  tw.logout();
});

test('resolveLogins consulta Helix con varios login y devuelve ID y nombre visible', async () => {
  const { tw, calls } = make(); await tw.init();
  const m = await tw.resolveLogins(['ana', 'zzz']);
  assert.equal(m.get('ana').id, '7'); assert.equal(m.get('ana').displayName, 'Ana'); assert.equal(m.has('zzz'), false);
  assert.match(calls.at(-1).url, /login=ana&login=zzz/);
  tw.logout();
});
