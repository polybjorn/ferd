'use strict';
// Runs the overlay config parser out of index.html (OVERLAY-CFG markers) and
// the service worker's overlay host list out of sw.js (OVERLAY-HOSTS markers).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
function load(file, begin, end, names) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  const m = new RegExp(begin + '[^\\n]*\\n([\\s\\S]*?)\\n\\s*// ' + end).exec(src);
  assert.ok(m, `${begin} markers not found in ${file}`);
  const ctx = { URL };
  vm.createContext(ctx);
  vm.runInContext(m[1] + `\nglobalThis.__g = { ${names} };`, ctx);
  return ctx.__g;
}
const { parseOverlays } = load('index.html', 'OVERLAY-CFG-BEGIN', 'OVERLAY-CFG-END', 'parseOverlays');
const { overlayHosts } = load('sw.js', 'OVERLAY-HOSTS-BEGIN', 'OVERLAY-HOSTS-END', 'overlayHosts');
// Results come from another realm, so deepEqual needs plain copies.
const plain = v => JSON.parse(JSON.stringify(v));

const TOPO = { name: 'Topo', url: 'https://cache.example.no/topo/{z}/{y}/{x}.png', attribution: 'K' };
const SHADE = { name: 'Hillshade', type: 'wms', url: 'https://wms.example.no/shade', layers: 'shade' };

test('no overlays when the key is missing or not a list', () => {
  for (const v of [undefined, null, {}, 'x', 3]) assert.deepEqual(plain(parseOverlays(v)), []);
});

test('an XYZ overlay defaults to type xyz', () => {
  assert.deepEqual(plain(parseOverlays([TOPO])), [
    { name: 'Topo', type: 'xyz', url: TOPO.url, attribution: 'K' },
  ]);
});

test('a WMS overlay fills in format, styles, version and transparency', () => {
  assert.deepEqual(plain(parseOverlays([SHADE])), [{
    name: 'Hillshade', type: 'wms', url: SHADE.url, attribution: '',
    layers: 'shade', format: 'image/png', styles: '', version: '1.1.1', transparent: true,
  }]);
  const o = plain(parseOverlays([{ ...SHADE, transparent: false, format: 'image/jpeg', version: '1.3.0' }]))[0];
  assert.equal(o.transparent, false);
  assert.equal(o.format, 'image/jpeg');
  assert.equal(o.version, '1.3.0');
});

test('max_zoom and subdomains pass through when valid', () => {
  const o = parseOverlays([{ ...TOPO, max_zoom: 17, subdomains: 'abc' }])[0];
  assert.equal(o.maxZoom, 17);
  assert.equal(o.subdomains, 'abc');
  const bad = parseOverlays([{ ...TOPO, max_zoom: 1.5 }])[0];
  assert.equal(bad.maxZoom, undefined);
});

test('invalid entries are dropped and the rest kept', () => {
  const list = [
    null,
    { url: TOPO.url },
    { name: 'No url' },
    { name: 'Script', url: 'javascript:alert(1)' },
    { name: 'Relative', url: '/tiles/{z}/{x}/{y}.png' },
    { name: 'Odd', type: 'wmts', url: TOPO.url },
    { name: 'WMS no layers', type: 'wms', url: SHADE.url },
    TOPO,
    { ...TOPO, url: 'https://other.example/{z}/{x}/{y}.png' },
    SHADE,
  ];
  assert.deepEqual(plain(parseOverlays(list)).map(o => o.name), ['Topo', 'Hillshade']);
});

test('the service worker caches each opted-in overlay host, with {s} expanded', () => {
  const on = o => ({ ...o, offline: true });
  const cfg = { overlays: [
    on(TOPO),
    on(SHADE),
    on({ name: 'Sub', url: 'https://{s}.tiles.example.org/{z}/{x}/{y}.png', subdomains: 'xy' }),
    on({ name: 'Default subs', url: 'https://{s}.d.example.org/{z}/{x}/{y}.png' }),
    on({ name: 'Bad', url: 'not a url' }),
    on({ name: 'Ftp', url: 'ftp://ftp.example.org/x' }),
  ] };
  assert.deepEqual(plain(overlayHosts(cfg)), [
    'cache.example.no', 'wms.example.no',
    'x.tiles.example.org', 'y.tiles.example.org',
    'a.d.example.org', 'b.d.example.org', 'c.d.example.org',
  ]);
  assert.deepEqual(plain(overlayHosts(null)), []);
  assert.deepEqual(plain(overlayHosts({})), []);
});

test('an overlay without offline: true stays out of the tile cache', () => {
  const cfg = { overlays: [
    TOPO,
    { ...SHADE, offline: false },
    { name: 'Truthy', url: 'https://truthy.example.org/{z}/{x}/{y}.png', offline: 'yes' },
    { name: 'Kept', url: 'https://kept.example.org/{z}/{x}/{y}.png', offline: true },
  ] };
  assert.deepEqual(plain(overlayHosts(cfg)), ['kept.example.org']);
});

test('base map tiles cache offline only from hosts whose terms allow it', () => {
  const src = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const m = /const TILE_HOSTS = (\[[\s\S]*?\]);/.exec(src);
  assert.ok(m, 'TILE_HOSTS not found in sw.js');
  const hosts = vm.runInNewContext(m[1]);
  assert.ok(hosts.includes('a.tile.opentopomap.org'));
  for (const h of hosts) assert.doesNotMatch(h, /openstreetmap\.(org|fr)$/);
});
