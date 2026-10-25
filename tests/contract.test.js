'use strict';
// Pruebas de CARACTERIZACIÓN: congelan los contratos públicos actuales (estado que consume la interfaz, historial,
// snapshot de persistencia) para que la refactorización pueda demostrar que no cambian. Un cambio aquí es un cambio de contrato.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core');
const { Game } = require('../game');
const { makeClock, FakeTwitch, keys, sorted } = require('./helpers');

const CFG = { ...Core.DEFAULT_CONFIG, prizes: 2 };
const people = n => ['ana', 'bob', 'carla', 'diego', 'elena'].slice(0, n).map(k => ({ name: k[0].toUpperCase() + k.slice(1), key: k, userId: 'id_' + k }));
const first = () => 0;
function make(n = 4, cfg = CFG) {
  const clock = makeClock(), e = new Core.Engine({ now: clock.now, setT: clock.setT, clearT: clock.clearT, pick: first });
  assert.equal(e.start(people(n), cfg).ok, true);
  return { e, clock };
}
// Avanza el reloj simulado hasta que el motor llega a `status` (o falla).
function until(clock, cond, maxMs = 3_600_000) { for (let s = 0; !cond(); s += 100) { if (s > maxMs) throw new Error('condición no alcanzada'); clock.advance(100); } }
const chatFrom = (e, key) => e.handleChat({ messageId: 'm' + Math.random(), chatterId: 'id_' + key, receivedAt: Date.now() });

const VIEW_KEYS = sorted(['absent', 'candidate', 'celestial', 'counts', 'deserted', 'disqualified', 'final', 'flowPaused', 'history', 'next', 'notice',
  'outcome', 'phase', 'prize', 'prizeStates', 'prizes', 'rollNames', 'round', 'screen', 'serverNow', 'skippable', 'status', 'timer', 'winners', 'xuen']);
const COUNTS_KEYS = sorted(['absentEvents', 'absentPeople', 'desertedRounds', 'disqualified', 'eligible', 'prizesDelivered', 'prizesPending', 'prizesRecovered', 'winners']);
const PHASE_KEYS = sorted(['endsAt', 'name', 'paused', 'remaining', 'total']);
const TIMER_KEYS = sorted(['closing', 'deadline', 'grace', 'paused', 'remaining', 'started', 'total']);
const PRIZE_STATE_KEYS = sorted(['celIndex', 'celestial', 'prize', 'state', 'via', 'winner']);
const HISTORY_KEYS = sorted(['celestial', 'id', 'key', 'kind', 'params', 'phase', 'prize', 't', 'text']);
const SNAPSHOT_KEYS = sorted(['absent', 'cfg', 'cur', 'disqualified', 'deserted', 'eventId', 'final', 'history', 'ph', 'outcome', 'participants', 'prizes',
  'replacement', 'rollNames', 'round', 'screen', 'seq', 'status', 'step', 'v', 'winners', 'xuen']);

test('contrato view(): claves exactas en reposo y en cada estado de una ronda completa', () => {
  const idle = new Core.Engine({}).view();
  assert.deepEqual(keys(idle), VIEW_KEYS);
  assert.deepEqual(keys(idle.counts), COUNTS_KEYS);
  const { e, clock } = make();
  const seen = new Set();
  for (let guard = 0; e.screen !== 'final' && guard < 5000; guard++) {
    const v = e.view();
    if (!seen.has(v.status)) {
      seen.add(v.status);
      assert.deepEqual(keys(v), VIEW_KEYS, 'view() en ' + v.status);
      assert.deepEqual(keys(v.counts), COUNTS_KEYS);
      if (v.phase) assert.deepEqual(keys(v.phase), PHASE_KEYS, 'phase en ' + v.status);
      if (v.timer) assert.deepEqual(keys(v.timer), TIMER_KEYS, 'timer en ' + v.status);
      for (const p of v.prizeStates) assert.deepEqual(keys(p), PRIZE_STATE_KEYS);
    }
    if (v.status === 'confirming' && e.cur && !e.cur.settled) chatFrom(e, e.cur.key);
    clock.advance(100);
  }
  for (const s of ['intro', 'countdown', 'rolling', 'reveal', 'confirming', 'won', 'transition']) assert.ok(seen.has(s), 'se observó ' + s);
});

test('contrato view(): el nombre del candidato no sale antes de la revelación y los estados de premio usan el vocabulario actual', () => {
  const { e, clock } = make();
  until(clock, () => e.status === 'rolling');
  assert.equal(e.view().candidate, null);
  assert.ok(e.view().rollNames.length > 1);
  until(clock, () => e.status === 'reveal');
  assert.equal(e.view().candidate, e.cur.name);
  assert.deepEqual(e.view().prizeStates.map(p => p.state), ['in_progress', 'pending']);
  assert.deepEqual(keys(e.view().timer), TIMER_KEYS);
  assert.equal(e.view().timer.started, false, 'el plazo aún no corre durante la revelación');
});

