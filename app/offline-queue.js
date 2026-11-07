import { state } from './core.js';
import { applyAuth, categoryLabelsUrl, dataUrl, isReadOnly } from './server.js';
import {
  _serverBase, cachedRead, dataCacheKey, idbClear, idbDeleteKey, idbGet, idbGetAll, idbPut,
  idbSet, localLog, logLocal,
} from './device-cache.js';
import {
  ROUTE_META_FIELDS, _genId, _splitKey, isLocalMode, localStore, parseGpxText, stripGpxPiiText,
} from './local-mode.js';
import { normalizePlaceTags, normalizeTags } from './tags.js';
import { api, apiUrl } from './auth.js';
import { refreshAreas, refreshPlaces, refreshRoutes } from './select.js';
import { wrappedRouter } from './pick-coords.js';

// When a server-mode write can't reach the server, it is applied
// optimistically to the on-device cache blob (the same one cachedRead
// hydrates from) and queued in the 'outbox' store for replay on
// reconnect. Because every call site refreshes through cachedRead after a
// write, mutating the cache blob makes the edit appear immediately and
// survive reload with no call-site changes. drainOutbox replays the queue
// in FIFO order (last-write-wins; skip + notify on a definitive conflict).

// OFFLINE-QUEUE-BEGIN (tests/js/offline-queue.test.js runs the code between these markers)
// Namespace the queue by server origin + viewer identity, mirroring
// dataCacheKey, so edits to one map never replay against another.
function currentNs() {
  const v = state.viewer;
  const who = (v && v.mode === 'public') ? 'pub:' + v.username : 'own:' + ((state.auth && state.auth.username) || '?');
  return _serverBase() + '::' + who;
}
// Cache-blob accessors. Reads fall back to a clone of the in-memory state
// if the cache was never populated (defensive; normal loads always cache).
function _readBlob(kind, seed) {
  return idbGet('cache', dataCacheKey(kind)).then(rec =>
    (rec && rec.data != null) ? rec.data : JSON.parse(JSON.stringify(seed)));
}
function _writeBlob(kind, data) { return idbSet('cache', dataCacheKey(kind), { data, ts: Date.now() }); }

// -- optimistic apply: places blob (array) --
function applyCreatePlace(payload) {
  return _readBlob('places', state.places || []).then(arr => {
    const place = normalizePlaceTags(Object.assign({}, payload, { id: _genId() }));
    if (place.category == null) place.category = '';
    const next = arr.concat([place]);
    return _writeBlob('places', next).then(() => ({ ok: true, place, total_places: next.length }));
  });
}
function applyUpdatePlace(body) {
  return _readBlob('places', state.places || []).then(arr => {
    const next = normalizePlaceTags(Object.assign({}, body.place, { id: body.id }));
    if (next.category == null) next.category = '';
    return _writeBlob('places', arr.map(p => p.id === body.id ? next : p)).then(() => ({ ok: true, place: next }));
  });
}
function applyDeletePlace(body) {
  return _readBlob('places', state.places || []).then(arr => {
    const next = arr.filter(p => p.id !== body.id);
    return _writeBlob('places', next).then(() => ({ ok: true, total_places: next.length }));
  });
}
function applyClearCategory(body) {
  const target = (body.category || '').trim();
  const clearIn = (kind, seed) => _readBlob(kind, seed).then(arr => {
    let cleared = 0;
    const next = arr.map(p => { if (p && p.category === target) { cleared++; return Object.assign({}, p, { category: '' }); } return p; });
    return _writeBlob(kind, next).then(() => cleared);
  });
  return clearIn('places', state.places || []).then(a =>
    clearIn('areas', state.areas || []).then(b => ({ ok: true, cleared: a + b })));
}
function applyCreateArea(payload) {
  return _readBlob('areas', state.areas || []).then(arr => {
    const area = Object.assign({}, payload, { id: _genId() });
    if (area.category == null) area.category = '';
    const next = arr.concat([area]);
    return _writeBlob('areas', next).then(() => ({ ok: true, area, total_areas: next.length }));
  });
}
function applyUpdateArea(body) {
  return _readBlob('areas', state.areas || []).then(arr => {
    const next = Object.assign({}, body.area, { id: body.id });
    if (next.category == null) next.category = '';
    return _writeBlob('areas', arr.map(a => a.id === body.id ? next : a)).then(() => ({ ok: true, area: next }));
  });
}
function applyDeleteArea(body) {
  return _readBlob('areas', state.areas || []).then(arr => {
    const next = arr.filter(a => a.id !== body.id);
    return _writeBlob('areas', next).then(() => ({ ok: true, total_areas: next.length }));
  });
}
// -- optimistic apply: category labels blob --
function applyPutCategoryLabels(body) {
  return _readBlob('category-labels', { category_labels: (state.config && state.config.category_labels) || {} }).then(cur => {
    const next = Object.assign({}, (cur && cur.category_labels) || {});
    const incoming = body.category_labels || {};
    for (const slug in incoming) next[slug] = Object.assign({}, next[slug], incoming[slug]);
    return _writeBlob('category-labels', { category_labels: next }).then(() => ({ ok: true }));
  });
}

