'use strict';
// The place, area and route forms keep their values in state and build the
// payload from it. These run that logic out of the app modules, between the
// FORM-FIELDS, PLACE-PAYLOAD, AREA-PAYLOAD and ROUTE-PAYLOAD markers.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('./app-source');
const block = name => {
  const m = new RegExp(name + '-BEGIN[^\\n]*\\n([\\s\\S]*?)\\n\\s*// ' + name + '-END').exec(app);
  assert.ok(m, name + ' markers not found in app/');
  return m[1];
};
const tagFn = /function parseTagInput\(str\) \{[\s\S]*?\n\}/.exec(app);
assert.ok(tagFn, 'parseTagInput not found in app/');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(tagFn[0] + '\n'
  // A stand-in that records what it was given; the geometry rules are tested in area-geo.test.js.
  + 'function buildAreaGeometry(polygons) { return { type: "stub", count: polygons.length }; }\n'
  + ['FORM-FIELDS', 'PLACE-PAYLOAD', 'AREA-PAYLOAD', 'ROUTE-PAYLOAD'].map(block).join('\n')
  + '\nglobalThis.api = { choiceFrom, choiceValue, sourcesFromText, roundCoord, placeValues, placeSnapshot,'
  + ' placePayload, editPlacePayload, areaValues, areaFormPayload, areaLocalName, editAreaPayload, newAreaItems,'
  + ' routeMetaValues, routeMetaFields, editRoutePlan, gpxUploadPlan };', ctx);
// Values built in vm have another realm's prototypes, which deepEqual rejects.
const api = new Proxy({}, {
  get: (_, k) => (...args) => {
    const r = ctx.api[k](...args);
    return r && typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r;
  },
});

const all = () => true;
const none = () => false;

test('a select-or-new holds a value outside its list as a new entry', () => {
  assert.deepEqual(api.choiceFrom('Hike', ['Hike', 'Food']), { sel: 'Hike', text: '' });
  assert.deepEqual(api.choiceFrom('Lake', ['Hike']), { sel: '__new__', text: 'Lake' });
  assert.deepEqual(api.choiceFrom(null, ['Hike']), { sel: '', text: '' });
  assert.equal(api.choiceValue({ sel: '__new__', text: '  Lake ' }), 'Lake');
  assert.equal(api.choiceValue({ sel: 'Hike', text: 'ignored' }), 'Hike');
  assert.equal(api.choiceValue({ sel: '__new__', text: ' ' }), '');
});

test('sources are one URL per line, blanks dropped', () => {
  assert.deepEqual(api.sourcesFromText(' a\n\n b \n'), ['a', 'b']);
  assert.deepEqual(api.sourcesFromText('  '), []);
});

test('coordinates round to five decimals', () => {
  assert.equal(api.roundCoord(59.123456789), 59.12346);
});

const place = (over = {}) => Object.assign(api.placeValues(null, ['castle']), {
  name: ' Keep ', lat: '59.1234567', lon: '5.5', category: { sel: 'castle', text: '' },
}, over);

test('a place without a position has no payload', () => {
  assert.deepEqual(api.placePayload(place({ lat: '' }), all), { error: 'coords' });
  assert.deepEqual(api.placePayload(place({ lon: 'x' }), all), { error: 'coords' });
});

test('a place payload trims, rounds and leaves empty fields out', () => {
  assert.deepEqual(api.placePayload(place(), all), {
    payload: { name: 'Keep', lat: 59.12346, lon: 5.5, visited: false, category: 'castle' },
  });
});

test('a place payload carries every filled field', () => {
  const v = place({
    local_name: ' Slott ', country: ' Norway ', tags: 'a, b,', note: ' n ', image: ' http://i ',
    sources: 'u1\nu2', visited: true, date_visited: '2024-05-01', rating: 4,
    category: { sel: '__new__', text: ' Ruin ' },
  });
  assert.deepEqual(api.placePayload(v, all).payload, {
    name: 'Keep', lat: 59.12346, lon: 5.5, visited: true, category: 'Ruin', country: 'Norway',
    note: 'n', local_name: 'Slott', image: 'http://i', sources: ['u1', 'u2'], tags: ['a', 'b'],
    date_visited: '2024-05-01', rating: 4,
  });
});

