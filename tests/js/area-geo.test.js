'use strict';
// Runs the area parser and geometry helpers straight out of the app modules,
// between the AREA-GEO markers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = require('./app-source');
const m = /AREA-GEO-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ AREA-GEO-END/.exec(app);
assert.ok(m, 'AREA-GEO markers not found in app/');
const ctx = { Math, JSON, Array, Uint8Array, Error, console };
vm.createContext(ctx);
vm.runInContext(m[1] + `
globalThis.__g = { nominatimAreas, parseAreaGeoJson, buildAreaGeometry, areaContains, areaSize, areaBbox, bboxesOverlap,
  placesInArea, tracksTouchArea, areaHasGeometry, AREA_TARGET_POINTS };`, ctx);
const g = ctx.__g;
// Results come from another realm, so deepEqual needs plain copies.
const plain = v => JSON.parse(JSON.stringify(v));

const SQUARE = [[5, 60], [6, 60], [6, 61], [5, 61], [5, 60]];
const HOLE = [[5.4, 60.4], [5.6, 60.4], [5.6, 60.6], [5.4, 60.6], [5.4, 60.4]];
const feature = (geometry, name) => ({ type: 'Feature', properties: name ? { name } : {}, geometry });
const polygon = (...rings) => ({ type: 'Polygon', coordinates: rings });
const parse = doc => plain(g.parseAreaGeoJson(JSON.stringify(doc)));

// A wobbly circle with n vertices: every vertex is off the line of its
// neighbours, so simplification has real work to do.
function circle(n, cx = 8, cy = 60, r = 1) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = 2 * Math.PI * i / n;
    const w = r * (1 + 0.02 * Math.sin(a * 40));
    ring.push([cx + w * Math.cos(a), cy + w * Math.sin(a)]);
  }
  ring.push(ring[0].slice());
  return ring;
}
const points = geom => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates)
  .flat().reduce((n, r) => n + r.length, 0);

test('accepts a FeatureCollection, a Feature and a bare geometry', () => {
  const geom = polygon(SQUARE);
  const expected = [[SQUARE]];
  assert.deepEqual(parse({ type: 'FeatureCollection', features: [feature(geom, 'A')] }).features, [{ name: 'A', polygons: expected }]);
  assert.deepEqual(parse(feature(geom, 'B')).features, [{ name: 'B', polygons: expected }]);
  assert.deepEqual(parse(geom).features, [{ name: '', polygons: expected }]);
});

test('a MultiPolygon stays one feature', () => {
  const doc = feature({ type: 'MultiPolygon', coordinates: [[SQUARE], [HOLE]] }, 'M');
  assert.equal(parse(doc).features[0].polygons.length, 2);
});

test('other geometry types are counted as ignored', () => {
  const out = parse({ type: 'FeatureCollection', features: [
    feature(polygon(SQUARE)),
    feature({ type: 'Point', coordinates: [5, 60] }),
    feature({ type: 'LineString', coordinates: [[5, 60], [6, 60]] }),
    { type: 'Feature', geometry: null },
  ] });
  assert.equal(out.features.length, 1);
  assert.equal(out.ignored, 3);
});

test('a file without polygons or with bad JSON is an error', () => {
  assert.throws(() => g.parseAreaGeoJson('{nope'), /not valid GeoJSON/);
  assert.throws(() => g.parseAreaGeoJson('[]'), /not valid GeoJSON/);
  assert.throws(() => g.parseAreaGeoJson('null'), /not valid GeoJSON/);
  assert.throws(() => parse({ type: 'Point', coordinates: [5, 60] }), /no polygons/);
  assert.throws(() => parse({ type: 'FeatureCollection', features: [] }), /no polygons/);
});

