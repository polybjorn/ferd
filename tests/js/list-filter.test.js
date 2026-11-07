'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('./app-source.js');

/** @param {string} name */
function block(name) {
  const m = source.match(new RegExp('// ' + name + '-BEGIN[^\\n]*\\n([\\s\\S]*?)// ' + name + '-END'));
  assert.ok(m, name + ' block exists');
  return m[1];
}
const tagsIncludeAll = (tags, wants) => wants.every(w => (tags || []).includes(w));
const ctx = vm.createContext({ tagsIncludeAll });
vm.runInContext(block('PLACE-LIST') + block('ROUTE-LIST') + ';this.placeMatches = placeMatches; this.routeMatches = routeMatches;', ctx);

const all = { search: '', status: 'all', category: 'all', country: 'all', catalog: 'all', tags: [] };
const place = { name: 'Kjerag', note: 'Boulder', category: 'hike', country: 'Norway', tags: ['wild'], visited: true };

test('a place matches the search on name, note, category, country or tag', () => {
  for (const q of ['kjer', 'boulder', 'HIKE', 'norw', 'wild']) assert.ok(ctx.placeMatches(place, { ...all, search: q }, () => false), q);
  assert.ok(!ctx.placeMatches(place, { ...all, search: 'sweden' }, () => false));
});

test('place filters narrow by status, category, country, catalog and tags', () => {
  assert.ok(!ctx.placeMatches(place, { ...all, status: 'want' }, () => false));
  assert.ok(!ctx.placeMatches(place, { ...all, category: 'food' }, () => false));
  assert.ok(!ctx.placeMatches(place, { ...all, country: 'Sweden' }, () => false));
  assert.ok(!ctx.placeMatches(place, { ...all, tags: ['wild', 'cold'] }, () => false));
  assert.ok(!ctx.placeMatches(place, { ...all, catalog: 'from-catalog' }, () => false));
  assert.ok(ctx.placeMatches({ ...place, from_catalog: 'x' }, { ...all, catalog: 'updates-available' }, () => true));
});

const rall = { search: '', status: 'all', region: 'all', difficulty: 'all', rating: 'all', tags: [] };
const entry = { route: { name: 'Pulpit', completed: true, difficulty: 'hard', rating: 4, tags: [] }, region: 'Rogaland' };

test('a route matches the search on name or region, and the region filter is lowercased', () => {
  assert.ok(ctx.routeMatches(entry, { ...rall, search: 'rogal' }));
  assert.ok(!ctx.routeMatches(entry, { ...rall, search: 'oslo' }));
  assert.ok(ctx.routeMatches(entry, { ...rall, region: 'rogaland' }));
  assert.ok(!ctx.routeMatches(entry, { ...rall, region: 'oslo' }));
});

test('route filters narrow by status, difficulty and rating', () => {
  assert.ok(!ctx.routeMatches(entry, { ...rall, status: 'planned' }));
  assert.ok(!ctx.routeMatches(entry, { ...rall, difficulty: 'easy' }));
  assert.ok(ctx.routeMatches(entry, { ...rall, rating: '4' }));
  assert.ok(!ctx.routeMatches(entry, { ...rall, rating: 'unrated' }));
});
