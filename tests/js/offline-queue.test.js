'use strict';
// Runs the offline write queue straight out of index.html, between the
// OFFLINE-QUEUE markers, against an in-memory IndexedDB stand-in. The markers
// are the only coupling: moving the section to its own file later only
// changes how `source` is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
const m = /OFFLINE-QUEUE-BEGIN[^\n]*\n([\s\S]*?)\n\s*\/\/ OFFLINE-QUEUE-END/.exec(html);
assert.ok(m, 'OFFLINE-QUEUE markers not found in index.html');
const source = m[1] + `
globalThis.__q = { OPS, mutate, offlineWrite, drainOutbox, remapArgs, currentNs,
  applyCreatePlace, applyUpdatePlace, applyDeletePlace, applyClearCategory,
  applyPutCategoryLabels, applyUploadGpx, applySetCompleted, applyMoveGpx,
  applyDeleteGpx, applyRenameRegion, applyClearRegion, applyPutMetadata };`;

// Stores mirror the schema: 'cache' and 'pending_gpx' are keyed, 'outbox'
// autoincrements `id`. Reads hand back a fresh copy like real IndexedDB.
function makeEnv(overrides = {}) {
  const stores = { cache: new Map(), outbox: new Map(), pending_gpx: new Map() };
  let nextId = 1;
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const calls = { api: [], upload: [], toast: [], refresh: 0, banner: 0 };
  const ctx = {
    console, Date, JSON, Promise, Object, Array, Error,
    state: { viewer: null, auth: { username: 'bjorn' }, places: [], manifest: { regions: [] }, config: {} },
    navigator: { onLine: true },
    _serverBase: () => 'https://ferd.test',
    dataCacheKey: kind => 'ferd:' + kind,
    isReadOnly: () => false,
    isLocalMode: () => false,
    _genId: (() => { let n = 0; return () => 'local' + (++n); })(),
    normalizePlaceTags: p => p,
    normalizeTags: t => (Array.isArray(t) ? t : []),
    ROUTE_META_FIELDS: ['source', 'date_completed', 'rating', 'notes', 'tags', 'difficulty', 'local_name'],
    _splitKey: key => {
      const parts = (key || '').split('/');
      return parts.length === 2 ? { region: parts[0], name: parts[1] } : { region: '', name: parts[0] };
    },
    parseGpxText: () => ({ hasElevation: true, bbox: [0, 0, 1, 1], trackCount: 1 }),
    stripGpxPiiText: t => t.replace('PII', ''),
    idbGet: (store, key) => Promise.resolve(clone(stores[store].get(key))),
    idbSet: (store, key, val) => { stores[store].set(key, clone(val)); return Promise.resolve(); },
    idbPut: (store, val) => {
      val = clone(val);
      if (store === 'outbox') val.id = nextId++;
      stores[store].set(store === 'pending_gpx' ? val.file : val.id, val);
      return Promise.resolve(val);
    },
    idbGetAll: store => Promise.resolve([...stores[store].values()].map(clone)),
    idbDeleteKey: (store, key) => { stores[store].delete(key); return Promise.resolve(); },
    idbClear: store => { stores[store].clear(); return Promise.resolve(); },
    api: (method, url, body) => { calls.api.push({ method, url, body }); return Promise.resolve({ ok: true }); },
    apiUrl: u => u,
    applyAuth: o => o,
    fetch: () => { throw new Error('unexpected fetch'); },
    refreshPlaces: () => { calls.refresh++; return Promise.resolve(); },
    refreshRoutes: () => Promise.resolve(),
    wrappedRouter: () => {},
    updateOfflineBanner: () => { calls.banner++; },
    showSyncToast: (synced, skipped) => calls.toast.push([synced, skipped]),
    ...overrides,
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { q: ctx.__q, ctx, stores, calls };
}
const blob = (stores, kind) => stores.cache.get('ferd:' + kind).data;
const seed = (stores, kind, data) => stores.cache.set('ferd:' + kind, { data, ts: 0 });
const NS = 'https://ferd.test::own:bjorn';
const row = (id, method, args, extra = {}) => ({ id, ns: NS, method, args, ts: 0, ...extra });

test('remapArgs rewrites update/delete ids only when the id was mapped', () => {
  const { q } = makeEnv();
  const args = { id: 'local1', place: {} };
  assert.deepEqual(q.remapArgs('updatePlace', args, { local1: 'srv1' }).id, 'srv1');
  assert.equal(q.remapArgs('deletePlace', { id: 'x' }, { local1: 'srv1' }).id, 'x');
  assert.equal(q.remapArgs('updatePlace', args, {}), args);
  assert.equal(q.remapArgs('putMetadata', { id: 'local1' }, { local1: 'srv1' }).id, 'local1');
});

test('applyCreatePlace assigns a client id and defaults category', async () => {
  const { q, stores } = makeEnv();
  seed(stores, 'places', [{ id: 'a', name: 'A', category: 'x' }]);
  const r = await q.applyCreatePlace({ name: 'B' });
  assert.equal(r.place.id, 'local1');
  assert.equal(r.place.category, '');
  assert.equal(r.total_places, 2);
  assert.equal(blob(stores, 'places').length, 2);
});

test('applyCreatePlace seeds from in-memory state when the cache is empty', async () => {
  const { q, ctx, stores } = makeEnv();
  ctx.state.places = [{ id: 'a', name: 'A' }];
  await q.applyCreatePlace({ name: 'B' });
  assert.deepEqual(blob(stores, 'places').map(p => p.id), ['a', 'local1']);
});

test('update, delete and clearCategory touch only the matching places', async () => {
  const { q, stores } = makeEnv();
  seed(stores, 'places', [{ id: 'a', category: 'x' }, { id: 'b', category: 'y' }, { id: 'c', category: 'x' }]);
  await q.applyUpdatePlace({ id: 'b', place: { name: 'B2' } });
  assert.deepEqual(blob(stores, 'places')[1], { name: 'B2', id: 'b', category: '' });
  const del = await q.applyDeletePlace({ id: 'a' });
  assert.equal(del.total_places, 2);
  const clr = await q.applyClearCategory({ category: ' x ' });
  assert.equal(clr.cleared, 1);
  assert.deepEqual(blob(stores, 'places').map(p => p.category), ['', '']);
});

test('applyPutCategoryLabels merges per slug instead of replacing', async () => {
  const { q, stores } = makeEnv();
  seed(stores, 'category-labels', { category_labels: { hike: { label: 'Hike', order: 1 } } });
  await q.applyPutCategoryLabels({ category_labels: { hike: { label: 'Walk' }, bike: { label: 'Bike' } } });
  assert.deepEqual(blob(stores, 'category-labels').category_labels, {
    hike: { label: 'Walk', order: 1 }, bike: { label: 'Bike' },
  });
});

const gpx = text => ({ text: () => Promise.resolve(text) });

test('applyUploadGpx stores bytes in pending_gpx and builds a walked entry', async () => {
  const { q, stores } = makeEnv();
  const r = await q.applyUploadGpx({ region: 'Alps', name: 'Col', file: gpx('<gpx/>PII'), stripPii: true });
  assert.equal(r.__file, 'Alps/Col.gpx');
  assert.equal(stores.pending_gpx.get('Alps/Col.gpx').text, '<gpx/>');
  const e = blob(stores, 'routes').regions[0].routes[0];
  assert.deepEqual([e.key, e.file, e.completed, e.hasElevation], ['Alps/Col', 'Alps/Col.gpx', true, true]);
});

test('a planned upload becomes the primary file only until a walked one exists', async () => {
  const { q, stores } = makeEnv();
  await q.applyUploadGpx({ name: 'Col.planned', file: gpx('p') });
  let e = blob(stores, 'routes').regions[0].routes[0];
  assert.deepEqual([e.key, e.file, e.plannedFile, e.completed], ['Col', 'Col.planned.gpx', 'Col.planned.gpx', false]);
  await q.applyUploadGpx({ name: 'Col', file: gpx('w') });
  await q.applyUploadGpx({ name: 'Col.planned', file: gpx('p2') });
  e = blob(stores, 'routes').regions[0].routes[0];
  assert.deepEqual([e.file, e.completed], ['Col.gpx', true]);
});

test('applySetCompleted flips planned to walked and rekeys the pending bytes', async () => {
  const { q, stores } = makeEnv();
  await q.applyUploadGpx({ name: 'Col.planned', file: gpx('p') });
  await q.applySetCompleted({ key: 'Col', completed: true });
  const e = blob(stores, 'routes').regions[0].routes[0];
  assert.deepEqual([e.file, e.completed, e.plannedFile], ['Col.gpx', true, undefined]);
  assert.ok(stores.pending_gpx.has('Col.gpx') && !stores.pending_gpx.has('Col.planned.gpx'));
});

test('applyMoveGpx rekeys the entry and bytes; no-op moves report moved 0', async () => {
  const { q, stores } = makeEnv();
  await q.applyUploadGpx({ name: 'Col', file: gpx('w') });
  assert.equal((await q.applyMoveGpx({ key: 'Col', new_name: 'Col' })).moved, 0);
  const r = await q.applyMoveGpx({ key: 'Col', new_region: 'Alps', new_name: 'Pass' });
  assert.deepEqual([r.new_key, r.moved], ['Alps/Pass', 1]);
  assert.ok(stores.pending_gpx.has('Alps/Pass.gpx') && !stores.pending_gpx.has('Col.gpx'));
  const reg = blob(stores, 'routes').regions;
  assert.deepEqual(reg.map(g => g.name), ['Alps']);
});

test('applyDeleteGpx strips .gpx and drops both pending files; empty regions vanish', async () => {
  const { q, stores } = makeEnv();
  await q.applyUploadGpx({ region: 'Alps', name: 'Col', file: gpx('w') });
  await q.applyDeleteGpx({ region: 'Alps', name: 'Col.GPX' });
  assert.equal(stores.pending_gpx.size, 0);
  assert.deepEqual(blob(stores, 'routes').regions, []);
});

test('applyRenameRegion moves routes to the new region and rekeys bytes', async () => {
  const { q, stores } = makeEnv();
  await q.applyUploadGpx({ region: 'Old', name: 'Col', file: gpx('w') });
  assert.equal((await q.applyRenameRegion({ from: 'Old', to: 'New' })).renamed, 1);
  const reg = blob(stores, 'routes').regions;
  assert.deepEqual([reg.length, reg[0].name, reg[0].routes[0].key], [1, 'New', 'New/Col']);
  assert.ok(stores.pending_gpx.has('New/Col.gpx'));
});

test('manifest normalisation sorts routes by name and the unnamed region last', async () => {
  const { q, stores } = makeEnv();
  await q.applyUploadGpx({ name: 'Z', file: gpx('a') });
  await q.applyUploadGpx({ region: 'B', name: 'b', file: gpx('a') });
  await q.applyUploadGpx({ region: 'A', name: 'y', file: gpx('a') });
  await q.applyUploadGpx({ region: 'A', name: 'x', file: gpx('a') });
  const regs = blob(stores, 'routes').regions;
  assert.deepEqual(regs.map(r => r.name), ['A', 'B', '']);
  assert.deepEqual(regs[0].routes.map(r => r.name), ['x', 'y']);
});

test('applyPutMetadata copies known fields, drops absent ones, empties tags', async () => {
  const { q, stores } = makeEnv();
  await q.applyUploadGpx({ name: 'Col', file: gpx('w') });
  await q.applyPutMetadata({ key: 'Col', metadata: { rating: 4, notes: 'n', tags: ['a'] } });
  await q.applyPutMetadata({ key: 'Col', metadata: { rating: 5, tags: [] } });
  const e = blob(stores, 'routes').regions[0].routes[0];
  assert.deepEqual([e.rating, e.notes, e.tags], [5, undefined, undefined]);
});

test('mutate: read-only viewers go straight to the server', async () => {
  const { q, calls } = makeEnv({ isReadOnly: () => true, navigator: { onLine: false } });
  await q.mutate('deletePlace', { id: 'a' });
  assert.equal(calls.api.length, 1);
});

test('mutate: known-offline writes skip the request and queue', async () => {
  const { q, calls, stores } = makeEnv({ navigator: { onLine: false } });
  seed(stores, 'places', []);
  await q.mutate('createPlace', { name: 'A' });
  assert.equal(calls.api.length, 0);
  const rows = [...stores.outbox.values()];
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].ns, rows[0].method, rows[0].localId], [NS, 'createPlace', 'local1']);
  assert.ok(calls.banner > 0);
});

