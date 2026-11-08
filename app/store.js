import { batch, signal } from '@preact/signals';
import { state } from './core.js';
import { t } from './i18n.js';
import { applyAuth, categoryLabelsUrl, dataUrl, hasServer, isReadOnly } from './server.js';
import { api, apiUrl } from './auth.js';
import { normalizePlaceTags, normalizeTags } from './tags.js';
import { ROUTE_META_FIELDS, _genId, _splitKey, parseGpxText, stripGpxPiiText } from './gpx-text.js';

// The one copy of the map's data the UI reads and writes. Everything lives in
// IndexedDB as items ({kind, id, data, pos}) under a namespace: 'local' when
// no server is configured, otherwise the server origin plus whose map it is,
// so one device can hold several maps without mixing them. Writes land in
// IndexedDB first and update the signals below, so screens redraw from the
// signals rather than by re-fetching. On a server the owner's writes are also
// queued: item changes in 'pending', pushed through /api/sync/batch, and GPX
// file operations in 'gpx_ops', replayed against /api/gpx and friends, since
// routes follow the files. sync() pushes both and then pulls the server's
// changes through /api/sync/changes. A public map is read-only and is loaded
// whole from its public endpoints, keeping the last copy for offline use.

/**
 * @typedef {{ ns: string, kind: string, id: string, data: any, pos: number }} ItemRec
 * @typedef {{ ns: string, kind: string, id: string, op: string, data?: any, seq: number }} PendingRec
 * @typedef {{ ns: string, file: string, text: string, ref?: number }} GpxRec
 * @typedef {{ id?: number, ns: string, method: string, args: any, ts: number, file?: string, ref?: number, error?: string }} GpxOpRec
 * @typedef {{ items?: ItemRec[], delItems?: string[][], pending?: PendingRec[], delPending?: string[][],
 *   gpx?: GpxRec[], delGpx?: string[][], ops?: GpxOpRec[], delOps?: number[], meta?: Array<[string, any]>,
 *   delMeta?: string[], clearItems?: boolean }} DbWrite
 * @typedef {{ keys: string[], regions: string[] }} OpScope
 * @typedef {{ data: any, pos: number }} MemItem
 * @typedef {{ kind: string, id: string, op: string, data?: any }} Change
 */

export const places = signal(/** @type {any[]} */ ([]));
export const areas = signal(/** @type {any[]} */ ([]));
export const routes = signal(/** @type {{ regions: any[] }} */ ({ regions: [] }));
export const labels = signal(/** @type {Record<string, any>} */ ({}));
export const prefs = signal(/** @type {Record<string, any>} */ ({}));
export const pendingCount = signal(0);
export const auth = signal(/** @type {any} */ (null));
// The catalogue's entries, null until fetched. state._catalogCache reads and
// writes it (bindCatalogCache), so a list that shows import badges follows
// a refetch.
export const catalogCache = signal(/** @type {any[] | null} */ (null));
// Queued GPX calls the server keeps failing (`stuck`) and uploads it refused
// whose text is kept here to save (`kept`), for the sync notice.
/** @typedef {{ id?: number, key?: string, method?: string, name: string, error?: string, upload: boolean }} SyncIssue */
export const syncIssues = signal(/** @type {{ stuck: SyncIssue[], kept: SyncIssue[] }} */ ({ stuck: [], kept: [] }));
// False while a sync runs and while this copy lacks part of the server's set.
export const syncSettled = signal(true);
// Make state.auth read and write the auth signal, so every existing reader
// stays. Called once at startup rather than at import, since core.js and
// this module import each other.
export function bindAuth() {
  auth.value = state.auth;
  Object.defineProperty(state, 'auth', {
    get() { return auth.value; },
    set(v) { auth.value = v; },
    enumerable: true, configurable: true,
  });
}

export function bindCatalogCache() {
  Object.defineProperty(state, '_catalogCache', {
    get() { return catalogCache.value; },
    set(v) { catalogCache.value = v == null ? null : v; },
    enumerable: true, configurable: true,
  });
}

const DB_NAME = 'ferd';
const DB_VERSION = 6;
const KINDS = ['place', 'area', 'route', 'metadata', 'pref', 'label'];
const BATCH_MAX = 500;
// Characters of change data per push. Even at three UTF-8 bytes each, a
// batch stays under the server's default 1 MiB body limit.
const BATCH_CHARS = 300000;

/** @param {IDBRequest} r @returns {Promise<any>} */
function req(r) { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
/** @param {IDBTransaction} tx @returns {Promise<void>} */
function txDone(tx) { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); }); }

/** @type {Promise<IDBDatabase> | null} */
let _dbPromise = null;
function dbOpen() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    /** @type {IDBOpenDBRequest} */
    let r;
    try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
    r.onupgradeneeded = () => upgrade(r.result);
    // A tab still on an older version holds the database open, and code
    // from before v6 never lets go of it, so the upgrade waits until that
    // tab closes. The boot screen says why.
    r.onblocked = () => {
      const el = document.querySelector('#app .app-state .ui-hint');
      if (el) el.textContent = t('app.otherTab');
    };
    r.onsuccess = () => {
      const db = r.result;
      // A newer version opening in another tab: let go so it can upgrade,
      // and offer the reload that brings this tab's code up to date.
      db.onversionchange = () => {
        db.close();
        _dbPromise = null;
        showUpdatePrompt();
      };
      resolve(db);
    };
    // Not cached, so a later call tries again (after an upgrade failed, or
    // once the blocking tab is gone).
    r.onerror = () => {
      _dbPromise = null;
      reject(r.error);
    };
  });
  return _dbPromise;
}

// v1 to v5 (Ferd 1.x) held a cache of server reads, separate local-mode
// stores and an offline outbox of REST calls. v6 is one item store for every
// namespace. The old stores are dropped unread: 1.x data comes over by
// export and import. 'log' (the local-mode activity log) carries over.
/** @param {IDBDatabase} db */
function upgrade(db) {
  if (db.objectStoreNames.contains('items')) return;
  for (const name of ['cache', 'places', 'areas', 'gpx', 'kv', 'outbox', 'pending_gpx']) {
    if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
  }
  db.createObjectStore('items', { keyPath: ['ns', 'kind', 'id'] }).createIndex('ns', 'ns');
  db.createObjectStore('pending', { keyPath: ['ns', 'kind', 'id'] }).createIndex('ns', 'ns');
  db.createObjectStore('gpx', { keyPath: ['ns', 'file'] }).createIndex('ns', 'ns');
  db.createObjectStore('gpx_ops', { keyPath: 'id', autoIncrement: true }).createIndex('ns', 'ns');
  if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
  if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
}

