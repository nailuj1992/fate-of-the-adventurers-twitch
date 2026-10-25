'use strict';
// Pruebas del envoltorio de Twitch con el flujo AUTOMÁTICO real y tiempos muy cortos (segundos fraccionarios).
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { Game } = require('../game');
const Core = require('../core');

class FakeTwitch extends EventEmitter {
  constructor() { super(); this.status = 'connected'; this.reason = ''; }
  snapshot() { return { configured: true, authenticated: true, status: this.status, reason: this.reason, user: 'streamer', channel: 'streamer' }; }
  setStatus(s) { this.status = s; this.emit('status', this.snapshot()); }
  async resolveLogins(logins) {
    const m = new Map();
    for (const l of logins) if (!l.toLowerCase().startsWith('nope')) m.set(l.toLowerCase(), { id: 'id_' + l.toLowerCase(), login: l.toLowerCase(), displayName: l[0].toUpperCase() + l.slice(1) });
    return m;
  }
}
let n = 0;
const chat = (g, name, id, extra = {}) => g.handleChat({ messageId: id || 'm' + (++n), chatterId: 'id_' + name.toLowerCase(), chatterLogin: name.toLowerCase(), text: 'hola', receivedAt: Date.now(), ...extra });

// Tiempos rápidos (en segundos). Cada ronda tarda ~60 ms.
const FAST = { prizes: 3, confirmSec: 0.12, countdownSec: 0.005, rollSec: 0.005, revealSec: 0.01, winnerSec: 0.01, absentSec: 0.01,
  transitionSec: 0.01, introSec: 0.01, lateSec: 0.03, graceSec: 0.1 };
const NAMES = ['ana', 'bob', 'carla', 'diego', 'elena', 'fran', 'gus', 'hugo', 'ivan', 'jose', 'kike', 'luis'];
const first = () => 0;                         // extracción determinista: siempre el primer elegible
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 4000) { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout esperando condición'); await sleep(2); } }
async function setup(opts = {}) {
  const { names = NAMES.slice(0, 5), pick, config = {} } = opts;
  const tw = new FakeTwitch(), g = new Game({ twitch: tw, config: { ...FAST, ...config }, unsafeConfig: true, ...(pick ? { pick } : {}) });
  const r = await g.start(names); assert.equal(r.ok, true, r.error);
  return { tw, g };
}
const cel = g => g.publicState().celestial.name;
const names = (g, round) => g.eligible(round).map(p => p.name);
// El candidato ya es visible y se está esperando su mensaje (el plazo de 120 s está corriendo).
async function reveal(g) { await until(() => g.status === 'confirming' && g.cur && !g.cur.settled && !g.cur.grace); return g.cur.name; }
async function winOne(g) { const c = await reveal(g); chat(g, c); assert.equal(g.status, 'won'); return c; }
async function absentOne(g) { const c = await reveal(g); await until(() => g.status === 'absent' || g.status === 'deserted'); return c; }
// Todos los elegibles de la ronda en curso dejan vencer el plazo → ronda desierta.
async function desertRound(g) { const r = g.round; while (g.status !== 'deserted') await absentOne(g); assert.equal(g.round, r); }
const prizes = g => g.publicState().prizeStates.map(p => p.winner ? p.winner + (p.via === 'xuen' ? '*' : '') : p.state);

/* ===================== Rotación de Celestiales ===================== */
async function playAll(g, count) {                         // gana siempre el primero que sale; devuelve el Celestial de cada ronda
  const seq = [];
  for (let i = 0; i < count; i++) { await reveal(g); seq.push(cel(g)); chat(g, g.cur.name); }
  await until(() => g.screen === 'final'); return seq;
}
test('1 premio: únicamente Niuzao, sin Xuen', async () => {
  const { g } = await setup({ pick: first, config: { prizes: 1 } });
  assert.deepEqual(await playAll(g, 1), ['Niuzao']); assert.equal(g.final, 'complete');
});
test("3 premios: Niuzao, Yu'lon y Chi-ji", async () => {
  const { g } = await setup({ pick: first });
  assert.deepEqual(await playAll(g, 3), ['Niuzao', "Yu'lon", 'Chi-ji']);
});
test("5 premios: Niuzao, Yu'lon, Chi-ji, Niuzao y Yu'lon", async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 6), config: { prizes: 5 } });
  assert.deepEqual(await playAll(g, 5), ['Niuzao', "Yu'lon", 'Chi-ji', 'Niuzao', "Yu'lon"]);
});
test('10 premios: rotación circular correcta', async () => {
  const { g } = await setup({ pick: first, names: NAMES, config: { prizes: 10 } });
  const seq = await playAll(g, 10);
  assert.deepEqual(seq, ['Niuzao', "Yu'lon", 'Chi-ji', 'Niuzao', "Yu'lon", 'Chi-ji', 'Niuzao', "Yu'lon", 'Chi-ji', 'Niuzao']);
  assert.equal(g.final, 'complete'); assert.equal(new Set(g.winners.map(w => w.name)).size, 10, 'cada premio, un ganador distinto');
});

