'use strict';
// Pruebas del núcleo compartido con un RELOJ SIMULADO: los tiempos se avanzan a mano, sin esperas reales.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../core');

/* ---------- reloj simulado ---------- */
function makeClock() {
  let t = 1_000_000, id = 0; const q = new Map();
  return {
    now: () => t,
    setT: (f, ms) => { const i = ++id; q.set(i, { at: t + ms, f }); return i; },
    clearT: i => q.delete(i),
    get active() { return q.size; },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let best = null;
        for (const [i, e] of q) if (e.at <= end && (!best || e.at < best.e.at)) best = { i, e };
        if (!best) break;
        q.delete(best.i); t = Math.max(t, best.e.at); best.e.f();
      }
      t = end;
    },
  };
}
const CFG = { ...Core.DEFAULT_CONFIG };       // tiempos por defecto reales (5/8/5/120/8/5/5/8)
const NAMES = ['ana', 'bob', 'carla', 'diego', 'elena', 'fran', 'gus', 'hugo', 'ivan', 'jose', 'kike', 'luis'];
const people = (n = 5) => NAMES.slice(0, n).map(k => ({ name: k[0].toUpperCase() + k.slice(1), key: k, userId: 'id_' + k }));
const first = () => 0;
function make({ cfg = {}, n = 5, connection } = {}) {
  const clock = makeClock(), events = [];
  const e = new Core.Engine({ now: clock.now, setT: clock.setT, clearT: clock.clearT, pick: first, connection, onChange: () => { events.push(clock.active); } });
  const config = { ...CFG, ...cfg };
  assert.equal(e.start(people(n), config).ok, true);
  return { e, clock, events, config };
}
const chat = (e, name, id) => e.handleChat({ messageId: id || 'm' + Math.random(), chatterId: 'id_' + name.toLowerCase(), receivedAt: Date.now() });
// Avanza hasta que se cumpla una condición, en pasos de 100 ms de reloj simulado.
function until(clock, cond, maxMs = 3_600_000) { let spent = 0; while (!cond()) { clock.advance(100); spent += 100; if (spent > maxMs) throw new Error('condición no alcanzada'); } }

/* ---------- configuración central ---------- */
test('valores por defecto: 3 premios y los tiempos pedidos', () => {
  assert.deepEqual(Core.DEFAULT_CONFIG, { prizes: 3, confirmSec: 120, countdownSec: 5, rollSec: 8, revealSec: 5, winnerSec: 8, absentSec: 5, transitionSec: 5, introSec: 8, lateSec: 3, graceSec: 30 });
  assert.equal(Core.validateConfig({}).ok, true);
});
test('cada opción de configuración tiene límites; etiqueta y ayuda (tooltip) en ambos idiomas', () => {
  const I18n = require('../i18n');
  for (const k of Core.CONFIG_KEYS) {
    assert.ok(Core.LIMITS[k], 'límites de ' + k);
    for (const loc of I18n.SUPPORTED) {
      assert.ok(I18n.catalogs[loc]['cfg.label.' + k], `etiqueta de ${k} en ${loc}`);
      assert.ok((I18n.catalogs[loc]['cfg.help.' + k] || '').length > 20, `ayuda de ${k} en ${loc}`);
    }
  }
});
test('validación: negativos, decimales, texto, vacíos, excesos y premios > participantes', () => {
  const bad = (k, v, count) => Core.validateConfig({ [k]: v }, count).errors[k];
  assert.ok(bad('confirmSec', -5)); assert.ok(bad('rollSec', 1.5)); assert.ok(bad('introSec', 'abc')); assert.ok(bad('winnerSec', ''));
  assert.ok(bad('confirmSec', 9)); assert.ok(bad('confirmSec', 601)); assert.ok(bad('countdownSec', 31)); assert.ok(bad('rollSec', 61));
  assert.ok(bad('prizes', 0)); assert.ok(bad('prizes', 51)); assert.ok(bad('prizes', NaN)); assert.ok(bad('prizes', Infinity));
  assert.deepEqual(bad('prizes', 8, 5), { code: 'max_participants', count: 5 });
  assert.equal(bad('confirmSec', 9).code, 'range'); assert.equal(bad('rollSec', 1.5).code, 'integer'); assert.equal(bad('introSec', 'abc').code, 'number');
  assert.equal(bad('prizes', 5, 5), undefined);
  assert.equal(Core.validateConfig({ prizes: '4', confirmSec: ' 90 ' }).config.confirmSec, 90, 'acepta números como texto');
  assert.equal(Core.validateConfig({ countdownSec: 0, revealSec: 0 }).ok, true, '0 s en animaciones es válido');
});