test('contrato del historial: cada entrada lleva clave + parámetros + texto en inglés', () => {
  const { e, clock } = make();
  until(clock, () => e.status === 'confirming');
  chatFrom(e, e.cur.key);
  assert.ok(e.history.length >= 3);
  for (const h of e.history) {
    assert.deepEqual(keys(h), HISTORY_KEYS);
    assert.equal(typeof h.text, 'string');
    assert.ok(['main', 'recovery'].includes(h.phase));
  }
  assert.deepEqual(sorted(new Set(e.history.map(h => h.kind))),['conf', 'ronda', 'sel', 'sys']);
});

test('contrato del snapshot v1: claves exactas, ida y vuelta sin pérdida y JSON puro', () => {
  const { e, clock } = make();
  until(clock, () => e.status === 'confirming');
  const snap = e.snapshot();
  assert.equal(snap.v, 1);
  assert.deepEqual(keys(snap), SNAPSHOT_KEYS);
  assert.deepEqual(keys(snap.ph), ['endsAt', 'name', 'paused', 'remaining', 'total']);
  assert.deepEqual(snap, JSON.parse(JSON.stringify(snap)));
  const clock2 = makeClock(clock.now());
  const e2 = new Core.Engine({ now: clock2.now, setT: clock2.setT, clearT: clock2.clearT, pick: first });
  assert.equal(e2.restore(snap), true);
  assert.deepEqual(e2.snapshot(), snap);
  assert.deepEqual(keys(e2.view()), VIEW_KEYS);
});

test('restore(): rechaza lo que no es un snapshot v1; CARACTERIZACIÓN: un {v:1} vacío se acepta (sin validar forma)', () => {
  const e = new Core.Engine({});
  for (const bad of [null, undefined, {}, { v: 2 }, 'x', 7]) assert.equal(e.restore(bad), false);
  // Comportamiento actual (riesgo D-9): no se valida la forma. Si se endurece, esta prueba debe actualizarse a propósito.
  assert.equal(new Core.Engine({}).restore({ v: 1 }), true);
});

test('contrato de configuración: valores por defecto, límites y orden de claves', () => {
  assert.deepEqual(Object.keys(Core.DEFAULT_CONFIG), ['prizes', 'confirmSec', 'countdownSec', 'rollSec', 'revealSec', 'winnerSec', 'absentSec', 'transitionSec', 'introSec', 'lateSec', 'graceSec']);
  assert.deepEqual(Core.LIMITS, { prizes: [1, 50], confirmSec: [10, 600], countdownSec: [0, 30], rollSec: [0, 60], revealSec: [0, 30],
    winnerSec: [0, 60], absentSec: [0, 60], transitionSec: [0, 60], introSec: [0, 60], lateSec: [0, 10], graceSec: [0, 300] });
  assert.deepEqual(keys(Core), sorted(['CELESTIALS', 'CONFIG_KEYS', 'DEFAULT_CONFIG', 'Engine', 'LIMITS', 'LIVE', 'MAX_PRIZES', 'XUEN',
    'err', 'ok', 'preview', 'roundCelestial', 'secureIndex', 'secureShuffle', 'toMs', 'validateConfig']));
});

test('contrato de errores del motor: {ok:false, errorKey, errorParams, error en inglés}', () => {
  const { e } = make();
  const r = e.disqualify('x');
  assert.deepEqual(keys(r), ['error', 'errorKey', 'errorParams', 'ok']);
  assert.equal(r.errorKey, 'err.reason_required');
  assert.equal(new Core.Engine({}).start(people(1), CFG).errorKey, 'err.not_enough_participants');
  assert.equal(new Core.Engine({}).back().errorKey, 'err.back_only_final');
});

test('Game con RELOJ SIMULADO: evento completo sin esperas reales y publicState con sus claves', async () => {
  const clock = makeClock(), tw = new FakeTwitch();
  const g = new Game({ twitch: tw, config: CFG, pick: first, clock });
  assert.deepEqual(keys(g.publicState()), sorted([...VIEW_KEYS, 'config', 'defaults', 'limits', 'twitch']));
  assert.equal((await g.start(['ana', 'bob', 'carla'])).ok, true);
  for (let i = 0; g.screen !== 'final' && i < 5000; i++) {
    if (g.status === 'confirming' && g.cur && !g.cur.settled) g.handleChat({ messageId: 'm' + i, chatterId: g.cur.userId, receivedAt: clock.now() });
    clock.advance(100);
  }
  assert.equal(g.screen, 'final');
  assert.equal(g.final, 'complete');
  assert.equal(g.winners.length, 2);
  assert.equal(clock.active, 0, 'sin temporizadores pendientes al terminar');
});

test('Game con reloj simulado: caída de Twitch en el plazo → verificación y plazo extra, sin esperas reales', async () => {
  const clock = makeClock(), tw = new FakeTwitch();
  const g = new Game({ twitch: tw, config: { ...CFG, prizes: 1 }, pick: first, clock });
  await g.start(['ana', 'bob']);
  until(clock, () => g.status === 'confirming');
  tw.setStatus('reconnecting');
  clock.advance((Core.DEFAULT_CONFIG.confirmSec + Core.DEFAULT_CONFIG.lateSec) * 1000 + 100);
  assert.equal(g.status, 'verifying');
  tw.setStatus('connected');
  assert.equal(g.status, 'confirming');
  assert.equal(g.publicState().timer.grace, true);
});