test('a projected file is refused and the message names the fix', () => {
  const utm = [[300000, 6700000], [310000, 6700000], [310000, 6710000], [300000, 6700000]];
  assert.throws(() => parse(polygon(utm)), /UTM33.*WGS84/);
  const named = { ...feature(polygon(SQUARE)), crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::25833' } } };
  assert.throws(() => parse(named), /25833.*WGS84/);
});

test('both spellings of WGS84 pass the crs check', () => {
  for (const name of ['urn:ogc:def:crs:OGC:1.3:CRS84', 'EPSG:4326', 'urn:ogc:def:crs:EPSG::4326']) {
    assert.equal(parse({ ...feature(polygon(SQUARE)), crs: { properties: { name } } }).features.length, 1);
  }
});

test('Z values are dropped and open rings are closed', () => {
  const open = [[5, 60, 100], [6, 60, 100], [6, 61, 100], [5, 61, 100]];
  assert.deepEqual(parse(polygon(open)).features[0].polygons[0][0], SQUARE);
});

test('a ring too short to enclose anything is dropped, a hole alone', () => {
  const tiny = [[5, 60], [6, 60]];
  assert.deepEqual(parse(polygon(SQUARE, tiny)).features[0].polygons, [[SQUARE]]);
  assert.throws(() => parse(polygon(tiny)), /no polygons/);
});

test('a malformed coordinate is an error, not a silent drop', () => {
  assert.throws(() => parse(polygon([[5, 60], ['a', 60], [6, 61], [5, 60]])), /malformed/);
  assert.throws(() => parse(polygon([[5], [6, 60], [6, 61], [5, 60]])), /malformed/);
});

test('a geometry under the target comes through unchanged', () => {
  assert.deepEqual(plain(g.buildAreaGeometry([[SQUARE, HOLE]])), polygon(SQUARE, HOLE));
});

test('several polygons wrap as a MultiPolygon', () => {
  const out = plain(g.buildAreaGeometry([[SQUARE], [HOLE]]));
  assert.equal(out.type, 'MultiPolygon');
  assert.equal(out.coordinates.length, 2);
});

test('coordinates are rounded to six decimals', () => {
  const ring = [[5.123456789, 60], [6, 60], [6, 61], [5.123456789, 60]];
  assert.equal(g.buildAreaGeometry([[ring]]).coordinates[0][0][0], 5.123457);
});

test('a large ring is simplified to the target and stays closed and in place', () => {
  const ring = circle(60000);
  const out = plain(g.buildAreaGeometry([[ring]]));
  const outer = out.coordinates[0];
  assert.ok(points(out) <= g.AREA_TARGET_POINTS, 'over target: ' + points(out));
  assert.ok(outer.length >= 4);
  assert.deepEqual(outer[0], outer[outer.length - 1]);
  assert.ok(g.areaContains(out, 8, 60));
  assert.ok(!g.areaContains(out, 8, 62));
});

test('the largest polygon survives a target that drops the islets', () => {
  const islets = [];
  for (let i = 0; i < 50; i++) islets.push([circle(40, 20 + i * 0.01, 70, 0.0001)]);
  const out = plain(g.buildAreaGeometry([...islets, [circle(4000)]], 500));
  assert.ok(points(out) <= 500, 'over target: ' + points(out));
  assert.ok(g.areaContains(out, 8, 60));
});

test('an impossible target still returns a valid ring', () => {
  const out = plain(g.buildAreaGeometry([[circle(1000)]], 1));
  assert.equal(out.type, 'Polygon');
  assert.ok(out.coordinates[0].length >= 4);
  assert.deepEqual(out.coordinates[0][0], out.coordinates[0][out.coordinates[0].length - 1]);
});

test('areaContains respects holes and every polygon of a MultiPolygon', () => {
  const donut = polygon(SQUARE, HOLE);
  assert.ok(g.areaContains(donut, 5.2, 60.2));
  assert.ok(!g.areaContains(donut, 5.5, 60.5));
  assert.ok(!g.areaContains(donut, 7, 60.5));
  const multi = { type: 'MultiPolygon', coordinates: [[SQUARE], [[[10, 60], [11, 60], [11, 61], [10, 60]]]] };
  assert.ok(g.areaContains(multi, 10.8, 60.2));
});

test('areaSize ranks a small area under a large one and subtracts holes', () => {
  assert.ok(g.areaSize(polygon(HOLE)) < g.areaSize(polygon(SQUARE)));
  assert.ok(g.areaSize(polygon(SQUARE, HOLE)) < g.areaSize(polygon(SQUARE)));
});

const DONUT = polygon(SQUARE, HOLE);
const ISLANDS = { type: 'MultiPolygon', coordinates: [[SQUARE], [[[10, 60], [11, 60], [11, 61], [10, 61], [10, 60]]]] };

test('bbox is south, west, north, east over every polygon', () => {
  assert.deepEqual(plain(g.areaBbox(ISLANDS)), [60, 5, 61, 11]);
});

test('bboxes overlap when they touch, not when they are apart', () => {
  const box = [60, 5, 61, 6];
  assert.equal(g.bboxesOverlap(box, [60.5, 5.5, 62, 7]), true);
  assert.equal(g.bboxesOverlap(box, [61, 6, 62, 7]), true);
  assert.equal(g.bboxesOverlap(box, [62, 5, 63, 6]), false);
  assert.equal(g.bboxesOverlap(box, [60, 7, 61, 8]), false);
});

test('places inside skip holes and reach every polygon', () => {
  const places = [
    { id: 'in', lon: 5.2, lat: 60.2 },
    { id: 'hole', lon: 5.5, lat: 60.5 },
    { id: 'out', lon: 7, lat: 60.5 },
  ];
  assert.deepEqual(plain(g.placesInArea(DONUT, places)).map(p => p.id), ['in']);
  assert.deepEqual(plain(g.placesInArea(ISLANDS, [{ id: 'far', lon: 10.5, lat: 60.5 }, ...places])).map(p => p.id),
    ['far', 'in', 'hole']);
});

test('one track point inside is enough, in any track', () => {
  const outside = { points: [{ lon: 4, lat: 60 }, { lon: 4.5, lat: 60 }] };
  const crossing = { points: [{ lon: 4.5, lat: 60.2 }, { lon: 5.2, lat: 60.2 }, { lon: 7, lat: 60.2 }] };
  const inHoleOnly = { points: [{ lon: 5.5, lat: 60.5 }] };
  assert.equal(g.tracksTouchArea(DONUT, [outside, crossing]), true);
  assert.equal(g.tracksTouchArea(DONUT, [outside, inHoleOnly]), false);
  assert.equal(g.tracksTouchArea(DONUT, []), false);
});

test('nominatimAreas keeps the English name and the local one beside it', () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
  const [area] = g.nominatimAreas({ features: [{
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { name: 'Hiroshima Prefecture', display_name: 'Hiroshima Prefecture, Japan', addresstype: 'province', namedetails: { name: '広島県' } },
  }] });
  assert.equal(area.name, 'Hiroshima Prefecture');
  assert.equal(area.localName, '広島県');
  assert.equal(area.kind, 'province');
  assert.equal(area.detail, 'Japan');
});