/* ---------- rotación ---------- */
test('rotación circular de Celestiales: 1, 3, 5, 8 y 10 premios', () => {
  const seq = n => Core.preview(n).map(p => p.celestial).join(',');
  assert.equal(seq(1), 'Niuzao');
  assert.equal(seq(3), "Niuzao,Yu'lon,Chi-ji");
  assert.equal(seq(5), "Niuzao,Yu'lon,Chi-ji,Niuzao,Yu'lon");
  assert.equal(seq(8), "Niuzao,Yu'lon,Chi-ji,Niuzao,Yu'lon,Chi-ji,Niuzao,Yu'lon");
  assert.equal(seq(10), "Niuzao,Yu'lon,Chi-ji,Niuzao,Yu'lon,Chi-ji,Niuzao,Yu'lon,Chi-ji,Niuzao");
  assert.equal(Core.roundCelestial(7, 8).name, "Yu'lon"); assert.equal(Core.roundCelestial(8, 8).name, 'Xuen', 'Xuen solo en recuperación');
});
test('las copias de core.js, i18n.js y locales/ de la versión manual son idénticas a estas', () => {
  for (const f of ['core.js', 'i18n.js', 'locales/en.js', 'locales/es.js']) {
    const sib = ['fate-of-the-adventurers-manual', 'Idea 2 - Manual'].find(n => fs.existsSync(path.join(__dirname, '..', '..', n)));
    const other = path.join(__dirname, '..', '..', sib || 'fate-of-the-adventurers-manual', f);
    if (!fs.existsSync(other)) continue;                   // si alguien separa las carpetas, no falla
    assert.equal(fs.readFileSync(other, 'utf8'), fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), f);
  }
});