/** @param {DbWrite} w */
function dbWrite(w) {
  return dbOpen().then(db => {
    const tx = db.transaction(['items', 'pending', 'gpx', 'gpx_ops', 'meta'], 'readwrite');
    const items = tx.objectStore('items');
    if (w.clearItems) {
      const range = IDBKeyRange.bound([NS, '', ''], [NS, '￿', '￿']);
      items.delete(range);
    }
    for (const k of w.delItems || []) items.delete(k);
    for (const rec of w.items || []) items.put(rec);
    const pend = tx.objectStore('pending');
    for (const k of w.delPending || []) pend.delete(k);
    for (const rec of w.pending || []) pend.put(rec);
    const gpx = tx.objectStore('gpx');
    for (const k of w.delGpx || []) gpx.delete(k);
    for (const rec of w.gpx || []) gpx.put(rec);
    const ops = tx.objectStore('gpx_ops');
    for (const id of w.delOps || []) ops.delete(id);
    for (const rec of w.ops || []) ops.put(rec);
    const meta = tx.objectStore('meta');
    for (const k of w.delMeta || []) meta.delete(k);
    for (const [k, v] of w.meta || []) meta.put(v, k);
    return txDone(tx);
  });
}
/** @param {string} ns */
function dbRead(ns) {
  return dbOpen().then(db => {
    const tx = db.transaction(['items', 'pending', 'gpx_ops', 'meta'], 'readonly');
    const byNs = (/** @type {string} */ name) => req(tx.objectStore(name).index('ns').getAll(ns));
    return Promise.all([byNs('items'), byNs('pending'), byNs('gpx_ops'), req(tx.objectStore('meta').get('sync::' + ns))])
      .then(([items, pending, ops, sync]) => ({ items, pending, ops, sync }));
  });
}
/** @param {string} ns @param {string} file @returns {Promise<GpxRec | undefined>} */
function dbGpx(ns, file) { return dbOpen().then(db => req(db.transaction('gpx').objectStore('gpx').get([ns, file]))); }
/** @param {string} ns @returns {Promise<GpxOpRec[]>} queued GPX calls in the order they were made */
async function gpxOpsFor(ns) {
  const db = await dbOpen();
  const rows = await req(db.transaction('gpx_ops').objectStore('gpx_ops').index('ns').getAll(ns));
  return rows.sort((/** @type {GpxOpRec} */ a, /** @type {GpxOpRec} */ b) => (a.id || 0) - (b.id || 0));
}
/** @param {string} ns @returns {Promise<GpxRec[]>} GPX text this device holds for the namespace */
function gpxFor(ns) { return dbOpen().then(db => req(db.transaction('gpx').objectStore('gpx').index('ns').getAll(ns))); }
/** @param {string} ns @returns {Promise<Array<[string, any]>>} refused uploads kept for the namespace */
async function keptFor(ns) {
  const db = await dbOpen();
  const st = db.transaction('meta').objectStore('meta'), range = IDBKeyRange.bound(keptKey(ns, ''), keptKey(ns, '\uffff'));
  const [keys, vals] = await Promise.all([req(st.getAllKeys(range)), req(st.getAll(range))]);
  return /** @type {IDBValidKey[]} */ (keys).map((k, i) => [String(k), vals[i]]);
}
/** @param {string} key */
export function metaGet(key) { return dbOpen().then(db => req(db.transaction('meta').objectStore('meta').get(key))).catch(() => /** @type {any} */ (undefined)); }
/** @param {string} key @param {any} val */
export function metaSet(key, val) { return dbWrite({ meta: [[key, val]] }).catch(() => {}); }

// The namespace the signals show.
export function _serverBase() {
  return (localStorage.getItem('ferd-server') || location.origin).replace(/\/+$/, '');
}
export function authCacheKey() { return 'auth::' + _serverBase(); }
export function currentNs() {
  if (!hasServer()) return 'local';
  const v = state.viewer;
  const who = (v && v.mode === 'public') ? 'pub:' + v.username : 'own:' + ((state.auth && state.auth.username) || '?');
  return _serverBase() + '::' + who;
}
function isOwnerServer() { return hasServer() && !isReadOnly(); }

let NS = '';
/** @type {Record<string, Map<string, MemItem>>} */
let mem = emptyMem();
/** @type {Map<string, PendingRec>} */
let pendingMap = new Map();
let opsCount = 0;
/** @type {{ rev: number, epoch: string | null, more?: boolean }} */
let syncState = { rev: 0, epoch: null };
let _seq = 0;
function nextSeq() { _seq = Math.max(_seq + 1, Date.now() * 1000); return _seq; }

// STORE-CORE-BEGIN (tests/js/store.test.js runs the code between these markers)
function emptyMem() {
  /** @type {Record<string, Map<string, MemItem>>} */
  const m = {};
  for (const k of KINDS) m[k] = new Map();
  return m;
}
/** @param {string} kind @param {string} id */
function pkey(kind, id) { return kind + '\u0000' + id; }
/** @param {any} v */
function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
// Fields the UI hangs on its copies (slugs) never reach storage.
/** @param {any} obj */
function stripUi(obj) {
  const out = Object.assign({}, obj);
  for (const k of Object.keys(out)) if (k.charAt(0) === '_') delete out[k];
  return out;
}
/** @param {Map<string, MemItem>} map */
function sortedData(map) {
  return [...map.values()].sort((a, b) => a.pos - b.pos).map(x => clone(x.data));
}
/** @param {Map<string, MemItem>} map */
function nextPos(map) { let p = 0; for (const v of map.values()) if (v.pos > p) p = v.pos; return p + 1; }

// The routes.json shape from route and metadata items, as the server's
// store.routes_manifest builds it.
/** @param {Map<string, MemItem>} routeMap @param {Map<string, MemItem>} metaMap */
function buildManifest(routeMap, metaMap) {
  /** @type {Record<string, { name: string, routes: any[] }>} */
  const regions = {};
  for (const { data } of routeMap.values()) {
    /** @type {Record<string, any>} */
    const entry = {};
    for (const k in data) if (k !== 'region') entry[k] = clone(data[k]);
    const md = metaMap.get(entry.key);
    if (md && md.data && typeof md.data === 'object') {
      for (const f of ROUTE_META_FIELDS) if (f in md.data) entry[f] = clone(md.data[f]);
    }
    const name = data.region || '';
    (regions[name] = regions[name] || { name, routes: [] }).routes.push(entry);
  }
  const out = Object.values(regions).sort((a, b) => (a.name === '' ? 1 : 0) - (b.name === '' ? 1 : 0) || a.name.localeCompare(b.name));
  for (const r of out) r.routes.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { regions: out };
}
// Split a routes.json manifest into route items and metadata items, the
// way the server's manifest_rows does.
/** @param {any} manifest */
function manifestItems(manifest) {
  /** @type {Change[]} */
  const out = [];
  for (const reg of (manifest && Array.isArray(manifest.regions)) ? manifest.regions : []) {
    for (const e of (reg && Array.isArray(reg.routes)) ? reg.routes : []) {
      if (!e || typeof e.key !== 'string') continue;
      /** @type {Record<string, any>} */
      const data = { region: reg.name || '' };
      /** @type {Record<string, any>} */
      const md = {};
      for (const k in e) {
        if (k.charAt(0) === '_') continue;
        if (ROUTE_META_FIELDS.includes(k)) md[k] = e[k]; else data[k] = e[k];
      }
      out.push({ kind: 'route', id: e.key, op: 'put', data });
      if (Object.keys(md).length) out.push({ kind: 'metadata', id: e.key, op: 'put', data: md });
    }
  }
  return out;
}

// Local-mode GPX records (one per file) to a manifest, grouping a walked
// and a planned file of one route as scripts/gpx-manifest.sh does.
/** @param {any[]} recs */
function localManifestFromGpx(recs) {
  /** @type {Record<string, any>} */
  const byKey = {};
  for (const rec of recs) {
    const region = rec.region || '';
    const key = region ? region + '/' + rec.name : rec.name;
    const r = byKey[key] = byKey[key] || { key, region, name: rec.name, walked: null, planned: null };
    if (rec.planned) r.planned = rec; else r.walked = rec;
  }
  /** @type {Record<string, any>} */
  const regions = {};
  for (const key in byKey) {
    const r = byKey[key], primary = r.walked || r.planned;
    /** @type {Record<string, any>} */
    const entry = { key, file: primary.file, name: r.name, hasElevation: !!primary.hasElevation, completed: !!r.walked };
    if (primary.bbox) entry.bbox = primary.bbox;
    if (r.planned) entry.plannedFile = r.planned.file;
    if (primary.trackCount > 1) { entry.trackCount = primary.trackCount; entry.trackNames = primary.trackNames; }
    (regions[r.region] = regions[r.region] || { name: r.region, routes: [] }).routes.push(entry);
  }
  return { regions: Object.values(regions) };
}