test('mutate: an HTTP error rethrows, a network error queues', async () => {
  const httpErr = Object.assign(new Error('bad'), { status: 422 });
  let env = makeEnv({ api: () => Promise.reject(httpErr) });
  await assert.rejects(env.q.mutate('deletePlace', { id: 'a' }), httpErr);
  assert.equal(env.stores.outbox.size, 0);

  env = makeEnv({ api: () => Promise.reject(new TypeError('Failed to fetch')) });
  seed(env.stores, 'places', [{ id: 'a' }]);
  await env.q.mutate('deletePlace', { id: 'a' });
  assert.equal(env.stores.outbox.size, 1);
  assert.deepEqual(blob(env.stores, 'places'), []);
});

test('offlineWrite records the pending file for uploads', async () => {
  const { q, stores } = makeEnv({ navigator: { onLine: false } });
  await q.mutate('uploadGpx', { name: 'Col', file: gpx('w') });
  assert.equal([...stores.outbox.values()][0].file, 'Col.gpx');
});

test('drainOutbox replays this namespace in id order and maps created place ids', async () => {
  const sent = [];
  const { q, stores, calls } = makeEnv({
    api: (method, url, body) => {
      sent.push([method, url, body]);
      return Promise.resolve(url === '/places' && method === 'POST' ? { place: { id: 'srv1' } } : { ok: true });
    },
  });
  stores.outbox.set(2, row(2, 'updatePlace', { id: 'local1', place: { name: 'N' } }));
  stores.outbox.set(1, row(1, 'createPlace', { name: 'N' }, { localId: 'local1' }));
  stores.outbox.set(3, { ...row(3, 'deletePlace', { id: 'z' }), ns: 'other::own:x' });
  await q.drainOutbox();
  assert.deepEqual(sent.map(s => s[0] + ' ' + s[1]), ['POST /places', 'PUT /places']);
  assert.equal(sent[1][2].id, 'srv1');
  assert.deepEqual([...stores.outbox.keys()], [3]);
  assert.deepEqual(calls.toast, [[2, 0]]);
});

