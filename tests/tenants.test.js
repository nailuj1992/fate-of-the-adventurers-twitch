'use strict';
// Pruebas de caracterización de Tenants (un tenant por streamer) con Twitch falso: creación, tope, liberación, modo local y reconexión.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Tenants } = require('../tenants');
const { StreamerStore } = require('../store');

class FakeTwitch extends EventEmitter {
  static inits = [];
  constructor(o) { super(); this.o = o; this.status = 'disconnected'; this.user = null; this.logouts = 0; }
  snapshot() { return { configured: true, authenticated: !!this.user, status: this.status, reason: null, user: this.user && this.user.login, channel: '' }; }
  authUrl() { return 'https://id.twitch.tv/oauth2/authorize?x=1'; }
  async exchange(q) { const [id, login] = String(q.code).split(':'); return { tokens: { accessToken: 'AT' + id }, who: { user_id: id, login } }; }
  async adopt(tokens) { this.tokens = tokens; this.user = { id: 'x', login: 'x' }; this.status = 'connected'; }
  async init() { FakeTwitch.inits.push(this.o.tokenFile); }
  logout() { this.logouts++; this.user = null; this.status = 'disconnected'; }
}
const make = (o = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ten-'));
  return { root, t: new Tenants({ store: new StreamerStore(root), TwitchClass: FakeTwitch, ...o }) };
};

test('arranca con un tenant invitado sin cuenta y sin archivo de tokens', () => {
  const { t } = make();
  assert.equal(t.current, t.guest); assert.equal(t.guest.id, null); assert.deepEqual(t.all(), [t.guest]);
  assert.equal(t.guest.twitch.o.tokenFile, undefined);
  assert.equal(t.auth.o.tokenFile, undefined, 'la instancia de OAuth nunca guarda tokens');
});

test('login crea el tenant del streamer con su archivo de tokens y su Game; repetir login reutiliza el mismo', async () => {
  const { t, root } = make();
  const a = await t.login({ code: '111:ana' });
  assert.equal(a.id, '111'); assert.equal(t.get(111), a); assert.equal(a.twitch.o.tokenFile, path.join(root, 'streamers', '111', 'tokens.json'));
  assert.ok(a.game && a.twitch.tokens, 'Game creado y tokens adoptados');
  assert.equal(await t.login({ code: '111:ana' }), a);
  assert.equal(t.map.size, 1);
});

test('login rechaza cuentas no permitidas, ids no numéricos y el exceso de streamers', async () => {
  const { t } = make({ allowLogin: l => l !== 'mala', max: 1 });
  await assert.rejects(t.login({ code: '5:mala' }), /not allowed/);
  await assert.rejects(t.login({ code: '../x:ana' }), /Unexpected Twitch user id/);
  await t.login({ code: '1:ana' });
  await assert.rejects(t.login({ code: '2:bob' }), /Too many streamers/);
  assert.equal(t.map.size, 1);
});

test('modo local: el último que inicia sesión es el actual y se avisa con "current"; en remoto no cambia', async () => {
  const local = make({ local: true }).t, avisos = [];
  local.on('current', x => avisos.push(x.id));
  await local.login({ code: '1:ana' }); await local.login({ code: '2:bob' });
  assert.deepEqual(avisos, ['1', '2']); assert.equal(local.current.id, '2');
  const remote = make({ local: false }).t;
  await remote.login({ code: '1:ana' }); assert.equal(remote.current, remote.guest);
});

test('logout: cierra la sesión de Twitch y libera el tenant solo si no hay evento en marcha', async () => {
  const { t } = make({ local: true }), released = [];
  t.on('released', x => released.push(x.id));
  const a = await t.login({ code: '1:ana' });
  t.logout(a);
  assert.equal(a.twitch.logouts, 1); assert.equal(t.get('1'), null); assert.equal(t.current, t.guest); assert.deepEqual(released, ['1']);
  const b = await t.login({ code: '2:bob' });
  b.game.engine.screen = 'stage';                       // evento en marcha (estado mínimo)
  t.logout(b);
  assert.equal(b.twitch.logouts, 1); assert.equal(t.get('2'), b, 'se conserva hasta que termine el evento');
  t.logout(t.guest); t.logout(null);                    // no hacen nada
  assert.equal(t.guest.twitch.logouts, 0);
});

test('loadSaved: reconecta solo las carpetas con tokens e ID numérico y deja visible la más reciente', () => {
  FakeTwitch.inits.length = 0;
  const { t, root } = make({ local: true });
  const put = (id, withTokens, mtime) => {
    const d = path.join(root, 'streamers', id); fs.mkdirSync(d, { recursive: true });
    if (withTokens) { const f = path.join(d, 'tokens.json'); fs.writeFileSync(f, '{}'); fs.utimesSync(f, mtime, mtime); }
  };
  put('111', true, new Date('2024-01-01')); put('222', true, new Date('2025-01-01')); put('333', false); put('abc', true, new Date('2026-01-01'));
  t.loadSaved();
  assert.deepEqual([...t.map.keys()].sort(), ['111', '222']);
  assert.equal(FakeTwitch.inits.length, 2);
  assert.equal(t.current.id, '222');
  assert.doesNotThrow(() => make().t.loadSaved(), 'sin carpeta data/streamers no falla');
});