// Apply changes to the in-memory copy and return what to persist. `queue`
// marks them pending for the server; a pull passes false.
/** @param {Change[]} changes @param {boolean} queue */
function applyChanges(changes, queue) {
  /** @type {DbWrite} */
  const w = { items: [], delItems: [], pending: [] };
  const kinds = new Set();
  for (const c of changes) {
    const m = mem[c.kind];
    kinds.add(c.kind);
    if (c.op === 'delete') {
      m.delete(c.id);
      /** @type {string[][]} */ (w.delItems).push([NS, c.kind, c.id]);
    } else {
      const cur = m.get(c.id);
      const rec = { data: c.data, pos: cur ? cur.pos : nextPos(m) };
      m.set(c.id, rec);
      /** @type {ItemRec[]} */ (w.items).push({ ns: NS, kind: c.kind, id: c.id, data: c.data, pos: rec.pos });
    }
    if (queue) {
      /** @type {PendingRec} */
      const p = { ns: NS, kind: c.kind, id: c.id, op: c.op, seq: nextSeq() };
      if (c.op !== 'delete') p.data = c.data;
      pendingMap.set(pkey(c.kind, c.id), p);
      /** @type {PendingRec[]} */ (w.pending).push(p);
    }
  }
  return { w, kinds };
}

// Route items change with GPX file operations. These mirror what the server
// does to its files and rows, so the map shows the result before (or
// without) a server. Each returns the response the REST endpoint gives,
// the item changes, and the GPX text records to move.
/** @param {string} key */
function routeFiles(key) {
  const { region, name } = _splitKey(key);
  const pre = region ? region + '/' : '';
  return { region, name, walked: pre + name + '.gpx', planned: pre + name + '.planned.gpx' };
}
/** @param {any} entry @param {any} meta */
function applyParse(entry, meta) {
  entry.hasElevation = !!meta.hasElevation;
  if (meta.bbox) entry.bbox = meta.bbox; else delete entry.bbox;
  if (meta.trackCount && meta.trackCount > 1) { entry.trackCount = meta.trackCount; entry.trackNames = meta.trackNames; }
  else { delete entry.trackCount; delete entry.trackNames; }
}
/**
 * @typedef {{ changes: Change[], moves: Array<[string, string]>, drops: string[], result: any, metaMoves: Array<[string, string]> }} RouteOut
 */
/** @returns {RouteOut} */
function routeOut(/** @type {any} */ result) { return { changes: [], moves: [], drops: [], result, metaMoves: [] }; }
/** @param {string} key */
function routeData(key) { const r = mem.route.get(key); return r ? clone(r.data) : null; }
/** @param {RouteOut} out @param {string} oldKey @param {string} newKey */
function moveMeta(out, oldKey, newKey) {
  if (oldKey === newKey) return;
  out.metaMoves.push([oldKey, newKey]);
}
const ROUTE_OPS = {
  /** @param {{ region?: string, name: string, text: string }} a */
  uploadGpx(a) {
    const region = a.region || '';
    const planned = a.name.endsWith('.planned');
    const stem = planned ? a.name.slice(0, -'.planned'.length) : a.name;
    const file = (region ? region + '/' : '') + a.name + '.gpx';
    const key = region ? region + '/' + stem : stem;
    const meta = parseGpxText(a.text);
    const e = routeData(key) || { region, key, name: stem };
    if (planned) {
      e.plannedFile = file;
      if (e.completed !== true) { e.file = file; e.completed = false; applyParse(e, meta); }
    } else {
      e.file = file; e.completed = true; applyParse(e, meta);
    }
    const out = routeOut({ ok: true });
    out.changes.push({ kind: 'route', id: key, op: 'put', data: e });
    return out;
  },
  /** @param {{ region?: string, name?: string }} a */
  deleteGpx(a) {
    const region = a.region || '';
    let name = a.name || '';
    if (name.toLowerCase().endsWith('.gpx')) name = name.slice(0, -4);
    const key = region ? region + '/' + name : name;
    const out = routeOut({ ok: true });
    if (mem.route.has(key)) {
      const f = routeFiles(key);
      out.changes.push({ kind: 'route', id: key, op: 'delete' });
      out.drops.push(f.walked, f.planned);
    }
    return out;
  },
  /** @param {{ key: string, completed: boolean }} a */
  setGpxCompleted(a) {
    const out = routeOut({ ok: true });
    const e = routeData(a.key);
    if (!e) return out;
    const f = routeFiles(a.key), walked = e.completed === true, hasPlanned = !!e.plannedFile;
    if (a.completed) {
      if (walked || !hasPlanned) return out;
      out.moves.push([f.planned, f.walked]);
      e.completed = true; e.file = f.walked; delete e.plannedFile;
    } else {
      if (hasPlanned || !walked) return out;
      out.moves.push([f.walked, f.planned]);
      e.completed = false; e.file = f.planned; e.plannedFile = f.planned;
    }
    out.changes.push({ kind: 'route', id: a.key, op: 'put', data: e });
    return out;
  },
  /** @param {{ key: string, new_region?: string, new_name?: string }} a */
  moveGpx(a) {
    const src = _splitKey(a.key);
    const newRegion = a.new_region || '';
    const finalName = ((a.new_name || src.name) + '').trim();
    const newKey = (newRegion ? newRegion + '/' : '') + finalName;
    if (src.region === newRegion && src.name === finalName) return routeOut({ ok: true, old_key: a.key, new_key: a.key, moved: 0 });
    const e = routeData(a.key);
    if (!e) return routeOut({ ok: true, old_key: a.key, new_key: newKey, moved: 0 });
    const out = routeOut({ ok: true, old_key: a.key, new_key: newKey, moved: 1 });
    relocate(out, e, newKey, newRegion, finalName);
    return out;
  },
  /** @param {{ from?: string, to?: string }} a */
  renameRegion(a) {
    const from = a.from || '', to = a.to || '';
    if (from === to) return routeOut({ ok: true, renamed: 0 });
    const out = routeOut({ ok: true, renamed: 1 });
    for (const { data } of [...mem.route.values()]) {
      if ((data.region || '') !== from) continue;
      relocate(out, clone(data), (to ? to + '/' : '') + data.name, to, data.name);
    }
    return out;
  },
  deleteRegion() { return routeOut({ ok: true }); }, // regions follow their routes; an empty one has nothing to remove
  // Removing a region that still has routes moves them to No region, as
  // the server's /regions/clear does.
  /** @param {{ name?: string }} a */
  clearRegion(a) {
    const name = a.name || '';
    const out = routeOut({ ok: true });
    for (const { data } of [...mem.route.values()]) {
      if ((data.region || '') !== name) continue;
      relocate(out, clone(data), data.name, '', data.name);
    }
    return out;
  },
};
/** @param {RouteOut} out @param {any} e @param {string} newKey @param {string} newRegion @param {string} newName */
function relocate(out, e, newKey, newRegion, newName) {
  const of = routeFiles(e.key), nf = routeFiles(newKey), oldKey = e.key;
  if (e.completed === true) out.moves.push([of.walked, nf.walked]);
  if (e.plannedFile) out.moves.push([of.planned, nf.planned]);
  e.key = newKey; e.name = newName; e.region = newRegion;
  e.file = e.completed === true ? nf.walked : nf.planned;
  if (e.plannedFile) e.plannedFile = nf.planned;
  out.changes.push({ kind: 'route', id: oldKey, op: 'delete' }, { kind: 'route', id: newKey, op: 'put', data: e });
  moveMeta(out, oldKey, newKey);
}

