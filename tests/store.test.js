'use strict';
// Datos por streamer: cada ID de Twitch tiene su carpeta; no hay colisiones ni escapes de ruta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StreamerStore } = require('../store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));

test('cada streamer guarda y lee su propia configuración', () => {
  const s = new StreamerStore(tmp());
  s.saveConfig('111', { prizes: 2 }); s.saveConfig('222', { prizes: 5 });
  assert.deepEqual(s.loadConfig('111'), { prizes: 2 });
  assert.deepEqual(s.loadConfig('222'), { prizes: 5 });
  assert.deepEqual(s.loadConfig('333'), {}, 'un streamer nuevo parte de cero, nunca hereda la de otro');
  assert.notEqual(s.historyFile('111'), s.historyFile('222'));
});

test('un ID que no es numérico se rechaza (no puede salirse de data/)', () => {
  const s = new StreamerStore(tmp());
  for (const bad of ['../x', '1/2', '', 'abc', '1'.repeat(21), null]) assert.throws(() => s.dir(bad), /Invalid Twitch user id/);
});

test('configuración dañada: se ignora y se usan los valores por defecto', () => {
  const s = new StreamerStore(tmp());
  fs.mkdirSync(s.dir('9'), { recursive: true }); fs.writeFileSync(s.configFile('9'), '{no es json');
  assert.deepEqual(s.loadConfig('9'), {});
});

test('historial: cada línea es un JSON; el de un streamer no toca al de otro; un ID inválido no escribe nada', () => {
  const root = tmp(), s = new StreamerStore(root);
  s.appendHistory('111', { event: 'e1', id: 1 }); s.appendHistory('111', { event: 'e1', id: 2 }); s.appendHistory('222', { event: 'e2', id: 1 });
  assert.deepEqual(fs.readFileSync(s.historyFile('111'), 'utf8').trim().split('\n').map(JSON.parse), [{ event: 'e1', id: 1 }, { event: 'e1', id: 2 }]);
  assert.equal(fs.readFileSync(s.historyFile('222'), 'utf8'), '{"event":"e2","id":1}\n');
  assert.throws(() => s.appendHistory('../x', {}), /Invalid Twitch user id/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'streamers')).sort(), ['111', '222']);
});

test('streamers guardados: solo carpetas con ID numérico; fecha de tokens solo si existen', () => {
  const root = tmp(), s = new StreamerStore(root);
  assert.deepEqual(s.savedStreamerIds(), [], 'sin carpeta data/streamers no falla');
  for (const name of ['111', '222', 'abc', '../x']) fs.mkdirSync(path.join(root, 'streamers', name.replace(/\.\.\//, '')), { recursive: true });
  fs.writeFileSync(s.tokenFile('111'), '{}');
  assert.deepEqual(s.savedStreamerIds().sort(), ['111', '222']);
  assert.equal(typeof s.tokenMtime('111'), 'number'); assert.equal(s.tokenMtime('222'), null);
});

test('migración: los archivos antiguos los hereda solo el primer streamer', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ prizes: 4 }));
  fs.writeFileSync(path.join(root, 'historial.jsonl'), '{"event":1}\n');
  const s = new StreamerStore(root);
  assert.deepEqual(s.loadConfig('111'), { prizes: 4 });
  assert.equal(fs.readFileSync(s.historyFile('111'), 'utf8'), '{"event":1}\n');
  assert.ok(fs.existsSync(path.join(root, 'config.json.migrated')) && !fs.existsSync(path.join(root, 'config.json')));
  assert.deepEqual(s.loadConfig('222'), {}, 'el segundo streamer no recibe los datos del primero');
});
