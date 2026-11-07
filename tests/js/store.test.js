'use strict';
// Runs the store's core (between the STORE-CORE markers in app/store.js) in
// vm, with IndexedDB and the API replaced by in-memory stand-ins: the v5
// migration, the manifest round trip, local edits against pulled changes,
// the push queue, GPX file operations and category labels.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('./app-source');
const m = /STORE-CORE-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ STORE-CORE-END/.exec(app);
assert.ok(m, 'STORE-CORE markers not found in app/');
const source = m[1] + `
globalThis.__s = { emptyMem, buildManifest, manifestItems, migrateV5, applyChanges, applyPull,
  pushPending, labelChanges, ROUTE_OPS, pkey, stripUi };
globalThis.__setMem = v => { mem = v; };`;

const META = ['source', 'date_completed', 'rating', 'notes', 'tags', 'difficulty', 'local_name'];
function makeEnv(overrides = {}) {
  const writes = [];
  const calls = [];
  let n = 0, seq = 0;
  const ctx = {
    console, JSON, Promise, Object, Array, Map, Set, Error, Math, Date,
    KINDS: ['place', 'area', 'route', 'metadata', 'pref', 'label'],
    BATCH_MAX: 500,
    NS: 'https://ferd.test::own:bjorn',
    pendingMap: new Map(),
    syncState: { rev: 0, epoch: null },
    nextSeq: () => ++seq,
    _genId: () => (0xa0000000 + (++n)).toString(16),
    _splitKey: key => {
      const parts = (key || '').split('/');
      return parts.length === 2 ? { region: parts[0], name: parts[1] } : { region: '', name: parts[0] };
    },
    parseGpxText: () => ({ hasElevation: true, bbox: [0, 0, 1, 1], trackCount: 1, trackNames: [] }),
    ROUTE_META_FIELDS: META,
    dbWrite: w => { writes.push(w); return Promise.resolve(); },
    updatePendingCount: () => {},
    api: (method, path, body) => { calls.push({ method, path, body }); return Promise.resolve({ ok: true }); },
    ...overrides,
  };
  vm.createContext(ctx);
  vm.runInContext('var mem;', ctx);
  vm.runInContext(source, ctx);
  ctx.__setMem(ctx.__s.emptyMem());
  return { s: ctx.__s, ctx, writes, calls };
}
const plain = v => JSON.parse(JSON.stringify(v));
const memOf = (ctx, kind) => plain([...vm.runInContext('mem', ctx)[kind].entries()]);

test('migrateV5 moves local stores, cached reads and the outbox', () => {
  const { s } = makeEnv();
  const ns = 'https://ferd.test::own:bjorn';
  const out = plain(s.migrateV5({
    places: [['aaaaaaa1', { id: 'aaaaaaa1', name: 'Hut' }]],
    areas: [['bbbbbbb1', { id: 'bbbbbbb1', name: 'Lake', geometry: {} }]],
    kv: [['local:metadata', { 'West/Ridge': { rating: 4 } }], ['local:category-labels', { hut: { label: 'Huts', color: 2 } }]],
    gpx: [
      ['West/Ridge.gpx', { file: 'West/Ridge.gpx', region: 'West', name: 'Ridge', planned: false, text: '<gpx/>', hasElevation: true }],
      ['West/Ridge.planned.gpx', { file: 'West/Ridge.planned.gpx', region: 'West', name: 'Ridge', planned: true, text: '<gpx p/>' }],
    ],
    cache: [
      ['auth::https://ferd.test', { data: { authenticated: true, username: 'bjorn' } }],
      ['data::' + ns + '::places', { data: [{ id: 'c0ffee01', name: 'Cafe' }, { id: 'local1', name: 'New' }] }],
      ['data::' + ns + '::routes', { data: { regions: [{ name: '', routes: [{ key: 'Loop', file: 'Loop.gpx', name: 'Loop', completed: true, notes: 'n' }] }] } }],
      ['data::' + ns + '::category-labels', { data: { category_labels: { cafe: { label: 'Cafes' } } } }],
    ],
    outbox: [
      [1, { id: 1, ns, method: 'createPlace', args: { name: 'New' }, localId: 'local1', ts: 0 }],
      [2, { id: 2, ns, method: 'uploadGpx', args: { region: '', name: 'Loop' }, file: 'Loop.gpx', ts: 0 }],
      [3, { id: 3, ns, method: 'putMetadata', args: { key: 'Loop', metadata: { notes: 'n' } }, ts: 0 }],
    ],
    pending_gpx: [['Loop.gpx', { file: 'Loop.gpx', text: '<gpx loop/>' }]],
  }));
  const local = out.items.filter(i => i.ns === 'local');
  assert.deepEqual(local.filter(i => i.kind === 'place').map(i => i.id), ['aaaaaaa1']);
  assert.deepEqual(local.find(i => i.kind === 'label').data, { label: 'Huts', color: 2 });
  const ridge = local.find(i => i.kind === 'route');
  assert.equal(ridge.id, 'West/Ridge');
  assert.equal(ridge.data.region, 'West');
  assert.equal(ridge.data.completed, true);
  assert.equal(ridge.data.plannedFile, 'West/Ridge.planned.gpx');
  assert.deepEqual(local.find(i => i.kind === 'metadata').data, { rating: 4 });
  assert.equal(out.gpx.filter(g => g.ns === 'local').length, 2);

  const server = out.items.filter(i => i.ns === ns);
  const placeIds = server.filter(i => i.kind === 'place').map(i => i.id);
  assert.ok(placeIds.includes('c0ffee01'));
  const fresh = placeIds.find(id => id !== 'c0ffee01');
  assert.match(fresh, /^[0-9a-f]{8}$/, 'an offline id that the server would refuse is replaced');
  assert.deepEqual(server.find(i => i.kind === 'metadata').data, { notes: 'n' });
  assert.equal(server.find(i => i.kind === 'route').data.notes, undefined, 'metadata leaves the route row');

  assert.deepEqual(out.pending.map(p => [p.kind, p.id, p.op]), [['place', fresh, 'put'], ['metadata', 'Loop', 'put']]);
  assert.equal(out.pending[0].data.id, fresh);
  assert.deepEqual(out.ops.map(o => o.method), ['uploadGpx']);
  assert.deepEqual(out.gpx.filter(g => g.ns === ns), [{ ns, file: 'Loop.gpx', text: '<gpx loop/>' }]);
  assert.deepEqual(out.meta, [['auth::https://ferd.test', { authenticated: true, username: 'bjorn' }]]);
});