// Category labels: a put replaces the whole map, keeping a slug's colour
// when the caller leaves it out, as PUT /me/category-labels does.
/** @param {Record<string, any>} incoming */
function labelChanges(incoming) {
  /** @type {Change[]} */
  const out = [];
  for (const slug in incoming) {
    const cur = mem.label.get(slug);
    const next = Object.assign({}, incoming[slug]);
    if (typeof next.color !== 'number' && cur && typeof cur.data.color === 'number') next.color = cur.data.color;
    if (!cur || JSON.stringify(cur.data) !== JSON.stringify(next)) out.push({ kind: 'label', id: slug, op: 'put', data: next });
  }
  for (const slug of mem.label.keys()) if (!(slug in incoming)) out.push({ kind: 'label', id: slug, op: 'delete' });
  return out;
}

// One page of /sync/changes into the in-memory copy. Items with a local
// change still waiting to be pushed keep the local version. `changed`
// counts items whose data differs from the copy here, so the echo of this
// device's own pushed edits does not count as news.
/** @param {any} page */
function applyPull(page) {
  /** @type {DbWrite} */
  const w = { items: [], delItems: [] };
  const kinds = new Set();
  let changed = 0;
  if (page.reset) {
    w.clearItems = true;
    for (const k of KINDS) { if (mem[k].size) { kinds.add(k); changed++; } mem[k] = new Map(); }
    // The local copy is dropped; pending edits are laid back over it.
    for (const p of pendingMap.values()) {
      if (p.op !== 'put') continue;
      const m = mem[p.kind], pos = nextPos(m);
      m.set(p.id, { data: p.data, pos });
      /** @type {ItemRec[]} */ (w.items).push({ ns: NS, kind: p.kind, id: p.id, data: p.data, pos });
    }
  }
  for (const c of page.changes || []) {
    if (!mem[c.kind]) continue;
    if (pendingMap.has(pkey(c.kind, c.id))) continue;
    const cur = mem[c.kind].get(c.id);
    if (c.deleted) {
      if (cur) { kinds.add(c.kind); changed++; }
      mem[c.kind].delete(c.id); /** @type {string[][]} */ (w.delItems).push([NS, c.kind, c.id]);
    } else {
      if (!cur || JSON.stringify(cur.data) !== JSON.stringify(c.data)) { kinds.add(c.kind); changed++; }
      mem[c.kind].set(c.id, { data: c.data, pos: c.pos });
      /** @type {ItemRec[]} */ (w.items).push({ ns: NS, kind: c.kind, id: c.id, data: c.data, pos: c.pos });
    }
  }
  syncState = { rev: page.next != null ? page.next : page.rev, epoch: page.epoch || null };
  if (page.more) syncState.more = true;
  w.meta = [['sync::' + NS, syncState]];
  return { w, kinds, changed };
}

// Push pending item changes in batches, oldest first. The server names a
// change it refuses ("changes[i]: ..."), and only that one is dropped. A
// refusal that names none (a whole-set limit) or a body too large halves
// the batch until the change behind it is alone, so no other edit goes
// with it. Anything else (a proxy error while the API restarts, a server
// error, a lapsed session) leaves the queue as it is and ends the sync.
// Metadata edits on a route a held GPX call touches wait with it. Returns
// counts.
/** @param {OpScope[]} [held] */
async function pushPending(held = []) {
  let pushed = 0, skipped = 0, size = BATCH_MAX;
  for (;;) {
    const list = nextBatch(size, held);
    if (!list.length) break;
    const body = { changes: list.map(p => p.op === 'put' ? { kind: p.kind, op: 'put', id: p.id, data: p.data } : { kind: p.kind, op: 'delete', id: p.id }) };
    /** @type {PendingRec[]} */
    let done;
    try {
      await api('POST', '/sync/batch', body);
      done = list;
      pushed += list.length;
    } catch (err) {
      const e = /** @type {any} */ (err), st = e && e.status;
      const m = st === 400 ? /changes\[(\d+)\]/.exec(e.message || '') : null;
      if (m && list[+m[1]]) done = [list[+m[1]]];
      else if (st === 400 || st === 409 || st === 413) {
        if (list.length > 1) { size = Math.ceil(list.length / 2); continue; }
        done = list;
      } else throw err;
      skipped += done.length;
      size = BATCH_MAX;
      await forceResync(NS);
    }
    await forgetPending(done);
  }
  return { pushed, skipped };
}
/** @param {number} size @param {OpScope[]} [held] */
function nextBatch(size, held = []) {
  const out = [];
  let chars = 0;
  for (const p of [...pendingMap.values()].sort((a, b) => a.seq - b.seq)) {
    if (out.length >= size) break;
    if (p.kind === 'metadata' && held.some(s => inScope(s, p.id))) continue;
    const n = JSON.stringify(p.data === undefined ? null : p.data).length + p.id.length + 40;
    if (out.length && chars + n > BATCH_CHARS) break;
    out.push(p); chars += n;
  }
  return out;
}
// A dropped edit leaves this copy holding something the server never took,
// and only items the server sends get corrected, so the next pull of that
// namespace fetches the whole set again (a missing epoch is a reset).
/** @param {string} ns */
function forceResync(ns) {
  const st = { rev: ns === NS ? syncState.rev : 0, epoch: /** @type {string | null} */ (null) };
  if (ns === NS) syncState = st;
  return dbWrite({ meta: [['sync::' + ns, st]] });
}
// Drop pushed changes from the queue, unless the item changed again while
// the push was in flight.
/** @param {PendingRec[]} list */
function forgetPending(list) {
  const del = [];
  for (const p of list) {
    const k = pkey(p.kind, p.id), cur = pendingMap.get(k);
    if (cur && cur.seq === p.seq) { pendingMap.delete(k); del.push([NS, p.kind, p.id]); }
  }
  updatePendingCount();
  return dbWrite({ delPending: del });
}
// How a queued GPX call fails decides what happens to it. No answer, a
// lapsed session, a rate limit or a proxy error while the API restarts:
// nothing gets through now, so the drain stops with every call still
// queued. A refusal: the server will never take the call as it is, so it
// is dropped and the rest go on. Any other answer (a server error such as
// a failing disk) can last, so the call stays queued, marked with its
// error for the owner to retry or discard, and only the calls and
// metadata edits that touch the same routes wait behind it (`held`).
const REFUSED = new Set([400, 404, 409, 413]);
const UNREACHABLE = new Set([401, 403, 429, 502, 503, 504]);
/** @param {string} ns */
async function drainGpxOps(ns) {
  let synced = 0, skipped = 0, stopped = false;
  /** @type {OpScope[]} */
  const held = [];
  /** @type {string[]} */
  const kept = [];
  for (const row of await gpxOpsFor(ns)) {
    const scope = opScope(row);
    if (held.some(h => scopesOverlap(h, scope))) { held.push(scope); continue; }
    /** @type {DbWrite} */
    const w = { delOps: [/** @type {number} */ (row.id)] };
    try {
      await GPX_REST[row.method](row.args);
      synced++;
      if (row.method === 'uploadGpx') w.delGpx = (await uploadCopies(ns, row)).map(g => [ns, g.file]);
    } catch (err) {
      const e = /** @type {any} */ (err), st = e && e.status;
      if (!st || UNREACHABLE.has(st)) { stopped = true; break; }
      if (!REFUSED.has(st)) {
        held.push(scope);
        const error = e.message || ('HTTP ' + st);
        if (row.error !== error) await dbWrite({ ops: [Object.assign({}, row, { error })] });
        continue;
      }
      skipped++;
      await forceResync(ns);
      // A refused upload's text is all there is of it, so it is kept for
      // the owner to save, and the toast names the file.
      if (row.method === 'uploadGpx') {
        const copies = await uploadCopies(ns, row);
        const text = row.args.text != null ? row.args.text : (copies[0] && copies[0].text);
        w.delGpx = copies.map(g => [ns, g.file]);
        if (text != null) {
          const file = uploadFile(row.args);
          w.meta = [[keptKey(ns, String(row.id)), { file, text, error: e.message || ('HTTP ' + st), ts: Date.now() }]];
          kept.push(file);
        }
      }
    }
    await dbWrite(w);
    if (ns === NS) { opsCount = Math.max(0, opsCount - 1); updatePendingCount(); }
  }
  return { synced, skipped, stopped, held, kept };
}
/** @param {any} a */
function uploadFile(a) { return (a.region ? a.region + '/' : '') + a.name + '.gpx'; }
/** @param {string} ns @param {string} id */
function keptKey(ns, id) { return 'kept::' + ns + '::' + id; }
// An upload's text stays on the device until the server has it. A queued
// move may have carried it to another name since, so it is found by the
// upload's ref; a call queued before refs existed still names its file.
/** @param {string} ns @param {GpxOpRec} row */
async function uploadCopies(ns, row) {
  const file = uploadFile(row.args);
  return (await gpxFor(ns)).filter(g => row.ref == null ? g.file === file : g.ref === row.ref);
}
// The route keys and regions a GPX call reads or changes, so a call that
// keeps failing holds back only what depends on it.
/** @param {GpxOpRec} row @returns {OpScope} */
function opScope(row) {
  const a = row.args || {};
  const at = (/** @type {string} */ region, /** @type {string} */ name) => (region ? region + '/' : '') + name;
  switch (row.method) {
    case 'uploadGpx': return { keys: [at(a.region || '', String(a.name).replace(/\.planned$/, ''))], regions: [] };
    case 'deleteGpx': return { keys: [at(a.region || '', String(a.name || '').replace(/\.gpx$/i, ''))], regions: [] };
    case 'setGpxCompleted': return { keys: [a.key], regions: [] };
    case 'moveGpx': return { keys: [a.key, at(a.new_region || '', String(a.new_name || _splitKey(a.key).name).trim())], regions: [] };
    case 'renameRegion': return { keys: [], regions: [a.from || '', a.to || ''] };
    case 'deleteRegion': return { keys: [], regions: [a.name || ''] };
    // Clearing a region moves its routes to No region.
    case 'clearRegion': return { keys: [], regions: [a.name || '', ''] };
    default: return { keys: [], regions: [] };
  }
}
/** @param {OpScope} s @param {string} key */
function inScope(s, key) { return s.keys.includes(key) || s.regions.includes(_splitKey(key).region); }
/** @param {OpScope} a @param {OpScope} b */
function scopesOverlap(a, b) {
  return a.keys.some(k => inScope(b, k)) || b.keys.some(k => inScope(a, k)) || a.regions.some(r => b.regions.includes(r));
}
// STORE-CORE-END

