'use strict';
// Runs the picker's matching out of the app modules (COUNTRY-MATCH markers) against
// the shipped list, so a rebuilt list is covered too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const src = require('./app-source');
const block = /COUNTRY-MATCH-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ COUNTRY-MATCH-END/.exec(src);
assert.ok(block, 'COUNTRY-MATCH markers not found in app/');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(block[1] + '\nglobalThis.__g = { countryMatches, canonicalCountry, normCountryName };', ctx);
const { countryMatches, canonicalCountry, normCountryName } = ctx.__g;

const data = f => JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'natural-earth', f), 'utf8'));
const names = data('country-names.json');
const countries = Object.entries(data('country-list.json')).map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));
const matched = q => Array.from(countryMatches(q, countries, names), c => c.name);

test('an empty query lists every country', () => {
  assert.equal(matched('  ').length, countries.length);
});

test('a prefix ranks above a match inside the name', () => {
  const list = matched('land');
  assert.ok(list.indexOf('Åland Islands') > -1);
  assert.ok(list.indexOf('Poland') > list.indexOf('Åland Islands'));
});

test('an alias finds its country first', () => {
  assert.equal(matched('Norge')[0], 'Norway');
  assert.equal(matched('USA')[0], 'United States');
  assert.equal(matched('uk')[0], 'United Kingdom');
});

test('accents do not matter', () => {
  assert.equal(matched('sao tome')[0], 'São Tomé and Príncipe');
});

test('no match gives an empty list', () => {
  assert.equal(matched('Xyzzy').length, 0);
});

test('canonicalCountry turns any known spelling into the listed name', () => {
  assert.equal(canonicalCountry('norge', countries, names), 'Norway');
  assert.equal(canonicalCountry('NO', countries, names), 'Norway');
  assert.equal(canonicalCountry('Norway', countries, names), 'Norway');
  assert.equal(canonicalCountry('Norwy', countries, names), null);
});

test('every listed name resolves to its own code', () => {
  for (const c of countries) assert.equal(names[normCountryName(c.name)], c.code, c.name);
});