// -- optimistic apply: routes manifest blob --
// The cached routes blob is the server manifest shape
// ({ regions: [{ name, routes: [entry] }] }); entries collapse a route's
// walked + planned siblings into one record (file = primary, completed
// flag, optional plannedFile). These helpers mutate that shape to match
// what buildLocalManifest would produce. completed===true means a walked
// file exists (entry.file is it); plannedFile present means a planned file
// exists. GPX bytes for offline uploads live in 'pending_gpx', re-keyed
// alongside the manifest when a route's file path changes.
// Returns a private, mutable copy of the cached manifest: idbGet
// deserializes a fresh object per call (and the seed path clones), so the
// apply helpers mutate it in place without a defensive clone.
function _routesBlob() { return _readBlob('routes', state.manifest || { regions: [] }); }
function _mfRegion(m, name) { return (m.regions || []).find(r => r.name === (name || '')) || null; }
function _mfEnsure(m, name) {
  let r = _mfRegion(m, name);
  if (!r) { r = { name: name || '', routes: [] }; m.regions.push(r); }
  return r;
}
function _mfFind(m, key) {
  for (const reg of m.regions || []) { const e = reg.routes.find(x => x.key === key); if (e) return { reg, entry: e }; }
  return null;
}
function _mfNormalize(m) {
  m.regions = (m.regions || []).filter(r => r.routes.length);
  m.regions.sort((a, b) => (a.name === '' ? 1 : 0) - (b.name === '' ? 1 : 0) || a.name.localeCompare(b.name));
  for (const reg of m.regions) reg.routes.sort((a, b) => a.name.localeCompare(b.name));
  return m;
}
function _routeFiles(key) {
  const { region, name } = _splitKey(key);
  const pre = region ? region + '/' : '';
  return { region, name, walked: pre + name + '.gpx', planned: pre + name + '.planned.gpx' };
}
function _rekeyPendingGpx(oldF, newF) {
  if (oldF === newF) return Promise.resolve();
  return idbGet('pending_gpx', oldF).then(rec => {
    if (!rec) return;
    return idbDeleteKey('pending_gpx', oldF).then(() => idbPut('pending_gpx', { file: newF, text: rec.text }));
  });
}
function _applyParse(entry, meta) {
  entry.hasElevation = !!meta.hasElevation;
  if (meta.bbox) entry.bbox = meta.bbox; else delete entry.bbox;
  if (meta.trackCount && meta.trackCount > 1) { entry.trackCount = meta.trackCount; entry.trackNames = meta.trackNames; }
  else { delete entry.trackCount; delete entry.trackNames; }
}
async function applyUploadGpx(opts) {
  const region = opts.region || '';
  const storedName = opts.name;
  const planned = storedName.endsWith('.planned');
  const stem = planned ? storedName.slice(0, -'.planned'.length) : storedName;
  const file = (region ? region + '/' : '') + storedName + '.gpx';
  const key = region ? region + '/' + stem : stem;
  const raw = await opts.file.text();
  const text = opts.stripPii ? stripGpxPiiText(raw) : raw;
  const meta = parseGpxText(text);
  await idbPut('pending_gpx', { file, text });
  const m = await _routesBlob();
  let found = _mfFind(m, key), entry;
  if (found) entry = found.entry;
  else { entry = { key, name: stem }; _mfEnsure(m, region).routes.push(entry); }
  if (planned) {
    entry.plannedFile = file;
    if (entry.completed !== true) { entry.file = file; entry.completed = false; _applyParse(entry, meta); }
  } else {
    entry.file = file; entry.completed = true; _applyParse(entry, meta);
  }
  await _writeBlob('routes', _mfNormalize(m));
  return { ok: true, __file: file };
}
async function applySetCompleted(body) {
  const f = _routeFiles(body.key);
  const m = await _routesBlob();
  const found = _mfFind(m, body.key);
  if (!found) return { ok: true };
  const e = found.entry, walked = e.completed === true, hasPlanned = !!e.plannedFile;
  if (body.completed) {
    if (walked || !hasPlanned) return { ok: true };
    await _rekeyPendingGpx(f.planned, f.walked);
    e.completed = true; e.file = f.walked; delete e.plannedFile;
  } else {
    if (hasPlanned || !walked) return { ok: true };
    await _rekeyPendingGpx(f.walked, f.planned);
    e.completed = false; e.file = f.planned; e.plannedFile = f.planned;
  }
  await _writeBlob('routes', _mfNormalize(m));
  return { ok: true };
}
async function applyMoveGpx(body) {
  const src = _splitKey(body.key);
  const newRegion = body.new_region || '';
  const finalName = ((body.new_name || src.name) + '').trim();
  const newKey = (newRegion ? newRegion + '/' : '') + finalName;
  if (src.region === newRegion && src.name === finalName) return { ok: true, old_key: body.key, new_key: body.key, moved: 0 };
  const m = await _routesBlob();
  const found = _mfFind(m, body.key);
  if (!found) return { ok: true, old_key: body.key, new_key: newKey, moved: 0 };
  const e = found.entry, of = _routeFiles(body.key), nf = _routeFiles(newKey);
  found.reg.routes = found.reg.routes.filter(x => x !== e);
  if (e.completed === true) await _rekeyPendingGpx(of.walked, nf.walked);
  if (e.plannedFile) await _rekeyPendingGpx(of.planned, nf.planned);
  e.key = newKey; e.name = finalName;
  e.file = e.completed === true ? nf.walked : nf.planned;
  if (e.plannedFile) e.plannedFile = nf.planned;
  _mfEnsure(m, newRegion).routes.push(e);
  await _writeBlob('routes', _mfNormalize(m));
  return { ok: true, old_key: body.key, new_key: newKey, moved: 1 };
}
async function applyPutMetadata(body) {
  const m = await _routesBlob();
  const found = _mfFind(m, body.key);
  if (!found) return { ok: true };
  const e = found.entry, md = Object.assign({}, body.metadata || {});
  if ('tags' in md) { const t = normalizeTags(md.tags); if (t.length) md.tags = t; else delete md.tags; }
  for (const fld of ROUTE_META_FIELDS) { if (fld in md) e[fld] = md[fld]; else delete e[fld]; }
  await _writeBlob('routes', m);
  return { ok: true };
}
async function applyDeleteGpx(body) {
  const region = body.region || '';
  let name = body.name || '';
  if (name.toLowerCase().endsWith('.gpx')) name = name.slice(0, -4);
  const key = region ? region + '/' + name : name;
  const m = await _routesBlob();
  const found = _mfFind(m, key);
  if (found) {
    found.reg.routes = found.reg.routes.filter(x => x.key !== key);
    const f = _routeFiles(key);
    await idbDeleteKey('pending_gpx', f.walked); await idbDeleteKey('pending_gpx', f.planned);
  }
  await _writeBlob('routes', _mfNormalize(m));
  return { ok: true };
}
async function applyRenameRegion(body) {
  const from = body.from || '', to = body.to || '';
  if (from === to) return { ok: true, renamed: 0 };
  const m = await _routesBlob();
  const reg = _mfRegion(m, from);
  if (!reg) return { ok: true, renamed: 0 };
  const dest = _mfEnsure(m, to);
  for (const e of reg.routes.slice()) {
    const of = _routeFiles(e.key), nf = _routeFiles((to ? to + '/' : '') + e.name);
    if (e.completed === true) await _rekeyPendingGpx(of.walked, nf.walked);
    if (e.plannedFile) await _rekeyPendingGpx(of.planned, nf.planned);
    e.key = (to ? to + '/' : '') + e.name;
    e.file = e.completed === true ? nf.walked : nf.planned;
    if (e.plannedFile) e.plannedFile = nf.planned;
    dest.routes.push(e);
  }
  reg.routes = [];
  await _writeBlob('routes', _mfNormalize(m));
  return { ok: true, renamed: 1 };
}
async function applyClearRegion(body) {
  const name = body.name || '';
  const m = await _routesBlob();
  const reg = _mfRegion(m, name);
  if (reg) {
    for (const e of reg.routes) { const f = _routeFiles(e.key); await idbDeleteKey('pending_gpx', f.walked); await idbDeleteKey('pending_gpx', f.planned); }
    reg.routes = [];
  }
  await _writeBlob('routes', _mfNormalize(m));
  return { ok: true };
}

