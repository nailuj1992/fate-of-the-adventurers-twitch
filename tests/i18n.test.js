'use strict';
// Pruebas de internacionalización: inglés por defecto, paridad EN/ES, cobertura de claves y comportamiento del módulo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../i18n');
const Core = require('../core');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const readDir = dir => fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js')).map(f => read(dir, f)).join('\n');
const SIB = ['fate-of-the-adventurers-manual', 'Idea 2 - Manual'].find(n => fs.existsSync(path.join(ROOT, '..', n)));   // repo hermano, si está clonado al lado
const MANUAL = path.join(ROOT, '..', SIB || 'fate-of-the-adventurers-manual', 'index.html');
const params = s => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();
const en = I18n.catalogs.en, es = I18n.catalogs.es;

test('el idioma por defecto es inglés y no depende del navegador', () => {
  assert.equal(I18n.DEFAULT, 'en'); assert.equal(I18n.locale, 'en');
  assert.deepEqual(I18n.SUPPORTED, ['en', 'es']);
  for (const f of ['i18n.js', 'core.js', 'public/index.html']) assert.ok(!/navigator\.language/.test(read(f)), f + ' no debe usar el idioma del navegador');
  assert.match(read('public/index.html'), /<html lang="en">/);
});

test('inglés y español tienen exactamente las mismas claves', () => {
  const miss = (a, b) => Object.keys(a).filter(k => !(k in b));
  assert.deepEqual(miss(en, es), [], 'faltan en es.js'); assert.deepEqual(miss(es, en), [], 'faltan en en.js');
});

test('cada clave tiene los mismos {parámetros} en ambos idiomas y ningún texto está vacío', () => {
  for (const k of Object.keys(en)) {
    assert.ok(en[k].trim() && es[k].trim(), 'texto vacío en ' + k);
    assert.deepEqual(params(en[k]), params(es[k]), 'parámetros distintos en ' + k);
  }
});

test('el español usa ortografía correcta en los catálogos (sin «n» donde va «ñ» en palabras habituales)', () => {
  const all = Object.values(es).join(' ');
  for (const bad of [/\bcontrasena\b/i, /\banos?\b/i, /\bsesion\b/i, /\bconfiguracion\b/i, /\bdescalificacion\b/i, /\bautorizacion\b/i, /\bconexion\b/i])
    assert.ok(!bad.test(all), 'palabra sin tilde: ' + bad);
});

test('respaldo: clave inexistente en el idioma activo → inglés → la propia clave', () => {
  assert.equal(I18n.tIn('es', 'stage.btn.confirm'), 'Confirmar presencia');
  assert.equal(I18n.tIn('xx', 'stage.btn.confirm'), 'Confirm presence', 'idioma no soportado → inglés');
  assert.equal(I18n.tIn('es', 'no.existe.esta.clave'), 'no.existe.esta.clave');
});
test('parámetros, plural y fragmentos traducibles ({ $t })', () => {
  assert.equal(I18n.tIn('en', 'ops.people', { count: 1 }), '1 person'); assert.equal(I18n.tIn('en', 'ops.people', { count: 4 }), '4 people');
  assert.equal(I18n.tIn('es', 'ops.people', { count: 1 }), '1 persona'); assert.equal(I18n.tIn('es', 'ops.people', { count: 0 }), '0 personas');
  assert.match(I18n.tIn('es', 'log.won_main', { prize: 2, celestial: "Yu'lon", name: 'Ana', via: { $t: 'log.via.chat' } }), /\(mensaje en el chat\)/);
  assert.match(I18n.tIn('en', 'log.won_main', { prize: 2, celestial: "Yu'lon", name: 'Ana', via: { $t: 'log.via.chat' } }), /\(chat message\)/);
  assert.equal(I18n.tIn('en', 'story.niuzao.victory', { name: 'Ana' }).includes('Ana'), true);
});
test('setLocale cambia el idioma, avisa a los oyentes y vuelve al inglés ante un valor no soportado', () => {
  const seen = []; I18n.onChange(l => seen.push(l));
  I18n.setLocale('es'); assert.equal(I18n.t('stage.btn.skip'), 'Saltar espera');
  I18n.setLocale('fr'); assert.equal(I18n.locale, 'en'); assert.equal(I18n.t('stage.btn.skip'), 'Skip wait');
  assert.deepEqual(seen, ['es', 'en']);
});
test('las páginas del servidor eligen idioma por cookie (inglés si no hay)', () => {
  assert.equal(I18n.fromCookie(''), 'en'); assert.equal(I18n.fromCookie('x=1; celestiales_lang=es'), 'es'); assert.equal(I18n.fromCookie('celestiales_lang=fr'), 'en');
});

/* ---------- cobertura: toda clave usada en el código existe en el catálogo ---------- */
const KEY_LITERAL = /'((?:app|admin|cfg|stage|notice|ops|final|modal|twitch|toast|boot|story|celestial|phase|log|err|srv)\.[A-Za-z_.]*[A-Za-z_])'/g;
const keysIn = src => [...src.matchAll(KEY_LITERAL)].map(m => m[1]);