/* ===================== Ausencias: mismo Celestial, exclusión por ronda ===================== */
test('una ausencia NO cambia el Celestial ni avanza la rotación', async () => {
  const { g } = await setup({ pick: first });
  await reveal(g); assert.equal(cel(g), 'Niuzao'); assert.equal(g.round, 0);
  await absentOne(g);
  assert.equal(await reveal(g) !== null, true);
  assert.equal(cel(g), 'Niuzao', 'el reemplazo sigue siendo bajo Niuzao'); assert.equal(g.round, 0);
  assert.equal(g.publicState().prize, 1);
});
test('ausente en una ronda de Niuzao puede participar en una ronda posterior también de Niuzao (premio 4)', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 5), config: { prizes: 4 } });
  assert.equal(await absentOne(g), 'Ana');                 // premio 1 (Niuzao): Ana ausente
  assert.equal(await winOne(g), 'Bob');
  assert.equal(await absentOne(g), 'Ana'); assert.equal(await winOne(g), 'Carla');     // premio 2 (Yu'lon)
  assert.equal(await absentOne(g), 'Ana'); assert.equal(await winOne(g), 'Diego');     // premio 3 (Chi-ji)
  const c = await reveal(g);                                // premio 4: otra vez Niuzao
  assert.equal(g.round, 3); assert.equal(cel(g), 'Niuzao'); assert.equal(c, 'Ana', 'Ana, ausente en el premio 1 de Niuzao, vuelve a ser elegible');
  assert.deepEqual(g.absent.map(a => [a.name, a.round]), [['Ana', 0], ['Ana', 1], ['Ana', 2]]);
});
test('nadie es seleccionado dos veces dentro de la misma ronda', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 4) });
  const seen = []; for (let i = 0; i < 4; i++) seen.push(await absentOne(g));
  assert.deepEqual(seen, ['Ana', 'Bob', 'Carla', 'Diego']); assert.equal(g.status, 'deserted');
});
test('con extracción real tampoco se repite nadie dentro de una ronda y los ausentes vuelven en la siguiente', async () => {
  const { g } = await setup({ names: NAMES.slice(0, 5) });
  const seen = []; for (let i = 0; i < 4; i++) seen.push(await absentOne(g));
  assert.equal(new Set(seen).size, 4);
  const w = await winOne(g); assert.ok(!seen.includes(w));
  await until(() => g.round === 1);
  assert.equal(names(g).length, 4); assert.ok(seen.every(x => names(g).includes(x)));
});

/* ===================== Ganadores, descalificados ===================== */
test('un ganador confirmado no puede volver a ganar ni ser extraído', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 5) });
  const w = []; for (let i = 0; i < 3; i++) { w.push(await winOne(g)); if (i < 2) await until(() => g.round === i + 1); }
  assert.equal(new Set(w).size, 3); chat(g, w[0]); assert.equal(g.winners.length, 3);
  await until(() => g.screen === 'final'); assert.equal(g.final, 'complete');
});
test('descalificación global: exige motivo, excluye de todas las rondas (Xuen incluida) y se registra', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 5) });
  assert.equal(await reveal(g), 'Ana');
  assert.equal(g.disqualify('').ok, false); assert.equal(g.disqualify('  ').ok, false); assert.equal(g.status, 'confirming');
  assert.equal(g.disqualify('Usó varias cuentas').ok, true);
  assert.equal(g.outcome, 'disqualified'); assert.equal(g.absent.length, 0, 'no cuenta como ausencia');
  assert.ok(g.history.some(h => h.kind === 'dq' && /Ana/.test(h.text) && /Usó varias cuentas/.test(h.text)));
  assert.equal(await winOne(g), 'Bob'); await until(() => g.round === 1); assert.ok(!names(g).includes('Ana'));
  assert.equal(await winOne(g), 'Carla'); await until(() => g.round === 2); assert.ok(!names(g).includes('Ana'));
  assert.equal(await winOne(g), 'Diego'); await until(() => g.screen === 'final'); assert.ok(!g.winners.some(w => w.name === 'Ana'));
});