test('visit details are dropped while the place is not visited', () => {
  const p = api.placePayload(place({ date_visited: '2024-05-01', rating: 3 }), all).payload;
  assert.equal('date_visited' in p, false);
  assert.equal('rating' in p, false);
});

test('a hidden optional field is not read from the form', () => {
  const v = place({ note: 'n', local_name: 'l', image: 'i', tags: 't', visited: true, date_visited: 'd', rating: 2 });
  assert.deepEqual(api.placePayload(v, none).payload, {
    name: 'Keep', lat: 59.12346, lon: 5.5, visited: true, category: 'castle',
  });
});

test('an edit keeps what a hidden field or the form cannot show', () => {
  const stored = {
    from_catalog: 'Keep', local_name: 'L', note: 'N', image: 'I', tags: ['t'], image_focus: [1, 2],
    date_visited: 'D', rating: 5,
  };
  const v = place({ visited: true });
  const p = api.editPlacePayload(v, stored, none).payload;
  assert.deepEqual(p, {
    name: 'Keep', lat: 59.12346, lon: 5.5, visited: true, category: 'castle', from_catalog: 'Keep',
    local_name: 'L', note: 'N', image: 'I', tags: ['t'], image_focus: [1, 2], date_visited: 'D', rating: 5,
  });
});

test('an image focus survives only while the image is unchanged', () => {
  const stored = { image: 'I', image_focus: [1, 2] };
  assert.deepEqual(api.editPlacePayload(place({ image: 'I' }), stored, all).payload.image_focus, [1, 2]);
  assert.equal('image_focus' in api.editPlacePayload(place({ image: 'J' }), stored, all).payload, false);
  assert.deepEqual(api.editPlacePayload(place({ lat: '' }), stored, all), { error: 'coords' });
});

test('the snapshot for a pick on the map needs no position', () => {
  const s = api.placeSnapshot(place({ lat: '', tags: 'a, b', sources: 'x', category: { sel: '__new__', text: 'N' } }));
  assert.equal(s.name, 'Keep');
  assert.deepEqual(s.tags, ['a', 'b']);
  assert.deepEqual(s.sources, ['x']);
  assert.equal(s.category, 'N');
});

const area = (over = {}) => Object.assign(api.areaValues(null, []), { name: ' Park ' }, over);

test('an area payload leaves empty and hidden fields out', () => {
  assert.deepEqual(api.areaFormPayload(area({ note: ' n ' }), all), { visited: false, note: 'n' });
  assert.deepEqual(api.areaFormPayload(area({ note: 'n', category: { sel: 'park', text: '' } }), none), { visited: false, category: 'park' });
});

test('an area edit replaces the area and keeps what the form hides', () => {
  const stored = { geometry: { g: 1 }, note: 'N', local_name: 'L', source: 'osm' };
  assert.deepEqual(api.editAreaPayload(area({ visited: true }), stored, none), {
    visited: true, name: 'Park', geometry: { g: 1 }, note: 'N', local_name: 'L', source: 'osm',
  });
  assert.deepEqual(api.editAreaPayload(area({ local_name: ' Parken ' }), { geometry: 1 }, all), {
    visited: false, name: 'Park', geometry: 1, local_name: 'Parken',
  });
});

test('the area local name falls back to the kept one only while hidden', () => {
  assert.equal(api.areaLocalName(area({ local_name: ' x ' }), all, 'kept'), 'x');
  assert.equal(api.areaLocalName(area({ local_name: 'x' }), none, 'kept'), 'kept');
  assert.equal(api.areaLocalName(area(), none, undefined), '');
});

const parsed = { features: [{ name: 'A', polygons: [1, 2] }, { polygons: [3] }], osm: true };
const fallbackName = n => 'Area ' + n;

test('a merged area takes the form name and every polygon', () => {
  const items = api.newAreaItems(area({ local_name: 'Skog' }), { parsed, split: false, pickedLocal: '', show: all, fallbackName });
  assert.deepEqual(items, [{
    visited: false, name: 'Park', geometry: { type: 'stub', count: 3 }, local_name: 'Skog', source: 'osm',
  }]);
});

test('a split area makes one item per group, named from the group', () => {
  const items = api.newAreaItems(area(), { parsed, split: true, pickedLocal: 'Skog', show: all, fallbackName });
  assert.deepEqual(items.map(i => i.name), ['A', 'Area 2']);
  assert.deepEqual(items.map(i => i.geometry.count), [2, 1]);
  assert.equal(items.some(i => 'local_name' in i), false);
  assert.ok(items.every(i => i.source === 'osm'));
});