function updatePendingCount() { pendingCount.value = pendingMap.size + opsCount; }
// Category colours are assigned and saved only once this copy holds the
// server's whole set: saved against part of it, they would replace labels
// a later page still brings (core.js persistAssignedCategoryColors).
function updateSettled() {
  syncSettled.value = !_syncing && (!isOwnerServer() || (!!syncState.epoch && !syncState.more));
}

/** @param {GpxOpRec} o */
function opName(o) {
  const a = o.args || {};
  switch (o.method) {
    case 'uploadGpx': return uploadFile(a);
    case 'deleteGpx': return a.name || '';
    case 'renameRegion': return a.from || '';
    case 'deleteRegion': case 'clearRegion': return a.name || '';
    default: return _splitKey(a.key || '').name;
  }
}
/** @param {string} ns */
async function refreshIssues(ns) {
  try {
    const [ops, kept] = await Promise.all([gpxOpsFor(ns), keptFor(ns)]);
    if (ns !== NS) return;
    syncIssues.value = {
      stuck: ops.filter(o => o.error).map(o => ({ id: o.id, method: o.method, name: opName(o), error: o.error, upload: o.method === 'uploadGpx' })),
      kept: kept.map(([key, v]) => ({ key, name: v.file, error: v.error, upload: true })),
    };
  } catch (e) { /* no database: nothing to show */ }
}

/** @param {Set<string>} kinds */
function publish(kinds) {
  batch(() => {
    if (kinds.has('place')) places.value = sortedData(mem.place);
    if (kinds.has('area')) areas.value = sortedData(mem.area);
    if (kinds.has('route') || kinds.has('metadata')) routes.value = buildManifest(mem.route, mem.metadata);
    if (kinds.has('label')) {
      /** @type {Record<string, any>} */
      const o = {};
      for (const [k, v] of mem.label) o[k] = clone(v.data);
      labels.value = o;
    }
    if (kinds.has('pref')) {
      /** @type {Record<string, any>} */
      const o = {};
      for (const [k, v] of mem.pref) o[k] = clone(v.data);
      prefs.value = o;
    }
    updatePendingCount();
  });
}

// Load the namespace for the current viewer into memory and the signals.
// Returns whether there is a copy to show (an owner who has synced before,
// a public map loaded once, or local mode).
/** Whether this namespace has pulled from the server at least once. */
export function synced() { return !!syncState.epoch; }

export async function open() {
  NS = currentNs();
  mem = emptyMem(); pendingMap = new Map(); opsCount = 0; syncState = { rev: 0, epoch: null };
  let had = false;
  try {
    const r = await dbRead(NS);
    for (const it of r.items) { if (mem[it.kind]) mem[it.kind].set(it.id, { data: it.data, pos: it.pos }); }
    for (const p of r.pending) pendingMap.set(pkey(p.kind, p.id), p);
    opsCount = r.ops.length;
    if (r.sync) syncState = r.sync;
    had = r.items.length > 0 || !!r.sync;
  } catch (e) {
    console.warn('[store] IndexedDB unavailable', e);
  }
  publish(new Set(KINDS));
  updateSettled();
  await refreshIssues(NS);
  return NS === 'local' || had;
}

// Persist a local edit, update the signals and, on a server, queue it and
// schedule a sync.
/** @param {Change[]} changes */
async function commit(changes) {
  // A public map's copy mirrors the owner's; an edit here would show until
  // the next load and then vanish.
  if (isReadOnly()) throw Object.assign(new Error('This map is read-only'), { status: 403 });
  const queue = isOwnerServer();
  const { w, kinds } = applyChanges(changes, queue);
  publish(kinds);
  await dbWrite(w);
  if (queue) scheduleSync();
}

// -- sync --
let _syncing = /** @type {Promise<void> | null} */ (null);
let _syncTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
function scheduleSync() {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { _syncTimer = null; sync(); }, 300);
}

/** Push local changes, then pull the server's. Owner on a server only. @returns {Promise<void>} */
export function sync() {
  if (!isOwnerServer() || !navigator.onLine) { updateOfflineBanner(); return Promise.resolve(); }
  if (_syncing) return _syncing.then(() => sync());
  const ns = NS;
  _syncing = (async () => {
    let synced = 0, skipped = 0;
    /** @type {string[]} */
    let kept = [];
    syncSettled.value = false;
    try {
      const g = await drainGpxOps(ns);
      synced += g.synced; skipped += g.skipped; kept = g.kept;
      if (g.stopped || ns !== NS) return;
      try {
        const p = await pushPending(g.held);
        synced += p.pushed; skipped += p.skipped;
      } catch (e) {
        // A server that answers can still be pulled from: the pull keeps
        // every edit still queued here.
        if (!e || !/** @type {any} */ (e).status) throw e;
      }
      await pull(ns);
    } catch (e) {
      // A network failure leaves the rest queued for the next attempt.
    } finally {
      _syncing = null;
      updateSettled();
      updateOfflineBanner();
      await refreshIssues(ns);
      if (synced || skipped) showSyncToast(synced, skipped, kept);
    }
  })();
  return _syncing;
}
/** @param {string} ns */
async function pull(ns) {
  let since = syncState.rev, epoch = syncState.epoch, changed = 0;
  for (;;) {
    const qs = '?since=' + since + '&limit=5000' + (epoch ? '&epoch=' + encodeURIComponent(epoch) : '');
    const page = await api('GET', '/sync/changes' + qs);
    if (ns !== NS) return 0;
    const pulled = applyPull(page), w = pulled.w;
    changed += pulled.changed;
    publish(pulled.kinds);
    await dbWrite(w);
    if (!page.more) break;
    since = syncState.rev; epoch = syncState.epoch;
  }
  return changed;
}