/* ===================== Rondas desiertas ===================== */
test('ronda desierta: el siguiente premio avanza al Celestial correspondiente', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 3) });
  await desertRound(g); assert.deepEqual(g.deserted, [0]);
  assert.ok(g.history.some(h => h.kind === 'des' && h.key === 'round_deserted' && h.params.celestial === 'Niuzao' && h.params.prize === 1));
  await until(() => g.round === 1);
  assert.equal(cel(g), "Yu'lon", 'tras la desierta de Niuzao sigue Yu\'lon'); assert.equal(g.winners.length, 0, 'el avance no depende de los ganadores');
  assert.deepEqual(names(g), ['Ana', 'Bob', 'Carla'], 'los ausentes de la ronda anterior vuelven a ser elegibles');
});
test('ronda desierta al entrar (nadie elegible): se declara sola', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 3) });
  await reveal(g); g.disqualify('Incumple las reglas');     // Ana fuera de todo
  await winOne(g); await until(() => g.round === 1);        // Bob gana el premio 1
  await winOne(g);                                          // Carla gana el premio 2; el premio 3 no tiene elegibles
  await until(() => g.deserted.includes(2), 2000);
  await until(() => g.round === 3 || g.screen === 'final', 2000);
});

/* ===================== Xuen: recuperación ===================== */
test('tres premios con ganador: Xuen NO se activa', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 4) });
  await playAll(g, 3); assert.equal(g.final, 'complete');
  assert.ok(!g.history.some(h => h.kind === 'xuen')); assert.equal(g.publicState().xuen.active, false);
});
test('premios pendientes activan Xuen; el ganador toma el premio pendiente y queda marcado como recuperado', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 3) });
  await desertRound(g);                                      // premio 1 (Niuzao) desierto
  assert.equal(await winOne(g), 'Ana'); await until(() => g.round === 2);   // premio 2: Ana
  assert.equal(await winOne(g), 'Bob');                      // premio 3: Bob
  await until(() => g.round === 3);                          // Xuen
  const v = g.publicState();
  assert.equal(v.celestial.name, 'Xuen'); assert.equal(v.xuen.active, true); assert.equal(v.xuen.total, 1); assert.equal(v.xuen.remaining, 1);
  assert.ok(g.history.some(h => h.kind === 'xuen' && h.key === 'xuen_activated' && h.params.list === '#1'));
  assert.equal(g.publicState().prizeStates[0].state, 'in_recovery');
  assert.deepEqual(names(g), ['Carla'], 'Carla estuvo ausente en la ronda 1 y sigue elegible; Ana y Bob ya ganaron');
  assert.equal(await winOne(g), 'Carla'); await until(() => g.screen === 'final');
  assert.equal(g.final, 'complete'); assert.deepEqual(prizes(g), ['Carla*', 'Ana', 'Bob']);
  const c = g.publicState().counts; assert.equal(c.prizesRecovered, 1); assert.equal(c.prizesDelivered, 2); assert.equal(c.prizesPending, 0);
});
test('varios premios pendientes: todos los intentos de recuperación se hacen bajo Xuen, en orden', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 4) });
  await desertRound(g); await until(() => g.round === 1); await desertRound(g); await until(() => g.round === 2);   // premios 1 y 2 desiertos
  assert.equal(await winOne(g), 'Ana'); await until(() => g.round === 3);                                          // premio 3
  assert.equal(g.publicState().xuen.total, 2);
  const used = [];
  for (let i = 0; i < 2; i++) { await reveal(g); used.push(cel(g) + '/' + g.round); chat(g, g.cur.name); if (i === 0) { await until(() => g.status === 'countdown'); } }
  assert.deepEqual(used, ['Xuen/3', 'Xuen/3'], 'sin alternar con los otros Celestiales');
  await until(() => g.screen === 'final'); assert.equal(g.final, 'complete'); assert.deepEqual(prizes(g), ['Bob*', 'Carla*', 'Ana']);
});
test('un ausente en Xuen no vuelve a ser seleccionado durante toda la recuperación', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 5) });
  await desertRound(g); await until(() => g.round === 1); await desertRound(g); await until(() => g.round === 2);
  assert.equal(await winOne(g), 'Ana'); await until(() => g.round === 3);                // Xuen con 2 premios
  assert.deepEqual(names(g), ['Bob', 'Carla', 'Diego', 'Elena']);
  assert.equal(await absentOne(g), 'Bob');
  assert.equal(await winOne(g), 'Carla'); await until(() => g.status === 'countdown');   // segundo intento
  assert.ok(!names(g).includes('Bob'), 'Bob sigue excluido en el 2.º premio de Xuen');
  assert.equal(await winOne(g), 'Diego'); await until(() => g.screen === 'final');
  assert.deepEqual(g.absent.filter(a => a.round === 3).map(a => a.name), ['Bob']);
});
test('agotamiento de candidatos en Xuen: premios sin adjudicar y evento incompleto', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 3) });
  await desertRound(g); await until(() => g.round === 1);
  assert.equal(await winOne(g), 'Ana'); await until(() => g.round === 2);
  assert.equal(await winOne(g), 'Bob'); await until(() => g.round === 3);
  assert.equal(await absentOne(g), 'Carla'); assert.equal(g.status, 'deserted');
  assert.ok(g.history.some(h => h.kind === 'des' && h.key === 'xuen_exhausted'));
  await until(() => g.screen === 'final'); assert.equal(g.final, 'incomplete');
  assert.deepEqual(prizes(g), ['unassigned', 'Ana', 'Bob']);
  assert.ok(g.history.some(h => h.kind === 'result' && h.key === 'result_open' && h.params.open === '#1'));
});
test('Xuen sin elegibles al activarse: se declara desierta y el evento termina incompleto', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 3) });
  await reveal(g); g.disqualify('Incumple las reglas');
  await winOne(g); await until(() => g.round === 1); await winOne(g);          // premio 3 sin elegibles
  await until(() => g.screen === 'final', 3000);
  assert.equal(g.final, 'incomplete'); assert.deepEqual(prizes(g).map(x => x.replace('*', '')), ['Bob', 'Carla', 'unassigned']);
});

