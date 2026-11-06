'use strict';
// Runs the real theme and popup functions out of index.html, each cut at its
// closing brace.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
function source(re, name) {
  const m = re.exec(html);
  assert.ok(m, `${name} not found in index.html`);
  return m[1];
}
const fn = name => source(new RegExp(`^( {4}function ${name}\\([^)]*\\) \\{[\\s\\S]*?^ {4}\\})$`, 'm'), name);
const systemListener = source(
  /^( {4}if \(window\.matchMedia\) \{\n {6}window\.matchMedia\('\(prefers-color-scheme: light\)'\)[\s\S]*?^ {4}\})$/m,
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
    refreshCategoryColors: () => calls.push('refresh'),
  };
  return run(`let _routeColorCache = null;\n${fn('applyTheme')}\n${systemListener}\nglobalThis.__applyTheme = applyTheme;`, ctx);
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

function popups(category) {
  const ctx = {
    state: { categoryColors: { nature: '#123456' }, categoryColorsLight: { nature: '#654321' } },
    escapeHtml: s => String(s),
    getShowField: f => f === 'local-name',
    tagPopupHtml: () => '',
    displayCategory: s => s || 'Uncategorized',
    popupEditHtml: () => '',
    areaStatusHtml: () => '',
  };
  run(`${fn('popupCategoryHtml')}\n${fn('placePopupHtml')}\n${fn('areaPopupHtml')}\nglobalThis.__g = { placePopupHtml, areaPopupHtml };`, ctx);
  const entry = { name: 'Lake', local_name: 'Vatn', category };
  return [ctx.__g.placePopupHtml(entry), ctx.__g.areaPopupHtml(entry, false)];
}

test('a category colour reaches only the dot', () => {
  for (const popup of popups('nature')) {
    const styled = [...popup.matchAll(/<(\w+)([^>]*) style="[^"]*--c:[^"]*"/g)];
    assert.equal(styled.length, 1);
    assert.match(styled[0][2], /class="popup-category-dot"/);
    assert.match(popup, /--c:#123456;--cl:#654321/);
    assert.match(popup, /<span class="popup-local">Vatn<\/span>/);
  }
});

test('an uncategorized dot has no colour of its own, so it stays on the theme', () => {
  for (const popup of popups('')) {
    assert.match(popup, /<span class="popup-category-dot"><\/span>Uncategorized/);
    assert.doesNotMatch(popup, /--c:/);
  }
});