test('a manifest survives the split into items and back', () => {
  const { s } = makeEnv();
  const manifest = { regions: [
    { name: 'East', routes: [{ key: 'East/A', file: 'East/A.gpx', name: 'A', completed: true, hasElevation: false, rating: 3 }] },
    { name: '', routes: [{ key: 'B', file: 'B.planned.gpx', name: 'B', completed: false, plannedFile: 'B.planned.gpx', hasElevation: true }] },
  ] };
  const route = new Map(), meta = new Map();
  for (const c of s.manifestItems(manifest)) (c.kind === 'route' ? route : meta).set(c.id, { data: c.data, pos: 0 });
  assert.deepEqual(plain(s.buildManifest(route, meta)), manifest);
});

test('a pull leaves items with a pending edit alone, and a reset keeps them', () => {
  const { s, ctx } = makeEnv();
  s.applyChanges([{ kind: 'place', id: 'aaaaaaa1', op: 'put', data: { id: 'aaaaaaa1', name: 'Mine' } }], true);
  assert.equal(ctx.pendingMap.size, 1);
  s.applyPull({ rev: 5, next: 5, epoch: 'e1', changes: [
    { kind: 'place', id: 'aaaaaaa1', pos: 1, rev: 4, data: { id: 'aaaaaaa1', name: 'Theirs' } },
    { kind: 'place', id: 'bbbbbbb1', pos: 2, rev: 5, data: { id: 'bbbbbbb1', name: 'Other' } },
  ] });
  assert.equal(memOf(ctx, 'place').find(([id]) => id === 'aaaaaaa1')[1].data.name, 'Mine');
  assert.deepEqual(plain(ctx.syncState), { rev: 5, epoch: 'e1' });
  const echo = s.applyPull({ rev: 5, next: 5, epoch: 'e1', changes: [
    { kind: 'place', id: 'bbbbbbb1', pos: 2, rev: 5, data: { id: 'bbbbbbb1', name: 'Other' } },
  ] });
  assert.equal(echo.changed, 0, 'an item that already matches is not news');
  const { w } = s.applyPull({ reset: true, rev: 9, next: 9, epoch: 'e2', changes: [
    { kind: 'area', id: 'ccccccc1', pos: 1, rev: 9, data: { id: 'ccccccc1' } },
  ] });
  assert.equal(w.clearItems, true);
  assert.deepEqual(memOf(ctx, 'place').map(([id]) => id), ['aaaaaaa1']);
  assert.deepEqual(memOf(ctx, 'area').map(([id]) => id), ['ccccccc1']);
});