/* ===================== Contadores, estados e historial ===================== */
test('contadores: eventos de ausencia y personas únicas ausentes son cosas distintas', async () => {
  const { g } = await setup({ pick: first });
  await absentOne(g); await winOne(g); await until(() => g.round === 1); await absentOne(g);   // Ana ausente dos veces
  const c = g.publicState().counts; assert.equal(c.absentEvents, 2); assert.equal(c.absentPeople, 1); assert.equal(c.winners, 1);
});
test('el historial identifica premio, Celestial y si fue en ronda principal o recuperación', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 3) });
  await desertRound(g); await until(() => g.round === 1); await winOne(g); await until(() => g.round === 2); await winOne(g);
  await until(() => g.round === 3); await winOne(g); await until(() => g.screen === 'final');
  const conf = g.history.filter(h => h.kind === 'conf');
  assert.deepEqual(conf.map(h => [h.prize, h.celestial, h.phase]), [[2, "Yu'lon", 'main'], [3, 'Chi-ji', 'main'], [1, 'Xuen', 'recovery']]);
  assert.ok(g.history.filter(h => h.kind === 'aus').every(h => h.prize === 1 && h.celestial === 'Niuzao' && h.phase === 'main'));
});
test('aviso cuando quedan menos personas que rondas pendientes', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 3) });
  assert.equal(g.publicState().notice, null);
  await reveal(g); g.disqualify('Incumple las reglas'); assert.equal(g.publicState().notice.key, 'notice.rounds'); assert.deepEqual(g.publicState().notice.params, { people: 2, count: 3 });
});

