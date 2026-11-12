'use strict';
// Runs the real theme and popup functions out of the app modules, each cut at its
// closing brace.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
const { loadPopupViews } = require('./popup-views');
function source(re, name) {
  const m = re.exec(app);
  assert.ok(m, `${name} not found in app/`);
  return m[1];
}
const fn = name => source(new RegExp(`^(function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\})$`, 'm'), name);
const systemListener = source(
  /^(if \(window\.matchMedia\) \{\n {2}window\.matchMedia\('\(prefers-color-scheme: light\)'\)[\s\S]*?^\})$/m,
  'system mode listener');

function run(code, ctx) {
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

function themeEnv() {
  const calls = [];
  const listeners = [];
  const ctx = {
    calls,
    listeners,
    state: {},
    window: { matchMedia: () => ({ matches: true, addEventListener: (_, f) => listeners.push(f) }) },
    document: { documentElement: { setAttribute: k => calls.push(k) } },
    getStoredMode: () => 'system',
    getStoredTheme: () => 'nord',
    loadedMap: () => ({ refreshCategoryColors: () => calls.push('refresh') }),
  };
  return run(`function clearRouteColorCache() {}\n${fn('applyTheme')}\n${systemListener}\nglobalThis.__applyTheme = applyTheme;`, ctx);
}

test('applyTheme refreshes the colours once the new theme is set', () => {
  const env = themeEnv();
  env.__applyTheme('nord', 'dark');
  assert.deepEqual([...env.calls], ['data-theme', 'data-mode', 'refresh']);
});

test('a system mode change refreshes the colours', () => {
  const env = themeEnv();
  assert.equal(env.listeners.length, 1);
  env.listeners[0]();
  assert.ok(env.calls.includes('refresh'));
});

function colorsEnv(state) {
  const calls = [];
  const ctx = {
    state,
    assignCategoryColors: () => ({ dark: { '': 'new-dark' }, light: { '': 'new-light' } }),
    syncAreasOnMap: () => calls.push('areas'),
    refreshFilterPanel: () => calls.push('filters'),
    refreshOpenPlacePopup: () => calls.push('popup'),
  };
  run(`${fn('refreshCategoryColors')}\nglobalThis.__refresh = refreshCategoryColors;`, ctx);
  ctx.__refresh();
  return calls;
}

test('colours update with no map mounted, for the list views', () => {
  const state = { places: [] };
  assert.deepEqual(colorsEnv(state), []);
  assert.equal(state.categoryColors[''], 'new-dark');
  assert.equal(state.categoryColorsLight[''], 'new-light');
});

test('a mounted map redraws and an open popup updates', () => {
  let redraws = 0;
  const calls = colorsEnv({ places: [], _placeClusterGroup: { redraw: () => { redraws += 1; } } });
  assert.equal(redraws, 1);
  assert.deepEqual(calls, ['areas', 'filters', 'popup']);
});

test('nothing runs before the places have loaded', () => {
  const state = { places: null };
  assert.deepEqual(colorsEnv(state), []);
  assert.equal(state.categoryColors, undefined);
});

async function popups(category) {
  const r = await loadPopupViews({
    state: { categoryColors: { nature: '#123456' }, categoryColorsLight: { nature: '#654321' } },
    getShowField: f => f === 'local-name',
    displayCategory: s => s || 'Uncategorized',
    canEditPopup: () => false,
  });
  const entry = { name: 'Lake', local_name: 'Vatn', category };
  return [r.place(entry), r.area(entry, false)];
}

test('a category colour reaches only the dot', async () => {
  for (const popup of await popups('nature')) {
    const styled = [...popup.matchAll(/<(\w+)([^>]*) style="[^"]*--c:[^"]*"/g)];
    assert.equal(styled.length, 1);
    assert.match(styled[0][2], /class="popup-category-dot"/);
    assert.match(popup, /--c:#123456;--cl:#654321/);
    assert.match(popup, /<span class="popup-local">Vatn<\/span>/);
  }
});

test('an uncategorized dot has no colour of its own, so it stays on the theme', async () => {
  for (const popup of await popups('')) {
    assert.match(popup, /<span class="popup-category-dot"><\/span>Uncategorized/);
    assert.doesNotMatch(popup, /--c:/);
  }
});