// -- GPX operations --
/** @param {any} a */
function _gpxUploadRequest(a) {
  const region = a.region || '';
  let qs = (region ? '?region=' + encodeURIComponent(region) + '&' : '?') + 'name=' + encodeURIComponent(a.name);
  if (a.stripPii) qs += '&strip_pii=true';
  const body = a.file != null ? a.file : new Blob([a.text], { type: 'application/gpx+xml' });
  return fetch(apiUrl('/gpx') + qs, applyAuth({ method: 'POST', headers: { 'Content-Type': 'application/gpx+xml' }, body })).then(async r => {
    const data = await r.json().catch(() => /** @type {any} */ (null));
    if (!r.ok) { const e = /** @type {import('./auth.js').ApiError} */ (new Error((data && data.error) || ('HTTP ' + r.status))); e.status = r.status; throw e; }
    return data;
  });
}
/** @type {Record<string, (a: any) => Promise<any>>} */
const GPX_REST = {
  uploadGpx: _gpxUploadRequest,
  deleteGpx: a => api('DELETE', '/gpx', a),
  setGpxCompleted: a => api('POST', '/gpx/set-completed', a),
  moveGpx: a => api('POST', '/gpx/move', a),
  renameRegion: a => api('POST', '/regions/rename', a),
  deleteRegion: a => api('POST', '/regions/delete', a),
  clearRegion: a => api('POST', '/regions/clear', a),
};
// Apply a GPX operation to the route items here, moving any GPX text held on
// the device with it, and carry pending metadata edits along to the new key.
/** @param {string} method @param {any} args */
async function applyRouteOp(method, args) {
  const out = /** @type {Record<string, (a: any) => RouteOut>} */ (ROUTE_OPS)[method](args);
  /** @type {Change[]} */
  const changes = out.changes.slice();
  // Metadata follows the route. On a server the call itself moves it, so
  // only a pending edit needs carrying to the new key.
  const local = !hasServer();
  for (const [from, to] of out.metaMoves) {
    const cur = mem.metadata.get(from);
    if (cur) changes.push({ kind: 'metadata', id: from, op: 'delete' }, { kind: 'metadata', id: to, op: 'put', data: cur.data });
  }
  const { w, kinds } = applyChanges(changes, false);
  if (!local) {
    for (const [from, to] of out.metaMoves) {
      const p = pendingMap.get(pkey('metadata', from));
      if (!p) continue;
      pendingMap.delete(pkey('metadata', from));
      const np = Object.assign({}, p, { id: to, seq: nextSeq() });
      pendingMap.set(pkey('metadata', to), np);
      (w.delPending = w.delPending || []).push([NS, 'metadata', from]);
      (w.pending = w.pending || []).push(np);
    }
  }
  w.gpx = []; w.delGpx = [];
  for (const [from, to] of out.moves) {
    const rec = await dbGpx(NS, from).catch(() => /** @type {GpxRec | undefined} */ (undefined));
    if (rec) { w.delGpx.push([NS, from]); w.gpx.push(Object.assign({}, rec, { file: to })); }
  }
  for (const f of out.drops) w.delGpx.push([NS, f]);
  publish(kinds);
  return { w, result: out.result };
}

/** @param {string} method @param {any} args */
async function gpxOp(method, args) {
  if (isReadOnly()) return GPX_REST[method](args);
  if (method === 'uploadGpx') {
    const raw = await args.file.text();
    args = { region: args.region || '', name: args.name, stripPii: !!args.stripPii, text: args.stripPii ? stripGpxPiiText(raw) : raw };
  }
  if (hasServer() && navigator.onLine) {
    try {
      // Queued edits go first: a pending metadata edit under a route's old
      // key would otherwise land after the server moved that key.
      if (pendingMap.size || opsCount) await sync();
      // A queued call still waiting goes first, so this one queues behind it.
      if (!opsCount) {
        const res = await GPX_REST[method](args);
        await sync();
        return res;
      }
    } catch (err) {
      if (err && /** @type {any} */ (err).status) throw err;
    }
  }
  // No server, or offline: change the route items here; on a server the
  // call is queued and replayed in order on reconnect.
  const { w, result } = await applyRouteOp(method, args);
  // The upload's text and its queued call share a ref, so the text is found
  // under whatever name later queued calls give it.
  const ref = nextSeq();
  if (method === 'uploadGpx') w.gpx = (w.gpx || []).concat([{ ns: NS, file: uploadFile(args), text: args.text, ref }]);
  if (hasServer()) {
    /** @type {GpxOpRec} */
    const op = { ns: NS, method, args, ts: Date.now(), ref };
    w.ops = [op];
    opsCount++;
    updatePendingCount();
    updateOfflineBanner();
  }
  await dbWrite(w);
  // Online, a call queues only behind one that keeps failing, and may not
  // depend on it.
  if (hasServer() && navigator.onLine) scheduleSync();
  return result;
}
/** Drop a queued GPX call that keeps failing, with any text it held here. @param {number} id */
export async function discardOp(id) {
  const ns = NS;
  const row = (await gpxOpsFor(ns)).find(o => o.id === id);
  if (!row) return;
  /** @type {DbWrite} */
  const w = { delOps: [id] };
  if (row.method === 'uploadGpx') w.delGpx = (await uploadCopies(ns, row)).map(g => [ns, g.file]);
  await dbWrite(w);
  opsCount = Math.max(0, opsCount - 1);
  updatePendingCount();
  // The copy here shows the call as done; the next pull fetches the whole
  // set and puts back the server's version.
  await forceResync(ns);
  await refreshIssues(ns);
  return sync();
}
/** Forget a refused upload kept here. @param {string} key */
export async function dismissKept(key) {
  await dbWrite({ delMeta: [key] });
  await refreshIssues(NS);
}
/** The GPX text behind a sync issue. @param {{ id?: number, key?: string }} it @returns {Promise<string | null>} */
export async function issueText(it) {
  if (it.key) { const k = await metaGet(it.key); return k ? k.text : null; }
  const row = (await gpxOpsFor(NS)).find(o => o.id === it.id);
  if (!row) return null;
  if (row.args.text != null) return row.args.text;
  const copies = await uploadCopies(NS, row);
  return copies[0] ? copies[0].text : null;
}
/** GPX text kept on this device: every file with no server, and offline uploads on one. @param {string} file */
export function gpxText(file) { return dbGpx(NS, file).then(r => r ? r.text : null, () => /** @type {string | null} */ (null)); }