test('nominatimAreas leaves the local name empty when it is the same', () => {
  const ring = [[0, 0], [1, 0], [1, 1], [0, 0]];
  const [area] = g.nominatimAreas({ features: [{
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { name: 'Agder', namedetails: { name: 'Agder' } },
  }] });
  assert.equal(area.localName, '');
});

test('nominatimAreas drops results with no polygon', () => {
  const out = g.nominatimAreas({ features: [{ geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'Galdhopiggen' } }] });
  assert.equal(out.length, 0);
});

test('parseAreaGeoJson notices an OpenStreetMap licence', () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const doc = extra => JSON.stringify(Object.assign({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] }, extra));
  assert.equal(g.parseAreaGeoJson(doc({ licence: 'Data © OpenStreetMap contributors, ODbL 1.0.' })).osm, true);
  assert.equal(g.parseAreaGeoJson(doc({ copyright: 'The data included in this document is from www.openstreetmap.org.' })).osm, true);
  assert.equal(g.parseAreaGeoJson(doc({})).osm, false);
});

test('areaHasGeometry refuses an area that cannot be drawn', () => {
  assert.equal(g.areaHasGeometry({ geometry: polygon(SQUARE) }), true);
  assert.equal(g.areaHasGeometry({ geometry: { type: 'MultiPolygon', coordinates: [[SQUARE]] } }), true);
  assert.equal(g.areaHasGeometry({ name: 'No geometry' }), false);
  assert.equal(g.areaHasGeometry({ geometry: { type: 'Point', coordinates: [1, 2] } }), false);
  assert.equal(g.areaHasGeometry({ geometry: polygon([[5, 60], [6, 60]]) }), false);
  assert.equal(g.areaHasGeometry({ geometry: polygon('not a ring') }), false);
  assert.equal(g.areaHasGeometry(null), false);
});