test('drainOutbox skips a definitive error and stops on a network error', async () => {
  const sent = [];
  const { q, stores, calls } = makeEnv({
    api: (method, url, body) => {
      sent.push(body.id);
      if (body.id === 'conflict') return Promise.reject(Object.assign(new Error('x'), { status: 409 }));
      if (body.id === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: true });
    },
  });
  for (const [i, id] of ['conflict', 'ok', 'offline', 'never'].entries()) stores.outbox.set(i + 1, row(i + 1, 'deletePlace', { id }));
  await q.drainOutbox();
  assert.deepEqual(sent, ['conflict', 'ok', 'offline']);
  assert.deepEqual([...stores.outbox.keys()], [3, 4]);
  assert.deepEqual(calls.toast, [[1, 1]]);
});

test('drainOutbox clears pending_gpx once the queue is empty and drops uploaded bytes', async () => {
  const { q, stores } = makeEnv({
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
  });
  stores.pending_gpx.set('Col.gpx', { file: 'Col.gpx', text: 'w' });
  stores.outbox.set(1, row(1, 'uploadGpx', { name: 'Col', file: gpx('w') }, { file: 'Col.gpx' }));
  await q.drainOutbox();
  assert.equal(stores.outbox.size, 0);
  assert.equal(stores.pending_gpx.size, 0);
});

test('drainOutbox does nothing when offline, read-only or in local mode', async () => {
  for (const o of [{ navigator: { onLine: false } }, { isReadOnly: () => true }, { isLocalMode: () => true }]) {
    const { q, stores, calls } = makeEnv(o);
    stores.outbox.set(1, row(1, 'deletePlace', { id: 'a' }));
    await q.drainOutbox();
    assert.equal(calls.api.length, 0);
    assert.equal(stores.outbox.size, 1);
  }
});