test('todas las claves usadas por la interfaz (Twitch y manual) existen en el catálogo', () => {
  for (const file of [path.join(ROOT, 'public', 'index.html'), MANUAL]) {
    if (!fs.existsSync(file)) continue;
    // La página son el HTML, los scripts compartidos de ui/ y el adaptador de cada versión.
    const adapter = path.join(path.dirname(file), 'adapter.js');           // junto a su index.html
    const html = fs.readFileSync(file, 'utf8') + '\n' + readDir('ui') + '\n' + fs.readFileSync(adapter, 'utf8');
    const used = new Set(keysIn(html));
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
    for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) m[1].split(';').forEach(p => used.add(p.split(':')[1]));
    for (const k of used) assert.ok(k in en, `clave usada y no definida: ${k} (${path.basename(file)})`);
    assert.ok(used.size > 60, 'se esperaba encontrar muchas claves, hay ' + used.size);
  }
});
test('claves del motor, errores y servidor: las usadas existen y las del catálogo se usan', () => {
  const core = read('core.js'), game = read('game.js'), server = read('server.js') + '\n' + readDir('server');
  const used = new Set([...keysIn(core), ...keysIn(game), ...keysIn(server)]);
  for (const m of core.matchAll(/this\.log\('[a-z]+',\s*'([a-z_]+)'/g)) used.add('log.' + m[1]);
  for (const m of (core + game).matchAll(/\berr\('([a-z_]+)'/g)) used.add('err.' + m[1]);
  for (const m of server.matchAll(/HttpError\(\d+,\s*'([a-z_]+)'/g)) used.add('err.' + m[1]);   // errores de la API HTTP
  used.add('err.generic');                                                                      // 500 genérico (fail(res, 500, 'generic'))
  for (const k of used) assert.ok(k in en, 'clave usada y no definida: ' + k);
  // claves de log.* que el motor referencia entre comillas (también dentro de condicionales); _repl se compone
  for (const k of Object.keys(en).filter(k => k.startsWith('log.') && !k.startsWith('log.via.'))) {
    const short = k.slice(4).replace(/_repl$/, '');
    assert.ok(core.includes(`'${short}'`), 'clave del catálogo sin usar en core.js: ' + k);
  }
  for (const k of Object.keys(en).filter(k => k.startsWith('err.') && k !== 'err.generic' && k !== 'err.config_locked'))
    assert.ok((core + game + server).includes(`'${k.slice(4)}'`), 'error del catálogo sin usar: ' + k);
});
test('familias dinámicas completas: opciones de configuración, errores de campo, estados de Twitch y fases', () => {
  for (const k of Core.CONFIG_KEYS) for (const f of ['cfg.label.', 'cfg.help.']) assert.ok((f + k) in en && (f + k) in es, f + k);
  for (const c of ['number', 'integer', 'range', 'max_participants']) assert.ok(('cfg.err.' + c) in en);
  const tw = read('twitch.js') + '\n' + readDir('twitch');   // los códigos de estado se emiten desde la fachada y desde twitch/*.js
  const codes = new Set([...tw.matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]));
  for (const m of tw.matchAll(/setStatus\('(?:connected|disconnected|reconnecting)',\s*'([a-z_]+)'/g)) codes.add(m[1]);
  for (const m of tw.matchAll(/invalidateTokens\('([a-z_]+)'\)/g)) codes.add(m[1]);
  for (const c of codes) assert.ok(('twitch.reason.' + c) in en, 'motivo de estado de Twitch sin traducir: ' + c);
  for (const p of ['intro', 'countdown', 'rolling', 'reveal', 'confirming', 'grace', 'closing', 'won', 'absent', 'transition', 'deserted']) assert.ok(('phase.' + p) in en, 'phase.' + p);
  for (const c of ['niuzao', 'yulon', 'chiji', 'xuen']) for (const f of ['title', 'intro', 'victory']) assert.ok((`story.${c}.${f}`) in en);
  assert.deepEqual([en['celestial.niuzao.long'], en['celestial.yulon.long'], en['celestial.chiji.long'], en['celestial.xuen.long']],
    ['Niuzao, the Black Ox', "Yu'lon, the Jade Serpent", 'Chi-ji, the Red Crane', 'Xuen, the White Tiger']);
  assert.deepEqual([es['celestial.niuzao.long'], es['celestial.yulon.long'], es['celestial.chiji.long'], es['celestial.xuen.long']],
    ['Niuzao, el Buey Negro', "Yu'lon, el Dragón de Jade", 'Chi-ji, la Grulla Roja', 'Xuen, el Tigre Blanco']);
});

/* ---------- el motor produce claves + parámetros y texto en inglés para el archivo de historial ---------- */
test('el historial del motor lleva clave, parámetros y texto en inglés', () => {
  const e = new Core.Engine({ pick: () => 0 });
  e.start([{ name: 'Ana', key: 'ana' }, { name: 'Bob', key: 'bob' }, { name: 'Carla', key: 'carla' }], { ...Core.DEFAULT_CONFIG, prizes: 3 });
  const h = e.history[0];
  assert.equal(h.key, 'event_started'); assert.equal(h.params.prizes, 3);
  assert.match(h.text, /^Event started: 3 prize\(s\), 3 participants/);
  const r = e.disqualify('x'); assert.equal(r.ok, false); assert.equal(r.errorKey, 'err.reason_required'); assert.match(r.error, /reason/i);
  e.clearPhase();
});