// -- public maps --
/** @param {string} url @returns {Promise<any>} 'offline' when unreachable or failing, null for a refusal */
function fetchOr(url) {
  return fetch(url, applyAuth({})).then(r => r.ok ? r.json().catch(() => /** @type {any} */ (null)) : r.status >= 500 ? 'offline' : null, () => 'offline');
}
// Load a published map whole. Returns false when the map is not there (or
// never was), and null when the server cannot be reached and this device
// has no copy, so the caller can say which.
export async function loadPublic() {
  const had = await open();
  const got = await Promise.all([fetchOr(dataUrl('places')), fetchOr(dataUrl('areas')), fetchOr(dataUrl('routes')), fetchOr(categoryLabelsUrl())]);
  const [pl, ar, ro, lb] = got;
  // Part of the map missing would replace the saved copy with less of it.
  if (got.includes('offline')) return had || null;
  if (!Array.isArray(pl) && !(ro && Array.isArray(ro.regions))) return false;
  /** @type {Change[]} */
  const changes = [];
  if (Array.isArray(pl)) for (const p of pl) if (p && p.id) changes.push({ kind: 'place', id: p.id, op: 'put', data: p });
  if (Array.isArray(ar)) for (const a of ar) if (a && a.id) changes.push({ kind: 'area', id: a.id, op: 'put', data: a });
  changes.push(...manifestItems(ro));
  if (lb && lb.category_labels) for (const s in lb.category_labels) changes.push({ kind: 'label', id: s, op: 'put', data: lb.category_labels[s] });
  mem = emptyMem();
  const { w } = applyChanges(changes, false);
  w.clearItems = true;
  publish(new Set(KINDS));
  await dbWrite(w).catch(() => {});
  return true;
}

// -- writes --
// Each returns one shape, {ok} plus the item or count it changed, whether
// or not a server is attached, so call sites have one path.
/** @param {string} action @param {string} target @param {any} [details] */
function logIfLocal(action, target, details) { if (!hasServer()) localLog(action, target, details); }
/** @param {any} p */
function cleanPlace(p) { const out = normalizePlaceTags(stripUi(p)); if (out.category == null || out.category === '') delete out.category; return out; }

export const dataLayer = {
  /** @param {any} payload */
  async createPlace(payload) {
    const id = _genId();
    const place = cleanPlace(Object.assign({}, payload, { id }));
    await commit([{ kind: 'place', id, op: 'put', data: place }]);
    logIfLocal('place.create', payload.name);
    return { ok: true, place: clone(place), total_places: mem.place.size };
  },
  /** @param {{ id: string, place: any }} body */
  async updatePlace(body) {
    const place = cleanPlace(Object.assign({}, body.place, { id: body.id }));
    await commit([{ kind: 'place', id: body.id, op: 'put', data: place }]);
    logIfLocal('place.update', place.name);
    return { ok: true, place: clone(place) };
  },
  /** @param {{ id: string }} body */
  async deletePlace(body) {
    const cur = mem.place.get(body.id);
    await commit([{ kind: 'place', id: body.id, op: 'delete' }]);
    logIfLocal('place.delete', cur ? cur.data.name : '');
    return { ok: true, total_places: mem.place.size };
  },
  /** @param {{ category?: string }} body */
  async clearCategory(body) {
    const target = (body.category || '').trim();
    /** @type {Change[]} */
    const changes = [];
    for (const kind of ['place', 'area']) {
      for (const [id, v] of mem[kind]) {
        if (v.data && v.data.category === target) {
          const next = Object.assign({}, v.data);
          delete next.category;
          changes.push({ kind, id, op: 'put', data: next });
        }
      }
    }
    if (changes.length) await commit(changes);
    logIfLocal('place.clear_category', target);
    return { ok: true, cleared: changes.length };
  },
  /** @param {any} payload */
  async createArea(payload) {
    const id = _genId();
    const area = stripUi(Object.assign({}, payload, { id }));
    await commit([{ kind: 'area', id, op: 'put', data: area }]);
    logIfLocal('area.create', payload.name);
    return { ok: true, area: clone(area), total_areas: mem.area.size };
  },
  /** @param {{ id: string, area: any }} body */
  async updateArea(body) {
    const area = stripUi(Object.assign({}, body.area, { id: body.id }));
    await commit([{ kind: 'area', id: body.id, op: 'put', data: area }]);
    logIfLocal('area.update', area.name);
    return { ok: true, area: clone(area) };
  },
  /** @param {{ id: string }} body */
  async deleteArea(body) {
    const cur = mem.area.get(body.id);
    await commit([{ kind: 'area', id: body.id, op: 'delete' }]);
    logIfLocal('area.delete', cur ? cur.data.name : '');
    return { ok: true, total_areas: mem.area.size };
  },
  /** @param {{ key: string, metadata: any }} body */
  async putMetadata(body) {
    const md = Object.assign({}, body.metadata || {});
    if ('tags' in md) { const t = normalizeTags(md.tags); if (t.length) md.tags = t; else delete md.tags; }
    /** @type {Record<string, any>} */
    const clean = {};
    for (const f of ROUTE_META_FIELDS) if (f in md) clean[f] = md[f];
    const key = (body.key || '').trim();
    await commit([Object.keys(clean).length ? { kind: 'metadata', id: key, op: 'put', data: clean } : { kind: 'metadata', id: key, op: 'delete' }]);
    logIfLocal('route.update', _splitKey(key).name);
    return { ok: true };
  },
  /** @param {{ category_labels: Record<string, any> }} body */
  async putCategoryLabels(body) {
    const changes = labelChanges(body.category_labels || {});
    if (changes.length) await commit(changes);
    return { ok: true, category_labels: clone(labels.value) };
  },
  /** @param {{ region?: string, name: string, stripPii?: boolean, file: Blob }} opts */
  async uploadGpx(opts) {
    const r = await gpxOp('uploadGpx', opts);
    const stem = opts.name.endsWith('.planned') ? opts.name.slice(0, -'.planned'.length) : opts.name;
    logIfLocal('route.create', stem, { region: opts.region || '' });
    return r;
  },
  /** @param {{ region?: string, name: string }} body */
  async deleteGpx(body) { const r = await gpxOp('deleteGpx', body); logIfLocal('route.delete', body.name); return r; },
  /** @param {{ key: string, completed: boolean }} body */
  async setGpxCompleted(body) {
    const r = await gpxOp('setGpxCompleted', body);
    logIfLocal(body.completed ? 'route.complete' : 'route.plan', _splitKey(body.key).name);
    return r;
  },
  /** @param {{ key: string, new_region?: string, new_name?: string }} body */
  async moveGpx(body) {
    const r = await gpxOp('moveGpx', body);
    logIfLocal('route.move', r && r.new_key ? _splitKey(r.new_key).name : '', { from: body.key });
    return r;
  },
  /** @param {{ from: string, to: string }} body */
  async renameRegion(body) { const r = await gpxOp('renameRegion', body); logIfLocal('region.rename', body.to, { from: body.from }); return r; },
  /** @param {{ name: string }} body */
  deleteRegion(body) { return gpxOp('deleteRegion', body); },
  /** @param {{ name: string }} body */
  async clearRegion(body) { const r = await gpxOp('clearRegion', body); logIfLocal('region.clear', body.name); return r; },
  /** @param {string} key @param {any} value */
  putPref(key, value) {
    const cur = mem.pref.get(key);
    if (cur && JSON.stringify(cur.data) === JSON.stringify(value)) return Promise.resolve();
    return commit([{ kind: 'pref', id: key, op: 'put', data: value }]);
  },
};

// -- local backup (no server) --
// A zip in the layout the server's export writes, and its import.
export function exportLocal() {
  const db = dbOpen();
  return db.then(d => req(d.transaction('gpx').objectStore('gpx').index('ns').getAll(NS))).then((/** @type {GpxRec[]} */ gpx) => {
    /** @type {Record<string, any>} */
    const md = {};
    /** @type {Record<string, any>} */
    const lb = {};
    for (const [k, v] of mem.metadata) md[k] = v.data;
    for (const [k, v] of mem.label) lb[k] = v.data;
    return {
      places: sortedData(mem.place), areas: sortedData(mem.area), routes: buildManifest(mem.route, new Map()),
      metadata: md, labels: lb, gpx: gpx.map(g => ({ file: g.file, text: g.text })),
    };
  });
}
/**
 * @param {{ places: any, areas: any, metadata: any, labels: any, gpx: Array<{ file: string, text: string }> }} data
 * @param {string} mode 'replace' or 'merge'
 */
