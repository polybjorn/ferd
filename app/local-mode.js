import { idbDeleteKey, idbGet, idbGetAll, idbPut, idbSet } from './device-cache.js';
import { normalizePlaceTags, normalizeTags } from './tags.js';

// When 'ferd-mode' is 'local', the app runs with no server: dataLayer
// routes every read/write to `localStore` (IndexedDB) instead of the API,
// and the server UI (auth, publish, sessions, tokens, admin, catalog) is
// hidden. Local and server data are separate maps; switching modes never
// touches the other's data.
export function isLocalMode() {
  try { return localStorage.getItem('ferd-mode') === 'local'; } catch { return false; }
}
export function setLocalMode(on) {
  try { on ? localStorage.setItem('ferd-mode', 'local') : localStorage.removeItem('ferd-mode'); } catch {}
}

function _round6(n) { return Math.round(n * 1e6) / 1e6; }
// Leaflet's tile transition is CSS cubic-bezier(0, 0, 0.25, 1). Match it
// exactly via Newton's method so pins and routes track the tiles through a
// zoom animation; a polynomial ease-out diverges ~5% mid-animation, visible
// as drift then snap.
export function easeLeaflet(t) {
  let s = t;
  for (let i = 0; i < 6; i++) {
    const sm = 1 - s;
    const x = 0.75 * sm * s * s + s * s * s;
    const dx = 1.5 * s + 0.75 * s * s;
    if (Math.abs(dx) < 1e-6) break;
    s -= (x - t) / dx;
    if (s < 0) s = 0; else if (s > 1) s = 1;
  }
  const sm = 1 - s;
  return 3 * sm * s * s + s * s * s;
}
export function _genId() {
  const b = new Uint8Array(4);
  (crypto || window.crypto).getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// Parse a GPX string for the manifest fields the server computes server-side
// (see scripts/gpx-manifest.sh): bbox [minLat,minLon,maxLat,maxLon] over all
// track/route/waypoints, whether any <ele> is present, and track count/names.
export function parseGpxText(text) {
  const out = { bbox: null, hasElevation: false, trackCount: 0, trackNames: [] };
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
  catch { return out; }
  if (!doc || doc.getElementsByTagName('parsererror').length) return out;
  let mnLat = Infinity, mnLon = Infinity, mxLat = -Infinity, mxLon = -Infinity, found = false;
  for (const tag of ['trkpt', 'rtept', 'wpt']) {
    const els = doc.getElementsByTagNameNS('*', tag);
    for (let i = 0; i < els.length; i++) {
      const lat = parseFloat(els[i].getAttribute('lat')), lon = parseFloat(els[i].getAttribute('lon'));
      if (isNaN(lat) || isNaN(lon)) continue;
      if (lat < mnLat) mnLat = lat; if (lon < mnLon) mnLon = lon;
      if (lat > mxLat) mxLat = lat; if (lon > mxLon) mxLon = lon;
      found = true;
    }
  }
  if (found) out.bbox = [_round6(mnLat), _round6(mnLon), _round6(mxLat), _round6(mxLon)];
  out.hasElevation = doc.getElementsByTagNameNS('*', 'ele').length > 0;
  const trks = doc.getElementsByTagNameNS('*', 'trk');
  out.trackCount = trks.length;
  for (let i = 0; i < trks.length; i++) {
    const n = trks[i].getElementsByTagNameNS('*', 'name')[0];
    out.trackNames.push(n && n.textContent ? n.textContent : 'Track ' + (i + 1));
  }
  return out;
}

// Mirror the server's strip_gpx_pii: drop <time>/<author> elements and the
// root creator= attribute. Used on upload/import when the user opts in.
export function stripGpxPiiText(text) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, 'application/xml'); }
  catch { return text; }
  if (doc.getElementsByTagName('parsererror').length) return text;
  const root = doc.documentElement;
  if (root && root.hasAttribute('creator')) root.removeAttribute('creator');
  for (const tag of ['time', 'author']) {
    const els = doc.getElementsByTagNameNS('*', tag);
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.parentNode) e.parentNode.removeChild(e);
    }
  }
  try { return new XMLSerializer().serializeToString(doc); }
  catch { return text; }
}

