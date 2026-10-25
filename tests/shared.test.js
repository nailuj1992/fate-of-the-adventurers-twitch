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

// El bloque del adaptador (script en línea) va desde su marca hasta el cierre de su <script>; todo lo demás debe coincidir.
function withoutAdapter(html) {
  const a = html.indexOf('/* ---- Adaptador'), b = html.indexOf('</script>', a);
  assert.ok(a > 0 && b > a, 'bloque Adaptador presente');
  return html.slice(0, a) + html.slice(b);
}

for (const f of SHARED_FILES) {
  test('archivo compartido idéntico en ambos repositorios: ' + f, t => {
    if (!sibling) { assert.ok(!REQUIRED, MISSING); t.skip(MISSING); return; }
    assert.equal(read(sibling, f), read(ROOT, f));
  });
}

test('la interfaz es la misma en ambos repositorios salvo el bloque Adaptador', t => {
  if (!sibling) { assert.ok(!REQUIRED, MISSING); t.skip(MISSING); return; }
  const ours = read(ROOT, 'public', 'index.html'), theirs = read(sibling, 'index.html');
  assert.equal(withoutAdapter(theirs), withoutAdapter(ours));
});

test('cada versión declara su propio modo en el bloque Adaptador', t => {
  if (!sibling) { assert.ok(!REQUIRED, MISSING); t.skip(MISSING); return; }
  assert.match(read(ROOT, 'public', 'index.html'), /const MODE = 'twitch'/);
  assert.match(read(sibling, 'index.html'), /const MODE = 'manual'/);
});
