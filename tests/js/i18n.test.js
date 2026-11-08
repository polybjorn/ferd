'use strict';
// The string table against the code that uses it: a key a view asks for must
// exist, and a key nothing mentions is dead weight.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', '..', 'app');
const files = fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js') && !/^i18n(-\w+)?\.js$/.test(f));
const source = files.map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

const base = key => key.replace(/\.(one|other)$/, '');
const load = () => import(path.join(dir, 'i18n.js'));

test('every key a view asks for is in the table', async () => {
  const { stringKeys } = await load();
  const known = new Set(stringKeys().map(base));
  const asked = [...source.matchAll(/\bt[x]?\('([\w.]+)'/g)].map(m => m[1]);
  assert.ok(asked.length > 100, 'found few t() calls: ' + asked.length);
  const missing = asked.filter(k => !known.has(k));
  assert.deepEqual(missing, []);
});

test('every key in the table is used by a view', async () => {
  const { stringKeys } = await load();
  const unused = [...new Set(stringKeys().map(base))].filter(k => !source.includes("'" + k + "'"));
  assert.deepEqual(unused, []);
});

test('t fills slots and picks the plural by count', async () => {
  const { t, tx } = await load();
  assert.equal(t('common.failed', { message: 'x' }), 'Failed: x');
  assert.equal(t('regions.clearWarning', { count: 1 }), '1 route will lose its region');
  assert.equal(t('regions.clearWarning', { count: 2 }), '2 routes will lose their region');
  assert.equal(t('areas.placesStat', { count: 1, done: 0 }), '1 place, 0 visited');
  assert.equal(t('areas.placesStat', { count: 14, done: 9 }), '14 places, 9 visited');
  assert.equal(t('areas.routesStat', { count: 1, done: 0 }), '1 route, 0 completed');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.deepEqual(tx('categories.slugPreview', { slug: 'S' }), ['Will be saved as slug ', 'S', '.']);
});

test('a language table falls back to English per key, and the browser tag picks the table', async () => {
  const { t, setLanguage, language, matchLanguage } = await load();
  try {
    setLanguage('nb');
    assert.equal(language(), 'nb');
    assert.equal(t('settings.general.language'), 'Språk');
    assert.equal(t('categories.clearWarning', { count: 1 }), '1 sted mister kategorien sin');
    assert.equal(t('categories.clearWarning', { count: 2 }), '2 steder mister kategorien sin');
    assert.equal(t('no.such.key'), 'no.such.key');
    assert.equal(matchLanguage('nb-NO'), 'nb');
    assert.equal(matchLanguage('nn'), 'nb');
    assert.equal(matchLanguage('en-GB'), 'en');
    assert.equal(matchLanguage('de-DE'), 'en');
    assert.equal(matchLanguage(undefined), 'en');
    setLanguage('fr');
    assert.equal(language(), 'en');
  } finally {
    setLanguage('en');
  }
});

test('numbers and unit labels follow the active language', async () => {
  const i18n = await load();
  const app = require('./app-source');
  const fn = name => {
    const m = new RegExp(`^(function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\})$`, 'm').exec(app);
    assert.ok(m, name + ' not found in app/');
    return m[1];
  };
  const ctx = { language: i18n.language, t: i18n.t, isImperial: () => false };
  vm.createContext(ctx);
  vm.runInContext([fn('grpNum'), fn('formatDistance'), fn('formatElevation')].join('\n'), ctx);
  try {
    assert.equal(ctx.grpNum(7340.9, 1), '7,340.9');
    assert.equal(ctx.formatDistance(7340900), '7,340.9 km');
    i18n.setLanguage('nb');
    assert.equal(ctx.grpNum(7340.9, 1), '7 340,9');
    assert.equal(ctx.formatElevation(1234), '1 234 m');
  } finally {
    i18n.setLanguage('en');
  }
});

// Every table but English against English: the same keys, no extras, the same
// {slot} names per key, and a .one/.other pair wherever English has one.
test('every language table matches the English keys, slots and plurals', async () => {
  const { stringKeys, stringTable, LANGUAGES } = await load();
  const en = stringTable('en');
  const slots = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  const codes = LANGUAGES.map(([code]) => code).filter(code => code !== 'en');
  assert.ok(codes.includes('nb'));
  assert.deepEqual(Object.keys(en), stringKeys());
  for (const code of codes) {
    const table = stringTable(code);
    const missing = stringKeys().filter(k => !(k in table));
    const extra = Object.keys(table).filter(k => !(k in en));
    assert.deepEqual(missing, [], code + ' lacks keys');
    assert.deepEqual(extra, [], code + ' has keys English lacks');
    const mismatched = stringKeys().filter(k => slots(table[k]) !== slots(en[k]));
    assert.deepEqual(mismatched, [], code + ' slot names differ');
    const plural = /\.(one|other)$/;
    const pairs = t => new Set(Object.keys(t).filter(k => plural.test(k)).map(k => k.replace(plural, '')));
    const unpaired = [...pairs(table)].filter(b => !(b + '.one' in table && b + '.other' in table));
    assert.deepEqual(unpaired, [], code + ' has a plural without both forms');
    assert.deepEqual([...pairs(table)].sort(), [...pairs(en)].sort());
  }
});
