'use strict';
// Runs the real searchMatches, which the map panel and the phone's search
// view share, out of the app modules.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('./app-source');
function fn(name) {
  const m = new RegExp(`^(function ${name}\\([\\s\\S]*?^\\})$`, 'm').exec(app);
  assert.ok(m, `${name} not found in app/`);
  return m[1];
}

function search(q, { state, places = true }) {
  const ctx = { state, placesEnabled: () => places };
  vm.createContext(ctx);
  vm.runInContext(`${fn('searchMatches')}\nglobalThis.__r = searchMatches(${JSON.stringify(q)});`, ctx);
  return ctx.__r;
}

const state = {
  places: [
    { name: 'Preikestolen', category: 'viewpoint', country: 'Norway' },
    { name: 'Kjeragbolten', category: 'viewpoint', country: 'Norway', note: 'Boulder above the fjord' },
    { name: 'Louvre', category: 'museum', country: 'France' },
  ],
  areas: [{ id: 'a1', name: 'Hardangervidda', local_name: 'Vidda', category: 'park' }],
  manifest: { regions: [
    { name: 'Rogaland', routes: [{ key: 'r1', name: 'Coast path' }, { key: 'r2', name: 'Ridge walk' }] },
    { name: 'Alps', routes: [{ key: 'r3', name: 'Fjord view' }] },
  ] },
};

test('matches a place on its note, country and category, ignoring case', () => {
  assert.deepEqual(search('FJORD', { state }).places.map(p => p.name), ['Kjeragbolten']);
  assert.deepEqual(search('norway', { state }).places.map(p => p.name), ['Preikestolen', 'Kjeragbolten']);
  assert.deepEqual(search('museum', { state }).places.map(p => p.name), ['Louvre']);
});

test('a region name brings in every route in it', () => {
  const r = search('rogaland', { state });
  assert.deepEqual(r.routes.map(t => t.route.key), ['r1', 'r2']);
  assert.equal(r.routes[0].region, 'Rogaland');
});

test('an area matches on its local name, and only while places are on', () => {
  assert.deepEqual(search('vidda', { state }).areas.map(a => a.id), ['a1']);
  assert.equal(search('vidda', { state, places: false }).areas.length, 0);
});

test('each kind stops at six', () => {
  const many = { ...state, places: Array.from({ length: 9 }, (_, i) => ({ name: 'Bay ' + i, category: 'beach' })) };
  assert.equal(search('bay', { state: many }).places.length, 6);
});

test('a map with no data loaded matches nothing', () => {
  const r = search('x', { state: {} });
  assert.deepEqual([r.places.length, r.areas.length, r.routes.length], [0, 0, 0]);
});