/* ===================== Seguridad de la confirmación por chat ===================== */
test('otros usuarios se ignoran; el elegido confirma; un mensaje anterior a la revelación no cuenta', async () => {
  const { g } = await setup({ pick: first });
  await until(() => g.status === 'reveal' || g.status === 'confirming');
  chat(g, 'Bob'); assert.notEqual(g.status, 'won');
  chat(g, g.cur.name, 'old', { receivedAt: g.cur.revealedAt - 1 }); assert.notEqual(g.status, 'won');
  chat(g, g.cur.name); assert.equal(g.status, 'won');
});
test('idempotencia: el mismo mensaje no se procesa dos veces', async () => {
  const { g } = await setup({ pick: first });
  const c = await reveal(g); chat(g, c, 'dup1'); chat(g, c, 'dup1');
  assert.equal(g.winners.length, 1); assert.equal(g.history.filter(h => h.kind === 'conf').length, 1);
});
test('carrera: confirmar a mano y luego vencer el temporizador no genera ausencia', async () => {
  const { g } = await setup({ pick: first });
  const c = await reveal(g); assert.equal(g.confirmManual().ok, true); chat(g, c); assert.equal(g.confirmManual().ok, false);
  await sleep(300);                                          // el evento sigue solo con la siguiente ronda; el primer ganador no se ve afectado
  assert.ok(!g.absent.some(a => a.name === c), 'el que confirmó no se registra como ausente'); assert.equal(g.winners.filter(w => w.name === c).length, 1);
});
test('el nombre del candidato no se publica antes de la revelación', async () => {
  const { g } = await setup({ pick: first });
  await until(() => g.status === 'rolling'); assert.equal(g.publicState().candidate, null);
  await until(() => g.status === 'reveal'); assert.equal(g.publicState().candidate, g.cur.name);
});

/* ===================== Caídas de conexión ===================== */
test('caída de conexión: no se declara ausente; al recuperar hay plazo extra y un mensaje confirma', async () => {
  const { tw, g } = await setup({ pick: first });
  const c = await reveal(g); tw.setStatus('reconnecting');
  await until(() => g.status === 'verifying'); assert.equal(g.absent.length, 0);
  await sleep(150); assert.equal(g.status, 'verifying');
  tw.setStatus('connected'); assert.equal(g.status, 'confirming'); assert.equal(g.cur.grace, true);
  chat(g, c); assert.equal(g.status, 'won'); assert.equal(g.winners[0].source, 'chat');
});
test('caída recuperada y plazo extra sin mensaje → ausente', async () => {
  const { tw, g } = await setup({ pick: first });
  await reveal(g); tw.setStatus('reconnecting'); await until(() => g.status === 'verifying');
  tw.setStatus('connected'); await until(() => g.status === 'absent'); assert.equal(g.absent.length, 1);
});

