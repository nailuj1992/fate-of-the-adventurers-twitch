'use strict';
// Paridad con el repositorio hermano (fate-of-the-adventurers-manual): los archivos compartidos son idénticos byte a byte y las dos
// páginas son la misma interfaz salvo el bloque «Adaptador». Si el hermano no está clonado al lado, las pruebas se marcan como OMITIDAS
// (visible en el informe); con REQUIRE_SIBLING=1 (CI) su ausencia es un FALLO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHARED_FILES = ['core.js', 'i18n.js', 'locales/en.js', 'locales/es.js', 'css/app.css',
  ...['util', 'state', 'admin', 'stage', 'fx', 'main'].map(n => `ui/${n}.js`)];
const SIBLING_NAMES = ['fate-of-the-adventurers-manual', 'Idea 2 - Manual'];
const sibling = SIBLING_NAMES.map(n => path.join(ROOT, '..', n)).find(p => fs.existsSync(p));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const MISSING = 'repositorio manual no encontrado junto a este';
const REQUIRED = process.env.REQUIRE_SIBLING === '1';


for (const f of SHARED_FILES) {
  test('archivo compartido idéntico en ambos repositorios: ' + f, t => {
    if (!sibling) { assert.ok(!REQUIRED, MISSING); t.skip(MISSING); return; }
    assert.equal(read(sibling, f), read(ROOT, f));
  });
}

test('la página es idéntica en ambos repositorios (la única diferencia está en adapter.js)', t => {
  if (!sibling) { assert.ok(!REQUIRED, MISSING); t.skip(MISSING); return; }
  assert.equal(read(sibling, 'index.html'), read(ROOT, 'public', 'index.html'));
});

test('cada versión tiene su propio adapter.js y declara su nombre y capacidades', t => {
  if (!sibling) { assert.ok(!REQUIRED, MISSING); t.skip(MISSING); return; }
  const ours = read(ROOT, 'public', 'adapter.js'), theirs = read(sibling, 'adapter.js');
  assert.notEqual(ours, theirs);
  assert.match(ours, /const ADAPTER = \{ name: 'twitch', twitchNames: true, helpSuffix: '' \};/);
  assert.match(theirs, /const ADAPTER = \{ name: 'manual', twitchNames: false, helpSuffix: '_manual' \};/);
  for (const src of [ours, theirs]) { assert.match(src, /\bfunction boot\(\)/); assert.match(src, /\b(async )?function api\(/); }
});
