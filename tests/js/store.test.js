'use strict';
// Runs the store's core (between the STORE-CORE markers in app/store.js) in
// vm, with IndexedDB and the API replaced by in-memory stand-ins: the v5
// migration, the manifest round trip, local edits against pulled changes,
// the push queue and the GPX call queue, GPX file operations and category
// labels.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const app = require('./app-source');
const m = /STORE-CORE-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ STORE-CORE-END/.exec(app);
assert.ok(m, 'STORE-CORE markers not found in app/');
const source = m[1] + `
globalThis.__s = { emptyMem, buildManifest, manifestItems, migrateV5, applyChanges, applyPull,
  pushPending, nextBatch, drainGpxOps, labelChanges, ROUTE_OPS, pkey, stripUi, opScope, scopesOverlap };
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
    BATCH_CHARS: 300000,
    opsCount: 0,
    gpxOpsFor: () => Promise.resolve([]),
    gpxFor: () => Promise.resolve([]),
    GPX_REST: {},
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

  assert.deepEqual(out.pending.map(p => [p.kind, p.id, p.op]), [['place', fresh, 'put']]);
  assert.equal(out.pending[0].data.id, fresh);
  assert.deepEqual(out.ops.map(o => o.method), ['uploadGpx', 'putMetadata']);
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

const httpError = (status, message) => Object.assign(new Error(message || 'HTTP ' + status), { status });
const places = (s, ids) => s.applyChanges(ids.map(id => ({ kind: 'place', id, op: 'put', data: { name: id } })), true);

test('pushPending keeps the whole queue on a server, proxy or session error', async () => {
  for (const status of [500, 502, 503, 401, 403, 429]) {
    const env = makeEnv({ api: () => Promise.reject(httpError(status)) });
    places(env.s, ['aaaaaaa1', 'aaaaaaa2']);
    await assert.rejects(env.s.pushPending(), undefined, 'HTTP ' + status);
    assert.equal(env.ctx.pendingMap.size, 2, 'HTTP ' + status + ' keeps both edits');
    assert.equal(env.ctx.syncState.epoch, null);
  }
});

test('pushPending halves a batch refused as a whole until the culprit is alone', async () => {
  for (const [status, msg] of [[409, 'too many category labels (max 200)'], [413, 'body too large'], [400, 'too many changes (max 500)']]) {
    const sent = [];
    const env = makeEnv({
      api: (method, path, body) => {
        const ids = body.changes.map(c => c.id);
        sent.push(ids);
        return ids.includes('aaaaaaa3') ? Promise.reject(httpError(status, msg)) : Promise.resolve({ ok: true });
      },
    });
    env.ctx.syncState = { rev: 9, epoch: 'e1' };
    places(env.s, ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3', 'aaaaaaa4']);
    const r = plain(await env.s.pushPending());
    assert.deepEqual(r, { pushed: 3, skipped: 1 }, 'HTTP ' + status);
    assert.equal(env.ctx.pendingMap.size, 0);
    assert.deepEqual(plain(sent[0]), ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3', 'aaaaaaa4']);
    assert.ok(sent.some(ids => ids.length === 1 && ids[0] === 'aaaaaaa3'), 'the culprit is sent alone before it is dropped');
    assert.equal(env.ctx.syncState.epoch, null, 'a drop asks the next pull for the whole set');
    assert.equal(env.ctx.syncState.rev, 9);
    assert.ok(env.writes.some(w => w.meta && w.meta[0][0] === 'sync::' + env.ctx.NS && w.meta[0][1].epoch === null), 'the reset survives a reload');
  }
});

test('pushPending keeps a successful push from resetting the sync', async () => {
  const env = makeEnv();
  env.ctx.syncState = { rev: 9, epoch: 'e1' };
  places(env.s, ['aaaaaaa1']);
  await env.s.pushPending();
  assert.equal(env.ctx.syncState.epoch, 'e1');
});

test('nextBatch stops at the character budget but always takes one change', () => {
  const { s, ctx } = makeEnv({ BATCH_CHARS: 1000 });
  const big = 'x'.repeat(600);
  s.applyChanges(['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3'].map(id => ({ kind: 'place', id, op: 'put', data: { name: big } })), true);
  assert.deepEqual(plain(s.nextBatch(500).map(p => p.id)), ['aaaaaaa1']);
  ctx.BATCH_CHARS = 10;
  assert.deepEqual(plain(s.nextBatch(500).map(p => p.id)), ['aaaaaaa1']);
  ctx.BATCH_CHARS = 300000;
  assert.deepEqual(plain(s.nextBatch(2).map(p => p.id)), ['aaaaaaa1', 'aaaaaaa2']);
});

test('drainGpxOps skips a refused call and stops, keeping it queued, when the server is unreachable', async () => {
  const rows = [
    { id: 1, ns: 'n', method: 'moveGpx', args: { key: 'A', new_region: 'West' } },
    { id: 2, ns: 'n', method: 'uploadGpx', args: { region: 'West', name: 'B' }, ref: 7 },
    { id: 3, ns: 'n', method: 'deleteGpx', args: { name: 'C' } },
  ];
  const fails = { moveGpx: httpError(404, 'route not found: A'), uploadGpx: httpError(502) };
  const called = [];
  const rest = {};
  for (const m of ['moveGpx', 'uploadGpx', 'deleteGpx']) rest[m] = () => { called.push(m); return fails[m] ? Promise.reject(fails[m]) : Promise.resolve({ ok: true }); };
  const env = makeEnv({ NS: 'n', opsCount: 3, GPX_REST: rest, gpxOpsFor: () => Promise.resolve(rows) });
  env.ctx.syncState = { rev: 4, epoch: 'e1' };
  const r = plain(await env.s.drainGpxOps('n'));
  assert.deepEqual(r, { synced: 0, skipped: 1, stopped: true, held: [], kept: [] });
  assert.deepEqual(called, ['moveGpx', 'uploadGpx'], 'nothing runs past the stop');
  assert.deepEqual(env.writes.filter(w => w.delOps).map(w => plain(w.delOps)), [[1]], 'the upload stays queued, its text with it');
  assert.equal(env.ctx.opsCount, 2);
  assert.equal(env.ctx.syncState.epoch, null, 'a skipped call asks the next pull for the whole set');

  // The text went under the upload's ref; a queued move has renamed it since.
  fails.uploadGpx = null;
  const gpx = [{ ns: 'n', file: 'East/B.gpx', text: '<gpx/>', ref: 7 }, { ns: 'n', file: 'West/B.gpx', text: '<other/>', ref: 9 }];
  const env2 = makeEnv({ NS: 'n', opsCount: 2, GPX_REST: rest, gpxOpsFor: () => Promise.resolve(rows.slice(1)), gpxFor: () => Promise.resolve(gpx) });
  assert.deepEqual(plain(await env2.s.drainGpxOps('n')), { synced: 2, skipped: 0, stopped: false, held: [], kept: [] });
  assert.deepEqual(plain(env2.writes.find(w => w.delGpx).delGpx), [['n', 'East/B.gpx']]);
});

test('an upload queued before refs existed finds its text by file name', async () => {
  const gpx = [{ ns: 'n', file: 'West/B.gpx', text: '<gpx/>' }, { ns: 'n', file: 'West/C.gpx', text: '<c/>' }];
  const env = makeEnv({
    NS: 'n', opsCount: 1,
    GPX_REST: { uploadGpx: () => Promise.resolve({ ok: true }) },
    gpxOpsFor: () => Promise.resolve([{ id: 1, ns: 'n', method: 'uploadGpx', args: { region: 'West', name: 'B' } }]),
    gpxFor: () => Promise.resolve(gpx),
  });
  await env.s.drainGpxOps('n');
  assert.deepEqual(plain(env.writes.find(w => w.delGpx).delGpx), [['n', 'West/B.gpx']]);
});

test('a call the server keeps failing holds only the calls on the same routes', async () => {
  const rows = [
    { id: 1, ns: 'n', method: 'uploadGpx', args: { region: 'West', name: 'A', text: '<a/>' }, ref: 1 },
    { id: 2, ns: 'n', method: 'moveGpx', args: { key: 'West/A', new_region: 'East' } },
    { id: 3, ns: 'n', method: 'deleteGpx', args: { region: 'North', name: 'C.gpx' } },
    { id: 4, ns: 'n', method: 'renameRegion', args: { from: 'East', to: 'South' } },
  ];
  const called = [];
  const rest = {};
  for (const m of ['uploadGpx', 'moveGpx', 'deleteGpx', 'renameRegion']) rest[m] = () => { called.push(m); return m === 'uploadGpx' ? Promise.reject(httpError(500, 'disk full')) : Promise.resolve({ ok: true }); };
  const env = makeEnv({ NS: 'n', opsCount: 4, GPX_REST: rest, gpxOpsFor: () => Promise.resolve(rows) });
  const r = plain(await env.s.drainGpxOps('n'));
  assert.equal(r.stopped, false);
  assert.equal(r.synced, 1);
  assert.deepEqual(called, ['uploadGpx', 'deleteGpx'], 'the move waits on the upload, the rename on the move');
  assert.deepEqual(r.held.map(h => h.keys.concat(h.regions)), [['West/A'], ['West/A', 'East/A'], ['East', 'South']]);
  assert.deepEqual(plain(env.writes.find(w => w.ops).ops), [{ ...rows[0], error: 'disk full' }], 'the failing call is marked, not dropped');
  assert.deepEqual(env.writes.filter(w => w.delOps).map(w => plain(w.delOps)), [[3]]);
  assert.equal(env.ctx.opsCount, 3);

  // A call already marked with the same error is not written again.
  env.writes.length = 0;
  rows[0].error = 'disk full';
  await env.s.drainGpxOps('n');
  assert.equal(env.writes.filter(w => w.ops).length, 0);
});

test('metadata edits on a held route wait, the rest push', async () => {
  const { s, ctx } = makeEnv();
  s.applyChanges([
    { kind: 'metadata', id: 'West/A', op: 'put', data: { notes: 'a' } },
    { kind: 'metadata', id: 'East/B', op: 'put', data: { notes: 'b' } },
    { kind: 'metadata', id: 'North/C', op: 'put', data: { notes: 'c' } },
    { kind: 'place', id: 'aaaaaaa1', op: 'put', data: { name: 'Hut' } },
  ], true);
  const held = [{ keys: ['West/A'], regions: [] }, { keys: [], regions: ['East'] }];
  assert.deepEqual(plain(s.nextBatch(500, held).map(p => p.id)), ['North/C', 'aaaaaaa1']);
  assert.equal(ctx.pendingMap.size, 4);
});

test('call scopes overlap on a shared route or region', () => {
  const { s } = makeEnv();
  const sc = row => plain(s.opScope(row));
  assert.deepEqual(sc({ method: 'uploadGpx', args: { region: 'West', name: 'A.planned' } }), { keys: ['West/A'], regions: [] });
  assert.deepEqual(sc({ method: 'deleteGpx', args: { name: 'A.gpx' } }), { keys: ['A'], regions: [] });
  assert.deepEqual(sc({ method: 'moveGpx', args: { key: 'West/A', new_name: 'B ' } }), { keys: ['West/A', 'B'], regions: [] });
  assert.deepEqual(sc({ method: 'clearRegion', args: { name: 'West' } }), { keys: [], regions: ['West', ''] });
  const up = s.opScope({ method: 'uploadGpx', args: { region: 'West', name: 'A' } });
  assert.equal(s.scopesOverlap(up, s.opScope({ method: 'deleteRegion', args: { name: 'West' } })), true);
  assert.equal(s.scopesOverlap(up, s.opScope({ method: 'setGpxCompleted', args: { key: 'West/B' } })), false);
  assert.equal(s.scopesOverlap(s.opScope({ method: 'clearRegion', args: { name: 'East' } }), s.opScope({ method: 'putMetadata', args: { key: 'Loop' } })), true, 'clearing a region moves routes into No region');
  assert.equal(s.scopesOverlap(up, s.opScope({ method: 'clearCategory', args: { category: 'x' } })), false);
});

test('a refused upload is kept on the device to save, and the toast names it', async () => {
  const gpx = [{ ns: 'n', file: 'West/A.gpx', text: '<device/>', ref: 3 }];
  const env = makeEnv({
    NS: 'n', opsCount: 1,
    GPX_REST: { uploadGpx: () => Promise.reject(httpError(413, 'file too large')) },
    gpxOpsFor: () => Promise.resolve([{ id: 5, ns: 'n', method: 'uploadGpx', args: { region: 'West', name: 'A' }, ref: 3 }]),
    gpxFor: () => Promise.resolve(gpx),
  });
  const r = plain(await env.s.drainGpxOps('n'));
  assert.deepEqual([r.skipped, r.kept], [1, ['West/A.gpx']]);
  const w = plain(env.writes.find(x => x.delOps));
  assert.deepEqual(w.delGpx, [['n', 'West/A.gpx']]);
  assert.equal(w.meta[0][0], 'kept::n::5');
  assert.deepEqual({ ...w.meta[0][1], ts: 0 }, { file: 'West/A.gpx', text: '<device/>', error: 'file too large', ts: 0 });
});

test('a paged pull marks the copy incomplete until the last page', () => {
  const { s, ctx } = makeEnv();
  s.applyPull({ rev: 5, next: 3, epoch: 'e1', more: true, changes: [] });
  assert.equal(ctx.syncState.more, true);
  s.applyPull({ rev: 5, next: 5, epoch: 'e1', changes: [] });
  assert.equal(!!ctx.syncState.more, false);
});

test('drainGpxOps stops on a network error', async () => {
  const env = makeEnv({
    NS: 'n', opsCount: 1,
    GPX_REST: { deleteGpx: () => Promise.reject(new Error('Network error')) },
    gpxOpsFor: () => Promise.resolve([{ id: 1, ns: 'n', method: 'deleteGpx', args: { name: 'C' } }]),
  });
  assert.deepEqual(plain(await env.s.drainGpxOps('n')), { synced: 0, skipped: 0, stopped: true, held: [], kept: [] });
  assert.equal(env.writes.length, 0);
});

test('migrateV5 replays metadata edits and category clears as calls, in queue order', () => {
  const { s } = makeEnv();
  const ns = 'https://ferd.test::own:bjorn';
  const route = (key, extra) => Object.assign({ key, file: key + '.gpx', name: key.split('/').pop(), completed: true }, extra);
  const out = plain(s.migrateV5({
    // As the v5 code left the cache: the move and rename applied, and the
    // removed region's routes gone from it (the server moves them instead).
    kv: [['local:metadata', {}]],
    gpx: [['North/Bay.gpx', { file: 'North/Bay.gpx', region: 'North', name: 'Bay', planned: false, text: '<gpx local only/>' }]],
    cache: [
      ['data::' + ns + '::places', { data: [{ id: 'c0ffee01', name: 'Cafe' }] }],
      ['data::' + ns + '::routes', { data: { regions: [
        { name: 'North', routes: [route('North/Ridge', { notes: 'edited' }), route('North/Bay')] },
      ] } }],
    ],
    outbox: [
      [1, { id: 1, ns, method: 'putMetadata', args: { key: 'West/Ridge', metadata: { notes: 'edited' } } }],
      [2, { id: 2, ns, method: 'moveGpx', args: { key: 'West/Ridge', new_region: 'North' } }],
      [3, { id: 3, ns, method: 'putMetadata', args: { key: 'Old/Peak', metadata: { notes: 'kept' } } }],
      [4, { id: 4, ns, method: 'clearRegion', args: { name: 'Old' } }],
      [5, { id: 5, ns, method: 'clearCategory', args: { category: 'hut' } }],
      [6, { id: 6, ns, method: 'uploadGpx', args: { region: 'South', name: 'Bay' }, file: 'South/Bay.gpx' }],
      [7, { id: 7, ns, method: 'moveGpx', args: { key: 'South/Bay', new_region: 'North' } }],
    ],
    // The v5 code renamed offline GPX text along with each move.
    pending_gpx: [['North/Bay.gpx', { file: 'North/Bay.gpx', text: '<gpx bay/>' }]],
  }));
  assert.deepEqual(out.pending, [], 'no metadata delete or place re-save is queued');
  assert.deepEqual(out.ops.map(o => [o.method, o.args.key || o.args.name || o.args.category]), [
    ['putMetadata', 'West/Ridge'], ['moveGpx', 'West/Ridge'], ['putMetadata', 'Old/Peak'], ['clearRegion', 'Old'],
    ['clearCategory', 'hut'], ['uploadGpx', 'Bay'], ['moveGpx', 'South/Bay'],
  ]);
  assert.deepEqual(out.gpx.filter(g => g.ns === ns), [{ ns, file: 'North/Bay.gpx', text: '<gpx bay/>' }], 'offline text under a moved name is kept');
  assert.deepEqual(out.gpx.filter(g => g.ns === 'local'), [{ ns: 'local', file: 'North/Bay.gpx', text: '<gpx local only/>' }], "local mode's file of the same name is left alone");
});

test('pushPending treats a 404 as a missing endpoint, not a refusal', async () => {
  const env = makeEnv({ api: () => Promise.reject(httpError(404, 'not found')) });
  places(env.s, ['aaaaaaa1', 'aaaaaaa2']);
  await assert.rejects(env.s.pushPending());
  assert.equal(env.ctx.pendingMap.size, 2);
});

test('pushPending goes back to full batches once the refused change is dropped', async () => {
  const sizes = [];
  const env = makeEnv({
    BATCH_MAX: 8,
    api: (method, path, body) => {
      const ids = body.changes.map(c => c.id);
      sizes.push(ids.length);
      return ids.includes('aaaaaa01') ? Promise.reject(httpError(409, 'too many category labels')) : Promise.resolve({ ok: true });
    },
  });
  places(env.s, Array.from({ length: 17 }, (_, i) => 'aaaaaa' + (i + 1).toString(16).padStart(2, '0')));
  assert.deepEqual(plain(await env.s.pushPending()), { pushed: 16, skipped: 1 });
  assert.deepEqual(sizes, [8, 4, 2, 1, 8, 8]);
});

test('a skipped GPX call resets the namespace it belongs to, not the one on screen', async () => {
  const env = makeEnv({
    NS: 'shown',
    GPX_REST: { deleteGpx: () => Promise.reject(httpError(404)) },
    gpxOpsFor: () => Promise.resolve([{ id: 1, ns: 'other', method: 'deleteGpx', args: { name: 'C' } }]),
  });
  env.ctx.syncState = { rev: 7, epoch: 'e1' };
  await env.s.drainGpxOps('other');
  assert.equal(env.ctx.syncState.epoch, 'e1');
  assert.deepEqual(plain(env.writes.find(w => w.meta).meta), [['sync::other', { rev: 0, epoch: null }]]);
});