/* ===================== Configuración y ciclo de vida ===================== */
test('configuración bloqueada durante el evento; editable al terminar o antes de empezar', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 4), config: { prizes: 2 } });
  const before = JSON.stringify(g.config);
  const r = g.saveConfig({ prizes: 4 }); assert.equal(r.ok, false); assert.equal(r.errorKey, 'err.config_locked'); assert.equal(JSON.stringify(g.config), before);
  g.cancel(); assert.equal(g.saveConfig({ prizes: 1 }).ok, false, 'aún en la pantalla final sigue bloqueada');
  g.back(); assert.equal(g.saveConfig({ prizes: 1 }).ok, true); assert.equal(g.config.prizes, 1);
});
test('la configuración se valida contra los participantes al iniciar (premios ≤ participantes)', async () => {
  const tw = new FakeTwitch(), g = new Game({ twitch: tw, config: { prizes: 8 } });
  const r = await g.start(NAMES.slice(0, 5)); assert.equal(r.ok, false); assert.equal(r.errorKey, 'err.config_invalid'); assert.deepEqual(r.errors.prizes, { code: 'max_participants', count: 5 });
  const r2 = await g.start(NAMES.slice(0, 5), { prizes: 5 }); assert.equal(r2.ok, true); assert.equal(g.prizes, 5);
  assert.equal(g.config.prizes, 5, 'lo usado queda guardado');
  g.cancel();                                  // este evento usa los tiempos reales por defecto: no se deja corriendo
});
test('saveConfig rechaza valores inválidos con el detalle por campo', () => {
  const g = new Game({ twitch: new FakeTwitch() });
  const r = g.saveConfig({ confirmSec: -3, rollSec: 2.5, introSec: 'x', prizes: 0 });
  assert.equal(r.ok, false); assert.deepEqual(Object.keys(r.errors).sort(), ['confirmSec', 'introSec', 'prizes', 'rollSec']);
  assert.equal(g.config.confirmSec, 120);
});
test('reiniciar restaura el estado sin conservar exclusiones anteriores', async () => {
  const { g } = await setup({ pick: first, names: NAMES.slice(0, 5) });
  await reveal(g); g.disqualify('Incumple las reglas'); await absentOne(g); await winOne(g);
  assert.ok(g.disqualified.length && g.absent.length && g.winners.length);
  assert.equal(g.reset().ok, true);
  assert.equal(g.screen, 'admin'); assert.equal(g.status, 'idle');
  assert.deepEqual([g.winners.length, g.absent.length, g.disqualified.length, g.deserted.length], [0, 0, 0, 0]);
  const r = await g.start(NAMES.slice(0, 5)); assert.equal(r.ok, true);
  assert.equal(g.eligible().length, 5, 'todos vuelven a ser elegibles'); assert.equal(g.round, 0);
});
test('cancelar conserva el historial; volver al panel solo al terminar', async () => {
  const { g } = await setup({ pick: first });
  assert.equal(g.back().ok, false); const c = await reveal(g); chat(g, c);
  const len = g.history.length; g.cancel(); assert.equal(g.final, 'cancelled'); assert.equal(g.winners.length, 1); assert.ok(g.history.length >= len);
  assert.equal(g.back().ok, true); assert.equal(g.screen, 'admin');
});
test('validación al iniciar: inexistentes, formato, duplicados, mínimo y sin conexión', async () => {
  const tw = new FakeTwitch(); const g = new Game({ twitch: tw, config: FAST, unsafeConfig: true });
  assert.equal((await g.start(['ana', 'bob', 'carla', 'nope1'])).errorKey, 'err.unknown_users');
  assert.equal((await g.start(['ana', 'bob', 'c arla!'])).errorKey, 'err.invalid_logins');
  assert.equal((await g.start(['ana', 'BOB', 'bob'])).errorKey, 'err.duplicate_names');
  assert.equal((await g.start(['ana', 'bob'])).errors.prizes.code, 'max_participants');
  tw.status = 'reconnecting'; assert.equal((await g.start(NAMES.slice(0, 5))).errorKey, 'err.twitch_not_connected');
  assert.equal(g.screen, 'admin');
});
test('parseLogins: colapsa espacios, quita la @ y las líneas vacías; separa inválidos y repetidos sin distinguir mayúsculas', () => {
  const { parseLogins } = require('../game');
  const r = parseLogins(['  Ana  ', '@Bob', '', '   ', 'ana', 'a b', 'x'.repeat(26), 'Carla_9', 'BOB']);
  assert.deepEqual([...r.seen], [['ana', 'Ana'], ['bob', 'Bob'], ['carla_9', 'Carla_9']]);
  assert.deepEqual(r.bad, ['a b', 'x'.repeat(26)]);
  assert.deepEqual(r.dup, ['ana', 'BOB']);
  assert.deepEqual(parseLogins('no es una lista'), { seen: new Map(), bad: [], dup: [] });
});

test('doble inicio simultáneo: solo uno arranca', async () => {
  const tw = new FakeTwitch(), g = new Game({ twitch: tw, config: FAST, unsafeConfig: true });
  const [a, b] = await Promise.all([g.start(NAMES.slice(0, 4)), g.start(NAMES.slice(0, 4))]);
  assert.equal([a, b].filter(r => r.ok).length, 1);
});
test('secureIndex es uniforme (sin sesgo apreciable)', () => {
  const k = 6, N = 60000, counts = Array(k).fill(0);
  for (let i = 0; i < N; i++) counts[Core.secureIndex(k)]++;
  const exp = N / k, chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
  assert.ok(chi < 20.5, `chi² = ${chi.toFixed(1)} (gl=5, p>0.001)`);
});

// ---- datos por streamer ----
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { StreamerStore } = require('../store');
function withStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'game-')), store = new StreamerStore(root), tw = new FakeTwitch();
  const g = new Game({ twitch: tw, store, unsafeConfig: true });
  const login = (id, login) => tw.emit('identity', id ? { id, login } : null);
  return { g, tw, store, login };
}