test('a file that is not from OpenStreetMap carries no source', () => {
  const items = api.newAreaItems(area(), { parsed: { features: parsed.features }, split: false, pickedLocal: '', show: all, fallbackName });
  assert.equal('source' in items[0], false);
});

const stored = { name: 'Loop', difficulty: 'easy', tags: ['x'], date_completed: '2024', rating: 3, completed: true };
const route = (over = {}) => Object.assign(api.routeMetaValues(stored, 'Alps', ['Alps', 'Jura']), over);

test('the route form starts from the stored route and its region', () => {
  const v = api.routeMetaValues(stored, 'Alps', ['Alps']);
  assert.equal(v.name, 'Loop');
  assert.equal(v.tags, 'x');
  assert.deepEqual(v.region, { sel: 'Alps', text: '' });
  assert.equal(v.rating, 3);
  assert.deepEqual(api.routeMetaValues(null, '', []).region, { sel: '', text: '' });
});

test('route metadata trims, parses tags and drops hidden fields', () => {
  const v = route({ source: ' s ', notes: 'n', local_name: ' L ', tags: 'a, b', difficulty: 'hard' });
  assert.deepEqual(api.routeMetaFields(v, all), {
    source: 's', notes: 'n', local_name: 'L', difficulty: 'hard', tags: ['a', 'b'],
  });
  assert.deepEqual(api.routeMetaFields(v, none), { source: 's', difficulty: 'hard' });
});

test('an edit needs a name and a named new region', () => {
  assert.deepEqual(api.editRoutePlan(route({ name: ' ' }), stored, 'Alps', all), { error: 'name' });
  assert.deepEqual(api.editRoutePlan(route({ region: { sel: '__new__', text: ' ' } }), stored, 'Alps', all), { error: 'region' });
});

test('an edit says what has to move or flip', () => {
  const same = api.editRoutePlan(route(), stored, 'Alps', all);
  assert.equal(same.needsMove, false);
  assert.equal(same.needsCompletedFlip, false);
  const moved = api.editRoutePlan(route({ region: { sel: '__new__', text: 'Tatra' }, name: 'Loop 2', completed: false }), stored, 'Alps', all);
  assert.equal(moved.targetRegion, 'Tatra');
  assert.equal(moved.newName, 'Loop 2');
  assert.equal(moved.needsMove, true);
  assert.equal(moved.needsCompletedFlip, true);
  assert.equal(moved.newCompleted, false);
});

test('an edit keeps stored metadata for hidden fields and uses date and rating when shown', () => {
  const r = Object.assign({}, stored, { local_name: 'L', notes: 'N' });
  const hidden = api.editRoutePlan(route(), r, 'Alps', none).metadata;
  assert.deepEqual(hidden, { difficulty: 'easy', local_name: 'L', notes: 'N', tags: ['x'], date_completed: '2024', rating: 3 });
  const shown = api.editRoutePlan(route({ date: ' 2025 ', rating: 5, tags: '' }), r, 'Alps', all).metadata;
  assert.equal(shown.date_completed, '2025');
  assert.equal(shown.rating, 5);
  assert.equal('tags' in shown, false);
});

test('an upload needs a file', () => {
  assert.deepEqual(api.gpxUploadPlan(route(), null, all), { error: 'file' });
});

test('a planned upload is stored with .planned and keyed without it', () => {
  const plan = api.gpxUploadPlan(route({ completed: false, region: { sel: 'Alps', text: '' }, name: ' Loop ', date: 'd', rating: 2 }), {}, all);
  assert.equal(plan.storedName, 'Loop.planned');
  assert.equal(plan.metaKey, 'Alps/Loop');
  assert.equal('date_completed' in plan.metadata, false);
  assert.equal('rating' in plan.metadata, false);
});

test('a completed upload with no region carries date and rating', () => {
  const plan = api.gpxUploadPlan(route({ completed: true, region: { sel: '', text: '' }, date: ' 2025 ', rating: 4 }), {}, all);
  assert.equal(plan.storedName, 'Loop');
  assert.equal(plan.metaKey, 'Loop');
  assert.equal(plan.metadata.date_completed, '2025');
  assert.equal(plan.metadata.rating, 4);
});
