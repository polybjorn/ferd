'use strict';
// Renders the real place and area popup views with the POPUP-EDIT block from
// app/server.js deciding whether Edit shows.
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
const { loadPopupViews } = require('./popup-views');

async function popups(viewer, auth) {
  const r = await loadPopupViews({
    state: { viewer, auth, categoryColors: {}, categoryColorsLight: {} },
    getShowField: () => false,
    displayCategory: s => String(s),
    displayRegion: s => String(s),
    areaStatText: n => String(n),
    DIFFICULTY_LABELS: {},
  }, block);
  return {
    place: r.place({ name: 'Lake', category: 'nature', visited: false }),
    area: r.area({ name: 'Park', category: 'nature' }, false),
  };
}

const EDIT = 'class="popup-edit"';
const OWNER = { mode: 'owner', username: null };
const PUBLIC = { mode: 'public', username: 'demo' };

test('a signed-in owner gets Edit on place and area popups', async () => {
  const { place, area } = await popups(OWNER, { authenticated: true });
  assert.ok(place.includes(EDIT));
  assert.ok(area.includes(EDIT));
});

test('local mode gets Edit, since it signs in as authenticated', async () => {
  assert.ok((await popups(OWNER, { authenticated: true, local: true })).place.includes(EDIT));
});

test('a public map has no Edit, even for a signed-in visitor', async () => {
  const { place, area } = await popups(PUBLIC, { authenticated: true });
  assert.ok(!place.includes(EDIT));
  assert.ok(!area.includes(EDIT));
});

test('a signed-out visitor has no Edit', async () => {
  for (const auth of [{ authenticated: false }, null, undefined]) {
    const { place, area } = await popups(OWNER, auth);
    assert.ok(!place.includes(EDIT));
    assert.ok(!area.includes(EDIT));
  }
});