// Per-method registry: replay() is the online HTTP call (used live and on
// drain); apply() mutates the cache blob optimistically when offline.
function _gpxUploadRequest(a) {
  const region = a.region || '';
  let qs = (region ? '?region=' + encodeURIComponent(region) + '&' : '?') + 'name=' + encodeURIComponent(a.name);
  if (a.stripPii) qs += '&strip_pii=true';
  return fetch(apiUrl('/gpx') + qs, applyAuth({ method: 'POST', headers: { 'Content-Type': 'application/gpx+xml' }, body: a.file })).then(async r => {
    const data = await r.json().catch(() => null);
    if (!r.ok) { const e = new Error((data && data.error) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return data;
  });
}
const OPS = {
  createPlace:       { replay: a => api('POST', '/places', a),                 apply: applyCreatePlace },
  updatePlace:       { replay: a => api('PUT', '/places', a),                  apply: applyUpdatePlace },
  deletePlace:       { replay: a => api('DELETE', '/places', a),               apply: applyDeletePlace },
  clearCategory:     { replay: a => api('POST', '/places/clear-category', a),  apply: applyClearCategory },
  createArea:        { replay: a => api('POST', '/areas', a),                  apply: applyCreateArea },
  updateArea:        { replay: a => api('PUT', '/areas', a),                   apply: applyUpdateArea },
  deleteArea:        { replay: a => api('DELETE', '/areas', a),                apply: applyDeleteArea },
  uploadGpx:         { replay: _gpxUploadRequest,                              apply: applyUploadGpx },
  deleteGpx:         { replay: a => api('DELETE', '/gpx', a),                  apply: applyDeleteGpx },
  setGpxCompleted:   { replay: a => api('POST', '/gpx/set-completed', a),      apply: applySetCompleted },
  moveGpx:           { replay: a => api('POST', '/gpx/move', a),              apply: applyMoveGpx },
  putMetadata:       { replay: a => api('PUT', '/metadata', a),               apply: applyPutMetadata },
  renameRegion:      { replay: a => api('POST', '/regions/rename', a),         apply: applyRenameRegion },
  deleteRegion:      { replay: a => api('POST', '/regions/delete', a),         apply: () => Promise.resolve({ ok: true }) },
  clearRegion:       { replay: a => api('POST', '/regions/clear', a),          apply: applyClearRegion },
  putCategoryLabels: { replay: a => api('PUT', '/me/category-labels', a),      apply: applyPutCategoryLabels },
};

// Server-mode write dispatch: try the server when online, fall back to the
// offline path on a network failure (a definitive HTTP error still throws
// so real validation errors surface). When known-offline, skip the doomed
// request entirely. Read-only (public) viewers can't write, so let the
// server reject as before.
function mutate(method, args) {
  if (isReadOnly()) return OPS[method].replay(args);
  if (!navigator.onLine) return offlineWrite(method, args);
  return OPS[method].replay(args).catch(err => {
    if (err && err.status) throw err;
    return offlineWrite(method, args);
  });
}
function offlineWrite(method, args) {
  return Promise.resolve(OPS[method].apply(args)).then(result => {
    const entry = { ns: currentNs(), method, args, ts: Date.now() };
    if (method === 'createPlace' && result && result.place) entry.localId = result.place.id;
    if (method === 'createArea' && result && result.area) entry.localId = result.area.id;
    if (method === 'uploadGpx' && result && result.__file) entry.file = result.__file;
    return idbPut('outbox', entry).then(() => { updateOfflineBanner(); return result; });
  });
}
// Rewrite a queued op's args at replay time: a place or area created offline
// got a client id; once it replays the server assigns the real id, so later
// edits of it must target the server id. Routes key on stable names.
const ID_KEYED_OPS = new Set(['updatePlace', 'deletePlace', 'updateArea', 'deleteArea']);
function remapArgs(method, args, idMap) {
  if (ID_KEYED_OPS.has(method) && args && idMap[args.id]) {
    return Object.assign({}, args, { id: idMap[args.id] });
  }
  return args;
}
let _draining = false;
export function drainOutbox() {
  if (_draining || isLocalMode() || isReadOnly() || !navigator.onLine) return Promise.resolve();
  const ns = currentNs();
  _draining = true;
  const idMap = {};
  let synced = 0, skipped = 0, stopped = false;
  return idbGetAll('outbox').then(rows => {
    rows = (rows || []).filter(r => r.ns === ns).sort((a, b) => a.id - b.id);
    return rows.reduce((chain, row) => chain.then(() => {
      if (stopped) return;
      const args = remapArgs(row.method, row.args, idMap);
      return OPS[row.method].replay(args).then(resp => {
        const created = resp && (row.method === 'createPlace' ? resp.place : row.method === 'createArea' ? resp.area : null);
        if (row.localId && created && created.id) idMap[row.localId] = created.id;
        synced++;
        return idbDeleteKey('outbox', row.id).then(() => {
          if (row.method === 'uploadGpx' && row.file) return idbDeleteKey('pending_gpx', row.file);
        });
      }, err => {
        if (err && err.status) { skipped++; return idbDeleteKey('outbox', row.id); }  // conflict/validation -> skip + notify
        stopped = true;  // network error mid-drain -> stop, keep the rest queued
      });
    }), Promise.resolve());
  }).then(() => _finishDrain(synced, skipped), () => { _draining = false; updateOfflineBanner(); });
}
function _finishDrain(synced, skipped) {
  _draining = false;
  const reconcile = (synced || skipped)
    ? Promise.all([refreshPlaces().catch(() => {}), refreshAreas().catch(() => {}), refreshRoutes().catch(() => {})]).then(() => { if (typeof wrappedRouter === 'function') wrappedRouter(); })
    : Promise.resolve();
  return reconcile
    .then(() => idbGetAll('outbox')).catch(() => [])
    .then(rows => { if (!(rows || []).length) return idbClear('pending_gpx'); })
    .then(() => { updateOfflineBanner(); if (synced || skipped) showSyncToast(synced, skipped); })
    .catch(() => {});
}

// OFFLINE-QUEUE-END

// Count of pending writes for the current map (outbox is namespaced).
function pendingCount() {
  return idbGetAll('outbox')
    .then(rows => (rows || []).filter(r => r.ns === currentNs()).length)
    .catch(() => 0);
}
// Offline banner: hidden online and in local-only mode (no server, always
// editable by design). Offline owners see editable-offline copy with the
// pending count; offline public viewers see read-only copy.
let _bannerSeq = 0;
export function updateOfflineBanner() {
  const el = document.getElementById('pwa-offline-banner');
  if (!el) return;
  if (isLocalMode() || navigator.onLine) { el.classList.remove('visible'); return; }
  if (isReadOnly()) {
    el.textContent = "You're offline. Showing the last loaded map.";
    el.classList.add('visible');
    return;
  }
  // pendingCount is async; a later call (e.g. once auth is restored on
  // boot) must win over an earlier one that read a not-yet-ready identity.
  const seq = ++_bannerSeq;
  pendingCount().then(n => {
    if (seq !== _bannerSeq) return;
    el.textContent = n > 0
      ? "You're offline. " + n + " change" + (n === 1 ? '' : 's') + " will sync when you reconnect."
      : "You're offline. Changes save here and sync when you reconnect.";
    el.classList.add('visible');
  });
}
let _syncToastTimer = null;
function showSyncToast(synced, skipped) {
  const el = document.getElementById('pwa-sync-toast');
  if (!el) return;
  let msg = synced ? ('Synced ' + synced + ' change' + (synced === 1 ? '' : 's')) : 'Sync complete';
  if (skipped) msg += ', ' + skipped + ' skipped (changed on the server)';
  el.textContent = msg;
  el.classList.add('visible');
  if (_syncToastTimer) clearTimeout(_syncToastTimer);
  _syncToastTimer = setTimeout(() => el.classList.remove('visible'), 4500);
}

// Single dispatch seam between the UI and the backend for app *content*
// (places, routes/GPX, metadata, regions, category labels). In server mode
// writes route through mutate() (online -> server, offline -> optimistic
// cache + outbox); local-only mode keeps its direct-to-IndexedDB path.
// Reads honor the viewer (owner vs public) via dataUrl/categoryLabelsUrl.
export const dataLayer = {
  // -- reads (local store, or cached-on-device server reads) --
  fetchPlaces(fallback)         { return isLocalMode() ? localStore.getPlaces(fallback) : cachedRead('places', dataUrl('places'), fallback); },
  fetchAreas(fallback)          { return isLocalMode() ? localStore.getAreas(fallback) : cachedRead('areas', dataUrl('areas'), fallback); },
  fetchRoutes(fallback)         { return isLocalMode() ? localStore.getRoutes() : cachedRead('routes', dataUrl('routes'), fallback); },
  fetchCategoryLabels(fallback) { return isLocalMode() ? localStore.getCategoryLabels() : cachedRead('category-labels', categoryLabelsUrl(), fallback); },

  // -- place writes --
  createPlace(payload)   { return isLocalMode() ? localStore.createPlace(payload).then(logLocal('place.create', payload.name)) : mutate('createPlace', payload); },
  updatePlace(body)      { return isLocalMode() ? localStore.updatePlace(body).then(logLocal('place.update', body.place && body.place.name)) : mutate('updatePlace', body); },          // { id, place }
  deletePlace(body)      {
    if (!isLocalMode()) return mutate('deletePlace', body);                                                               // { id }
    const p = (state.places || []).find(x => x.id === body.id);
    return localStore.deletePlace(body).then(logLocal('place.delete', p ? p.name : ''));
  },
  clearCategory(body)    { return isLocalMode() ? localStore.clearCategory(body).then(logLocal('place.clear_category', body.category)) : mutate('clearCategory', body); }, // { category }

  // -- area writes --
  createArea(payload)    { return isLocalMode() ? localStore.createArea(payload).then(logLocal('area.create', payload.name)) : mutate('createArea', payload); },
  updateArea(body)       { return isLocalMode() ? localStore.updateArea(body).then(logLocal('area.update', body.area && body.area.name)) : mutate('updateArea', body); },          // { id, area }
  deleteArea(body)       {
    if (!isLocalMode()) return mutate('deleteArea', body);                                                                // { id }
    const a = (state.areas || []).find(x => x.id === body.id);
    return localStore.deleteArea(body).then(logLocal('area.delete', a ? a.name : ''));
  },

  // -- route / GPX writes --
  uploadGpx(opts) {
    if (isLocalMode()) {
      const stem = opts.name.endsWith('.planned') ? opts.name.slice(0, -'.planned'.length) : opts.name;
      return localStore.uploadGpx(opts).then(logLocal('route.create', stem, { region: opts.region || '' }));
    }
    return mutate('uploadGpx', opts);
  },
  deleteGpx(body)        { return isLocalMode() ? localStore.deleteGpx(body).then(logLocal('route.delete', body.name)) : mutate('deleteGpx', body); },          // { region, name }
  setGpxCompleted(body)  { return isLocalMode() ? localStore.setGpxCompleted(body).then(logLocal(body.completed ? 'route.complete' : 'route.plan', _splitKey(body.key).name)) : mutate('setGpxCompleted', body); }, // { key, completed }
  moveGpx(body)          { return isLocalMode() ? localStore.moveGpx(body).then(r => { localLog('route.move', r.new_key ? _splitKey(r.new_key).name : '', { from: body.key }); return r; }) : mutate('moveGpx', body); },       // { key, new_region, new_name? }
  putMetadata(body)      { return isLocalMode() ? localStore.putMetadata(body).then(logLocal('route.update', _splitKey(body.key).name)) : mutate('putMetadata', body); },        // { key, metadata }

  // -- region writes --
  renameRegion(body)     { return isLocalMode() ? localStore.renameRegion(body).then(logLocal('region.rename', body.to, { from: body.from })) : mutate('renameRegion', body); }, // { from, to }
  deleteRegion(body)     { return isLocalMode() ? localStore.deleteRegion(body) : mutate('deleteRegion', body); }, // { name }
  clearRegion(body)      { return isLocalMode() ? localStore.clearRegion(body).then(logLocal('region.clear', body.name)) : mutate('clearRegion', body); },  // { name }

  // -- category labels --
  putCategoryLabels(body) { return isLocalMode() ? localStore.putCategoryLabels(body) : mutate('putCategoryLabels', body); }, // { category_labels }
};