test('cada streamer tiene su propia configuración y al cambiar de cuenta se carga la suya', () => {
  const { g, store, login } = withStore();
  login('111', 'ana'); assert.equal(g.saveConfig({ ...FAST, prizes: 2 }).ok, true);
  login('222', 'bob'); assert.equal(g.config.prizes, Core.DEFAULT_CONFIG.prizes, 'bob no hereda la de ana');
  assert.equal(g.saveConfig({ ...FAST, prizes: 4 }).ok, true);
  login('111', 'ana'); assert.equal(g.config.prizes, 2);
  assert.equal(store.loadConfig('222').prizes, 4);
});

test('con un evento en marcha, un cambio de identidad no toca la configuración ni el dueño', async () => {
  const { g, tw, login } = withStore();
  login('111', 'ana'); g.saveConfig({ ...FAST, prizes: 2 });
  assert.equal((await g.start(NAMES.slice(0, 5))).ok, true);
  login('222', 'bob');
  assert.equal(g.owner, '111'); assert.equal(g.config.prizes, 2);
  g.cancel(); tw.removeAllListeners();
});

test('al iniciar sesión el primer streamer hereda la configuración antigua (migración explícita en Game.setOwner)', () => {
  const { g, store, login } = withStore();
  fs.writeFileSync(path.join(store.root, 'config.json'), JSON.stringify({ prizes: 4 }));
  login('111', 'ana');
  assert.equal(g.config.prizes, 4);
  assert.ok(fs.existsSync(path.join(store.root, 'config.json.migrated')));
  login('111', 'ana'); login(null);
  login('222', 'bob');
  assert.equal(g.config.prizes, 3, 'el segundo streamer parte de los valores por defecto');
});

test('el historial se escribe en la carpeta del streamer dueño del evento', async () => {
  const { g, store, login } = withStore();
  login('111', 'ana'); g.saveConfig({ ...FAST, prizes: 1 });
  assert.equal((await g.start(NAMES.slice(0, 3))).ok, true);
  await until(() => g.status === 'confirming' && g.cur && !g.cur.settled && !g.cur.grace);
  g.cancel();
  assert.ok(fs.existsSync(store.historyFile('111')));
  assert.ok(!fs.existsSync(store.historyFile('222')));
});

test('si tras las ausencias queda un solo elegible, se salta la cuenta atrás y el roll y pasa directo a la revelación', async () => {
  const { g } = await setup({ names: ['ana', 'bob', 'carla'], pick: first, config: { prizes: 1 } });
  const seq = []; g.on('change', () => { if (seq[seq.length - 1] !== g.status) seq.push(g.status); });
  assert.equal(await absentOne(g), 'Ana');
  assert.equal(await absentOne(g), 'Bob', 'con dos elegibles se sortea con normalidad');
  await until(() => g.status === 'reveal' && g.cur && g.cur.name === 'Carla');
  const afterLastAbsent = seq.slice(seq.lastIndexOf('absent') + 1);
  assert.ok(!afterLastAbsent.includes('countdown') && !afterLastAbsent.includes('rolling'), 'sin cuenta atrás ni roll: ' + afterLastAbsent);
  assert.ok(g.history.some(h => h.key === 'last_candidate'), 'queda anotado en el historial');
  await until(() => g.status === 'confirming'); chat(g, 'carla'); assert.equal(g.status, 'won');   // sigue siendo candidata: debe confirmar presencia
  g.cancel();
});

test('con un solo elegible en una ronda (aunque no sea un reemplazo) se salta la cuenta atrás y el roll', async () => {
  const { g } = await setup({ names: ['ana', 'bob'], pick: first, config: { prizes: 2 } });
  const seq = []; g.on('change', () => { if (seq[seq.length - 1] !== g.status) seq.push(g.status); });
  assert.equal(await winOne(g), 'Ana');
  await until(() => g.status === 'reveal' && g.cur && g.cur.name === 'Bob');
  const afterWon = seq.slice(seq.lastIndexOf('won') + 1);
  assert.ok(!afterWon.includes('countdown') && !afterWon.includes('rolling'), 'sin cuenta atrás ni roll: ' + afterWon);
  g.cancel();
});