test('pushPending sends the queue, drops a refused change and keeps the rest on a network error', async () => {
  let fail = null;
  const env = makeEnv({
    api: (method, path, body) => {
      env.calls.push(body.changes.map(c => c.id));
      if (fail) { const f = fail; fail = null; return Promise.reject(f); }
      return Promise.resolve({ ok: true });
    },
  });
  const { s, ctx, calls } = env;
  s.applyChanges([
    { kind: 'place', id: 'aaaaaaa1', op: 'put', data: { name: 'A' } },
    { kind: 'place', id: 'aaaaaaa2', op: 'put', data: { name: '' } },
    { kind: 'place', id: 'aaaaaaa3', op: 'delete' },
  ], true);
  fail = Object.assign(new Error('changes[1]: name must be a non-empty string'), { status: 400 });
  const r = await s.pushPending();
  assert.deepEqual(plain(r), { pushed: 2, skipped: 1 });
  assert.deepEqual(plain(calls), [['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3'], ['aaaaaaa1', 'aaaaaaa3']]);
  assert.equal(ctx.pendingMap.size, 0);

  s.applyChanges([{ kind: 'pref', id: 'theme', op: 'put', data: 'dark' }], true);
  fail = new Error('Network error');
  await assert.rejects(s.pushPending());
  assert.equal(ctx.pendingMap.size, 1);
});

test('GPX operations move route items, files and metadata the way the server does', () => {
  const { s, ctx } = makeEnv();
  const route = (key, extra) => ({ kind: 'route', id: key, op: 'put', data: Object.assign({ key, name: key.split('/').pop(), region: key.includes('/') ? key.split('/')[0] : '' }, extra) });
  s.applyChanges([
    route('West/Ridge', { file: 'West/Ridge.gpx', completed: true, plannedFile: 'West/Ridge.planned.gpx' }),
    route('West/Lake', { file: 'West/Lake.planned.gpx', completed: false, plannedFile: 'West/Lake.planned.gpx' }),
  ], false);

  const mv = s.ROUTE_OPS.moveGpx({ key: 'West/Ridge', new_region: 'North', new_name: 'Crest' });
  assert.deepEqual(plain(mv.result), { ok: true, old_key: 'West/Ridge', new_key: 'North/Crest', moved: 1 });
  assert.deepEqual(plain(mv.moves), [['West/Ridge.gpx', 'North/Crest.gpx'], ['West/Ridge.planned.gpx', 'North/Crest.planned.gpx']]);
  assert.deepEqual(plain(mv.metaMoves), [['West/Ridge', 'North/Crest']]);
  assert.deepEqual(plain(mv.changes.map(c => [c.id, c.op])), [['West/Ridge', 'delete'], ['North/Crest', 'put']]);
  assert.equal(mv.changes[1].data.region, 'North');

  const done = s.ROUTE_OPS.setGpxCompleted({ key: 'West/Lake', completed: true });
  assert.deepEqual(plain(done.moves), [['West/Lake.planned.gpx', 'West/Lake.gpx']]);
  assert.equal(done.changes[0].data.file, 'West/Lake.gpx');
  assert.equal(done.changes[0].data.plannedFile, undefined);

  const clear = s.ROUTE_OPS.clearRegion({ name: 'West' });
  assert.deepEqual(plain(clear.changes.filter(c => c.op === 'put').map(c => [c.id, c.data.region])), [['Ridge', ''], ['Lake', '']]);
  assert.equal(memOf(ctx, 'route').length, 2, 'the op only describes changes; applyChanges makes them');

  const up = s.ROUTE_OPS.uploadGpx({ region: 'West', name: 'Lake', text: '<gpx/>' });
  assert.equal(up.changes[0].data.completed, true);
  assert.equal(up.changes[0].data.plannedFile, 'West/Lake.planned.gpx');
});

test('category labels replace the map and keep a colour left out', () => {
  const { s } = makeEnv();
  s.applyChanges([
    { kind: 'label', id: 'hut', op: 'put', data: { label: 'Huts', color: 3 } },
    { kind: 'label', id: 'old', op: 'put', data: { label: 'Old' } },
  ], false);
  const out = plain(s.labelChanges({ hut: { label: 'Cabins' }, cafe: { label: 'Cafes', color: 1 } }));
  assert.deepEqual(out, [
    { kind: 'label', id: 'hut', op: 'put', data: { label: 'Cabins', color: 3 } },
    { kind: 'label', id: 'cafe', op: 'put', data: { label: 'Cafes', color: 1 } },
    { kind: 'label', id: 'old', op: 'delete' },
  ]);
  assert.deepEqual(plain(s.labelChanges({ hut: { label: 'Huts' }, old: { label: 'Old' } })), []);
});

test('fields the UI hangs on its copies never reach storage', () => {
  const { s } = makeEnv();
  assert.deepEqual(plain(s.stripUi({ id: 'a', name: 'b', _slug: 'b' })), { id: 'a', name: 'b' });
});
