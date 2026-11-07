import { state } from './core.js';
import { applyAuth } from './server.js';

// Mirror of the last successful server reads so the app stays browsable
// when the server is unreachable. A single key/value 'cache' store is
// enough for hydrate-on-read; per-record stores arrive with offline
// writes and local-only mode. All helpers are best-effort: if IndexedDB
// is missing or errors, get() yields null and set() is a no-op, so the
// app degrades to the previous online-only behavior.
const IDB_NAME = 'ferd';
const IDB_VERSION = 5;
let _idbPromise = null;
function idbOpen() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(IDB_NAME, IDB_VERSION); }
    catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1: server-read cache (key/value). v2 adds the local-only stores:
      // 'places' (keyed by id), 'gpx' (keyed by file path), and a 'kv'
      // bag for singletons (metadata, category labels, local config).
      // v3 adds 'log': the local-mode activity log (auto-increment id).
      // v4 adds the server-mode offline write queue: 'outbox' (queued
      // mutations, auto-increment id, replayed on reconnect) and
      // 'pending_gpx' (bytes of offline-uploaded GPX keyed by file path,
      // served by fetchGpxText until the upload replays to the server).
      // v5 adds 'areas' (keyed by id), the local-only area polygons.
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache');
      if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('areas')) db.createObjectStore('areas', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('gpx')) db.createObjectStore('gpx', { keyPath: 'file' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('pending_gpx')) db.createObjectStore('pending_gpx', { keyPath: 'file' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}
export function idbGet(store, key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  })).catch(() => null);
}
export function idbSet(store, key, val) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })).catch(() => {});
}
// Collection helpers for the keyPath stores (places, gpx). put() uses the
// in-line key; get/delete take the key value. Rejections surface so the
// local backend can fail a mutation rather than silently dropping it.
export function idbGetAll(store) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
}
export function idbPut(store, val) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(val);
    tx.oncomplete = () => resolve(val);
    tx.onerror = () => reject(tx.error);
  }));
}
export function idbDeleteKey(store, key) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
export function idbClear(store) {
  return idbOpen().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Local-mode activity log: a single-device record of the actions the user
// takes on their on-device map (the local analogue of the server audit
// log). Best-effort - logging never blocks or fails a write. Capped to the
// most recent LOCAL_LOG_CAP entries so it can't grow unbounded.
const LOCAL_LOG_CAP = 1000;
export function localLog(action, target, details) {
  try {
    const entry = { ts: Math.floor(Date.now() / 1000), action: action, target: target || '', details: details || {} };
    idbOpen().then(db => {
      const store = db.transaction('log', 'readwrite').objectStore('log');
      store.add(entry);
      const cnt = store.count();
      cnt.onsuccess = () => {
        const over = cnt.result - LOCAL_LOG_CAP;
        if (over <= 0) return;
        let removed = 0;
        store.openCursor().onsuccess = e => {
          const c = e.target.result;
          if (c && removed < over) { c.delete(); removed++; c.continue(); }
        };
      };
    }).catch(() => {});
  } catch (_) {}
}
// Returns a then-able that logs after a successful local write and passes
// the write's result through unchanged: localStore.x(...).then(logLocal(...)).
export function logLocal(action, target, details) {
  return res => { localLog(action, target, details); return res; };
}
// One page of the local log, newest first, in the same shape renderAdminLogs
// expects from the server (/admin/logs).
export function localLogPage(beforeId) {
  return idbGetAll('log').then(rows => {
    rows = (rows || []).slice().sort((a, b) => b.id - a.id);
    if (beforeId != null) rows = rows.filter(r => r.id < beforeId);
    const page = rows.slice(0, 100);
    const next = rows.length > 100 ? page[page.length - 1].id : null;
    return { logs: page, next_before_id: next };
  }).catch(() => ({ logs: [], next_before_id: null }));
}
export function localLogClear() { return idbClear('log'); }

// Cache keys are namespaced by server origin and viewer identity so a
// user who holds several maps (own account, a public map, a different
// server) never reads one map's cache into another's view.
export function _serverBase() {
  return (localStorage.getItem('ferd-server') || location.origin).replace(/\/+$/, '');
}
export function authCacheKey() { return 'auth::' + _serverBase(); }
export function dataCacheKey(kind) {
  const v = state.viewer;
  const who = (v && v.mode === 'public') ? 'pub:' + v.username : 'own:' + ((state.auth && state.auth.username) || '?');
  return 'data::' + _serverBase() + '::' + who + '::' + kind;
}

// Read a JSON payload, mirroring it to the cache on success and serving
// the last cached copy when the network is unreachable. A definitive
// server response (404/401/...) returns the fallback exactly as the old
// fetchJson did, so an unpublished or signed-out map never resurrects
// stale data; only an outright network failure hydrates from cache.
export function cachedRead(kind, url, fallback) {
  return fetch(url, applyAuth({})).then(
    r => {
      if (!r.ok) return fallback;
      return r.json().then(data => {
        idbSet('cache', dataCacheKey(kind), { data, ts: Date.now() });
        return data;
      }, () => fallback);
    },
    () => idbGet('cache', dataCacheKey(kind)).then(rec => rec ? rec.data : fallback)
  );
}
