'use strict';
// Runs the real popup builders out of the app modules: the POPUP-EDIT block, plus
// placePopupHtml and areaPopupHtml cut at their closing brace.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
function source(re, name) {
  const m = re.exec(app);
  assert.ok(m, `${name} not found in app/`);
  return m[1];
}
const block = source(/POPUP-EDIT-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ POPUP-EDIT-END/, 'POPUP-EDIT block');
const placeHtml = source(/^(function placePopupHtml\(p\) \{[\s\S]*?^\})$/m, 'placePopupHtml');
const areaHtml = source(/^(function areaPopupHtml\(a, visited\) \{[\s\S]*?^\})$/m, 'areaPopupHtml');

function popups(viewer, auth) {
  const ctx = {
    state: { viewer, auth },
    escapeHtml: s => String(s),
    getShowField: () => false,
    tagPopupHtml: () => '',
    popupCategoryHtml: s => String(s),
    areaStatusHtml: () => '<span>Visited</span>',
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}\n${placeHtml}\n${areaHtml}\nglobalThis.__g = { placePopupHtml, areaPopupHtml };`, ctx);
  return {
    place: ctx.__g.placePopupHtml({ name: 'Lake', category: 'nature', visited: false }),
    area: ctx.__g.areaPopupHtml({ name: 'Park', category: 'nature' }, false),
  };
}

const EDIT = 'class="popup-edit"';
const OWNER = { mode: 'owner', username: null };
const PUBLIC = { mode: 'public', username: 'demo' };

test('a signed-in owner gets Edit on place and area popups', () => {
  const { place, area } = popups(OWNER, { authenticated: true });
  assert.ok(place.includes(EDIT));
  assert.ok(area.includes(EDIT));
});

test('local mode gets Edit, since it signs in as authenticated', () => {
  assert.ok(popups(OWNER, { authenticated: true, local: true }).place.includes(EDIT));
});

test('a public map has no Edit, even for a signed-in visitor', () => {
  const { place, area } = popups(PUBLIC, { authenticated: true });
  assert.ok(!place.includes(EDIT));
  assert.ok(!area.includes(EDIT));
});

test('a signed-out visitor has no Edit', () => {
  for (const auth of [{ authenticated: false }, null, undefined]) {
    const { place, area } = popups(OWNER, auth);
    assert.ok(!place.includes(EDIT));
    assert.ok(!area.includes(EDIT));
  }
});