/* ---------- fases y temporizadores ---------- */
test('un solo temporizador activo en todo momento durante un evento completo con ausencias, descalificación y Xuen', () => {
  const { e, clock, events } = make({ n: 4, cfg: { prizes: 3 } });
  let guard = 0;
  while (e.screen === 'stage' && guard++ < 400) {
    if (e.status === 'confirming' && e.cur && !e.cur.settled) {
      if (e.cur.name === 'Ana' && e.round < 2) { until(clock, () => e.status !== 'confirming'); continue; }       // Ana ausente en las dos primeras rondas
      e.confirmManual();
    }
    clock.advance(500);
  }
  assert.equal(e.screen, 'final');
  assert.ok(Math.max(...events) <= 1, 'nunca hubo más de un temporizador programado: ' + Math.max(...events));
});
test('el plazo de confirmación empieza al terminar la revelación y dura exactamente lo configurado', () => {
  const { e, clock } = make();                              // intro 8 + cuenta 5 + selección 8 + revelación 5
  clock.advance(8000); assert.equal(e.status, 'countdown');
  clock.advance(5000); assert.equal(e.status, 'rolling');
  assert.equal(e.view().candidate, null, 'el nombre no es visible durante la selección');
  clock.advance(8000); assert.equal(e.status, 'reveal');
  const v = e.view(); assert.ok(v.candidate); assert.equal(v.timer.started, false); assert.equal(v.timer.remaining, 120000);
  clock.advance(4999); assert.equal(e.status, 'reveal'); assert.equal(e.view().timer.remaining, 120000, 'la revelación no descuenta tiempo');
  clock.advance(1); assert.equal(e.status, 'confirming');
  clock.advance(119_999); assert.equal(e.status, 'confirming'); assert.equal(e.view().timer.closing, false);
  clock.advance(1); assert.equal(e.view().timer.closing, true, 'a los 120 s exactos empieza el margen');
  clock.advance(3000); assert.equal(e.status, 'absent');
});
test('se escucha el chat durante la revelación (el nombre ya es visible) y confirma sin esperar al plazo', () => {
  const { e, clock } = make();
  clock.advance(8000 + 5000 + 8000); assert.equal(e.status, 'reveal');
  chat(e, e.cur.name); assert.equal(e.status, 'won'); assert.equal(e.winners[0].source, 'chat');
});
test('temporizador personalizado: respeta el valor configurado', () => {
  const { e, clock } = make({ cfg: { confirmSec: 30, introSec: 0, countdownSec: 0, rollSec: 0, revealSec: 0 } });
  clock.advance(0); until(clock, () => e.status === 'confirming', 1000); assert.equal(e.view().timer.total, 30000);
  clock.advance(29_900); assert.equal(e.view().timer.closing, false); clock.advance(100); assert.equal(e.view().timer.closing, true);
});
test('plazo expirado: se procesa UNA sola vez; mensajes y confirmaciones posteriores no se aceptan', () => {
  const { e, clock } = make({ cfg: { lateSec: 3 } });
  until(clock, () => e.status === 'confirming'); const c = e.cur.name;
  clock.advance(123_000); assert.equal(e.status, 'absent');
  assert.equal(e.absent.length, 1); assert.equal(e.history.filter(h => h.kind === 'aus').length, 1);
  chat(e, c); assert.equal(e.winners.length, 0, 'tras el plazo no se acepta');
  assert.equal(e.confirmManual().ok, false);
  clock.advance(60_000); assert.equal(e.absent.length, 1, 'el vencimiento no se repite al seguir pasando el tiempo');
});
test('confirmación dentro del plazo se acepta; en el margen de entrega también; después del margen no', () => {
  let r = make(); until(r.clock, () => r.e.status === 'confirming');
  r.clock.advance(60_000); chat(r.e, r.e.cur.name); assert.equal(r.e.status, 'won');
  r = make(); until(r.clock, () => r.e.status === 'confirming');
  r.clock.advance(121_000); assert.equal(r.e.view().timer.closing, true); chat(r.e, r.e.cur.name); assert.equal(r.e.status, 'won', 'dentro del margen de 3 s');
  r = make(); until(r.clock, () => r.e.status === 'confirming');
  r.clock.advance(123_001); assert.equal(r.e.status, 'absent'); chat(r.e, 'Ana'); assert.equal(r.e.winners.length, 0);
});
test('modo estricto (margen 0): un mensaje justo después de 0:00 no se acepta', () => {
  const { e, clock } = make({ cfg: { lateSec: 0 } });
  until(clock, () => e.status === 'confirming'); const c = e.cur.name;
  clock.advance(120_001); assert.equal(e.status, 'absent'); chat(e, c); assert.equal(e.winners.length, 0);
});
test('pausa y reanudación conservan el tiempo restante; saltar solo vale en esperas de visualización', () => {
  const { e, clock } = make();
  clock.advance(3000); assert.equal(e.status, 'intro');
  assert.equal(e.pauseToggle().ok, true); clock.advance(60_000); assert.equal(e.status, 'intro', 'pausado: no avanza');
  assert.equal(e.view().phase.remaining, 5000); e.pauseToggle(); clock.advance(4999); assert.equal(e.status, 'intro'); clock.advance(1); assert.equal(e.status, 'countdown');
  assert.equal(e.skip().ok, false, 'la cuenta atrás no se salta');
  until(clock, () => e.status === 'confirming'); clock.advance(10_000); e.pauseToggle(); assert.equal(e.status, 'paused');
  clock.advance(500_000); assert.equal(e.status, 'paused'); assert.equal(e.absent.length, 0);
  e.pauseToggle(); assert.equal(e.status, 'confirming'); clock.advance(109_999); assert.equal(e.view().timer.closing, false);
});
test('saltar la visualización del ganador acelera el avance sin duplicar nada', () => {
  const { e, clock } = make();
  until(clock, () => e.status === 'confirming'); e.confirmManual(); assert.equal(e.status, 'won');
  assert.equal(e.skip().ok, true); assert.equal(e.status, 'transition'); assert.equal(e.skip().ok, true); assert.equal(e.status, 'intro');
  assert.equal(e.round, 1);
});
test('persistencia: snapshot/restore a mitad de confirmación conserva el plazo y vence una sola vez', () => {
  const a = make(); until(a.clock, () => a.e.status === 'confirming'); a.clock.advance(50_000);
  const snap = JSON.parse(JSON.stringify(a.e.snapshot()));
  const b = new Core.Engine({ now: a.clock.now, setT: a.clock.setT, clearT: a.clock.clearT, pick: first });
  assert.equal(b.restore(snap), true); assert.equal(b.status, 'confirming'); assert.equal(b.cur.name, a.e.cur.name);
  assert.ok(Math.abs(b.view().timer.remaining - 70_000) <= 100);
  a.e.clearPhase();                                           // la «página anterior» ya no existe
  a.clock.advance(70_000 + 3000); assert.equal(b.status, 'absent'); assert.equal(b.absent.length, 1);
});
test('persistencia: con el evento pausado se restaura pausado', () => {
  const a = make(); until(a.clock, () => a.e.status === 'confirming'); a.e.pauseToggle();
  const b = new Core.Engine({ now: a.clock.now, setT: a.clock.setT, clearT: a.clock.clearT, pick: first });
  b.restore(JSON.parse(JSON.stringify(a.e.snapshot()))); a.clock.advance(1_000_000);
  assert.equal(b.status, 'paused'); assert.equal(b.absent.length, 0);
});