export async function importLocal(data, mode) {
  /** @type {Change[]} */
  const changes = [];
  /** @type {DbWrite} */
  let extra = { gpx: [] };
  if (mode === 'replace') {
    for (const k of ['place', 'area', 'route']) for (const id of mem[k].keys()) changes.push({ kind: k, id, op: 'delete' });
    const db = await dbOpen();
    const old = /** @type {GpxRec[]} */ (await req(db.transaction('gpx').objectStore('gpx').index('ns').getAll(NS)));
    extra.delGpx = old.map(g => [NS, g.file]);
  }
  let nPlaces = 0, nAreas = 0, nRoutes = 0;
  if (Array.isArray(data.places)) for (const p of data.places) {
    if (!p || typeof p !== 'object') continue;
    const id = /^[0-9a-f]{8}$/.test(p.id || '') ? p.id : _genId();
    changes.push({ kind: 'place', id, op: 'put', data: Object.assign({}, p, { id }) }); nPlaces++;
  }
  if (Array.isArray(data.areas)) for (const a of data.areas) {
    if (!a || typeof a !== 'object' || !a.geometry) continue;
    const id = /^[0-9a-f]{8}$/.test(a.id || '') ? a.id : _genId();
    changes.push({ kind: 'area', id, op: 'put', data: Object.assign({}, a, { id }) }); nAreas++;
  }
  /** @type {any[]} */
  const recs = [];
  for (const g of data.gpx || []) {
    const slash = g.file.lastIndexOf('/');
    const region = slash >= 0 ? g.file.slice(0, slash) : '';
    const base = slash >= 0 ? g.file.slice(slash + 1) : g.file;
    const planned = base.endsWith('.planned.gpx');
    const name = planned ? base.slice(0, -'.planned.gpx'.length) : base.slice(0, -'.gpx'.length);
    const m = parseGpxText(g.text);
    recs.push(Object.assign({ file: g.file, region, name, planned }, m));
    /** @type {GpxRec[]} */ (extra.gpx).push({ ns: NS, file: g.file, text: g.text });
    nRoutes++;
  }
  // Merge with the files already here, so a planned file next to an
  // existing walked one still makes one route.
  for (const c of manifestItems(localManifestFromGpx(recs))) changes.push(c);
  if (data.metadata && typeof data.metadata === 'object') {
    if (mode === 'replace') for (const id of mem.metadata.keys()) if (!(id in data.metadata)) changes.push({ kind: 'metadata', id, op: 'delete' });
    for (const k in data.metadata) changes.push({ kind: 'metadata', id: k, op: 'put', data: data.metadata[k] });
  }
  if (data.labels && typeof data.labels === 'object') {
    for (const k in data.labels) changes.push({ kind: 'label', id: k, op: 'put', data: data.labels[k] });
    if (mode === 'replace') for (const id of mem.label.keys()) if (!(id in data.labels)) changes.push({ kind: 'label', id, op: 'delete' });
  }
  const { w, kinds } = applyChanges(changes, false);
  // A later put of an id deleted above in the same list wins in memory; keep
  // the database in step by writing deletes before puts.
  const putKeys = new Set((w.items || []).map(r => pkey(r.kind, r.id)));
  w.delItems = (w.delItems || []).filter(k => !putKeys.has(pkey(k[1], k[2])));
  w.delGpx = (extra.delGpx || []).filter(k => !(extra.gpx || []).some(g => g.file === k[1]));
  w.gpx = extra.gpx || [];
  publish(kinds);
  await dbWrite(w);
  localLog('local.import', '', { places: nPlaces, areas: nAreas, gpx: nRoutes, mode });
  return { ok: true, places: nPlaces, areas: nAreas, routes: nRoutes };
}

// -- local-mode activity log --
// A single-device record of the actions taken on the on-device map (the
// local analogue of the server audit log). Best-effort, capped to the most
// recent LOCAL_LOG_CAP entries.
const LOCAL_LOG_CAP = 1000;
/** @param {string} action @param {string} [target] @param {any} [details] */
export function localLog(action, target, details) {
  const entry = { ts: Math.floor(Date.now() / 1000), action, target: target || '', details: details || {} };
  dbOpen().then(db => {
    const st = db.transaction('log', 'readwrite').objectStore('log');
    st.add(entry);
    const cnt = st.count();
    cnt.onsuccess = () => {
      const over = cnt.result - LOCAL_LOG_CAP;
      if (over <= 0) return;
      let removed = 0;
      st.openCursor().onsuccess = e => {
        const c = /** @type {IDBRequest<IDBCursorWithValue | null>} */ (e.target).result;
        if (c && removed < over) { c.delete(); removed++; c.continue(); }
      };
    };
  }).catch(() => {});
}
// One page of the local log, newest first, in the shape /admin/logs returns.
/** @param {number | null} [beforeId] */
export function localLogPage(beforeId) {
  return dbOpen().then(db => req(db.transaction('log').objectStore('log').getAll())).then((/** @type {any[]} */ rows) => {
    rows = rows.slice().sort((a, b) => b.id - a.id);
    if (beforeId != null) rows = rows.filter(r => r.id < beforeId);
    const page = rows.slice(0, 100);
    return { logs: page, next_before_id: rows.length > 100 ? page[page.length - 1].id : null };
  }).catch(() => ({ logs: /** @type {any[]} */ ([]), next_before_id: /** @type {number | null} */ (null) }));
}
export function localLogClear() {
  return dbOpen().then(db => { const tx = db.transaction('log', 'readwrite'); tx.objectStore('log').clear(); return txDone(tx); });
}

// -- offline banner and sync toast --
// Hidden online and with no server (always editable by design). Offline
// owners see how many changes wait; offline public viewers see read-only copy.
export function updateOfflineBanner() {
  const el = document.getElementById('pwa-offline-banner');
  const text = document.getElementById('pwa-offline-text');
  if (!el || !text) return;
  if (!hasServer() || navigator.onLine) { el.hidden = true; return; }
  // Unhidden first: a live region announces a text change, and text that
  // arrives with the region does not count.
  el.hidden = false;
  if (isReadOnly()) {
    text.textContent = t('pwa.offlineReadOnly');
  } else {
    const n = pendingCount.value;
    text.textContent = n > 0 ? t('pwa.offlinePending', { count: n }) : t('pwa.offline');
  }
}
// The update prompt is a toast with an action, so it has no timer: it stays
// until the user reloads. Its words are set on showing, for the live region.
export function showUpdatePrompt() {
  const el = document.getElementById('pwa-update-banner');
  const text = document.getElementById('pwa-update-text');
  if (!el || !text) return;
  el.hidden = false;
  text.textContent = t('pwa.updateAvailable');
}
let _syncToastTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
/** @param {number} synced @param {number} skipped @param {string[]} kept */
function showSyncToast(synced, skipped, kept) {
  const el = document.getElementById('pwa-sync-toast');
  if (!el) return;
  let msg = synced ? t('pwa.synced', { count: synced }) : t('pwa.syncComplete');
  if (skipped) msg = t('pwa.refused', { msg, n: skipped });
  if (kept.length) msg = t('pwa.kept', { msg, files: kept.map(f => f.split('/').pop()).join(', ') });
  el.hidden = false;
  el.textContent = msg;
  if (_syncToastTimer) clearTimeout(_syncToastTimer);
  _syncToastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}