// Build the routes manifest from local GPX records + metadata, replicating
// scripts/gpx-manifest.sh: group a walked (.gpx) and planned (.planned.gpx)
// sibling under one route key, mark completed when the walked file exists,
// and merge the metadata sidecar fields.
export const ROUTE_META_FIELDS = ['source', 'date_completed', 'rating', 'notes', 'tags', 'difficulty', 'local_name'];
function buildLocalManifest(recs, metadata) {
  const routes = {};
  for (const rec of recs) {
    const region = rec.region || '';
    const base = region ? region + '/' + rec.name : rec.name;
    if (!routes[base]) routes[base] = { key: base, region, name: rec.name, walked: null, planned: null };
    if (rec.planned) routes[base].planned = rec; else routes[base].walked = rec;
  }
  const regions = {};
  for (const base in routes) {
    const r = routes[base];
    const primary = r.walked || r.planned;
    const entry = {
      key: r.key, file: primary.file, name: r.name,
      hasElevation: !!primary.hasElevation, completed: !!r.walked,
    };
    if (primary.bbox) entry.bbox = primary.bbox;
    if (r.planned) entry.plannedFile = r.planned.file;
    if (primary.trackCount && primary.trackCount > 1) {
      entry.trackCount = primary.trackCount;
      entry.trackNames = primary.trackNames;
    }
    const meta = (metadata && metadata[r.key]) || {};
    for (const f of ROUTE_META_FIELDS) if (f in meta) entry[f] = meta[f];
    if (!regions[r.region]) regions[r.region] = { name: r.region, routes: [] };
    regions[r.region].routes.push(entry);
  }
  // No-region bucket ('') sorts last, matching the server.
  const out = { regions: Object.values(regions).sort((a, b) => (a.name === '' ? 1 : 0) - (b.name === '' ? 1 : 0) || a.name.localeCompare(b.name)) };
  for (const reg of out.regions) reg.routes.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// On-device backend. Each method returns the same shape the matching API
// endpoint does, so dataLayer call sites don't care which mode they're in.
export const localStore = {
  _metadata() { return idbGet('kv', 'local:metadata').then(v => v || {}); },
  _setMetadata(m) { return idbSet('kv', 'local:metadata', m); },

  getPlaces(fallback) { return idbGetAll('places').then(a => Array.isArray(a) ? a : (fallback || [])).catch(() => fallback || []); },
  createPlace(payload) {
    // Wrap in a promise so a tag-validation throw rejects (caught by the
    // caller's .catch) instead of throwing synchronously, matching the
    // server's 400-as-rejection behavior.
    return Promise.resolve().then(() => {
      const place = normalizePlaceTags(Object.assign({}, payload, { id: _genId() }));
      return idbPut('places', place).then(() => idbGetAll('places')).then(a => ({ ok: true, place, total_places: a.length }));
    });
  },
  updatePlace(body) {
    return Promise.resolve().then(() => {
      const next = normalizePlaceTags(Object.assign({}, body.place, { id: body.id }));
      return idbPut('places', next).then(() => ({ ok: true, place: next }));
    });
  },
  deletePlace(body) {
    return idbDeleteKey('places', body.id).then(() => idbGetAll('places')).then(a => ({ ok: true, total_places: a.length }));
  },
  clearCategory(body) {
    const target = (body.category || '').trim();
    const clearIn = store => idbGetAll(store).then(list => {
      const puts = [];
      for (const p of list) {
        if (p && p.category === target) { delete p.category; puts.push(idbPut(store, p)); }
      }
      return Promise.all(puts).then(() => puts.length);
    });
    return Promise.all([clearIn('places'), clearIn('areas')]).then(([a, b]) => ({ ok: true, cleared: a + b }));
  },

  getAreas(fallback) { return idbGetAll('areas').then(a => Array.isArray(a) ? a : (fallback || [])).catch(() => fallback || []); },
  createArea(payload) {
    const area = Object.assign({}, payload, { id: _genId() });
    return idbPut('areas', area).then(() => idbGetAll('areas')).then(a => ({ ok: true, area, total_areas: a.length }));
  },
  updateArea(body) {
    const next = Object.assign({}, body.area, { id: body.id });
    return idbPut('areas', next).then(() => ({ ok: true, area: next }));
  },
  deleteArea(body) {
    return idbDeleteKey('areas', body.id).then(() => idbGetAll('areas')).then(a => ({ ok: true, total_areas: a.length }));
  },

  getRoutes() { return Promise.all([idbGetAll('gpx'), this._metadata()]).then(([recs, meta]) => buildLocalManifest(recs || [], meta || {})); },
  uploadGpx({ region, name, stripPii, file }) {
    return file.text().then(raw => {
      const text = stripPii ? stripGpxPiiText(raw) : raw;
      const planned = name.endsWith('.planned');
      const stem = planned ? name.slice(0, -'.planned'.length) : name;
      const f = (region ? region + '/' : '') + name + '.gpx';
      const m = parseGpxText(text);
      const rec = { file: f, region: region || '', name: stem, planned, text, bbox: m.bbox, hasElevation: m.hasElevation, trackCount: m.trackCount, trackNames: m.trackNames };
      return idbPut('gpx', rec).then(() => this.getRoutes()).then(manifest => ({ ok: true, manifest }));
    });
  },
  deleteGpx(body) {
    const region = body.region || '';
    let name = body.name || '';
    if (name.toLowerCase().endsWith('.gpx')) name = name.slice(0, -4);
    const pre = region ? region + '/' : '';
    return Promise.all([idbDeleteKey('gpx', pre + name + '.gpx'), idbDeleteKey('gpx', pre + name + '.planned.gpx')]).then(() => ({ ok: true }));
  },
  setGpxCompleted(body) {
    const { region, name } = _splitKey(body.key);
    const pre = region ? region + '/' : '';
    const walkedF = pre + name + '.gpx', plannedF = pre + name + '.planned.gpx';
    return Promise.all([idbGet('gpx', walkedF), idbGet('gpx', plannedF)]).then(([w, p]) => {
      if (body.completed) {
        if (w || !p) return { ok: true };
        return idbDeleteKey('gpx', plannedF).then(() => idbPut('gpx', Object.assign({}, p, { file: walkedF, planned: false }))).then(() => ({ ok: true }));
      }
      if (p || !w) return { ok: true };
      return idbDeleteKey('gpx', walkedF).then(() => idbPut('gpx', Object.assign({}, w, { file: plannedF, planned: true }))).then(() => ({ ok: true }));
    });
  },
  moveGpx(body) {
    const { region, name } = _splitKey(body.key);
    const newRegion = body.new_region || '';
    const finalName = ((body.new_name || name) + '').trim();
    const newKey = (newRegion ? newRegion + '/' : '') + finalName;
    if (region === newRegion && name === finalName) return Promise.resolve({ ok: true, old_key: body.key, new_key: body.key, moved: 0 });
    const pre = region ? region + '/' : '', npre = newRegion ? newRegion + '/' : '';
    return Promise.all([idbGet('gpx', pre + name + '.gpx'), idbGet('gpx', pre + name + '.planned.gpx')]).then(([w, p]) => {
      const ops = [];
      if (w) ops.push(idbDeleteKey('gpx', w.file).then(() => idbPut('gpx', Object.assign({}, w, { file: npre + finalName + '.gpx', region: newRegion, name: finalName }))));
      if (p) ops.push(idbDeleteKey('gpx', p.file).then(() => idbPut('gpx', Object.assign({}, p, { file: npre + finalName + '.planned.gpx', region: newRegion, name: finalName }))));
      ops.push(this._metadata().then(meta => {
        if (meta && (body.key in meta)) { meta[newKey] = meta[body.key]; delete meta[body.key]; return this._setMetadata(meta); }
      }));
      return Promise.all(ops).then(() => ({ ok: true, old_key: body.key, new_key: newKey, moved: 1 }));
    });
  },
  putMetadata(body) {
    return this._metadata().then(meta => {
      const next = Object.assign({}, meta);
      if (body.metadata && Object.keys(body.metadata).length) {
        const md = Object.assign({}, body.metadata);
        if ('tags' in md) { const t = normalizeTags(md.tags); if (t.length) md.tags = t; else delete md.tags; }
        next[body.key] = md;
      }
      else delete next[body.key];
      return this._setMetadata(next).then(() => ({ ok: true }));
    });
  },
  renameRegion(body) {
    const from = body.from || '', to = body.to || '';
    if (from === to) return Promise.resolve({ ok: true, renamed: 0 });
    return Promise.all([idbGetAll('gpx'), this._metadata()]).then(([recs, meta]) => {
      const ops = [];
      for (const rec of recs) {
        if ((rec.region || '') !== from) continue;
        ops.push(idbDeleteKey('gpx', rec.file).then(() => idbPut('gpx', Object.assign({}, rec, { region: to, file: (to ? to + '/' : '') + rec.name + (rec.planned ? '.planned' : '') + '.gpx' }))));
      }
      const nextMeta = {};
      for (const k in meta) {
        const { region, name } = _splitKey(k);
        nextMeta[region === from ? (to ? to + '/' : '') + name : k] = meta[k];
      }
      ops.push(this._setMetadata(nextMeta));
      return Promise.all(ops).then(() => ({ ok: true, renamed: 1 }));
    });
  },
  deleteRegion(_body) { return Promise.resolve({ ok: true }); }, // regions are derived from files; an empty region needs no deletion
  clearRegion(body) {
    const name = body.name || '';
    return Promise.all([idbGetAll('gpx'), this._metadata()]).then(([recs, meta]) => {
      const ops = recs.filter(r => (r.region || '') === name).map(r => idbDeleteKey('gpx', r.file));
      const nextMeta = {};
      for (const k in meta) { if (_splitKey(k).region !== name) nextMeta[k] = meta[k]; }
      ops.push(this._setMetadata(nextMeta));
      return Promise.all(ops).then(() => ({ ok: true }));
    });
  },

  getCategoryLabels() { return idbGet('kv', 'local:category-labels').then(v => ({ category_labels: v || {} })); },
  putCategoryLabels(body) {
    return idbGet('kv', 'local:category-labels').then(cur => {
      const next = Object.assign({}, cur || {});
      const incoming = body.category_labels || {};
      // Preserve existing color/order when the caller omits them, like the server.
      for (const slug in incoming) next[slug] = Object.assign({}, next[slug], incoming[slug]);
      return idbSet('kv', 'local:category-labels', next).then(() => ({ ok: true }));
    });
  },

  gpxText(file) { return idbGet('gpx', file).then(rec => rec ? rec.text : null); },
};
export function _splitKey(key) {
  const parts = (key || '').split('/');
  return parts.length === 2 ? { region: parts[0], name: parts[1] } : { region: '', name: parts[0] };
}