/* ---------- caída de conexión con el temporizador del servidor ---------- */
test('caída de conexión: no se declara ausente; al recuperarla hay plazo extra', () => {
  let conn = 'connected';
  const { e, clock } = make({ connection: () => conn });
  until(clock, () => e.status === 'confirming'); const c = e.cur.name;
  conn = 'reconnecting'; e.onConnection('reconnecting');
  clock.advance(125_000); assert.equal(e.status, 'verifying'); assert.equal(e.absent.length, 0);
  clock.advance(120_000); assert.equal(e.status, 'verifying', 'sin conexión fiable no se resuelve');
  conn = 'connected'; e.onConnection('connected'); assert.equal(e.status, 'confirming'); assert.equal(e.cur.grace, true);
  chat(e, c); assert.equal(e.status, 'won');
});

test('barajado al iniciar: el orden de los participantes lo decide la función de barajado y queda anotado', () => {
  const clock = makeClock();
  const e = new Core.Engine({ now: clock.now, setT: clock.setT, clearT: clock.clearT, pick: first, shuffle: a => a.slice().reverse() });
  assert.equal(e.start(people(4), { ...CFG, prizes: 2 }).ok, true);
  assert.deepEqual(e.participants.map(p => p.key), ['diego', 'carla', 'bob', 'ana']);
  assert.ok(e.history.some(h => h.key === 'shuffled'));
  e.cancel();
});

test('secureShuffle devuelve una permutación (mismos elementos, sin tocar el original) y mezcla de verdad', () => {
  const src = Array.from({ length: 30 }, (_, i) => i), copy = src.slice();
  const out = Core.secureShuffle(src);
  assert.deepEqual(src, copy, 'no modifica la lista original');
  assert.deepEqual([...out].sort((a, b) => a - b), src, 'mismos elementos');
  assert.notDeepEqual(out, src, 'con 30 elementos la probabilidad de quedar igual es 1/30!');
});

test('sin pick ni shuffle inyectados, el motor baraja por defecto; con pick inyectado conserva el orden', () => {
  const clock = makeClock();
  const a = new Core.Engine({ now: clock.now, setT: clock.setT, clearT: clock.clearT, pick: first });
  a.start(people(5), { ...CFG, prizes: 2 });
  assert.deepEqual(a.participants.map(p => p.key), ['ana', 'bob', 'carla', 'diego', 'elena']);
  assert.ok(!a.history.some(h => h.key === 'shuffled'));
  a.cancel();
  const b = new Core.Engine({ now: clock.now, setT: clock.setT, clearT: clock.clearT });
  b.start(Array.from({ length: 30 }, (_, i) => ({ name: 'P' + i, key: 'p' + i, userId: 'id_p' + i })), { ...CFG, prizes: 2 });
  assert.ok(b.history.some(h => h.key === 'shuffled'));
  assert.notDeepEqual(b.participants.map(p => p.key), Array.from({ length: 30 }, (_, i) => 'p' + i));
  b.cancel();
});
