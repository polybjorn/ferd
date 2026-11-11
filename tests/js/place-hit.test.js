'use strict';
// Runs the place layer's hit test straight out of the app modules, since the
// layer itself needs a real map.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('./app-source');
/** @param {string} name */
function functionSource(name) {
  const fn = new RegExp('\\nfunction ' + name + '\\([^\\n]*\\n[\\s\\S]*?\\n\\}\\n').exec(app)
    || new RegExp('\\nfunction ' + name + '\\(.*\\}\\n').exec(app);
  assert.ok(fn, name + ' not found in app/');
  return fn[0];
}
const halo = /\nconst MARK_HALO = ([\d.]+);/.exec(app);
assert.ok(halo, 'MARK_HALO not found in app/');

const env = { HALO: Number(halo[1]) };
vm.createContext(env);
vm.runInContext(['placeMarkerRadius', 'clusterDiscRadius', 'markCovers', 'clustersOnTop', 'pickMark']
  .map(functionSource).join('\n') + '\nglobalThis.f = { clustersOnTop, pickMark };', env);
const { clustersOnTop, pickMark } = env.f;

const group = { properties: { cluster: true, point_count: 5 }, at: { x: 100, y: 100 } };
const pin = { properties: { place: {} }, at: { x: 122, y: 100 } };
const at = (/** @type {any} */ f) => f.at;
const pick = (/** @type {any[]} */ features, /** @type {number} */ x, /** @type {number} */ y, style = 'ring') =>
  pickMark(clustersOnTop(features), at, { x, y }, 18, style, 14);

test('a tap where a place peeks out under a group opens the group', () => {
  assert.equal(pick([group, pin], 114, 100), group);
  assert.equal(pick([pin, group], 114, 100), group);
});

test('a tap on the part of a place outside the group opens the place', () => {
  assert.equal(pick([group, pin], 129, 100), pin);
});

test('a tap just outside every mark goes to the nearest one in reach', () => {
  assert.equal(pick([group, pin], 100, 119), group);
  assert.equal(pick([group, pin], 100, 140), null);
});

test('a tap on a tag flag counts though its point is out of reach', () => {
  const tag = { properties: { place: {} }, at: { x: 200, y: 200 } };
  assert.equal(pick([tag], 216, 204, 'tag'), tag);
});
